import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AvlTreePriceIndex } from '../src/engine/avl.js';
import { SortedArrayPriceIndex } from '../src/engine/level.js';
import { MatchingEngine } from '../src/engine/engine.js';
import { NaiveEngine } from './oracle/naive-engine.js';
import { computeStateHash } from '../src/engine/hash.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('AVL Tree Price Level Index (Alternative Data Structure)', () => {
  test('maintains strictly descending order and correct min/max for bids', () => {
    const bids = new AvlTreePriceIndex(true);
    assert.equal(bids.length, 0);
    assert.equal(bids[0], undefined);
    assert.equal(bids.peek(), undefined);

    const prices = [100, 150, 80, 120, 90, 200, 110];
    for (const p of prices) {
      assert.equal(bids.insert(p), true);
    }
    // Duplicate insertion returns false and does not change size
    assert.equal(bids.insert(100), false);
    assert.equal(bids.length, 7);
    assert.equal(bids.has(100), true);
    assert.equal(bids.has(999), false);

    assert.equal(bids[0], 200);
    assert.equal(bids.peek(), 200);

    const iterated = [...bids];
    assert.deepEqual(iterated, [200, 150, 120, 110, 100, 90, 80]);

    assert.deepEqual(bids.toArray(3), [200, 150, 120]);
    assert.deepEqual(bids.toArray(20), [200, 150, 120, 110, 100, 90, 80]);

    // Removal of best price
    assert.equal(bids.remove(200), true);
    assert.equal(bids.length, 6);
    assert.equal(bids[0], 150);

    // Removal of min price
    assert.equal(bids.remove(80), true);
    assert.equal(bids.length, 5);
    assert.deepEqual([...bids], [150, 120, 110, 100, 90]);

    // Removal of internal node
    assert.equal(bids.remove(110), true);
    assert.deepEqual([...bids], [150, 120, 100, 90]);

    // Non-existent remove returns false
    assert.equal(bids.remove(999), false);
    assert.equal(bids.length, 4);
  });

  test('maintains strictly ascending order and correct min/max for asks', () => {
    const asks = new AvlTreePriceIndex(false);
    const prices = [100, 150, 80, 120, 90, 200, 110];
    for (const p of prices) {
      assert.equal(asks.insert(p), true);
    }

    assert.equal(asks[0], 80);
    assert.equal(asks.peek(), 80);

    const iterated = [...asks];
    assert.deepEqual(iterated, [80, 90, 100, 110, 120, 150, 200]);

    assert.equal(asks.remove(80), true);
    assert.equal(asks[0], 90);

    // Drain all
    for (const p of [90, 100, 110, 120, 150, 200]) {
      assert.equal(asks.remove(p), true);
    }
    assert.equal(asks.length, 0);
    assert.equal(asks[0], undefined);
    assert.equal(asks.peek(), undefined);
  });

  test('SortedArrayPriceIndex conforms to the identical interface', () => {
    const arrayBids = new SortedArrayPriceIndex(true);
    const avlBids = new AvlTreePriceIndex(true);

    const testPrices = [500, 300, 700, 200, 400, 600, 800, 350, 650];
    for (const p of testPrices) {
      arrayBids.insert(p);
      avlBids.insert(p);
    }

    assert.equal(arrayBids.length, avlBids.length);
    assert.equal(arrayBids[0], avlBids[0]);
    assert.equal(arrayBids.has(500), true);
    assert.equal(arrayBids.has(9999), false);
    assert.deepEqual([...arrayBids], [...avlBids]);
    assert.deepEqual(arrayBids.toArray(4), avlBids.toArray(4));

    for (const removeP of [800, 200, 500]) {
      arrayBids.remove(removeP);
      avlBids.remove(removeP);
    }

    assert.equal(arrayBids.length, avlBids.length);
    assert.equal(arrayBids[0], avlBids[0]);
    assert.deepEqual([...arrayBids], [...avlBids]);
  });
});

