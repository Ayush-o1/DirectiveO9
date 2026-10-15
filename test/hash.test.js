import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MatchingEngine } from '../src/engine/engine.js';
import {
  computeStateHash,
  projectCanonicalState,
  canonicalJsonStringify,
} from '../src/engine/hash.js';

describe('Canonical State Hashing & Serialization (ADR 0002)', () => {
  function createPopulatedEngine() {
    const engine = new MatchingEngine({
      instruments: [
        { symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 },
        { symbol: 'ETH-USDT', tick_size: 1, lot_size: 1 },
      ],
    });

    // Resting bids
    engine.processCommand({
      type: 'LIMIT',
      order_id: 1,
      participant_id: 10,
      symbol: 'BTC-USDT',
      side: 'BUY',
      price: 100,
      quantity: 10,
      seq: 1,
      ts: 1000,
    });
    engine.processCommand({
      type: 'LIMIT',
      order_id: 2,
      participant_id: 11,
      symbol: 'BTC-USDT',
      side: 'BUY',
      price: 100,
      quantity: 5,
      seq: 2,
      ts: 1001,
    });
    engine.processCommand({
      type: 'LIMIT',
      order_id: 3,
      participant_id: 12,
      symbol: 'BTC-USDT',
      side: 'BUY',
      price: 99,
      quantity: 8,
      seq: 3,
      ts: 1002,
    });

    // Resting asks
    engine.processCommand({
      type: 'LIMIT',
      order_id: 4,
      participant_id: 13,
      symbol: 'BTC-USDT',
      side: 'SELL',
      price: 105,
      quantity: 12,
      seq: 4,
      ts: 1003,
    });

    // ETH order
    engine.processCommand({
      type: 'LIMIT',
      order_id: 5,
      participant_id: 14,
      symbol: 'ETH-USDT',
      side: 'BUY',
      price: 200,
      quantity: 4,
      seq: 5,
      ts: 1004,
    });

    return engine;
  }

  it('generates deterministic SHA-256 state hashes for identical engine states', () => {
    const engine1 = createPopulatedEngine();
    const engine2 = createPopulatedEngine();

    const hash1 = computeStateHash(engine1);
    const hash2 = computeStateHash(engine2);

    assert.equal(typeof hash1, 'string');
    assert.equal(hash1.length, 64);
    assert.equal(hash1, hash2);
  });

  it('guarantees identical hash regardless of internal insertion chronology or batch sizes', () => {
    // Engine A: populated sequentially
    const engineA = createPopulatedEngine();

    // Engine B: replay identical commands
    const engineB = new MatchingEngine({
      instruments: [
        { symbol: 'ETH-USDT', tick_size: 1, lot_size: 1 }, // different registration order
        { symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 },
      ],
    });

    for (let seq = 1; seq <= 5; seq++) {
      const o = engineA.orders.get(seq);
      engineB.processCommand({
        type: 'LIMIT',
        order_id: o.order_id,
        participant_id: o.participant_id,
        symbol: o.symbol,
        side: o.side,
        price: o.price,
        quantity: o.original_qty,
        seq: o.seq,
        ts: o.ts,
      });
    }

    assert.equal(computeStateHash(engineB), computeStateHash(engineA));
  });

  it('changes hash when any resting order price is modified', () => {
    const engine = createPopulatedEngine();
    const baselineHash = computeStateHash(engine);

    // Tamper with price of order 1 in book
    const order = engine.orders.get(1);
    order.price = 101;

    const tamperedHash = computeStateHash(engine);
    assert.notEqual(tamperedHash, baselineHash);
  });

  it('changes hash when any resting order remaining quantity is modified', () => {
    const engine = createPopulatedEngine();
    const baselineHash = computeStateHash(engine);

    const order = engine.orders.get(1);
    order.remaining_qty = 9;

    const tamperedHash = computeStateHash(engine);
    assert.notEqual(tamperedHash, baselineHash);
  });

  it('changes hash when participant_id is modified', () => {
    const engine = createPopulatedEngine();
    const baselineHash = computeStateHash(engine);

    const order = engine.orders.get(1);
    order.participant_id = 999;

    const tamperedHash = computeStateHash(engine);
    assert.notEqual(tamperedHash, baselineHash);
  });

  it('changes hash when order state is modified', () => {
    const engine = createPopulatedEngine();
    const baselineHash = computeStateHash(engine);

    const order = engine.orders.get(1);
    order.state = 'PARTIALLY_FILLED';

    const tamperedHash = computeStateHash(engine);
    assert.notEqual(tamperedHash, baselineHash);
  });

  it('changes hash when trade counter is incremented', () => {
    const engine = createPopulatedEngine();
    const baselineHash = computeStateHash(engine);

    engine.trade_id_seq += 1;

    const tamperedHash = computeStateHash(engine);
    assert.notEqual(tamperedHash, baselineHash);
  });

  it('recursively sorts keys in canonicalJsonStringify', () => {
    const obj1 = { z: 1, a: { y: 2, b: 3 }, m: [4, { d: 5, c: 6 }] };
    const obj2 = { a: { b: 3, y: 2 }, m: [4, { c: 6, d: 5 }], z: 1 };

    assert.equal(canonicalJsonStringify(obj1), canonicalJsonStringify(obj2));
    assert.equal(canonicalJsonStringify(null), 'null');
    assert.equal(canonicalJsonStringify('text'), '"text"');
    assert.equal(canonicalJsonStringify(42), '42');
  });

  it('projects canonical state structure with books, orders, and trade_counter', () => {
    const engine = createPopulatedEngine();
    const state = projectCanonicalState(engine);

    assert.ok(Array.isArray(state.books));
    assert.ok(Array.isArray(state.orders));
    assert.equal(typeof state.trade_counter, 'number');
    assert.equal(state.books.length, 2);
    assert.equal(state.books[0].symbol, 'BTC-USDT');
    assert.equal(state.books[1].symbol, 'ETH-USDT');
  });
});
