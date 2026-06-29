// The "forever loop": polls NSE for new filings, classifies + extracts orders
// with AI, enriches them with company revenue, and pushes them into the store
// (newest-first). Designed to run continuously on an always-on server.

import { fetchAnnouncements, normalize } from './nse.js';
import { pdfTextFromUrl } from './pdf.js';
import { extractOrder, isOrderFiling, extractorMode } from './extract.js';
import { getAnnualRevenue } from './screener.js';
import * as store from './orderStore.js';

const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000);
const processed = new Set(); // filing ids we've already evaluated (order or not)
let running = false;
let stats = { polls: 0, filingsSeen: 0, ordersFound: 0, lastPollAt: null, lastError: null };

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseNseDate(s) {
  // "27-Jun-2026 22:59:30" -> ISO
  const m = String(s || '').match(/(\d{1,2})-(\w{3})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
  if (!m) return new Date().toISOString();
  const [, d, mon, y, hh = '0', mm = '0', ss = '0'] = m;
  const dt = new Date(Date.UTC(+y, MONTHS[mon.toLowerCase()] ?? 0, +d, +hh, +mm, +ss));
  return dt.toISOString();
}

async function processFiling(filing) {
  if (processed.has(filing.id) || store.has(filing.id)) return;
  processed.add(filing.id);
  stats.filingsSeen++;

  // Tier 1: classify by NSE category — no AI, no PDF download for non-orders.
  if (!isOrderFiling(filing)) return;

  // Tiers 2 & 3 live in extractOrder. The PDF is fetched lazily (only if the
  // headline lacked a value and AI fallback is enabled), via this callback.
  const getPdfText = filing.pdfUrl
    ? () => pdfTextFromUrl(filing.pdfUrl).catch(() => '')
    : null;

  const extracted = await extractOrder(
    {
      company: filing.company,
      headline: filing.headline,
      category: filing.category,
    },
    getPdfText
  );

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
    extracted.contractValueCr && companyRevenueCr
      ? +((extracted.contractValueCr / companyRevenueCr) * 100).toFixed(2)
      : null;

  const order = {
    id: filing.id,
    company: filing.company,
    symbol: filing.symbol,
    customer: extracted.customer,
    orderType: extracted.orderType,
    date: parseNseDate(filing.announcedAt),
    contractValueCr: extracted.contractValueCr,
    duration: extracted.duration,
    annualValueCr: extracted.annualValueCr,
    orderSizePct,
    companyRevenueCr,
    revenueFy,
    pdfUrl: filing.pdfUrl,
    summary: extracted.summary,
    extractedBy: extracted._extractedBy,
    source: 'NSE',
  };

  const added = await store.add(order);
  if (added) {
    stats.ordersFound++;
    console.log(`[order] ${order.company} — ${order.contractValueCr ?? '?'} Cr — ${order.summary || ''}`);
  }
}

async function pollOnce() {
  stats.polls++;
  stats.lastPollAt = new Date().toISOString();
  try {
    const raw = await fetchAnnouncements();
    const filings = raw.map(normalize);
    // Process oldest-first within a batch so newest ends up on top of the store.
    for (const filing of filings.reverse()) {
      await processFiling(filing);
    }
    stats.lastError = null;
  } catch (err) {
    stats.lastError = err.message;
    console.warn('[poller] poll failed:', err.message);
  }
}

export function getStats() {
  return { ...stats, mode: extractorMode, pollIntervalMs: POLL_MS, running };
}

export function startPoller() {
  if (running) return;
  running = true;
  console.log(
    `[poller] starting — source: NSE, extractor: ${extractorMode}, interval: ${POLL_MS}ms`
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
