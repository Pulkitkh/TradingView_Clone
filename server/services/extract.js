// Turns a raw filing (headline + PDF text) into a structured order record.
//
// Two modes:
//  - AI mode (preferred): if ANTHROPIC_API_KEY is set, Claude classifies the
//    filing and extracts fields as strict JSON. This mirrors how the real
//    product works ("extracted using AI").
//  - Heuristic mode (fallback): keyword + regex extraction so the pipeline
//    still runs end-to-end without an API key (lower accuracy).

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.EXTRACTION_MODEL || 'claude-sonnet-4-6';
const hasKey = !!process.env.ANTHROPIC_API_KEY;
const client = hasKey ? new Anthropic() : null;

export const extractorMode = hasKey ? 'ai' : 'heuristic';

const ORDER_KEYWORDS = [
  'order', 'contract', 'awarded', 'award of', 'letter of award', 'loa',
  'work order', 'bags', 'bagged', 'wins', 'secures', 'receipt of order',
  'purchase order', 'supply order', 'tender', 'e-auction', 'work contract',
];

/** Cheap pre-filter so we only spend AI calls on plausibly-order filings. */
export function looksLikeOrder({ headline, category }) {
  const blob = `${headline || ''} ${category || ''}`.toLowerCase();
  return ORDER_KEYWORDS.some((k) => blob.includes(k));
}

// ---------------------------------------------------------------------------
// AI extraction
// ---------------------------------------------------------------------------

const SYSTEM = `You extract structured data about business orders/contracts that
Indian listed companies disclose to the stock exchange. You are given a filing's
headline and the text of its PDF. Decide whether the filing announces the company
RECEIVING an order/contract/work award. Reply with ONLY a JSON object, no prose.

Schema:
{
  "isOrder": boolean,            // true only if the company received an order/contract
  "customer": string|null,       // who placed the order (client/awarder), null if not stated
  "orderType": string|null,      // e.g. "EPC Contract", "Supply Order", "Work Order"
  "contractValueCr": number|null,// total order value in INR crore (convert if given in other units)
  "duration": string|null,       // execution period if stated, e.g. "12 months"
  "annualValueCr": number|null,  // value per year if derivable, else equal to contractValueCr for one-off
  "summary": string|null         // one short sentence describing the order
}
If it is not an order filing, return {"isOrder": false} and nulls for the rest.`;

async function aiExtract({ company, headline, text }) {
  const content = `Company: ${company}\nHeadline: ${headline}\n\nPDF text (truncated):\n${(text || '').slice(0, 12000)}`;
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  });
  const raw = msg.content?.[0]?.type === 'text' ? msg.content[0].text : '{}';
  const jsonStr = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  return JSON.parse(jsonStr);
}

// ---------------------------------------------------------------------------
// Heuristic extraction (fallback)
// ---------------------------------------------------------------------------

// Matches amounts like "Rs. 350.5 crore", "₹1,256.30 Cr", "INR 60 crores".
const AMOUNT_RE =
  /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d+)?)\s*(crore|cr\.?|lakh|lakhs|million|mn|billion|bn)\b/i;

function toCrore(value, unit) {
  const n = parseFloat(String(value).replace(/,/g, ''));
  if (Number.isNaN(n)) return null;
  const u = unit.toLowerCase();
  if (u.startsWith('cr')) return n;
  if (u.startsWith('lakh')) return n / 100;
  if (u.startsWith('million') || u === 'mn') return n / 10; // 1 mn = 0.1 cr
  if (u.startsWith('billion') || u === 'bn') return n * 100;
  return n;
}

// Explicit phrases that strongly indicate an order receipt (vs. a stray
// occurrence of the word "order" in some unrelated filing).
const STRONG_ORDER_RE =
  /(receipt of order|award of order|awarding of order|letter of award|work order|purchase order|supply order|bags?\s+(?:an?\s+)?order|bagged\s+(?:an?\s+)?order|secures?\s+(?:an?\s+)?order|wins?\s+(?:an?\s+)?order|received\s+(?:an?\s+)?(?:order|contract)|order worth|contract worth)/i;

function heuristicExtract({ headline, category, text }) {
  const blob = `${headline || ''}\n${text || ''}`;
  const m = blob.match(AMOUNT_RE);
  const contractValueCr = m ? toCrore(m[1], m[2]) : null;

  // In heuristic mode, only treat it as an order when there's a strong order
  // phrase or a parseable order value — generic keyword hits are too noisy.
  const strong =
    STRONG_ORDER_RE.test(blob) || STRONG_ORDER_RE.test(category || '');
  if (!strong && contractValueCr == null) return { isOrder: false };

  const durMatch = blob.match(/(\d+)\s*(months?|years?|weeks?)/i);
  const duration = durMatch ? `${durMatch[1]} ${durMatch[2].toLowerCase()}` : null;

  // Capture the customer name after "from", stopping at the next clause word.
  const custMatch = blob.match(
    /from\s+((?:[A-Z][\w&.'-]*\s*){1,6}?)(?=\s+(?:for|to|towards|over|worth|valued|amounting|of|on|under|,|\.|\n|$))/
  );
  const customer = custMatch ? custMatch[1].trim().replace(/[.,]$/, '') : null;

  return {
    isOrder: true,
    customer,
    orderType: null,
    contractValueCr,
    duration,
    annualValueCr: contractValueCr,
    summary: (headline || '').slice(0, 160) || null,
  };
}

/**
 * Extract an order from a filing. Returns null if it is not an order.
 * @returns {Promise<object|null>}
 */
export async function extractOrder(filing) {
  let result;
  try {
    result = client ? await aiExtract(filing) : heuristicExtract(filing);
  } catch (err) {
    // On AI failure, degrade gracefully to heuristics rather than dropping.
    result = heuristicExtract(filing);
    result._aiError = err.message;
  }
  if (!result || !result.isOrder) return null;
  return {
    customer: result.customer || 'Not mentioned',
    orderType: result.orderType || 'Not mentioned',
    contractValueCr: result.contractValueCr ?? null,
    duration: result.duration || 'Not mentioned',
    annualValueCr: result.annualValueCr ?? result.contractValueCr ?? null,
    summary: result.summary || filing.headline || null,
  };
}
