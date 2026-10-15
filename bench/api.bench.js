import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import autocannon from 'autocannon';

import { getPool, closePool } from '../src/db/pool.js';
import { Sequencer } from '../src/sequencer/sequencer.js';
import { createApp } from '../src/api/app.js';
import { getBenchmarkEnv, computeStats } from './env.js';
import { seedDatabase } from '../scripts/seed.js';
import { runMigrations } from '../src/db/migrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runAutocannonTest({ port, apiKey, durationSec = 4, overallRate, connections = 8 }) {
  let counter = 0;
  const symbol = 'BTC-USDT';

  const makeBody = () => {
    counter++;
    const side = counter % 2 === 0 ? 'BUY' : 'SELL';
    const priceOffset = (counter % 20) + 1;
    const price = side === 'BUY' ? 10000 - priceOffset : 10000 + priceOffset;
    return JSON.stringify({
      symbol,
      side,
      type: 'LIMIT',
      price,
      quantity: 5,
      client_order_id: `bench-api-${Date.now()}-${counter}-${Math.random()}`,
    });
  };

  const autocannonOpts = {
    url: `http://127.0.0.1:${port}/orders`,
    method: 'POST',
    connections,
    duration: durationSec,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    setupClient: client => {
      client.on('response', () => {
        client.setHeadersAndBody(
          {
            'Content-Type': 'application/json',
            'X-API-Key': apiKey,
          },
          makeBody()
        );
      });
      client.setHeadersAndBody(
        {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        makeBody()
      );
    },
  };

  if (typeof overallRate === 'number' && overallRate > 0) {
    autocannonOpts.overallRate = overallRate;
  }

  const instance = autocannon(autocannonOpts);
  const result = await instance;
  return result;
}

async function benchmarkConfig({
  pool,
  apiKey,
  batchMaxSize,
  batchTimeoutMs,
  maxQueueSize = 1000,
  overallRate,
  connections = 8,
  repetitions = 5,
  durationSec = 4,
}) {
  const achievedRates = [];
  const totalRequests = [];
  const status2xxCounts = [];
  const status5xxCounts = [];
  const non2xxCounts = [];
  const errorCounts = [];
  const p50s = [];
  const p95s = [];
  const p99s = [];

  for (let r = 0; r < repetitions; r++) {
    const sequencer = new Sequencer({
      pool,
      batchMaxSize,
      batchTimeoutMs,
      maxQueueSize,
    });
    await sequencer.init();

    const app = createApp({
      sequencer,
      pool,
      adminKey: 'admin-secret-key-1',
    });

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const res = await runAutocannonTest({
        port,
        apiKey,
        durationSec,
        overallRate,
        connections,
      });

      achievedRates.push(res.requests.average);
      totalRequests.push(res.requests.total);
      status2xxCounts.push(res['2xx'] || 0);
      status5xxCounts.push(res['5xx'] || 0);
      non2xxCounts.push(res.non2xx || 0);
      errorCounts.push(res.errors || 0);
      p50s.push(res.latency.p50);
      const p95Estimate = Number((res.latency.p90 * 0.333 + res.latency.p97_5 * 0.667).toFixed(2));
      p95s.push(p95Estimate);
      p99s.push(res.latency.p99);

      process.stdout.write(
        `  Run ${r + 1}/${repetitions}: achieved = ${Math.round(res.requests.average)} req/s | 2xx = ${res['2xx'] || 0} | 5xx = ${res['5xx'] || 0} | non-2xx = ${res.non2xx || 0} | errors = ${res.errors || 0} | p50 = ${res.latency.p50} ms | p95 = ${p95Estimate} ms\n`
      );
    } finally {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      await sequencer.close();
    }
  }

  return {
    achievedRate: computeStats(achievedRates),
    totalRequests: computeStats(totalRequests),
    status2xx: computeStats(status2xxCounts),
    status5xx: computeStats(status5xxCounts),
    non2xx: computeStats(non2xxCounts),
    errors: computeStats(errorCounts),
    p50: computeStats(p50s),
    p95: computeStats(p95s),
    p99: computeStats(p99s),
  };
}

