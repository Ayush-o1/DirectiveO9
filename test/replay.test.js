import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { getPool, closePool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrator.js';
import { seedDatabase, SEED_DATA } from '../scripts/seed.js';
import { MatchingEngine } from '../src/engine/engine.js';
import { Sequencer } from '../src/sequencer/sequencer.js';
import { createApp } from '../src/api/app.js';
import { replayJournal } from '../src/sequencer/replay.js';
import { computeStateHash } from '../src/engine/hash.js';

describe('Deterministic Replay Tool & Verification (Phase 4)', () => {
  let pool;
  let sequencer;
  let app;
  let server;
  let baseUrl;

  const mm1Key = SEED_DATA.participants[0].apiKey;
  const mm2Key = SEED_DATA.participants[1].apiKey;
  const adminKey = SEED_DATA.participants[3].apiKey;

  before(async () => {
    pool = getPool();
    await runMigrations({ pool });

    // Clean tables for fresh test run
    await pool.query(
      'TRUNCATE commands, events, trades, orders, instruments, participants CASCADE'
    );
    await seedDatabase(pool);

    const engine = new MatchingEngine();
    sequencer = new Sequencer({ engine, pool, batchTimeoutMs: 2 });
    await sequencer.init();

    app = createApp({ sequencer, pool, adminKey: 'key_admin_test_secret_99' });

    server = await new Promise(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    baseUrl = `http://localhost:${addr.port}`;
  });

  after(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    if (sequencer) {
      await sequencer.close();
    }
    await closePool();
  });

  async function apiRequest(path, options = {}) {
    const url = `${baseUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };
    const res = await fetch(url, { ...options, headers });
    const body = await res.json().catch(() => null);
    return { status: res.status, body, headers: res.headers };
  }

  it('populates initial activity in the journal', async () => {
    // Submit resting bids and asks
    const res1 = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 100,
        quantity: 10,
        client_order_id: 'rep-b1',
      }),
    });
    assert.equal(res1.status, 201);

    const res2 = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm2Key },
      body: JSON.stringify({
        symbol: 'BTC-USDT',
        side: 'SELL',
        type: 'LIMIT',
        price: 110,
        quantity: 15,
        client_order_id: 'rep-s1',
      }),
    });
    assert.equal(res2.status, 201);

    // Cross the book to generate a trade
    const res3 = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 110,
        quantity: 5,
        client_order_id: 'rep-b2',
      }),
    });
    assert.equal(res3.status, 201);

    // Cancel an order
    const cancelOrderId = res1.body.order_id;
    const res4 = await apiRequest(`/orders/${cancelOrderId}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        symbol: 'BTC-USDT',
        client_order_id: 'rep-c1',
      }),
    });
    assert.equal(res4.status, 200);

    // Submit an IOC order that partially fills and remainder cancels
    const res5 = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'IOC',
        price: 110,
        quantity: 20,
        client_order_id: 'rep-ioc1',
      }),
    });
    assert.equal(res5.status, 201);
  });

  it('replays journal and confirms bit-for-bit event/trade equality and matching state hash', async () => {
    const replayRes = await replayJournal({
      pool,
      fromSeq: 1,
      toSeq: null,
      oracle: false,
    });

    assert.equal(replayRes.verified, true);
    assert.ok(replayRes.commands_replayed >= 5);
    assert.equal(replayRes.divergence, null);
    assert.ok(typeof replayRes.state_hash === 'string' && replayRes.state_hash.length === 64);

    const liveHash = computeStateHash(sequencer.engine);
    assert.equal(replayRes.state_hash, liveHash);
  });

  it('replays journal with --oracle comparing against the independent naive reference oracle', async () => {
    const replayRes = await replayJournal({
      pool,
      fromSeq: 1,
      toSeq: null,
      oracle: true,
    });

    assert.equal(replayRes.verified, true);
    assert.equal(replayRes.oracle_verified, true);
    assert.equal(replayRes.divergence, null);
    assert.ok(replayRes.state_hash);
  });

  it('handles empty replay sequence range gracefully', async () => {
    const replayRes = await replayJournal({
      pool,
      fromSeq: 999999,
      toSeq: 10,
    });

    assert.equal(replayRes.verified, true);
    assert.equal(replayRes.commands_replayed, 0);
  });

  it('GET /admin/verify verifies engine invariants and database consistency checks', async () => {
    const res = await apiRequest('/admin/verify', {
      headers: { 'X-Admin-Key': adminKey },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.invariants_passed, true);
    assert.equal(res.body.checks.book_never_crossed, true);
    assert.equal(res.body.checks.single_location, true);
    assert.equal(res.body.checks.gap_free_sequence, true);
    assert.equal(res.body.checks.bought_equals_sold, true);
    assert.equal(res.body.checks.orders_table_in_sync, true);
    assert.ok(res.body.canonical_hash);
  });

  it('POST /admin/replay verifies journal over HTTP API', async () => {
    const res = await apiRequest('/admin/replay', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ from_seq: 1, oracle: true }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'VERIFIED');
    assert.equal(res.body.verified, true);
    assert.equal(res.body.oracle_verified, true);
    assert.ok(res.body.state_hash);
  });

  it('POST /admin/replay rejects unauthorized requests without admin key', async () => {
    const res = await apiRequest('/admin/replay', {
      method: 'POST',
      headers: { 'X-Admin-Key': 'wrong_key' },
      body: JSON.stringify({ from_seq: 1 }),
    });

    assert.equal(res.status, 403);
  });

  it('GET /admin/verify rejects unauthorized requests without admin key', async () => {
    const res = await apiRequest('/admin/verify', {
      headers: { 'X-Admin-Key': 'wrong_key' },
    });

    assert.equal(res.status, 403);
  });

  it('CLI scripts/replay.js runs successfully and outputs verification info', () => {
    const proc = spawnSync('node', ['scripts/replay.js', '--from=1', '--oracle'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf-8',
    });

    assert.equal(proc.status, 0, `CLI failed with error: ${proc.stderr}`);
    assert.ok(proc.stdout.includes('REPLAY VERIFIED SUCCESSFULLY'));
    assert.ok(proc.stdout.includes('State Hash:'));
    assert.ok(proc.stdout.includes('Oracle Verified:   true'));
  });

  it('detects divergence when stored event row has modified order_id or event_type', async () => {
    // Tamper with an event in DB
    const { rows } = await pool.query('SELECT event_id, order_id, event_type FROM events LIMIT 1');
    assert.ok(rows.length > 0);
    const ev = rows[0];

    // Case 1: Tamper order_id
    await pool.query('UPDATE events SET order_id = 99999 WHERE event_id = $1', [ev.event_id]);
    const resDivOrderId = await replayJournal({ pool, fromSeq: 1 });
    assert.equal(resDivOrderId.verified, false);
    assert.ok(resDivOrderId.divergence.field.includes('order_id'));

    // Case 2: Tamper event_type
    await pool.query('UPDATE events SET order_id = $1, event_type = $2 WHERE event_id = $3', [
      ev.order_id,
      'CORRUPTED_EVENT',
      ev.event_id,
    ]);
    const resDivEventType = await replayJournal({ pool, fromSeq: 1 });
    assert.equal(resDivEventType.verified, false);
    assert.ok(resDivEventType.divergence.field.includes('type'));

    // Restore original event
    await pool.query('UPDATE events SET event_type = $1 WHERE event_id = $2', [
      ev.event_type,
      ev.event_id,
    ]);

    // Verify recovery
    const resRestored = await replayJournal({ pool, fromSeq: 1 });
    assert.equal(resRestored.verified, true);
  });

  it('detects divergence when stored trade row has modified price or quantity', async () => {
    const { rows } = await pool.query('SELECT trade_id, price FROM trades LIMIT 1');
    if (rows.length > 0) {
      const tr = rows[0];
      await pool.query('UPDATE trades SET price = 99999 WHERE trade_id = $1', [tr.trade_id]);

      const resDivTrade = await replayJournal({ pool, fromSeq: 1 });
      assert.equal(resDivTrade.verified, false);
      assert.ok(resDivTrade.divergence.field.includes('trade'));

      // Restore trade
      await pool.query('UPDATE trades SET price = $1 WHERE trade_id = $2', [tr.price, tr.trade_id]);
      const resRestored = await replayJournal({ pool, fromSeq: 1 });
      assert.equal(resRestored.verified, true);
    }
  });

  it('POST /admin/replay returns 409 DIVERGED when a divergence is detected', async () => {
    const { rows } = await pool.query('SELECT event_id, event_type FROM events LIMIT 1');
    assert.ok(rows.length > 0);
    const ev = rows[0];

    await pool.query('UPDATE events SET event_type = $1 WHERE event_id = $2', [
      'DIVERGED_TYPE',
      ev.event_id,
    ]);

    const res = await apiRequest('/admin/replay', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ from_seq: 1 }),
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.status, 'DIVERGED');
    assert.equal(res.body.verified, false);
    assert.ok(res.body.divergence);

    // Restore event
    await pool.query('UPDATE events SET event_type = $1 WHERE event_id = $2', [
      ev.event_type,
      ev.event_id,
    ]);
  });

  it('detects trade_count mismatch divergence when a trade row is missing from DB', async () => {
    const { rows } = await pool.query('SELECT * FROM trades LIMIT 1');
    assert.ok(rows.length > 0);
    const tr = rows[0];

    await pool.query('DELETE FROM trades WHERE trade_id = $1', [tr.trade_id]);

    const res = await replayJournal({ pool, fromSeq: 1 });
    assert.equal(res.verified, false);
    assert.equal(res.divergence.field, 'trade_count');

    // Restore trade
    await pool.query(
      `INSERT INTO trades (trade_id, seq, symbol, price, quantity, maker_order_id, taker_order_id, maker_participant_id, taker_participant_id, taker_side, ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        tr.trade_id,
        tr.seq,
        tr.symbol,
        tr.price,
        tr.quantity,
        tr.maker_order_id,
        tr.taker_order_id,
        tr.maker_participant_id,
        tr.taker_participant_id,
        tr.taker_side,
        tr.ts,
      ]
    );

    const restored = await replayJournal({ pool, fromSeq: 1 });
    assert.equal(restored.verified, true);
  });

  it('CLI scripts/replay.js exits with code 1 on divergence', async () => {
    const { rows } = await pool.query('SELECT event_id, event_type FROM events LIMIT 1');
    assert.ok(rows.length > 0);
    const ev = rows[0];

    await pool.query('UPDATE events SET event_type = $1 WHERE event_id = $2', [
      'BAD_EVENT',
      ev.event_id,
    ]);

    const proc = spawnSync('node', ['scripts/replay.js', '--from', '1', '--to', '10'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf-8',
    });

    assert.equal(proc.status, 1);
    assert.ok(proc.stderr.includes('REPLAY DIVERGENCE DETECTED'));

    // Restore event
    await pool.query('UPDATE events SET event_type = $1 WHERE event_id = $2', [
      ev.event_type,
      ev.event_id,
    ]);
  });

  it('CLI scripts/replay.js handles positional arguments and --to flag', () => {
    const proc = spawnSync('node', ['scripts/replay.js', '1', '5'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf-8',
    });

    assert.equal(proc.status, 0);
    assert.ok(proc.stdout.includes('REPLAY VERIFIED SUCCESSFULLY'));
  });
});
