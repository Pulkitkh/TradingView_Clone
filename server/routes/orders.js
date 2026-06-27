import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '..', 'data', 'orders.json');

const router = Router();

async function loadOrders() {
  const raw = await readFile(DATA_PATH, 'utf-8');
  return JSON.parse(raw);
}

// GET /api/orders?company=&customer=&minOrderSize=
router.get('/', async (req, res) => {
  try {
    let orders = await loadOrders();
    const { company, customer, minOrderSize } = req.query;

    if (company) {
      const c = String(company).toLowerCase();
      orders = orders.filter((o) => o.company.toLowerCase().includes(c));
    }
    if (customer) {
      const c = String(customer).toLowerCase();
      orders = orders.filter((o) => o.customer.toLowerCase().includes(c));
    }
    if (minOrderSize) {
      const min = parseFloat(minOrderSize);
      if (!Number.isNaN(min)) {
        orders = orders.filter((o) => o.orderSizePct >= min);
      }
    }

    orders.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ count: orders.length, orders });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load orders', detail: err.message });
  }
});

// GET /api/orders/facets -> distinct companies & customers for filter dropdowns
router.get('/facets', async (_req, res) => {
  try {
    const orders = await loadOrders();
    const companies = [...new Set(orders.map((o) => o.company))].sort();
    const customers = [
      ...new Set(orders.map((o) => o.customer).filter((c) => c && c !== 'Not mentioned')),
    ].sort();
    res.json({ companies, customers });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load facets', detail: err.message });
  }
});

export default router;
