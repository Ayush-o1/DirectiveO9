import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MatchingEngine } from '../src/engine/engine.js';
import { generateWorkload } from './workload.js';
import { computeStateHash } from '../src/engine/hash.js';
import { getBenchmarkEnv, computeStats } from './env.js';
import { getPool, closePool } from '../src/db/pool.js';
import { replayJournal } from '../src/sequencer/replay.js';
import { Sequencer } from '../src/sequencer/sequencer.js';
import { runMigrations } from '../src/db/migrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Replays a journal command sequence purely in memory through a fresh MatchingEngine instance,
 * recording precise monotonic duration and heap memory growth.
 */
function measureInMemoryReplayTrial({ commands, symbol = 'BTC-USDT' }) {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
  }

  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();

  const engine = new MatchingEngine({
    instruments: [{ symbol, tick_size: 1, lot_size: 1 }],
  });

  const commandCount = commands.length;
  for (let i = 0; i < commandCount; i++) {
    engine.processCommand(commands[i]);
  }

  const t1 = process.hrtime.bigint();
  const heapAfter = process.memoryUsage().heapUsed;

  const durationMs = Number(t1 - t0) / 1e6;
  const throughputOpsSec = commandCount / (Number(t1 - t0) / 1e9);
  const heapGrowthBytes = Math.max(0, heapAfter - heapBefore);
  const heapGrowthMB = Number((heapGrowthBytes / (1024 * 1024)).toFixed(3));

  engine.checkInvariants();
  const stateHash = computeStateHash(engine);

  return {
    commandCount,
    durationMs,
    throughputOpsSec,
    heapGrowthMB,
    registryOrderCount: engine.orders.size,
    restingOrderCount: engine.books.get(symbol).orders.size,
    stateHash,
  };
}

/**
 * Replays journal from PostgreSQL (reading commands, events, and trades from disk,
 * replaying through a fresh MatchingEngine, and validating bit-for-bit event parity).
 */
async function measurePostgresStartupTrial({ pool, fromSeq = 1, toSeq }) {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
  }

  const t0 = process.hrtime.bigint();
  const result = await replayJournal({
    pool,
    fromSeq,
    toSeq,
    oracle: false,
  });
  const t1 = process.hrtime.bigint();

  const durationMs = Number(t1 - t0) / 1e6;
  const commandCount = result.commands_replayed;
  const throughputOpsSec = commandCount / (Number(t1 - t0) / 1e9);

  if (!result.verified) {
    throw new Error(
      `Divergence detected during startup recovery: ${JSON.stringify(result.divergence)}`
    );
  }

  return {
    commandCount,
    durationMs,
    throughputOpsSec,
    eventsVerified: result.events_verified,
    tradesVerified: result.trades_verified,
    stateHash: result.state_hash,
  };
}

/**
 * Seeds PostgreSQL journal with a deterministic workload up to target count.
 */
async function populateDatabaseJournal(pool, count, symbol = 'BTC-USDT') {
  console.log(`  Populating PostgreSQL journal with ${count.toLocaleString()} commands...`);
  await pool.query('TRUNCATE commands, events, trades, orders CASCADE;');
  await pool.query(
    'INSERT INTO instruments (symbol, tick_size, lot_size) VALUES ($1, 1, 1) ON CONFLICT (symbol) DO NOTHING;',
    [symbol]
  );
  await pool.query(
    "INSERT INTO participants (participant_id, name, api_key_hash, is_admin) VALUES (1, 'MM1', 'dummy', false), (2, 'MM2', 'dummy', false), (3, 'TRADER1', 'dummy', false), (4, 'TRADER2', 'dummy', false) ON CONFLICT (participant_id) DO NOTHING;"
  );

  const sequencer = new Sequencer({
    pool,
    batchMaxSize: 1000,
    batchTimeoutMs: 2,
  });
  await sequencer.init();

  const commands = generateWorkload({
    seed: 42 + count,
    count,
    symbol,
    tick_size: 1,
    lot_size: 1,
    book_depth: 50,
  });

  const CHUNK_SIZE = 500;
  for (let i = 0; i < count; i += CHUNK_SIZE) {
    const chunk = commands.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(c =>
        sequencer.enqueue({
          type: c.type,
          symbol: c.symbol,
          side: c.side,
          price: c.price,
          quantity: c.quantity,
          order_id: c.order_id,
          participant_id: c.participant_id,
          client_order_id: c.client_order_id,
        })
      )
    );
  }

  await sequencer.close();
  console.log(`  Committed ${count.toLocaleString()} commands to PostgreSQL journal.`);
}

