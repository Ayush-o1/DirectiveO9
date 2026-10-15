import crypto from 'node:crypto';

export function computePayloadHash(payload) {
  if (!payload || typeof payload !== 'object') {
    return crypto.createHash('sha256').update(String(payload)).digest('hex');
  }

  // Canonical JSON serialization with sorted keys
  const sorted = Object.keys(payload)
    .sort()
    .reduce((acc, key) => {
      acc[key] = payload[key];
      return acc;
    }, {});

  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

export class IdempotencyCache {
  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  _key(participantId, clientOrderId) {
    return `${participantId}:${clientOrderId}`;
  }

  get(participantId, clientOrderId) {
    const key = this._key(participantId, clientOrderId);
    const item = this.cache.get(key);
    if (!item) return null;

    // Refresh LRU order
    this.cache.delete(key);
    this.cache.set(key, item);
    return item;
  }

  set(participantId, clientOrderId, data) {
    const key = this._key(participantId, clientOrderId);
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first inserted) item
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, data);
  }

  has(participantId, clientOrderId) {
    return this.cache.has(this._key(participantId, clientOrderId));
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}
