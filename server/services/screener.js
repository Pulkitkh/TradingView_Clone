import * as cheerio from 'cheerio';

const BASE = 'https://www.screener.in';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Simple in-memory cache so we don't hammer Screener on every request.
const cache = new Map(); // key -> { at, data }
const TTL_MS = 1000 * 60 * 30; // 30 minutes

function getCached(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  return null;
}
function setCached(key, data) {
  cache.set(key, { at: Date.now(), data });
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/json' },
  });
  if (!res.ok) {
    const err = new Error(`Screener responded ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

/** Resolve a free-text query (name or symbol) to a Screener company URL. */
export async function searchCompany(query) {
  const url = `${BASE}/api/company/search/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return [];
  const list = await res.json();
  return Array.isArray(list) ? list : [];
}

function cleanNum(s) {
  if (s == null) return s;
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRatios($) {
  const ratios = [];
  $('#top-ratios li').each((_, el) => {
    const name = cleanNum($(el).find('.name').text());
    const value = cleanNum($(el).find('.value').text());
    if (name) ratios.push({ name, value });
  });
  return ratios;
}

function parseTable($, sectionId) {
  const $section = $(`#${sectionId}`);
  if (!$section.length) return null;
  const $table = $section.find('table.data-table').first();
  if (!$table.length) return null;

  const headers = [];
  $table
    .find('thead th')
    .each((_, th) => headers.push(cleanNum($(th).text())));

  const rows = [];
  $table.find('tbody tr').each((_, tr) => {
    const cells = [];
    $(tr)
      .find('td, th')
      .each((__, td) => cells.push(cleanNum($(td).text())));
    if (cells.length && cells[0]) {
      rows.push({ label: cells[0], values: cells.slice(1) });
    }
  });

  return { headers: headers.slice(1), rows };
}

function parseAbout($) {
  const about = cleanNum($('.company-profile .about p').first().text());
  const website =
    $('.company-links a').filter((_, a) => /www|http/i.test($(a).text())).first().attr('href') || null;
  return { about: about || null, website };
}

function parseProsCons($) {
  const pros = [];
  const cons = [];
  $('.pros li').each((_, el) => pros.push(cleanNum($(el).text())));
  $('.cons li').each((_, el) => cons.push(cleanNum($(el).text())));
  return { pros, cons };
}

/**
 * Fetch and parse a company's data from Screener.in.
 * @param {string} symbolOrName - Screener symbol (e.g. "BEML") or a company name.
 * @param {boolean} consolidated - prefer consolidated financials.
 */
export async function getCompany(symbolOrName, consolidated = true) {
  const cacheKey = `company:${symbolOrName}:${consolidated}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Resolve the path. If it looks like a clean symbol, try directly first.
  let path = null;
  let resolvedName = null;

  const looksLikeSymbol = /^[A-Za-z0-9&._-]{1,20}$/.test(symbolOrName);
  if (looksLikeSymbol) {
    path = `/company/${symbolOrName.toUpperCase()}/${consolidated ? 'consolidated/' : ''}`;
  }

  let html;
  try {
    if (!path) throw new Error('search-first');
    html = await fetchText(`${BASE}${path}`);
  } catch {
    const results = await searchCompany(symbolOrName);
    if (!results.length) {
      const err = new Error(`No Screener match for "${symbolOrName}"`);
      err.status = 404;
      throw err;
    }
    resolvedName = results[0].name;
    path = results[0].url;
    html = await fetchText(`${BASE}${path}`);
  }

  const $ = cheerio.load(html);
  const name =
    cleanNum($('h1').first().text()) || resolvedName || symbolOrName;

  const data = {
    name,
    symbol: symbolOrName.toUpperCase(),
    screenerUrl: `${BASE}${path}`,
    ...parseAbout($),
    ratios: parseRatios($),
    prosCons: parseProsCons($),
    financials: {
      quarters: parseTable($, 'quarters'),
      profitLoss: parseTable($, 'profit-loss'),
      balanceSheet: parseTable($, 'balance-sheet'),
      cashFlow: parseTable($, 'cash-flow'),
      ratios: parseTable($, 'ratios'),
      shareholding: parseTable($, 'shareholding'),
    },
    fetchedAt: new Date().toISOString(),
  };

  setCached(cacheKey, data);
  return data;
}

/**
 * Best-effort latest annual revenue (in INR crore) for a symbol, parsed from
 * the Screener Profit & Loss "Sales" row. Returns { revenueCr, fy } or null.
 */
export async function getAnnualRevenue(symbolOrName) {
  try {
    const data = await getCompany(symbolOrName, true);
    const pl = data.financials?.profitLoss;
    if (!pl || !pl.rows?.length) return null;
    const salesRow = pl.rows.find((r) => /^sales\b/i.test(r.label));
    if (!salesRow) return null;
    const idx = salesRow.values.length - 1;
    const num = parseFloat(String(salesRow.values[idx]).replace(/,/g, ''));
    if (Number.isNaN(num)) return null;
    const fyLabel = pl.headers?.[idx] || '';
    const fy = fyLabel ? `FY${(fyLabel.match(/\d{4}/) || [''])[0]}` : null;
    return { revenueCr: num, fy };
  } catch {
    return null;
  }
}
