# HF Wrapper

Generic Hugging Face Space wrapper that fixes three HF Space limitations:

1. **Blocked outbound API calls** — HF Spaces blocks many external APIs (Telegram,
   Discord, Twitter, OpenAI, etc.). A Cloudflare Worker proxy transparently routes
   blocked domains through your own worker.

2. **Space sleeps after inactivity** — A Cloudflare cron Worker pings your Space
   every 10 minutes (configurable) to keep it awake.

3. **Ephemeral container storage** — Optional HF Dataset backup/restore persists
   a single file (e.g. a SQLite database) across restarts.

## Architecture

```
                          ┌──────────────────────────────────┐
                          │       Hugging Face Space         │
                          │                                  │
  Cloudflare              │  ┌───────────────────────────┐  │
  KeepAlive Worker ─────┐ │  │  health-server.js         │  │
  (cron: */10 * * * *)  │ │  │  (port 7860 or            │  │
                        │ │  │   HEALTH_SERVER_PORT)     │  │
                        │ │  └───────────────────────────┘  │
                        │ │                                  │
  Cloudflare            │ │  ┌───────────────────────────┐  │
  Proxy Worker ───────────┤  │  Your App                  │  │
  (HTTP/HTTPS only,      │ │  │  (port via APP_START_CMD) │  │
   transparent via        │ │  └───────────────────────────┘  │
   NODE_OPTIONS for       │ │                                  │
   Node.js apps)          │ │  ┌───────────────────────────┐  │
                          │ │  │  sync.py (bg loop)        │  │
  HF Dataset ───────────────┤  │  single-file backup       │  │
  (optional)               │ │  └───────────────────────────┘  │
                           │ └──────────────────────────────────┘
                           └──────────────────────────────────┘
```

> **Proxy scope:** The Cloudflare proxy handles **HTTP/HTTPS** traffic to
> blocked domains. Node.js apps get transparent coverage via
> `NODE_OPTIONS --require`. Python apps need manual configuration (see
> Troubleshooting). Non-HTTP protocols (e.g., Telegram MTProto used by
> TelePlay) are not affected by HF's HTTP domain blocks and may work
> directly.

## Quick Start

The wrapper scripts are designed to be used with a self-contained Dockerfile
that builds from `python:3.11-slim` directly. See `teleplay-backend/Dockerfile`
for the canonical example — no registry push needed.

The key pattern:

```dockerfile
FROM python:3.11-slim
# ... install deps ...
COPY hf-wrapper/start.sh /opt/hf-wrapper/start.sh
COPY hf-wrapper/sync.py  /opt/hf-wrapper/sync.py
# ... copy other wrapper scripts ...
ENV HEALTH_SERVER_PORT=7861
ENV APP_START_CMD="uvicorn app.main:app --host 0.0.0.0 --port 7860"
ENTRYPOINT ["/opt/hf-wrapper/start.sh"]
```

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `APP_START_CMD` | Command to start your application (runs in foreground) |
| `CLOUDFLARE_WORKERS_TOKEN` | Cloudflare API token with Workers Scripts:Edit permission |
| `SPACE_URL` | Public URL of your HF Space (used for keep-alive pings) |

### Optional

| Variable | Default | Description |
|---|---|---|
| `HF_TOKEN` | — | HF token with write access for dataset backup |
| `HF_USERNAME` | — | HF username (auto-detected from token if unset) |
| `HF_DATASET` | — | HF Dataset name for backup (e.g. `myapp-backup`) |
| `SYNC_FILE` | — | Path to file to back up (e.g. `/app/data/db.sqlite`) |
| `SYNC_INTERVAL` | `300` | Backup interval in seconds |
| `CLOUDFLARE_PROXY_URL` | — | Existing Cloudflare Worker URL (skip auto-setup) |
| `CLOUDFLARE_PROXY_SECRET` | — | Shared secret for the proxy worker |
| `CLOUDFLARE_PROXY_DOMAINS` | *(default list)* | Comma-separated extra domains to proxy, or `*` for all |
| `CLOUDFLARE_ACCOUNT_ID` | *(auto-detected)* | Cloudflare account ID (override for multi-account tokens) |
| `CLOUDFLARE_WORKER_NAME` | *(auto-derived)* | Custom name for the proxy Worker script |
| `CLOUDFLARE_KEEPALIVE_ENABLED` | `true` | Set to `false` to disable keep-awake |
| `CLOUDFLARE_KEEPALIVE_CRON` | `*/10 * * * *` | Cron expression for keep-alive pings |
| `CLOUDFLARE_KEEPALIVE_URL` | *(auto-derived)* | Target URL for keep-alive pings (default: `https://{SPACE_HOST}/health`) |
| `CLOUDFLARE_KEEPALIVE_WORKER_NAME` | *(auto-derived)* | Custom name for the keepalive Worker script |
| `SPACE_HOST` | *(auto-detected)* | HF Space hostname (auto-set by HF; derived from `SPACE_URL` if not set) |
| `SPACE_AUTHOR_NAME` | *(auto-detected)* | HF Space author (fallback for SPACE_HOST auto-detection) |
| `SPACE_REPO_NAME` | *(auto-detected)* | HF Space repo name (fallback for SPACE_HOST auto-detection) |
| `HEALTH_SERVER_PORT` | `7860` | Port for the health server (change to avoid conflict with your app) |

