# Telegram Order Alerter

A **standalone program** (`server/alerter.js`) that watches NSE + BSE and posts
every new order win to a Telegram group in real time. It is independent of the
website — you can run it alone, on a different machine, or alongside the site.

```
NSE para-b XBRL ─┐
                 ├─→ extract → enrich (revenue) → de-dupe → Telegram group
BSE announcements┘
```

---

## 1. Create the bot

1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts.
2. Copy the **token** it gives you (looks like `1234567890:AAH...`).

## 2. Add the bot to your group

1. Add the bot to your group.
2. **Promote it to admin** (Telegram blocks bots from posting in many groups
   otherwise) — it only needs "Post Messages".

## 3. Get the group's chat id

Post any message in the group, then:

```bash
curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates" | grep -o '"chat":{"id":[-0-9]*'
```

Group ids are **negative**, e.g. `-1001234567890`. (For a channel, use the
channel id and add the bot as an admin there instead.)

## 4. Configure

In `server/.env`:

```ini
TELEGRAM_BOT_TOKEN=1234567890:AAH...
TELEGRAM_CHAT_ID=-1001234567890
```

## 5. Run

```bash
npm run alert                                  # foreground
pm2 start ecosystem.config.cjs --only alerter  # background, restarts forever
pm2 logs alerter                               # watch it
```

**First run posts nothing.** It records the existing backlog silently so your
group isn't flooded with hundreds of historical filings, then alerts on
everything new from that point. To post the backlog anyway, set
`ALERT_BACKLOG=true` once.

---

## What an alert looks like

> 🚨 **NEW ORDER — Texmaco Rail & Engineering Ltd** (TEXRAIL)
> *NSE • 01 Jul 2026, 22:39 IST*
>
> 💰 **Value:** ₹351.16 Cr
> 🟡 **Order size:** 12.4% of revenue (rev ₹2,832.5 Cr FY25)
> 🏢 **Customer:** JSW (South) Rail Logistics Pvt Ltd.
> 📦 **Nature:** Supply of wagons & spares
> ⏳ **Duration:** 12 months
> 📅 **Order received:** 2026-06-30
>
> 📄 [Filing](https://nsearchives.nseindia.com/…)

The dot before "Order size" is a quick materiality cue: 🟢 ≥25% of revenue,
🟡 ≥5%, ⚪ below that.

---

## Duplicate protection

Four independent layers — the group never sees the same order twice:

| Layer | Catches |
|---|---|
| **Filing id** | the same filing re-appearing in later polls (the feed keeps ~200 rows, so every filing is seen many times) |
| **Content fingerprint** | the **same order filed on both NSE and BSE** — company, value, day and customer are normalised (`TEXMACO RAIL & ENGINEERING LIMITED` ≡ `Texmaco Rail & Engineering Ltd`), so cross-exchange twins collapse to one alert |
| **In-flight lock** | a slow send being started twice by overlapping polls |
| **Disk persistence** | a **restart** re-alerting everything — state is saved atomically to `server/data/alerted.json` |

A failed send is *released* rather than recorded, so it retries on the next
poll instead of being lost.

> ⚠️ Run **only one instance**. Two processes sharing a group will double-post,
> because each keeps its own state file. The PM2 config pins `instances: 1`.

## Tuning (`server/.env`)

| Var | Default | Purpose |
|---|---|---|
| `ALERT_POLL_MS` | 60000 | how often to check for new orders |
| `ALERT_SEND_GAP_MS` | 3500 | spacing between messages (Telegram allows ~20/min/group) |
| `ALERT_MIN_VALUE_CR` | 0 | only alert orders ≥ this value (e.g. `50` for big orders only) |
| `ALERT_MAX_PER_POLL` | 15 | flood guard; extras roll to the next cycle |
| `ALERT_BACKLOG` | false | `true` posts the existing backlog on first run |
| `DISABLE_BSE` | – | `true` runs NSE only |

Telegram rate limits are handled automatically: on HTTP 429 the alerter waits
exactly the `retry_after` the API asks for, then continues.

## Resetting

To make it forget what it has alerted (it will then re-baseline silently):

```bash
rm server/data/alerted.json
```
