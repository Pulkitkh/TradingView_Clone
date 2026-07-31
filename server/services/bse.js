// Order/contract announcements from BSE India.
//
// BSE's announcement API (AnnSubCategoryGetData) returns data only when queried
// ONE DAY at a time (a date range comes back empty), paginated at 50/page. We
// filter to BSE's dedicated order subcategory "Award of Order / Receipt of
// Order" — matching on SUBCATNAME avoids the legal/court "order" false positives
// (NCLT orders, GST demand orders, arbitration orders). BSE has no structured
// value, so value/customer/duration are extracted by the shared headline/PDF
// regex tier (see extract.js) back in the poller.

import { fetchJson } from './browserFetch.js';

const API = 'https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w';
const HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.bseindia.com/corporates/ann.html',
  Origin: 'https://www.bseindia.com',
};
const DAYS = Number(process.env.BSE_DAYS || 2); // how many recent days to scan
const MAX_PAGES = Number(process.env.BSE_MAX_PAGES || 3); // 50 rows/page

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

// BSE's dedicated order subcategory. Matching SUBCATNAME (not the headline)
// keeps out unrelated filings that merely contain the word "order".
const ORDER_SUBCAT_RE = /award of order|receipt of order|orders?\s*\/\s*contracts?/i;
export function isOrderRow(r) {
  return ORDER_SUBCAT_RE.test(r.SUBCATNAME || '');
}

function pdfUrl(attachment) {
  if (!attachment) return null;
  return `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${attachment}`;
}

export function normalize(r) {
  return {
    id: `BSE-${r.NEWSID}`,
    source: 'BSE',
    symbol: null, // BSE gives a numeric SCRIP_CD; resolve to financials via name
    company: (r.SLONGNAME || '').trim() || 'Unknown',
    category: `${r.CATEGORYNAME || ''} / ${r.SUBCATNAME || ''}`.trim(),
    headline: (r.HEADLINE || r.NEWSSUB || r.MORE || '').trim(),
    pdfUrl: pdfUrl(r.ATTACHMENTNAME),
    broadcastDateTime: r.NEWS_DT || r.DissemDT || null,
    scripCd: r.SCRIP_CD || null,
  };
}

// One day, paginated (BSE caps at 50/page). Stops at TotalPageCnt or MAX_PAGES.
async function fetchDay(day) {
  const rows = [];
  let page = 1;
  let totalPages = 1;
  do {
    const url =
      `${API}?pageno=${page}&strCat=-1&strPrevDate=${day}` +
      `&strScrip=&strSearch=P&strToDate=${day}&strType=C&subcategory=-1`;
    let data;
    try {
      data = await fetchJson(url, { headers: HEADERS });
    } catch {
      break; // transient day/page error — take what we have
    }
    const batch = Array.isArray(data?.Table) ? data.Table : [];
    if (!batch.length) break;
    if (page === 1) {
      totalPages = Math.min(Number(batch[0]?.TotalPageCnt) || 1, MAX_PAGES);
    }
    rows.push(...batch);
    page += 1;
  } while (page <= totalPages);
  return rows;
}

/**
 * Fetch recent BSE order filings (normalized, deduped by NEWSID). Scans the
 * last `DAYS` days one at a time so nothing is missed over weekends.
 */
export async function fetchOrderFilings() {
  const seen = new Set();
  const orders = [];
  for (let i = 0; i < DAYS; i++) {
    const day = ymd(new Date(Date.now() - i * 86400000));
    let rows;
    try {
      rows = await fetchDay(day);
    } catch {
      continue;
    }
    for (const r of rows) {
      if (!isOrderRow(r)) continue;
      const n = normalize(r);
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      orders.push(n);
    }
  }
  return orders;
}
