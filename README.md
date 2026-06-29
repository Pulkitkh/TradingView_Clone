# Company Data — Real-time Order Tracking

A clone of [FinanciallyFree's Order Tracking tool](https://www.financiallyfree.in/tools/order-tracking).
It runs a **continuous pipeline** that watches NSE for new order/contract
awards, reads the **structured XBRL** each company files, enriches it with
company financials, and streams it to a live dashboard — newest on top. The
loop runs forever. Optionally it also posts each new order to **Telegram**.

Company financials are sourced live from [Screener.in](https://www.screener.in).

## How the pipeline works

```
        ┌──────────────────────────┐  poll every N sec
        │ NSE XBRL feeds            │  /api/XBRL-announcements?type=para-b
        │ para-b (live) + award     │  + ...&type=award  → keep records whose
        │ filter eventType = order  │     eventType is an order, each w/ `xbrl`
        └────────────┬─────────────┘
                     ▼
        ┌──────────────────────────┐  fetch + parse the XBRL XML →
        │ structured fields         │  AmountOfTheOrdersOrContracts (value),
        │ (nseAward.js)             │  counterparty, date, nature, duration…
        └────────────┬─────────────┘  NO PDF, NO AI for the core fields
                     ▼
        ┌──────────────────────────┐  Screener → annual revenue
        │ enrich + compute          │  → Order Size % = value / revenue
        └────────────┬─────────────┘
                     ▼
        ┌──────────────────────────┐  dedupe, persist, newest-first
        │ order store               │──► SSE stream ──► dashboard (LIVE)
        └──────────────────────────┘──► Telegram alert (optional)
```

NSE publishes order awards as **machine-readable XBRL** with the value tagged as
`AmountOfTheOrdersOrContracts` (in rupees ÷ 1e7 = crore), plus the counterparty,
date, nature and execution period. So the core fields are read **directly from
the filing — no PDF parsing and no AI.** (Endpoint + taxonomy courtesy of a
working poller script.)

- **Order feeds:** NSE merged the dedicated "Awarding/Bagging of Orders" event
  into **Para B** of Schedule III (effective 20-Jun-2026), so orders now arrive
  in `type=para-b` mixed with other material events. We poll `para-b` (live) and
  the legacy `award` feed, and keep only records whose **`eventType`** is an
  order — e.g. *"Bagging/Receiving of orders/contracts (Sub-para 4-Para B)"* or
  *"Awarding of order(s)/contract(s)"*. On a real sample this kept 40/83 para-b
  records with **0 non-order leaks**. The order XBRL is unchanged, so the same
  parser reads the value/customer/date.
- **Sanity check:** a few filings mis-enter the value (wrong unit). If the XBRL
  amount is implausibly large (> ₹100,000 Cr) it's flagged ⚠ in the UI and the
  value is recovered from the free-text description when possible.
- **Rare fallback:** if the XBRL amount is blank, a free regex over the
  description runs, then — only if `ANTHROPIC_API_KEY` is set — AI on the PDF.
  In practice the XBRL provides the value, so **AI almost never runs.**

> An earlier version classified the generic `corporate-announcements` feed and
> read values from the PDF (regex, then AI). That code still ships
> (`services/nse.js`, `pdf.js`, `extract.js`) as a fallback, but the XBRL award
> feed supersedes it — it's order-only and already structured.

#### Getting past Akamai

NSE sits behind Akamai bot protection that **fingerprints the TLS handshake**,
so a plain Node `fetch` can get `403` even with perfect headers (curl, real
browsers and Python `requests` pass). `services/browserFetch.js` therefore falls
back to fetching through a real browser engine when fetch is blocked — running
same-origin API calls *inside* a navigated page and opening archive files
(XBRL/PDF) as page navigations.

- Install the optional fallback: `npm i playwright && npx playwright install chromium`
- It only activates on a `403`; otherwise plain fetch is used. From a host whose
  IP isn't fingerprint-blocked (e.g. many India IPs), plain fetch just works.
- Env: `PLAYWRIGHT_MODULE` (module path, default `playwright`) and
  `PLAYWRIGHT_CHROMIUM_PATH` (browser binary) if your install is non-standard.

#### Telegram alerts (optional)

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` and every new order is also
posted to your channel/chat (`services/telegram.js`). Leave them unset to
disable.

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
| `ANTHROPIC_API_KEY` | — | Enables the rare AI fallback (only when XBRL value is blank). |
| `EXTRACTION_MODEL` | `claude-sonnet-4-6` | Model used for the AI fallback. |
| `POLL_INTERVAL_MS` | `60000` | How often to poll the award feed. |
| `DISABLE_POLLER` | `false` | Set `true` to run the API without the loop. |
| `TELEGRAM_BOT_TOKEN` | — | Enables Telegram alerts (with chat id). |
| `TELEGRAM_CHAT_ID` | — | Target channel/chat for alerts. |
| `PLAYWRIGHT_MODULE` | `playwright` | Module path for the browser-fetch fallback. |
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
