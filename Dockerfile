# SafePrint web app — production image (linux/amd64 and linux/arm64).
# Used by deploy/oracle/docker-compose.yml; also runs standalone:
#   docker build -t safeprint-app .
#   docker run -p 3000:3000 -e MASTER_KEY=... -e MONGODB_URI=... safeprint-app

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    STORAGE_DRIVER=local \
    LOCAL_STORE_DIR=/data/store
# App files stay root-owned (read-only to the app); only the encrypted store
# and Next's cache are writable.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
RUN mkdir -p /data/store .next/cache \
 && chown -R node:node /data .next/cache \
 && chmod 700 /data/store
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
