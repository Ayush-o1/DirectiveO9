#!/usr/bin/env node

import { replayJournal } from '../src/sequencer/replay.js';
import { getPool, closePool } from '../src/db/pool.js';

async function main() {
  const args = process.argv.slice(2);
  let fromSeq = 1;
  let toSeq = null;
  let oracle = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--from=')) {
      fromSeq = Number(arg.split('=')[1]);
    } else if (arg === '--from' && i + 1 < args.length) {
      fromSeq = Number(args[++i]);
    } else if (arg.startsWith('--to=')) {
      toSeq = Number(arg.split('=')[1]);
    } else if (arg === '--to' && i + 1 < args.length) {
      toSeq = Number(args[++i]);
    } else if (arg === '--oracle') {
      oracle = true;
    } else if (!arg.startsWith('-') && fromSeq === 1 && toSeq === null) {
      fromSeq = Number(arg);
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        toSeq = Number(args[++i]);
      }
    }
  }

  process.stdout.write(
    `[Replay Tool] Starting deterministic journal replay (from=${fromSeq}, to=${toSeq || 'latest'}, oracle=${oracle})...\n`
  );

  const pool = getPool();
  try {
    const result = await replayJournal({ pool, fromSeq, toSeq, oracle });

    if (!result.verified) {
      process.stderr.write(
        `[Replay Tool] REPLAY DIVERGENCE DETECTED at sequence ${result.divergence.seq}!\n` +
          `  Field:    ${result.divergence.field}\n` +
          `  Expected: ${JSON.stringify(result.divergence.expected)}\n` +
          `  Actual:   ${JSON.stringify(result.divergence.actual)}\n`
      );
      process.exit(1);
    }

    process.stdout.write(
      `[Replay Tool] REPLAY VERIFIED SUCCESSFULLY\n` +
        `  Commands Replayed: ${result.commands_replayed}\n` +
        `  Sequence Range:    [${result.from_seq}, ${result.to_seq}]\n` +
        `  State Hash:        ${result.state_hash}\n` +
        `  Invariants Passed: ${result.invariants_passed}\n` +
        `  Oracle Verified:   ${result.oracle_verified}\n` +
        `  Elapsed Time:      ${result.duration_ms}ms\n`
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[Replay Tool] Fatal error during replay: ${err.message}\n`);
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
