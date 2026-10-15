import { getPool } from './db/pool.js';
import { runMigrations } from './db/migrator.js';
import { MatchingEngine } from './engine/engine.js';
import { Sequencer } from './sequencer/sequencer.js';
import { createApp } from './api/app.js';

export function getVersion() {
  return '1.0.0';
}

export * from './engine/index.js';
export * from './sequencer/index.js';
export * from './api/index.js';
export * from './db/pool.js';
export * from './db/migrator.js';

export async function bootstrap({
  pool = getPool(),
  port = Number(process.env.PORT || 3000),
  adminKey = process.env.ADMIN_KEY || 'key_admin_test_secret_99',
} = {}) {
  // 1. Run migrations
  await runMigrations({ pool });

  // 2. Initialize engine and sequencer
  const engine = new MatchingEngine();
  const sequencer = new Sequencer({ engine, pool });
  await sequencer.init();

  // 3. Create Express API
  const app = createApp({ sequencer, pool, adminKey });

  let server = null;
  if (port) {
    server = await new Promise(resolve => {
      const s = app.listen(port, () => resolve(s));
    });
  }

  return { app, server, sequencer, engine, pool };
}

// Standalone execution
if (process.argv[1] && process.argv[1].endsWith('src/index.js')) {
  bootstrap()
    .then(({ server }) => {
      const addr = server.address();
      console.log(`DirectiveO9 server running on port ${addr.port}`);
    })
    .catch(err => {
      console.error('Bootstrap failed:', err);
      process.exit(1);
    });
}
