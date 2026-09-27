import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, assertConfig } from './config.js';
import { pool } from './db.js';
import { migrate } from './db/migrate.js';
import { initAuth } from './middleware/auth.js';
import { securityHeaders, cors } from './lib/http.js';
import { publicRouter } from './routes/public.js';
import { customerRouter } from './routes/customer.js';
import { adminRouter } from './routes/admin.js';
import { webhookRouter } from './routes/webhooks.js';
import { sweepExpiredHolds } from './services/bookings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '../../client/dist');

export async function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render sits behind one proxy
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use('/api', cors);

  app.get('/healthz', async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  // Webhooks need the raw body, so they're mounted before the JSON parser.
  app.use('/api/webhooks', webhookRouter);
  app.use(express.json({ limit: '100kb' }));
  await initAuth(app);

  app.use('/api', publicRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', customerRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } }));

  // Serve the built React app (single Render web service).
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  // Error handler — friendly JSON, no stack traces to clients.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[error]', req.method, req.originalUrl, err);
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { message: 'Invalid JSON body', code: 'BAD_JSON' } });
    }
    res.status(status).json({
      error: {
        message: status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message,
        code: err.code || (status >= 500 ? 'SERVER_ERROR' : 'ERROR'),
        details: status < 500 ? err.details : undefined,
      },
    });
  });
  return app;
}

async function main() {
  assertConfig();
  if (config.runMigrationsOnStart) await migrate();
  const app = await createApp();
  const server = app.listen(config.port, () => console.log(`[server] listening on :${config.port} (${config.nodeEnv})`));

  // Release expired payment holds regularly.
  const sweeper = setInterval(() => sweepExpiredHolds().catch((e) => console.error('[sweep]', e.message)), 60_000);
  sweeper.unref();

  const shutdown = () => {
    console.log('[server] shutting down');
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
