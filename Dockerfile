FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CLI_API_PORT=3457 \
    CLI_API_HOST=0.0.0.0 \
    SAMATA_PLUGINS_DIR=/app/plugins,/app/work-plugins

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bubblewrap \
    ca-certificates \
    chromium \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    g++ \
    git \
    make \
    openssh-client \
    openssl \
    pandoc \
    python-is-python3 \
    python3 \
    python3-bs4 \
    python3-cryptography \
    python3-lxml \
    python3-matplotlib \
    python3-numpy \
    python3-openpyxl \
    python3-pandas \
    python3-paramiko \
    python3-pil \
    python3-pip \
    python3-psycopg2 \
    python3-requests \
    python3-venv \
    python3-xlrd \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/samata

COPY samata/package.json samata/package-lock.json ./
COPY samata/packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
RUN npm ci --include=dev

WORKDIR /app/plugins
COPY samata-plugins/package.json samata-plugins/package-lock.json ./
COPY samata-plugins/csv-export/package.json ./csv-export/package.json
COPY samata-plugins/diagram/package.json ./diagram/package.json
COPY samata-plugins/excel-parser/package.json ./excel-parser/package.json
COPY samata-plugins/pdf-parser/package.json ./pdf-parser/package.json
COPY samata-plugins/word-parser/package.json ./word-parser/package.json
RUN npm ci --include=dev
COPY samata-plugins ./

WORKDIR /app/work-plugins
COPY samata-plugin-work/package.json samata-plugin-work/package-lock.json ./
COPY samata-plugin-work/client-manager/package.json ./client-manager/package.json
COPY samata-plugin-work/corporate-action-alert/package.json ./corporate-action-alert/package.json
COPY samata-plugin-work/etf-monitor/package.json ./etf-monitor/package.json
COPY samata-plugin-work/hedge-ratio/package.json ./hedge-ratio/package.json
COPY samata-plugin-work/normal-trading-summary/package.json ./normal-trading-summary/package.json
COPY samata-plugin-work/pricing/package.json ./pricing/package.json
COPY samata-plugin-work/sbl-data/package.json ./sbl-data/package.json
COPY samata-plugin-work/titans-code-search/package.json ./titans-code-search/package.json
COPY samata-plugin-work/trade-query/package.json ./trade-query/package.json
COPY samata-plugin-work/wiki-sync/package.json ./wiki-sync/package.json
RUN npm ci --include=dev
COPY samata-plugin-work ./
RUN rm -rf logyi-mcp

WORKDIR /app/samata-plugin-work/logyi-mcp
COPY samata-plugin-work/logyi-mcp/package.json samata-plugin-work/logyi-mcp/package-lock.json ./
RUN npm ci --include=dev
COPY samata-plugin-work/logyi-mcp ./
RUN npm run build

WORKDIR /app/samata
COPY samata ./

EXPOSE 3457

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const port=process.env.CLI_API_PORT||'3457'; fetch('http://127.0.0.1:'+port+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ARG SAMATA_VERSION=unknown
ARG SAMATA_COMMIT=unknown

LABEL org.opencontainers.image.title="Samata" \
      org.opencontainers.image.version="${SAMATA_VERSION}" \
      org.opencontainers.image.revision="${SAMATA_COMMIT}"

CMD ["node", "--import", "tsx/esm", "src/index.ts", "--server"]
