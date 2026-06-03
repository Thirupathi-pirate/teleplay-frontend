# HF Wrapper — Agent Guide

## What this is
Shared entrypoint & utility scripts (`start.sh`, `sync.py`, health server, Cloudflare proxy) used by the backend HF Space Dockerfile. Not a standalone package — these files are `COPY`'d into the app image during `docker build`.

## Boot order (start.sh, strict)
1. restore from HF Dataset
2. Cloudflare proxy-setup (creates Workers proxy)
3. source proxy env file (`/tmp/huggingpost-cloudflare-proxy.env`)
4. `NODE_OPTIONS --require cloudflare-proxy.js` (patches `http`/`https`/`fetch`/`undici`)
5. Cloudflare keepalive-setup (creates Workers cron)
6. health-server.js in background (port via `sed` patching `const PORT =`)
7. sync.py loop in background (periodic HF Dataset backup)
8. `$APP_START_CMD` in foreground

## Critical gotchas
- **Shell stays PID 1 (no `exec`):** Trap catches SIGTERM/SIGINT, kills children, runs final sync. Removing `&` + `wait` or adding `exec` breaks graceful shutdown.
- **Port 7860 conflict:** HF Spaces only exposes 7860. Health server defaults to 7860. The backend Dockerfile sets `HEALTH_SERVER_PORT=7861` to avoid conflict.
- **health-server.js uses only Node.js builtins** (`http`, `fs`) — no external dependencies.
- **sync.py writes `/tmp/sync-status.json`** after each operation; health server reads this for `/health` response.
- **sync.py limits:** handles exactly one file (`SYNC_FILE`); session files NOT backed up.
- **Proxy is Node.js only:** `NODE_OPTIONS` patching only covers `http`/`https`/`fetch`/`undici`. Python apps must configure proxy manually. Telegram MTProto (PyroFork) bypasses HTTP proxy.

## Env vars easy to miss
- `HEALTH_SERVER_PORT` — hardcoded default 7860 in JS, patched to 7861 by backend Dockerfile
- `SYNC_INTERVAL` — stripped of non-digits, minimum clamped to 60s
- `SPACE_HOST` — auto-derived from `SPACE_URL` if unset
- `CLOUDFLARE_PROXY_DOMAINS` — `*` to proxy all outbound HTTP

## File layout in container
```
/opt/hf-wrapper/
  start.sh                              — entrypoint (strict order)
  sync.py                               — HF Dataset backup/restore
  cloudflare-proxy-setup.py             — CF Worker proxy deployer
  cloudflare-keepalive-setup.py         — CF Worker cron deployer
  cloudflare-proxy.js                   — Node.js HTTP patch module
  healthsrv/health-server.js            — /health endpoint (Node.js builtins only)
/tmp/sync-status.json                   — written by sync.py, read by health-server.js
/tmp/huggingpost-cloudflare-proxy.env   — sourced by start.sh step 3
```
