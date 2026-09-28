import { createClient } from 'redis';
import { config } from './config.js';

export const redis = createClient({ url: config.redisUrl });
redis.on('error', err => console.error('Redis error:', err));

export async function connectRedis() {
  if (!redis.isOpen) await redis.connect();
}
