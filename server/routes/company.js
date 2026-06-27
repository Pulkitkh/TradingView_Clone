import { Router } from 'express';
import { getCompany, searchCompany } from '../services/screener.js';

const router = Router();

// GET /api/company/search?q=...
router.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  try {
    const results = await searchCompany(String(q));
    res.json(results);
  } catch (err) {
    res.status(502).json({ error: 'Search failed', detail: err.message });
  }
});

// GET /api/company/:symbol?consolidated=true|false
router.get('/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const consolidated = req.query.consolidated !== 'false';
  try {
    const data = await getCompany(symbol, consolidated);
    res.json(data);
  } catch (err) {
    const status = err.status === 404 ? 404 : 502;
    res
      .status(status)
      .json({ error: 'Failed to fetch company data', detail: err.message });
  }
});

export default router;
