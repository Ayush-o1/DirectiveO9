// Reference matching engine oracle implemented with plain arrays and linear scans
// Designed strictly according to docs/spec.md without sharing code with src/engine

export class NaiveEngine {
  constructor({ instruments = [] } = {}) {
    this.instruments = new Map();
    this.restingOrders = []; // Flat array of active resting orders
    this.historicalOrders = new Map(); // order_id -> orderRecord
    this.trade_id_seq = 0;

    for (const inst of instruments) {
      this.registerInstrument(inst);
    }
  }

  registerInstrument({ symbol, tick_size = 1, lot_size = 1 }) {
    this.instruments.set(symbol, { symbol, tick_size, lot_size });
  }

  getDepth(symbol, depth = 50) {
    const symbolOrders = this.restingOrders.filter(o => o.symbol === symbol);

    const bidMap = new Map();
    const askMap = new Map();

    for (const o of symbolOrders) {
      const targetMap = o.side === 'BUY' ? bidMap : askMap;
      const existing = targetMap.get(o.price) || {
        price: o.price,
        quantity: 0,
        order_count: 0,
      };
      existing.quantity += o.remaining_qty;
      existing.order_count += 1;
      targetMap.set(o.price, existing);
    }

    const bids = Array.from(bidMap.values())
      .sort((a, b) => b.price - a.price)
      .slice(0, depth);

    const asks = Array.from(askMap.values())
      .sort((a, b) => a.price - b.price)
      .slice(0, depth);

    return {
      symbol,
      bids,
      asks,
    };
  }

  getOrder(order_id) {
    return this.historicalOrders.get(order_id) || null;
  }

  processCommand(command) {
    const {
      type,
      order_id,
      participant_id,
      symbol,
      side,
      price,
      quantity,
      seq,
      ts,
    } = command;

    const events = [];

    // Instrument check
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

    // CANCEL handling
    if (type === 'CANCEL') {
      const existing = this.historicalOrders.get(order_id);
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

      const restingIdx = this.restingOrders.findIndex(o => o.order_id === order_id);
      if (restingIdx === -1) {
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

      this.restingOrders.splice(restingIdx, 1);
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

    // Input validation
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

    if (this.historicalOrders.has(order_id)) {
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

    let remaining_qty = quantity;
    const isBuy = side === 'BUY';

    while (remaining_qty > 0) {
      // Find candidate resting orders on the opposite side
      const eligible = this.restingOrders.filter(o => {
        if (o.symbol !== symbol) return false;
        if (isBuy) {
          if (o.side !== 'SELL') return false;
          if (type === 'LIMIT' || type === 'IOC') {
            return o.price <= price;
          }
          return true; // MARKET
        } else {
          if (o.side !== 'BUY') return false;
          if (type === 'LIMIT' || type === 'IOC') {
            return o.price >= price;
          }
          return true; // MARKET
        }
      });

      if (eligible.length === 0) {
        break;
      }

      // Sort candidate orders by price-time priority
      eligible.sort((a, b) => {
        if (isBuy) {
          // Lowest price first
          if (a.price !== b.price) return a.price - b.price;
        } else {
          // Highest price first
          if (a.price !== b.price) return b.price - a.price;
        }
        // FIFO: earliest sequence number first
        return a.seq - b.seq;
      });

      const bestMaker = eligible[0];
      const matchQty = Math.min(remaining_qty, bestMaker.remaining_qty);
      const tradePrice = bestMaker.price;
      this.trade_id_seq += 1;

      remaining_qty -= matchQty;
      bestMaker.remaining_qty -= matchQty;

      const makerHist = this.historicalOrders.get(bestMaker.order_id);
      makerHist.remaining_qty = bestMaker.remaining_qty;

      events.push({
        event: 'TRADE_EXECUTED',
        trade_id: this.trade_id_seq,
        symbol,
        price: tradePrice,
        quantity: matchQty,
        maker_order_id: bestMaker.order_id,
        taker_order_id: order_id,
        maker_participant_id: bestMaker.participant_id,
        taker_participant_id: participant_id,
        taker_side: side,
        seq,
        ts,
      });

      if (bestMaker.remaining_qty === 0) {
        makerHist.state = 'FILLED';
        const idx = this.restingOrders.findIndex(o => o.order_id === bestMaker.order_id);
        if (idx !== -1) {
          this.restingOrders.splice(idx, 1);
        }

        events.push({
          event: 'ORDER_FILLED',
          order_id: bestMaker.order_id,
          participant_id: bestMaker.participant_id,
          symbol,
          side: makerHist.side,
          price: bestMaker.price,
          filled_qty: makerHist.original_qty,
          seq,
          ts,
        });
      } else {
        makerHist.state = 'PARTIALLY_FILLED';
      }
    }

    const filledQty = quantity - remaining_qty;

    if (remaining_qty === 0) {
      this.historicalOrders.set(order_id, {
        order_id,
        participant_id,
        symbol,
        side,
        price: price ?? null,
        original_qty: quantity,
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
      if (type === 'LIMIT') {
        const restingState = filledQty > 0 ? 'PARTIALLY_FILLED' : 'NEW';

        this.historicalOrders.set(order_id, {
          order_id,
          participant_id,
          symbol,
          side,
          price,
          original_qty: quantity,
          remaining_qty,
          state: restingState,
          seq,
          ts,
        });

        this.restingOrders.push({
          order_id,
          participant_id,
          symbol,
          side,
          price,
          remaining_qty,
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
        this.historicalOrders.set(order_id, {
          order_id,
          participant_id,
          symbol,
          side,
          price,
          original_qty: quantity,
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
        this.historicalOrders.set(order_id, {
          order_id,
          participant_id,
          symbol,
          side,
          price: null,
          original_qty: quantity,
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
