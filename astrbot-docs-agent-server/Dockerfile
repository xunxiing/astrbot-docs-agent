FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci || npm install

# opencode 通过 npm 安装（按你的需求：不随仓库提交）
RUN npm install -g opencode-ai@1.1.45

COPY tsconfig.json ./
COPY src ./src

RUN npm run build
RUN npm prune --omit=dev

# Fail-fast: ensure runtime deps exist in the image
RUN git --version && opencode --version

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["node", "dist/index.js"]
