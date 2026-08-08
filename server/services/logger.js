// Console + rotating file logging.
//
// On a 24/7 RDP box nobody is watching the console, and a terminal scrollback
// is not a record. Everything is mirrored to logs/alerter.log, rotated at a
// size cap so it can never fill the disk.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.LOG_DIR || path.resolve(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'alerter.log');
const MAX_BYTES = Number(process.env.LOG_MAX_BYTES || 5 * 1024 * 1024); // 5 MB
const KEEP = Number(process.env.LOG_KEEP || 3);

let stream = null;

function open() {
  if (stream) return stream;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  } catch {
    stream = null; // logging must never take the process down
  }
  return stream;
}

function rotateIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    if (fs.statSync(LOG_FILE).size < MAX_BYTES) return;
    if (stream) {
      stream.end();
      stream = null;
    }
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      const to = `${LOG_FILE}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    /* ignore rotation problems */
  }
}

function ts() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).replace('T', ' ');
}

function write(level, args) {
  const line = `${ts()} ${level} ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  const out = level === 'ERROR' || level === 'WARN' ? console.error : console.log;
  out(line);
  rotateIfNeeded();
  const s = open();
  if (s) s.write(`${line}\n`);
}

export const log = {
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
  file: LOG_FILE,
};
