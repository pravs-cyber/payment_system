import { query } from '../db.js';

// Fixed-window rate limiter stored in Postgres (works across serverless instances, no Redis).
export async function hitRateLimit(bucket, limit, windowSeconds) {
  const { rows } = await query(
    `INSERT INTO rate_limits (bucket, window_start, count)
     VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2) * $2), 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [bucket, windowSeconds]
  );
  return { allowed: rows[0].count <= limit, count: rows[0].count, limit };
}

export function rateLimit(bucketFn, limit, windowSeconds) {
  return async (req, res, next) => {
    try {
      const bucket = bucketFn(req);
      if (!bucket) return next();
      const r = await hitRateLimit(bucket, limit, windowSeconds);
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - r.count)));
      if (!r.allowed) return res.status(429).json({ error: 'Rate limit exceeded, retry later' });
      next();
    } catch (error) { next(error); }
  };
}

export async function audit(actor, action, target, details = {}, client = null) {
  const run = client ? client.query.bind(client) : query;
  try {
    await run(`INSERT INTO audit_log (actor, action, target, details) VALUES ($1,$2,$3,$4)`,
      [actor, action, target, JSON.stringify(details)]);
  } catch (error) {
    console.error('Audit log write failed:', error.message);
  }
}

export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}
