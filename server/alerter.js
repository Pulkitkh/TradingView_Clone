// Standalone Telegram order alerter.
//
// A separate program from the website: it polls NSE + BSE for new order wins
// and posts each one to a Telegram group in real time. It shares the fetch and
// parse services with the site but keeps its OWN state, so the two can run
// independently (or on different machines) without interfering.
//
// Run:  node --env-file=server/.env server/alerter.js
//       npm run alert
//
// Required env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//
// Duplicate protection (see services/alertDedupe.js):
//   • filing id      — same filing seen in a later poll
//   • fingerprint    — same order filed on BOTH NSE and BSE, or re-filed
//   • in-flight lock — overlapping polls can't send the same order twice
//   • persisted      — a restart does not re-alert what was already sent
//   • first run baselines the existing backlog silently (ALERT_BACKLOG=true
//     to send it instead)

import { pathToFileURL } from 'node:url';
import {
  fetchOrderFilings as fetchNseOrders,
  normalizeFeed,
  parseAwardXbrl,
  cleanEventType,
} from './services/nseAward.js';
import { fetchOrderFilings as fetchBseOrders } from './services/bse.js';
import { pdfTextFromUrl } from './services/pdf.js';
import { extractOrder } from './services/extract.js';
import { getAnnualRevenue } from './services/screener.js';
import * as dedupe from './services/alertDedupe.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const POLL_MS = Number(process.env.ALERT_POLL_MS || process.env.POLL_INTERVAL_MS || 60_000);
const SEND_GAP_MS = Number(process.env.ALERT_SEND_GAP_MS || 3500); // Telegram: ~20 msg/min/group
const SEND_BACKLOG = process.env.ALERT_BACKLOG === 'true';
const BSE_ENABLED = process.env.DISABLE_BSE !== 'true';
const MIN_VALUE_CR = Number(process.env.ALERT_MIN_VALUE_CR || 0); // 0 = alert everything
const MAX_PER_POLL = Number(process.env.ALERT_MAX_PER_POLL || 15); // flood guard; 0 = unlimited

let firstRun = true;
let running = true;
const stats = { polls: 0, seen: 0, sent: 0, skipped: 0, failed: 0, lastPollAt: null };

// ---------- formatting ----------

const IST = 'Asia/Kolkata';
const fmtCr = (v) =>
  v == null ? null : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`;
const fmtDateTime = (iso) =>
  new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: IST,
  });

// HTML parse mode: only these three need escaping, which is far safer than
// Markdown against company names full of (), -, ., & etc.
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

export function formatAlert(o) {
  const head = `🚨 <b>NEW ORDER — ${esc(o.company)}</b>${o.symbol ? ` (${esc(o.symbol)})` : ''}`;
  const lines = [head, `<i>${esc(o.source)} • ${esc(fmtDateTime(o.date))} IST</i>`, ''];

  if (o.contractValueCr != null) lines.push(`💰 <b>Value:</b> ${esc(fmtCr(o.contractValueCr))}`);
  else lines.push('💰 <b>Value:</b> not disclosed in filing');

  if (o.orderSizePct != null) {
    const bar = o.orderSizePct >= 25 ? '🟢' : o.orderSizePct >= 5 ? '🟡' : '⚪';
    lines.push(
      `${bar} <b>Order size:</b> ${o.orderSizePct}% of revenue` +
        (o.companyRevenueCr ? ` (rev ${esc(fmtCr(o.companyRevenueCr))}${o.revenueFy ? ` ${esc(o.revenueFy)}` : ''})` : '')
    );
  }
  if (o.customer && o.customer !== 'Not mentioned')
    lines.push(`🏢 <b>Customer:</b> ${esc(clip(o.customer, 120))}`);
  if (o.orderType && o.orderType !== 'Not mentioned')
    lines.push(`📦 <b>Nature:</b> ${esc(clip(o.orderType, 300))}`);
  if (o.duration && o.duration !== 'Not mentioned')
    lines.push(`⏳ <b>Duration:</b> ${esc(clip(o.duration, 120))}`);
  if (o.awardDate && String(o.awardDate).slice(0, 10) !== String(o.date).slice(0, 10))
    lines.push(`📅 <b>Order received:</b> ${esc(String(o.awardDate).slice(0, 10))}`);
  if (o._flag) lines.push(`\n⚠️ <i>${esc(o._flag)}</i>`);
  if (o.pdfUrl) lines.push(`\n📄 <a href="${esc(o.pdfUrl)}">Filing</a>`);
  return lines.join('\n');
}

// ---------- telegram send (queued + rate-limit aware) ----------

let lastSendAt = 0;
async function sendMessage(text) {
  const wait = lastSendAt + SEND_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  for (let attempt = 1; attempt <= 3; attempt++) {
    lastSendAt = Date.now();
    let res;
    try {
      res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    if (res.ok) return true;

    const body = await res.text().catch(() => '');
    if (res.status === 429) {
      // Telegram tells us exactly how long to back off.
      let retryAfter = 5;
      try {
        retryAfter = JSON.parse(body)?.parameters?.retry_after ?? 5;
      } catch {
        /* default */
      }
      console.warn(`[telegram] rate limited, waiting ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      continue;
    }
    if (res.status >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw new Error(`telegram ${res.status}: ${body.slice(0, 160)}`);
  }
  return false;
}

