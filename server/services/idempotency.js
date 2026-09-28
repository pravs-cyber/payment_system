import { redis } from '../redis.js';

export async function getIdempotent(key) {
  if (!key) return null;
  const value = await redis.get(`payflow:idempotency:${key}`);
  return value ? JSON.parse(value) : null;
}

export async function saveIdempotent(key, value, ttlSeconds = 86400) {
  if (!key) return;
  await redis.set(`payflow:idempotency:${key}`, JSON.stringify(value), { EX: ttlSeconds });
}
