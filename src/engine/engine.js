import { OrderBook } from './book.js';

export class MatchingEngine {
  constructor({ instruments = [], indexType = process.env.INDEX_TYPE || 'array' } = {}) {
    this.indexType = indexType;
    this.instruments = new Map(); // symbol -> { symbol, tick_size, lot_size }
    this.books = new Map(); // symbol -> OrderBook
    this.orders = new Map(); // order_id -> orderRecord
    this.trade_id_seq = 0;

    for (const inst of instruments) {
      this.registerInstrument(inst);
    }
  }

  registerInstrument({ symbol, tick_size = 1, lot_size = 1 }) {
    if (!symbol || typeof symbol !== 'string') {
      throw new Error('Symbol must be a non-empty string');
    }
    if (!Number.isSafeInteger(tick_size) || tick_size <= 0) {
      throw new Error('tick_size must be a positive safe integer');
    }
    if (!Number.isSafeInteger(lot_size) || lot_size <= 0) {
      throw new Error('lot_size must be a positive safe integer');
    }

    this.instruments.set(symbol, { symbol, tick_size, lot_size });
    if (!this.books.has(symbol)) {
      this.books.set(
        symbol,
        new OrderBook({ symbol, tick_size, lot_size, indexType: this.indexType })
      );
    }
  }

  getDepth(symbol, depth = 50) {
    const book = this.books.get(symbol);
    if (!book) return null;
    return book.getDepth(depth);
  }

  getOrder(order_id) {
    return this.orders.get(order_id) || null;
  }

  checkInvariants() {
    for (const book of this.books.values()) {
      book.checkInvariants();
    }

    // Invariant 4: For every order, filled_qty + remaining_qty == original_qty
    for (const order of this.orders.values()) {
      if (
        order.remaining_qty < 0 ||
        order.filled_qty < 0 ||
        order.filled_qty + order.remaining_qty !== order.original_qty
      ) {
        throw new Error(
          `Invariant violation: order ${order.order_id} quantity conservation failed`
        );
      }
    }

    return true;
  }

  processCommand(command) {
    // Pure function requirement: engine must never mutate input command
    const { type, order_id, participant_id, symbol, side, price, quantity, seq, ts } = command;

    const events = [];

    // Validation 1: Symbol check
    const inst = this.instruments.get(symbol);
    if (!inst) {
      events.push({
        event: 'ORDER_REJECTED',
        code: 'UNKNOWN_INSTRUMENT',
        order_id: order_id ?? null,
        participant_id: participant_id ?? null,
        seq,
        ts,
      });
      return events;
    }

    const book = this.books.get(symbol);

    // CANCEL command branch
    if (type === 'CANCEL') {
      const existing = this.orders.get(order_id);
      if (!existing) {
        events.push({
          event: 'ORDER_REJECTED',
          code: 'UNKNOWN_ORDER',
          order_id,
          participant_id,
          seq,
          ts,
        });
        return events;
      }

      if (existing.symbol !== symbol) {
        events.push({
          event: 'ORDER_REJECTED',
          code: 'UNKNOWN_ORDER',
          order_id,
          participant_id,
          seq,
          ts,
        });
        return events;
      }

      if (existing.participant_id !== participant_id) {
        events.push({
          event: 'ORDER_REJECTED',
          code: 'NOT_OWNER',
          order_id,
          participant_id,
          seq,
          ts,
        });
        return events;
      }

      if (
        existing.state === 'FILLED' ||
        existing.state === 'CANCELLED' ||
        existing.state === 'REJECTED'
      ) {
        events.push({
          event: 'ORDER_REJECTED',
          code: 'ALREADY_TERMINAL',
          order_id,
          participant_id,
          seq,
          ts,
        });
        return events;
      }

      const res = book.cancelOrder(order_id, participant_id);
      if (!res.success) {
        events.push({
          event: 'ORDER_REJECTED',
          code: res.code,
          order_id,
          participant_id,
          seq,
          ts,
        });
        return events;
      }

      existing.state = 'CANCELLED';

      events.push({
        event: 'ORDER_CANCELLED',
        order_id: existing.order_id,
        participant_id: existing.participant_id,
        symbol: existing.symbol,
        side: existing.side,
        price: existing.price,
        original_qty: existing.original_qty,
        remaining_qty: existing.remaining_qty,
        reason: 'CLIENT_CANCEL',
        seq,
        ts,
      });

      return events;
    }

    // Validation for placement commands (LIMIT, MARKET, IOC)
    if (type !== 'LIMIT' && type !== 'MARKET' && type !== 'IOC') {
      throw new Error(`Unsupported command type: ${type}`);
    }

    if (side !== 'BUY' && side !== 'SELL') {
      events.push({
        event: 'ORDER_REJECTED',
        code: 'INVALID_SIDE',
        order_id,
        participant_id,
        seq,
        ts,
      });
      return events;
    }

    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      events.push({
        event: 'ORDER_REJECTED',
        code: 'NON_POSITIVE_QUANTITY',
        order_id,
        participant_id,
        seq,
        ts,
      });
      return events;
    }

    if (quantity % inst.lot_size !== 0) {
      events.push({
        event: 'ORDER_REJECTED',
        code: 'INVALID_LOT',
        order_id,
        participant_id,
        seq,
        ts,
      });
      return events;
    }