async function main() {
  console.log('DirectiveO9 API & Group-Commit Journaling Benchmark');
  console.log('==================================================');

  const env = getBenchmarkEnv();
  console.log(
    `Environment: Node ${env.node_version} | ${env.cpu_model} (${env.cpu_count} cores) | OS: ${env.os_type} ${env.os_release}`
  );

  const pool = getPool();
  await runMigrations({ pool });
  await seedDatabase(pool);

  const syncCommitRes = await pool.query('SHOW synchronous_commit;');
  const synchronousCommit = syncCommitRes.rows[0]?.synchronous_commit || 'unknown';
  console.log(`PostgreSQL synchronous_commit: ${synchronousCommit}`);
  console.log(
    `Note: PostgreSQL runs inside Docker on macOS; fsync includes VM host write barrier overhead.\n`
  );

  const apiKey = 'key_trader1_test_secret_3';
  const REPETITIONS = 5;

  const configurations = [
    {
      name: 'Fixed-Rate (Offered 100 req/s, Batch 20, Timeout 5ms)',
      batchMaxSize: 20,
      batchTimeoutMs: 5,
      maxQueueSize: 1000,
      overallRate: 100,
      connections: 8,
      mode: 'fixed-rate',
      isCapacityRun: false,
    },
    {
      name: 'Fixed-Rate (Offered 500 req/s, Batch 100, Timeout 10ms)',
      batchMaxSize: 100,
      batchTimeoutMs: 10,
      maxQueueSize: 1000,
      overallRate: 500,
      connections: 8,
      mode: 'fixed-rate',
      isCapacityRun: false,
    },
    {
      name: 'Max-Rate Unbatched Comparison (Batch 1, Timeout 1ms, Conn 16)',
      batchMaxSize: 1,
      batchTimeoutMs: 1,
      maxQueueSize: 1000,
      overallRate: null, // Unconstrained
      connections: 16,
      mode: 'unconstrained max-rate (group-commit comparison)',
      isCapacityRun: true,
      groupCommitCompare: 'batch_size_1',
    },
    {
      name: 'Max-Rate Group-Commit Comparison (Batch 100, Timeout 10ms, Conn 16)',
      batchMaxSize: 100,
      batchTimeoutMs: 10,
      maxQueueSize: 1000,
      overallRate: null, // Unconstrained
      connections: 16,
      mode: 'unconstrained max-rate (group-commit comparison)',
      isCapacityRun: true,
      groupCommitCompare: 'batch_size_100',
    },
    {
      name: 'Over-Capacity Saturation Test (Queue Limit 50, Conn 80)',
      batchMaxSize: 10,
      batchTimeoutMs: 15,
      maxQueueSize: 50,
      overallRate: null,
      connections: 80,
      durationSec: 3,
      mode: 'over-capacity test (queue limit 50, 80 concurrent connections)',
      isCapacityRun: false,
      isOverCapacityTest: true,
      queueFullNote:
        'Saturates ingress queue (limit 50 with 80 concurrent connections) to measure 503 QUEUE_FULL rejection behavior with zero socket errors.',
    },
  ];

  const results = [];

  for (const cfg of configurations) {
    console.log(`Evaluating ${cfg.name} (${REPETITIONS} runs)...`);
    const measured = await benchmarkConfig({
      pool,
      apiKey,
      batchMaxSize: cfg.batchMaxSize,
      batchTimeoutMs: cfg.batchTimeoutMs,
      maxQueueSize: cfg.maxQueueSize,
      overallRate: cfg.overallRate,
      connections: cfg.connections,
      repetitions: REPETITIONS,
      durationSec: cfg.durationSec || 4,
    });

    results.push({
      configuration: cfg.name,
      batch_max_size: cfg.batchMaxSize,
      batch_timeout_ms: cfg.batchTimeoutMs,
      configured_queue_limit: cfg.maxQueueSize,
      mode: cfg.mode,
      is_capacity_run: cfg.isCapacityRun,
      is_over_capacity_test: Boolean(cfg.isOverCapacityTest),
      queue_full_note: cfg.queueFullNote || null,
      offered_rate_req_sec: cfg.overallRate ?? 'unconstrained',
      achieved_rate_req_sec: {
        median: Math.round(measured.achievedRate.median),
        spread: Math.round(measured.achievedRate.spread),
      },
      total_requests: {
        median: Math.round(measured.totalRequests.median),
        spread: Math.round(measured.totalRequests.spread),
      },
      status_2xx_count: {
        median: Math.round(measured.status2xx.median),
        max: Math.round(measured.status2xx.max),
      },
      status_503_count: {
        median: Math.round(measured.status5xx.median),
        max: Math.round(measured.status5xx.max),
      },
      non_2xx_count: {
        median: Math.round(measured.non2xx.median),
        max: Math.round(measured.non2xx.max),
      },
      error_count: {
        median: Math.round(measured.errors.median),
        max: Math.round(measured.errors.max),
      },
      latency_p50_ms: {
        median: measured.p50.median,
        spread: measured.p50.spread,
      },
      latency_p95_ms: {
        median: measured.p95.median,
        spread: measured.p95.spread,
      },
      latency_p99_ms: {
        median: measured.p99.median,
        spread: measured.p99.spread,
      },
    });

    console.log();
  }

  await closePool();

  console.log('SUMMARY RESULTS:');
  console.table(
    results.map(r => ({
      Configuration: r.configuration,
      'Batch Size': r.batch_max_size,
      'Queue Limit': r.configured_queue_limit,
      'Offered (req/s)': r.offered_rate_req_sec,
      'Achieved (req/s)': r.achieved_rate_req_sec.median,
      'Total Reqs': r.total_requests.median,
      '2xx (OK)': r.status_2xx_count.median,
      '503 QUEUE_FULL': r.status_503_count.median,
      'Non-2xx': r.non_2xx_count.median,
      Errors: r.error_count.median,
      'p50 (ms)': r.latency_p50_ms.median,
      'p95 (ms)': r.latency_p95_ms.median,
      'p99 (ms)': r.latency_p99_ms.median,
    }))
  );

  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const resultPayload = {
    benchmark: 'api_benchmark',
    timestamp: new Date().toISOString(),
    synchronous_commit: synchronousCommit,
    docker_vm_macos_note:
      'PostgreSQL runs in Docker VM on macOS; fsync overhead includes virtualization barrier and is not representative of bare-metal production NVMe.',
    load_generator_mode: 'autocannon (fixed-rate offered load, max-rate capacity & over-capacity)',
    environment: env,
    results,
  };

  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const outputPath = path.join(resultsDir, `api-benchmark-${timestamp}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(resultPayload, null, 2));
  console.log(`\nBenchmark results written to: bench/results/api-benchmark-${timestamp}.json`);
}

main().catch(async err => {
  console.error(err);
  await closePool();
  process.exit(1);
});
