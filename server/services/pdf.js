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
    // Normalise the odd spacing PDFs produce — non-breaking/zero-width spaces
    // and runs of whitespace — WITHOUT deleting ordinary spaces, or the text
    // collapses into unsearchable soup ("BEMLSoudha", "Rs.19crore").
    return (result.text || '')
      .replace(/[   ]/g, ' ')
      .replace(/[​-‍﻿]/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return '';
  }
}

/** Convenience: fetch a URL and return its extracted text (best effort). */
export async function pdfTextFromUrl(url) {
  const buf = await downloadPdf(url);
  return extractText(buf);
}