    if (type === 'LIMIT' || type === 'IOC') {
      if (!Number.isSafeInteger(price) || price <= 0 || price % inst.tick_size !== 0) {
        events.push({
          event: 'ORDER_REJECTED',
          code: 'INVALID_TICK',
          order_id,
          participant_id,
          seq,
          ts,
        });
        return events;
      }
    }

    if (this.orders.has(order_id)) {
      events.push({
        event: 'ORDER_REJECTED',
        code: 'DUPLICATE_ORDER',
        order_id,
        participant_id,
        seq,
        ts,
      });
      return events;
    }

    // Matching loop
    let remaining_qty = quantity;
    const isBuy = side === 'BUY';

    while (remaining_qty > 0) {
      // Check opposite book
      const oppositePrices = isBuy ? book.asks : book.bids;
      if (oppositePrices.length === 0) {
        break;
      }

      const bestOppositePrice = oppositePrices[0];

      // Price limit check
      if (type === 'LIMIT' || type === 'IOC') {
        if (isBuy && bestOppositePrice > price) {
          break;
        }
        if (!isBuy && bestOppositePrice < price) {
          break;
        }
      }

      const level = book.levels.get(bestOppositePrice);

      while (level && level.head !== null && remaining_qty > 0) {
        const makerNode = level.head;
        const matchQty = Math.min(remaining_qty, makerNode.remaining_qty);
        const tradePrice = makerNode.price; // Trade price is resting order's price
        this.trade_id_seq += 1;

        remaining_qty -= matchQty;
        makerNode.remaining_qty -= matchQty;
        level.total_volume -= matchQty;

        const makerRecord = this.orders.get(makerNode.order_id);
        makerRecord.remaining_qty = makerNode.remaining_qty;
        makerRecord.filled_qty = (makerRecord.filled_qty ?? 0) + matchQty;

        events.push({
          event: 'TRADE_EXECUTED',
          trade_id: this.trade_id_seq,
          symbol,
          price: tradePrice,
          quantity: matchQty,
          maker_order_id: makerNode.order_id,
          taker_order_id: order_id,
          maker_participant_id: makerNode.participant_id,
          taker_participant_id: participant_id,
          taker_side: side,
          seq,
          ts,
        });

        if (makerNode.remaining_qty === 0) {
          makerRecord.state = 'FILLED';
          book.cancelOrder(makerNode.order_id, makerNode.participant_id);

          events.push({
            event: 'ORDER_FILLED',
            order_id: makerNode.order_id,
            participant_id: makerNode.participant_id,
            symbol,
            side: makerRecord.side,
            price: makerNode.price,
            filled_qty: makerRecord.original_qty,
            seq,
            ts,
          });
        } else {
          makerRecord.state = 'PARTIALLY_FILLED';
        }
      }
    }

    // Post-matching handling for taker order
    const filledQty = quantity - remaining_qty;

    if (remaining_qty === 0) {
      // Fully filled
      this.orders.set(order_id, {
        order_id,
        participant_id,
        symbol,
        side,
        price: price ?? null,
        original_qty: quantity,
        filled_qty: quantity,
        remaining_qty: 0,
        state: 'FILLED',
        seq,
        ts,
      });

      events.push({
        event: 'ORDER_FILLED',
        order_id,
        participant_id,
        symbol,
        side,
        price: price ?? null,
        filled_qty: quantity,
        seq,
        ts,
      });
    } else {
      // Unfilled remainder
      if (type === 'LIMIT') {
        const restingState = filledQty > 0 ? 'PARTIALLY_FILLED' : 'NEW';

        this.orders.set(order_id, {
          order_id,
          participant_id,
          symbol,
          side,
          price,
          original_qty: quantity,
          filled_qty: filledQty,
          remaining_qty,
          state: restingState,
          seq,
          ts,
        });

        book.addRestingOrder({
          order_id,
          participant_id,
          side,
          price,
          quantity: remaining_qty,
          seq,
          ts,
        });

        events.push({
          event: 'ORDER_ACCEPTED',
          order_id,
          participant_id,
          symbol,
          side,
          price,
          quantity,
          remaining_qty,
          seq,
          ts,
        });
      } else if (type === 'IOC') {
        this.orders.set(order_id, {
          order_id,
          participant_id,
          symbol,
          side,
          price,
          original_qty: quantity,
          filled_qty: filledQty,
          remaining_qty,
          state: 'CANCELLED',
          seq,
          ts,
        });

        events.push({
          event: 'ORDER_CANCELLED',
          order_id,
          participant_id,
          symbol,
          side,
          price,
          original_qty: quantity,
          remaining_qty,
          reason: 'IOC_UNFILLED',
          seq,
          ts,
        });
      } else if (type === 'MARKET') {
        this.orders.set(order_id, {
          order_id,
          participant_id,
          symbol,
          side,
          price: null,
          original_qty: quantity,
          filled_qty: filledQty,
          remaining_qty,
          state: 'CANCELLED',
          seq,
          ts,
        });

        events.push({
          event: 'ORDER_CANCELLED',
          order_id,
          participant_id,
          symbol,
          side,
          price: null,
          original_qty: quantity,
          remaining_qty,
          reason: 'MARKET_UNFILLED',
          seq,
          ts,
        });
      }
    }

    return events;
  }
}
