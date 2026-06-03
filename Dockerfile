ARG VITE_API_URL=https://lavender7736-teleplay-backend.hf.space

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

RUN cat > /docker-entrypoint.d/40-envsubst.sh << 'EOF' && chmod +x /docker-entrypoint.d/40-envsubst.sh
#!/bin/sh
envsubst '${BACKEND_URL}' < /etc/nginx/conf.d/default.conf > /tmp/default.conf && mv /tmp/default.conf /etc/nginx/conf.d/default.conf
EOF

EXPOSE 7860

CMD ["nginx", "-g", "daemon off;"]
