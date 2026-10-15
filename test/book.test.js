import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBook } from '../src/engine/book.js';

describe('OrderBook Core', () => {
  it('initializes with valid parameters', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 });
    assert.equal(book.symbol, 'BTC-USDT');
    assert.equal(book.tick_size, 1);
    assert.equal(book.lot_size, 1);
    assert.equal(book.getBestBid(), null);
    assert.equal(book.getBestAsk(), null);
    assert.deepEqual(book.getDepth(), { symbol: 'BTC-USDT', bids: [], asks: [] });
    assert.equal(book.checkInvariants(), true);
  });

  it('rejects invalid constructor parameters', () => {
    assert.throws(() => new OrderBook({ symbol: '' }), /Symbol must be a non-empty string/);
    assert.throws(
      () => new OrderBook({ symbol: 'BTC-USDT', tick_size: -1 }),
      /tick_size must be a positive safe integer/
    );
    assert.throws(
      () => new OrderBook({ symbol: 'BTC-USDT', lot_size: 0 }),
      /lot_size must be a positive safe integer/
    );
  });

  it('adds resting bids and asks and returns best bid/ask', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 });

    book.addRestingOrder({
      order_id: 1,
      participant_id: 10,
      side: 'BUY',
      price: 100,
      quantity: 10,
      seq: 1,
      ts: 1000,
    });
    book.addRestingOrder({
      order_id: 2,
      participant_id: 11,
      side: 'BUY',
      price: 105,
      quantity: 5,
      seq: 2,
      ts: 1001,
    });
    book.addRestingOrder({
      order_id: 3,
      participant_id: 12,
      side: 'SELL',
      price: 110,
      quantity: 8,
      seq: 3,
      ts: 1002,
    });

    assert.deepEqual(book.getBestBid(), { price: 105, total_volume: 5, order_count: 1 });
    assert.deepEqual(book.getBestAsk(), { price: 110, total_volume: 8, order_count: 1 });
    assert.equal(book.checkInvariants(), true);
  });

  it('validates tick size and lot size constraints on add', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT', tick_size: 5, lot_size: 10 });

    assert.throws(
      () =>
        book.addRestingOrder({
          order_id: 1,
          participant_id: 10,
          side: 'BUY',
          price: 103, // Not a multiple of 5
          quantity: 20,
          seq: 1,
          ts: 1000,
        }),
      /Invalid tick/
    );

    assert.throws(
      () =>
        book.addRestingOrder({
          order_id: 1,
          participant_id: 10,
          side: 'BUY',
          price: 105,
          quantity: 25, // Not a multiple of 10
          seq: 1,
          ts: 1000,
        }),
      /Invalid lot/
    );
  });

  it('rejects duplicate order_id', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT' });
    book.addRestingOrder({
      order_id: 1,
      participant_id: 10,
      side: 'BUY',
      price: 100,
      quantity: 10,
      seq: 1,
      ts: 1000,
    });

    assert.throws(
      () =>
        book.addRestingOrder({
          order_id: 1,
          participant_id: 11,
          side: 'SELL',
          price: 110,
          quantity: 5,
          seq: 2,
          ts: 1001,
        }),
      /Duplicate order_id/
    );
  });

  it('cancels resting orders and cleans up empty levels', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT' });
    book.addRestingOrder({
      order_id: 1,
      participant_id: 10,
      side: 'BUY',
      price: 100,
      quantity: 10,
      seq: 1,
      ts: 1000,
    });
    book.addRestingOrder({
      order_id: 2,
      participant_id: 10,
      side: 'BUY',
      price: 100,
      quantity: 5,
      seq: 2,
      ts: 1001,
    });

    // Cancel order 1 (head of level 100)
    const res1 = book.cancelOrder(1, 10);
    assert.equal(res1.success, true);
    assert.equal(res1.order.order_id, 1);
    assert.equal(book.getBestBid().total_volume, 5);
    assert.equal(book.getBestBid().order_count, 1);
    assert.equal(book.checkInvariants(), true);

    // Cancel order 2 (last remaining in level 100)
    const res2 = book.cancelOrder(2, 10);
    assert.equal(res2.success, true);
    assert.equal(book.getBestBid(), null);
    assert.equal(book.levels.has(100), false);
    assert.equal(book.bids.length, 0);
    assert.equal(book.checkInvariants(), true);
  });

  it('returns reject codes for cancel errors', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT' });
    book.addRestingOrder({
      order_id: 1,
      participant_id: 10,
      side: 'BUY',
      price: 100,
      quantity: 10,
      seq: 1,
      ts: 1000,
    });

    // Cancel unknown order
    const resUnknown = book.cancelOrder(999, 10);
    assert.equal(resUnknown.success, false);
    assert.equal(resUnknown.code, 'UNKNOWN_ORDER');

    // Cancel not owner
    const resNotOwner = book.cancelOrder(1, 99);
    assert.equal(resNotOwner.success, false);
    assert.equal(resNotOwner.code, 'NOT_OWNER');
  });

  it('produces truncated depth view up to requested limit', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT' });
    for (let p = 100; p <= 104; p++) {
      book.addRestingOrder({
        order_id: p,
        participant_id: 1,
        side: 'BUY',
        price: p,
        quantity: 1,
        seq: p,
        ts: p,
      });
    }

    const depthAll = book.getDepth(10);
    assert.equal(depthAll.bids.length, 5);
    assert.equal(depthAll.bids[0].price, 104);
    assert.equal(depthAll.bids[4].price, 100);

    const depthTruncated = book.getDepth(2);
    assert.equal(depthTruncated.bids.length, 2);
    assert.equal(depthTruncated.bids[0].price, 104);
    assert.equal(depthTruncated.bids[1].price, 103);
  });

  it('queries orders via hasOrder and getOrder', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT' });
    assert.equal(book.hasOrder(1), false);
    assert.equal(book.getOrder(1), null);

    book.addRestingOrder({
      order_id: 1,
      participant_id: 10,
      side: 'BUY',
      price: 100,
      quantity: 10,
      seq: 1,
      ts: 1000,
    });

    assert.equal(book.hasOrder(1), true);
    assert.deepEqual(book.getOrder(1), {
      order_id: 1,
      participant_id: 10,
      price: 100,
      quantity: 10,
      remaining_qty: 10,
      side: 'BUY',
      seq: 1,
      ts: 1000,
    });
  });

  it('rejects invalid order parameter shapes on add', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT' });

    assert.throws(
      () =>
        book.addRestingOrder({
          order_id: 1,
          participant_id: 10,
          side: 'HOLD',
          price: 100,
          quantity: 10,
          seq: 1,
          ts: 1000,
        }),
      /Invalid side/
    );

    assert.throws(
      () =>
        book.addRestingOrder({
          order_id: -1,
          participant_id: 10,
          side: 'BUY',
          price: 100,
          quantity: 10,
          seq: 1,
          ts: 1000,
        }),
      /order_id must be a positive safe integer/
    );

    assert.throws(
      () =>
        book.addRestingOrder({
          order_id: 1,
          participant_id: 0,
          side: 'BUY',
          price: 100,
          quantity: 10,
          seq: 1,
          ts: 1000,
        }),
      /participant_id must be a positive safe integer/
    );
  });

  it('detects invariant violation when bids are not strictly descending', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT' });
    book.bids = [100, 105];
    assert.throws(() => book.checkInvariants(), /bids not strictly descending/);
  });

  it('detects invariant violation when asks are not strictly ascending', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT' });
    book.asks = [110, 105];
    assert.throws(() => book.checkInvariants(), /asks not strictly ascending/);
  });

  it('detects invariant violation when empty level is retained', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT' });
    book.levels.set(100, {
      isEmpty: () => true,
      total_volume: 0,
      order_count: 0,
    });
    assert.throws(() => book.checkInvariants(), /is empty but retained in levels map/);
  });

  it('detects invariant violation when level has non-positive volume', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT' });
    book.levels.set(100, {
      isEmpty: () => false,
      total_volume: -5,
      order_count: 1,
    });
    assert.throws(() => book.checkInvariants(), /has non-positive volume/);
  });

  it('detects invariant violation when level order is missing from orders index', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT' });
    book.levels.set(100, {
      isEmpty: () => false,
      total_volume: 10,
      order_count: 1,
      head: { order_id: 99, remaining_qty: 10, price: 100, next: null },
    });
    assert.throws(() => book.checkInvariants(), /missing from orders index/);
  });

  it('detects invariant violation when order has non-positive remaining_qty', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT' });
    book.orders.set(1, { node: null, side: 'BUY' });
    book.levels.set(100, {
      isEmpty: () => false,
      total_volume: 10,
      order_count: 1,
      head: { order_id: 1, remaining_qty: 0, price: 100, next: null },
    });
    assert.throws(() => book.checkInvariants(), /has non-positive remaining_qty/);
  });

  it('detects invariant violation when order price mismatches level price', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT' });
    book.orders.set(1, { node: null, side: 'BUY' });
    book.levels.set(100, {
      isEmpty: () => false,
      total_volume: 10,
      order_count: 1,
      head: { order_id: 1, remaining_qty: 10, price: 95, next: null },
    });
    assert.throws(() => book.checkInvariants(), /mismatch with level price/);
  });

  it('detects invariant violation on level volume or order count mismatch', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT' });
    book.orders.set(1, { node: null, side: 'BUY' });
    book.levels.set(100, {
      isEmpty: () => false,
      total_volume: 15, // Scanned will be 10
      order_count: 1,
      head: { order_id: 1, remaining_qty: 10, price: 100, next: null },
    });
    assert.throws(() => book.checkInvariants(), /volume mismatch/);

    book.levels.set(100, {
      isEmpty: () => false,
      total_volume: 10,
      order_count: 2, // Scanned will be 1
      head: { order_id: 1, remaining_qty: 10, price: 100, next: null },
    });
    assert.throws(() => book.checkInvariants(), /order count mismatch/);
  });

  it('detects invariant violation when book is crossed', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT' });
    book.bids = [105];
    book.asks = [100];
    assert.throws(() => book.checkInvariants(), /Invariant violation: book crossed/);
  });

  it('detects invariant violation when total orders across levels mismatches orders index', () => {
    const book = new OrderBook({ symbol: 'BTC-USDT' });
    book.orders.set(1, { node: null, side: 'BUY' });
    book.orders.set(2, { node: null, side: 'BUY' }); // Extra order in map
    book.levels.set(100, {
      isEmpty: () => false,
      total_volume: 10,
      order_count: 1,
      head: { order_id: 1, remaining_qty: 10, price: 100, next: null },
    });
    assert.throws(() => book.checkInvariants(), /Levels contain 1, orders map contains 2/);
  });
});
