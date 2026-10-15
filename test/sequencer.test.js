import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MatchingEngine } from '../src/engine/engine.js';
import { Sequencer } from '../src/sequencer/sequencer.js';
import { IdempotencyCache, computePayloadHash } from '../src/sequencer/idempotency.js';

describe('Sequencer & Idempotency Unit Tests', () => {
  it('computes consistent payload hashes across key orders and handles non-objects', () => {
    const hash1 = computePayloadHash({ symbol: 'BTC-USDT', price: 100, quantity: 5 });
    const hash2 = computePayloadHash({ quantity: 5, symbol: 'BTC-USDT', price: 100 });
    assert.equal(hash1, hash2);

    const hashNull = computePayloadHash(null);
    assert.ok(typeof hashNull === 'string');

    const hashString = computePayloadHash('raw_text');
    assert.ok(typeof hashString === 'string');
  });

  it('manages IdempotencyCache lifecycle and enforces LRU eviction', () => {
    const cache = new IdempotencyCache(2);
    assert.equal(cache.size, 0);

    cache.set(10, 'c1', { data: 1 });
    cache.set(10, 'c2', { data: 2 });
    assert.equal(cache.size, 2);
    assert.ok(cache.has(10, 'c1'));
    assert.ok(cache.has(10, 'c2'));

    // Access c1 to refresh its LRU position
    const c1 = cache.get(10, 'c1');
    assert.deepEqual(c1, { data: 1 });

    // Insert c3; c2 should be evicted as oldest
    cache.set(10, 'c3', { data: 3 });
    assert.equal(cache.size, 2);
    assert.equal(cache.get(10, 'c2'), null);
    assert.ok(cache.has(10, 'c1'));
    assert.ok(cache.has(10, 'c3'));

    // Test overwrite
    cache.set(10, 'c1', { data: 99 });
    assert.deepEqual(cache.get(10, 'c1'), { data: 99 });

    // Test delete and clear
    assert.equal(cache.delete(10, 'c1'), true);
    assert.equal(cache.delete(10, 'nonexistent'), false);
    assert.equal(cache.size, 1);

    cache.clear();
    assert.equal(cache.size, 0);
  });

  it('handles in-memory sequencer operations without pool', async () => {
    const engine = new MatchingEngine({
      instruments: [{ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 }],
    });
    const sequencer = new Sequencer({ engine, maxQueueSize: 5, batchTimeoutMs: 1 });
    await sequencer.init();

    // Enqueue valid order
    const res = await sequencer.enqueue({
      type: 'LIMIT',
      participant_id: 1,
      client_order_id: 'mem-1',
      symbol: 'BTC-USDT',
      side: 'BUY',
      price: 100,
      quantity: 5,
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);

    // Duplicate submission with identical payload returns cached result
    const dupRes = await sequencer.enqueue({
      type: 'LIMIT',
      participant_id: 1,
      client_order_id: 'mem-1',
      symbol: 'BTC-USDT',
      side: 'BUY',
      price: 100,
      quantity: 5,
    });
    assert.equal(dupRes.status, 201);

    // Duplicate submission with conflicting payload throws 409
    await assert.rejects(
      () =>
        sequencer.enqueue({
          type: 'LIMIT',
          participant_id: 1,
          client_order_id: 'mem-1',
          symbol: 'BTC-USDT',
          side: 'BUY',
          price: 105,
          quantity: 5,
        }),
      err => err.status === 409 && err.code === 'IDEMPOTENCY_CONFLICT'
    );

    // Queue full rejection
    const fullPromises = [];
    for (let i = 0; i < 5; i++) {
      fullPromises.push(
        sequencer.enqueue({
          type: 'LIMIT',
          participant_id: 1,
          symbol: 'BTC-USDT',
          side: 'BUY',
          price: 100,
          quantity: 1,
        })
      );
    }

    await assert.rejects(
      () =>
        sequencer.enqueue({
          type: 'LIMIT',
          participant_id: 1,
          symbol: 'BTC-USDT',
          side: 'BUY',
          price: 100,
          quantity: 1,
        }),
      err => err.status === 503 && err.code === 'QUEUE_FULL'
    );

    await Promise.all(fullPromises);

    // Close and reject after shutdown
    await sequencer.close();
    await assert.rejects(
      () =>
        sequencer.enqueue({
          type: 'LIMIT',
          participant_id: 1,
          symbol: 'BTC-USDT',
          side: 'BUY',
          price: 100,
          quantity: 1,
        }),
      err => err.status === 503 && err.code === 'SERVICE_UNAVAILABLE'
    );
  });

  it('rejects in-flight commands with conflicting payload with 409', async () => {
    const engine = new MatchingEngine({
      instruments: [{ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 }],
    });
    const sequencer = new Sequencer({ engine, maxQueueSize: 10, batchTimeoutMs: 1000 });

    const p1 = sequencer.enqueue({
      type: 'LIMIT',
      participant_id: 2,
      client_order_id: 'inflight-1',
      symbol: 'BTC-USDT',
      side: 'BUY',
      price: 100,
      quantity: 5,
    });

    const pConflict = sequencer.enqueue({
      type: 'LIMIT',
      participant_id: 2,
      client_order_id: 'inflight-1',
      symbol: 'BTC-USDT',
      side: 'BUY',
      price: 105,
      quantity: 5,
    });

    await assert.rejects(
      () => pConflict,
      err => err.status === 409 && err.code === 'IDEMPOTENCY_CONFLICT'
    );

    // Flush batch to resolve p1
    await sequencer._processBatch();
    const res1 = await p1;
    assert.equal(res1.status, 201);
    await sequencer.close();
  });

  it('rejects new enqueue commands with 503 SERVICE_RECOVERING when isRecovering is true', async () => {
    const engine = new MatchingEngine({
      instruments: [{ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 }],
    });
    const sequencer = new Sequencer({ engine });
    sequencer.isRecovering = true;

    await assert.rejects(
      () =>
        sequencer.enqueue({
          type: 'LIMIT',
          participant_id: 1,
          symbol: 'BTC-USDT',
          side: 'BUY',
          price: 100,
          quantity: 1,
        }),
      err => err.status === 503 && err.code === 'SERVICE_RECOVERING'
    );
  });

  it('detects trade and order divergence during replay', async () => {
    const engine = new MatchingEngine({
      instruments: [{ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 }],
    });

    const mockPool = {
      query: async sql => {
        if (sql.includes('FROM instruments')) {
          return { rows: [{ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 }] };
        }
        if (sql.includes('MAX(seq)')) {
          return { rows: [{ max_seq: '2' }] };
        }
        if (sql.includes('FROM commands')) {
          return {
            rows: [
              {
                seq: 1,
                command_type: 'LIMIT',
                participant_id: 1,
                client_order_id: 'c1',
                symbol: 'BTC-USDT',
                side: 'SELL',
                price: 100,
                quantity: 10,
                order_id: 1,
                payload_hash: 'h1',
                status: 'COMMITTED',
                response_status: 201,
                response_body: {},
                ts: 1000,
              },
              {
                seq: 2,
                command_type: 'LIMIT',
                participant_id: 2,
                client_order_id: 'c2',
                symbol: 'BTC-USDT',
                side: 'BUY',
                price: 100,
                quantity: 10,
                order_id: 2,
                payload_hash: 'h2',
                status: 'COMMITTED',
                response_status: 200,
                response_body: {},
                ts: 1001,
              },
            ],
          };
        }
        if (sql.includes('FROM events')) {
          return {
            rows: [
              {
                event_id: 1,
                seq: 1,
                event_type: 'ORDER_ACCEPTED',
                order_id: 1,
                participant_id: 1,
                payload: {},
                ts: 1000,
              },
              {
                event_id: 2,
                seq: 2,
                event_type: 'TRADE_EXECUTED',
                order_id: 1,
                participant_id: 1,
                payload: {},
                ts: 1001,
              },
              {
                event_id: 3,
                seq: 2,
                event_type: 'ORDER_FILLED',
                order_id: 1,
                participant_id: 1,
                payload: {},
                ts: 1001,
              },
              {
                event_id: 4,
                seq: 2,
                event_type: 'ORDER_FILLED',
                order_id: 2,
                participant_id: 2,
                payload: {},
                ts: 1001,
              },
            ],
          };
        }
        if (sql.includes('FROM trades')) {
          return {
            rows: [
              {
                trade_id: 1,
                seq: 2,
                symbol: 'BTC-USDT',
                price: 99, // Divergent: should be 100
                quantity: 10,
                maker_order_id: 1,
                taker_order_id: 2,
                maker_participant_id: 1,
                taker_participant_id: 2,
                taker_side: 'BUY',
                ts: 1001,
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const seq = new Sequencer({ engine, pool: mockPool });
    await assert.rejects(
      () => seq.init(),
      err => err.message.includes('Startup replay divergence at seq 2: trade[0] mismatch')
    );
  });

  it('detects event count and event type divergence during replay', async () => {
    const engine = new MatchingEngine({
      instruments: [{ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 }],
    });

    const mockPoolEventCount = {
      query: async sql => {
        if (sql.includes('FROM instruments')) {
          return { rows: [{ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 }] };
        }
        if (sql.includes('MAX(seq)')) return { rows: [{ max_seq: '1' }] };
        if (sql.includes('FROM commands')) {
          return {
            rows: [
              {
                seq: 1,
                command_type: 'LIMIT',
                participant_id: 1,
                symbol: 'BTC-USDT',
                side: 'BUY',
                price: 100,
                quantity: 10,
                order_id: 1,
                payload_hash: 'h1',
                status: 'COMMITTED',
                response_status: 201,
                response_body: {},
                ts: 1000,
              },
            ],
          };
        }
        if (sql.includes('FROM events')) {
          // Empty stored events -> count divergence
          return { rows: [] };
        }
        return { rows: [] };
      },
    };

    const seq1 = new Sequencer({ engine, pool: mockPoolEventCount });
    await assert.rejects(
      () => seq1._replayJournal(1, 5),
      err => err.message.includes('expected 0 events but regenerated 1')
    );

    // Event type divergence
    const mockPoolEventType = {
      query: async sql => {
        if (sql.includes('FROM instruments')) {
          return { rows: [{ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 }] };
        }
        if (sql.includes('MAX(seq)')) return { rows: [{ max_seq: '1' }] };
        if (sql.includes('FROM commands')) {
          return {
            rows: [
              {
                seq: 1,
                command_type: 'LIMIT',
                participant_id: 1,
                symbol: 'BTC-USDT',
                side: 'BUY',
                price: 100,
                quantity: 10,
                order_id: 1,
                payload_hash: 'h1',
                status: 'COMMITTED',
                response_status: 201,
                response_body: {},
                ts: 1000,
              },
            ],
          };
        }
        if (sql.includes('FROM events')) {
          return {
            rows: [
              {
                event_id: 1,
                seq: 1,
                event_type: 'ORDER_REJECTED', // Divergent: should be ORDER_ACCEPTED
                order_id: 1,
                participant_id: 1,
                payload: {},
                ts: 1000,
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const seq2 = new Sequencer({ engine: new MatchingEngine(), pool: mockPoolEventType });
    await assert.rejects(
      () => seq2.init(),
      err => err.message.includes('type mismatch')
    );

    // Order ID divergence
    const mockPoolOrderId = {
      query: async sql => {
        if (sql.includes('FROM instruments')) {
          return { rows: [{ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 }] };
        }
        if (sql.includes('MAX(seq)')) return { rows: [{ max_seq: '1' }] };
        if (sql.includes('FROM commands')) {
          return {
            rows: [
              {
                seq: 1,
                command_type: 'LIMIT',
                participant_id: 1,
                symbol: 'BTC-USDT',
                side: 'BUY',
                price: 100,
                quantity: 10,
                order_id: 1,
                payload_hash: 'h1',
                status: 'COMMITTED',
                response_status: 201,
                response_body: {},
                ts: 1000,
              },
            ],
          };
        }
        if (sql.includes('FROM events')) {
          return {
            rows: [
              {
                event_id: 1,
                seq: 1,
                event_type: 'ORDER_ACCEPTED',
                order_id: 999, // Divergent order_id
                participant_id: 1,
                payload: {},
                ts: 1000,
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const seq3 = new Sequencer({ engine: new MatchingEngine(), pool: mockPoolOrderId });
    await assert.rejects(
      () => seq3.init(),
      err => err.message.includes('order_id mismatch')
    );
  });

  it('flushes batch immediately when batchMaxSize is reached and handles CANCEL without pool', async () => {
    const engine = new MatchingEngine({
      instruments: [{ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 }],
    });
    // batchMaxSize: 2, batchTimeoutMs: 10
    const sequencer = new Sequencer({
      engine,
      batchMaxSize: 2,
      batchTimeoutMs: 10,
    });

    const p1 = sequencer.enqueue({
      type: 'LIMIT',
      participant_id: 1,
      symbol: 'BTC-USDT',
      side: 'BUY',
      price: 100,
      quantity: 5,
    });

    const p2 = sequencer.enqueue({
      type: 'LIMIT',
      participant_id: 1,
      symbol: 'BTC-USDT',
      side: 'BUY',
      price: 99,
      quantity: 5,
    });

    const [res1, res2] = await Promise.all([p1, p2]);
    assert.equal(res1.status, 201);
    assert.equal(res2.status, 201);

    // Cancel command without pool
    const cancelRes = await sequencer.enqueue({
      type: 'CANCEL',
      order_id: res1.body.order_id,
      participant_id: 1,
      symbol: 'BTC-USDT',
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.success, true);
    await sequencer.close();
  });
});