### Default proxied domains

```
api.telegram.org, discord.com, discordapp.com, gateway.discord.gg,
status.discord.com, web.whatsapp.com, graph.facebook.com,
graph.instagram.com, api.twitter.com, api.x.com, upload.twitter.com,
api.linkedin.com, www.linkedin.com, open.tiktokapis.com,
oauth.reddit.com, youtube.com, www.youtube.com, api.openai.com,
api.resend.com, api.sendgrid.com, api.mailgun.net, googleapis.com,
google.com, googleusercontent.com, gstatic.com
```

## Port 7860

Hugging Face Spaces only exposes port **7860** externally. By default, the
health server listens on this port. Your app needs port 7860 to receive
external traffic.

**If your app needs port 7860** (e.g., TelePlay backend), set
`HEALTH_SERVER_PORT` to a different value so the health server moves to an
internal port and your app takes 7860:

```dockerfile
ENV HEALTH_SERVER_PORT=7861
ENV APP_START_CMD="uvicorn app.main:app --host 0.0.0.0 --port 7860"
```

HF Spaces health checks still work if your app serves its own `/health`
endpoint (TelePlay does — `GET /health` returns `{"status": "healthy"}`).
The Dockerfile `HEALTHCHECK` uses `HEALTH_SERVER_PORT` and follows
automatically.

**Options summary:**

| Approach | When to use |
|---|---|
| `HEALTH_SERVER_PORT=7861`, app on 7860 | App has its own `/health` endpoint (TelePlay, FastAPI, etc.) |
| health-server on 7860, app on internal port | App does not need direct external traffic; use a reverse proxy |
| Replace `health-server.js` in downstream Dockerfile | Need full control over the public entry point |

## Files

| File | Source | Description |
|---|---|---|
| `cloudflare-proxy-setup.py` | Copied from HuggingPost | Deploys/updates a Cloudflare Worker that proxies blocked domains |
| `cloudflare-keepalive-setup.py` | Copied from HuggingPost | Deploys a cron Worker that pings the Space to prevent sleeping |
| `cloudflare-proxy.js` | Copied from HuggingPost | Node.js require hook: transparently patches http/https/fetch to route blocked hosts through the proxy Worker |
| `health-server.js` | This repo | Minimal `/health` endpoint using Node.js builtins; reads sync status from `/tmp/sync-status.json` |
| `start.sh` | This repo | Entrypoint orchestrator with strict ordering (see below) |
| `sync.py` | This repo | Restores/pushes a file to/from an HF Dataset |

## Entrypoint Order (`start.sh`)

1. If `SYNC_FILE` is set → restore file from HF Dataset
2. Run `cloudflare-proxy-setup.py` (deploy proxy Worker)
3. Source the generated proxy env file (`/tmp/huggingpost-cloudflare-proxy.env`)
4. Set `NODE_OPTIONS` to require `cloudflare-proxy.js` if proxy is active (Node.js apps)
   — Python apps must configure the proxy manually (see Troubleshooting)
5. Run `cloudflare-keepalive-setup.py` (deploy keep-awake Worker)
6. Start `health-server.js` in background (port from `HEALTH_SERVER_PORT`, default 7860)
7. If `SYNC_FILE` is set → start `sync.py` loop in background
8. Start the app using `APP_START_CMD` (foreground — this is the main process)

## Example: TelePlay Backend (HF Space 1)

The backend uses a self-contained Dockerfile (`teleplay-backend/Dockerfile`)
that builds from `python:3.11-slim` directly — no registry needed:

