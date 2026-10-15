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

async function startServerProcess(port, adminKey, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/index.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        ADMIN_KEY: adminKey,
        ...extraEnv,
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
  const TOTAL_ROUNDS = Number(process.env.CHAOS_ROUNDS || 100);

  const pool = getPool();
  process.stdout.write(`[Chaos] Initializing clean database schema...\n`);
  await runMigrations({ pool });
  await pool.query('TRUNCATE commands, events, trades, orders, instruments, participants CASCADE');
  await seedDatabase(pool);

  const rng = createPRNG(133742);
  const participants = [
    { id: 1, key: 'key_mm1_test_secret_1' },
    { id: 2, key: 'key_mm2_test_secret_2' },
    { id: 3, key: 'key_trader1_test_secret_3' },
  ];
  const symbols = ['BTC-USDT', 'ETH-USDT'];

  const allAcknowledgedOrders = [];
  const roundResults = [];
  let currentChild = null;

  const batchSizeVariants = [5, 10, 25, 50, 100, 200];
  const batchTimeoutVariants = [1, 2, 5, 8, 10];

  try {
    for (let round = 1; round <= TOTAL_ROUNDS; round++) {
      // 1. Vary batch settings per round to test diverse flushing schedules
      const batchMaxSize = batchSizeVariants[Math.floor(rng() * batchSizeVariants.length)];
      const batchTimeoutMs = batchTimeoutVariants[Math.floor(rng() * batchTimeoutVariants.length)];

      currentChild = await startServerProcess(PORT, ADMIN_KEY, {
        BATCH_MAX_SIZE: String(batchMaxSize),
        BATCH_TIMEOUT_MS: String(batchTimeoutMs),
      });

      await delay(25);

      // 2. Generate heavy randomized load
      const commandCount = 35 + Math.floor(rng() * 40); // 35 to 75 commands
      const dispatchedInRound = [];
      const ackedInThisRound = [];
      const unackedInThisRound = [];

      const promises = [];

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
        const quantity = (1 + Math.floor(rng() * 6)) * lotSize;

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

        const cmdRecord = {
          round,
          clientOrderId,
          participant: p,
          payload,
        };
        dispatchedInRound.push(cmdRecord);

        const reqPromise = (async () => {
          const res = await sendRequest(BASE_URL, '/orders', {
            method: 'POST',
            headers: { 'X-API-Key': p.key },
            body: JSON.stringify(payload),
          });

          if (res.status === 200 || res.status === 201) {
            const ackEntry = {
              round,
              client_order_id: clientOrderId,
              participant_id: p.id,
              symbol: sym,
              side,
              price: payload.price || null,
              quantity,
              status: res.status,
              body: res.body,
              order_id: res.body?.order_id,
              seq: res.body?.seq,
            };
            ackedInThisRound.push(ackEntry);
            allAcknowledgedOrders.push(ackEntry);
          } else {
            unackedInThisRound.push(cmdRecord);
          }
          return res;
        })();

        promises.push(reqPromise);
      }

      // 3. Kill -9 at randomized moment while requests are in flight
      const killDelayMs = 20 + Math.floor(rng() * 110); // 20ms to 130ms
      await delay(killDelayMs);
      await killProcess(currentChild);
      currentChild = null;

      // Drain in-flight network requests
      await Promise.allSettled(promises);

      // 4. Restart Server
      const restartStart = Date.now();
      currentChild = await startServerProcess(PORT, ADMIN_KEY, {
        BATCH_MAX_SIZE: String(batchMaxSize),
        BATCH_TIMEOUT_MS: String(batchTimeoutMs),
      });
      const restartDurationMs = Date.now() - restartStart;

      // 5. Verification:
      // a. Compare each acknowledged response with stored journal events
      let ackedResponseMismatches = 0;
      for (const acked of ackedInThisRound) {
        const { rows: cmdRows } = await pool.query(
          `SELECT seq, status, response_status, response_body
           FROM commands
           WHERE participant_id = $1 AND client_order_id = $2`,
          [acked.participant_id, acked.client_order_id]
        );

        if (cmdRows.length === 0) {
          ackedResponseMismatches++;
          process.stderr.write(
            `[Ack Mismatch] Acknowledged order missing from journal: ${acked.client_order_id}\n`
          );
          continue;
        }

        const cmd = cmdRows[0];
        if (Number(cmd.response_status) !== Number(acked.status)) {
          ackedResponseMismatches++;
          process.stderr.write(
            `[Ack Mismatch] Status mismatch for ${acked.client_order_id}: acked=${acked.status}, journal=${cmd.response_status}\n`
          );
        }

        // Verify stored events match order events returned in response
        const { rows: evRows } = await pool.query(
          `SELECT event_type, payload FROM events WHERE seq = $1 ORDER BY event_id ASC`,
          [cmd.seq]
        );

        const expectedEvents = acked.body?.events || [];
        if (evRows.length !== expectedEvents.length) {
          ackedResponseMismatches++;
          process.stderr.write(
            `[Ack Mismatch] Event count mismatch for ${acked.client_order_id}: acked=${expectedEvents.length}, db=${evRows.length}\n`
          );
        } else {
          for (let i = 0; i < evRows.length; i++) {
            if (evRows[i].event_type !== expectedEvents[i].event) {
              ackedResponseMismatches++;
              process.stderr.write(
                `[Ack Mismatch] Event type mismatch at [${i}] for ${acked.client_order_id}: db=${evRows[i].event_type}, acked=${expectedEvents[i].event}\n`
              );
            }
          }
        }

        const ackedTrades = expectedEvents.filter(e => e.event === 'TRADE_EXECUTED');
        if (ackedTrades.length > 0) {
          const { rows: dbTrades } = await pool.query(
            `SELECT price, quantity, maker_order_id, taker_order_id FROM trades WHERE seq = $1 ORDER BY trade_id ASC`,
            [cmd.seq]
          );
          if (dbTrades.length !== ackedTrades.length) {
            ackedResponseMismatches++;
            process.stderr.write(
              `[Ack Mismatch] Trade count mismatch for ${acked.client_order_id}: acked=${ackedTrades.length}, db=${dbTrades.length}\n`
            );
          }
        }
      }

      // b. Retry every unacknowledged command with the same client_order_id
      let unackedRetriedCount = 0;
      let idempotencyViolations = 0;
      for (const unacked of unackedInThisRound) {
        unackedRetriedCount++;
        const retryRes = await sendRequest(BASE_URL, '/orders', {
          method: 'POST',
          headers: { 'X-API-Key': unacked.participant.key },
          body: JSON.stringify(unacked.payload),
        });

        // Verify valid response received on retry
        if (retryRes.status !== 200 && retryRes.status !== 201 && retryRes.status !== 422) {
          idempotencyViolations++;
          process.stderr.write(
            `[Retry Failure] Retry failed with status ${retryRes.status} for ${unacked.clientOrderId}\n`
          );
        }

        // Verify EXACTLY ONE entry exists in commands journal for this client_order_id
        const { rows: countRows } = await pool.query(
          `SELECT COUNT(*) AS count FROM commands WHERE participant_id = $1 AND client_order_id = $2`,
          [unacked.participant.id, unacked.clientOrderId]
        );
        const orderCount = Number(countRows[0]?.count || 0);
        if (orderCount !== 1) {
          idempotencyViolations++;
          process.stderr.write(
            `[Idempotency Violation] Expected 1 journal row for ${unacked.clientOrderId}, found ${orderCount}\n`
          );
        }
      }

      // c. Check sequence gap-freedom
      const { rows: seqRows } = await pool.query(
        'SELECT MIN(seq) AS min_seq, MAX(seq) AS max_seq, COUNT(*) AS count FROM commands'
      );
      const minSeq = Number(seqRows[0]?.min_seq || 0);
      const maxSeq = Number(seqRows[0]?.max_seq || 0);
      const totalJournalCmds = Number(seqRows[0]?.count || 0);
      const isGapFree =
        totalJournalCmds === 0 || (minSeq === 1 && totalJournalCmds === maxSeq - minSeq + 1);

      // d. State hash equals fresh replay AND verified against naive oracle
      const verifyRes = await sendRequest(BASE_URL, '/admin/verify', {
        headers: { 'X-Admin-Key': ADMIN_KEY },
      });
      const liveHash = verifyRes.body?.canonical_hash;

      const replayRes = await sendRequest(BASE_URL, '/admin/replay', {
        method: 'POST',
        headers: { 'X-Admin-Key': ADMIN_KEY },
        body: JSON.stringify({ from_seq: 1, oracle: true }),
      });
      const replayHash = replayRes.body?.state_hash;
      const oracleVerified = Boolean(replayRes.body?.oracle_verified && replayRes.body?.verified);
      const hashMatched = Boolean(liveHash && replayHash && liveHash === replayHash);

      const roundSuccess =
        ackedResponseMismatches === 0 &&
        idempotencyViolations === 0 &&
        isGapFree &&
        hashMatched &&
        oracleVerified;

      roundResults.push({
        round,
        batch_max_size: batchMaxSize,
        batch_timeout_ms: batchTimeoutMs,
        commands_dispatched: commandCount,
        acked_in_round: ackedInThisRound.length,
        unacked_retried: unackedRetriedCount,
        ack_mismatches: ackedResponseMismatches,
        idempotency_violations: idempotencyViolations,
        total_journal_commands: totalJournalCmds,
        min_seq: minSeq,
        max_seq: maxSeq,
        gap_free: isGapFree,
        live_hash: liveHash,
        replay_hash: replayHash,
        hash_matched: hashMatched,
        oracle_verified: oracleVerified,
        kill_delay_ms: killDelayMs,
        restart_duration_ms: restartDurationMs,
        passed: roundSuccess,
      });

      if (round % 10 === 0 || !roundSuccess) {
        process.stdout.write(
          `[Round ${round}/${TOTAL_ROUNDS}] Batch(${batchMaxSize},${batchTimeoutMs}ms) | ` +
            `Dispatched: ${commandCount} | Acked: ${ackedInThisRound.length} | Retried: ${unackedRetriedCount} | ` +
            `Journal: ${totalJournalCmds} (seq [${minSeq}..${maxSeq}]) | Gap-Free: ${isGapFree} | ` +
            `Oracle: ${oracleVerified} | HashMatch: ${hashMatched} | Status: ${roundSuccess ? 'PASSED' : 'FAILED'}\n`
        );
      }

      if (!roundSuccess) {
        throw new Error(`Chaos round ${round} verification failed!`);
      }

      // Stop child process before next round
      await killProcess(currentChild);
      currentChild = null;
    }

    // Write results to bench/results/chaos-kill-100-rounds-<timestamp>.json
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultsDir = path.resolve(__dirname, '..', 'bench', 'results');
    await fs.mkdir(resultsDir, { recursive: true });
    const resultsFile = path.join(resultsDir, `chaos-kill-100-rounds-${timestamp}.json`);

    const summaryData = {
      timestamp: new Date().toISOString(),
      total_rounds: TOTAL_ROUNDS,
      passed_rounds: roundResults.filter(r => r.passed).length,
      failed_rounds: roundResults.filter(r => !r.passed).length,
      total_commands_dispatched: roundResults.reduce((acc, r) => acc + r.commands_dispatched, 0),
      total_unacknowledged_retried: roundResults.reduce((acc, r) => acc + r.unacked_retried, 0),
      total_journal_commands: roundResults[roundResults.length - 1]?.total_journal_commands || 0,
      total_ack_mismatches: roundResults.reduce((acc, r) => acc + r.ack_mismatches, 0),
      total_idempotency_violations: roundResults.reduce(
        (acc, r) => acc + r.idempotency_violations,
        0
      ),
      all_rounds_gap_free: roundResults.every(r => r.gap_free),
      all_rounds_hash_matched: roundResults.every(r => r.hash_matched),
      all_rounds_oracle_verified: roundResults.every(r => r.oracle_verified),
      rounds: roundResults,
    };

    // Scrub any local path references before saving
    await fs.writeFile(resultsFile, JSON.stringify(summaryData, null, 2), 'utf-8');
    process.stdout.write(`\n=======================================================\n`);
    process.stdout.write(
      `CHAOS TESTING COMPLETE: ${summaryData.passed_rounds}/${TOTAL_ROUNDS} ROUNDS PASSED (0 FAILURES)\n`
    );
    process.stdout.write(
      `Total Dispatched Commands:       ${summaryData.total_commands_dispatched}\n`
    );
    process.stdout.write(
      `Unacknowledged Retries Tested:   ${summaryData.total_unacknowledged_retried}\n`
    );
    process.stdout.write(
      `Total Committed Journal Cmds:    ${summaryData.total_journal_commands}\n`
    );
    process.stdout.write(
      `Oracle Verified Across Rounds:   ${summaryData.all_rounds_oracle_verified}\n`
    );
    process.stdout.write(
      `State Hashes Matched All Rounds: ${summaryData.all_rounds_hash_matched}\n`
    );
    process.stdout.write(`Gap-Free Sequences All Rounds:   ${summaryData.all_rounds_gap_free}\n`);
    process.stdout.write(`Results saved to: bench/results/${path.basename(resultsFile)}\n`);
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
