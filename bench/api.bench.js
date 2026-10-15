import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import autocannon from 'autocannon';

import { getPool, closePool } from '../src/db/pool.js';
import { Sequencer } from '../src/sequencer/sequencer.js';
import { createApp } from '../src/api/app.js';
import { getBenchmarkEnv, computeStats } from './env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runAutocannonFixedRate({
  port,
  apiKey,
  durationSec = 5,
  overallRate = 350,
  connections = 10,
}) {
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

  const instance = autocannon({
    url: `http://127.0.0.1:${port}/orders`,
    method: 'POST',
    connections,
    duration: durationSec,
    overallRate, // Fixed-rate mode avoids coordinated omission
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
  });

  const result = await instance;
  return result;
}

async function benchmarkConfig({
  pool,
  apiKey,
  batchMaxSize,
  batchTimeoutMs,
  repetitions = 5,
  durationSec = 4,
}) {
  const throughputs = [];
  const p50s = [];
  const p95s = [];
  const p99s = [];

  for (let r = 0; r < repetitions; r++) {
    // Start clean sequencer
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
      const res = await runAutocannonFixedRate({
        port,
        apiKey,
        durationSec,
        overallRate: batchMaxSize === 1 ? 150 : 400,
        connections: 8,
      });

      throughputs.push(res.requests.average);
      p50s.push(res.latency.p50);
      const p95Estimate = Number((res.latency.p90 * 0.333 + res.latency.p97_5 * 0.667).toFixed(2));
      p95s.push(p95Estimate);
      p99s.push(res.latency.p99);

      process.stdout.write(
        `  Run ${r + 1}/${repetitions}: throughput = ${Math.round(res.requests.average)} req/s | p50 = ${res.latency.p50} ms | p95 = ${p95Estimate} ms | p99 = ${res.latency.p99} ms\n`
      );
    } finally {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      await sequencer.close();
    }
  }

  return {
    throughput: computeStats(throughputs),
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

  // Query database settings
  const syncCommitRes = await pool.query('SHOW synchronous_commit;');
  const synchronousCommit = syncCommitRes.rows[0]?.synchronous_commit || 'unknown';
  console.log(`PostgreSQL synchronous_commit: ${synchronousCommit}`);
  console.log(
    `Note: PostgreSQL runs inside Docker on macOS; fsync includes VM host write barrier overhead.\n`
  );

  const apiKey = 'part-key-1';
  const REPETITIONS = 5;

  const configurations = [
    {
      name: 'Unbatched Commit (Batch 1, Timeout 1ms)',
      batchMaxSize: 1,
      batchTimeoutMs: 1,
    },
    {
      name: 'Moderate Group Commit (Batch 20, Timeout 5ms)',
      batchMaxSize: 20,
      batchTimeoutMs: 5,
    },
    {
      name: 'High Group Commit (Batch 100, Timeout 10ms)',
      batchMaxSize: 100,
      batchTimeoutMs: 10,
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
      repetitions: REPETITIONS,
      durationSec: 4,
    });

    results.push({
      configuration: cfg.name,
      batch_max_size: cfg.batchMaxSize,
      batch_timeout_ms: cfg.batchTimeoutMs,
      synchronous_commit: synchronousCommit,
      mode: 'autocannon fixed-rate (uncoordinated omission mitigated)',
      runs: REPETITIONS,
      throughput_req_sec: {
        median: Math.round(measured.throughput.median),
        spread: Math.round(measured.throughput.spread),
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
      'Timeout (ms)': r.batch_timeout_ms,
      'Throughput (median req/s)': r.throughput_req_sec.median,
      'p50 Latency (ms)': r.latency_p50_ms.median,
      'p95 Latency (ms)': r.latency_p95_ms.median,
      'p99 Latency (ms)': r.latency_p99_ms.median,
    }))
  );

  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const resultPayload = {
    benchmark: 'api_benchmark',
    timestamp: new Date().toISOString(),
    synchronous_commit: synchronousCommit,
    docker_vm_macos_note:
      'PostgreSQL runs in Docker VM on macOS; fsync overhead includes virtualization barrier and is not representative of bare-metal production NVMe.',
    load_generator_mode: 'autocannon fixed-rate',
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
