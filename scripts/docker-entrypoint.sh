#!/bin/sh
set -eu

mkdir -p /app/samata/config/agents /app/samata/data /app/samata/logs

baseline_db="/app/samata/docker-baseline/samata.db"
runtime_db="/app/samata/data/samata.db"
if [ ! -f "$runtime_db" ] && [ -f "$baseline_db" ]; then
  cp "$baseline_db" "$runtime_db"
  rm -f /app/samata/data/samata.db-shm /app/samata/data/samata.db-wal
fi

chown -R node:node \
  /app/samata/config/agents \
  /app/samata/data \
  /app/samata/logs 2>/dev/null || true

mkdir -p /app/work-plugins/hedge-ratio/attachments /app/work-plugins/hedge-ratio/data
chown node:node /app/work-plugins/hedge-ratio 2>/dev/null || true
chown -R node:node \
  /app/work-plugins/hedge-ratio/.venv \
  /app/work-plugins/hedge-ratio/attachments \
  /app/work-plugins/hedge-ratio/data 2>/dev/null || true

exec gosu node "$@"
