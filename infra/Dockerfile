FROM node:22-bookworm-slim AS control-build
WORKDIR /app/services/control
COPY services/control/package*.json ./
RUN npm ci --no-audit --no-fund
COPY services/control/ ./
COPY services/voice/report-window.mjs /app/services/voice/report-window.mjs
RUN npm run build && npm prune --omit=dev

FROM golang:1.26.4-bookworm AS media-build
WORKDIR /src
COPY services/media/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/media .
WORKDIR /validator
COPY services/recording-archive-validator/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/recording-archive-validator .

FROM node:22-bookworm-slim AS control
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=control-build /app/services/control/dist ./dist
COPY --from=control-build /app/services/control/node_modules ./node_modules
COPY --from=control-build /app/services/control/package.json ./package.json
COPY --from=media-build /out/recording-archive-validator /usr/local/bin/
USER 10001:10001
CMD ["sh", "-c", "node dist/src/migrate.js && exec node dist/src/server.js"]

FROM debian:bookworm-slim AS media
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=media-build /out/media /usr/local/bin/vodog-media
USER 10001:10001
ENTRYPOINT ["vodog-media"]

FROM node:22-bookworm-slim AS voice
WORKDIR /app
COPY services/voice/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY services/voice/ ./
RUN node --input-type=module -e "import('@roamhq/wrtc').then(m=>{if(!(m.default??m).nonstandard?.RTCAudioSource)process.exit(1)})"
USER 10001:10001
CMD ["node", "--max-old-space-size=160", "server.mjs"]

FROM node:22-bookworm-slim AS web-build
WORKDIR /app
COPY apps/web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY apps/web/ ./
RUN npm run build
FROM nginx:stable-bookworm AS web
COPY --from=web-build /app/dist /usr/share/nginx/html

FROM debian:bookworm-slim AS turn
RUN apt-get update && apt-get install -y --no-install-recommends coturn ca-certificates && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["turnserver", "-c", "/etc/turnserver.conf"]

FROM python:3.12-slim-bookworm AS retention
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
COPY infra/retention.py /app/retention.py
USER 10001:10001
ENTRYPOINT ["python3", "-B", "/app/retention.py"]
