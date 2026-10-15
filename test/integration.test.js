import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getPool, closePool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrator.js';
import { seedDatabase, SEED_DATA } from '../scripts/seed.js';
import { MatchingEngine } from '../src/engine/engine.js';
import { Sequencer } from '../src/sequencer/sequencer.js';
import { createApp } from '../src/api/app.js';

describe('DirectiveO9 Integration Tests (PostgreSQL Journal, Replay & API)', () => {
  let pool;
  let sequencer;
  let app;
  let server;
  let baseUrl;
  let failHookActive = false;

  const mm1Key = SEED_DATA.participants[0].apiKey;
  const mm2Key = SEED_DATA.participants[1].apiKey;
  const traderKey = SEED_DATA.participants[2].apiKey;
  const adminKey = SEED_DATA.participants[3].apiKey;

  before(async () => {
    pool = getPool();
    // Run migrations and seed test database
    await runMigrations({ pool });

    // Clean tables for fresh test run
    await pool.query(
      'TRUNCATE commands, events, trades, orders, instruments, participants CASCADE'
    );
    await seedDatabase(pool);

    const engine = new MatchingEngine();
    sequencer = new Sequencer({
      engine,
      pool,
      batchTimeoutMs: 2,
      beforeCommitHook: async () => {
        if (failHookActive) {
          failHookActive = false;
          throw new Error('FAULT_INJECTED_BATCH_COMMIT_FAILURE');
        }
      },
    });
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
      server.closeAllConnections?.();
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

    const res = await fetch(url, {
      ...options,
      headers,
    });

    const body = await res.json().catch(() => null);
    return { status: res.status, body, headers: res.headers };
  }

  it('verifies health endpoint returns system status', async () => {
    const res = await apiRequest('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'OK');
    assert.ok(res.body.instruments.includes('BTC-USDT'));
    assert.ok(res.body.instruments.includes('ETH-USDT'));
  });

  it('rejects schema-invalid requests with 400 without advancing sequence number', async () => {
    const initialSeq = sequencer.lastSeq;

    // Negative quantity is schema invalid
    const res = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 100,
        quantity: -10,
      }),
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'INVALID_SCHEMA');
    assert.equal(sequencer.lastSeq, initialSeq);
  });

  it('journals valid requests rejected by the engine and preserves gap-free sequence', async () => {
    const initialSeq = sequencer.lastSeq;

    // Price not aligned with tick_size 5 on ETH-USDT (schema-valid integer, but engine invalid tick)
    const res = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        symbol: 'ETH-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 201, // tick size is 5
        quantity: 10,
      }),
    });

    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'INVALID_TICK');
    assert.equal(sequencer.lastSeq, initialSeq + 1);

    // Verify command was journaled
    const { rows } = await pool.query('SELECT * FROM commands WHERE seq = $1', [sequencer.lastSeq]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'REJECTED');
  });

  it('submits resting orders, matches crossing orders, and persists trades', async () => {
    // 1. MM1 places resting SELL 10 @ 100 on BTC-USDT
    const askRes = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        symbol: 'BTC-USDT',
        side: 'SELL',
        type: 'LIMIT',
        price: 100,
        quantity: 10,
      }),
    });

    assert.equal(askRes.status, 201);
    assert.equal(askRes.body.success, true);
    const askOrderId = askRes.body.order_id;

    // Check book depth
    const depthBefore = await apiRequest('/book/BTC-USDT');
    assert.equal(depthBefore.body.asks.length, 1);
    assert.equal(depthBefore.body.asks[0].price, 100);
    assert.equal(depthBefore.body.asks[0].quantity, 10);

    // 2. TRADER1 places aggressive crossing BUY 10 @ 100
    const bidRes = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': traderKey },
      body: JSON.stringify({
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 100,
        quantity: 10,
      }),
    });

    assert.equal(bidRes.status, 201);
    assert.equal(bidRes.body.success, true);

    // Verify trade was executed and recorded in DB
    const { rows: trades } = await pool.query('SELECT * FROM trades WHERE maker_order_id = $1', [
      askOrderId,
    ]);
    assert.equal(trades.length, 1);
    assert.equal(Number(trades[0].price), 100);
    assert.equal(Number(trades[0].quantity), 10);
    assert.equal(trades[0].maker_participant_id, 1); // MM1
    assert.equal(trades[0].taker_participant_id, 3); // TRADER1

    // Verify book is now empty
    const depthAfter = await apiRequest('/book/BTC-USDT');
    assert.equal(depthAfter.body.asks.length, 0);
    assert.equal(depthAfter.body.bids.length, 0);
  });

  it('cancels resting orders and prevents non-owner cancellation', async () => {
    // 1. MM1 places resting BUY 10 @ 95
    const placeRes = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 95,
        quantity: 10,
      }),
    });

    assert.equal(placeRes.status, 201);
    const orderId = placeRes.body.order_id;

    // 2. TRADER1 attempts to cancel MM1's order -> 403 Forbidden (NOT_OWNER)
    const unauthorizedCancelRes = await apiRequest(`/orders/${orderId}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': traderKey },
      body: JSON.stringify({ symbol: 'BTC-USDT' }),
    });

    assert.equal(unauthorizedCancelRes.status, 403);
    assert.equal(unauthorizedCancelRes.body.error, 'NOT_OWNER');

    // Order still exists on book
    const depthMid = await apiRequest('/book/BTC-USDT');
    assert.equal(depthMid.body.bids.length, 1);

    // 3. MM1 cancels their own order -> 200 OK
    const ownerCancelRes = await apiRequest(`/orders/${orderId}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({ symbol: 'BTC-USDT' }),
    });

    assert.equal(ownerCancelRes.status, 200);
    assert.equal(ownerCancelRes.body.success, true);

    // Order unlinked from book
    const depthAfter = await apiRequest('/book/BTC-USDT');
    assert.equal(depthAfter.body.bids.length, 0);
  });

  it('handles duplicate retries idempotently and rejects conflicting payloads with 409', async () => {
    const clientOrderId = 'retry-test-unique-1001';

    // 1. Initial submission
    const res1 = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        client_order_id: clientOrderId,
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 90,
        quantity: 5,
      }),
    });

    assert.equal(res1.status, 201);
    const originalOrderId = res1.body.order_id;
    const originalSeq = res1.body.seq;

    // 2. Retry identical submission
    const res2 = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        client_order_id: clientOrderId,
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 90,
        quantity: 5,
      }),
    });

    assert.equal(res2.status, 201);
    assert.equal(res2.body.order_id, originalOrderId);
    assert.equal(res2.body.seq, originalSeq);

    // 3. Retry same client_order_id with different payload -> 409 Conflict
    const resConflict = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        client_order_id: clientOrderId,
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 91, // Different price!
        quantity: 5,
      }),
    });

    assert.equal(resConflict.status, 409);
    assert.equal(resConflict.body.error, 'IDEMPOTENCY_CONFLICT');

    // Verify exactly one command row in DB
    const { rows } = await pool.query('SELECT count(*) FROM commands WHERE client_order_id = $1', [
      clientOrderId,
    ]);
    assert.equal(Number(rows[0].count), 1);
  });

  it('processes 50 concurrent identical submissions creating exactly one order', async () => {
    const concurrentClientId = 'concurrent-test-batch-50';

    const payload = JSON.stringify({
      client_order_id: concurrentClientId,
      symbol: 'BTC-USDT',
      side: 'BUY',
      type: 'LIMIT',
      price: 85,
      quantity: 5,
    });

    // Launch 50 identical concurrent submissions simultaneously
    const requests = Array.from({ length: 50 }, () =>
      apiRequest('/orders', {
        method: 'POST',
        headers: { 'X-API-Key': mm2Key },
        body: payload,
      })
    );

    const responses = await Promise.all(requests);

    // All 50 must resolve with status 201
    for (const r of responses) {
      assert.equal(r.status, 201);
      assert.equal(r.body.order_id, responses[0].body.order_id);
      assert.equal(r.body.seq, responses[0].body.seq);
    }

    // Verify database only persisted exactly 1 command
    const { rows } = await pool.query('SELECT count(*) FROM commands WHERE client_order_id = $1', [
      concurrentClientId,
    ]);
    assert.equal(Number(rows[0].count), 1);
  });

  it('rejects with 503 QUEUE_FULL when sequencer ingress queue capacity is saturated', async () => {
    // Create an isolated small-queue sequencer
    const smallEngine = new MatchingEngine();
    smallEngine.registerInstrument({ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 });
    const saturatedSequencer = new Sequencer({
      engine: smallEngine,
      maxQueueSize: 2,
      batchTimeoutMs: 500, // delay batch to fill queue
    });

    // Enqueue 2 items to fill the queue
    saturatedSequencer.enqueue({
      type: 'LIMIT',
      participant_id: 1,
      symbol: 'BTC-USDT',
      side: 'BUY',
      price: 100,
      quantity: 1,
    });
    saturatedSequencer.enqueue({
      type: 'LIMIT',
      participant_id: 1,
      symbol: 'BTC-USDT',
      side: 'BUY',
      price: 100,
      quantity: 1,
    });

    // 3rd item should be rejected immediately with QUEUE_FULL (503)
    await assert.rejects(
      async () => {
        await saturatedSequencer.enqueue({
          type: 'LIMIT',
          participant_id: 1,
          symbol: 'BTC-USDT',
          side: 'BUY',
          price: 100,
          quantity: 1,
        });
      },
      err => {
        assert.equal(err.status, 503);
        assert.equal(err.code, 'QUEUE_FULL');
        return true;
      }
    );

    await saturatedSequencer.close();
  });

  it('restarts engine from durable journal and achieves bit-for-bit book equality', async () => {
    // 1. Populate book with resting orders across multiple levels
    await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 80,
        quantity: 10,
      }),
    });
    await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 82,
        quantity: 20,
      }),
    });
    await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm2Key },
      body: JSON.stringify({
        symbol: 'BTC-USDT',
        side: 'SELL',
        type: 'LIMIT',
        price: 120,
        quantity: 15,
      }),
    });

    // Capture depth before restart
    const depthBefore = sequencer.engine.getDepth('BTC-USDT', 50);

    // 2. Simulate shutdown and restart: instantiate fresh engine and sequencer from DB journal
    const freshEngine = new MatchingEngine();
    const freshSequencer = new Sequencer({ engine: freshEngine, pool });
    await freshSequencer.init();

    // Verify sequence parity
    assert.equal(freshSequencer.lastSeq, sequencer.lastSeq);

    // Verify depth parity
    const depthAfter = freshEngine.getDepth('BTC-USDT', 50);
    assert.deepEqual(depthAfter, depthBefore);

    // Verify invariant validation on replayed engine
    assert.equal(freshEngine.checkInvariants(), true);

    await freshSequencer.close();
  });

  it('rejects unauthorized requests with 401 for missing or invalid API keys', async () => {
    // Missing key
    const resNoKey = await apiRequest('/orders', {
      method: 'POST',
      body: JSON.stringify({
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 100,
        quantity: 5,
      }),
    });
    assert.equal(resNoKey.status, 401);
    assert.equal(resNoKey.body.error, 'UNAUTHORIZED');

    // Invalid key
    const resBadKey = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': 'invalid_secret_key' },
      body: JSON.stringify({
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 100,
        quantity: 5,
      }),
    });
    assert.equal(resBadKey.status, 401);
    assert.equal(resBadKey.body.error, 'UNAUTHORIZED');
  });

  it('queries orders by ID, trades history, and event logs', async () => {
    // 1. Query existing order (order_id 2 from first accepted order)
    const orderRes = await apiRequest('/orders/2');
    assert.equal(orderRes.status, 200);
    assert.ok(orderRes.body.order);
    assert.equal(Number(orderRes.body.order.order_id), 2);

    // 2. Query unknown order -> 404
    const unknownRes = await apiRequest('/orders/999999');
    assert.equal(unknownRes.status, 404);
    assert.equal(unknownRes.body.error, 'ORDER_NOT_FOUND');

    // 3. Query invalid parameter -> 400
    const invalidParamRes = await apiRequest('/orders/abc');
    assert.equal(invalidParamRes.status, 400);

    // 4. Query trades history
    const tradesRes = await apiRequest('/trades?symbol=BTC-USDT&limit=10');
    assert.equal(tradesRes.status, 200);
    assert.ok(Array.isArray(tradesRes.body));
    assert.ok(tradesRes.body.length > 0);

    // 5. Query events log
    const eventsRes = await apiRequest('/events?limit=10');
    assert.equal(eventsRes.status, 200);
    assert.ok(Array.isArray(eventsRes.body));
    assert.ok(eventsRes.body.length > 0);
  });

  it('enforces admin authorization and registers new instruments and participants', async () => {
    // 1. Non-admin attempting to register instrument -> 403
    const forbiddenRes = await apiRequest('/admin/instruments', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        symbol: 'SOL-USDT',
        tick_size: 1,
        lot_size: 1,
      }),
    });
    assert.equal(forbiddenRes.status, 403);
    assert.equal(forbiddenRes.body.error, 'FORBIDDEN');

    // 2. Admin registering new instrument via X-Admin-Key -> 201
    const adminInstRes = await apiRequest('/admin/instruments', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({
        symbol: 'SOL-USDT',
        tick_size: 2,
        lot_size: 5,
      }),
    });
    assert.equal(adminInstRes.status, 201);
    assert.equal(adminInstRes.body.success, true);
    assert.ok(sequencer.engine.instruments.has('SOL-USDT'));

    // 3. Admin registering new participant -> 201
    const adminPartRes = await apiRequest('/admin/participants', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({
        participant_id: 4,
        name: 'PROP_SHOP_1',
        apiKey: 'key_propshop1_test_secret_4',
        is_admin: false,
      }),
    });
    assert.equal(adminPartRes.status, 201);
    assert.equal(adminPartRes.body.success, true);

    // 4. Verify admin endpoint
    const verifyRes = await apiRequest('/admin/verify', {
      method: 'GET',
      headers: { 'X-Admin-Key': adminKey },
    });
    assert.equal(verifyRes.status, 200);
    assert.equal(verifyRes.body.invariants_passed, true);
  });

  it('handles batch commit failure with fail-stop recovery and journal rebuild', async () => {
    const initialSeq = sequencer.lastSeq;

    // Trigger commit failure on next batch via constructor-injected hook
    failHookActive = true;

    const failRes = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 70,
        quantity: 10,
      }),
    });

    assert.equal(failRes.status, 500);
    assert.equal(failRes.body.error, 'COMMIT_FAILED');

    // Sequencer recovered and rolled back in-memory sequence counter to match DB
    assert.equal(sequencer.isRecovering, false);
    assert.equal(sequencer.lastSeq, initialSeq);

    // Verify uncommitted order was not written to database
    const { rows } = await pool.query('SELECT * FROM commands WHERE seq > $1', [initialSeq]);
    assert.equal(rows.length, 0);

    // Verify subsequent submissions succeed seamlessly and advance seq from clean state
    const successRes = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 70,
        quantity: 10,
      }),
    });

    assert.equal(successRes.status, 201);
    assert.equal(successRes.body.seq, initialSeq + 1);
  });

  it('resolves duplicate commands through PostgreSQL constraint after in-memory cache eviction', async () => {
    // 1. Submit order
    const origRes = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        client_order_id: 'evict-test-100',
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 60,
        quantity: 5,
      }),
    });
    assert.equal(origRes.status, 201);
    const origSeq = origRes.body.seq;

    // 2. Simulate LRU cache eviction
    sequencer.idempotencyCache.delete(1, 'evict-test-100');
    assert.equal(sequencer.idempotencyCache.has(1, 'evict-test-100'), false);

    // 3. Duplicate arrival after eviction resolves through database
    const dupRes = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        client_order_id: 'evict-test-100',
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 60,
        quantity: 5,
      }),
    });
    assert.equal(dupRes.status, 201);
    assert.equal(dupRes.body.seq, origSeq);
    assert.equal(sequencer.idempotencyCache.has(1, 'evict-test-100'), true);

    // 4. Evict again and submit with conflicting payload -> 409 Conflict
    sequencer.idempotencyCache.delete(1, 'evict-test-100');
    const conflictRes = await apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        client_order_id: 'evict-test-100',
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 65, // Changed price
        quantity: 5,
      }),
    });
    assert.equal(conflictRes.status, 409);
    assert.equal(conflictRes.body.error, 'IDEMPOTENCY_CONFLICT');
  });

  it('fails startup with clear error when database events diverge from regenerated replay', async () => {
    // Query an existing event
    const { rows } = await pool.query('SELECT event_id, event_type FROM events LIMIT 1');
    assert.ok(rows.length > 0);
    const targetEventId = rows[0].event_id;
    const originalEvent = rows[0].event_type;

    // Tamper with the event in database
    await pool.query('UPDATE events SET event_type = $1 WHERE event_id = $2', [
      'TAMPERED_EVENT',
      targetEventId,
    ]);

    const badSequencer = new Sequencer({ pool });
    await assert.rejects(
      () => badSequencer.init(),
      err => err.message.includes('Startup replay divergence at seq')
    );

    // Restore database row
    await pool.query('UPDATE events SET event_type = $1 WHERE event_id = $2', [
      originalEvent,
      targetEventId,
    ]);
  });

  it('streams live events over Server-Sent Events (SSE)', async () => {
    // Connect to /stream
    const controller = new AbortController();
    const streamRes = await fetch(`${baseUrl}/stream?symbol=BTC-USDT`, {
      signal: controller.signal,
    });
    assert.equal(streamRes.status, 200);
    assert.equal(streamRes.headers.get('content-type'), 'text/event-stream');

    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();

    // Trigger an order submission while stream is open
    const submitPromise = apiRequest('/orders', {
      method: 'POST',
      headers: { 'X-API-Key': mm1Key },
      body: JSON.stringify({
        symbol: 'BTC-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: 75,
        quantity: 5,
      }),
    });

    let receivedData = '';
    const readTimeout = setTimeout(() => controller.abort(), 2000);

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        receivedData += decoder.decode(value, { stream: true });
        if (receivedData.includes('ORDER_ACCEPTED')) {
          break;
        }
      }
    } catch {
      // Aborted as expected
    } finally {
      clearTimeout(readTimeout);
      try {
        await reader.cancel();
      } catch {
        // Ignore abort error
      }
      controller.abort();
    }

    await submitPromise;
    assert.ok(receivedData.includes('ORDER_ACCEPTED'));
  });
});
