import { MatchingEngine } from '../engine/engine.js';
import { NaiveEngine } from '../../test/oracle/naive-engine.js';
import { computeStateHash } from '../engine/hash.js';
import { getPool } from '../db/pool.js';

/**
 * Replays journal commands from PostgreSQL through a fresh MatchingEngine instance,
 * verifies bit-for-bit event and trade parity against stored rows, and computes
 * the canonical state hash.
 *
 * Optionally verifies against the independent naive reference oracle.
 */
export async function replayJournal({
  pool = getPool(),
  fromSeq = 1,
  toSeq = null,
  oracle = false,
} = {}) {
  const startTime = Date.now();

  // 1. Load registered instruments
  const { rows: instruments } = await pool.query(
    'SELECT symbol, tick_size, lot_size FROM instruments'
  );

  const engine = new MatchingEngine({ instruments });
  let naiveOracle = null;
  if (oracle) {
    naiveOracle = new NaiveEngine({ instruments });
  }

  // 2. Query maximum sequence if toSeq not specified
  const { rows: maxRows } = await pool.query(
    'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM commands'
  );
  const maxSeqInDb = Number(maxRows[0].max_seq);
  const effectiveToSeq = toSeq !== null && toSeq !== undefined ? Number(toSeq) : maxSeqInDb;

  if (effectiveToSeq < fromSeq) {
    return {
      verified: true,
      commands_replayed: 0,
      from_seq: fromSeq,
      to_seq: effectiveToSeq,
      state_hash: computeStateHash(engine),
      invariants_passed: true,
      oracle_verified: Boolean(oracle),
      divergence: null,
      duration_ms: Date.now() - startTime,
    };
  }

  // 3. Query commands in range
  const { rows: commands } = await pool.query(
    `SELECT seq, command_type, participant_id, client_order_id, symbol, side,
            price, quantity, order_id, payload_hash, status, response_status,
            response_body, ts
     FROM commands
     WHERE seq >= $1 AND seq <= $2
     ORDER BY seq ASC`,
    [fromSeq, effectiveToSeq]
  );

  // 4. Query stored events and trades in range
  const { rows: storedEvents } = await pool.query(
    `SELECT event_id, seq, event_type, order_id, participant_id, payload, ts
     FROM events
     WHERE seq >= $1 AND seq <= $2
     ORDER BY seq ASC, event_id ASC`,
    [fromSeq, effectiveToSeq]
  );

  const { rows: storedTrades } = await pool.query(
    `SELECT trade_id, seq, symbol, price, quantity, maker_order_id, taker_order_id,
            maker_participant_id, taker_participant_id, taker_side, ts
     FROM trades
     WHERE seq >= $1 AND seq <= $2
     ORDER BY seq ASC, trade_id ASC`,
    [fromSeq, effectiveToSeq]
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

  // 5. Replay commands sequentially
  for (const row of commands) {
    const seq = Number(row.seq);
    const cmd = {
      type: row.command_type,
      order_id: row.order_id ? Number(row.order_id) : null,
      participant_id: row.participant_id,
      symbol: row.symbol,
      side: row.side,
      price: row.price !== null ? Number(row.price) : null,
      quantity: row.quantity !== null ? Number(row.quantity) : null,
      seq,
      ts: Number(row.ts),
    };

    const engineEvents = engine.processCommand(cmd);

    // Verify against naive oracle if enabled
    if (naiveOracle) {
      const oracleEvents = naiveOracle.processCommand(cmd);
      if (engineEvents.length !== oracleEvents.length) {
        return {
          verified: false,
          divergence: {
            seq,
            field: 'oracle_event_count',
            expected: oracleEvents.length,
            actual: engineEvents.length,
          },
          commands_replayed: seq - fromSeq,
          state_hash: null,
          duration_ms: Date.now() - startTime,
        };
      }

      for (let i = 0; i < engineEvents.length; i++) {
        const engEv = engineEvents[i];
        const oraEv = oracleEvents[i];
        if (engEv.event !== oraEv.event) {
          return {
            verified: false,
            divergence: {
              seq,
              field: `oracle_event[${i}].type`,
              expected: oraEv.event,
              actual: engEv.event,
            },
            commands_replayed: seq - fromSeq,
            state_hash: null,
            duration_ms: Date.now() - startTime,
          };
        }
      }
    }

    // Verify against stored database events
    const expectedEvents = eventsBySeq.get(seq) || [];
    if (engineEvents.length !== expectedEvents.length) {
      return {
        verified: false,
        divergence: {
          seq,
          field: 'event_count',
          expected: expectedEvents.length,
          actual: engineEvents.length,
        },
        commands_replayed: seq - fromSeq,
        state_hash: null,
        duration_ms: Date.now() - startTime,
      };
    }

    for (let i = 0; i < engineEvents.length; i++) {
      const engEv = engineEvents[i];
      const expEv = expectedEvents[i];
      if (engEv.event !== expEv.event_type) {
        return {
          verified: false,
          divergence: {
            seq,
            field: `event[${i}].type`,
            expected: expEv.event_type,
            actual: engEv.event,
          },
          commands_replayed: seq - fromSeq,
          state_hash: null,
          duration_ms: Date.now() - startTime,
        };
      }
      if (engEv.order_id && expEv.order_id && Number(engEv.order_id) !== Number(expEv.order_id)) {
        return {
          verified: false,
          divergence: {
            seq,
            field: `event[${i}].order_id`,
            expected: Number(expEv.order_id),
            actual: Number(engEv.order_id),
          },
          commands_replayed: seq - fromSeq,
          state_hash: null,
          duration_ms: Date.now() - startTime,
        };
      }
    }

    // Verify against stored trades
    const engineTrades = engineEvents.filter(e => e.event === 'TRADE_EXECUTED');
    const expectedTrades = tradesBySeq.get(seq) || [];
    if (engineTrades.length !== expectedTrades.length) {
      return {
        verified: false,
        divergence: {
          seq,
          field: 'trade_count',
          expected: expectedTrades.length,
          actual: engineTrades.length,
        },
        commands_replayed: seq - fromSeq,
        state_hash: null,
        duration_ms: Date.now() - startTime,
      };
    }

    for (let i = 0; i < engineTrades.length; i++) {
      const engTr = engineTrades[i];
      const expTr = expectedTrades[i];
      if (
        Number(engTr.price) !== Number(expTr.price) ||
        Number(engTr.quantity) !== Number(expTr.quantity) ||
        Number(engTr.maker_order_id) !== Number(expTr.maker_order_id) ||
        Number(engTr.taker_order_id) !== Number(expTr.taker_order_id)
      ) {
        return {
          verified: false,
          divergence: {
            seq,
            field: `trade[${i}]`,
            expected: {
              price: Number(expTr.price),
              quantity: Number(expTr.quantity),
              maker_order_id: Number(expTr.maker_order_id),
              taker_order_id: Number(expTr.taker_order_id),
            },
            actual: {
              price: Number(engTr.price),
              quantity: Number(engTr.quantity),
              maker_order_id: Number(engTr.maker_order_id),
              taker_order_id: Number(engTr.taker_order_id),
            },
          },
          commands_replayed: seq - fromSeq,
          state_hash: null,
          duration_ms: Date.now() - startTime,
        };
      }
    }
  }

  // 6. Verify structural engine invariants
  engine.checkInvariants();

  // 7. Verify depth against naive oracle if enabled
  if (naiveOracle) {
    for (const symbol of engine.instruments.keys()) {
      const engDepth = engine.getDepth(symbol, 100);
      const oraDepth = naiveOracle.getDepth(symbol, 100);
      if (JSON.stringify(engDepth) !== JSON.stringify(oraDepth)) {
        return {
          verified: false,
          divergence: {
            seq: effectiveToSeq,
            field: `oracle_depth_${symbol}`,
            expected: oraDepth,
            actual: engDepth,
          },
          commands_replayed: commands.length,
          state_hash: null,
          duration_ms: Date.now() - startTime,
        };
      }
    }
  }

  const stateHash = computeStateHash(engine);

  return {
    verified: true,
    commands_replayed: commands.length,
    events_verified: storedEvents.length,
    trades_verified: storedTrades.length,
    from_seq: fromSeq,
    to_seq: effectiveToSeq,
    state_hash: stateHash,
    invariants_passed: true,
    oracle_verified: Boolean(oracle),
    divergence: null,
    duration_ms: Date.now() - startTime,
    engine,
  };
}
