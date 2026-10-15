/**
 * Mulberry32 32-bit deterministic PRNG.
 * Ensures identical seeds produce bit-identical pseudo-random sequences.
 */
export function createRng(seed = 42) {
  let s = seed >>> 0 || 1;
  return function next() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates a realistic, seeded command workload around a moving midpoint.
 *
 * Command mix defaults:
 * - LIMIT (maker):  45% (adds resting depth at spread offsets)
 * - LIMIT (taker):  25% (crosses opposite book at or beyond top of book)
 * - MARKET:         10% (sweeps available top of book liquidity)
 * - IOC:            10% (immediate-or-cancel crossing liquidity)
 * - CANCEL:         10% (targets actively resting orders)
 *
 * @param {object} options
 * @param {number} [options.seed=42] - PRNG seed for deterministic replay.
 * @param {number} [options.count=10000] - Total commands to generate.
 * @param {string} [options.symbol='BTC-USDT'] - Trading instrument symbol.
 * @param {number} [options.tick_size=1] - Price tick size.
 * @param {number} [options.lot_size=1] - Quantity lot size.
 * @param {number} [options.initial_mid=10000] - Starting mid price.
 * @param {number} [options.book_depth=20] - Target active price levels on either side.
 * @param {number} [options.participant_count=4] - Number of participating market actors.
 * @param {object} [options.mix] - Relative mix weights.
 * @returns {Array<object>} Deterministic command list.
 */
export function generateWorkload({
  seed = 42,
  count = 10000,
  symbol = 'BTC-USDT',
  tick_size = 1,
  lot_size = 1,
  initial_mid = 10000,
  book_depth = 20,
  participant_count = 4,
  mix = {
    limit_maker: 0.45,
    limit_taker: 0.25,
    market: 0.1,
    ioc: 0.1,
    cancel: 0.1,
  },
} = {}) {
  const rng = createRng(seed);
  const commands = [];

  let currentMid = initial_mid;
  const activeRestingOrders = []; // { order_id, participant_id, side, price }
  let nextOrderId = 1;

  // Normalized cumulative probabilities
  const totalWeight = mix.limit_maker + mix.limit_taker + mix.market + mix.ioc + mix.cancel;
  const pMaker = mix.limit_maker / totalWeight;
  const pTaker = pMaker + mix.limit_taker / totalWeight;
  const pMarket = pTaker + mix.market / totalWeight;
  const pIoc = pMarket + mix.ioc / totalWeight;

  for (let i = 0; i < count; i++) {
    const cmdIndex = i + 1;
    const participantId = 1 + Math.floor(rng() * participant_count);
    const clientOrderId = `cli-${seed}-${cmdIndex}`;

    // Moving midpoint random walk with mean reversion toward initial_mid
    const drift = (initial_mid - currentMid) * 0.01;
    const step = (rng() - 0.5) * 4 * tick_size + drift;
    currentMid = Math.max(100 * tick_size, Math.round((currentMid + step) / tick_size) * tick_size);

    const roll = rng();

    // CANCEL command (if resting orders exist)
    if (roll > pIoc && activeRestingOrders.length > 0) {
      const targetIdx = Math.floor(rng() * activeRestingOrders.length);
      const target = activeRestingOrders.splice(targetIdx, 1)[0];

      commands.push({
        type: 'CANCEL',
        order_id: target.order_id,
        participant_id: target.participant_id,
        symbol,
        client_order_id: clientOrderId,
      });
      continue;
    }

    const side = rng() < 0.5 ? 'BUY' : 'SELL';
    const quantity = (1 + Math.floor(rng() * 10)) * lot_size;

    // MARKET command
    if (roll > pTaker && roll <= pMarket) {
      const orderId = nextOrderId++;
      commands.push({
        type: 'MARKET',
        order_id: orderId,
        participant_id: participantId,
        symbol,
        side,
        quantity,
        client_order_id: clientOrderId,
      });
      continue;
    }

    // IOC command
    if (roll > pMarket && roll <= pIoc) {
      const orderId = nextOrderId++;
      // Price close to current mid for IOC matching
      const priceOffset = Math.floor(rng() * 3) * tick_size;
      const price = side === 'BUY' ? currentMid + priceOffset : currentMid - priceOffset;

      commands.push({
        type: 'IOC',
        order_id: orderId,
        participant_id: participantId,
        symbol,
        side,
        price: Math.max(tick_size, price),
        quantity,
        client_order_id: clientOrderId,
      });
      continue;
    }

    // TAKER LIMIT (crossing order)
    if (roll > pMaker && roll <= pTaker) {
      const orderId = nextOrderId++;
      const priceOffset = Math.floor(rng() * 5) * tick_size;
      const price = side === 'BUY' ? currentMid + priceOffset : currentMid - priceOffset;

      commands.push({
        type: 'LIMIT',
        order_id: orderId,
        participant_id: participantId,
        symbol,
        side,
        price: Math.max(tick_size, price),
        quantity,
        client_order_id: clientOrderId,
      });
      continue;
    }

    // MAKER LIMIT (passive order resting on book)
    const orderId = nextOrderId++;
    // Price placed deeper into book based on target depth
    const depthOffset = (1 + Math.floor(rng() * book_depth)) * tick_size;
    const price = side === 'BUY' ? currentMid - depthOffset : currentMid + depthOffset;
    const safePrice = Math.max(tick_size, price);

    const order = {
      order_id: orderId,
      participant_id: participantId,
      side,
      price: safePrice,
    };
    activeRestingOrders.push(order);

    commands.push({
      type: 'LIMIT',
      order_id: orderId,
      participant_id: participantId,
      symbol,
      side,
      price: safePrice,
      quantity,
      client_order_id: clientOrderId,
    });
  }

  return commands;
}
