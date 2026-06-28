// Structured order ingestion from NSE's XBRL award feed.
//
// NSE exposes order/contract awards at:
//   /api/XBRL-announcements?index=equities&type=award
// Each record links an `xbrl` document whose XML carries the fields as
// structured data — value, counterparty, date, nature, duration — so we do
// NOT need to parse PDFs or use AI to get them.
//
// (Endpoint + taxonomy identified from a working poller script. Thanks!)

import { fetchJson, fetchText } from './browserFetch.js';

const FEED_URL =
  'https://www.nseindia.com/api/XBRL-announcements?index=equities&type=award';
const WARMUP = 'https://www.nseindia.com/';

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
    }
  } catch {
    /* best effort */
  }
}

/** Fetch the list of award filings (newest first). */
export async function fetchAwardFilings() {
  await warmup();
  const data = await fetchJson(FEED_URL, {
    cookie,
    headers: {
      Accept: '*/*',
      Referer:
        'https://www.nseindia.com/companies-listing/corporate-filings-announcements',
    },
  });
  if (!Array.isArray(data)) throw new Error('award feed: unexpected payload');
  return data;
}

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
  };
}
