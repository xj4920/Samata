FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CLI_API_PORT=3457 \
    CLI_API_HOST=0.0.0.0 \
    SAMATA_PLUGINS_DIR=/app/plugins

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    g++ \
    make \
    openssl \
    pandoc \
    python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/samata

COPY samata/package.json samata/package-lock.json ./
COPY samata/packages ./packages
RUN npm ci --include=dev

COPY samata ./

WORKDIR /app/plugins
COPY samata-plugins ./
RUN npm ci --include=dev

WORKDIR /app/samata

EXPOSE 3457

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const port=process.env.CLI_API_PORT||'3457'; fetch('http://127.0.0.1:'+port+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx/esm", "src/index.ts", "--server"]
