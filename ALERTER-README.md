# Order Alerter — run it on an RDP in one click

Posts every new order/contract win filed with **NSE or BSE** to your Telegram
group, in real time, 24/7. No editor or developer tools needed on the machine.

---

## Setup (once, ~5 minutes)

**1. Install Node.js on the RDP** — <https://nodejs.org>, take the **LTS**
button, click through the installer. Nothing else to configure.

**2. Copy this folder onto the RDP.** Anywhere is fine, e.g. `C:\OrderAlerter`.

**3. Create the credentials file.** In the `server` folder make a file called
`.env` (exactly that, no `.txt`) containing:

```ini
TELEGRAM_BOT_TOKEN=123456:AAH-your-token
TELEGRAM_CHAT_ID=-1001234567890
```

> Windows hides extensions by default, so "New → Text Document" can silently
> create `.env.txt`. In Notepad use **File → Save As**, set *Save as type* to
> **All Files**, and name it `.env`.

**4. Double-click `START-ALERTER.bat`.**

That's it. On first run it installs what it needs (a few minutes), posts the
**most recent order** to your group so you can see it working, then keeps
watching. Leave the window open — closing it stops the alerter.

Every later launch is instant.

---

## Where to get the two values

| Value | How |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Message **@BotFather** → `/newbot` → copy the token |
| `TELEGRAM_CHAT_ID` | Add the bot to your group **as an admin**, post any message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read `"chat":{"id":-100…}` |

The bot **must be an admin** in the group or Telegram silently blocks it.

---

## What an alert looks like

> 🚨 **NEW ORDER — Texmaco Rail & Engineering Ltd** (TEXRAIL)
> *NSE • 01 Aug 2026, 22:39 IST*
>
> 💰 **Value:** ₹351.16 Cr
> 🟡 **Order size:** 12.4% of revenue (rev ₹2,832.5 Cr)
> 🏢 **Customer:** JSW (South) Rail Logistics Pvt Ltd.
> 📦 **Nature:** Supply of wagons & spares
> ⏳ **Duration:** 12 months
> 📄 [Filing](https://nsearchives.nseindia.com/…)

🟢 ≥25% of revenue · 🟡 ≥5% · ⚪ smaller — a quick read on how material it is.

---

## Running 24/7

The `.bat` **restarts itself** if the program ever stops, so it survives
transient errors without help. For it to keep running you only need the RDP
session to stay alive — don't sign out; disconnecting is fine.

**To start automatically when Windows boots:** press `Win+R`, type
`shell:startup`, press Enter, and put a **shortcut** to `START-ALERTER.bat` in
the folder that opens.

**Logs:** `logs\alerter.log` (rotates at 5 MB, keeps 3 files). Everything the
window shows is written there too, so you can check what happened overnight.

**Health check (optional):** set `ALERT_HEARTBEAT_MS=43200000` in `server\.env`
to get a "still alive" message every 12 hours, so silence never leaves you
guessing.

---

## Normal behaviour, so you don't chase non-problems

- **Quiet overnight and at weekends.** Orders are filed during and shortly
  after market hours. No alerts then is correct.
- **First run posts one order, then goes quiet.** It records the existing
  backlog silently so your group isn't flooded with hundreds of old filings,
  then alerts on everything new from that point.
- **"NSE is refusing requests — pausing 120s"** in the log is normal and
  self-healing: the exchange rate-limited us, so the program waits instead of
  hammering it, which would extend the block.

## No duplicates — ever

Four layers, so the same order can't be posted twice:

1. **Filing id** — the feed re-lists every filing on each check
2. **Content fingerprint** — the *same order filed on both NSE and BSE*
   collapses into one alert (names are normalised, so
   `TEXMACO RAIL & ENGINEERING LIMITED` matches `Texmaco Rail & Engineering Ltd`)
3. **In-flight lock** — two overlapping checks can't both send it
4. **Saved to disk** — restarting, or rebooting the RDP, does not re-post
   anything

> Run **one copy only**. Two windows would each keep their own memory and
> double-post.

---

## Useful commands (optional)

Open a terminal in the folder (Shift + right-click → *Open PowerShell here*):

| Command | Does |
|---|---|
| `npm run alert:test` | posts a test message — confirms token, group and admin rights |
| `npm run alert:recent` | posts the 3 latest real orders |
| `npm run alert` | runs it without the `.bat` wrapper |

## If something's wrong

| Message | Fix |
|---|---|
| `401 Unauthorized` | wrong bot token |
| `400 chat not found` | wrong chat id — group ids start with `-100` |
| `403 Forbidden` | the bot isn't an admin in the group |
| `browser fallback unavailable` | run `npm --prefix server exec playwright install chromium` |
| No alerts for days *during* market hours | check `logs\alerter.log`, then run `npm run alert:test` |

To make it forget what it has already sent, delete
`server\data\alerted.json` — it re-baselines silently on the next start.
