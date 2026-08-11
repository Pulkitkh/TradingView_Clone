// Turns an order filing into a structured record using a TIERED strategy that
// keeps AI as a last resort:
//
//   1. Category gate  — NSE tags order filings with a specific category, so we
//      classify with a plain string match (no AI, no false positives).
//   2. Headline parse — free regex over the announcement headline; fills value/
//      customer/duration for the filings that include them in the text.
//   3. AI on PDF      — only when a value is still missing AND ANTHROPIC_API_KEY
//      is set. This is the only step that costs anything, and most filings
//      never reach it.
//
// Without an API key the pipeline still ingests every order (with "Not
// mentioned" where the text didn't carry a value — exactly like the real site).

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.EXTRACTION_MODEL || 'claude-sonnet-4-6';
const hasKey = !!process.env.ANTHROPIC_API_KEY;
const client = hasKey ? new Anthropic() : null;

export const extractorMode = hasKey ? 'ai-fallback' : 'no-ai';

// ---------------------------------------------------------------------------
// Tier 1: category classification (no AI)
// ---------------------------------------------------------------------------

// NSE announcement categories (the `desc` field) that mean the company RECEIVED
// an order/contract. "Awarding of order(s)/contract(s)" is the opposite side
// and "Action(s)/orders passed" are regulatory, so both are excluded.
const ORDER_CATEGORIES = new Set([
  'bagging/receiving of orders/contracts',
]);

export function isOrderFiling({ category, headline }) {
  const cat = (category || '').trim().toLowerCase();
  if (ORDER_CATEGORIES.has(cat)) return true;
  // Fallback for sources without a clean category: strong headline phrases.
  return STRONG_ORDER_RE.test(headline || '');
}

// ---------------------------------------------------------------------------
// Tier 2: headline / text regex parsing (no AI)
// ---------------------------------------------------------------------------

const STRONG_ORDER_RE =
  /(receipt of (?:order|letter)|letter of (?:intent|acceptance|award)|work order|purchase order|supply order|bags?\s+order|bagged\s+order|secures?\s+order|received an order|order worth|contract worth)/i;

// "Rs. 350.5 crore", "₹1,256.30 Cr", "INR 60 crores", "Rs 4.71 Crores"
const AMOUNT_RE =
  /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d+)?)\s*(crores?|cr\.?|lakhs?|millions?|mn|billions?|bn)\b/i;

// Plain rupee amounts with no unit word, which BSE headlines use constantly:
//   "work order of Rs. 19,78,77,660/-"   "₹1,25,00,000"
// Indian digit grouping (2,2,3) as well as western (3,3,3). Requires at least
// 6 digits so we never read a document number or a year as money.
const PLAIN_RUPEE_RE = /(?:rs\.?|inr|₹)\s*((?:\d{1,3}(?:,\d{2,3})+|\d{6,})(?:\.\d+)?)\s*(?!\s*(?:crores?|cr\b|lakhs?|millions?|mn|billions?|bn))/i;

const ORDER_TYPE_RE =
  /(letter of intent|letter of acceptance|letter of award|work order|purchase order|supply order|epc contract|turnkey contract|work contract|contract|order)/i;

function toCrore(value, unit) {
  const n = parseFloat(String(value).replace(/,/g, ''));
  if (Number.isNaN(n)) return null;
  const u = unit.toLowerCase();
  if (u.startsWith('cr')) return n;
  if (u.startsWith('lakh')) return n / 100;
  if (u.startsWith('million') || u === 'mn') return n / 10;
  if (u.startsWith('billion') || u === 'bn') return n * 100;
  return n;
}

function titleCase(s) {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bOf\b/g, 'of');
}

