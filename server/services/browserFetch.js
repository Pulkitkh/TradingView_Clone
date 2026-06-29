// Fetches a URL, falling back to a real browser engine when a plain Node
// `fetch` is blocked by TLS-fingerprint bot protection (NSE/Akamai 403s
// undici but lets curl/browsers through).
//
// Two browser strategies, picked by host:
//  - www.nseindia.com API calls: run fetch INSIDE a navigated page
//    (page.evaluate) so it's a genuine same-origin XHR — this is how the real
//    site loads its data and what gets past Akamai.
//  - nsearchives.nseindia.com (XBRL/PDF): use the browser request context,
//    which that (more lenient) host accepts.
//
// The browser fallback is OPTIONAL: without `playwright` it's a no-op and we
// just return the plain-fetch result. From a non-fingerprinted host plain
// fetch works and the browser never launches.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const NSE_PAGE =
  'https://www.nseindia.com/companies-listing/corporate-filings-announcements';

let sessionPromise = null; // { ctx, page } or null

async function getSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    let chromium;
    try {
      const mod = process.env.PLAYWRIGHT_MODULE || 'playwright';
      ({ chromium } = await import(mod));
    } catch {
      return null;
    }
    const launchOpts = {};
    if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
      launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
    }
    try {
      const browser = await chromium.launch(launchOpts);
      const ctx = await browser.newContext({ userAgent: UA });
      const page = await ctx.newPage();
      try {
        await page.goto(NSE_PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2500); // let Akamai's challenge settle
      } catch {
        /* still usable for nsearchives */
      }
      return { ctx, page };
    } catch {
      return null;
    }
  })();
  return sessionPromise;
}

function isSameOriginApi(url) {
  return /^https:\/\/www\.nseindia\.com\//i.test(url);
}

async function viaBrowser(url, { binary = false } = {}) {
  const session = await getSession();
  if (!session) return null;
  const { ctx, page } = session;

  // Same-origin NSE API → fetch from inside the page.
  if (isSameOriginApi(url) && !binary) {
    try {
      const body = await page.evaluate(async (u) => {
        const r = await fetch(u, {
          headers: { Accept: '*/*' },
          credentials: 'include',
        });
        if (!r.ok) return null;
        return r.text();
      }, url);
      if (body != null) return body;
    } catch {
      /* fall through to request context */
    }
  }

  // Cross-origin archive host (nsearchives XBRL/PDF) → open as a top-level
  // navigation in its own page, which Akamai accepts as a real browser hit.
  const archivePage = await ctx.newPage();
  try {
    const resp = await archivePage.goto(url, { waitUntil: 'commit', timeout: 30000 });
    if (!resp || !resp.ok()) return null;
    const buf = await resp.body();
    return binary ? buf : buf.toString('utf8');
  } catch {
    return null;
  } finally {
    await archivePage.close().catch(() => {});
  }
}

async function plainFetch(url, headers, binary) {
  const res = await fetch(url, { headers });
  if (res.ok) return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
  if (res.status !== 403) throw new Error(`fetch ${url} -> ${res.status}`);
  return undefined; // 403 → signal caller to try browser
}

export async function fetchText(url, { headers = {}, cookie } = {}) {
  const h = { 'User-Agent': UA, Referer: 'https://www.nseindia.com/', ...headers };
  if (cookie) h.Cookie = cookie;
  try {
    const out = await plainFetch(url, h, false);
    if (out !== undefined) return out;
  } catch {
    /* fall through */
  }
  const viaB = await viaBrowser(url, { binary: false });
  if (viaB != null) return viaB;
  throw new Error(`fetch failed (403; browser fallback unavailable): ${url}`);
}

export async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

export async function fetchBuffer(url, { headers = {}, cookie } = {}) {
  const h = { 'User-Agent': UA, Referer: 'https://www.nseindia.com/', ...headers };
  if (cookie) h.Cookie = cookie;
  try {
    const out = await plainFetch(url, h, true);
    if (out !== undefined) return out;
  } catch {
    /* fall through */
  }
  const viaB = await viaBrowser(url, { binary: true });
  if (viaB != null) return viaB;
  throw new Error(`fetch failed (403; browser fallback unavailable): ${url}`);
}
