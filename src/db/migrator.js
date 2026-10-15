import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

export async function runMigrations({
  pool = getPool(),
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
} = {}) {
  const client = await pool.connect();
  const applied = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const { rows } = await client.query('SELECT name FROM _migrations ORDER BY id ASC');
    const appliedSet = new Set(rows.map(r => r.name));

    const files = await fs.readdir(migrationsDir);
    const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();

    for (const file of sqlFiles) {
      if (!appliedSet.has(file)) {
        const filePath = path.join(migrationsDir, file);
        const sql = await fs.readFile(filePath, 'utf8');

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
          await client.query('COMMIT');
          applied.push(file);
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${file} failed: ${err.message}`);
        }
      }
    }
  } finally {
    client.release();
  }

  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(applied => {
      if (applied.length > 0) {
        process.stdout.write(`Applied ${applied.length} migration(s): ${applied.join(', ')}\n`);
      } else {
        process.stdout.write('Database schema up to date.\n');
      }
      process.exit(0);
    })
    .catch(err => {
      process.stderr.write(`Migration error: ${err.message}\n`);
      process.exit(1);
    });
}
