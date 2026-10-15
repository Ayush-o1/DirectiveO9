import EventEmitter from 'node:events';
import { MatchingEngine } from '../engine/engine.js';
import { IdempotencyCache, computePayloadHash } from './idempotency.js';

export class Sequencer extends EventEmitter {
  constructor({
    engine = new MatchingEngine(),
    pool,
    maxQueueSize = 1000,
    batchMaxSize = Number(process.env.BATCH_MAX_SIZE || 100),
    batchTimeoutMs = Number(process.env.BATCH_TIMEOUT_MS || 5),
    idempotencyCacheSize = 10000,
    beforeCommitHook = null,
  } = {}) {
    super();
    this.engine = engine;
    this.pool = pool;
    this.maxQueueSize = maxQueueSize;
    this.batchMaxSize = batchMaxSize;
    this.batchTimeoutMs = batchTimeoutMs;

    this.idempotencyCache = new IdempotencyCache(idempotencyCacheSize);
    this.inFlightCommands = new Map(); // key -> { payloadHash, callbacks: [{ resolve, reject }] }

    this.queue = [];
    this.lastSeq = 0;
    this.isFlushing = false;
    this.flushTimer = null;
    this.isShuttingDown = false;
    this.isRecovering = false;
    // Constructor-injected hook for testing transaction aborts and fail-stop recovery.
    // Strictly validated as a function; cannot be configured via request payloads or environment variables.
    this._beforeCommitHook = typeof beforeCommitHook === 'function' ? beforeCommitHook : null;
  }

  async init() {
    if (!this.pool) return;
    await this._replayJournal();
  }

  async _replayJournal(fromSeq = 1, toSeq = Infinity) {
    // 1. Load registered instruments from database
    const { rows: instrumentRows } = await this.pool.query(
      'SELECT symbol, tick_size, lot_size FROM instruments'
    );
    for (const inst of instrumentRows) {
      if (!this.engine.instruments.has(inst.symbol)) {
        this.engine.registerInstrument({
          symbol: inst.symbol,
          tick_size: inst.tick_size,
          lot_size: inst.lot_size,
        });
      }
    }

    // 2. Query maximum seq
    const { rows: seqRows } = await this.pool.query(
      'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM commands'
    );
    this.lastSeq = Number(seqRows[0].max_seq);

    const maxQuerySeq = toSeq === Infinity ? null : toSeq;

    // 3. Query all commands
    const { rows: commandRows } = await this.pool.query(
      `SELECT seq, command_type, participant_id, client_order_id, symbol, side,
              price, quantity, order_id, payload_hash, status, response_status,
              response_body, ts
       FROM commands
       WHERE seq >= $1 AND ($2::bigint IS NULL OR seq <= $2)
       ORDER BY seq ASC`,
      [fromSeq, maxQuerySeq]
    );

    // 4. Query all stored events and trades for comparison
    const { rows: storedEvents } = await this.pool.query(
      `SELECT event_id, seq, event_type, order_id, participant_id, payload, ts
       FROM events
       WHERE seq >= $1 AND ($2::bigint IS NULL OR seq <= $2)
       ORDER BY seq ASC, event_id ASC`,
      [fromSeq, maxQuerySeq]
    );

    const { rows: storedTrades } = await this.pool.query(
      `SELECT trade_id, seq, symbol, price, quantity, maker_order_id, taker_order_id,
              maker_participant_id, taker_participant_id, taker_side, ts
       FROM trades
       WHERE seq >= $1 AND ($2::bigint IS NULL OR seq <= $2)
       ORDER BY seq ASC, trade_id ASC`,
      [fromSeq, maxQuerySeq]
    );

    const eventsBySeq = new Map();
    for (const ev of storedEvents) {
      const s = Number(ev.seq);
      if (!eventsBySeq.has(s)) eventsBySeq.set(s, []);
      eventsBySeq.get(s).push(ev);
    }

    const tradesBySeq = new Map();
    for (const tr of storedTrades) {
      const s = Number(tr.seq);
      if (!tradesBySeq.has(s)) tradesBySeq.set(s, []);
      tradesBySeq.get(s).push(tr);
    }

    for (const row of commandRows) {
      const cmdSeq = Number(row.seq);
      const cmd = {
        type: row.command_type,
        order_id: row.order_id ? Number(row.order_id) : null,
        participant_id: row.participant_id,
        symbol: row.symbol,
        side: row.side,
        price: row.price !== null ? Number(row.price) : null,
        quantity: row.quantity !== null ? Number(row.quantity) : null,
        seq: cmdSeq,
        ts: Number(row.ts),
      };

      const regeneratedEvents = this.engine.processCommand(cmd);

      // Verify regenerated events against stored rows
      const expectedEvents = eventsBySeq.get(cmdSeq) || [];
      if (regeneratedEvents.length !== expectedEvents.length) {
        throw new Error(
          `Startup replay divergence at seq ${cmdSeq}: expected ${expectedEvents.length} events but regenerated ${regeneratedEvents.length}`
        );
      }

      for (let i = 0; i < regeneratedEvents.length; i++) {
        const regEv = regeneratedEvents[i];
        const expEv = expectedEvents[i];
        if (regEv.event !== expEv.event_type) {
          throw new Error(
            `Startup replay divergence at seq ${cmdSeq}: event[${i}] type mismatch (expected ${expEv.event_type}, got ${regEv.event})`
          );
        }
        if (regEv.order_id && expEv.order_id && Number(regEv.order_id) !== Number(expEv.order_id)) {
          throw new Error(
            `Startup replay divergence at seq ${cmdSeq}: event[${i}] order_id mismatch (expected ${expEv.order_id}, got ${regEv.order_id})`
          );
        }
      }

      // Verify trades against stored rows
      const regeneratedTrades = regeneratedEvents.filter(e => e.event === 'TRADE_EXECUTED');
      const expectedTrades = tradesBySeq.get(cmdSeq) || [];
      if (regeneratedTrades.length !== expectedTrades.length) {
        throw new Error(
          `Startup replay divergence at seq ${cmdSeq}: expected ${expectedTrades.length} trades but regenerated ${regeneratedTrades.length}`
        );
      }

      for (let i = 0; i < regeneratedTrades.length; i++) {
        const regTr = regeneratedTrades[i];
        const expTr = expectedTrades[i];
        if (
          Number(regTr.price) !== Number(expTr.price) ||
          Number(regTr.quantity) !== Number(expTr.quantity) ||
          Number(regTr.maker_order_id) !== Number(expTr.maker_order_id) ||
          Number(regTr.taker_order_id) !== Number(expTr.taker_order_id)
        ) {
          throw new Error(`Startup replay divergence at seq ${cmdSeq}: trade[${i}] mismatch`);
        }
      }

      // Rebuild in-memory idempotency cache
      if (row.client_order_id) {
        this.idempotencyCache.set(row.participant_id, row.client_order_id, {
          payload_hash: row.payload_hash,
          response_status: row.response_status,
          response_body: row.response_body,
          seq: cmdSeq,
        });
      }
    }

    // Verify invariants after full replay
    this.engine.checkInvariants();
  }

