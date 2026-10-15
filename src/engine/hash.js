import crypto from 'node:crypto';

/**
 * Deterministically projects the MatchingEngine state into a canonical serializable representation.
 *
 * The canonical representation extracts:
 * 1. Resting orders per instrument in strict price-time priority:
 *    - Sorted alphabetically by instrument symbol.
 *    - Bids: sorted by price descending; within each level, orders from FIFO queue (head -> tail).
 *    - Asks: sorted by price ascending; within each level, orders from FIFO queue (head -> tail).
 *    - Explicit integer fields per order: order_id, participant_id, price, remaining_qty, seq, ts.
 * 2. Order Registry:
 *    - All active orders in the engine, sorted strictly by order_id ascending.
 *    - Fields: order_id, participant_id, symbol, side, price, original_qty, remaining_qty, filled_qty, state, seq, ts.
 * 3. Trade Counter:
 *    - trade_id_seq (monotonic count of executed trades).
 */
export function projectCanonicalState(engine) {
  const instruments = Array.from(engine.instruments.keys()).sort();
  const bookStates = [];

  for (const symbol of instruments) {
    const book = engine.books.get(symbol);
    const bids = [];
    const asks = [];

    if (book) {
      // Traverse bids: prices already sorted descending
      for (const price of book.bids) {
        const queue = book.levels.get(price);
        if (queue) {
          let curr = queue.head;
          while (curr) {
            bids.push({
              order_id: curr.order_id,
              participant_id: curr.participant_id,
              price: curr.price,
              remaining_qty: curr.remaining_qty,
              seq: curr.seq,
              ts: curr.ts,
            });
            curr = curr.next;
          }
        }
      }

      // Traverse asks: prices already sorted ascending
      for (const price of book.asks) {
        const queue = book.levels.get(price);
        if (queue) {
          let curr = queue.head;
          while (curr) {
            asks.push({
              order_id: curr.order_id,
              participant_id: curr.participant_id,
              price: curr.price,
              remaining_qty: curr.remaining_qty,
              seq: curr.seq,
              ts: curr.ts,
            });
            curr = curr.next;
          }
        }
      }
    }

    bookStates.push({
      symbol,
      bids,
      asks,
    });
  }

  // 2. Order registry: sorted by order_id ascending
  const sortedOrderIds = Array.from(engine.orders.keys()).sort((a, b) => a - b);
  const orderRegistry = [];

  for (const orderId of sortedOrderIds) {
    const o = engine.orders.get(orderId);
    orderRegistry.push({
      order_id: o.order_id,
      participant_id: o.participant_id,
      symbol: o.symbol,
      side: o.side,
      price: o.price,
      original_qty: o.original_qty,
      remaining_qty: o.remaining_qty,
      filled_qty: o.filled_qty,
      state: o.state,
      seq: o.seq,
      ts: o.ts,
    });
  }

  // 3. Trade Counter
  const tradeCounter = engine.trade_id_seq || 0;

  return {
    books: bookStates,
    orders: orderRegistry,
    trade_counter: tradeCounter,
  };
}

/**
 * Recursively serializes objects and arrays with lexicographically sorted keys.
 */
export function canonicalJsonStringify(val) {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }

  if (Array.isArray(val)) {
    return '[' + val.map(item => canonicalJsonStringify(item)).join(',') + ']';
  }

  const sortedKeys = Object.keys(val).sort();
  const entries = sortedKeys.map(k => `${JSON.stringify(k)}:${canonicalJsonStringify(val[k])}`);
  return '{' + entries.join(',') + '}';
}

/**
 * Computes a SHA-256 hexadecimal hash from the canonical state representation.
 */
export function computeStateHash(engine) {
  const projected = projectCanonicalState(engine);
  const canonicalString = canonicalJsonStringify(projected);
  return crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}
