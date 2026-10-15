import { OrderNode, LevelQueue } from './queue.js';
import { SortedArrayPriceIndex } from './level.js';
import { AvlTreePriceIndex } from './avl.js';

export class OrderBook {
  constructor({ symbol, tick_size = 1, lot_size = 1, indexType = 'array' }) {
    if (!symbol || typeof symbol !== 'string') {
      throw new Error('Symbol must be a non-empty string');
    }
    if (!Number.isSafeInteger(tick_size) || tick_size <= 0) {
      throw new Error('tick_size must be a positive safe integer');
    }
    if (!Number.isSafeInteger(lot_size) || lot_size <= 0) {
      throw new Error('lot_size must be a positive safe integer');
    }

    this.symbol = symbol;
    this.tick_size = tick_size;
    this.lot_size = lot_size;
    this.indexType = indexType;

    if (indexType === 'avl' || indexType === 'tree') {
      this.bids = new AvlTreePriceIndex(true);
      this.asks = new AvlTreePriceIndex(false);
    } else {
      this.bids = new SortedArrayPriceIndex(true);
      this.asks = new SortedArrayPriceIndex(false);
    }

    this.levels = new Map(); // price -> LevelQueue
    this.orders = new Map(); // order_id -> { node, side }
  }

  isValidTick(price) {
    return Number.isSafeInteger(price) && price > 0 && price % this.tick_size === 0;
  }

  isValidLot(quantity) {
    return Number.isSafeInteger(quantity) && quantity > 0 && quantity % this.lot_size === 0;
  }

  addRestingOrder({ order_id, participant_id, side, price, quantity, seq, ts }) {
    if (side !== 'BUY' && side !== 'SELL') {
      throw new Error(`Invalid side: ${side}`);
    }
    if (!Number.isSafeInteger(order_id) || order_id <= 0) {
      throw new Error('order_id must be a positive safe integer');
    }
    if (!Number.isSafeInteger(participant_id) || participant_id <= 0) {
      throw new Error('participant_id must be a positive safe integer');
    }
    if (!this.isValidTick(price)) {
      throw new Error(`Invalid tick: price ${price} is not a multiple of ${this.tick_size}`);
    }
    if (!this.isValidLot(quantity)) {
      throw new Error(`Invalid lot: quantity ${quantity} is not a multiple of ${this.lot_size}`);
    }
    if (this.orders.has(order_id)) {
      throw new Error(`Duplicate order_id: ${order_id} already exists on book`);
    }

    const isBuy = side === 'BUY';
    const prices = isBuy ? this.bids : this.asks;

    let level = this.levels.get(price);
    if (!level) {
      level = new LevelQueue(price);
      this.levels.set(price, level);
      prices.insert(price);
    }

    const node = new OrderNode({
      order_id,
      participant_id,
      price,
      quantity,
      seq,
      ts,
    });

    level.append(node);
    this.orders.set(order_id, { node, side });

    return node;
  }

  cancelOrder(order_id, participant_id) {
    const entry = this.orders.get(order_id);
    if (!entry) {
      return { success: false, code: 'UNKNOWN_ORDER' };
    }

    if (entry.node.participant_id !== participant_id) {
      return { success: false, code: 'NOT_OWNER' };
    }

    const { node, side } = entry;
    const isBuy = side === 'BUY';
    const prices = isBuy ? this.bids : this.asks;
    const level = this.levels.get(node.price);

    level.remove(node);

    if (level.isEmpty()) {
      this.levels.delete(node.price);
      prices.remove(node.price);
    }

    this.orders.delete(order_id);

    return {
      success: true,
      order: {
        order_id: node.order_id,
        participant_id: node.participant_id,
        price: node.price,
        remaining_qty: node.remaining_qty,
        side,
      },
    };
  }

  getBestBid() {
    if (this.bids.length === 0) {
      return null;
    }
    const price = this.bids[0];
    const level = this.levels.get(price);
    return {
      price,
      total_volume: level.total_volume,
      order_count: level.order_count,
    };
  }

  getBestAsk() {
    if (this.asks.length === 0) {
      return null;
    }
    const price = this.asks[0];
    const level = this.levels.get(price);
    return {
      price,
      total_volume: level.total_volume,
      order_count: level.order_count,
    };
  }

