import express from 'express';
import cors from 'cors';
import ordersRouter from './routes/orders.js';
import companyRouter from './routes/company.js';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/orders', ordersRouter);
app.use('/api/company', companyRouter);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
