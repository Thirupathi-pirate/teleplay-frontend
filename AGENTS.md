# TelePlay Frontend — Agent Guide

## App structure
- **SPA:** React 18 + TypeScript, built with Vite, served by nginx:alpine
- **State:** Zustand store at `src/lib/store.ts`
- **API client:** `src/lib/api.ts` — axios instance with auth interceptor (reads `access_token` from localStorage), auto-refresh on 401, 429 handling
- **Routing:** react-router-dom — `/login`, `/auth` (callback), `/*` (protected file browser)
- **Components:** 12 components in `src/components/`, all functional + hooks

## Build & run
```bash
npm install
npm run dev          # Vite dev on :3000, proxies /api → localhost:8000
npm run build        # production build → dist/
npm run lint         # eslint --max-warnings 0
```

## Dockerfile (multi-stage)
```dockerfile
FROM node:20-slim as builder
# COPY . .     ← all source at repo root
# RUN npm run build

FROM nginx:alpine
# ENV BACKEND_URL=${VITE_API_URL}
# envsubst '${BACKEND_URL}' in 40-envsubst.sh at runtime
# CMD ["nginx", "-g", "daemon off;"]
```
- `VITE_API_URL` is a build ARG (baked into JS bundle). `BACKEND_URL` is runtime env for nginx `proxy_pass`.
- `hf-wrapper/` is included in repo but **not used** by the Dockerfile (nginx container, no wrapper entrypoint).

## Nginx (`nginx.conf`)
- `proxy_pass ${BACKEND_URL};` — no trailing URI, so `/api/foo` → `${BACKEND_URL}/api/foo`
- Only `$BACKEND_URL` is envsubst'd at runtime — nginx `$uri`, `$scheme`, `$host` etc. are nginx runtime vars, safe from substitution.
- Security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer-when-downgrade`

## Deploy (HF Space SDK: Docker)
1. Create Space with Docker SDK
2. Set `VITE_API_URL` as build-time secret (`https://user-teleplay-backend.hf.space`)
3. Frontend Space exposes port 7860, nginx listens on 7860

## Key env vars
| Var | When | Notes |
|-----|------|-------|
| `VITE_API_URL` | build ARG | Backend Space URL (required). Default: `https://yourname-teleplay-backend.hf.space` |
| `BACKEND_URL` | runtime ENV | Inherits from `VITE_API_URL`. Used by nginx `proxy_pass` |

## Gotchas
- Token is stored in `localStorage('access_token')` and sent via `Authorization: Bearer` header (axios interceptor). Thumbnails use `AuthImage` component (fetch + blob URL with Bearer header) — no `?token=` in `<img>` tags.
- `<video>`/`<audio>` stream URLs unavoidably include `?token=` query param. Streams are same-origin so no cross-origin referrer concerns.
- **Share/copy URLs** use `public_stream_url` (token-free) — never expose `?token=` in shared links. `GlobalContextMenu` splits the two: download uses token, copy/share uses public hash.
- **Auth retry:** `useCurrentUser` retries 2 times (1s delay). If all fail, a Retry button (`refetch()`) is shown alongside "Go to Login".
- **AuthImage:** Blobs are capped at 5MB to prevent memory exhaustion on oversized thumbnails.
- **Icons:** All emoji characters (🚀🎵🎬) replaced with lucide-react SVG icons (`Zap`, `Music`, `Film`) for cross-platform consistency.
- **Path alias:** `@` maps to `src/` in both `vite.config.ts` and `tsconfig.json`.
- **Firefox scrollbar:** `scrollbar-width: thin` and `scrollbar-color` set in `index.css`.
- Drag-and-drop: FileCard sets `text/plain` data (`String(file.id)`), FolderCard sets `application/json` data with `{type, id}`.
- `@dnd-kit/*` and `video.js` have been removed — not used.
- `package-lock.json` must be committed for reproducible builds.
- Dev proxy config in `vite.config.ts` proxies `/api` → `http://localhost:8000`.
- TypeScript strict mode with `noUnusedLocals`, `noUnusedParameters`.
- Build is via Vite (esbuild), not `tsc`. Run `npx tsc --noEmit` separately to catch type errors.
