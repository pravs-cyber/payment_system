// Vercel serverless entry point for the PayFlow API.
// vercel.json rewrites /health and /v1/* here; the Express app in server/app.js
// handles routing exactly as it does in Docker (req.url keeps the original path).
import app from '../server/app.js';

export default function handler(req, res) {
  // Also accept direct calls such as /api/v1/wallet or /api/health.
  if (req.url === '/api' || req.url.startsWith('/api/') || req.url.startsWith('/api?')) {
    req.url = req.url.slice(4) || '/';
  }
  return app(req, res);
}
