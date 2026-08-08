// Order/contract announcements from BSE India.
//
// BSE publishes ~2,400 announcements a day across 48 pages, so scanning pages
// and filtering client-side misses almost everything. Instead we ask BSE's API
// for the order subcategory directly:
//
//   strCat      = "Company Update"
//   subcategory = "Award of Order / Receipt of Order"
//
// which returns just the order filings (typically a single page per day). The
// API also only honours a SINGLE day at a time — a date range comes back empty
// — so we walk recent days one by one.
//
// BSE exposes no structured order value, so value/customer/duration are
// extracted from the headline/PDF by the shared regex tier (see extract.js).

import { fetchJson } from './browserFetch.js';

const API = 'https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w';
const CATEGORY = 'Company Update';
const SUBCATEGORY = 'Award of Order / Receipt of Order';
const HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.bseindia.com/corporates/ann.html',
  Origin: 'https://www.bseindia.com',
};
const DAYS = Number(process.env.BSE_DAYS || 2);
const MAX_PAGES = Number(process.env.BSE_MAX_PAGES || 5);

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

// The API already filters to the order subcategory; this is a belt-and-braces
// check in case BSE ever widens what it returns for that query.
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
    symbol: null, // BSE gives a numeric SCRIP_CD; financials resolve via name
    company: (r.SLONGNAME || '').trim() || 'Unknown',
    category: `${r.CATEGORYNAME || ''} / ${r.SUBCATNAME || ''}`.trim(),
    headline: (r.HEADLINE || r.NEWSSUB || r.MORE || '').trim(),
    pdfUrl: pdfUrl(r.ATTACHMENTNAME),
    broadcastDateTime: r.NEWS_DT || r.DissemDT || null,
    scripCd: r.SCRIP_CD || null,
  };
}

function dayUrl(day, page) {
  const q = new URLSearchParams({
    pageno: String(page),
    strCat: CATEGORY,
    strPrevDate: day,
    strScrip: '',
    strSearch: 'P',
    strToDate: day,
    strType: 'C',
    subcategory: SUBCATEGORY,
  });
  return `${API}?${q}`;
}

async function fetchDay(day) {
  const rows = [];
  let totalPages = 1;
  for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page++) {
    let data;
    try {
      data = await fetchJson(dayUrl(day, page), { headers: HEADERS });
    } catch {
      break; // transient failure — keep whatever we already have
    }
    const batch = Array.isArray(data?.Table) ? data.Table : [];
    if (!batch.length) break;
    if (page === 1) totalPages = Number(batch[0]?.TotalPageCnt) || 1;
    rows.push(...batch);
  }
  return rows;
}

/**
 * Recent BSE order filings, normalized and deduped by NEWSID. Walks the last
 * `BSE_DAYS` days so nothing is missed across weekends or short outages.
 */
export async function fetchOrderFilings() {
  const seen = new Set();
  const orders = [];
  const errors = [];

  for (let i = 0; i < DAYS; i++) {
    const day = ymd(new Date(Date.now() - i * 86400000));
    let rows;
    try {
      rows = await fetchDay(day);
    } catch (err) {
      errors.push(`${day}: ${err.message}`);
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

  // Only surface an error if EVERY day failed — a single bad day shouldn't
  // look like an outage.
  if (!orders.length && errors.length === DAYS) {
    throw new Error(`BSE unreachable — ${errors[0]}`);
  }
  return orders;
}
