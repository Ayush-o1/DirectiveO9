import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { MatchingEngine } from '../src/engine/engine.js';
import { NaiveEngine } from './oracle/naive-engine.js';

describe('Differential Testing (MatchingEngine vs NaiveEngine Oracle)', () => {
  const instruments = [
    { symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 },
    { symbol: 'ETH-USDT', tick_size: 5, lot_size: 10 },
  ];

  const isLongRun = process.env.LONG_DIFF === 'true';
  const numRuns = isLongRun ? 2000 : 100;
  const minCmds = isLongRun ? 30 : 25;
  const maxCmds = isLongRun ? 200 : 45;

  // Arbitrary command generator with moving mid-price ensuring frequent crossings, sweeps, and rejects
  const commandSequenceArb = fc.gen().map(g => {
    const length = g(fc.integer, { min: minCmds, max: maxCmds });
    const commands = [];
    let seq = 1;
    let ts = 1000;
    let orderIdSeq = 1;
    let midBTC = 100;
    let midETH = 200;

    const placedOrders = [];
    const cancelledOrderIds = [];

    for (let i = 0; i < length; i++) {
      // Dynamic moving mid-price
      if (g(fc.integer, { min: 1, max: 10 }) <= 2) {
        midBTC = Math.max(95, Math.min(105, midBTC + g(fc.constantFrom, -1, 1)));
        midETH = Math.max(190, Math.min(210, midETH + g(fc.constantFrom, -5, 5)));
      }

      const roll = g(fc.integer, { min: 1, max: 100 });

      if (roll <= 45) {
        // LIMIT order crossing or resting tightly around mid
        const symbol = g(fc.integer, { min: 1, max: 10 }) <= 7 ? 'BTC-USDT' : 'ETH-USDT';
        const side = g(fc.constantFrom, 'BUY', 'SELL');
        const order_id = orderIdSeq++;
        const participant_id = g(fc.integer, { min: 1, max: 5 });

        let price;
        let quantity;
        if (symbol === 'BTC-USDT') {
          const offset =
            side === 'BUY'
              ? g(fc.integer, { min: -2, max: 3 })
              : g(fc.integer, { min: -3, max: 2 });
          price = midBTC + offset;
          quantity = g(fc.constantFrom, 2, 5, 10, 15, 25);
        } else {
          const offset =
            side === 'BUY'
              ? g(fc.constantFrom, -10, -5, 0, 5, 10, 15)
              : g(fc.constantFrom, -15, -10, -5, 0, 5, 10);
          price = midETH + offset;
          quantity = g(fc.constantFrom, 10, 20, 30, 50);
        }

        placedOrders.push({ order_id, participant_id, symbol, price, quantity, side });
        commands.push({
          type: 'LIMIT',
          order_id,
          participant_id,
          symbol,
          side,
          price,
          quantity,
          seq: seq++,
          ts: ts++,
        });
      } else if (roll <= 58) {
        // MARKET order
        const symbol = g(fc.integer, { min: 1, max: 10 }) <= 7 ? 'BTC-USDT' : 'ETH-USDT';
        const side = g(fc.constantFrom, 'BUY', 'SELL');
        const order_id = orderIdSeq++;
        const participant_id = g(fc.integer, { min: 1, max: 5 });
        const quantity =
          symbol === 'BTC-USDT' ? g(fc.constantFrom, 3, 8, 15, 30) : g(fc.constantFrom, 10, 20, 40);

        placedOrders.push({ order_id, participant_id, symbol, price: null, quantity, side });
        commands.push({
          type: 'MARKET',
          order_id,
          participant_id,
          symbol,
          side,
          quantity,
          seq: seq++,
          ts: ts++,
        });
      } else if (roll <= 70) {
        // IOC order
        const symbol = g(fc.integer, { min: 1, max: 10 }) <= 7 ? 'BTC-USDT' : 'ETH-USDT';
        const side = g(fc.constantFrom, 'BUY', 'SELL');
        const order_id = orderIdSeq++;
        const participant_id = g(fc.integer, { min: 1, max: 5 });
        let price;
        let quantity;
        if (symbol === 'BTC-USDT') {
          price =
            midBTC +
            (side === 'BUY'
              ? g(fc.integer, { min: -1, max: 2 })
              : g(fc.integer, { min: -2, max: 1 }));
          quantity = g(fc.constantFrom, 3, 10, 20);
        } else {
          price =
            midETH + (side === 'BUY' ? g(fc.constantFrom, -5, 0, 5) : g(fc.constantFrom, -5, 0, 5));
          quantity = g(fc.constantFrom, 10, 20, 30);
        }

        placedOrders.push({ order_id, participant_id, symbol, price, quantity, side });
        commands.push({
          type: 'IOC',
          order_id,
          participant_id,
          symbol,
          side,
          price,
          quantity,
          seq: seq++,
          ts: ts++,
        });
      } else if (roll <= 76) {
        // Successful CANCEL
        if (placedOrders.length > 0) {
          const target = g(fc.constantFrom, ...placedOrders);
          cancelledOrderIds.push(target.order_id);
          commands.push({
            type: 'CANCEL',
            order_id: target.order_id,
            participant_id: target.participant_id,
            symbol: target.symbol,
            seq: seq++,
            ts: ts++,
          });
        }
      } else if (roll <= 79) {
        // Reject: ALREADY_TERMINAL
        if (cancelledOrderIds.length > 0) {
          const targetId = g(fc.constantFrom, ...cancelledOrderIds);
          const target = placedOrders.find(o => o.order_id === targetId);
          if (target) {
            commands.push({
              type: 'CANCEL',
              order_id: target.order_id,
              participant_id: target.participant_id,
              symbol: target.symbol,
              seq: seq++,
              ts: ts++,
            });
          }
        } else if (placedOrders.length > 0) {
          const target = g(fc.constantFrom, ...placedOrders);
          commands.push({
            type: 'CANCEL',
            order_id: target.order_id,
            participant_id: target.participant_id,
            symbol: target.symbol,
            seq: seq++,
            ts: ts++,
          });
          cancelledOrderIds.push(target.order_id);
          commands.push({
            type: 'CANCEL',
            order_id: target.order_id,
            participant_id: target.participant_id,
            symbol: target.symbol,
            seq: seq++,
            ts: ts++,
          });
        }
      } else if (roll <= 82) {
        // Reject: DUPLICATE_ORDER
        if (placedOrders.length > 0) {
          const target = g(fc.constantFrom, ...placedOrders);
          commands.push({
            type: 'LIMIT',
            order_id: target.order_id,
            participant_id: target.participant_id,
            symbol: 'BTC-USDT',
            side: 'BUY',
            price: 100,
            quantity: 5,
            seq: seq++,
            ts: ts++,
          });
        }
      } else if (roll <= 85) {
        // Reject: UNKNOWN_ORDER
        commands.push({
          type: 'CANCEL',
          order_id: 999999 + g(fc.integer, { min: 1, max: 100 }),
          participant_id: 1,
          symbol: 'BTC-USDT',
          seq: seq++,
          ts: ts++,
        });
      } else if (roll <= 88) {
        // Reject: NOT_OWNER
        if (placedOrders.length > 0) {
          const target = g(fc.constantFrom, ...placedOrders);
          commands.push({
            type: 'CANCEL',
            order_id: target.order_id,
            participant_id: target.participant_id + 99,
            symbol: target.symbol,
            seq: seq++,
            ts: ts++,
          });
        }
      } else if (roll <= 91) {
        // Reject: INVALID_TICK
        commands.push({
          type: 'LIMIT',
          order_id: orderIdSeq++,
          participant_id: 1,
          symbol: 'ETH-USDT',
          side: 'BUY',
          price: 201, // non-multiple of tick_size 5
          quantity: 10,
          seq: seq++,
          ts: ts++,
        });
      } else if (roll <= 94) {
        // Reject: INVALID_LOT
        commands.push({
          type: 'LIMIT',
          order_id: orderIdSeq++,
          participant_id: 1,
          symbol: 'ETH-USDT',
          side: 'BUY',
          price: 200,
          quantity: 17, // non-multiple of lot_size 10
          seq: seq++,
          ts: ts++,
        });
      } else if (roll <= 96) {
        // Reject: INVALID_SIDE
        commands.push({
          type: 'LIMIT',
          order_id: orderIdSeq++,
          participant_id: 1,
          symbol: 'BTC-USDT',
          side: 'HOLD',
          price: 100,
          quantity: 5,
          seq: seq++,
          ts: ts++,
        });
      } else if (roll <= 98) {
        // Reject: NON_POSITIVE_QUANTITY
        commands.push({
          type: 'LIMIT',
          order_id: orderIdSeq++,
          participant_id: 1,
          symbol: 'BTC-USDT',
          side: 'BUY',
          price: 100,
          quantity: 0,
          seq: seq++,
          ts: ts++,
        });
      } else {
        // Reject: UNKNOWN_INSTRUMENT
        commands.push({
          type: 'LIMIT',
          order_id: orderIdSeq++,
          participant_id: 1,
          symbol: 'UNKNOWN-SYM',
          side: 'BUY',
          price: 100,
          quantity: 5,
          seq: seq++,
          ts: ts++,
        });
      }
    }

    return commands;
  });

  it('compares randomized valid and invalid command sequences between engine and oracle', () => {
    let totalSequences = 0;
    const seed = Date.now();

    const counts = {
      commands: 0,
      trades: 0,
      multi_level_sweeps: 0,
      partial_fills: 0,
      cancels: 0,
      ioc_remainder_cancels: 0,
      market_remainder_cancels: 0,
      UNKNOWN_INSTRUMENT: 0,
      INVALID_TICK: 0,
      INVALID_LOT: 0,
      INVALID_SIDE: 0,
      NON_POSITIVE_QUANTITY: 0,
      UNKNOWN_ORDER: 0,
      NOT_OWNER: 0,
      ALREADY_TERMINAL: 0,
      DUPLICATE_ORDER: 0,
    };

    try {
      fc.assert(
        fc.property(commandSequenceArb, commands => {
          totalSequences += 1;

          const engine = new MatchingEngine({ instruments });
          const oracle = new NaiveEngine({ instruments });

          for (const cmd of commands) {
            counts.commands += 1;

            const engineEvents = engine.processCommand(cmd);
            const oracleEvents = oracle.processCommand(cmd);

            assert.deepEqual(
              engineEvents,
              oracleEvents,
              `Event mismatch on command: ${JSON.stringify(cmd)}`
            );

            // Compare depth for both instruments
            for (const inst of instruments) {
              const engineDepth = engine.getDepth(inst.symbol);
              const oracleDepth = oracle.getDepth(inst.symbol);
              assert.deepEqual(
                engineDepth,
                oracleDepth,
                `Depth mismatch for ${inst.symbol} on command: ${JSON.stringify(cmd)}`
              );
            }

            // Invariant verification on engine state
            assert.equal(engine.checkInvariants(), true);

            // Operational metrics tracking
            const tradeEvents = engineEvents.filter(e => e.event === 'TRADE_EXECUTED');
            counts.trades += tradeEvents.length;

            if (tradeEvents.length > 1) {
              const distinctPrices = new Set(tradeEvents.map(e => e.price));
              if (distinctPrices.size > 1) {
                counts.multi_level_sweeps += 1;
              }
            }

            // Partial fill tracking
            let hadPartialFill = false;
            if (tradeEvents.length > 0) {
              for (const t of tradeEvents) {
                const makerFilled = engineEvents.some(
                  e => e.event === 'ORDER_FILLED' && e.order_id === t.maker_order_id
                );
                if (!makerFilled) {
                  hadPartialFill = true;
                  break;
                }
              }
              if (!hadPartialFill) {
                const takerAccepted = engineEvents.find(
                  e => e.event === 'ORDER_ACCEPTED' && e.order_id === cmd.order_id
                );
                const takerCancelled = engineEvents.find(
                  e => e.event === 'ORDER_CANCELLED' && e.order_id === cmd.order_id
                );
                if (takerAccepted || takerCancelled) {
                  hadPartialFill = true;
                }
              }
            }
            if (hadPartialFill) counts.partial_fills += 1;

            for (const e of engineEvents) {
              if (e.event === 'ORDER_CANCELLED') {
                if (e.reason === 'CLIENT_CANCEL') counts.cancels += 1;
                else if (e.reason === 'IOC_UNFILLED') counts.ioc_remainder_cancels += 1;
                else if (e.reason === 'MARKET_UNFILLED') counts.market_remainder_cancels += 1;
              } else if (e.event === 'ORDER_REJECTED') {
                if (counts[e.code] !== undefined) {
                  counts[e.code] += 1;
                }
              }
            }
          }

          return true;
        }),
        { numRuns, seed }
      );
    } catch (err) {
      console.error(`Differential test failed with seed: ${seed}`);
      throw err;
    }

    console.log(
      `\n[Differential Generator Statistics] (${totalSequences} sequences, ${counts.commands} commands):`
    );
    console.table(counts);

    // Fail the test if any category has zero occurrences across the run
    for (const [category, count] of Object.entries(counts)) {
      assert.ok(
        count > 0,
        `Differential test failed: Category "${category}" had 0 occurrences across the run (weak generator)!`
      );
    }
  });

  it('verifies determinism: same seed run twice gives identical event streams', () => {
    const seed = 42891723;
    const [commands1] = fc.sample(commandSequenceArb, { seed, numRuns: 1 });
    const [commands2] = fc.sample(commandSequenceArb, { seed, numRuns: 1 });

    assert.deepEqual(commands1, commands2, 'Same seed must generate identical command sequence');

    const engine1 = new MatchingEngine({ instruments });
    const engine2 = new MatchingEngine({ instruments });

    const events1 = [];
    const events2 = [];

    for (const cmd of commands1) {
      events1.push(...engine1.processCommand(cmd));
    }
    for (const cmd of commands2) {
      events2.push(...engine2.processCommand(cmd));
    }

    assert.deepEqual(events1, events2);
    for (const inst of instruments) {
      assert.deepEqual(engine1.getDepth(inst.symbol), engine2.getDepth(inst.symbol));
    }
  });
});
