import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MatchingEngine } from '../src/engine/engine.js';
import { generateWorkload } from './workload.js';
import { getBenchmarkEnv, computeStats } from './env.js';
import { findPriceIndex, insertPrice, removePrice } from '../src/engine/level.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * The Array-subclass implementation from commit 69b25d2.
 */
class SortedArrayPriceIndexSubclass extends Array {
  static get [Symbol.species]() {
    return Array;
  }

  constructor(isDescending = false) {
    if (typeof isDescending === 'number') {
      super(isDescending);
      this.isDescending = false;
    } else {
      super();
      this.isDescending = Boolean(isDescending);
    }
  }

  peek() {
    return this.length > 0 ? this[0] : undefined;
  }

  has(price) {
    return findPriceIndex(this, price, this.isDescending) !== -1;
  }

  insert(price) {
    const prevLen = this.length;
    insertPrice(this, price, this.isDescending);
    return this.length > prevLen;
  }

  remove(price) {
    return removePrice(this, price, this.isDescending) !== -1;
  }

  toArray(limit) {
    const list = Array.from(this);
    return typeof limit === 'number' && limit > 0 ? list.slice(0, limit) : list;
  }
}

function createEngineWithIndex(IndexClass) {
  const engine = new MatchingEngine();
  const symbol = 'BTC-USDT';
  engine.registerInstrument({ symbol, tick_size: 1, lot_size: 1 });
  const book = engine.books.get(symbol);
  book.bids = new IndexClass(true);
  book.asks = new IndexClass(false);
  return engine;
}

function runTrial({ IndexClass, bookDepth, commandCount, seed }) {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
  }

  const symbol = 'BTC-USDT';
  const engine = createEngineWithIndex(IndexClass);

  const commands = generateWorkload({
    seed,
    count: commandCount,
    symbol,
    tick_size: 1,
    lot_size: 1,
    book_depth: bookDepth,
  });

  const latenciesNs = new Float64Array(commandCount);

  const tStart = process.hrtime.bigint();
  for (let i = 0; i < commandCount; i++) {
    const c = commands[i];
    const t0 = process.hrtime.bigint();
    engine.processCommand(c);
    const t1 = process.hrtime.bigint();
    latenciesNs[i] = Number(t1 - t0);
  }
  const tEnd = process.hrtime.bigint();

  const totalDurationSec = Number(tEnd - tStart) / 1e9;
  const throughputOpsSec = commandCount / totalDurationSec;

  const sorted = Array.from(latenciesNs).sort((a, b) => a - b);
  const p50 = sorted[Math.floor(commandCount * 0.5)];
  const p95 = sorted[Math.floor(commandCount * 0.95)];
  const p99 = sorted[Math.floor(commandCount * 0.99)];
  const mean = sorted.reduce((sum, v) => sum + v, 0) / commandCount;

  return {
    throughputOpsSec,
    stats: { p50, p95, p99, mean },
  };
}

async function runBenchmark() {
  console.log('================================================================');
  console.log('       Array-Subclass (69b25d2) vs Plain Array (HEAD) Benchmark  ');
  console.log('================================================================\n');

  // Warmup JIT
  console.log('Warming up V8 JIT compiler...');
  for (let w = 0; w < 3; w++) {
    runTrial({
      IndexClass: SortedArrayPriceIndexSubclass,
      bookDepth: 100,
      commandCount: 5000,
      seed: 1234 + w,
    });
    runTrial({
      IndexClass: (await import('../src/engine/level.js')).SortedArrayPriceIndex,
      bookDepth: 100,
      commandCount: 5000,
      seed: 5678 + w,
    });
  }
  console.log('Warm-up complete.\n');

  const { SortedArrayPriceIndex: SortedArrayPriceIndexPlain } =
    await import('../src/engine/level.js');

  const REPETITIONS = 5;
  const COMMAND_COUNT = 25000;
  const DEPTHS = [500, 5000];

  const env = getBenchmarkEnv();
  const scenarios = [
    {
      label: 'Array-Subclass (commit 69b25d2)',
      IndexClass: SortedArrayPriceIndexSubclass,
      type: 'subclass',
    },
    { label: 'Plain Array (HEAD)', IndexClass: SortedArrayPriceIndexPlain, type: 'plain' },
  ];

  const results = [];

  for (const depth of DEPTHS) {
    for (const sc of scenarios) {
      console.log(
        `Testing Depth ${depth} with ${sc.label} (${REPETITIONS} runs of ${COMMAND_COUNT} ops)...`
      );

      const throughputs = [];
      const p50s = [];
      const p95s = [];
      const p99s = [];

      for (let r = 0; r < REPETITIONS; r++) {
        // EXACT same seed for identical workloads across implementations
        const seed = 50000 + (r + 1) * 100 + depth;
        const trial = runTrial({
          IndexClass: sc.IndexClass,
          bookDepth: depth,
          commandCount: COMMAND_COUNT,
          seed,
        });

        throughputs.push(trial.throughputOpsSec);
        p50s.push(trial.stats.p50);
        p95s.push(trial.stats.p95);
        p99s.push(trial.stats.p99);

        console.log(
          `  Run ${r + 1}/${REPETITIONS}: ${Math.round(trial.throughputOpsSec).toLocaleString()} ops/s | p50: ${trial.stats.p50} ns | p95: ${trial.stats.p95} ns`
        );
      }

      const tpStats = computeStats(throughputs);
      const p50Stats = computeStats(p50s);
      const p95Stats = computeStats(p95s);
      const p99Stats = computeStats(p99s);

      results.push({
        implementation: sc.label,
        type: sc.type,
        book_depth: depth,
        command_count: COMMAND_COUNT,
        repetitions: REPETITIONS,
        throughput_ops_sec: {
          median: Math.round(tpStats.median),
          min: Math.round(tpStats.min),
          max: Math.round(tpStats.max),
          spread: Math.round(tpStats.spread),
        },
        latency_p50_ns: {
          median: p50Stats.median,
          min: p50Stats.min,
          max: p50Stats.max,
          spread: p50Stats.spread,
        },
        latency_p95_ns: {
          median: p95Stats.median,
          min: p95Stats.min,
          max: p95Stats.max,
          spread: p95Stats.spread,
        },
        latency_p99_ns: {
          median: p99Stats.median,
          min: p99Stats.min,
          max: p99Stats.max,
          spread: p99Stats.spread,
        },
      });
    }
  }

  // Display comparison table
  console.log('\n================================================================');
  console.log('                      COMPARISON RESULTS                        ');
  console.log('================================================================');
  console.table(
    results.map(r => ({
      Depth: r.book_depth,
      Implementation: r.implementation,
      'Median Throughput': `${r.throughput_ops_sec.median.toLocaleString()} ops/s`,
      Spread: `${r.throughput_ops_sec.spread.toLocaleString()} ops/s`,
      p50: `${r.latency_p50_ns.median} ns`,
      p95: `${r.latency_p95_ns.median} ns`,
      p99: `${r.latency_p99_ns.median} ns`,
    }))
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `subclass-comparison-${timestamp}.json`;
  const outPath = path.resolve(__dirname, 'results', filename);

  const payload = {
    benchmark: 'subclass_vs_plain_array',
    timestamp: new Date().toISOString(),
    environment: env,
    results,
  };

  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\nBenchmark results written to: bench/results/${filename}\n`);
}

runBenchmark();
