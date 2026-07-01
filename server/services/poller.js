// The "forever loop": polls NSE (structured XBRL) and BSE (headline/PDF regex)
// for new order/contract wins, enriches each with company revenue, dedupes
// across exchanges, and pushes them into the store (newest-first). SSE + optional
// Telegram fan them out.
//
// NSE path: value/customer/date come straight from the award XBRL — no AI.
// BSE path: BSE has no structured value, so we extract via the regex tier
//   (headline → PDF text), with optional AI only if a key is set.

import {
  fetchOrderFilings as fetchNseOrders,
  normalizeFeed,
  parseAwardXbrl,
  cleanEventType,
} from './nseAward.js';
import { fetchOrderFilings as fetchBseOrders } from './bse.js';
import { pdfTextFromUrl } from './pdf.js';
import { extractOrder, extractorMode } from './extract.js';
import { getAnnualRevenue } from './screener.js';
import { sendOrderAlert, telegramEnabled } from './telegram.js';
import * as store from './orderStore.js';

const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000);
const BSE_ENABLED = process.env.DISABLE_BSE !== 'true';

const processed = new Set(); // filing IDs already evaluated (either exchange)
const dupeKeys = new Set(); // cross-exchange dedupe: company|value|day
let running = false;
let firstRun = true;
let stats = {
  polls: 0,
  filingsSeen: 0,
  ordersFound: 0,
  lastPollAt: null,
  lastError: null,
  bySource: { NSE: 0, BSE: 0 },
};

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Exchange timestamps are IST. Return an ISO string carrying the +05:30 offset
// so the calendar date never drifts when the browser renders it.
function parseDate(s) {
  if (!s) return new Date().toISOString();
  // NSE broadcast "24-Jun-2026 13:26:00" (IST).
  const m = String(s).match(/(\d{1,2})-(\w{3})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
  if (m) {
    const [, d, mon, y, hh = '00', mm = '00', ss = '00'] = m;
    const mo = String((MONTHS[mon.toLowerCase()] ?? 0) + 1).padStart(2, '0');
    const dd = String(+d).padStart(2, '0');
    return `${y}-${mo}-${dd}T${hh.padStart(2, '0')}:${mm}:${ss}+05:30`;
  }
  // ISO date/datetime ("2026-06-24" or "2026-07-01T14:38:37", BSE) — treat as IST.
  const iso = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?/);
  if (iso) {
    const [, y, mo, d, hh = '00', mm = '00', ss = '00'] = iso;
    return `${y}-${mo}-${d}T${hh}:${mm}:${ss}+05:30`;
  }
  return new Date().toISOString();
}

// Shared tail: enrich a candidate with revenue, dedupe, store, alert.
// candidate: { id, source, symbol, company, customer, orderType, contractValueCr,
//              duration, date, awardDate, pdfUrl, summary, flag }
async function enrichAndStore(c) {
  if (processed.has(c.id) || store.has(c.id)) return;
  processed.add(c.id);
  stats.filingsSeen++;

  // Cross-exchange dedupe: the same order is often filed on both NSE and BSE.
  if (c.contractValueCr != null) {
    const key = `${c.company.toLowerCase().replace(/\s+/g, ' ').trim()}|${c.contractValueCr}|${String(c.date).slice(0, 10)}`;
    if (dupeKeys.has(key)) return;
    dupeKeys.add(key);
  }

  // Enrich with annual revenue → Order Size %. NSE gives a ticker; BSE gives a
  // name — Screener resolves both.
  let companyRevenueCr = null;
  let revenueFy = null;
  const lookup = c.symbol || c.company;
  if (lookup) {
    const rev = await getAnnualRevenue(lookup);
    if (rev) {
      companyRevenueCr = rev.revenueCr;
      revenueFy = rev.fy;
    }
  }
  const orderSizePct =
    c.contractValueCr && companyRevenueCr
      ? +((c.contractValueCr / companyRevenueCr) * 100).toFixed(2)
      : null;

  const order = {
    id: c.id,
    company: c.company,
    symbol: c.symbol || null,
    // used by the UI to link to Screener (ticker if we have it, else name)
    screenerQuery: c.symbol || c.company,
    customer: c.customer || 'Not mentioned',
    orderType: c.orderType || 'Not mentioned',
    date: c.date,
    awardDate: c.awardDate || null,
    contractValueCr: c.contractValueCr ?? null,
    duration: c.duration || 'Not mentioned',
    annualValueCr: c.contractValueCr ?? null,
    orderSizePct,
    companyRevenueCr,
    revenueFy,
    pdfUrl: c.pdfUrl || null,
    summary: c.summary || null,
    source: c.source,
    _flag: c.flag || null,
  };

  const added = await store.add(order);
  if (added) {
    stats.ordersFound++;
    stats.bySource[c.source] = (stats.bySource[c.source] || 0) + 1;
    console.log(
      `[order] (${c.source}) ${order.company} — ${order.contractValueCr ?? '?'} Cr — ${order.customer}`
    );
    await sendOrderAlert(order);
  }
}

