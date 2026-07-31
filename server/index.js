import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import express from 'express';
import compression from 'compression';
import cors from 'cors';
import ordersRouter from './routes/orders.js';
import companyRouter from './routes/company.js';
import * as store from './services/orderStore.js';
import { startPoller } from './services/poller.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';

app.set('trust proxy', 1); // behind nginx/Cloudflare
app.use(compression());
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/orders', ordersRouter);
app.use('/api/company', companyRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// In production, serve the built SPA from the same origin as the API, so the
// deployed site needs no CORS, no dev proxy, and no API base URL config.
const CLIENT_DIST = path.resolve(__dirname, '../client/dist');
if (fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
  // Hashed assets are immutable; index.html must never be cached or users get
  // a stale bundle after a deploy.
  app.use(
    express.static(CLIENT_DIST, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
        else if (/[.-][0-9a-zA-Z_]{8,}\.(js|css|woff2?|png|svg|jpg)$/.test(filePath))
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    })
  );
  // SPA fallback: every non-API route renders the app (deep links work).
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
  console.log(`[web] serving client build from ${CLIENT_DIST}`);
} else {
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  console.log('[web] no client build found — API only (run: npm run build)');
}

// Boot: load persisted orders first so the site shows data immediately on open,
// even before the first poll of this process completes.
await store.init();
const server = app.listen(PORT, HOST, () => {
  console.log(
    `Server listening on http://${HOST}:${PORT} (${store.getAll().length} orders loaded)`
  );
});
server.keepAliveTimeout = 65_000; // > typical proxy idle timeout, keeps SSE alive
server.headersTimeout = 70_000;

if (process.env.DISABLE_POLLER !== 'true') {
  startPoller();
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`\n[server] ${sig} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
