import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as store from '../services/orderStore.js';
import { subscribe } from '../services/orderStore.js';
import { getStats } from '../services/poller.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(__dirname, '..', 'data', 'orders.json');

const router = Router();

// Live orders come from the poller's store. Until the first real order lands
// (or if NSE is unreachable from this host), fall back to the seed sample so
// the UI is never empty.
async function loadSeed() {
  try {
    return JSON.parse(await readFile(SEED_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

async function currentOrders() {
  const live = store.getAll();
  if (live.length) return { orders: live, source: 'live' };
  return { orders: await loadSeed(), source: 'seed' };
}

// GET /api/orders?company=&customer=&minOrderSize=
router.get('/', async (req, res) => {
  try {
    let { orders, source } = await currentOrders();
    const { company, customer, minOrderSize } = req.query;

    if (company) {
      const c = String(company).toLowerCase();
      orders = orders.filter((o) => o.company.toLowerCase().includes(c));
    }
    if (customer) {
      const c = String(customer).toLowerCase();
      orders = orders.filter((o) => (o.customer || '').toLowerCase().includes(c));
    }
    if (minOrderSize) {
      const min = parseFloat(minOrderSize);
      if (!Number.isNaN(min)) {
        orders = orders.filter((o) => o.orderSizePct != null && o.orderSizePct >= min);
      }
    }

    orders = [...orders].sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ count: orders.length, source, orders });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load orders', detail: err.message });
  }
});

// GET /api/orders/facets -> distinct companies & customers for filter dropdowns
router.get('/facets', async (_req, res) => {
  try {
    const { orders } = await currentOrders();
    const companies = [...new Set(orders.map((o) => o.company))].sort();
    const customers = [
      ...new Set(
        orders.map((o) => o.customer).filter((c) => c && c !== 'Not mentioned')
      ),
    ].sort();
    res.json({ companies, customers });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load facets', detail: err.message });
  }
});

// GET /api/orders/stats -> live pipeline status
router.get('/stats', (_req, res) => {
  res.json(getStats());
});

// GET /api/orders/stream -> Server-Sent Events; pushes each new order live.
router.get('/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  res.write(`event: ping\ndata: connected\n\n`);

  const unsub = subscribe((order) => {
    res.write(`event: order\ndata: ${JSON.stringify(order)}\n\n`);
  });
  const keepAlive = setInterval(() => res.write(`event: ping\ndata: 1\n\n`), 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsub();
  });
});

export default router;
