# Deploying to trendingdata.in

The app runs as **one Node process** that serves both the API and the built
frontend, with a poller loop ingesting NSE + BSE filings continuously. nginx
terminates TLS and proxies to it.

> **Host requirement:** the server must be **always-on** and have an **India IP**.
> NSE/BSE block most foreign and datacenter IPs, and the poller is a continuous
> loop, so serverless (Vercel/Netlify functions) will not work for the backend.
> Use an India-region VPS — DigitalOcean Bangalore, AWS Mumbai, Azure Central
> India, Hetzner+India proxy, or an Indian provider. 1 vCPU / 2 GB RAM is enough
> (2 GB matters: headless Chromium is used to bypass exchange bot protection).

---

## 1. Point the domain at the server

In your DNS provider for `trendingdata.in`:

| Type | Name | Value |
|------|------|-------|
| A    | `@`  | `<server-public-IP>` |
| A    | `www`| `<server-public-IP>` |

Wait for propagation (`ping trendingdata.in` should show your IP).

## 2. Server prerequisites

```bash
sudo apt update && sudo apt install -y curl git nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

## 3. Get the code and build

```bash
sudo mkdir -p /var/www && sudo chown $USER /var/www
cd /var/www
git clone <your-repo-url> trendingdata
cd trendingdata

cp .env.example server/.env      # edit if you want Telegram / tuning
npm run setup:prod               # installs deps + Chromium + builds the frontend
```

`setup:prod` installs Playwright's Chromium, which the fetcher falls back to
when the exchanges' bot protection blocks a plain request. If Chromium needs
system libraries:

```bash
sudo npx playwright install-deps chromium
```

## 4. Run it under PM2 (survives crashes and reboots)

```bash
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup        # run the command it prints, then `pm2 save` again
```

Check it: `pm2 logs trendingdata` — you should see
`[poller] starting — NSE + BSE` and `[order] (NSE) …` / `[order] (BSE) …` lines.

## 5. nginx + HTTPS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/trendingdata.in
sudo ln -s /etc/nginx/sites-available/trendingdata.in /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d trendingdata.in -d www.trendingdata.in
```

Certbot adds the TLS block and the HTTP→HTTPS redirect, and auto-renews.

The nginx config disables buffering on `/api/orders/stream` — required, or the
live (SSE) feed stalls behind the proxy.

## 6. Verify

```bash
curl -s https://trendingdata.in/api/health          # {"ok":true}
curl -s https://trendingdata.in/api/orders | head   # order JSON
```

Open <https://trendingdata.in> — orders should render immediately, newest first,
with the LIVE indicator active.

---

## How "always fresh on open" works

- The poller writes every new order to `server/data/live-orders.json`.
- On boot the store loads that file **before** the server starts listening, so a
  visitor sees the full backlog instantly — no waiting for the first poll.
- The page then subscribes to `/api/orders/stream` (SSE) and new orders appear
  live without a refresh.
- `index.html` is served `no-cache` while hashed assets are immutable, so a
  deploy never leaves users on a stale bundle.

## Updating after a code change

```bash
cd /var/www/trendingdata && npm run deploy      # git pull + build + pm2 restart
```

## Tuning (server/.env)

| Var | Default | Purpose |
|-----|---------|---------|
| `POLL_INTERVAL_MS` | 60000 | how often to check the exchanges |
| `BASELINE_MAX` | 25 | orders ingested per exchange on first boot |
| `FETCH_GAP_MS` | 500 | min gap between fetches; raise to 800+ if rate-limited |
| `BSE_DAYS` | 2 | recent days of BSE filings to scan |
| `DISABLE_BSE` | – | set `true` to run NSE only |

**If you see 403s in the logs:** the exchanges are rate-limiting. Raise
`FETCH_GAP_MS` and/or `POLL_INTERVAL_MS`. Confirm Chromium is present with
`npm --prefix server exec playwright install chromium`.

## Operations

```bash
pm2 logs trendingdata --lines 100    # live logs
pm2 restart trendingdata             # restart
pm2 monit                            # CPU/memory
```

Back up `server/data/live-orders.json` — it holds the accumulated order history.