async function main() {
  console.log('DirectiveO9 Recovery & Startup Replay Benchmark');
  console.log('==============================================');

  const env = getBenchmarkEnv();
  console.log(
    `Environment: Node ${env.node_version} | ${env.cpu_model} (${env.cpu_count} cores) | OS: ${env.os_type} ${env.os_release}`
  );

  const pool = getPool();
  await runMigrations({ pool });

  const JOURNAL_SIZES = [1000, 5000, 20000];
  const REPETITIONS = 5;
  const symbol = 'BTC-USDT';

  // 1. In-Memory Engine Replay Benchmark
  console.log('\n--- Section 1: In-Memory Engine Replay Scaling (Cold Engine Replay) ---');
  const inMemoryResults = [];

  for (const size of JOURNAL_SIZES) {
    console.log(
      `Testing In-Memory Replay: ${size.toLocaleString()} commands (${REPETITIONS} runs)...`
    );

    const durations = [];
    const throughputs = [];
    const heapGrowths = [];
    let registryCount = 0;
    let restingCount = 0;
    let finalHash = '';

    const commands = generateWorkload({
      seed: 42 + size,
      count: size,
      symbol,
      tick_size: 1,
      lot_size: 1,
      book_depth: 50,
    });

    for (let r = 0; r < REPETITIONS; r++) {
      const trial = measureInMemoryReplayTrial({ commands, symbol });
      durations.push(trial.durationMs);
      throughputs.push(trial.throughputOpsSec);
      heapGrowths.push(trial.heapGrowthMB);
      registryCount = trial.registryOrderCount;
      restingCount = trial.restingOrderCount;
      finalHash = trial.stateHash;

      process.stdout.write(
        `  Run ${r + 1}/${REPETITIONS}: duration = ${trial.durationMs.toFixed(2)} ms | throughput = ${Math.round(trial.throughputOpsSec).toLocaleString()} ops/s | heap = +${trial.heapGrowthMB} MB\n`
      );
    }

    const durationStats = computeStats(durations);
    const throughputStats = computeStats(throughputs);
    const heapStats = computeStats(heapGrowths);

    inMemoryResults.push({
      benchmark_type: 'in_memory_engine_replay',
      journal_size: size,
      runs: REPETITIONS,
      replay_duration_ms: {
        median: Number(durationStats.median.toFixed(2)),
        spread: Number(durationStats.spread.toFixed(2)),
      },
      replay_throughput_ops_sec: {
        median: Math.round(throughputStats.median),
        spread: Math.round(throughputStats.spread),
      },
      heap_growth_mb: {
        median: Number(heapStats.median.toFixed(3)),
        spread: Number(heapStats.spread.toFixed(3)),
      },
      order_registry_size: registryCount,
      resting_orders_on_book: restingCount,
      canonical_state_hash: finalHash,
    });
    console.log();
  }

  // 2. Full Startup Recovery Benchmark (PostgreSQL Journal Read + Replay + Event Parity Check)
  console.log(
    '--- Section 2: Full Startup Recovery (PostgreSQL Read + Engine Replay + Parity Verification) ---'
  );
  const fullStartupResults = [];

  for (const size of JOURNAL_SIZES) {
    console.log(
      `Testing Full Startup Recovery: ${size.toLocaleString()} commands (${REPETITIONS} runs)...`
    );
    await populateDatabaseJournal(pool, size, symbol);

    const durations = [];
    const throughputs = [];
    let eventsVerified = 0;
    let tradesVerified = 0;
    let finalHash = '';

    for (let r = 0; r < REPETITIONS; r++) {
      const trial = await measurePostgresStartupTrial({ pool, fromSeq: 1, toSeq: size });
      durations.push(trial.durationMs);
      throughputs.push(trial.throughputOpsSec);
      eventsVerified = trial.eventsVerified;
      tradesVerified = trial.tradesVerified;
      finalHash = trial.stateHash;

      process.stdout.write(
        `  Run ${r + 1}/${REPETITIONS}: recovery duration = ${trial.durationMs.toFixed(2)} ms | effective throughput = ${Math.round(trial.throughputOpsSec).toLocaleString()} ops/s | events verified = ${eventsVerified} | trades verified = ${tradesVerified}\n`
      );
    }

    const durationStats = computeStats(durations);
    const throughputStats = computeStats(throughputs);

    fullStartupResults.push({
      benchmark_type: 'full_startup_recovery',
      journal_size: size,
      runs: REPETITIONS,
      recovery_duration_ms: {
        median: Number(durationStats.median.toFixed(2)),
        spread: Number(durationStats.spread.toFixed(2)),
      },
      effective_throughput_ops_sec: {
        median: Math.round(throughputStats.median),
        spread: Math.round(throughputStats.spread),
      },
      events_verified: eventsVerified,
      trades_verified: tradesVerified,
      canonical_state_hash: finalHash,
      divergences: 0,
    });
    console.log();
  }

  await closePool();

  console.log('SUMMARY: In-Memory Engine Replay');
  console.table(
    inMemoryResults.map(r => ({
      'Size (cmds)': r.journal_size,
      'Replay Duration (median ms)': r.replay_duration_ms.median,
      'Spread (ms)': r.replay_duration_ms.spread,
      'Throughput (median ops/s)': r.replay_throughput_ops_sec.median,
      'Heap Growth (MB)': r.heap_growth_mb.median,
    }))
  );

  console.log('\nSUMMARY: Full Startup Recovery (PostgreSQL Read + Replay + Event Verification)');
  console.table(
    fullStartupResults.map(r => ({
      'Journal Size (cmds)': r.journal_size,
      'Recovery Duration (median ms)': r.recovery_duration_ms.median,
      'Spread (ms)': r.recovery_duration_ms.spread,
      'Effective Rate (ops/s)': r.effective_throughput_ops_sec.median,
      'Events Verified': r.events_verified,
      'Trades Verified': r.trades_verified,
      Divergences: r.divergences,
    }))
  );

  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const resultPayload = {
    benchmark: 'recovery_benchmark',
    timestamp: new Date().toISOString(),
    environment: env,
    in_memory_results: inMemoryResults,
    full_startup_results: fullStartupResults,
    // Maintain backwards compatible top-level results key for any existing tools
    results: inMemoryResults,
  };

  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const outputPath = path.join(resultsDir, `recovery-benchmark-${timestamp}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(resultPayload, null, 2));
  console.log(`\nBenchmark results written to: bench/results/recovery-benchmark-${timestamp}.json`);
}

main().catch(async err => {
  console.error(err);
  await closePool();
  process.exit(1);
});