// ---------- shared date parsing ----------

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseDate(s) {
  if (!s) return new Date().toISOString();
  const m = String(s).match(/(\d{1,2})-(\w{3})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
  if (m) {
    const [, d, mon, y, hh = '00', mm = '00', ss = '00'] = m;
    const mo = String((MONTHS[mon.toLowerCase()] ?? 0) + 1).padStart(2, '0');
    return `${y}-${mo}-${String(+d).padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}:${ss}+05:30`;
  }
  const iso = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?/);
  if (iso) {
    const [, y, mo, d, hh = '00', mm = '00', ss = '00'] = iso;
    return `${y}-${mo}-${d}T${hh}:${mm}:${ss}+05:30`;
  }
  return new Date().toISOString();
}

// ---------- collect orders from both exchanges ----------

async function collectNse() {
  const out = [];
  const feed = await fetchNseOrders();
  for (const rec of feed) {
    const filing = normalizeFeed(rec);
    // Cheap id check BEFORE fetching the XBRL — avoids re-downloading documents
    // for filings we've already alerted on.
    if (dedupe.alreadyAlerted({ id: filing.id, company: filing.company })) continue;

    let x = {};
    if (filing.xbrlUrl) {
      try {
        x = await parseAwardXbrl(filing.xbrlUrl);
      } catch {
        x = {};
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

    out.push({
      id: filing.id,
      source: 'NSE',
      symbol: filing.symbol,
      company: filing.company,
      customer,
      orderType,
      duration,
      contractValueCr,
      date: parseDate(filing.broadcastDateTime || x.date),
      awardDate: x.date ? parseDate(x.date) : null,
      pdfUrl: filing.pdfUrl,
      _flag: x.flag || null,
    });
  }
  return out;
}

async function collectBse() {
  const out = [];
  const feed = await fetchBseOrders();
  for (const filing of feed) {
    if (dedupe.alreadyAlerted({ id: filing.id, company: filing.company })) continue;
    const getPdf = filing.pdfUrl ? () => pdfTextFromUrl(filing.pdfUrl).catch(() => '') : null;
    const ex = await extractOrder(
      { company: filing.company, headline: filing.headline, category: filing.category, text: '' },
      getPdf
    );
    out.push({
      id: filing.id,
      source: 'BSE',
      symbol: null,
      company: filing.company,
      customer: ex.customer !== 'Not mentioned' ? ex.customer : null,
      orderType: ex.orderType !== 'Not mentioned' ? ex.orderType : null,
      duration: ex.duration !== 'Not mentioned' ? ex.duration : null,
      contractValueCr: ex.contractValueCr,
      date: parseDate(filing.broadcastDateTime),
      awardDate: null,
      pdfUrl: filing.pdfUrl,
      _flag: null,
    });
  }
  return out;
}

async function enrich(o) {
  const lookup = o.symbol || o.company;
  if (lookup) {
    try {
      const rev = await getAnnualRevenue(lookup);
      if (rev) {
        o.companyRevenueCr = rev.revenueCr;
        o.revenueFy = rev.fy;
        if (o.contractValueCr && rev.revenueCr) {
          o.orderSizePct = +((o.contractValueCr / rev.revenueCr) * 100).toFixed(2);
        }
      }
    } catch {
      /* revenue is a nice-to-have; never block an alert on it */
    }
  }
  return o;
}

// ---------- poll loop ----------

/**
 * First-run baseline: record what already exists WITHOUT parsing it. We only
 * need ids here, so we skip every XBRL/PDF download — otherwise a cold start
 * would fetch hundreds of documents and hammer the exchanges for filings we
 * are not going to post anyway.
 */
async function baselineSilently() {
  let n = 0;
  try {
    for (const rec of await fetchNseOrders()) {
      const f = normalizeFeed(rec);
      dedupe.markSeenSilently({ id: f.id, company: f.company, date: parseDate(f.broadcastDateTime) });
      n++;
    }
  } catch (err) {
    console.warn('[alerter] NSE baseline:', err.message);
  }
  if (BSE_ENABLED) {
    try {
      for (const f of await fetchBseOrders()) {
        dedupe.markSeenSilently({
          id: f.id,
          company: f.company,
          date: parseDate(f.broadcastDateTime),
        });
        n++;
      }
    } catch (err) {
      console.warn('[alerter] BSE baseline:', err.message);
    }
  }
  await dedupe.save();
  return n;
}

async function pollOnce() {
  stats.polls++;
  stats.lastPollAt = new Date().toISOString();

  if (firstRun && !SEND_BACKLOG) {
    firstRun = false;
    const n = await baselineSilently();
    console.log(
      `[alerter] baselined ${n} existing filings silently ` +
        `(set ALERT_BACKLOG=true to post them). Now watching for new orders.`
    );
    return;
  }
  firstRun = false;

  const collected = [];
  try {
    collected.push(...(await collectNse()));
  } catch (err) {
    console.warn('[alerter] NSE:', err.message);
  }
  if (BSE_ENABLED) {
    try {
      collected.push(...(await collectBse()));
    } catch (err) {
      console.warn('[alerter] BSE:', err.message);
    }
  }

  // Oldest first, so the group reads chronologically.
  collected.sort((a, b) => new Date(a.date) - new Date(b.date));
  stats.seen += collected.length;

  // Safety valve: if something upstream ever floods (e.g. a feed re-issues ids),
  // cap how many messages one cycle can post to the group.
  const batch = MAX_PER_POLL > 0 ? collected.slice(0, MAX_PER_POLL) : collected;
  if (batch.length < collected.length) {
    console.warn(
      `[alerter] ${collected.length} new orders this poll — posting ${batch.length}, rest next cycle`
    );
  }

  for (const raw of batch) {
    if (!dedupe.claim(raw)) {
      stats.skipped++;
      continue;
    }
    try {
      const o = await enrich(raw);
      if (MIN_VALUE_CR > 0 && (o.contractValueCr ?? 0) < MIN_VALUE_CR) {
        dedupe.markAlerted(o); // below threshold: record so we don't re-evaluate
        stats.skipped++;
        continue;
      }
      await sendMessage(formatAlert(o));
      dedupe.markAlerted(o);
      stats.sent++;
      console.log(
        `[sent] (${o.source}) ${o.company} — ${o.contractValueCr ?? '?'} Cr — ${o.customer ?? '?'}`
      );
    } catch (err) {
      dedupe.release(raw); // let a later poll retry it
      stats.failed++;
      console.warn(`[alerter] send failed for ${raw.company}: ${err.message}`);
    }
  }
  await dedupe.save();
}

async function main() {
  const loaded = await dedupe.init();
  console.log(
    `[alerter] starting — NSE${BSE_ENABLED ? ' + BSE' : ''}, poll ${POLL_MS}ms, ` +
      `dedupe loaded ${loaded.ids} ids / ${loaded.prints} fingerprints`
  );
  if (loaded.ids > 0) firstRun = false; // returning run: alert anything genuinely new

  while (running) {
    try {
      await pollOnce();
    } catch (err) {
      console.error('[alerter] poll error:', err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// Only start the loop when run directly, so this module can also be imported
// (tests, or to reuse the formatter) without launching a poller.
const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  if (!TOKEN || !CHAT_ID) {
    console.error('FATAL: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set (see .env.example).');
    process.exit(1);
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      console.log(
        `\n[alerter] ${sig} — saving state (sent ${stats.sent}, skipped ${stats.skipped})`
      );
      running = false;
      try {
        await dedupe.save();
      } catch {
        /* best effort */
      }
      process.exit(0);
    });
  }

  main().catch((err) => {
    console.error('[alerter] fatal:', err);
    process.exit(1);
  });
}
