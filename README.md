# Company Data — Real-time Order Tracking

A clone of [FinanciallyFree's Order Tracking tool](https://www.financiallyfree.in/tools/order-tracking).
It runs a **continuous pipeline** that watches the stock exchange for new
corporate filings, detects the ones announcing an **order/contract win**,
**extracts the details with AI**, enriches them with company financials, and
streams them to a live dashboard — newest on top. The loop runs forever.

Company financials are sourced live from [Screener.in](https://www.screener.in).

## How the pipeline works

```
            ┌─────────────┐   poll every N sec
            │   NSE feed   │  (corporate-announcements API)
            └──────┬───────┘
                   ▼
        ┌──────────────────────┐   keyword/category pre-filter
        │  classify filing     │   ("is this an order?")
        └──────────┬───────────┘
                   ▼ (candidates)
        ┌──────────────────────┐   download PDF → extract text
        │  AI extraction        │   → Claude returns structured JSON:
        │  (extract.js)         │     value, customer, duration, type…
        └──────────┬───────────┘
                   ▼
        ┌──────────────────────┐   Screener → annual revenue
        │  enrich + compute      │   → Order Size % = value / revenue
        └──────────┬───────────┘
                   ▼
        ┌──────────────────────┐   dedupe, persist, newest-first
        │  order store          │──► SSE stream ──► dashboard (LIVE)
        └──────────────────────┘
```

- **Source:** NSE's `corporate-announcements` API (live, with PDF links). BSE
  can be added the same way; its API is geo-restricted to Indian IPs.
- **Tiered extraction** (`server/services/extract.js`) — AI is a last resort,
  not the default:
  1. **Category gate (no AI):** NSE tags order receipts with the category
     `Bagging/Receiving of orders/contracts`. A string match classifies them
     with zero AI and (measured on a real 5-day, 3,600-filing sample)
     **0 false positives**. Non-order filings never get a PDF download.
  2. **Headline parse (no AI):** free regex pulls value / customer / duration /
     type from the announcement text. Covers the filings that state the value
     inline (~1 in 6).
  3. **AI on PDF (only if needed):** when a value is still missing *and*
     `ANTHROPIC_API_KEY` is set, the PDF is downloaded and Claude extracts the
     remaining fields. Most filings never reach this step.

  Without a key, every order is still ingested — filings whose text lacked a
  value simply show "Not mentioned" (exactly like the real site). With a key,
  AI backfills those from the PDF.

  > Why not skip PDFs entirely with NSE's XBRL? Measured reality: only ~17% of
  > order filings put the value in the feed text, and NSE's order XBRL tags the
  > value inconsistently — so the PDF is the only reliable source for the rest.
  > That's why the value extraction is tiered rather than feed-only.
- **Live updates:** new orders are pushed to the browser over **Server-Sent
  Events** (`/api/orders/stream`) and flash in at the top of the table.

## Features

- Dark-themed **Order Tracking dashboard** matching the original: Company,
  Customer, Order Type, Date, Contract Value, Duration, Annual Value,
  Order Size %, Company Revenue, source PDF.
- **Live badge + pipeline status** (feed, extractor mode, last poll time).
- Filters by company, customer, and minimum order size %.
- **Company detail page** — click any company to load live Screener data:
  key ratios, pros/cons, and full Quarterly / P&L / Balance Sheet / Cash Flow /
  Ratios / Shareholding tables.

## Tech stack

- **Frontend:** React + Vite + React Router (EventSource for live updates)
- **Backend:** Node.js + Express; `pdf-parse` for PDF text, `cheerio` for
  Screener, `@anthropic-ai/sdk` for extraction
- **Persistence:** JSON file store (`server/data/live-orders.json`), created at
  runtime; swap for a DB if you want.

## Getting started

```bash
npm run install:all       # root + server + client deps

# (optional but recommended) enable AI extraction
export ANTHROPIC_API_KEY=sk-ant-...
export EXTRACTION_MODEL=claude-sonnet-4-6   # or claude-haiku-4-5 for cheaper/high-volume

npm run dev               # API :4000 (starts the poller) + web :5173
```

Open http://localhost:5173. The dashboard shows **SAMPLE DATA** until the first
real order is ingested, then flips to **LIVE**.

### Environment variables (server)

| Var | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Enables the AI fallback (tier 3). Without it, category + headline parsing only. |
| `EXTRACTION_MODEL` | `claude-sonnet-4-6` | Model used for extraction. |
| `POLL_INTERVAL_MS` | `60000` | How often to poll the exchange feed. |
| `DISABLE_POLLER` | `false` | Set `true` to run the API without the loop. |
| `PORT` | `4000` | API port. |

## API

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| GET | `/api/orders?company=&customer=&minOrderSize=` | Current orders (live, or sample fallback) |
| GET | `/api/orders/stream` | **SSE** — pushes each new order in real time |
| GET | `/api/orders/stats` | Pipeline status (polls, orders found, mode, last error) |
| GET | `/api/orders/facets` | Distinct companies/customers for dropdowns |
| GET | `/api/company/:symbol` | Live company financials from Screener |

## Running it for real (the "forever" part)

- Deploy the server on an **always-on host** (a small VM, Render, Railway,
  Fly.io, etc.) so the poll loop never stops. A laptop works too, as long as
  it stays running.
- **Exchange access:** NSE blocks many datacenter IPs. An **India-based** host
  (or one that can reach `nseindia.com`) is most reliable; the NSE client warms
  up a cookie session and retries with backoff.
- Set `ANTHROPIC_API_KEY` for accurate extraction. Tune `POLL_INTERVAL_MS`
  (e.g. 30–60s) — on trading days there are bursts of filings.
- The store is a JSON file; for production, point it at SQLite/Postgres.

## Notes

- BSE is not wired in by default (its API is geo-restricted from non-India IPs),
  but it slots into the same `fetch → normalize` shape as `services/nse.js`.
- Some filings are scanned-image PDFs with no text layer; with AI extraction you
  can pass the PDF to a vision-capable Claude model to handle those too.
