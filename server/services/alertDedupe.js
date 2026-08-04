// Persistent de-duplication for the Telegram alerter.
//
// Three layers, because "already alerted" has three different meanings:
//   1. filing id      — the exact same filing seen again in a later poll
//   2. fingerprint    — the SAME order filed on both NSE and BSE, or re-filed
//                       as a revision: company + value + award/announce day
//   3. in-flight lock — a send already underway for this key, so a slow send
//                       can't be started twice by overlapping polls
//
// State is written to disk, so a restart does NOT re-alert the whole backlog.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH =
  process.env.ALERT_STATE_PATH || path.join(__dirname, '..', 'data', 'alerted.json');
const MAX_KEYS = Number(process.env.ALERT_MAX_KEYS || 20000); // bounded history

let ids = new Set(); // filing ids
let prints = new Set(); // content fingerprints
const inFlight = new Set(); // keys currently being sent
let order = []; // insertion order, for pruning
let dirty = false;
let saveTimer = null;

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(limited|ltd|private|pvt|india|industries|company|co|corporation|corp|the)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Content fingerprint: identifies the same order regardless of which exchange
 * filed it. Value is rounded to 2dp and the date to the day, because NSE and
 * BSE often differ in trailing precision / dissemination minute.
 */
export function fingerprint(o) {
  const company = norm(o.company);
  const value = o.contractValueCr == null ? 'na' : Number(o.contractValueCr).toFixed(2);
  const day = String(o.date || '').slice(0, 10);
  // Value alone can repeat across days; include the customer when we have one
  // so two genuinely different same-value orders aren't collapsed.
  const cust = norm(o.customer) || 'na';
  return `${company}|${value}|${day}|${cust}`;
}

export async function init() {
  try {
    const raw = JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
    ids = new Set(raw.ids || []);
    prints = new Set(raw.prints || []);
    order = raw.order || [...ids];
  } catch {
    ids = new Set();
    prints = new Set();
    order = [];
  }
  return { ids: ids.size, prints: prints.size };
}

/** True if this order was already alerted (by id or by content). */
export function alreadyAlerted(o) {
  if (ids.has(o.id)) return true;
  if (inFlight.has(o.id)) return true;
  const fp = fingerprint(o);
  if (prints.has(fp)) return true;
  if (inFlight.has(fp)) return true;
  return false;
}

/** Claim an order for sending. Returns false if another send already owns it. */
export function claim(o) {
  if (alreadyAlerted(o)) return false;
  inFlight.add(o.id);
  inFlight.add(fingerprint(o));
  return true;
}

/** Release a claim without recording it (send failed — allow a later retry). */
export function release(o) {
  inFlight.delete(o.id);
  inFlight.delete(fingerprint(o));
}

/** Record an order as alerted (also releases the in-flight claim). */
export function markAlerted(o) {
  const fp = fingerprint(o);
  inFlight.delete(o.id);
  inFlight.delete(fp);
  if (!ids.has(o.id)) {
    ids.add(o.id);
    order.push(o.id);
  }
  prints.add(fp);
  dirty = true;
  scheduleSave();
}

/**
 * Record without sending — used to baseline the existing backlog on first run
 * so the group isn't flooded with historical filings.
 */
export function markSeenSilently(o) {
  if (!ids.has(o.id)) {
    ids.add(o.id);
    order.push(o.id);
  }
  prints.add(fingerprint(o));
  dirty = true;
}

function prune() {
  if (order.length <= MAX_KEYS) return;
  const drop = order.splice(0, order.length - MAX_KEYS);
  for (const id of drop) ids.delete(id);
  // prints are cheap strings; clear the oldest half if it grows unbounded
  if (prints.size > MAX_KEYS * 2) prints = new Set([...prints].slice(-MAX_KEYS));
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save().catch(() => {});
  }, 1000);
  saveTimer.unref?.();
}

export async function save() {
  if (!dirty) return;
  prune();
  dirty = false;
  const tmp = `${STATE_PATH}.tmp`;
  const payload = JSON.stringify({
    ids: [...ids],
    prints: [...prints],
    order,
    savedAt: new Date().toISOString(),
  });
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(tmp, payload); // atomic: write then rename
  await fs.rename(tmp, STATE_PATH);
}

export function stats() {
  return { ids: ids.size, prints: prints.size, inFlight: inFlight.size };
}
