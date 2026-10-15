#!/usr/bin/env node

import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT_DIR = resolve('.');
const INDEX_TYPE = process.env.INDEX_TYPE || 'array';

const MUTATIONS = [
  {
    id: 1,
    name: 'Flip price comparison',
    file: 'src/engine/engine.js',
    original: 'if (isBuy && bestOppositePrice > price) {',
    mutated: 'if (isBuy && bestOppositePrice < price) {',
  },
  {
    id: 2,
    name: 'Break FIFO order',
    file: 'src/engine/engine.js',
    original: 'const makerNode = level.head;',
    mutated: 'const makerNode = level.tail;',
  },
  {
    id: 3,
    name: 'Trade at taker price',
    file: 'src/engine/engine.js',
    original: "const tradePrice = makerNode.price; // Trade price is resting order's price",
    mutated: "const tradePrice = price; // Trade price is resting order's price",
  },
  {
    id: 4,
    name: 'Skip level pruning',
    file: 'src/engine/book.js',
    original: 'if (level.isEmpty()) {',
    mutated: 'if (false && level.isEmpty()) {',
  },
  {
    id: 5,
    name: 'Mishandle partial fill',
    file: 'src/engine/engine.js',
    original: 'makerNode.remaining_qty -= matchQty;',
    mutated: '/* makerNode.remaining_qty -= matchQty; */',
  },
  {
    id: 6,
    name: 'Wrong remainder cancel',
    file: 'src/engine/engine.js',
    original: "reason: 'IOC_UNFILLED',",
    mutated: "reason: 'CLIENT_CANCEL',",
  },
  {
    id: 7,
    name: 'Off-by-one in quantity',
    file: 'src/engine/engine.js',
    original: 'const matchQty = Math.min(remaining_qty, makerNode.remaining_qty);',
    mutated: 'const matchQty = Math.max(1, Math.min(remaining_qty, makerNode.remaining_qty) - 1);',
  },
  {
    id: 8,
    name: 'Ignore ownership on cancel',
    file: 'src/engine/book.js',
    original: 'if (entry.node.participant_id !== participant_id) {',
    mutated: 'if (false && entry.node.participant_id !== participant_id) {',
  },
];

function extractCaughtBy(output) {
  // Check for specific fixture failure
  const fixtureMatch = output.match(/✖ executes ([^:\n]+)/);
  if (fixtureMatch) {
    return `Fixture ${fixtureMatch[1]}`;
  }

  // Check for differential test failure
  const diffMatch = output.match(/(?:AVL )?(?:Event|Depth) mismatch on command:[^\n]*/);
  if (diffMatch) {
    return `Differential (${diffMatch[0].slice(0, 40)}...)`;
  }

  // Check for invariant violation in any test
  const invariantMatch = output.match(/Invariant violation:[^\n]+/);
  if (invariantMatch) {
    return invariantMatch[0].trim().slice(0, 48);
  }

  // Generic assertion or failure line
  const lines = output.split('\n');
  const failLine = lines.find(
    l =>
      l.includes('AssertionError') || (l.includes('✖') && !l.includes('Golden Scenario Fixtures'))
  );
  if (failLine) {
    return failLine.trim().slice(0, 48);
  }

  return 'Test suite assertion failure';
}

async function runMutationChecks() {
  console.log('================================================================');
  console.log(`       DirectiveO9 Mutation Spot Check (IndexType: ${INDEX_TYPE})       `);
  console.log('================================================================\n');

  // Create isolated sandbox directory to ensure workspace is never dirtied
  const tempSandbox = mkdtempSync(join(tmpdir(), 'directiveo9-mutate-'));

  try {
    // Copy necessary test and source files to sandbox
    cpSync(join(ROOT_DIR, 'src'), join(tempSandbox, 'src'), { recursive: true });
    cpSync(join(ROOT_DIR, 'test'), join(tempSandbox, 'test'), { recursive: true });
    cpSync(join(ROOT_DIR, 'package.json'), join(tempSandbox, 'package.json'));

    // Symlink node_modules to avoid full npm install
    try {
      symlinkSync(join(ROOT_DIR, 'node_modules'), join(tempSandbox, 'node_modules'), 'junction');
    } catch {
      // If symlink fails, copy
      cpSync(join(ROOT_DIR, 'node_modules'), join(tempSandbox, 'node_modules'), {
        recursive: true,
      });
    }

    const results = [];
    let allCaught = true;

    for (const m of MUTATIONS) {
      const sandboxFile = join(tempSandbox, m.file);
      const originalContent = readFileSync(sandboxFile, 'utf8');

      if (!originalContent.includes(m.original)) {
        console.error(`ERROR: Target text for Bug #${m.id} not found in ${m.file}!`);
        process.exit(1);
      }

      try {
        // Mutate inside sandbox
        const mutatedContent = originalContent.replace(m.original, m.mutated);
        writeFileSync(sandboxFile, mutatedContent, 'utf8');

        // Run test suite against sandboxed code
        let caught = false;
        let caughtBy = 'ESCAPED';

        try {
          execSync('node --test test/fixtures.test.js test/differential.test.js', {
            cwd: tempSandbox,
            env: { ...process.env, INDEX_TYPE },
            stdio: 'pipe',
            timeout: 30000,
          });
          caught = false;
          caughtBy = 'ESCAPED (Tests Passed)';
          allCaught = false;
        } catch (err) {
          caught = true;
          const stdout = err.stdout ? err.stdout.toString() : '';
          const stderr = err.stderr ? err.stderr.toString() : '';
          const combined = `${stdout}\n${stderr}`;
          caughtBy = extractCaughtBy(combined);
        }

        results.push({
          id: m.id,
          name: m.name,
          file: m.file,
          indexType: INDEX_TYPE,
          caught: caught ? 'YES' : 'NO',
          caughtBy,
        });
      } finally {
        // Restore file in sandbox
        writeFileSync(sandboxFile, originalContent, 'utf8');
      }
    }

    // Display formatted results table
    console.log(
      '┌─────┬─────────────────────────────┬─────────────────────┬───────────┬────────┬──────────────────────────────────────────────────┐'
    );
    console.log(
      '│ Bug │ Mutation Description        │ Target File         │ IndexType │ Caught │ Caught By                                        │'
    );
    console.log(
      '├─────┼─────────────────────────────┼─────────────────────┼───────────┼────────┼──────────────────────────────────────────────────┤'
    );

    for (const r of results) {
      const id = String(r.id).padEnd(3, ' ');
      const name = r.name.padEnd(27, ' ');
      const file = r.file.padEnd(19, ' ');
      const idx = r.indexType.padEnd(9, ' ');
      const caught = r.caught.padEnd(6, ' ');
      const caughtBy = r.caughtBy.padEnd(48, ' ');
      console.log(`│ #${id} │ ${name} │ ${file} │ ${idx} │ ${caught} │ ${caughtBy} │`);
    }

    console.log(
      '└─────┴─────────────────────────────┴─────────────────────┴───────────┴────────┴──────────────────────────────────────────────────┘\n'
    );

    if (allCaught) {
      console.log(
        `✓ All 8 mutations were successfully detected and caught for indexType: ${INDEX_TYPE}.\n`
      );
      process.exit(0);
    } else {
      console.error(`✖ One or more mutations ESCAPED for indexType: ${INDEX_TYPE}!\n`);
      process.exit(1);
    }
  } finally {
    // Guaranteed sandbox cleanup
    rmSync(tempSandbox, { recursive: true, force: true });
  }
}

runMutationChecks();
