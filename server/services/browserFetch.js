// Fetches a URL, falling back to a real browser engine when a plain Node
// `fetch` is blocked by TLS-fingerprint bot protection (both NSE and BSE sit
// behind Akamai, which 403s undici but lets real browsers through).
//
// Strategy: keep a warmed browser page PER SITE (nseindia / bseindia). For an
// API/JSON URL we run the fetch INSIDE that site's page (page.evaluate) so it
// is a genuine browser XHR carrying that site's Akamai cookies — which is how
// the real site loads its own data. Binary files (PDF/XBRL archives) are opened
// as a top-level navigation instead.
//
// Requests are throttled and, when a site starts refusing us, put in a short
// cooldown — hammering a rate-limited exchange only extends the block.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const SITE_HOME = {
  nse: 'https://www.nseindia.com/companies-listing/corporate-filings-announcements',
  bse: 'https://www.bseindia.com/corporates/ann.html',
};

function siteFor(url) {
  if (/nseindia\.com/i.test(url)) return 'nse';
  if (/bseindia\.com/i.test(url)) return 'bse';
  return null;
}

// ---- pacing & cooldown ------------------------------------------------------

const MIN_GAP_MS = Number(process.env.FETCH_GAP_MS || 600);
const COOLDOWN_MS = Number(process.env.FETCH_COOLDOWN_MS || 120_000);
let lastFetchAt = 0;
const blockedUntil = {}; // site -> timestamp

async function pace() {
  const wait = lastFetchAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt = Date.now();
}

function inCooldown(site) {
  return site && blockedUntil[site] && Date.now() < blockedUntil[site];
}

function startCooldown(site) {
  if (!site) return;
  if (!inCooldown(site)) {
    blockedUntil[site] = Date.now() + COOLDOWN_MS;
    console.warn(
      `[fetch] ${site.toUpperCase()} is refusing requests — pausing ${Math.round(
        COOLDOWN_MS / 1000
      )}s before retrying (rate limit).`
    );
  }
}

function clearCooldown(site) {
  if (site) delete blockedUntil[site];
}

// ---- browser fallback -------------------------------------------------------

let ctxPromise = null;
let browserRef = null;
let browserUnavailableReason = null;
let warnedUnavailable = false;
const sitePages = {}; // site -> Promise<page>

/**
 * Close the browser and forget every warmed page, so the next fetch starts a
 * fresh one. Chromium's memory creeps over days of uptime, and a stale profile
 * can also accumulate cookies the exchanges dislike — a periodic recycle keeps
 * a long-running process healthy.
 */
export async function recycleBrowser() {
  const old = browserRef;
  ctxPromise = null;
  browserRef = null;
  for (const k of Object.keys(sitePages)) delete sitePages[k];
  if (old) await old.close().catch(() => {});
}

async function getContext() {
  if (ctxPromise) return ctxPromise;
  ctxPromise = (async () => {
    let chromium;
    try {
      const mod = process.env.PLAYWRIGHT_MODULE || 'playwright';
      ({ chromium } = await import(mod));
    } catch (err) {
      browserUnavailableReason =
        'playwright is not installed. Run:  npm --prefix server install  ' +
        '&&  npm --prefix server exec playwright install chromium';
      return null;
    }
    const launchOpts = {};
    if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
      launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
    }
    // Node's fetch honours HTTPS_PROXY automatically; Chromium does not, so a
    // proxied environment would leave the browser unable to connect at all.
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (proxy) launchOpts.proxy = { server: proxy };
    try {
      const browser = await chromium.launch(launchOpts);
      browserRef = browser;
      return await browser.newContext({ userAgent: UA });
    } catch (err) {
      browserUnavailableReason =
        `Chromium failed to launch (${err.message.split('\n')[0]}). Run:  ` +
        'npm --prefix server exec playwright install chromium';
      return null;
    }
  })();
  return ctxPromise;
}

function warnUnavailableOnce() {
  if (warnedUnavailable || !browserUnavailableReason) return;
  warnedUnavailable = true;
  console.error(
    `\n[fetch] ⚠️  Browser fallback is NOT available — ${browserUnavailableReason}\n` +
      '        Without it, the exchanges will block this machine as soon as they rate-limit ' +
      'plain requests.\n'
  );
}

