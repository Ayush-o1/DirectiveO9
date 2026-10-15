import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrderBook } from '../src/engine/book.js';
import { MatchingEngine } from '../src/engine/engine.js';

describe('Golden Scenario Fixtures', () => {
  const fixturesDir = join(process.cwd(), 'test', 'fixtures');
  const fixtureFiles = readdirSync(fixturesDir)
    .filter(file => file.endsWith('.json'))
    .sort();

  assert.ok(
    fixtureFiles.length >= 35,
    `Expected at least 35 fixtures, found ${fixtureFiles.length}`
  );

  for (const file of fixtureFiles) {
    const raw = readFileSync(join(fixturesDir, file), 'utf8');
    const fixture = JSON.parse(raw);

    it(`executes ${fixture.name}: ${fixture.description}`, () => {
      const isMatchingFixture = fixture.commands.some(
        c =>
          c.type === 'LIMIT' ||
          c.type === 'MARKET' ||
          c.type === 'IOC' ||
          file.startsWith('3') ||
          file.startsWith('4')
      );

      if (isMatchingFixture) {
        for (const indexType of ['array', 'avl']) {
          const engine = new MatchingEngine({
            instruments: [
              {
                symbol: fixture.symbol,
                tick_size: fixture.tick_size,
                lot_size: fixture.lot_size,
              },
            ],
            indexType,
          });

          const actualEvents = [];

          for (const cmd of fixture.commands) {
            const events = engine.processCommand({
              symbol: cmd.symbol ?? fixture.symbol,
              ...cmd,
            });
            actualEvents.push(...events);

            assert.equal(engine.checkInvariants(), true);
          }

          assert.deepEqual(actualEvents, fixture.expected_events);

          const depth = engine.getDepth(fixture.symbol);
          if (fixture.expected_book) {
            if (fixture.expected_book.depth) {
              assert.deepEqual(depth.bids, fixture.expected_book.depth.bids);
              assert.deepEqual(depth.asks, fixture.expected_book.depth.asks);
            }
            const book = engine.books.get(fixture.symbol);
            assert.deepEqual(book.getBestBid(), fixture.expected_book.best_bid);
            assert.deepEqual(book.getBestAsk(), fixture.expected_book.best_ask);
          }
        }
      } else {
        // Book core legacy fixtures (01 to 16)
        const book = new OrderBook({
          symbol: fixture.symbol,
          tick_size: fixture.tick_size,
          lot_size: fixture.lot_size,
        });

        const actualEvents = [];

        for (const cmd of fixture.commands) {
          if (cmd.type === 'ADD') {
            try {
              book.addRestingOrder({
                order_id: cmd.order_id,
                participant_id: cmd.participant_id,
                side: cmd.side,
                price: cmd.price,
                quantity: cmd.quantity,
                seq: cmd.seq,
                ts: cmd.ts,
              });

              actualEvents.push({
                event: 'ORDER_ACCEPTED',
                order_id: cmd.order_id,
                participant_id: cmd.participant_id,
                side: cmd.side,
                price: cmd.price,
                quantity: cmd.quantity,
                seq: cmd.seq,
              });
            } catch (err) {
              actualEvents.push({
                event: 'COMMAND_REJECTED',
                message: err.message,
                order_id: cmd.order_id,
                participant_id: cmd.participant_id,
                seq: cmd.seq,
              });
            }
          } else if (cmd.type === 'CANCEL') {
            const res = book.cancelOrder(cmd.order_id, cmd.participant_id);
            if (res.success) {
              actualEvents.push({
                event: 'ORDER_CANCELLED',
                order_id: res.order.order_id,
                participant_id: res.order.participant_id,
                price: res.order.price,
                remaining_qty: res.order.remaining_qty,
                side: res.order.side,
                seq: cmd.seq,
              });
            } else {
              actualEvents.push({
                event: 'COMMAND_REJECTED',
                code: res.code,
                order_id: cmd.order_id,
                participant_id: cmd.participant_id,
                seq: cmd.seq,
              });
            }
          }

          assert.equal(book.checkInvariants(), true);
        }

        assert.deepEqual(actualEvents, fixture.expected_events);
        assert.deepEqual(book.getBestBid(), fixture.expected_book.best_bid);
        assert.deepEqual(book.getBestAsk(), fixture.expected_book.best_ask);

        const depth = book.getDepth();
        assert.deepEqual(depth.bids, fixture.expected_book.depth.bids);
        assert.deepEqual(depth.asks, fixture.expected_book.depth.asks);
      }
    });
  }
});
