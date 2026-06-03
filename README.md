---
title: TelePlay
emoji: 🎬
colorFrom: blue
colorTo: indigo
sdk: docker
pinned: false
---

<div align="center">
  <img src="logo.png" width="80" alt="TelePlay Logo"/>
  <h1>TelePlay</h1>
  <p>Web UI for your Telegram media — browse, stream, manage</p>
  <p>
    <a href="https://github.com/Thirupathi-pirate/teleplay-frontend/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"/></a>
    <a href="https://huggingface.co/spaces"><img src="https://img.shields.io/badge/deploy-HF%20Spaces-yellow" alt="Deploy on HF Spaces"/></a>
  </p>
</div>

## Overview

TelePlay is a web frontend that turns your private Telegram channel into a
personal media streaming library. Upload videos, audio, and files to a Telegram
channel via a bot, then browse, search, and stream them from any browser.

Built with **React 18 + TypeScript + Vite**, served by **nginx**.

### Features

- **File Browser** — grid/list views, search, sort by type, pagination
- **Media Player** — video & audio playback with progress tracking
- **Folder Management** — create, rename, move, delete folders; drag-and-drop files
- **Continue Watching** — remembers playback position across sessions
- **Multi-select** — batch delete, batch move files and folders
- **Share & Stream** — copy shareable links, direct stream URLs
- **Auth** — Telegram-based login with JWT, auto-refresh, retry on failure
- **Responsive** — works on desktop and mobile browsers

## Deploy on Hugging Face Spaces

### Prerequisites

A running [TelePlay Backend](https://github.com/Thirupathi-pirate/teleplay-backend) Space.

### Steps

1. Create a **Docker** Space on Hugging Face
2. Push this repo to your Space
3. Add **one secret** in Settings → Repository Secrets:

   | Secret | Value |
   |--------|-------|
   | `VITE_API_URL` | `https://yourname-teleplay-backend.hf.space` |

4. Deploy — it just works

### Deploy Order

1. Backend first → verify at `/health`
2. Then frontend (this repo)

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build (node → nginx:alpine) |
| `nginx.conf` | SPA serving + `/api` proxy to backend |
| `src/` | React application source |
| `public/` | Static assets (logo, etc.) |

## License

[MIT](LICENSE) © 2026 [Thirupathi-pirate](https://github.com/Thirupathi-pirate)
