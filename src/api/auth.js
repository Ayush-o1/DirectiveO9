import crypto from 'node:crypto';

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function createAuthMiddleware(pool) {
  // In-memory cache for fast participant key lookup
  const keyCache = new Map();

  return async function authenticate(req, res, next) {
    const rawKey =
      req.header('X-API-Key') || req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!rawKey) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Missing X-API-Key header or Bearer token',
      });
    }

    const keyHash = hashApiKey(rawKey);

    // Check fast cache
    if (keyCache.has(keyHash)) {
      req.participant = keyCache.get(keyHash);
      return next();
    }

    if (!pool) {
      return res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Database connection not initialized',
      });
    }

    try {
      const { rows } = await pool.query(
        'SELECT participant_id, name, is_admin FROM participants WHERE api_key_hash = $1',
        [keyHash]
      );

      if (rows.length === 0) {
        return res.status(401).json({
          error: 'UNAUTHORIZED',
          message: 'Invalid API key credential',
        });
      }

      const participant = rows[0];
      keyCache.set(keyHash, participant);
      req.participant = participant;
      next();
    } catch (err) {
      return res.status(500).json({
        error: 'DATABASE_ERROR',
        message: err.message,
      });
    }
  };
}

export function createAdminAuthMiddleware(
  adminKey = process.env.ADMIN_KEY || 'key_admin_test_secret_99'
) {
  return function requireAdmin(req, res, next) {
    const rawAdminKey = req.header('X-Admin-Key');
    if (rawAdminKey && rawAdminKey === adminKey) {
      return next();
    }

    if (req.participant && req.participant.is_admin) {
      return next();
    }

    return res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Administrative privileges required',
    });
  };
}
