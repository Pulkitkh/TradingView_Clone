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
import { recycleBrowser } from './services/browserFetch.js';
import { log } from './services/logger.js';
import * as dedupe from './services/alertDedupe.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
// 2 minutes by default: NSE rate-limits datacenter/VPS IPs (the usual RDP case)
// aggressively, and polling harder mostly buys longer blocks. Filings still
// arrive within a couple of minutes of being published.
const POLL_MS = Number(process.env.ALERT_POLL_MS || process.env.POLL_INTERVAL_MS || 120_000);
// Spread requests so we never hit the feeds on a perfectly predictable beat.
const POLL_JITTER_MS = Number(process.env.ALERT_POLL_JITTER_MS || 15_000);
const SEND_GAP_MS = Number(process.env.ALERT_SEND_GAP_MS || 3500); // Telegram: ~20 msg/min/group
const SEND_BACKLOG = process.env.ALERT_BACKLOG === 'true';
const BSE_ENABLED = process.env.DISABLE_BSE !== 'true';
const MIN_VALUE_CR = Number(process.env.ALERT_MIN_VALUE_CR || 0); // 0 = alert everything
const MAX_PER_POLL = Number(process.env.ALERT_MAX_PER_POLL || 15); // flood guard; 0 = unlimited
// 24/7 hardening
const RECYCLE_AFTER_FAILURES = Number(process.env.ALERT_RECYCLE_AFTER_FAILURES || 3);
const RECYCLE_EVERY_MS = Number(process.env.ALERT_RECYCLE_EVERY_MS || 6 * 3600_000); // 6h
const HEARTBEAT_MS = Number(process.env.ALERT_HEARTBEAT_MS || 0); // 0 = off
// Post the newest order once at startup, so a fresh launch visibly proves the
// pipeline works instead of sitting silent until the next filing.
const POST_LAST_ON_START = process.env.ALERT_POST_LAST_ON_START === 'true';
const startedAt = Date.now();

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
      log.warn(`[telegram] rate limited, waiting ${retryAfter}s`);
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

