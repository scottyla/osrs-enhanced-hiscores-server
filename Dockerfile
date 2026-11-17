# Build stage: has a compiler, in case better-sqlite3 has no prebuilt binary for this Node version.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Runtime stage: just Node, the dependencies and the app.
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
ENV DATABASE_PATH=/data/hiscores.db PORT=8080
# The database lives in /data: a named volume (docker compose) or a Railway volume mounted there.
# Owned by the runtime user so a fresh volume is writable. (No VOLUME instruction: Railway doesn't support it.)
RUN mkdir -p /data && chown node:node /data
EXPOSE 8080
USER node
CMD ["node", "src/index.ts"]
