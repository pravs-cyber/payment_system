import { redis } from './redis.js';

export async function getCachedResponse(key) {
  if (!key) return null;
  const value = await redis.get(`idempotency:${key}`);
  return value ? JSON.parse(value) : null;
}

export async function cacheResponse(key, response) {
  if (!key) return;
  await redis.set(`idempotency:${key}`, JSON.stringify(response), { EX: 86400 });
}