// `limit` + `ignoreDedupe` exist for --send-recent, which deliberately re-posts
// the newest N filings even though they are already recorded.
async function collectNse({ ignoreDedupe = false, limit = 0 } = {}) {
  const out = [];
  let feed = await fetchNseOrders();
  if (limit > 0) {
    // Feed is newest-first; only parse what we actually need.
    feed = feed.slice(0, limit);
  }
  for (const rec of feed) {
    const filing = normalizeFeed(rec);
    // Cheap id check BEFORE fetching the XBRL — avoids re-downloading documents
    // for filings we've already alerted on.
    if (!ignoreDedupe && dedupe.alreadyAlerted({ id: filing.id, company: filing.company }))
      continue;

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

async function collectBse({ ignoreDedupe = false, limit = 0 } = {}) {
  const out = [];
  let feed = await fetchBseOrders();
  if (limit > 0) feed = feed.slice(0, limit);
  for (const filing of feed) {
    if (!ignoreDedupe && dedupe.alreadyAlerted({ id: filing.id, company: filing.company }))
      continue;
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
    log.warn('[alerter] NSE baseline:', err.message);
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
      log.warn('[alerter] BSE baseline:', err.message);
    }
  }
  await dedupe.save();
  return n;
}

// An exchange being unreachable is an expected, self-healing condition — the
// exchanges rate-limit datacenter/VPS ranges routinely. Log the transition into
// and out of an outage, not every single poll, so the log stays readable and a
// genuine problem is still visible.
const sourceState = {}; // name -> { down: boolean, since: number, polls: number }

function noteSourceFailed(name, message) {
  const s = (sourceState[name] ||= { down: false, since: 0, polls: 0 });
  s.polls++;
  if (!s.down) {
    s.down = true;
    s.since = Date.now();
    s.polls = 1;
    log.warn(`[alerter] ${name} unreachable — retrying quietly. Reason: ${message}`);
  }
}

function noteSourceOk(name) {
  const s = (sourceState[name] ||= { down: false, since: 0, polls: 0 });
  if (s.down) {
    const mins = Math.max(1, Math.round((Date.now() - s.since) / 60000));
    log.info(`[alerter] ${name} recovered after ${mins} min (${s.polls} retries)`);
  }
  s.down = false;
  s.polls = 0;
}

async function pollOnce() {
  stats.polls++;
  stats.lastPollAt = new Date().toISOString();

  if (firstRun && !SEND_BACKLOG) {
    firstRun = false;
    const n = await baselineSilently();
    log.info(
      `[alerter] baselined ${n} existing filings silently ` +
        `(set ALERT_BACKLOG=true to post them). Now watching for new orders.`
    );
    return;
  }
  firstRun = false;

  const collected = [];
  try {
    collected.push(...(await collectNse()));
    noteSourceOk('NSE');
  } catch (err) {
    noteSourceFailed('NSE', err.message);
  }
  if (BSE_ENABLED) {
    try {
      collected.push(...(await collectBse()));
      noteSourceOk('BSE');
    } catch (err) {
      noteSourceFailed('BSE', err.message);
    }
  }

  // Oldest first, so the group reads chronologically.
  collected.sort((a, b) => new Date(a.date) - new Date(b.date));
  stats.seen += collected.length;

  // Safety valve: if something upstream ever floods (e.g. a feed re-issues ids),
  // cap how many messages one cycle can post to the group.
  const batch = MAX_PER_POLL > 0 ? collected.slice(0, MAX_PER_POLL) : collected;
  if (batch.length < collected.length) {
    log.warn(
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
      log.info(
        `[sent] (${o.source}) ${o.company} — ${o.contractValueCr ?? '?'} Cr — ${o.customer ?? '?'}`
      );
    } catch (err) {
      dedupe.release(raw); // let a later poll retry it
      stats.failed++;
      log.warn(`[alerter] send failed for ${raw.company}: ${err.message}`);
    }
  }
  await dedupe.save();
}

// --test           : post a test message, confirm token/chat/admin rights, exit
// --send-recent=N  : post the N most recent orders now, ignoring de-dupe, exit
//                    (proves the whole pipeline end to end)
async function runOneShot(mode, n) {
  if (mode === 'test') {
    log.info('[alerter] sending test message…');
    await sendMessage(
      '✅ <b>Order alerter connected</b>\n' +
        '<i>If you can see this, the bot, token and group are set up correctly.</i>\n\n' +
        'Real alerts will arrive here as soon as a company files a new order with NSE or BSE.'
    );
    log.info('[alerter] ✅ sent. Check your Telegram group.');
    return;
  }

  log.info(`[alerter] fetching the ${n} most recent orders…`);
  await dedupe.init();
  // Deliberately ignore de-dupe here: this mode exists to prove the pipeline,
  // so it re-posts the newest N even though they are already recorded.
  const opts = { ignoreDedupe: true, limit: n };
  const collected = [];
  try {
    collected.push(...(await collectNse(opts)));
  } catch (err) {
    log.warn('[alerter] NSE:', err.message);
  }
  if (BSE_ENABLED) {
    try {
      collected.push(...(await collectBse(opts)));
    } catch (err) {
      log.warn('[alerter] BSE:', err.message);
    }
  }
  collected.sort((a, b) => new Date(b.date) - new Date(a.date)); // newest first
  const batch = collected.slice(0, n).reverse(); // post oldest-first
  if (!batch.length) {
    log.info('[alerter] no orders found to send (feeds returned nothing new).');
    return;
  }
  for (const raw of batch) {
    const o = await enrich(raw);
    await sendMessage(formatAlert(o));
    dedupe.markAlerted(o); // so the live loop won't repeat them
    log.info(`[sent] (${o.source}) ${o.company} — ${o.contractValueCr ?? '?'} Cr`);
  }
  await dedupe.save();
  log.info(`[alerter] ✅ sent ${batch.length}. Check your Telegram group.`);
}

async function main() {
  const loaded = await dedupe.init();
  log.info(
    `[alerter] starting — NSE${BSE_ENABLED ? ' + BSE' : ''}, poll ${POLL_MS}ms, ` +
      `dedupe loaded ${loaded.ids} ids / ${loaded.prints} fingerprints`
  );
  log.info(`[alerter] logging to ${log.file}`);
  if (loaded.ids > 0) firstRun = false; // returning run: alert anything genuinely new

  if (POST_LAST_ON_START) {
    try {
      log.info('[alerter] posting the most recent order to confirm the pipeline…');
      await runOneShot('recent', 1);
    } catch (err) {
      log.warn('[alerter] startup post failed (continuing anyway):', err.message);
    }
  }

  let consecutiveFailures = 0;
  let lastRecycle = Date.now();
  let lastHeartbeat = Date.now();

  while (running) {
    const before = stats.failed;
    try {
      await pollOnce();
      // A poll that reached the feeds resets the failure counter.
      consecutiveFailures = stats.failed > before ? consecutiveFailures : 0;
      stats.lastOkAt = new Date().toISOString();
    } catch (err) {
      consecutiveFailures++;
      log.error(`[alerter] poll error (${consecutiveFailures} in a row):`, err.message);
    }

    // Repeated failures usually mean a wedged browser session or expired
    // cookies. Recycle it rather than sitting broken until someone notices.
    if (consecutiveFailures >= RECYCLE_AFTER_FAILURES) {
      log.warn('[alerter] recycling browser after repeated failures');
      await recycleBrowser().catch(() => {});
      consecutiveFailures = 0;
    }

    // Scheduled recycle: Chromium's memory creeps over days of uptime.
    if (RECYCLE_EVERY_MS > 0 && Date.now() - lastRecycle > RECYCLE_EVERY_MS) {
      log.info('[alerter] scheduled browser recycle');
      await recycleBrowser().catch(() => {});
      lastRecycle = Date.now();
    }

    // Optional heartbeat so you can tell "quiet market" from "process died".
    if (HEARTBEAT_MS > 0 && Date.now() - lastHeartbeat > HEARTBEAT_MS) {
      lastHeartbeat = Date.now();
      const up = Math.round((Date.now() - startedAt) / 3600000);
      try {
        await sendMessage(
          `💓 <b>Alerter healthy</b>\n<i>up ${up}h • ${stats.sent} alerts sent • ` +
            `${stats.polls} checks • last check ${esc(fmtDateTime(stats.lastPollAt))} IST</i>`
        );
      } catch (err) {
        log.warn('[alerter] heartbeat failed:', err.message);
      }
    }

    await new Promise((r) => setTimeout(r, POLL_MS + Math.random() * POLL_JITTER_MS));
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
      log.info(`[alerter] ${sig} — saving state (sent ${stats.sent}, skipped ${stats.skipped})`);
      running = false;
      try {
        await dedupe.save();
      } catch {
        /* best effort */
      }
      process.exit(0);
    });
  }

  // On an unattended box an unexpected throw must not end a 24/7 run. Log it,
  // keep the loop alive, and let the launcher restart us only if the process
  // genuinely dies.
  process.on('unhandledRejection', (err) => {
    log.error('[alerter] unhandled rejection:', err?.message || String(err));
  });
  process.on('uncaughtException', (err) => {
    log.error('[alerter] uncaught exception:', err?.message || String(err));
  });

  const argv = process.argv.slice(2);
  const recentArg = argv.find((a) => a.startsWith('--send-recent'));
  const oneShot = argv.includes('--test')
    ? { mode: 'test' }
    : recentArg
      ? { mode: 'recent', n: Number(recentArg.split('=')[1] || 3) }
      : null;

  const run = oneShot ? runOneShot(oneShot.mode, oneShot.n) : main();
  run.catch((err) => {
    log.error('[alerter] fatal:', err.message || err);
    process.exit(1);
  });
}
