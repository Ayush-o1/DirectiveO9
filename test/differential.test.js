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

  // Arbitrary command generator
  const commandSequenceArb = fc.gen().map(g => {
    const length = g(fc.integer, { min: 5, max: 40 });
    const commands = [];
    let orderIdSeq = 1;
    const placedOrderIds = [];

    for (let i = 0; i < length; i++) {
      const seq = i + 1;
      const ts = 1000 + i;

      // Choose command type: mostly LIMIT, occasionally MARKET, IOC, or CANCEL
      const typeRoll = g(fc.integer, { min: 1, max: 10 });
      let type = 'LIMIT';
      if (typeRoll <= 5) type = 'LIMIT';
      else if (typeRoll <= 7) type = 'MARKET';
      else if (typeRoll <= 8) type = 'IOC';
      else type = 'CANCEL';

      // Select symbol (mostly valid BTC-USDT, sometimes ETH-USDT or invalid)
      const symbolRoll = g(fc.integer, { min: 1, max: 10 });
      let symbol = 'BTC-USDT';
      if (symbolRoll <= 6) symbol = 'BTC-USDT';
      else if (symbolRoll <= 9) symbol = 'ETH-USDT';
      else symbol = 'UNKNOWN-SYM';

      const participantId = g(fc.integer, { min: 1, max: 5 });

      if (type === 'CANCEL') {
        // Choose to cancel existing order or unknown order
        let targetOrderId = 99999;
        if (placedOrderIds.length > 0 && g(fc.boolean)) {
          targetOrderId = g(fc.constantFrom, ...placedOrderIds);
        }

        commands.push({
          type: 'CANCEL',
          order_id: targetOrderId,
          participant_id: participantId,
          symbol,
          seq,
          ts,
        });
      } else {
        const order_id = orderIdSeq++;
        placedOrderIds.push(order_id);

        const side = g(fc.constantFrom, 'BUY', 'SELL');

        // Prices centered around spread with occasional edge cases (negative, zero, unaligned tick)
        let price = g(fc.integer, { min: 90, max: 110 });
        if (symbol === 'ETH-USDT') {
          // align to tick_size 5 most of the time
          if (g(fc.integer, { min: 1, max: 10 }) <= 8) {
            price = Math.round(price / 5) * 5;
            if (price <= 0) price = 5;
          }
        }

        // Quantities with occasional unaligned lots or negative
        let quantity = g(fc.integer, { min: 1, max: 50 });
        if (symbol === 'ETH-USDT') {
          if (g(fc.integer, { min: 1, max: 10 }) <= 8) {
            quantity = Math.max(10, Math.round(quantity / 10) * 10);
          }
        }

        commands.push({
          type,
          order_id,
          participant_id: participantId,
          symbol,
          side,
          price,
          quantity,
          seq,
          ts,
        });
      }
    }

    return commands;
  });

  it('compares randomized valid and invalid command sequences between engine and oracle', () => {
    let totalSequences = 0;
    let totalCommandsCompared = 0;
    const seed = Date.now();

    try {
      fc.assert(
        fc.property(commandSequenceArb, commands => {
          totalSequences += 1;

          const engine = new MatchingEngine({ instruments });
          const oracle = new NaiveEngine({ instruments });

          for (const cmd of commands) {
            totalCommandsCompared += 1;

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
          }

          return true;
        }),
        { numRuns: 100, seed }
      );
    } catch (err) {
      console.error(`Differential test failed with seed: ${seed}`);
      throw err;
    }

    assert.ok(totalSequences >= 100, `Expected at least 100 sequences, ran ${totalSequences}`);
    assert.ok(
      totalCommandsCompared >= 1000,
      `Expected at least 1000 commands, compared ${totalCommandsCompared}`
    );
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