// A page already navigated to the site, so Akamai's challenge has run and its
// cookies are set. Reused across calls.
async function getSitePage(site) {
  if (sitePages[site]) return sitePages[site];
  sitePages[site] = (async () => {
    const ctx = await getContext();
    if (!ctx) return null;
    const page = await ctx.newPage();
    try {
      await page.goto(SITE_HOME[site] || 'https://example.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(2500); // let the bot challenge settle
    } catch {
      /* still usable for top-level navigations */
    }
    return page;
  })();
  return sitePages[site];
}

async function inPageFetchOnce(site, url) {
  const page = await getSitePage(site);
  if (!page) return null;
  try {
    return await page.evaluate(async (u) => {
      const r = await fetch(u, { headers: { Accept: '*/*' }, credentials: 'include' });
      return r.ok ? r.text() : null;
    }, url);
  } catch {
    return null;
  }
}

// In-page fetch with one re-warm: the exchanges' cookies expire, so on failure
// we discard the cached page, re-navigate for fresh cookies, and retry once.
async function inPageFetch(site, url) {
  let body = await inPageFetchOnce(site, url);
  if (body != null) return body;

  const stale = sitePages[site];
  try {
    const p = await stale;
    if (p) await p.close().catch(() => {});
  } catch {
    /* ignore */
  }
  if (sitePages[site] === stale) delete sitePages[site];

  return inPageFetchOnce(site, url);
}

async function topLevelFetch(url, binary) {
  const ctx = await getContext();
  if (!ctx) return null;
  const site = siteFor(url);
  if (site) await getSitePage(site); // warm cookies first
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
    if (!resp || !resp.ok()) return null;
    const buf = await resp.body();
    return binary ? buf : buf.toString('utf8');
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function viaBrowser(url, { binary = false } = {}) {
  await pace();
  const site = siteFor(url);
  if (!binary && site) {
    const body = await inPageFetch(site, url);
    if (body != null) return body;
  }
  return topLevelFetch(url, binary);
}

// ---- public API -------------------------------------------------------------

async function plainFetch(url, headers, binary) {
  const res = await fetch(url, { headers });
  if (res.ok) return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
  if (res.status !== 403 && res.status !== 429) {
    throw new Error(`fetch ${url} -> ${res.status}`);
  }
  return undefined; // blocked → try the browser
}

async function fetchAny(url, { headers = {}, cookie } = {}, binary) {
  const site = siteFor(url);
  if (inCooldown(site)) {
    const secs = Math.ceil((blockedUntil[site] - Date.now()) / 1000);
    throw new Error(`${site} rate-limited, cooling down ${secs}s: ${url}`);
  }

  const h = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: site === 'bse' ? 'https://www.bseindia.com/' : 'https://www.nseindia.com/',
    ...headers,
  };
  if (cookie) h.Cookie = cookie;

  try {
    const out = await plainFetch(url, h, binary);
    if (out !== undefined) {
      clearCooldown(site);
      return out;
    }
  } catch (err) {
    // A real HTTP status (404, 500…) means the request got through and the
    // browser won't do better — surface it. Anything else is a transport-level
    // failure: Akamai commonly blocks by RESETTING the connection rather than
    // answering 403, which surfaces as a bare "fetch failed". Those must fall
    // through to the browser fallback, not abort.
    if (/-> \d+$/.test(err.message)) throw err;
  }

  const viaB = await viaBrowser(url, { binary });
  if (viaB != null) {
    clearCooldown(site);
    return viaB;
  }

  warnUnavailableOnce();
  startCooldown(site);
  const why = browserUnavailableReason
    ? `browser fallback unavailable — ${browserUnavailableReason}`
    : 'blocked in both plain and browser fetch (rate limited)';
  throw new Error(`fetch failed (403; ${why}): ${url}`);
}

export async function fetchText(url, opts = {}) {
  return fetchAny(url, opts, false);
}

export async function fetchJson(url, opts = {}) {
  return JSON.parse(await fetchText(url, opts));
}

export async function fetchBuffer(url, opts = {}) {
  return fetchAny(url, opts, true);
}
