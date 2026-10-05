# ---- 构建阶段：编译 better-sqlite3 原生模块与 TypeScript ----
FROM node:20-bookworm-slim AS builder

# better-sqlite3 需要 python3、make 与 g++
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 修剪为生产依赖（原生模块保留，无需再次编译）
RUN npm prune --omit=dev

# ---- 运行阶段 ----
FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV DB_PATH=/data/cues.db

WORKDIR /app

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
