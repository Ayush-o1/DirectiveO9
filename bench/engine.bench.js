import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MatchingEngine } from '../src/engine/engine.js';
import { generateWorkload } from './workload.js';
import { getBenchmarkEnv, computeStats } from './env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Measures the baseline resolution overhead of process.hrtime.bigint().
 */
function measureTimerOverhead(iterations = 100000) {
  const diffs = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    const t1 = process.hrtime.bigint();
    diffs.push(Number(t1 - t0));
  }
  return computeStats(diffs);
}

/**
 * Measures an engine configuration over a specific workload.
 */
function runTrial({ indexType, bookDepth, commandCount, seed }) {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
  }

  const symbol = 'BTC-USDT';
  const engine = new MatchingEngine({
    instruments: [{ symbol, tick_size: 1, lot_size: 1 }],
    indexType,
  });

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

  const stats = computeStats(Array.from(latenciesNs));

  return {
    throughputOpsSec,
    totalDurationSec,
    stats,
  };
}

async function main() {
  console.log('DirectiveO9 Engine Performance Benchmark');
  console.log('=========================================');

  const env = getBenchmarkEnv();
  console.log(
    `Environment: Node ${env.node_version} | ${env.cpu_model} (${env.cpu_count} cores) | ${env.os_type} ${env.os_release}`
  );
  console.log(`Thermal policy: 5 runs per scenario, reporting median and spread.`);

  // 1. Measure timer overhead
  const timerOverhead = measureTimerOverhead();
  console.log(
    `Measured process.hrtime.bigint overhead: median ${timerOverhead.median} ns (p95: ${timerOverhead.p95} ns)\n`
  );

  // 2. Warm up JIT
  console.log('Warming up V8 JIT compiler...');
  for (let w = 0; w < 3; w++) {
    runTrial({ indexType: 'array', bookDepth: 20, commandCount: 5000, seed: 9999 + w });
    runTrial({ indexType: 'avl', bookDepth: 20, commandCount: 5000, seed: 8888 + w });
  }
  console.log('Warm-up complete.\n');

  const REPETITIONS = 5;
  const COMMAND_COUNT = 25000;

  const scenarios = [
    { name: 'Shallow Book (Depth 10)', bookDepth: 10, indexType: 'array', label: 'sorted-array' },
    { name: 'Shallow Book (Depth 10)', bookDepth: 10, indexType: 'avl', label: 'avl-tree' },
    { name: 'Deep Book (Depth 2000)', bookDepth: 2000, indexType: 'array', label: 'sorted-array' },
    { name: 'Deep Book (Depth 2000)', bookDepth: 2000, indexType: 'avl', label: 'avl-tree' },
  ];

  const results = [];

  for (const scenario of scenarios) {
    console.log(
      `Benchmarking ${scenario.name} [${scenario.label}] (${REPETITIONS} runs of ${COMMAND_COUNT} ops)...`
    );

    const runThroughputs = [];
    const runP50s = [];
    const runP95s = [];
    const runP99s = [];
    const runMeans = [];

    for (let r = 0; r < REPETITIONS; r++) {
      const trialSeed = 1000 * (r + 1) + scenario.bookDepth;
      const trial = runTrial({
        indexType: scenario.indexType,
        bookDepth: scenario.bookDepth,
        commandCount: COMMAND_COUNT,
        seed: trialSeed,
      });

      runThroughputs.push(trial.throughputOpsSec);
      runP50s.push(trial.stats.p50);
      runP95s.push(trial.stats.p95);
      runP99s.push(trial.stats.p99);
      runMeans.push(trial.stats.mean);

      process.stdout.write(
        `  Run ${r + 1}/${REPETITIONS}: ${Math.round(trial.throughputOpsSec).toLocaleString()} ops/s | p50: ${trial.stats.p50} ns | p95: ${trial.stats.p95} ns\n`
      );
    }

    const throughputStats = computeStats(runThroughputs);
    const p50Stats = computeStats(runP50s);
    const p95Stats = computeStats(runP95s);
    const p99Stats = computeStats(runP99s);
    const meanStats = computeStats(runMeans);

    results.push({
      scenario: scenario.name,
      data_structure: scenario.label,
      book_depth: scenario.bookDepth,
      command_count: COMMAND_COUNT,
      runs: REPETITIONS,
      throughput_ops_sec: {
        median: Math.round(throughputStats.median),
        min: Math.round(throughputStats.min),
        max: Math.round(throughputStats.max),
        spread: Math.round(throughputStats.spread),
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
      latency_mean_ns: {
        median: meanStats.median,
        spread: meanStats.spread,
      },
    });

    console.log();
  }

  // Summary Table
  console.log('SUMMARY RESULTS:');
  console.table(
    results.map(r => ({
      Scenario: r.scenario,
      'Data Structure': r.data_structure,
      'Throughput (median ops/s)': r.throughput_ops_sec.median.toLocaleString(),
      'p50 Latency (ns)': r.latency_p50_ns.median,
      'p95 Latency (ns)': r.latency_p95_ns.median,
      'p99 Latency (ns)': r.latency_p99_ns.median,
      'Spread (ops/s)': r.throughput_ops_sec.spread.toLocaleString(),
    }))
  );

  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const resultPayload = {
    benchmark: 'engine_benchmark',
    timestamp: new Date().toISOString(),
    timer_overhead_ns: timerOverhead,
    environment: env,
    results,
  };

  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const outputPath = path.join(resultsDir, `engine-benchmark-${timestamp}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(resultPayload, null, 2));
  console.log(`\nBenchmark results written to: bench/results/engine-benchmark-${timestamp}.json`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
