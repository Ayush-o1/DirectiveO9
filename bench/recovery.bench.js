import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MatchingEngine } from '../src/engine/engine.js';
import { generateWorkload } from './workload.js';
import { computeStateHash } from '../src/engine/hash.js';
import { getBenchmarkEnv, computeStats } from './env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Replays a journal command sequence through a fresh MatchingEngine instance,
 * recording precise monotonic duration and heap memory growth.
 */
function measureReplayTrial({ commands, symbol = 'BTC-USDT' }) {
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

async function main() {
  console.log('DirectiveO9 Recovery & Startup Replay Benchmark');
  console.log('==============================================');

  const env = getBenchmarkEnv();
  console.log(
    `Environment: Node ${env.node_version} | ${env.cpu_model} (${env.cpu_count} cores) | OS: ${env.os_type} ${env.os_release}`
  );
  console.log('Evaluating startup replay scaling across 3 journal sizes (5 runs each)...\n');

  const JOURNAL_SIZES = [1000, 5000, 20000];
  const REPETITIONS = 5;
  const symbol = 'BTC-USDT';

  const results = [];

  for (const size of JOURNAL_SIZES) {
    console.log(`Testing Journal Size: ${size.toLocaleString()} commands (${REPETITIONS} runs)...`);

    const durations = [];
    const throughputs = [];
    const heapGrowths = [];
    let registryCount = 0;
    let restingCount = 0;
    let finalHash = '';

    // Generate deterministic workload for this size
    const commands = generateWorkload({
      seed: 42 + size,
      count: size,
      symbol,
      tick_size: 1,
      lot_size: 1,
      book_depth: 50,
    });

    for (let r = 0; r < REPETITIONS; r++) {
      const trial = measureReplayTrial({ commands, symbol });
      durations.push(trial.durationMs);
      throughputs.push(trial.throughputOpsSec);
      heapGrowths.push(trial.heapGrowthMB);
      registryCount = trial.registryOrderCount;
      restingCount = trial.restingOrderCount;
      finalHash = trial.stateHash;

      process.stdout.write(
        `  Run ${r + 1}/${REPETITIONS}: replay = ${trial.durationMs.toFixed(2)} ms (${Math.round(trial.throughputOpsSec).toLocaleString()} ops/s) | heap growth = ${trial.heapGrowthMB} MB\n`
      );
    }

    const durationStats = computeStats(durations);
    const throughputStats = computeStats(throughputs);
    const heapStats = computeStats(heapGrowths);

    results.push({
      journal_size: size,
      runs: REPETITIONS,
      replay_duration_ms: {
        median: durationStats.median,
        spread: durationStats.spread,
      },
      replay_throughput_ops_sec: {
        median: Math.round(throughputStats.median),
        spread: Math.round(throughputStats.spread),
      },
      heap_growth_mb: {
        median: heapStats.median,
        spread: heapStats.spread,
      },
      order_registry_size: registryCount,
      resting_orders_on_book: restingCount,
      canonical_state_hash: finalHash,
    });

    console.log();
  }

  console.log('SUMMARY RESULTS:');
  console.table(
    results.map(r => ({
      'Journal Size': r.journal_size.toLocaleString(),
      'Replay Time (median ms)': r.replay_duration_ms.median,
      'Spread (ms)': r.replay_duration_ms.spread,
      'Throughput (median ops/s)': r.replay_throughput_ops_sec.median.toLocaleString(),
      'Heap Growth (median MB)': r.heap_growth_mb.median,
      'Orders in Registry': r.order_registry_size.toLocaleString(),
      'Resting on Book': r.resting_orders_on_book.toLocaleString(),
    }))
  );

  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const resultPayload = {
    benchmark: 'recovery_benchmark',
    timestamp: new Date().toISOString(),
    environment: env,
    results,
  };

  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const outputPath = path.join(resultsDir, `recovery-benchmark-${timestamp}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(resultPayload, null, 2));
  console.log(`\nBenchmark results written to: bench/results/recovery-benchmark-${timestamp}.json`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
