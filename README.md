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
     type from the announcement text. Covers the ~1 in 6 filings that state the
     value inline.
  3. **PDF-text regex (no AI):** for filings still missing a value, download the
     PDF and run the same regex over its text. On a real 24-filing sample this
     lifted no-AI value coverage from **~17% to ~58%** (and recovered duration
     for most of the rest) — all without spending a single AI token.
  4. **AI on PDF (only if needed):** when a value is *still* missing *and*
     `ANTHROPIC_API_KEY` is set, Claude extracts the remaining fields from the
     PDF text. Only ~40% of filings reach this step, vs ~83% before.

  Without a key, every order is still ingested — the few filings whose PDF text
  didn't yield a value show "Not mentioned" (exactly like the real site).

  > **Why not skip PDFs with NSE's XBRL?** Investigated and ruled out: the
  > announcements API doesn't expose the XBRL URL, and NSE's order XBRL tags the
  > monetary value inconsistently. The PDF is the only reliable source — but
  > tier 3 reads it with *regex*, so AI stays a rare fallback.

#### Getting past Akamai (PDF downloads)

NSE/`nsearchives` sits behind Akamai bot protection that **fingerprints the TLS
handshake**, so a plain Node `fetch` can get `403` even with perfect headers
(curl and real browsers pass). `services/pdf.js` therefore falls back to
downloading through a real browser engine when fetch is blocked:

- Install the optional fallback: `npm i playwright && npx playwright install chromium`
- It activates automatically only when a download 403s; otherwise plain fetch is
  used. If Playwright isn't installed, those filings just stay value-less.
- Env: `PLAYWRIGHT_MODULE` (module path, default `playwright`) and
  `PLAYWRIGHT_CHROMIUM_PATH` (browser binary) if your install is non-standard.

From an India-based host you may not be fingerprint-blocked at all, in which case
plain fetch works and the fallback never fires.
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
| `ANTHROPIC_API_KEY` | — | Enables the AI fallback (tier 4). Without it, category + headline/PDF regex only. |
| `EXTRACTION_MODEL` | `claude-sonnet-4-6` | Model used for the AI fallback. |
| `POLL_INTERVAL_MS` | `60000` | How often to poll the exchange feed. |
| `DISABLE_POLLER` | `false` | Set `true` to run the API without the loop. |
| `PLAYWRIGHT_MODULE` | `playwright` | Module path for the browser-download fallback. |
| `PLAYWRIGHT_CHROMIUM_PATH` | — | Chromium binary path, if non-standard. |
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
