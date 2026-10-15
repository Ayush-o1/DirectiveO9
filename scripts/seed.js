import crypto from 'node:crypto';
import { getPool } from '../src/db/pool.js';

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export const SEED_DATA = {
  instruments: [
    { symbol: 'BTC-USDT', tick_size: 1, lot_size: 1 },
    { symbol: 'ETH-USDT', tick_size: 5, lot_size: 10 },
  ],
  participants: [
    {
      participant_id: 1,
      name: 'MM1',
      apiKey: 'key_mm1_test_secret_1',
      is_admin: false,
    },
    {
      participant_id: 2,
      name: 'MM2',
      apiKey: 'key_mm2_test_secret_2',
      is_admin: false,
    },
    {
      participant_id: 3,
      name: 'TRADER1',
      apiKey: 'key_trader1_test_secret_3',
      is_admin: false,
    },
    {
      participant_id: 99,
      name: 'ADMIN',
      apiKey: 'key_admin_test_secret_99',
      is_admin: true,
    },
  ],
};

export async function seedDatabase(pool = getPool()) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Seed instruments
    for (const inst of SEED_DATA.instruments) {
      await client.query(
        `INSERT INTO instruments (symbol, tick_size, lot_size)
         VALUES ($1, $2, $3)
         ON CONFLICT (symbol) DO UPDATE
         SET tick_size = EXCLUDED.tick_size, lot_size = EXCLUDED.lot_size`,
        [inst.symbol, inst.tick_size, inst.lot_size]
      );
    }

    // Seed participants
    for (const p of SEED_DATA.participants) {
      const hash = hashApiKey(p.apiKey);
      await client.query(
        `INSERT INTO participants (participant_id, name, api_key_hash, is_admin)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (participant_id) DO UPDATE
         SET name = EXCLUDED.name, api_key_hash = EXCLUDED.api_key_hash, is_admin = EXCLUDED.is_admin`,
        [p.participant_id, p.name, hash, p.is_admin]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Standalone execution
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seedDatabase()
    .then(() => {
      console.log('Database seeded successfully.');
      process.exit(0);
    })
    .catch(err => {
      console.error('Seeding failed:', err);
      process.exit(1);
    });
}
