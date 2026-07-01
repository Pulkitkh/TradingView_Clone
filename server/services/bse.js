// Order/contract announcements from BSE India.
//
// Unlike NSE, BSE's announcement API does not expose a clean structured order
// value — it gives category + headline + a PDF. So BSE filings are filtered to
// the order category here, and the value/customer/duration are extracted by the
// shared headline/PDF-regex tier (see extract.js) back in the poller.

import { fetchJson } from './browserFetch.js';

const API = 'https://api.bseindia.com/BseIndiaAPI/api/AnnGetData/w';
const HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.bseindia.com/corporates/ann.html',
  Origin: 'https://www.bseindia.com',
};

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

// BSE tags order filings under a subcategory like "Award of Order / Receipt of
// Order". Match on category first (clean), then fall back to headline phrases.
const STRONG_ORDER_RE =
  /award of order|receipt of order|orders?\s*\/\s*contracts?|bagging|work order|letter of award|purchase order|supply order|won\s+(?:an?\s+)?order/i;

function isOrderRow(r) {
  const cat = `${r.CATEGORYNAME || ''} ${r.SUBCATNAME || ''}`;
  if (/order|contract/i.test(cat)) return true;
  return STRONG_ORDER_RE.test(`${r.NEWSSUB || ''} ${r.HEADLINE || ''}`);
}

function pdfUrl(attachment) {
  if (!attachment) return null;
  return `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${attachment}`;
}

function normalize(r) {
  return {
    id: `BSE-${r.NEWSID || `${r.SCRIP_CD}-${r.NEWS_DT}`}`,
    source: 'BSE',
    symbol: null, // BSE gives a numeric SCRIP_CD, not a ticker; resolve via name
    company: (r.SLONGNAME || '').trim() || 'Unknown',
    category: `${r.CATEGORYNAME || ''} ${r.SUBCATNAME || ''}`.trim(),
    headline: (r.HEADLINE || r.NEWSSUB || '').trim(),
    pdfUrl: pdfUrl(r.ATTACHMENTNAME),
    broadcastDateTime: r.NEWS_DT || r.DissemDT || null,
    scripCd: r.SCRIP_CD || null,
  };
}

/**
 * Fetch recent BSE order filings (normalized). Covers the last `days` days so
 * nothing is missed between polls / over weekends.
 */
export async function fetchOrderFilings({ days = 2 } = {}) {
  const to = new Date();
  const from = new Date(Date.now() - days * 86400000);
  const url =
    `${API}?pageno=1&strCat=-1&strPrevDate=${ymd(from)}` +
    `&strScrip=&strSearch=P&strToDate=${ymd(to)}&strType=C`;

  const data = await fetchJson(url, { headers: HEADERS });
  const rows = Array.isArray(data?.Table) ? data.Table : [];
  return rows.filter(isOrderRow).map(normalize);
}
