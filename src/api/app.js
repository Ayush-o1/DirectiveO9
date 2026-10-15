import express from 'express';
import { createAuthMiddleware, createAdminAuthMiddleware, hashApiKey } from './auth.js';
import {
  createOrderSchema,
  cancelOrderParamSchema,
  cancelOrderBodySchema,
  registerInstrumentSchema,
  registerParticipantSchema,
} from './validation.js';

export function createApp({ sequencer, pool, adminKey }) {
  const app = express();
  app.use(express.json());

  const auth = createAuthMiddleware(pool);
  const adminAuth = createAdminAuthMiddleware(adminKey);

  // 1. Health Endpoint
  app.get('/health', (req, res) => {
    res.json({
      status: 'OK',
      seq: sequencer.lastSeq,
      queue_depth: sequencer.queue.length,
      instruments: Array.from(sequencer.engine.instruments.keys()),
    });
  });

  // 2. Submit Order
  app.post('/orders', auth, async (req, res) => {
    // Schema validation (rejected before sequencing with 400; never gets a seq)
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'INVALID_SCHEMA',
        message: 'Order payload validation failed',
        details: parsed.error.issues,
      });
    }

    try {
      const command = {
        type: parsed.data.type,
        participant_id: req.participant.participant_id,
        client_order_id: parsed.data.client_order_id,
        symbol: parsed.data.symbol,
        side: parsed.data.side,
        price: parsed.data.price,
        quantity: parsed.data.quantity,
      };

      const result = await sequencer.enqueue(command);
      return res.status(result.status).json(result.body);
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({
          error: err.code || 'ERROR',
          message: err.message,
        });
      }
      return res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 3. Cancel Order
  app.delete('/orders/:id', auth, async (req, res) => {
    const paramParsed = cancelOrderParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      return res.status(400).json({
        error: 'INVALID_SCHEMA',
        message: 'Invalid order ID in path parameter',
        details: paramParsed.error.issues,
      });
    }

    const bodyParsed = cancelOrderBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      return res.status(400).json({
        error: 'INVALID_SCHEMA',
        message: 'Invalid cancel body parameters',
        details: bodyParsed.error.issues,
      });
    }

    try {
      const command = {
        type: 'CANCEL',
        order_id: Number(req.params.id),
        participant_id: req.participant.participant_id,
        client_order_id: bodyParsed.data.client_order_id,
        symbol: bodyParsed.data.symbol,
      };

      const result = await sequencer.enqueue(command);
      // Map NOT_OWNER rejection to 403 Forbidden for clean HTTP semantics
      if (!result.body.success && result.body.error === 'NOT_OWNER') {
        return res.status(403).json(result.body);
      }
      return res.status(result.status).json(result.body);
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({
          error: err.code || 'ERROR',
          message: err.message,
        });
      }
      return res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 4. Query Order Details
  app.get('/orders/:id', async (req, res) => {
    const orderId = Number(req.params.id);
    if (!Number.isSafeInteger(orderId)) {
      return res.status(400).json({
        error: 'INVALID_PARAMETER',
        message: 'Order ID must be an integer',
      });
    }

    const memoryOrder = sequencer.engine.getOrder(orderId);
    if (memoryOrder) {
      return res.json({ order: memoryOrder });
    }

    if (pool) {
      try {
        const { rows } = await pool.query('SELECT * FROM orders WHERE order_id = $1', [orderId]);
        if (rows.length > 0) {
          return res.json({ order: rows[0] });
        }
      } catch (err) {
        return res.status(500).json({
          error: 'DATABASE_ERROR',
          message: err.message,
        });
      }
    }

    return res.status(404).json({
      error: 'ORDER_NOT_FOUND',
      message: `Order ${orderId} not found`,
    });
  });

  // 5. Query Order Book Depth
  app.get('/book/:symbol', (req, res) => {
    const symbol = req.params.symbol;
    const depth = req.query.depth ? Math.min(500, Math.max(1, Number(req.query.depth))) : 50;

    const depthView = sequencer.engine.getDepth(symbol, depth);
    if (!depthView) {
      return res.status(404).json({
        error: 'UNKNOWN_INSTRUMENT',
        message: `Instrument ${symbol} is not registered`,
      });
    }

    return res.json({
      symbol,
      seq: sequencer.lastSeq,
      ...depthView,
    });
  });

  // 6. Query Trades History
  app.get('/trades', async (req, res) => {
    if (!pool) {
      return res.status(500).json({ error: 'DATABASE_UNAVAILABLE' });
    }

    const symbol = req.query.symbol;
    const fromSeq = req.query.from_seq ? Number(req.query.from_seq) : 0;
    const limit = req.query.limit ? Math.min(500, Number(req.query.limit)) : 100;

    try {
      let query = 'SELECT * FROM trades WHERE seq >= $1';
      const params = [fromSeq];

      if (symbol) {
        params.push(symbol);
        query += ` AND symbol = $${params.length}`;
      }

      params.push(limit);
      query += ` ORDER BY trade_id DESC LIMIT $${params.length}`;

      const { rows } = await pool.query(query, params);
      return res.json(rows);
    } catch (err) {
      return res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
    }
  });

  // 7. Query Events Log
  app.get('/events', async (req, res) => {
    if (!pool) {
      return res.status(500).json({ error: 'DATABASE_UNAVAILABLE' });
    }

    const fromSeq = req.query.from_seq ? Number(req.query.from_seq) : 0;
    const limit = req.query.limit ? Math.min(500, Number(req.query.limit)) : 100;

    try {
      const { rows } = await pool.query(
        'SELECT * FROM events WHERE seq >= $1 ORDER BY event_id ASC LIMIT $2',
        [fromSeq, limit]
      );
      return res.json(rows);
    } catch (err) {
      return res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
    }
  });

  // 8. Server-Sent Events (SSE) Stream
  app.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const filterSymbol = req.query.symbol;

    const onEvent = ev => {
      if (filterSymbol && ev.symbol && ev.symbol !== filterSymbol) {
        return;
      }
      res.write(`event: ${ev.event}\n`);
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };

    sequencer.on('event', onEvent);

    const heartbeatTimer = setInterval(() => {
      res.write(`event: heartbeat\ndata: {"ts":${Date.now()}}\n\n`);
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeatTimer);
      sequencer.off('event', onEvent);
    });
  });

  // 9. Admin: Register Instrument
  app.post('/admin/instruments', adminAuth, async (req, res) => {
    const parsed = registerInstrumentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'INVALID_SCHEMA',
        details: parsed.error.issues,
      });
    }

    const { symbol, tick_size, lot_size } = parsed.data;

    try {
      if (pool) {
        await pool.query(
          `INSERT INTO instruments (symbol, tick_size, lot_size)
           VALUES ($1, $2, $3)
           ON CONFLICT (symbol) DO UPDATE
           SET tick_size = EXCLUDED.tick_size, lot_size = EXCLUDED.lot_size`,
          [symbol, tick_size, lot_size]
        );
      }

      sequencer.engine.registerInstrument({ symbol, tick_size, lot_size });

      return res.status(201).json({
        success: true,
        instrument: { symbol, tick_size, lot_size },
      });
    } catch (err) {
      return res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
    }
  });

  // 10. Admin: Register Participant
  app.post('/admin/participants', adminAuth, async (req, res) => {
    const parsed = registerParticipantSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'INVALID_SCHEMA',
        details: parsed.error.issues,
      });
    }

    const { participant_id, name, apiKey, is_admin } = parsed.data;
    const keyHash = hashApiKey(apiKey);

    try {
      if (pool) {
        await pool.query(
          `INSERT INTO participants (participant_id, name, api_key_hash, is_admin)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (participant_id) DO UPDATE
           SET name = EXCLUDED.name, api_key_hash = EXCLUDED.api_key_hash, is_admin = EXCLUDED.is_admin`,
          [participant_id, name, keyHash, is_admin || false]
        );
      }

      return res.status(201).json({
        success: true,
        participant: { participant_id, name, is_admin: is_admin || false },
      });
    } catch (err) {
      return res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
    }
  });

  // 11. Admin: Invariant Verification
  app.get('/admin/verify', adminAuth, (req, res) => {
    try {
      sequencer.engine.checkInvariants();
      return res.json({
        invariants_passed: true,
        current_seq: sequencer.lastSeq,
      });
    } catch (err) {
      return res.status(500).json({
        invariants_passed: false,
        error: err.message,
      });
    }
  });

  return app;
}
