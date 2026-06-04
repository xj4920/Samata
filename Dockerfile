FROM node:22-bookworm-slim

ARG SAMATA_VERSION=unknown
ARG SAMATA_COMMIT=unknown

LABEL org.opencontainers.image.title="Samata" \
      org.opencontainers.image.version="${SAMATA_VERSION}" \
      org.opencontainers.image.revision="${SAMATA_COMMIT}"

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
COPY samata/packages ./packages
RUN npm ci --include=dev

WORKDIR /app/plugins
COPY samata-plugins ./
RUN npm ci --include=dev

WORKDIR /app/work-plugins
COPY samata-plugin-work ./
RUN npm ci --include=dev \
  && rm -rf logyi-mcp

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

CMD ["node", "--import", "tsx/esm", "src/index.ts", "--server"]