export function parseHeadline({ headline, text }) {
  const blob = `${headline || ''}\n${text || ''}`;

  // Prefer an amount that states its unit; fall back to a plain rupee figure
  // (BSE headlines usually write the full number instead of "crore").
  const amt = blob.match(AMOUNT_RE);
  let contractValueCr = amt ? toCrore(amt[1], amt[2]) : null;
  if (contractValueCr == null) {
    const plain = blob.match(PLAIN_RUPEE_RE);
    if (plain) {
      const rupees = parseFloat(plain[1].replace(/,/g, ''));
      if (!Number.isNaN(rupees)) contractValueCr = +(rupees / 1e7).toFixed(2);
    }
  }

  const dur = blob.match(/(\d+)\s*(months?|years?|weeks?|days?)/i);
  const duration = dur ? `${dur[1]} ${dur[2].toLowerCase()}` : null;

  const cust = blob.match(
    /from\s+((?:[A-Z][\w&.'-]*\s*){1,6}?)(?=\s+(?:for|to|towards|over|worth|valued|amounting|of|on|under|,|\.|\n|$))/
  );
  const customer = cust ? cust[1].trim().replace(/[.,]$/, '') : null;

  const typeM = (headline || '').match(ORDER_TYPE_RE);
  const orderType = typeM ? titleCase(typeM[1]) : null;

  return { contractValueCr, duration, customer, orderType };
}

// ---------------------------------------------------------------------------
// Tier 3: AI extraction over PDF text (only when needed)
// ---------------------------------------------------------------------------

const SYSTEM = `You extract structured data about an order/contract an Indian
listed company disclosed to the stock exchange. You are given a headline and the
text of the filing PDF. Reply with ONLY a JSON object, no prose:
{
  "customer": string|null,        // who placed/awarded the order
  "orderType": string|null,       // e.g. "EPC Contract", "Supply Order", "Letter of Acceptance"
  "contractValueCr": number|null, // total order value in INR crore
  "duration": string|null,        // execution period, e.g. "12 months"
  "annualValueCr": number|null,   // per-year value if derivable, else same as contractValueCr
  "summary": string|null          // one short sentence describing the order
}
Use null for anything not stated. Never guess a number.`;

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
// Orchestration
// ---------------------------------------------------------------------------

// Keep the first value for each field, filling only the gaps from `extra`.
function fillGaps(base, extra) {
  return {
    contractValueCr: base.contractValueCr ?? extra.contractValueCr ?? null,
    duration: base.duration ?? extra.duration ?? null,
    customer: base.customer ?? extra.customer ?? null,
    orderType: base.orderType ?? extra.orderType ?? null,
  };
}

/**
 * Extract order fields with the tiered strategy. The caller has already
 * confirmed it's an order (via isOrderFiling). `getPdfText` is an optional
 * async fn that returns the filing's PDF text — used by the free PDF-regex
 * tier and the AI tier, fetched at most once.
 *
 * @returns {Promise<object>} order fields (values may be null / "Not mentioned")
 */
export async function extractOrder(filing, getPdfText) {
  // Tier 2: headline regex (free).
  let fields = parseHeadline(filing);
  let by = fields.contractValueCr != null ? 'headline' : null;
  let pdfText = filing.text || '';
  let summary = null;

  // Tier 2.5: PDF-text regex (free) — fetch the PDF once if we still lack a
  // value. Order filings are low-volume, so this is cheap and AI-free.
  if (fields.contractValueCr == null && (pdfText || getPdfText)) {
    if (!pdfText && getPdfText) pdfText = await getPdfText();
    if (pdfText) {
      const fromPdf = parseHeadline({ headline: '', text: pdfText });
      // A "from X" match in dense PDF text is noisy; only trust longer names.
      if (fromPdf.customer && fromPdf.customer.length < 5) fromPdf.customer = null;
      fields = fillGaps(fields, fromPdf);
      if (fromPdf.contractValueCr != null && !by) by = 'pdf-regex';
    }
  }

  // Tier 3: AI on the PDF text — only if still missing a value AND key present.
  if (client && fields.contractValueCr == null && pdfText) {
    try {
      const ai = await aiExtract({ ...filing, text: pdfText });
      fields = fillGaps(
        {
          contractValueCr: ai.contractValueCr ?? null,
          duration: ai.duration ?? null,
          customer: ai.customer ?? null,
          orderType: ai.orderType ?? null,
        },
        fields
      );
      if (ai.annualValueCr != null) fields.annualValueCr = ai.annualValueCr;
      summary = ai.summary || null;
      if (ai.contractValueCr != null) by = 'ai';
    } catch {
      /* keep the regex-parsed fields */
    }
  }

  return {
    customer: fields.customer || 'Not mentioned',
    orderType: fields.orderType || 'Not mentioned',
    contractValueCr: fields.contractValueCr ?? null,
    duration: fields.duration || 'Not mentioned',
    annualValueCr: fields.annualValueCr ?? fields.contractValueCr ?? null,
    summary: summary || filing.headline || null,
    _extractedBy: by || 'none',
  };
}