// ---- NSE: structured XBRL ----
async function processNse(rec) {
  const filing = normalizeFeed(rec);
  if (processed.has(filing.id) || store.has(filing.id)) return;

  let x = {};
  if (filing.xbrlUrl) {
    try {
      x = await parseAwardXbrl(filing.xbrlUrl);
    } catch (err) {
      x = { _err: err.message };
    }
  }

  let contractValueCr = x.amountCr ?? null;
  let customer = x.counterparty || null;
  let orderType = x.nature || cleanEventType(filing.eventType) || null;
  let duration = x.duration || null;

  if (contractValueCr == null) {
    const getPdf = filing.pdfUrl ? () => pdfTextFromUrl(filing.pdfUrl).catch(() => '') : null;
    const ex = await extractOrder(
      { company: filing.company, headline: x.description || x.nature || '', category: 'award', text: '' },
      getPdf
    );
    contractValueCr = ex.contractValueCr;
    customer = customer || (ex.customer !== 'Not mentioned' ? ex.customer : null);
    orderType = orderType || (ex.orderType !== 'Not mentioned' ? ex.orderType : null);
    duration = duration || (ex.duration !== 'Not mentioned' ? ex.duration : null);
  }

  await enrichAndStore({
    id: filing.id,
    source: 'NSE',
    symbol: filing.symbol,
    company: filing.company,
    customer,
    orderType,
    contractValueCr,
    duration,
    date: parseDate(filing.broadcastDateTime || x.date),
    awardDate: x.date ? parseDate(x.date) : null,
    pdfUrl: filing.pdfUrl,
    summary: x.nature || x.description || null,
    flag: x.flag || null,
  });
}

// ---- BSE: headline/PDF regex ----
async function processBse(filing) {
  if (processed.has(filing.id) || store.has(filing.id)) return;
  const getPdf = filing.pdfUrl ? () => pdfTextFromUrl(filing.pdfUrl).catch(() => '') : null;
  const ex = await extractOrder(
    { company: filing.company, headline: filing.headline, category: filing.category, text: '' },
    getPdf
  );
  await enrichAndStore({
    id: filing.id,
    source: 'BSE',
    symbol: null,
    company: filing.company,
    customer: ex.customer !== 'Not mentioned' ? ex.customer : null,
    orderType: ex.orderType !== 'Not mentioned' ? ex.orderType : null,
    contractValueCr: ex.contractValueCr,
    duration: ex.duration !== 'Not mentioned' ? ex.duration : null,
    date: parseDate(filing.broadcastDateTime),
    pdfUrl: filing.pdfUrl,
    summary: ex.summary || filing.headline || null,
    flag: null,
  });
}

async function pollOnce() {
  stats.polls++;
  stats.lastPollAt = new Date().toISOString();
  const errors = [];

  // NSE
  try {
    const nse = await fetchNseOrders();
    for (const rec of [...nse].reverse()) {
      if (!firstRun && processed.has(String(rec.appId))) continue;
      await processNse(rec);
    }
  } catch (err) {
    errors.push(`NSE: ${err.message}`);
  }

  // BSE (optional)
  if (BSE_ENABLED) {
    try {
      const bse = await fetchBseOrders();
      for (const filing of [...bse].reverse()) {
        if (!firstRun && processed.has(filing.id)) continue;
        await processBse(filing);
      }
    } catch (err) {
      errors.push(`BSE: ${err.message}`);
    }
  }

  if (firstRun) {
    firstRun = false;
    console.log(`[poller] baselined ${stats.ordersFound} existing orders (NSE+BSE)`);
  }
  stats.lastError = errors.length ? errors.join(' | ') : null;
  if (errors.length) console.warn('[poller] poll issues:', stats.lastError);
}

export function getStats() {
  return {
    ...stats,
    source: BSE_ENABLED ? 'NSE (XBRL) + BSE' : 'NSE (XBRL)',
    mode: extractorMode === 'ai-fallback' ? 'xbrl + regex + ai-fallback' : 'xbrl + regex',
    telegram: telegramEnabled,
    pollIntervalMs: POLL_MS,
    running,
  };
}

export function startPoller() {
  if (running) return;
  running = true;
  console.log(
    `[poller] starting — NSE${BSE_ENABLED ? ' + BSE' : ''}, interval ${POLL_MS}ms, telegram:${telegramEnabled}`
  );
  const loop = async () => {
    if (!running) return;
    await pollOnce();
    setTimeout(loop, POLL_MS);
  };
  loop();
}

export function stopPoller() {
  running = false;
}
