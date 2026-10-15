import pg from 'pg';

const { Pool } = pg;

export function createPool(config = {}) {
  if (config.pool) {
    return config.pool;
  }

  if (process.env.DATABASE_URL) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      ...config,
    });
  }

  return new Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5433),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'directiveo9',
    ...config,
  });
}

let defaultPool = null;

export function getPool() {
  if (!defaultPool) {
    defaultPool = createPool();
  }
  return defaultPool;
}

export async function closePool() {
  if (defaultPool) {
    await defaultPool.end();
    defaultPool = null;
  }
}
