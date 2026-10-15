#!/usr/bin/env node

import { getPool, closePool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrator.js';
import { seedDatabase } from './seed.js';
import { MatchingEngine } from '../src/engine/engine.js';
import { Sequencer } from '../src/sequencer/sequencer.js';
import { replayJournal } from '../src/sequencer/replay.js';
import { computeStateHash } from '../src/engine/hash.js';

async function runDemo() {
  console.log('================================================================');
  console.log('         DirectiveO9 Deterministic Matching Engine Demo         ');
  console.log('================================================================\n');

  const pool = getPool();

  try {
    // 1. Run migrations
    console.log('[1/5] Running database migrations...');
    const applied = await runMigrations({ pool });
    if (applied.length > 0) {
      console.log(`      Applied ${applied.length} migration(s): ${applied.join(', ')}`);
    } else {
      console.log('      Schema is up to date.');
    }

    // 2. Reset and seed database
    console.log('[2/5] Seeding instruments and participants...');
    const client = await pool.connect();
    try {
      await client.query('TRUNCATE TABLE trades, events, commands RESTART IDENTITY CASCADE');
    } finally {
      client.release();
    }
    await seedDatabase(pool);
    console.log(
      '      Seeded instruments (BTC-USDT, ETH-USDT) and participants (MM1, MM2, TRADER1, ADMIN).'
    );

    // 3. Initialize engine and sequencer
    console.log('[3/5] Starting sequencer and matching engine...');
    const engine = new MatchingEngine();
    const sequencer = new Sequencer({ engine, pool, batchMaxSize: 10, batchTimeoutMs: 5 });
    await sequencer.init();

    // 4. Run scripted trading session
    console.log('\n[4/5] Executing scripted trading session (BTC-USDT)...');

    const sessionCommands = [
      // MM1 establishes broad quotes
      {
        desc: 'MM1: Post resting buy orders (bids)',
        cmd: {
          type: 'LIMIT',
          participant_id: 1,
          client_order_id: 'MM1-B1',
          symbol: 'BTC-USDT',
          side: 'BUY',
          price: 59900,
          quantity: 10,
        },
      },
      {
        desc: 'MM1: Post resting buy order at deeper level',
        cmd: {
          type: 'LIMIT',
          participant_id: 1,
          client_order_id: 'MM1-B2',
          symbol: 'BTC-USDT',
          side: 'BUY',
          price: 59850,
          quantity: 15,
        },
      },
      {
        desc: 'MM1: Post resting buy order at lowest level',
        cmd: {
          type: 'LIMIT',
          participant_id: 1,
          client_order_id: 'MM1-B3',
          symbol: 'BTC-USDT',
          side: 'BUY',
          price: 59800,
          quantity: 20,
        },
      },
      {
        desc: 'MM1: Post resting sell orders (asks)',
        cmd: {
          type: 'LIMIT',
          participant_id: 1,
          client_order_id: 'MM1-A1',
          symbol: 'BTC-USDT',
          side: 'SELL',
          price: 60100,
          quantity: 10,
        },
      },
      {
        desc: 'MM1: Post resting sell order at higher level',
        cmd: {
          type: 'LIMIT',
          participant_id: 1,
          client_order_id: 'MM1-A2',
          symbol: 'BTC-USDT',
          side: 'SELL',
          price: 60150,
          quantity: 15,
        },
      },
      // MM2 tightens inside spread
      {
        desc: 'MM2: Tighten inside bid to 59,950',
        cmd: {
          type: 'LIMIT',
          participant_id: 2,
          client_order_id: 'MM2-B1',
          symbol: 'BTC-USDT',
          side: 'BUY',
          price: 59950,
          quantity: 5,
        },
      },
      {
        desc: 'MM2: Tighten inside ask to 60,050',
        cmd: {
          type: 'LIMIT',
          participant_id: 2,
          client_order_id: 'MM2-A1',
          symbol: 'BTC-USDT',
          side: 'SELL',
          price: 60050,
          quantity: 5,
        },
      },
      // TRADER1 crosses inside ask (full fill)
      {
        desc: 'TRADER1: Aggressive LIMIT BUY 3 BTC @ 60,050 (Full Fill)',
        cmd: {
          type: 'LIMIT',
          participant_id: 3,
          client_order_id: 'T1-BUY-1',
          symbol: 'BTC-USDT',
          side: 'BUY',
          price: 60050,
          quantity: 3,
        },
      },
      // TRADER1 sends IOC buy for 5 BTC @ 60,050 (Partial Fill 2, Cancel remainder 3)
      {
        desc: 'TRADER1: IOC BUY 5 BTC @ 60,050 (Matches remaining 2 at 60,050; 3 cancelled)',
        cmd: {
          type: 'IOC',
          participant_id: 3,
          client_order_id: 'T1-IOC-1',
          symbol: 'BTC-USDT',
          side: 'BUY',
          price: 60050,
          quantity: 5,
        },
      },
      // MM1 cancels order MM1-B3 (order_id 3)
      {
        desc: 'MM1: Cancel resting order MM1-B3 (order_id: 3)',
        cmd: {
          type: 'CANCEL',
          participant_id: 1,
          client_order_id: 'MM1-C3',
          symbol: 'BTC-USDT',
          order_id: 3,
        },
      },
      // TRADER1 sweeps multiple bid levels: sells 12 BTC @ 59,900
      {
        desc: 'TRADER1: Multi-level sweep SELL 12 BTC @ 59,900 (Fills MM2-B1 5@59950 + MM1-B1 7@59900)',
        cmd: {
          type: 'LIMIT',
          participant_id: 3,
          client_order_id: 'T1-SWEEP-1',
          symbol: 'BTC-USDT',
          side: 'SELL',
          price: 59900,
          quantity: 12,
        },
      },
    ];

    for (const item of sessionCommands) {
      const res = await sequencer.enqueue(item.cmd);
      const fills = res.body.events
        ? res.body.events.filter(e => e.event === 'ORDER_FILLED').length
        : 0;
      const status = res.body.error ? `REJECTED (${res.body.error})` : 'PROCESSED';
      console.log(
        `  -> [Seq ${String(res.body.seq).padStart(2, ' ')}] ${item.desc} | Status: ${status} | Fills: ${fills}`
      );
    }

    await sequencer.close();

    // 5. Print order book
    console.log('\n----------------------------------------------------------------');
    console.log('              CURRENT ORDER BOOK SNAPSHOT (BTC-USDT)            ');
    console.log('----------------------------------------------------------------');
    const depth = engine.getDepth('BTC-USDT', 10);

    console.log('   SIDE     |     PRICE ($)     |   QUANTITY (BTC)  |    LEVELS');
    console.log('------------+-------------------+-------------------+------------');

    if (depth.asks.length === 0) {
      console.log('   ASKS     |      (empty)      |        -          |      -');
    } else {
      // Print asks from highest to lowest
      for (let i = depth.asks.length - 1; i >= 0; i--) {
        const lvl = depth.asks[i];
        console.log(
          `   ASK      |   ${lvl.price.toLocaleString().padStart(11, ' ')}     |   ${lvl.quantity.toString().padStart(11, ' ')}     |   Ask Level ${i + 1}`
        );
      }
    }

    console.log('------------+-------------------+-------------------+------------');
    const spread =
      depth.asks.length > 0 && depth.bids.length > 0
        ? `${(depth.asks[0].price - depth.bids[0].price).toLocaleString()} USD`
        : 'N/A';
    console.log(`   SPREAD   |   ${spread.padStart(15, ' ')} |                   |`);
    console.log('------------+-------------------+-------------------+------------');

    if (depth.bids.length === 0) {
      console.log('   BIDS     |      (empty)      |        -          |      -');
    } else {
      // Print bids from highest to lowest
      for (let i = 0; i < depth.bids.length; i++) {
        const lvl = depth.bids[i];
        console.log(
          `   BID      |   ${lvl.price.toLocaleString().padStart(11, ' ')}     |   ${lvl.quantity.toString().padStart(11, ' ')}     |   Bid Level ${i + 1}`
        );
      }
    }
    console.log('----------------------------------------------------------------\n');

    // 6. Run verify and replay
    console.log('[5/5] Replaying journal & verifying state invariants against oracle...');
    const replayResult = await replayJournal({ pool, oracle: true });

    if (!replayResult.verified) {
      console.error('      REPLAY FAILED! State divergence detected:', replayResult.divergence);
      process.exit(1);
    }

    console.log('      Replay verification passed successfully:');
    console.log(`      - Commands replayed:  ${replayResult.commands_replayed}`);
    console.log(`      - Sequence range:     [${replayResult.from_seq}, ${replayResult.to_seq}]`);
    console.log(
      `      - Invariants passed:  ${replayResult.invariants_passed ? 'YES (all 6 checked)' : 'NO'}`
    );
    console.log(
      `      - Oracle matched:     ${replayResult.oracle_verified ? 'YES (bit-for-bit parity)' : 'NO'}`
    );
    console.log(`      - Replay elapsed:     ${replayResult.duration_ms} ms`);
    const liveHash = computeStateHash(engine);
    console.log(`      - Live Engine State Hash: ${liveHash}`);
    console.log(`      - Replay State Hash:      ${replayResult.state_hash}`);
    console.log(
      `      - Bit-for-Bit Hash Match: ${liveHash === replayResult.state_hash ? 'YES' : 'NO'}\n`
    );

    console.log('================================================================');
    console.log('                  Demo Completed Successfully                   ');
    console.log('================================================================');
  } catch (err) {
    console.error('Demo encountered an error:', err);
    process.exit(1);
  } finally {
    await closePool();
  }
}

runDemo();
