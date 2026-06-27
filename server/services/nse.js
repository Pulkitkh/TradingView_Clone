// Fetches live corporate announcements from NSE India.
// NSE gates its APIs behind a browser-like session and aggressively blocks
// non-browser / datacenter traffic. We warm up a cookie session, send the
// full set of headers a real browser sends, and retry with backoff.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ANN_URL =
  'https://www.nseindia.com/api/corporate-announcements?index=equities';
const WARMUP_URLS = [
  'https://www.nseindia.com/',
  'https://www.nseindia.com/companies-listing/corporate-filings-announcements',
];

const BROWSER_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

let cookieJar = '';
let cookieAt = 0;

function mergeCookies(setCookie) {
  if (!setCookie) return;
  const parts = setCookie
    .split(/,(?=[^;]+=[^;]+;)/)
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean);
  const map = new Map();
  cookieJar
    .split('; ')
    .filter(Boolean)
    .forEach((c) => {
      const [k, ...v] = c.split('=');
      map.set(k, v.join('='));
    });
  parts.forEach((c) => {
    const [k, ...v] = c.split('=');
    map.set(k, v.join('='));
  });
  cookieJar = [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function warmup() {
  if (cookieJar && Date.now() - cookieAt < 1000 * 60 * 5) return;
  for (const url of WARMUP_URLS) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      mergeCookies(res.headers.get('set-cookie'));
    } catch {
      /* keep trying the next warmup URL */
    }
  }
  cookieAt = Date.now();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @returns {Promise<Array>} raw NSE announcement objects, newest first.
 */
export async function fetchAnnouncements({ retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await warmup();
    try {
      const res = await fetch(ANN_URL, {
        headers: {
          ...BROWSER_HEADERS,
          Referer:
            'https://www.nseindia.com/companies-listing/corporate-filings-announcements',
          ...(cookieJar ? { Cookie: cookieJar } : {}),
        },
      });
      if (res.status === 401 || res.status === 403) {
        // Session likely stale/blocked — force a fresh warmup and retry.
        cookieJar = '';
        cookieAt = 0;
        lastErr = new Error(`NSE announcements responded ${res.status}`);
      } else if (!res.ok) {
        lastErr = new Error(`NSE announcements responded ${res.status}`);
      } else {
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('NSE returned unexpected payload');
        return data;
      }
    } catch (err) {
      lastErr = err;
    }
    if (attempt < retries) await sleep(1000 * 2 ** attempt);
  }
  throw lastErr || new Error('NSE fetch failed');
}

/** Normalise a raw NSE record into a stable shape used by the pipeline. */
export function normalize(raw) {
  const id =
    raw.seq_id ||
    raw.attchmntFile ||
    `${raw.symbol}-${raw.an_dt}`.replace(/\s+/g, '');
  return {
    id: String(id),
    symbol: raw.symbol || null,
    company: raw.sm_name || raw.symbol || 'Unknown',
    category: (raw.desc || '').trim(),
    headline: (raw.attchmntText || '').trim(),
    pdfUrl: raw.attchmntFile || null,
    announcedAt: raw.an_dt || raw.sort_date || null,
    industry: raw.smIndustry || null,
  };
}
