// Structured order ingestion from NSE's XBRL award feed.
//
// NSE exposes order/contract awards at:
//   /api/XBRL-announcements?index=equities&type=award
// Each record links an `xbrl` document whose XML carries the fields as
// structured data — value, counterparty, date, nature, duration — so we do
// NOT need to parse PDFs or use AI to get them.
//
// (Endpoint + taxonomy identified from a working poller script. Thanks!)

import { fetchJson, fetchText, cookiesViaBrowser } from './browserFetch.js';

// NSE merged the dedicated "award" event into Para B of Schedule III effective
// 20-Jun-2026. The legacy `type=award` feed now returns 0 records (verified
// live), so `para-b` is the only source — orders arrive mixed with other
// material events and are selected by eventType.
const FEED = (type) =>
  `https://www.nseindia.com/api/XBRL-announcements?index=equities&type=${type}`;
const FEED_TYPES = ['para-b'];
const WARMUP = 'https://www.nseindia.com/';

// eventType strings that denote a NEW order/contract win in the Para B feed:
//   "Bagging/Receiving of orders/contracts (Sub-para 4-Para B)"
//   "Awarding of order(s)/contract(s)-(Sub-para 4-Para B)"
// "Amendment or termination of orders/contracts" shares Sub-para 4 but is a
// change/cancellation, not a new win, so it is excluded.
const ORDER_EVENT_RE = /\b(order|contract|bagging|awarding)\b/i;
const NOT_NEW_ORDER_RE = /amendment|termination|terminated|cancell?ation/i;
export function isOrderEvent(eventType) {
  const t = eventType || '';
  return ORDER_EVENT_RE.test(t) && !NOT_NEW_ORDER_RE.test(t);
}

// Absurd values usually mean a filing data-entry error (wrong unit). Flag,
// don't trust, and try to recover from the free-text description.
const SANITY_LIMIT_CR = 100000;
const CRORE_RE = /(?:Rs\.?\s*)?(\d[\d,]*\.?\d*)\s*(?:crore|cr\.?)/i;

const DATE_TAGS = [
  'DateOfBaggingOrReceivingOfOrdersOrContracts',
  'DateOfAwardingOfOrdersOrContracts',
  'DateOfAwardOfOrdersOrContracts',
];

let cookie = '';
let cookieAt = 0;

// Ask NSE's home page for a session cookie. On a datacenter/VPS IP the plain
// request is itself refused, so nothing is learned and the API call then fails
// too — hence the browser fallback, which passes the bot challenge and can hand
// us real cookies.
async function warmup() {
  if (cookie && Date.now() - cookieAt < 1000 * 60 * 5) return;
  try {
    const res = await fetch(WARMUP, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        Accept: 'text/html',
      },
    });
    const sc = res.headers.get('set-cookie');
    if (sc) {
      cookie = sc
        .split(/,(?=[^;]+=[^;]+;)/)
        .map((c) => c.split(';')[0].trim())
        .join('; ');
      cookieAt = Date.now();
      return;
    }
  } catch {
    /* fall through to the browser */
  }

  const viaBrowser = await cookiesViaBrowser('nse');
  if (viaBrowser) {
    cookie = viaBrowser;
    cookieAt = Date.now();
  }
}

/**
 * Fetch order/contract award filings across the para-b + award feeds, filtered
 * to orders and deduped by appId (newest first). Para B records are filtered by
 * eventType; the legacy award feed is order-only by definition.
 */
export async function fetchOrderFilings() {
  await warmup();
  const headers = {
    Accept: '*/*',
    Referer:
      'https://www.nseindia.com/companies-listing/corporate-filings-announcements',
  };

  const seen = new Set();
  const out = [];
  const errors = [];
  for (const type of FEED_TYPES) {
    let data;
    try {
      data = await fetchJson(FEED(type), { cookie, headers });
    } catch (err) {
      errors.push(`${type}: ${err.message}`);
      continue; // one feed failing shouldn't kill the other
    }
    if (!Array.isArray(data)) continue;
    for (const rec of data) {
      // para-b carries all material events; keep only new order/contract wins.
      if (!isOrderEvent(rec.eventType)) continue;
      const id = String(rec.appId);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(rec);
    }
  }
  if (!out.length && errors.length) {
    throw new Error(`order feeds failed — ${errors.join('; ')}`);
  }
  return out;
}

// Back-compat alias.
export const fetchAwardFilings = fetchOrderFilings;

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

// Pull the text of a tag, ignoring any namespace prefix.
function tag(xml, name) {
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`,
    'i'
  );
  const m = xml.match(re);
  return m ? decodeEntities(m[1].trim()) : null;
}

function firstTag(xml, names) {
  for (const n of names) {
    const v = tag(xml, n);
    if (v) return v;
  }
  return null;
}

/**
 * Parse an award XBRL document (XML string) into structured fields.
 * Pure function — no network — so it's easy to test.
 * @returns {object}
 */
export function parseAwardXml(xml) {
  const amountRaw = tag(xml, 'AmountOfTheOrdersOrContracts');
  const description = tag(
    xml,
    'BroadCommercialConsiderationOrSizeOfTheOrdersOrContracts'
  );

  let amountCr = amountRaw ? +(parseFloat(amountRaw) / 1e7).toFixed(2) : null;
  let flag = null;
  if (amountCr != null && amountCr > SANITY_LIMIT_CR) {
    const m = CRORE_RE.exec(description || '');
    if (m) {
      amountCr = parseFloat(m[1].replace(/,/g, ''));
      flag = 'value recovered from description (raw XBRL amount looked wrong)';
    } else {
      flag = 'suspected data error (raw XBRL amount implausibly large)';
    }
  }

  return {
    amountCr,
    flag,
    nature: tag(xml, 'NatureOfOrdersOrContracts'),
    description,
    duration: tag(xml, 'TimePeriodToWhichOrdersOrContractsIsAssociated'),
    domesticIntl: tag(
      xml,
      'WhetherOrdersOrContractsIsAwardedToDomesticOrInternationalEntity'
    ),
    country: tag(xml, 'NameOfTheCountryInWhichCounterpartyIsExists'),
    counterparty: firstTag(xml, [
      'NameOfTheEntityAwardingTheOrdersOrContracts',
      'NameOfTheEntityToWhichOrdersOrContractsIsAwarded',
    ]),
    date: firstTag(xml, DATE_TAGS),
  };
}

/**
 * Fetch + parse one award XBRL document into structured fields.
 * @returns {Promise<object>}
 */
export async function parseAwardXbrl(xbrlUrl) {
  const xml = await fetchText(xbrlUrl, { cookie });
  return parseAwardXml(xml);
}

/** Normalise a feed record. */
export function normalizeFeed(rec) {
  return {
    id: String(rec.appId),
    appId: rec.appId,
    symbol: rec.symbol || null,
    company: rec.companyName || rec.symbol || 'Unknown',
    xbrlUrl: rec.xbrl || null,
    pdfUrl: rec.attachment || null,
    broadcastDateTime: rec.broadcastDateTime || null,
    eventType: rec.eventType || null,
  };
}

/** "Awarding of order(s)/contract(s)-(Sub-para 4-Para B)" -> clean type. */
export function cleanEventType(eventType) {
  if (!eventType) return null;
  return eventType.replace(/\s*[-(]?\s*\(?Sub-para[^)]*\)?\s*$/i, '').trim() || null;
}