  getDepth(depth = 50) {
    const safeDepth = Math.max(1, Math.min(depth, 500));

    const bidsDepth = [];
    const bidsPrices = this.bids.toArray(safeDepth);
    for (const price of bidsPrices) {
      const level = this.levels.get(price);
      if (level) {
        bidsDepth.push({
          price,
          quantity: level.total_volume,
          order_count: level.order_count,
        });
      }
    }

    const asksDepth = [];
    const asksPrices = this.asks.toArray(safeDepth);
    for (const price of asksPrices) {
      const level = this.levels.get(price);
      if (level) {
        asksDepth.push({
          price,
          quantity: level.total_volume,
          order_count: level.order_count,
        });
      }
    }

    return {
      symbol: this.symbol,
      bids: bidsDepth,
      asks: asksDepth,
    };
  }

  hasOrder(order_id) {
    return this.orders.has(order_id);
  }

  getOrder(order_id) {
    const entry = this.orders.get(order_id);
    if (!entry) return null;
    return {
      order_id: entry.node.order_id,
      participant_id: entry.node.participant_id,
      price: entry.node.price,
      quantity: entry.node.quantity,
      remaining_qty: entry.node.remaining_qty,
      side: entry.side,
      seq: entry.node.seq,
      ts: entry.node.ts,
    };
  }

  checkInvariants() {
    // Invariant 1: Book never crossed
    if (this.bids.length > 0 && this.asks.length > 0) {
      if (this.bids[0] >= this.asks[0]) {
        throw new Error(
          `Invariant violation: book crossed. Best bid ${this.bids[0]} >= best ask ${this.asks[0]}`
        );
      }
    }

    // Invariant: Bids strictly descending
    let prevBid = null;
    let bidIdx = 0;
    for (const bidPrice of this.bids) {
      if (prevBid !== null && bidPrice >= prevBid) {
        throw new Error(
          `Invariant violation: bids not strictly descending at index ${bidIdx}: ${prevBid} <= ${bidPrice}`
        );
      }
      prevBid = bidPrice;
      bidIdx++;
    }

    // Invariant: Asks strictly ascending
    let prevAsk = null;
    let askIdx = 0;
    for (const askPrice of this.asks) {
      if (prevAsk !== null && askPrice <= prevAsk) {
        throw new Error(
          `Invariant violation: asks not strictly ascending at index ${askIdx}: ${prevAsk} >= ${askPrice}`
        );
      }
      prevAsk = askPrice;
      askIdx++;
    }

    // Invariant 2 & 3: Order presence, single location, positive quantity
    let totalOrdersAcrossLevels = 0;

    for (const [price, level] of this.levels.entries()) {
      if (level.isEmpty()) {
        throw new Error(`Invariant violation: level ${price} is empty but retained in levels map`);
      }
      if (level.total_volume <= 0) {
        throw new Error(
          `Invariant violation: level ${price} has non-positive volume ${level.total_volume}`
        );
      }

      let scannedVolume = 0;
      let curr = level.head;
      let orderCountAtLevel = 0;

      while (curr !== null) {
        if (!this.orders.has(curr.order_id)) {
          throw new Error(
            `Invariant violation: order ${curr.order_id} in level ${price} missing from orders index`
          );
        }
        if (curr.remaining_qty <= 0) {
          throw new Error(
            `Invariant violation: order ${curr.order_id} has non-positive remaining_qty ${curr.remaining_qty}`
          );
        }
        if (curr.price !== price) {
          throw new Error(
            `Invariant violation: order ${curr.order_id} price ${curr.price} mismatch with level price ${price}`
          );
        }

        scannedVolume += curr.remaining_qty;
        orderCountAtLevel += 1;
        curr = curr.next;
      }

      if (scannedVolume !== level.total_volume) {
        throw new Error(
          `Invariant violation: level ${price} volume mismatch. Level reports ${level.total_volume}, scanned ${scannedVolume}`
        );
      }
      if (orderCountAtLevel !== level.order_count) {
        throw new Error(
          `Invariant violation: level ${price} order count mismatch. Level reports ${level.order_count}, scanned ${orderCountAtLevel}`
        );
      }

      totalOrdersAcrossLevels += orderCountAtLevel;
    }

    if (totalOrdersAcrossLevels !== this.orders.size) {
      throw new Error(
        `Invariant violation: order count mismatch. Levels contain ${totalOrdersAcrossLevels}, orders map contains ${this.orders.size}`
      );
    }

    return true;
  }
}
