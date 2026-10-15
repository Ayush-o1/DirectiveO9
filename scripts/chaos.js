#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrator.js';
import { seedDatabase } from './seed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Seeded PRNG (Mulberry32) for reproducible pseudorandom load and kill timing
function createPRNG(seed = 987654321) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startServerProcess(port, adminKey) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/index.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        ADMIN_KEY: adminKey,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    let stderrOutput = '';

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      if (text.includes(`DirectiveO9 server running on port ${port}`)) {
        if (!started) {
          started = true;
          resolve(child);
        }
      }
    });

    child.stderr.on('data', chunk => {
      stderrOutput += chunk.toString();
    });

    child.on('error', err => {
      if (!started) reject(err);
    });

    child.on('exit', (code, signal) => {
      if (!started) {
        reject(
          new Error(
            `Server exited prematurely before startup (code=${code}, signal=${signal}): ${stderrOutput}`
          )
        );
      }
    });

    // Startup timeout
    setTimeout(() => {
      if (!started) {
        child.kill('SIGKILL');
        reject(new Error(`Server startup timed out on port ${port}`));
      }
    }, 10000);
  });
}

async function killProcess(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  return new Promise(resolve => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

async function sendRequest(baseUrl, endpoint, options = {}) {
  const url = `${baseUrl}${endpoint}`;
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

async function runChaos() {
  const PORT = Number(process.env.CHAOS_PORT || 3300);
  const ADMIN_KEY = process.env.ADMIN_KEY || 'key_admin_test_secret_99';
  const BASE_URL = `http://localhost:${PORT}`;
  const TOTAL_ROUNDS = Number(process.env.CHAOS_ROUNDS || 20);

  const pool = getPool();
  process.stdout.write(`[Chaos] Initializing database schema and clean tables...\n`);
  await runMigrations({ pool });
  await pool.query('TRUNCATE commands, events, trades, orders, instruments, participants CASCADE');
  await seedDatabase(pool);

  const rng = createPRNG(424242);
  const participants = [
    { id: 1, key: 'key_mm1_test_secret_1' },
    { id: 2, key: 'key_mm2_test_secret_2' },
    { id: 3, key: 'key_trader1_test_secret_3' },
  ];
  const symbols = ['BTC-USDT', 'ETH-USDT'];

  const allAcknowledgedOrders = [];
  const roundResults = [];
  let currentChild = null;

  try {
    for (let round = 1; round <= TOTAL_ROUNDS; round++) {
      process.stdout.write(`\n--- [Chaos Round ${round}/${TOTAL_ROUNDS}] ---\n`);

      // 1. Start Server Process
      currentChild = await startServerProcess(PORT, ADMIN_KEY);
      process.stdout.write(
        `[Round ${round}] Server started on port ${PORT} (PID ${currentChild.pid})\n`
      );

      // Wait a moment for TCP readiness
      await delay(50);

      // 2. Generate and dispatch randomized load
      const commandCount = 25 + Math.floor(rng() * 25); // 25 to 50 commands
      const roundPromises = [];
      const activeRestingOrderIds = [];

      for (let c = 1; c <= commandCount; c++) {
        const p = participants[Math.floor(rng() * participants.length)];
        const sym = symbols[Math.floor(rng() * symbols.length)];
        const side = rng() > 0.5 ? 'BUY' : 'SELL';
        const clientOrderId = `chaos-r${round}-c${c}-${Date.now().toString(36)}`;

        const basePrice = sym === 'BTC-USDT' ? 100 : 500;
        const tickSize = sym === 'BTC-USDT' ? 1 : 5;
        const lotSize = sym === 'BTC-USDT' ? 1 : 10;

        const priceOffset = Math.floor(rng() * 10) * tickSize;
        const price =
          side === 'BUY' ? basePrice + priceOffset : basePrice + 5 * tickSize - priceOffset;
        const quantity = (1 + Math.floor(rng() * 5)) * lotSize;

        // Choose command type: LIMIT (70%), MARKET (15%), IOC (15%)
        const roll = rng();
        let cmdType = 'LIMIT';
        if (roll > 0.85) cmdType = 'MARKET';
        else if (roll > 0.7) cmdType = 'IOC';

        const payload = {
          symbol: sym,
          side,
          type: cmdType,
          quantity,
          client_order_id: clientOrderId,
        };
        if (cmdType !== 'MARKET') {
          payload.price = Math.max(price, tickSize);
        }

        const reqPromise = (async () => {
          const res = await sendRequest(BASE_URL, '/orders', {
            method: 'POST',
            headers: { 'X-API-Key': p.key },
            body: JSON.stringify(payload),
          });

          if (res.status === 200 || res.status === 201) {
            allAcknowledgedOrders.push({
              round,
              client_order_id: clientOrderId,
              participant_id: p.id,
              symbol: sym,
              side,
              price: payload.price || null,
              quantity,
              order_id: res.body?.order_id,
              seq: res.body?.seq,
            });
            if (res.body?.order_id) {
              activeRestingOrderIds.push({
                order_id: res.body.order_id,
                participant_key: p.key,
                symbol: sym,
              });
            }
          }
          return res;
        })();

        roundPromises.push(reqPromise);
      }

      // 3. Issue kill -9 at random moment while requests are in flight
      const killDelayMs = 25 + Math.floor(rng() * 125); // 25ms to 150ms
      process.stdout.write(
        `[Round ${round}] Dispatched ${commandCount} commands. Killing PID ${currentChild.pid} with SIGKILL in ${killDelayMs}ms...\n`
      );

      await delay(killDelayMs);
      await killProcess(currentChild);
      process.stdout.write(`[Round ${round}] Process killed with SIGKILL (-9).\n`);

      // Drain in-flight promises (most will fail/terminate)
      await Promise.allSettled(roundPromises);

      // 4. Restart server
      const restartStartTime = Date.now();
      currentChild = await startServerProcess(PORT, ADMIN_KEY);
      const restartDurationMs = Date.now() - restartStartTime;
      process.stdout.write(
        `[Round ${round}] Server restarted successfully on port ${PORT} in ${restartDurationMs}ms (PID ${currentChild.pid})\n`
      );

      // 5. Verification
      // a. Check that every acknowledged order is in the database journal
      let lostAckedOrders = 0;
      for (const acked of allAcknowledgedOrders) {
        const { rows } = await pool.query(
          `SELECT seq, command_type, participant_id, client_order_id, symbol, side, price, quantity, status
           FROM commands
           WHERE participant_id = $1 AND client_order_id = $2`,
          [acked.participant_id, acked.client_order_id]
        );
        if (rows.length === 0) {
          process.stderr.write(
            `[CRITICAL] Lost acknowledged order! client_order_id=${acked.client_order_id}, participant=${acked.participant_id}\n`
          );
          lostAckedOrders++;
        }
      }

      // b. Check sequence gap-freedom
      const { rows: seqRows } = await pool.query(
        'SELECT MIN(seq) AS min_seq, MAX(seq) AS max_seq, COUNT(*) AS count FROM commands'
      );
      const minSeq = Number(seqRows[0]?.min_seq || 0);
      const maxSeq = Number(seqRows[0]?.max_seq || 0);
      const count = Number(seqRows[0]?.count || 0);
      const isGapFree = count === 0 || (minSeq === 1 && count === maxSeq - minSeq + 1);

      // c. State hash equals a fresh replay
      const verifyRes = await sendRequest(BASE_URL, '/admin/verify', {
        headers: { 'X-Admin-Key': ADMIN_KEY },
      });
      const liveHash = verifyRes.body?.canonical_hash;

      const replayRes = await sendRequest(BASE_URL, '/admin/replay', {
        method: 'POST',
        headers: { 'X-Admin-Key': ADMIN_KEY },
        body: JSON.stringify({ from_seq: 1, oracle: false }),
      });
      const replayHash = replayRes.body?.state_hash;

      const hashMatched = Boolean(liveHash && replayHash && liveHash === replayHash);

      const roundSuccess = lostAckedOrders === 0 && isGapFree && hashMatched;

      process.stdout.write(
        `[Round ${round} Summary]\n` +
          `  Acked Orders (Cumulative): ${allAcknowledgedOrders.length}\n` +
          `  Lost Acked Orders:         ${lostAckedOrders}\n` +
          `  Journal Total Commands:    ${count} (min=${minSeq}, max=${maxSeq})\n` +
          `  Gap-Free Sequence:         ${isGapFree}\n` +
          `  Live Canonical Hash:       ${liveHash}\n` +
          `  Replay State Hash:         ${replayHash}\n` +
          `  Hash Match:                ${hashMatched}\n` +
          `  Round Status:              ${roundSuccess ? 'PASSED' : 'FAILED'}\n`
      );

      roundResults.push({
        round,
        commands_dispatched: commandCount,
        acked_cumulative: allAcknowledgedOrders.length,
        lost_acked_orders: lostAckedOrders,
        db_commands_count: count,
        min_seq: minSeq,
        max_seq: maxSeq,
        gap_free: isGapFree,
        live_hash: liveHash,
        replay_hash: replayHash,
        hash_matched: hashMatched,
        kill_delay_ms: killDelayMs,
        restart_duration_ms: restartDurationMs,
        passed: roundSuccess,
      });

      if (!roundSuccess) {
        throw new Error(`Chaos round ${round} verification failed!`);
      }

      // Cleanly stop child before next round iteration starts
      await killProcess(currentChild);
      currentChild = null;
    }

    // Write results to bench/results/chaos-kill-<timestamp>.json
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultsDir = path.resolve(__dirname, '..', 'bench', 'results');
    await fs.mkdir(resultsDir, { recursive: true });
    const resultsFile = path.join(resultsDir, `chaos-kill-${timestamp}.json`);

    const summaryData = {
      timestamp: new Date().toISOString(),
      total_rounds: TOTAL_ROUNDS,
      passed_rounds: roundResults.filter(r => r.passed).length,
      failed_rounds: roundResults.filter(r => !r.passed).length,
      total_acknowledged_orders: allAcknowledgedOrders.length,
      lost_acknowledged_orders: roundResults.reduce((acc, r) => acc + r.lost_acked_orders, 0),
      gap_free_all_rounds: roundResults.every(r => r.gap_free),
      hashes_matched_all_rounds: roundResults.every(r => r.hash_matched),
      rounds: roundResults,
    };

    await fs.writeFile(resultsFile, JSON.stringify(summaryData, null, 2), 'utf-8');
    process.stdout.write(`\n=======================================================\n`);
    process.stdout.write(
      `CHAOS KILL TESTING COMPLETE: ${summaryData.passed_rounds}/${TOTAL_ROUNDS} ROUNDS PASSED\n`
    );
    process.stdout.write(`Results written to: ${resultsFile}\n`);
    process.stdout.write(`=======================================================\n`);
  } finally {
    if (currentChild) {
      await killProcess(currentChild);
    }
    await closePool();
  }
}

runChaos().catch(err => {
  process.stderr.write(`[Chaos Fatal Error] ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
