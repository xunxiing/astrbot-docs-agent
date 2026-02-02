FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build
RUN npm prune --omit=dev

# Fail-fast: ensure runtime deps exist in the image
RUN git --version

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["node", "dist/index.js"]

