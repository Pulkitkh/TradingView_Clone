// Optional Telegram alerting. Posts each new order to a channel/chat, mirroring
// the standalone poller script. No-op unless TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
// are set.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

export const telegramEnabled = !!(TOKEN && CHAT_ID);

const fmtCr = (v) =>
  v == null ? null : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`;

function escapeMd(s) {
  return String(s).replace(/([_*`\[])/g, '\\$1');
}

export function formatOrderAlert(o) {
  const lines = [`🚨 *NEW ORDER: ${escapeMd(o.company)} (${escapeMd(o.symbol || '')})*`];
  if (o._flag) lines.push(`⚠️ ${escapeMd(o._flag)}`);
  if (o.contractValueCr != null) lines.push(`• Value: ${fmtCr(o.contractValueCr)}`);
  if (o.orderSizePct != null) lines.push(`• Order size: ${o.orderSizePct}% of revenue`);
  if (o.orderType && o.orderType !== 'Not mentioned')
    lines.push(`• Type: ${escapeMd(o.orderType).slice(0, 200)}`);
  if (o.customer && o.customer !== 'Not mentioned')
    lines.push(`• Customer: ${escapeMd(o.customer)}`);
  if (o.duration && o.duration !== 'Not mentioned')
    lines.push(`• Duration: ${escapeMd(o.duration).slice(0, 120)}`);
  if (o.pdfUrl) lines.push(`• [Source PDF](${o.pdfUrl})`);
  return lines.join('\n');
}

export async function sendOrderAlert(order) {
  if (!telegramEnabled) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: formatOrderAlert(order),
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.warn('[telegram] send failed', res.status, (await res.text()).slice(0, 160));
    }
  } catch (err) {
    console.warn('[telegram] send error', err.message);
  }
}
