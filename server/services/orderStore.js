// In-memory store of extracted orders, persisted to disk so restarts keep
// history. Dedupes by filing id and keeps newest-first.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, '..', 'data', 'live-orders.json');
const MAX_ORDERS = 1000;

let orders = [];
const seen = new Set();
const listeners = new Set(); // SSE subscribers

export async function init() {
  try {
    const raw = await readFile(STORE_PATH, 'utf-8');
    orders = JSON.parse(raw);
    orders.forEach((o) => seen.add(o.id));
  } catch {
    orders = [];
  }
}

async function persist() {
  try {
    await mkdir(dirname(STORE_PATH), { recursive: true });
    await writeFile(STORE_PATH, JSON.stringify(orders.slice(0, MAX_ORDERS), null, 2));
  } catch {
    /* non-fatal */
  }
}

export function has(id) {
  return seen.has(id);
}

export function getAll() {
  return orders;
}

/** Add a new order to the top; returns false if it was a duplicate. */
export async function add(order) {
  if (seen.has(order.id)) return false;
  seen.add(order.id);
  orders.unshift(order);
  if (orders.length > MAX_ORDERS) orders.length = MAX_ORDERS;
  await persist();
  for (const fn of listeners) {
    try {
      fn(order);
    } catch {
      /* ignore broken subscriber */
    }
  }
  return true;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
