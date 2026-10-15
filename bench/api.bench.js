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
      client_order_id: `bench-api-${Date.now()}-${counter}`,
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
  overallRate,
  connections = 8,
  repetitions = 5,
  durationSec = 4,
}) {
  const achievedRates = [];
  const totalRequests = [];
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
      non2xxCounts.push(res.non2xx || 0);
      errorCounts.push(res.errors || 0);
      p50s.push(res.latency.p50);
      const p95Estimate = Number((res.latency.p90 * 0.333 + res.latency.p97_5 * 0.667).toFixed(2));
      p95s.push(p95Estimate);
      p99s.push(res.latency.p99);

      process.stdout.write(
        `  Run ${r + 1}/${repetitions}: achieved = ${Math.round(res.requests.average)} req/s | total reqs = ${res.requests.total} | non-2xx = ${res.non2xx || 0} | errors = ${res.errors || 0} | p50 = ${res.latency.p50} ms | p95 = ${p95Estimate} ms\n`
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
      name: 'Unbatched Commit (Batch 1, Timeout 1ms)',
      batchMaxSize: 1,
      batchTimeoutMs: 1,
      overallRate: 150,
      connections: 8,
      mode: 'fixed-rate (offered 150 req/s)',
      isCapacityRun: false,
    },
    {
      name: 'Moderate Group Commit (Batch 20, Timeout 5ms)',
      batchMaxSize: 20,
      batchTimeoutMs: 5,
      overallRate: 400,
      connections: 8,
      mode: 'fixed-rate (offered 400 req/s)',
      isCapacityRun: false,
    },
    {
      name: 'High Group Commit (Batch 100, Timeout 10ms)',
      batchMaxSize: 100,
      batchTimeoutMs: 10,
      overallRate: 400,
      connections: 8,
      mode: 'fixed-rate (offered 400 req/s)',
      isCapacityRun: false,
    },
    {
      name: 'System Capacity Run (Unconstrained Max-Rate, Batch 100, Timeout 10ms)',
      batchMaxSize: 100,
      batchTimeoutMs: 10,
      overallRate: null, // Unconstrained to find saturation limit
      connections: 16,
      mode: 'unconstrained max-rate (capacity measurement)',
      isCapacityRun: true,
      queueFullNote:
        'Ingress queue bounded by queueCapacity; returns 503 QUEUE_FULL on saturation.',
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
      overallRate: cfg.overallRate,
      connections: cfg.connections,
      repetitions: REPETITIONS,
      durationSec: 4,
    });

    results.push({
      configuration: cfg.name,
      batch_max_size: cfg.batchMaxSize,
      batch_timeout_ms: cfg.batchTimeoutMs,
      mode: cfg.mode,
      is_capacity_run: cfg.isCapacityRun,
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
      'Offered Rate': r.offered_rate_req_sec,
      'Achieved Rate (req/s)': r.achieved_rate_req_sec.median,
      'Total Reqs': r.total_requests.median,
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
    load_generator_mode: 'autocannon (fixed-rate offered load & unconstrained max-rate capacity)',
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