  async _rebuildFromJournal() {
    const freshEngine = new MatchingEngine();
    for (const [sym, inst] of this.engine.instruments.entries()) {
      freshEngine.registerInstrument({
        symbol: sym,
        tick_size: inst.tick_size,
        lot_size: inst.lot_size,
      });
    }
    this.engine = freshEngine;
    this.idempotencyCache.clear();
    await this._replayJournal();
  }

  async enqueue(commandPayload) {
    if (this.isShuttingDown) {
      const err = new Error('Service shutting down');
      err.status = 503;
      err.code = 'SERVICE_UNAVAILABLE';
      throw err;
    }

    if (this.isRecovering) {
      const err = new Error('Sequencer is recovering state after a batch commit failure');
      err.status = 503;
      err.code = 'SERVICE_RECOVERING';
      throw err;
    }

    const { participant_id, client_order_id } = commandPayload;
    const payloadHash = computePayloadHash(commandPayload);

    if (client_order_id) {
      // 1. Idempotency Check: Committed Cache
      const cached = this.idempotencyCache.get(participant_id, client_order_id);
      if (cached) {
        if (cached.payload_hash !== payloadHash) {
          const err = new Error(
            'client_order_id was previously submitted with a different payload'
          );
          err.status = 409;
          err.code = 'IDEMPOTENCY_CONFLICT';
          throw err;
        }
        return {
          status: cached.response_status,
          body: cached.response_body,
        };
      }

      // 2. Idempotency Check: In-Flight Request Coalescence
      const inFlightKey = `${participant_id}:${client_order_id}`;
      const inFlight = this.inFlightCommands.get(inFlightKey);
      if (inFlight) {
        if (inFlight.payloadHash !== payloadHash) {
          const err = new Error(
            'client_order_id was previously submitted with a different payload'
          );
          err.status = 409;
          err.code = 'IDEMPOTENCY_CONFLICT';
          throw err;
        }

        return new Promise((resolve, reject) => {
          inFlight.callbacks.push({ resolve, reject });
        });
      }

      // 3. Database check on cache miss (resolving evicted entries through PostgreSQL constraint)
      if (this.pool) {
        const { rows } = await this.pool.query(
          `SELECT seq, command_type, participant_id, client_order_id, symbol, side,
                  price, quantity, order_id, payload_hash, status, response_status, response_body
           FROM commands
           WHERE participant_id = $1 AND client_order_id = $2`,
          [participant_id, client_order_id]
        );
        if (rows.length > 0) {
          const row = rows[0];
          if (row.payload_hash !== payloadHash) {
            const err = new Error(
              'client_order_id was previously submitted with a different payload'
            );
            err.status = 409;
            err.code = 'IDEMPOTENCY_CONFLICT';
            throw err;
          }

          const responseStatus = row.response_status || 200;
          const responseBody = row.response_body || { success: true, seq: Number(row.seq) };

          this.idempotencyCache.set(participant_id, client_order_id, {
            payload_hash: row.payload_hash,
            response_status: responseStatus,
            response_body: responseBody,
            seq: Number(row.seq),
          });

          return { status: responseStatus, body: responseBody };
        }
      }
    }

    // 4. Bounded Ingress Queue Check
    if (this.queue.length >= this.maxQueueSize) {
      const err = new Error('Sequencer ingress queue is full');
      err.status = 503;
      err.code = 'QUEUE_FULL';
      throw err;
    }

    return new Promise((resolve, reject) => {
      const item = {
        command: commandPayload,
        payloadHash,
        callbacks: [{ resolve, reject }],
      };

      if (client_order_id) {
        const inFlightKey = `${participant_id}:${client_order_id}`;
        this.inFlightCommands.set(inFlightKey, {
          payloadHash,
          callbacks: item.callbacks,
        });
      }

      this.queue.push(item);

      if (!this.flushTimer && !this.isFlushing) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          this._processBatch();
        }, this.batchTimeoutMs);
        this.flushTimer.unref?.();
      }

