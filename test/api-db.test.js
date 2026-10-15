import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createPool, getPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrator.js';
import { seedDatabase } from '../scripts/seed.js';
import { createAuthMiddleware, createAdminAuthMiddleware } from '../src/api/auth.js';
import { createApp } from '../src/api/app.js';
import { Sequencer } from '../src/sequencer/sequencer.js';
import { MatchingEngine } from '../src/engine/engine.js';
import { createOrderSchema } from '../src/api/validation.js';

const execFileAsync = promisify(execFile);

describe('Database Module Coverage (src/db/pool.js & src/db/migrator.js)', () => {
  before(async () => {
    const pool = getPool();
    await runMigrations({ pool });
    await seedDatabase(pool);
  });

  it('covers createPool options (custom pool, DATABASE_URL, defaults)', () => {
    const dummyPool = { query: () => {} };
    const wrapped = createPool({ pool: dummyPool });
    assert.equal(wrapped, dummyPool);

    const prevUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5433/directiveo9';
    const urlPool = createPool();
    assert.ok(urlPool);
    urlPool.end();

    if (prevUrl) {
      process.env.DATABASE_URL = prevUrl;
    } else {
      delete process.env.DATABASE_URL;
    }

    // Test default fallbacks when env vars are absent
    const savedEnv = {
      PGHOST: process.env.PGHOST,
      PGPORT: process.env.PGPORT,
      PGUSER: process.env.PGUSER,
      PGPASSWORD: process.env.PGPASSWORD,
      PGDATABASE: process.env.PGDATABASE,
    };
    delete process.env.PGHOST;
    delete process.env.PGPORT;
    delete process.env.PGUSER;
    delete process.env.PGPASSWORD;
    delete process.env.PGDATABASE;

    const defaultPool = createPool();
    assert.ok(defaultPool);
    defaultPool.end();

    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  it('runs migrations on a new migration file and handles rollback on syntax error', async () => {
    const pool = getPool();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'd9-mig-'));

    try {
      // Valid migration
      const mig1 = '9998_test_dummy.sql';
      await fs.writeFile(
        path.join(tempDir, mig1),
        'CREATE TABLE IF NOT EXISTS _test_dummy (id int);'
      );

      const applied1 = await runMigrations({ pool, migrationsDir: tempDir });
      assert.deepEqual(applied1, [mig1]);

      // Running again returns empty applied list (already applied)
      const appliedAgain = await runMigrations({ pool, migrationsDir: tempDir });
      assert.deepEqual(appliedAgain, []);

      // Failing migration triggers rollback
      const mig2 = '9999_failing_dummy.sql';
      await fs.writeFile(path.join(tempDir, mig2), 'INVALID SQL SYNTAX HERE;');

      await assert.rejects(
        () => runMigrations({ pool, migrationsDir: tempDir }),
        /Migration 9999_failing_dummy.sql failed/
      );

      // Clean up test table and records
      await pool.query('DROP TABLE IF EXISTS _test_dummy;');
      await pool.query(
        "DELETE FROM _migrations WHERE name IN ('9998_test_dummy.sql', '9999_failing_dummy.sql');"
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('runs migrator.js CLI directly via child process', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['src/db/migrator.js'], {
      cwd: process.cwd(),
      env: process.env,
    });
    assert.ok(stdout.includes('migration') || stdout.includes('Database schema up to date'));
  });
});

describe('API Auth & Validation Coverage (src/api/auth.js & src/api/validation.js)', () => {
  it('covers Bearer token authentication and cache hits', async () => {
    const pool = getPool();
    const auth = createAuthMiddleware(pool);

    const req1 = {
      header: name => {
        if (name === 'Authorization') return 'Bearer key_mm1_test_secret_1';
        return undefined;
      },
    };
    const res1 = {
      status: code => ({
        json: b => ({ code, body: b }),
      }),
    };

    let nextCalled = false;
    await auth(req1, res1, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.ok(req1.participant);

    // Second call hits cache
    nextCalled = false;
    const req2 = {
      header: name => {
        if (name === 'X-API-Key') return 'key_mm1_test_secret_1';
        return undefined;
      },
    };
    await auth(req2, res1, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(req2.participant.participant_id, req1.participant.participant_id);
  });

  it('covers auth without pool (returns 500 INTERNAL_ERROR)', async () => {
    const auth = createAuthMiddleware(null);
    let statusCode = null;
    let jsonBody = null;
    const req = {
      header: name => (name === 'X-API-Key' ? 'some_random_key_abc' : undefined),
    };
    const res = {
      status: code => {
        statusCode = code;
        return {
          json: b => {
            jsonBody = b;
          },
        };
      },
    };

    await auth(req, res, () => {});
    assert.equal(statusCode, 500);
    assert.equal(jsonBody.error, 'INTERNAL_ERROR');
  });

  it('covers database error inside auth middleware', async () => {
    const brokenPool = {
      query: async () => {
        throw new Error('Database pool error');
      },
    };
    const auth = createAuthMiddleware(brokenPool);
    let statusCode = null;
    let jsonBody = null;
    const req = {
      header: name => (name === 'X-API-Key' ? 'some_random_key_xyz' : undefined),
    };
    const res = {
      status: code => {
        statusCode = code;
        return {
          json: b => {
            jsonBody = b;
          },
        };
      },
    };

    await auth(req, res, () => {});
    assert.equal(statusCode, 500);
    assert.equal(jsonBody.error, 'DATABASE_ERROR');
  });

  it('covers admin middleware via req.participant.is_admin', async () => {
    const adminAuth = createAdminAuthMiddleware('secret_admin_key');

    let nextCalled = false;
    const reqAdmin = {
      header: () => undefined,
      participant: { is_admin: true },
    };
    adminAuth(reqAdmin, {}, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);

    let forbiddenCode = null;
    let forbiddenBody = null;
    const reqNonAdmin = {
      header: () => undefined,
      participant: { is_admin: false },
    };
    const resForbidden = {
      status: code => {
        forbiddenCode = code;
        return {
          json: b => {
            forbiddenBody = b;
          },
        };
      },
    };
    adminAuth(reqNonAdmin, resForbidden, () => {});
    assert.equal(forbiddenCode, 403);
    assert.equal(forbiddenBody.error, 'FORBIDDEN');
  });

  it('covers MARKET order validation refinement', () => {
    const validMarket = createOrderSchema.safeParse({
      symbol: 'BTC-USDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 10,
    });
    assert.equal(validMarket.success, true);

    const invalidLimit = createOrderSchema.safeParse({
      symbol: 'BTC-USDT',
      side: 'BUY',
      type: 'LIMIT',
      quantity: 10,
    });
    assert.equal(invalidLimit.success, false);
  });
});

describe('API Route Error and Edge Branches (src/api/app.js)', () => {
  it('covers sequencer enqueue error with err.status and generic 500', async () => {
    const mockSequencer = {
      lastSeq: 0,
      queue: [],
      engine: { instruments: new Map(), orders: new Map(), checkInvariants: () => {} },
      on: () => {},
      off: () => {},
      enqueue: async () => {
        const err = new Error('Custom sequencer failure');
        err.status = 503;
        err.code = 'CUSTOM_FAILURE';
        throw err;
      },
    };

    const pool = {
      query: async () => ({
        rows: [{ participant_id: 1, name: 'Trader Alpha', is_admin: true }],
      }),
    };

    const app = createApp({ sequencer: mockSequencer, pool, adminKey: 'admin' });
    const server = await new Promise(r => {
      const s = app.listen(0, () => r(s));
    });
    const baseUrl = `http://localhost:${server.address().port}`;

    try {
      const res1 = await fetch(`${baseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key_mock' },
        body: JSON.stringify({
          symbol: 'BTC-USDT',
          side: 'BUY',
          type: 'MARKET',
          quantity: 1,
        }),
      });

      assert.equal(res1.status, 503);
      const b1 = await res1.json();
      assert.equal(b1.error, 'CUSTOM_FAILURE');

      // Generic 500 error
      mockSequencer.enqueue = async () => {
        throw new Error('Unspecified fatal error');
      };

      const res2 = await fetch(`${baseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key_mock' },
        body: JSON.stringify({
          symbol: 'BTC-USDT',
          side: 'BUY',
          type: 'MARKET',
          quantity: 1,
        }),
      });

      assert.equal(res2.status, 500);
      const b2 = await res2.json();
      assert.equal(b2.error, 'INTERNAL_ERROR');
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  it('covers cancel order error paths', async () => {
    const mockSequencer = {
      lastSeq: 0,
      queue: [],
      engine: { instruments: new Map(), orders: new Map(), checkInvariants: () => {} },
      on: () => {},
      off: () => {},
      enqueue: async () => {
        const err = new Error('Sequencer error during cancel');
        err.status = 503;
        err.code = 'CANCEL_FAIL';
        throw err;
      },
    };
    const pool = {
      query: async () => ({
        rows: [{ participant_id: 1, name: 'Trader Alpha', is_admin: true }],
      }),
    };
    const app = createApp({ sequencer: mockSequencer, pool, adminKey: 'admin' });
    const server = await new Promise(r => {
      const s = app.listen(0, () => r(s));
    });
    const baseUrl = `http://localhost:${server.address().port}`;

    try {
      // Invalid path param
      const res1 = await fetch(`${baseUrl}/orders/abc`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key_mock' },
        body: JSON.stringify({ symbol: 'BTC-USDT' }),
      });
      assert.equal(res1.status, 400);

      // Invalid body param
      const res2 = await fetch(`${baseUrl}/orders/123`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key_mock' },
        body: JSON.stringify({}),
      });
      assert.equal(res2.status, 400);

      // Sequencer error with status
      const res3 = await fetch(`${baseUrl}/orders/123`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key_mock' },
        body: JSON.stringify({ symbol: 'BTC-USDT' }),
      });
      assert.equal(res3.status, 503);

      // Sequencer error without status (500)
      mockSequencer.enqueue = async () => {
        throw new Error('Internal cancel crash');
      };
      const res4 = await fetch(`${baseUrl}/orders/123`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key_mock' },
        body: JSON.stringify({ symbol: 'BTC-USDT' }),
      });
      assert.equal(res4.status, 500);
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  it('covers admin registration without pool (in-memory mode), validation failures, and database errors', async () => {
    const mockSequencer = {
      lastSeq: 0,
      queue: [],
      engine: {
        instruments: new Map(),
        orders: new Map(),
        registerInstrument: () => {},
        checkInvariants: () => {},
      },
      on: () => {},
      off: () => {},
    };

    const brokenPool = {
      query: async () => {
        throw new Error('Database insert failed');
      },
    };

    const app = createApp({ sequencer: mockSequencer, pool: null, adminKey: 'admin-key-xyz' });
    const server = await new Promise(r => {
      const s = app.listen(0, () => r(s));
    });
    const baseUrl = `http://localhost:${server.address().port}`;

    try {
      // Invalid instrument schema
      const res1 = await fetch(`${baseUrl}/admin/instruments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'admin-key-xyz' },
        body: JSON.stringify({ symbol: '' }),
      });
      assert.equal(res1.status, 400);

      // Valid instrument registration without pool
      const res2 = await fetch(`${baseUrl}/admin/instruments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'admin-key-xyz' },
        body: JSON.stringify({ symbol: 'ETH-USDT', tick_size: 1, lot_size: 1 }),
      });
      assert.equal(res2.status, 201);
      const b2 = await res2.json();
      assert.equal(b2.success, true);

      // Invalid participant schema
      const res3 = await fetch(`${baseUrl}/admin/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'admin-key-xyz' },
        body: JSON.stringify({ participant_id: 'bad' }),
      });
      assert.equal(res3.status, 400);

      // Valid participant registration without pool
      const res4 = await fetch(`${baseUrl}/admin/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'admin-key-xyz' },
        body: JSON.stringify({
          participant_id: 99,
          name: 'Market Maker 99',
          apiKey: 'key_mm_test_123456789',
        }),
      });
      assert.equal(res4.status, 201);
      const b4 = await res4.json();
      assert.equal(b4.success, true);
    } finally {
      await new Promise(r => server.close(r));
    }

    // Now test database error branches for admin registration
    const appWithBrokenPool = createApp({
      sequencer: mockSequencer,
      pool: brokenPool,
      adminKey: 'admin-key-xyz',
    });
    const s2 = await new Promise(r => {
      const s = appWithBrokenPool.listen(0, () => r(s));
    });
    const base2 = `http://localhost:${s2.address().port}`;

    try {
      const resInst = await fetch(`${base2}/admin/instruments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'admin-key-xyz' },
        body: JSON.stringify({ symbol: 'SOL-USDT', tick_size: 1, lot_size: 1 }),
      });
      assert.equal(resInst.status, 500);

      const resPart = await fetch(`${base2}/admin/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'admin-key-xyz' },
        body: JSON.stringify({
          participant_id: 77,
          name: 'Trader 77',
          apiKey: 'key_trader_77_secret_1234',
        }),
      });
      assert.equal(resPart.status, 500);
    } finally {
      await new Promise(r => s2.close(r));
    }
  });

  it('covers /admin/verify database failure checks (sequence gap, volume mismatch, order mismatch)', async () => {
    const engine = new MatchingEngine();
    engine.registerInstrument({ symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 });
    const sequencer = {
      lastSeq: 5,
      queue: [],
      engine,
      on: () => {},
      off: () => {},
    };

    // 1. Sequence gap failure
    const poolGap = {
      query: async sql => {
        if (sql.includes('MIN(seq)')) {
          return { rows: [{ min_seq: 2, max_seq: 5, count: 4 }] };
        }
        return { rows: [] };
      },
    };
    const appGap = createApp({ sequencer, pool: poolGap, adminKey: 'adm' });
    const sGap = await new Promise(r => {
      const s = appGap.listen(0, () => r(s));
    });
    try {
      const res = await fetch(`http://localhost:${sGap.address().port}/admin/verify`, {
        headers: { 'X-Admin-Key': 'adm' },
      });
      assert.equal(res.status, 500);
      const b = await res.json();
      assert.ok(b.error.includes('sequence gaps'));
    } finally {
      await new Promise(r => sGap.close(r));
    }

    // 2. Volume bought != sold failure
    const poolVol = {
      query: async sql => {
        if (sql.includes('MIN(seq)')) {
          return { rows: [{ min_seq: 1, max_seq: 5, count: 5 }] };
        }
        if (sql.includes('FROM trades')) {
          return {
            rows: [
              {
                symbol: 'BTC-USDT',
                taker_bought: 10,
                maker_bought: 0,
                taker_sold: 5,
                maker_sold: 0,
                total_volume: 15,
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const appVol = createApp({ sequencer, pool: poolVol, adminKey: 'adm' });
    const sVol = await new Promise(r => {
      const s = appVol.listen(0, () => r(s));
    });
    try {
      const res = await fetch(`http://localhost:${sVol.address().port}/admin/verify`, {
        headers: { 'X-Admin-Key': 'adm' },
      });
      assert.equal(res.status, 500);
      const b = await res.json();
      assert.ok(b.error.includes('does not equal sold'));
    } finally {
      await new Promise(r => sVol.close(r));
    }

    // 3. Orders table count mismatch
    const poolOrderCount = {
      query: async sql => {
        if (sql.includes('MIN(seq)')) {
          return { rows: [{ min_seq: 1, max_seq: 5, count: 5 }] };
        }
        if (sql.includes('FROM trades')) {
          return { rows: [] };
        }
        if (sql.includes('FROM orders')) {
          return { rows: [{ order_id: 1, remaining_qty: 10, state: 'NEW' }] };
        }
        return { rows: [] };
      },
    };
    const appOrderCount = createApp({ sequencer, pool: poolOrderCount, adminKey: 'adm' });
    const sOrderCount = await new Promise(r => {
      const s = appOrderCount.listen(0, () => r(s));
    });
    try {
      const res = await fetch(`http://localhost:${sOrderCount.address().port}/admin/verify`, {
        headers: { 'X-Admin-Key': 'adm' },
      });
      assert.equal(res.status, 500);
      const b = await res.json();
      assert.ok(b.error.includes('Orders table count mismatch'));
    } finally {
      await new Promise(r => sOrderCount.close(r));
    }

    // 4. Orders table detail mismatch
    const engineMock = {
      instruments: new Map(),
      orders: new Map([[1, { order_id: 1, remaining_qty: 5, state: 'NEW' }]]),
      checkInvariants: () => {},
    };
    const seqDetail = { lastSeq: 5, queue: [], engine: engineMock, on: () => {}, off: () => {} };
    const poolOrderDetail = {
      query: async sql => {
        if (sql.includes('MIN(seq)')) {
          return { rows: [{ min_seq: 1, max_seq: 5, count: 5 }] };
        }
        if (sql.includes('FROM trades')) {
          return { rows: [] };
        }
        if (sql.includes('FROM orders')) {
          return { rows: [{ order_id: 1, remaining_qty: 10, state: 'NEW' }] };
        }
        return { rows: [] };
      },
    };
    const appOrderDetail = createApp({
      sequencer: seqDetail,
      pool: poolOrderDetail,
      adminKey: 'adm',
    });
    const sOrderDetail = await new Promise(r => {
      const s = appOrderDetail.listen(0, () => r(s));
    });
    try {
      const res = await fetch(`http://localhost:${sOrderDetail.address().port}/admin/verify`, {
        headers: { 'X-Admin-Key': 'adm' },
      });
      assert.equal(res.status, 500);
      const b = await res.json();
      assert.ok(b.error.includes('Order mismatch at order 1'));
    } finally {
      await new Promise(r => sOrderDetail.close(r));
    }
  });

  it('covers queries without pool (/trades, /events, /orders/:id error)', async () => {
    const mockSequencer = {
      lastSeq: 0,
      queue: [],
      engine: {
        instruments: new Map(),
        orders: new Map(),
        checkInvariants: () => {},
        getDepth: () => null,
        getOrder: () => null,
      },
      on: () => {},
      off: () => {},
    };

    const app = createApp({ sequencer: mockSequencer, pool: null, adminKey: 'adm' });
    const server = await new Promise(r => {
      const s = app.listen(0, () => r(s));
    });
    const baseUrl = `http://localhost:${server.address().port}`;

    try {
      const resTrades = await fetch(`${baseUrl}/trades`);
      assert.equal(resTrades.status, 500);
      const bT = await resTrades.json();
      assert.equal(bT.error, 'DATABASE_UNAVAILABLE');

      const resEvents = await fetch(`${baseUrl}/events`);
      assert.equal(resEvents.status, 500);
      const bE = await resEvents.json();
      assert.equal(bE.error, 'DATABASE_UNAVAILABLE');
    } finally {
      await new Promise(r => server.close(r));
    }

    // Database error in GET /orders/:id
    const brokenPool = {
      query: async sql => {
        if (sql.includes('SELECT * FROM orders')) {
          throw new Error('Database crash on order query');
        }
        return { rows: [{ participant_id: 1, name: 'MM1', is_admin: false }] };
      },
    };
    const appBroken = createApp({ sequencer: mockSequencer, pool: brokenPool, adminKey: 'adm' });
    const sBroken = await new Promise(r => {
      const s = appBroken.listen(0, () => r(s));
    });
    try {
      const res = await fetch(`http://localhost:${sBroken.address().port}/orders/123`, {
        headers: { 'X-API-Key': 'key_mm1_test_secret_1' },
      });
      assert.equal(res.status, 500);
    } finally {
      await new Promise(r => sBroken.close(r));
    }
  });

  it('covers query endpoints error branches and 404s', async () => {
    const pool = getPool();
    const sequencer = new Sequencer({ pool, batchMaxSize: 10, batchTimeoutMs: 10 });
    await sequencer.init();
    const app = createApp({ sequencer, pool, adminKey: 'key_admin_test_secret_99' });
    const server = await new Promise(r => {
      const s = app.listen(0, () => r(s));
    });
    const baseUrl = `http://localhost:${server.address().port}`;

    try {
      // Invalid order ID in GET /orders/:id
      const res1 = await fetch(`${baseUrl}/orders/non-numeric`, {
        headers: { 'X-API-Key': 'key_mm1_test_secret_1' },
      });
      assert.equal(res1.status, 400);

      // Non-existent order in GET /orders/:id
      const res2 = await fetch(`${baseUrl}/orders/999999999`, {
        headers: { 'X-API-Key': 'key_mm1_test_secret_1' },
      });
      assert.equal(res2.status, 404);

      // GET /book/:symbol non-existent
      const res3 = await fetch(`${baseUrl}/book/NON_EXISTENT_PAIR`);
      assert.equal(res3.status, 404);

      // GET /trades with symbol filter
      const res5 = await fetch(`${baseUrl}/trades?symbol=BTC-USDT&limit=10`);
      assert.equal(res5.status, 200);

      // GET /events with filters
      const res6 = await fetch(`${baseUrl}/events?from_seq=1&limit=5`);
      assert.equal(res6.status, 200);
    } finally {
      await sequencer.close();
      await new Promise(r => server.close(r));
    }
  });
});
