# Company Data — Order Tracking

A clone of [FinanciallyFree's Order Tracking tool](https://www.financiallyfree.in/tools/order-tracking),
built as a full-stack app. It shows a filterable feed of company order
announcements, and lets you drill into any company to see full financials
sourced **live from [Screener.in](https://www.screener.in)**.

## Features

- **Order Tracking dashboard** — dark-themed table matching the original:
  Company, Customer, Order Type, Date, Contract Value, Duration, Annual Value,
  Order Size %, Company Revenue and a link to the source PDF.
- **Filters** — by company, customer, and minimum order size %.
- **Company detail page** — click any company to load live data from Screener:
  key ratios (Market Cap, P/E, ROCE, ROE…), pros & cons, and full financial
  tables (Quarterly Results, P&L, Balance Sheet, Cash Flow, Ratios,
  Shareholding Pattern).
- **Server-side scraping + caching** of Screener (30-min in-memory cache) so
  the same company isn't re-fetched on every view.

## Tech stack

- **Frontend:** React + Vite + React Router
- **Backend:** Node.js + Express, with Cheerio for parsing Screener pages
- **Data:**
  - Orders → seeded sample dataset in `server/data/orders.json`
    (the original extracts these from filing PDFs via a proprietary AI pipeline,
    which can't be replicated; swap this file for a real feed when available).
  - Company financials → fetched live from Screener.in.

## Project layout

```
.
├── server/                 # Express API
│   ├── index.js
│   ├── data/orders.json    # sample order feed
│   ├── routes/             # /api/orders, /api/company
│   └── services/screener.js# Screener scraper + cache
└── client/                 # React + Vite frontend
    └── src/
        ├── pages/          # OrdersPage, CompanyPage
        ├── components/
        └── api/client.js
```

## Getting started

```bash
# from the repo root — installs root, server, and client deps
npm run install:all

# run backend (port 4000) + frontend (port 5173) together
npm run dev
```

Then open http://localhost:5173.

To run them separately:

```bash
npm run dev --prefix server   # API on :4000
npm run dev --prefix client   # Vite dev server on :5173 (proxies /api → :4000)
```

## API

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| GET | `/api/orders?company=&customer=&minOrderSize=` | Filtered order feed |
| GET | `/api/orders/facets` | Distinct companies/customers for dropdowns |
| GET | `/api/company/:symbol?consolidated=true` | Live company data from Screener |
| GET | `/api/company/search?q=` | Resolve a name/symbol to a Screener company |

## Notes & next steps

- Order data is sample data. To make it real, replace `server/data/orders.json`
  with a live source (BSE/NSE announcements + an extraction step), keeping the
  same shape.
- Screener has no public API; scraping is best-effort and depends on their page
  markup. The parser is isolated in `server/services/screener.js`, and responses
  are cached to be polite.