```dockerfile
FROM python:3.11-slim

# Install system deps (nodejs for health server, build-essential for native
# Python extensions, ffmpeg for TelePlay)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg build-essential ffmpeg \
    && ... nodejs ...

# Install wrapper Python deps
RUN pip install --no-cache-dir huggingface_hub PyYAML

# Copy wrapper scripts
COPY hf-wrapper/start.sh /opt/hf-wrapper/start.sh
COPY hf-wrapper/sync.py  /opt/hf-wrapper/sync.py
# ...

# Copy TelePlay source
COPY . /app
WORKDIR /app
RUN pip install -r requirements.txt

# TelePlay listens on 7860 (HF exposed port). Move health server aside.
ENV HEALTH_SERVER_PORT=7861
ENV APP_START_CMD="uvicorn app.main:app --host 0.0.0.0 --port 7860"

EXPOSE 7860
ENTRYPOINT ["/opt/hf-wrapper/start.sh"]
```

> TelePlay already has a `GET /health` endpoint (`main.py:117`) that returns
> `{"status": "healthy"}` — HF Spaces health checks work out of the box on
> port 7860 without the wrapper's health server.

Set these HF Space secrets:

| Secret | Value |
|---|---|
| `TELEGRAM_API_ID` | Your Telegram API ID |
| `TELEGRAM_API_HASH` | Your Telegram API hash |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_STORAGE_CHANNEL_ID` | Channel ID (starts with -100) |
| `TELEGRAM_HELPER_BOT_TOKENS` | *(optional)* Helper bots for faster downloads |
| `AUTH_USERS` | *(optional)* Comma-separated allowed Telegram user IDs |
| `JWT_SECRET` | Random 32+ char string |
| `DATABASE_URL` | `sqlite:///./data/teleplay.db` |
| `SERVER_PORT` | *(optional)* — TelePlay's own port (default 8000; APP_START_CMD overrides it) |
| `HF_TOKEN` | HF token with write access |
| `HF_USERNAME` | Your HF username |
| `HF_DATASET` | `teleplay-backup` |
| `SYNC_FILE` | `/app/data/teleplay.db` |
| `CLOUDFLARE_WORKERS_TOKEN` | Cloudflare API token |
| `SPACE_URL` | `https://yourname-teleplay-backend.hf.space` |
| `WEB_BASE_URL` | `https://app.yourdomain.com` |

## Example: TelePlay Frontend (HF Space 2)

Uses a standard nginx Dockerfile (no wrapper needed):

```dockerfile
FROM node:20-slim as builder
WORKDIR /app
COPY web/package*.json ./
RUN npm install
COPY web/ .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 7860
CMD ["nginx", "-g", "daemon off;"]
```

Set this HF Space secret:

| Secret | Value |
|---|---|
| `VITE_API_URL` | `https://stream.yourdomain.com` |

## Troubleshooting

### Cloudflare proxy setup fails with "invalid Workers token"

Use a **Cloudflare API Token** (not a Global API Key, not a tunnel token).
The token needs `Workers Scripts: Edit` permission at the account level.

### Space keeps sleeping

- Verify `CLOUDFLARE_WORKERS_TOKEN` is set and has Workers permissions.
- Verify `SPACE_URL` is set to your Space's public URL.
- Check the keepalive Worker is deployed at
  `https://{space-name}-keepalive.{subdomain}.workers.dev`.

### File backup not working

- `HF_TOKEN` must have write permission to create/update datasets.
- `SYNC_FILE` must be an absolute path to an existing file.
- The dataset is created automatically on first sync.

### Port conflict on 7860

If your app also listens on 7860, the health server will conflict.
Set `HEALTH_SERVER_PORT` to a different value (e.g., `7861`) in your
downstream Dockerfile. If your app has its own `/health` endpoint, the
Dockerfile `HEALTHCHECK` will automatically follow the new port:

```dockerfile
ENV HEALTH_SERVER_PORT=7861
ENV APP_START_CMD="uvicorn app.main:app --host 0.0.0.0 --port 7860"
```

### Cloudflare proxy not working for Python apps

The `NODE_OPTIONS` hook (`cloudflare-proxy.js`) only patches Node.js HTTP(S)
modules. For Python apps, configure the proxy manually in your application
code. Example using `httpx`:

```python
import os
import httpx

proxy_url = os.environ.get("CLOUDFLARE_PROXY_URL")
proxy_secret = os.environ.get("CLOUDFLARE_PROXY_SECRET")

# Transparent proxy via httpx
transport = httpx.HTTPTransport(proxy=proxy_url)
client = httpx.Client(transport=transport)

# For requests/urllib: use proxies dict
proxies = {"all://": proxy_url}
```

For Telegram MTProto apps (like TelePlay), the Cloudflare proxy is not
needed — MTProto uses a custom binary protocol over TCP, not HTTP, and is
not affected by HF's HTTP domain blocks. The MTProto connection to
Telegram may already work without any proxy.

## License

MIT
