// The "forever loop": polls NSE's XBRL *award* feed (order/contract awards
// only), reads each order's structured XBRL — value, customer, date, duration,
// nature — enriches it with company revenue, and pushes it into the store
// (newest-first). No PDF parsing or AI is needed for the core fields; the
// award XBRL provides them directly.
//
// Tiered value recovery (rare): if the XBRL amount is blank/suspect, fall back
// to a free regex over the filing's description, then — only if a key is set —
// the AI extractor on the PDF text.

import {
  fetchOrderFilings,
  normalizeFeed,
  parseAwardXbrl,
  cleanEventType,
} from './nseAward.js';
import { pdfTextFromUrl } from './pdf.js';
import { extractOrder, extractorMode } from './extract.js';
import { getAnnualRevenue } from './screener.js';
import { sendOrderAlert, telegramEnabled } from './telegram.js';
import * as store from './orderStore.js';

const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000);
const processed = new Set(); // appIds already evaluated
let running = false;
let firstRun = true;
let stats = {
  polls: 0,
  filingsSeen: 0,
  ordersFound: 0,
  lastPollAt: null,
  lastError: null,
};

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// NSE timestamps are in IST. We return an ISO string carrying the +05:30
// offset so the calendar date never drifts when the browser renders it.
function parseDate(s) {
  if (!s) return new Date().toISOString();
  // NSE broadcast/announcement format "24-Jun-2026 13:26:00" (IST).
  const m = String(s).match(/(\d{1,2})-(\w{3})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
  if (m) {
    const [, d, mon, y, hh = '00', mm = '00', ss = '00'] = m;
    const mo = String((MONTHS[mon.toLowerCase()] ?? 0) + 1).padStart(2, '0');
    const dd = String(+d).padStart(2, '0');
    return `${y}-${mo}-${dd}T${hh.padStart(2, '0')}:${mm}:${ss}+05:30`;
  }
  // ISO date from XBRL ("2026-06-24") — pin to IST midnight, no drift.
  const iso = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}T00:00:00+05:30`;
  return new Date().toISOString();
}

async function processFiling(rec) {
  const filing = normalizeFeed(rec);
  if (processed.has(filing.id) || store.has(filing.id)) return;
  processed.add(filing.id);
  stats.filingsSeen++;

  // Primary: structured fields straight from the award XBRL.
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
  const flag = x.flag || null;

  // Fallback only if the XBRL didn't give a value: free regex over the
  // description, then optional AI on the PDF.
  if (contractValueCr == null) {
    const getPdf = filing.pdfUrl
      ? () => pdfTextFromUrl(filing.pdfUrl).catch(() => '')
      : null;
    const extracted = await extractOrder(
      {
        company: filing.company,
        headline: x.description || x.nature || '',
        category: 'award',
        text: '',
      },
      getPdf
    );
    contractValueCr = extracted.contractValueCr;
    customer = customer || (extracted.customer !== 'Not mentioned' ? extracted.customer : null);
    orderType = orderType || (extracted.orderType !== 'Not mentioned' ? extracted.orderType : null);
    duration = duration || (extracted.duration !== 'Not mentioned' ? extracted.duration : null);
  }

  // Enrich with annual revenue to compute order size %.
  let companyRevenueCr = null;
  let revenueFy = null;
  if (filing.symbol) {
    const rev = await getAnnualRevenue(filing.symbol);
    if (rev) {
      companyRevenueCr = rev.revenueCr;
      revenueFy = rev.fy;
    }
  }
  const orderSizePct =
    contractValueCr && companyRevenueCr
      ? +((contractValueCr / companyRevenueCr) * 100).toFixed(2)
      : null;

  const order = {
    id: filing.id,
    company: filing.company,
    symbol: filing.symbol,
    customer: customer || 'Not mentioned',
    orderType: orderType || 'Not mentioned',
    // "Date" = when the market learned of it (announcement/dissemination),
    // matching how the exchanges and comparable trackers show it. The XBRL
    // order-received date is kept separately.
    date: parseDate(filing.broadcastDateTime || x.date),
    awardDate: x.date ? parseDate(x.date) : null,
    contractValueCr,
    duration: duration || 'Not mentioned',
    annualValueCr: contractValueCr,
    orderSizePct,
    companyRevenueCr,
    revenueFy,
    pdfUrl: filing.pdfUrl,
    summary: x.nature || x.description || null,
    source: 'NSE-XBRL',
    _flag: flag,
  };

  const added = await store.add(order);
  if (added) {
    stats.ordersFound++;
    console.log(`[order] ${order.company} — ${order.contractValueCr ?? '?'} Cr — ${order.customer}`);
    await sendOrderAlert(order);
  }
}

async function pollOnce() {
  stats.polls++;
  stats.lastPollAt = new Date().toISOString();
  try {
    const feed = await fetchOrderFilings();

    if (firstRun) {
      // Baseline the existing backlog without alert spam, but DO ingest them
      // so the dashboard isn't empty on first boot.
      firstRun = false;
      for (const rec of [...feed].reverse()) await processFiling(rec);
      console.log(`[poller] baselined ${stats.ordersFound} existing orders`);
    } else {
      const fresh = feed.filter((r) => !processed.has(String(r.appId)));
      for (const rec of fresh.reverse()) await processFiling(rec);
    }
    stats.lastError = null;
  } catch (err) {
    stats.lastError = err.message;
    console.warn('[poller] poll failed:', err.message);
  }
}

export function getStats() {
  return {
    ...stats,
    source: 'NSE XBRL para-b + award',
    mode: extractorMode === 'ai-fallback' ? 'xbrl + ai-fallback' : 'xbrl (structured)',
    telegram: telegramEnabled,
    pollIntervalMs: POLL_MS,
    running,
  };
}

export function startPoller() {
  if (running) return;
  running = true;
  console.log(
    `[poller] starting — NSE XBRL award feed, interval ${POLL_MS}ms, telegram:${telegramEnabled}`
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