describe('Golden Fixtures on MatchingEngine with AvlTreePriceIndex', () => {
  const fixturesDir = path.join(__dirname, 'fixtures');
  const fixtureFiles = fs
    .readdirSync(fixturesDir)
    .filter(f => f.endsWith('.json'))
    .sort();

  for (const file of fixtureFiles) {
    test(`executes fixture with AVL tree index: ${file}`, () => {
      const filePath = path.join(fixturesDir, file);
      const fixture = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      const arrayEngine = new MatchingEngine({
        instruments: fixture.setup?.instruments || [],
        indexType: 'array',
      });
      const avlEngine = new MatchingEngine({
        instruments: fixture.setup?.instruments || [],
        indexType: 'avl',
      });

      for (const cmd of fixture.commands) {
        const arrayEvents = arrayEngine.processCommand(cmd);
        const avlEvents = avlEngine.processCommand(cmd);

        assert.deepEqual(
          avlEvents,
          arrayEvents,
          `AVL events diverged from Array events in fixture ${file} on command ${JSON.stringify(cmd)}`
        );
      }

      arrayEngine.checkInvariants();
      avlEngine.checkInvariants();

      const arrayHash = computeStateHash(arrayEngine);
      const avlHash = computeStateHash(avlEngine);
      assert.equal(
        avlHash,
        arrayHash,
        `State hash mismatch between array and avl engine on fixture ${file}`
      );
    });
  }
});

describe('Differential Verification: Array vs AVL vs Oracle', () => {
  test('randomized sequence produces identical output across Array, AVL, and Naive Oracle', () => {
    const symbol = 'BTC-USDT';
    const instruments = [{ symbol, tick_size: 1, lot_size: 1 }];

    const arrayEngine = new MatchingEngine({ instruments, indexType: 'array' });
    const avlEngine = new MatchingEngine({ instruments, indexType: 'avl' });
    const oracleEngine = new NaiveEngine({ instruments });

    let lcgSeed = 777;
    const lcg = () => {
      lcgSeed = (lcgSeed * 1664525 + 1013904223) >>> 0;
      return lcgSeed / 4294967296;
    };

    let orderId = 1;
    const activeOrders = [];

    for (let i = 0; i < 500; i++) {
      const roll = lcg();
      let cmd;

      if (roll < 0.2 && activeOrders.length > 0) {
        const idx = Math.floor(lcg() * activeOrders.length);
        const target = activeOrders.splice(idx, 1)[0];
        cmd = {
          type: 'CANCEL',
          order_id: target.order_id,
          participant_id: target.participant_id,
          symbol,
        };
      } else {
        const side = lcg() < 0.5 ? 'BUY' : 'SELL';
        const type = lcg() < 0.7 ? 'LIMIT' : lcg() < 0.85 ? 'MARKET' : 'IOC';
        const price = 95 + Math.floor(lcg() * 15);
        const quantity = 1 + Math.floor(lcg() * 5);
        const currentId = orderId++;
        const participantId = 1 + Math.floor(lcg() * 3);

        cmd = {
          type,
          order_id: currentId,
          participant_id: participantId,
          symbol,
          side,
          price: type === 'MARKET' ? undefined : price,
          quantity,
        };

        if (type === 'LIMIT') {
          activeOrders.push({ order_id: currentId, participant_id: participantId });
        }
      }

      const eventsArray = arrayEngine.processCommand(cmd);
      const eventsAvl = avlEngine.processCommand(cmd);
      const eventsOracle = oracleEngine.processCommand(cmd);

      assert.deepEqual(eventsAvl, eventsArray, `AVL != Array at step ${i}`);
      assert.deepEqual(eventsArray, eventsOracle, `Array != Oracle at step ${i}`);
    }

    arrayEngine.checkInvariants();
    avlEngine.checkInvariants();

    const hashArray = computeStateHash(arrayEngine);
    const hashAvl = computeStateHash(avlEngine);
    assert.equal(hashAvl, hashArray, 'Canonical state hash parity');
  });
});
