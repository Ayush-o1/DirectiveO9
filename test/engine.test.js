import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MatchingEngine } from '../src/engine/engine.js';

describe('MatchingEngine Direct Unit Tests', () => {
  it('validates registerInstrument input parameters', () => {
    const engine = new MatchingEngine();

    assert.throws(
      () => engine.registerInstrument({ symbol: '' }),
      /Symbol must be a non-empty string/
    );
    assert.throws(
      () => engine.registerInstrument({ symbol: 'BTC-USDT', tick_size: 0 }),
      /tick_size must be a positive safe integer/
    );
    assert.throws(
      () => engine.registerInstrument({ symbol: 'BTC-USDT', lot_size: -1 }),
      /lot_size must be a positive safe integer/
    );
  });

  it('handles getDepth on unregistered symbol and getOrder queries', () => {
    const engine = new MatchingEngine({
      instruments: [{ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 }],
    });

    assert.equal(engine.getDepth('UNKNOWN-SYM'), null);
    assert.equal(engine.getOrder(999), null);

    engine.processCommand({
      type: 'LIMIT',
      order_id: 1,
      participant_id: 10,
      symbol: 'BTC-USDT',
      side: 'BUY',
      price: 100,
      quantity: 5,
      seq: 1,
      ts: 1000,
    });

    const order = engine.getOrder(1);
    assert.equal(order.order_id, 1);
    assert.equal(order.remaining_qty, 5);
    assert.equal(order.state, 'NEW');
  });

  it('rejects unsupported command types', () => {
    const engine = new MatchingEngine({
      instruments: [{ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 }],
    });

    assert.throws(
      () =>
        engine.processCommand({
          type: 'UNSUPPORTED_TYPE',
          order_id: 1,
          participant_id: 10,
          symbol: 'BTC-USDT',
          side: 'BUY',
          price: 100,
          quantity: 5,
          seq: 1,
          ts: 1000,
        }),
      /Unsupported command type/
    );
  });

  it('rejects duplicate order_id submission', () => {
    const engine = new MatchingEngine({
      instruments: [{ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 }],
    });

    engine.processCommand({
      type: 'LIMIT',
      order_id: 1,
      participant_id: 10,
      symbol: 'BTC-USDT',
      side: 'BUY',
      price: 100,
      quantity: 5,
      seq: 1,
      ts: 1000,
    });

    const events = engine.processCommand({
      type: 'LIMIT',
      order_id: 1,
      participant_id: 10,
      symbol: 'BTC-USDT',
      side: 'BUY',
      price: 100,
      quantity: 5,
      seq: 2,
      ts: 1001,
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'ORDER_REJECTED');
    assert.equal(events[0].code, 'DUPLICATE_ORDER');
  });

  it('detects invariant violation when order quantity conservation is breached', () => {
    const engine = new MatchingEngine({
      instruments: [{ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 }],
    });

    engine.processCommand({
      type: 'LIMIT',
      order_id: 1,
      participant_id: 10,
      symbol: 'BTC-USDT',
      side: 'BUY',
      price: 100,
      quantity: 5,
      seq: 1,
      ts: 1000,
    });

    // Tamper with order to breach conservation
    const order = engine.orders.get(1);
    order.remaining_qty = 999;

    assert.throws(() => engine.checkInvariants(), /quantity conservation failed/);
  });

  it('handles unexpected book.cancelOrder failure defensively', () => {
    const engine = new MatchingEngine({
      instruments: [{ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 }],
    });

    engine.processCommand({
      type: 'LIMIT',
      order_id: 1,
      participant_id: 10,
      symbol: 'BTC-USDT',
      side: 'BUY',
      price: 100,
      quantity: 5,
      seq: 1,
      ts: 1000,
    });

    // Remove from underlying book directly to test defensive branch
    const book = engine.books.get('BTC-USDT');
    book.orders.delete(1);

    const events = engine.processCommand({
      type: 'CANCEL',
      order_id: 1,
      participant_id: 10,
      symbol: 'BTC-USDT',
      seq: 2,
      ts: 1001,
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'ORDER_REJECTED');
    assert.equal(events[0].code, 'UNKNOWN_ORDER');
  });

  it('rejects cancel with UNKNOWN_ORDER if order exists on different symbol', () => {
    const engine = new MatchingEngine({
      instruments: [
        { symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 },
        { symbol: 'ETH-USDT', tick_size: 1, lot_size: 1 },
      ],
    });

    engine.processCommand({
      type: 'LIMIT',
      order_id: 1,
      participant_id: 10,
      symbol: 'BTC-USDT',
      side: 'BUY',
      price: 100,
      quantity: 5,
      seq: 1,
      ts: 1000,
    });

    const events = engine.processCommand({
      type: 'CANCEL',
      order_id: 1,
      participant_id: 10,
      symbol: 'ETH-USDT',
      seq: 2,
      ts: 1001,
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'ORDER_REJECTED');
    assert.equal(events[0].code, 'UNKNOWN_ORDER');
  });
});
