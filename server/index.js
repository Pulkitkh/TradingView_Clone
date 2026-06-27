import express from 'express';
import cors from 'cors';
import ordersRouter from './routes/orders.js';
import companyRouter from './routes/company.js';
import * as store from './services/orderStore.js';
import { startPoller } from './services/poller.js';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/orders', ordersRouter);
app.use('/api/company', companyRouter);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Boot: load persisted orders, then start the live ingestion loop.
await store.init();
app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});

if (process.env.DISABLE_POLLER !== 'true') {
  startPoller();
}
