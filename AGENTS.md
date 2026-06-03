# TelePlay Frontend — Agent Guide

## Build Context
- Dockerfile uses `COPY . .` in the builder stage — all source files must be at repo root.
- `hf-wrapper/` is included but NOT used by the Dockerfile (nginx container, no wrapper entrypoint).
- If hf-wrapper is ever needed, change Dockerfile to `ENTRYPOINT ["/opt/hf-wrapper/start.sh"]` and set `APP_START_CMD=nginx -g "daemon off;"`.

## Port Setup
- `EXPOSE 7860` — HF Space exposes this port.
- nginx listens on 7860 (match in nginx.conf).

## Environment Variables
- `VITE_API_URL` — **required** HF Space secret. Backend Space URL (e.g. `https://user-teleplay-backend.hf.space`).
- Set via Docker `ARG` during build, then available as `envsubst '$BACKEND_URL'` in nginx config at runtime.

## Key Files
| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage: node:20-slim builds, nginx:alpine serves |
| `nginx.conf` | Reverse proxies `/api` to backend, serves SPA on `/` |
| `src/` | React application source |
| `hf-wrapper/` | Available for future use (not currently wired in) |

## Gotchas
- `envsubst` only replaces `$BACKEND_URL` (quoted in sh call) — nginx `$uri`, `$http_upgrade` etc. are safe.
- `package-lock.json` must be committed for reproducible builds.
