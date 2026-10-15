import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findInsertIndex, insertPrice, findPriceIndex, removePrice } from '../src/engine/level.js';

describe('Price Level Sorted Index (Binary Search)', () => {
  describe('Bids (Descending Order: highest price first)', () => {
    it('inserts prices into empty array', () => {
      const bids = [];
      const idx = insertPrice(bids, 100, true);
      assert.equal(idx, 0);
      assert.deepEqual(bids, [100]);
    });

    it('maintains descending order on sequential and random insertions', () => {
      const bids = [];
      insertPrice(bids, 100, true);
      insertPrice(bids, 120, true);
      insertPrice(bids, 90, true);
      insertPrice(bids, 110, true);

      assert.deepEqual(bids, [120, 110, 100, 90]);
    });

    it('does not duplicate existing prices in sorted array', () => {
      const bids = [120, 100, 90];
      const idx = insertPrice(bids, 100, true);
      assert.equal(idx, 1);
      assert.deepEqual(bids, [120, 100, 90]);
    });

    it('finds existing price index and returns -1 for missing price', () => {
      const bids = [120, 110, 100, 90];
      assert.equal(findPriceIndex(bids, 120, true), 0);
      assert.equal(findPriceIndex(bids, 100, true), 2);
      assert.equal(findPriceIndex(bids, 90, true), 3);
      assert.equal(findPriceIndex(bids, 115, true), -1);
      assert.equal(findPriceIndex(bids, 80, true), -1);
      assert.equal(findPriceIndex(bids, 130, true), -1);
    });

    it('removes price level correctly', () => {
      const bids = [120, 110, 100, 90];
      assert.equal(removePrice(bids, 110, true), 1);
      assert.deepEqual(bids, [120, 100, 90]);

      assert.equal(removePrice(bids, 120, true), 0);
      assert.deepEqual(bids, [100, 90]);

      assert.equal(removePrice(bids, 90, true), 1);
      assert.deepEqual(bids, [100]);

      assert.equal(removePrice(bids, 999, true), -1);
      assert.deepEqual(bids, [100]);
    });
  });

  describe('Asks (Ascending Order: lowest price first)', () => {
    it('inserts prices into empty array', () => {
      const asks = [];
      const idx = insertPrice(asks, 100, false);
      assert.equal(idx, 0);
      assert.deepEqual(asks, [100]);
    });

    it('maintains ascending order on insertions', () => {
      const asks = [];
      insertPrice(asks, 100, false);
      insertPrice(asks, 120, false);
      insertPrice(asks, 90, false);
      insertPrice(asks, 110, false);

      assert.deepEqual(asks, [90, 100, 110, 120]);
    });

    it('does not duplicate existing prices in asks array', () => {
      const asks = [90, 100, 120];
      const idx = insertPrice(asks, 100, false);
      assert.equal(idx, 1);
      assert.deepEqual(asks, [90, 100, 120]);
    });

    it('finds ask price index and returns -1 for missing price', () => {
      const asks = [90, 100, 110, 120];
      assert.equal(findPriceIndex(asks, 90, false), 0);
      assert.equal(findPriceIndex(asks, 110, false), 2);
      assert.equal(findPriceIndex(asks, 120, false), 3);
      assert.equal(findPriceIndex(asks, 95, false), -1);
      assert.equal(findPriceIndex(asks, 80, false), -1);
      assert.equal(findPriceIndex(asks, 130, false), -1);
    });

    it('removes ask price level correctly', () => {
      const asks = [90, 100, 110, 120];
      assert.equal(removePrice(asks, 100, false), 1);
      assert.deepEqual(asks, [90, 110, 120]);

      assert.equal(removePrice(asks, 90, false), 0);
      assert.deepEqual(asks, [110, 120]);

      assert.equal(removePrice(asks, 120, false), 1);
      assert.deepEqual(asks, [110]);
    });
  });

  describe('findInsertIndex boundaries', () => {
    it('returns 0 for empty array', () => {
      assert.equal(findInsertIndex([], 100, true), 0);
      assert.equal(findInsertIndex([], 100, false), 0);
    });
  });
});
