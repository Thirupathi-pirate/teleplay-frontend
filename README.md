# TelePlay Frontend — HF Space Deployment

## Overview

Deploys the TelePlay React web UI on Hugging Face Spaces. The built SPA is
served by nginx on port 7860. API requests are proxied to the backend Space.

The `hf-wrapper/` scripts are included in this repo for convenience, but the
frontend does not use them — it has no Telegram calls, no Cloudflare proxy,
and no keep-awake requirement. The wrapper is available if you want to extend
the frontend Space with health checks or keep-awake later.

## HF Space Configuration

### Space Hardware

| Setting | Value |
|---------|-------|
| Space name | `yourname-teleplay-frontend` |
| Visibility | Private |
| SDK | Docker |
| Hardware | CPU Free tier |
| Sleep | 15 min of inactivity |

### Secrets

Add this in **HF Space → Settings → Repository Secrets**:

| Secret | Value |
|--------|-------|
| `VITE_API_URL` | `https://yourname-teleplay-backend.hf.space` |

> If using custom domains: `https://app.yourdomain.com`

### Dockerfile

Place these two files in your HF Space repo root:

**`Dockerfile`:**

```dockerfile
ARG VITE_API_URL=https://yourname-teleplay-backend.hf.space

FROM node:20-slim as builder

ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

RUN npm run build

FROM nginx:alpine

ARG VITE_API_URL
ENV BACKEND_URL=${VITE_API_URL}

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

RUN apk add --no-cache gettext

RUN printf '#!/bin/sh\nenvsubst "\$BACKEND_URL" < /etc/nginx/conf.d/default.conf > /tmp/default.conf && mv /tmp/default.conf /etc/nginx/conf.d/default.conf\n' > /docker-entrypoint.d/40-envsubst.sh && chmod +x /docker-entrypoint.d/40-envsubst.sh

EXPOSE 7860

CMD ["nginx", "-g", "daemon off;"]
```

**`nginx.conf`:**

```nginx
server {
    listen 7860;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript
                application/javascript application/json application/xml;

    location /api {
        proxy_pass ${BACKEND_URL};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

## Custom Domain (Optional)

1. In Cloudflare Dashboard, add a CNAME record:
   - Name: `app`
   - Target: `yourname-teleplay-frontend.hf.space`
   - Proxy: DNS only (grey cloud)

2. In HF Space Settings → Custom Domain:
   - Enter `app.yourdomain.com`
   - Add the provided HF TXT verification record in Cloudflare DNS
   - Wait for verification

## Deploy Order

1. Deploy **teleplay-backend** first
2. Verify backend is running (`https://yourname-teleplay-backend.hf.space/health`)
3. Deploy **teleplay-frontend**
4. Visit frontend at `https://yourname-teleplay-frontend.hf.space`

## Env Vars Summary

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_API_URL` | Yes | Backend Space URL (build arg → nginx proxy target via envsubst) |
| `BACKEND_URL` | No | Runtime override for nginx proxy target (defaults to VITE_API_URL) |
