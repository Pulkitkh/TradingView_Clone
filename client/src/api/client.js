const BASE = '/api';

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || body.error || detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json();
}

export function fetchOrders({ company, customer, minOrderSize } = {}) {
  const params = new URLSearchParams();
  if (company) params.set('company', company);
  if (customer) params.set('customer', customer);
  if (minOrderSize) params.set('minOrderSize', minOrderSize);
  const qs = params.toString();
  return getJson(`${BASE}/orders${qs ? `?${qs}` : ''}`);
}

export function fetchFacets() {
  return getJson(`${BASE}/orders/facets`);
}

export function fetchCompany(symbol, consolidated = true) {
  return getJson(
    `${BASE}/company/${encodeURIComponent(symbol)}?consolidated=${consolidated}`
  );
}
