// Downloads a filing PDF (with the shared Akamai-aware browser fallback) and
// extracts its text layer. Some filings are scanned images with no text layer —
// those return little/no text and the value simply stays unknown.

import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { fetchBuffer } from './browserFetch.js';

export async function downloadPdf(url) {
  return fetchBuffer(url);
}

export async function extractText(buffer) {
  try {
    const result = await pdfParse(buffer);
    return (result.text || '').replace(/ /g, '').trim();
  } catch {
    return '';
  }
}

/** Convenience: fetch a URL and return its extracted text (best effort). */
export async function pdfTextFromUrl(url) {
  const buf = await downloadPdf(url);
  return extractText(buf);
}
