import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 8000),
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379',
  paymentProvider: process.env.PAYMENT_PROVIDER || 'simulator'
};