      if (this.queue.length >= this.batchMaxSize && !this.isFlushing) {
        if (this.flushTimer) {
          clearTimeout(this.flushTimer);
          this.flushTimer = null;
        }
        this._processBatch();
      }
    });
  }

  async _processBatch() {
    if (this.isFlushing || this.queue.length === 0) return;
    this.isFlushing = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const batch = this.queue.splice(0, this.batchMaxSize);
    const ts = Date.now();
    const batchProcessed = [];
    const affectedOrderIds = new Set();

    try {
      // 1. Deterministic execution through matching engine
      for (const item of batch) {
        this.lastSeq += 1;
        const seq = this.lastSeq;
        const { command } = item;

        // Deterministic order ID assignment
        const isPlacement =
          command.type === 'LIMIT' || command.type === 'MARKET' || command.type === 'IOC';
        const order_id = isPlacement ? seq : Number(command.order_id);

        const engineCmd = {
          type: command.type,
          order_id,
          participant_id: command.participant_id,
          symbol: command.symbol,
          side: command.side,
          price: command.price !== undefined ? Number(command.price) : null,
          quantity: command.quantity !== undefined ? Number(command.quantity) : null,
          seq,
          ts,
        };

        const events = this.engine.processCommand(engineCmd);

        // Determine HTTP response status and body
        let status = 'PROCESSED';
        let responseStatus = command.type === 'CANCEL' ? 200 : 201;
        let responseBody;

        const rejectEvent = events.find(e => e.event === 'ORDER_REJECTED');
        if (rejectEvent) {
          status = 'REJECTED';
          responseStatus = 422;
          responseBody = {
            success: false,
            error: rejectEvent.code,
            events,
          };
        } else {
          responseBody = {
            success: true,
            order_id,
            seq,
            events,
          };
        }

        // Collect affected orders for projection upsert
        if (order_id) affectedOrderIds.add(order_id);
        for (const e of events) {
          if (e.maker_order_id) affectedOrderIds.add(e.maker_order_id);
          if (e.taker_order_id) affectedOrderIds.add(e.taker_order_id);
          if (e.order_id) affectedOrderIds.add(e.order_id);
        }

        batchProcessed.push({
          item,
          engineCmd,
          seq,
          ts,
          events,
          status,
          responseStatus,
          responseBody,
        });
      }

      // 2. Database Group-Commit Persistence (if pool configured)
      if (this.pool) {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');

          for (const bp of batchProcessed) {
            const { engineCmd, seq, status, responseStatus, responseBody, item } = bp;

            // Insert into commands journal
            await client.query(
              `INSERT INTO commands (
                seq, command_type, participant_id, client_order_id, symbol, side,
                price, quantity, order_id, payload_hash, status, response_status,
                response_body, ts
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
              [
                seq,
                engineCmd.type,
                engineCmd.participant_id,
                item.command.client_order_id || null,
                engineCmd.symbol || null,
                engineCmd.side || null,
                engineCmd.price !== null ? engineCmd.price : null,
                engineCmd.quantity !== null ? engineCmd.quantity : null,
                engineCmd.order_id || null,
                item.payloadHash,
                status,
                responseStatus,
                JSON.stringify(responseBody),
                engineCmd.ts,
              ]
            );

            // Insert events
            for (const ev of bp.events) {
              await client.query(
                `INSERT INTO events (seq, event_type, order_id, participant_id, payload, ts)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                  seq,
                  ev.event,
                  ev.order_id || ev.maker_order_id || ev.taker_order_id || null,
                  ev.participant_id || ev.taker_participant_id || null,
                  JSON.stringify(ev),
                  ev.ts,
                ]
              );

              // Insert trades
              if (ev.event === 'TRADE_EXECUTED') {
                await client.query(
                  `INSERT INTO trades (
                    trade_id, seq, symbol, price, quantity, maker_order_id,
                    taker_order_id, maker_participant_id, taker_participant_id,
                    taker_side, ts
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                  [
                    ev.trade_id,
                    seq,
                    ev.symbol,
                    ev.price,
                    ev.quantity,
                    ev.maker_order_id,
                    ev.taker_order_id,
                    ev.maker_participant_id,
                    ev.taker_participant_id,
                    ev.taker_side,
                    ev.ts,
                  ]
                );
              }
            }
          }

          // Upsert affected orders
          for (const orderId of affectedOrderIds) {
            const order = this.engine.getOrder(orderId);
            if (order) {
              await client.query(
                `INSERT INTO orders (
                  order_id, participant_id, symbol, side, price, original_qty,
                  remaining_qty, filled_qty, state, seq, ts
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                ON CONFLICT (order_id) DO UPDATE SET
                  remaining_qty = EXCLUDED.remaining_qty,
                  filled_qty = EXCLUDED.filled_qty,
                  state = EXCLUDED.state,
                  seq = EXCLUDED.seq,
                  ts = EXCLUDED.ts,
                  updated_at = NOW()`,
                [
                  order.order_id,
                  order.participant_id,
                  order.symbol,
                  order.side,
                  order.price,
                  order.original_qty,
                  order.remaining_qty,
                  order.filled_qty,
                  order.state,
                  order.seq,
                  order.ts,
                ]
              );
            }
          }

          if (this._beforeCommitHook) {
            await this._beforeCommitHook(client, batchProcessed);
          }

          await client.query('COMMIT');
        } catch (dbErr) {
          await client.query('ROLLBACK');
          throw dbErr;
        } finally {
          client.release();
        }
      }

      // 3. Post-commit notification and resolution
      for (const bp of batchProcessed) {
        const { item, responseStatus, responseBody, seq } = bp;
        const clientOrderId = item.command.client_order_id;
        const participantId = item.command.participant_id;

        // Update in-memory idempotency cache
        if (clientOrderId) {
          this.idempotencyCache.set(participantId, clientOrderId, {
            payload_hash: item.payloadHash,
            response_status: responseStatus,
            response_body: responseBody,
            seq,
          });
          this.inFlightCommands.delete(`${participantId}:${clientOrderId}`);
        }

        // Broadcast events to SSE / listeners
        for (const ev of bp.events) {
          this.emit('event', ev);
        }

        // Acknowledge client requests
        for (const cb of item.callbacks) {
          cb.resolve({ status: responseStatus, body: responseBody });
        }
      }
    } catch (err) {
      // Fail-stop: reject all commands in that batch with 5xx, refuse new work, rebuild engine from journal
      this.isRecovering = true;
      const failErr = new Error(`Batch commit failed: ${err.message}`);
      failErr.status = 500;
      failErr.code = 'COMMIT_FAILED';

      try {
        if (this.pool) {
          await this._rebuildFromJournal();
        }
      } catch (rebuildErr) {
        this.emit('error', rebuildErr);
      } finally {
        this.isRecovering = false;
      }

      for (const item of batch) {
        if (item.command.client_order_id) {
          this.inFlightCommands.delete(
            `${item.command.participant_id}:${item.command.client_order_id}`
          );
        }
        for (const cb of item.callbacks) {
          cb.reject(failErr);
        }
      }
    } finally {
      this.isFlushing = false;
      if (this.queue.length > 0 && !this.isRecovering) {
        this._processBatch();
      }
    }
  }

  async close() {
    this.isShuttingDown = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const maxWait = Date.now() + 2000;
    while ((this.queue.length > 0 || this.isFlushing) && Date.now() < maxWait) {
      if (!this.isFlushing && this.queue.length > 0) {
        await this._processBatch();
      } else {
        await new Promise(r => setTimeout(r, 10));
      }
    }
  }
}
