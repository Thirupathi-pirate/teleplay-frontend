<div align="center">
  <img src="https://cdn.jsdelivr.net/gh/huggingface/huggingface-svg@main/huggingface.svg" width="40" alt="HF Logo"/>
  <h1>TelePlay Frontend</h1>
  <p>React SPA — Deploy on <a href="https://huggingface.co/spaces">Hugging Face Spaces</a></p>
</div>

## What is this?

TelePlay's web UI — file browser, media player, folder management. Built with
React + Vite + TypeScript, served by nginx on port 7860. API calls proxy to
the backend Space.

## How to Deploy

1. Create a **Docker** Space on Hugging Face
2. Push the contents of this repo to your Space repo
3. Add one secret in **Settings → Repository Secrets**:
   - `VITE_API_URL` → your backend Space URL (e.g. `https://user-teleplay-backend.hf.space`)
4. Deploy — the `Dockerfile` and `nginx.conf` are already included

## One Secret

| Secret | Why |
|--------|-----|
| `VITE_API_URL` | Tells nginx where to proxy `/api` requests (your backend Space) |

## Deploy Order

1. Backend first → verify at `/health`
2. Then frontend — it just proxies to the backend

## Files That Matter

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build (node → nginx) |
| `nginx.conf` | SPA serving + `/api` proxy |
| `src/` | React source |
| `hf-wrapper/` | Not used (included for convenience) |
