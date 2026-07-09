#!/bin/sh
set -eu

mkdir -p /app/samata/config/agents /app/samata/data /app/samata/logs

baseline_db="/app/samata/docker-baseline/samata.db"
baseline_data="/app/samata/docker-baseline/data-files.tar.gz"
baseline_manifest="/app/samata/docker-baseline/data-files.manifest.json"
runtime_db="/app/samata/data/samata.db"
restore_marker="/app/samata/data/.samata-data-baseline-restored"
initialized_from_baseline=0

if [ ! -f "$runtime_db" ] && [ -f "$baseline_db" ]; then
  cp "$baseline_db" "$runtime_db"
  rm -f /app/samata/data/samata.db-shm /app/samata/data/samata.db-wal
  initialized_from_baseline=1
fi

if [ "$initialized_from_baseline" = "1" ] && [ -f "$baseline_data" ]; then
  tar --skip-old-files -xzf "$baseline_data" -C /app/samata/data
  {
    echo "restored_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    echo "archive=$baseline_data"
    if [ -f "$baseline_manifest" ]; then
      echo "manifest=$baseline_manifest"
    fi
  } > "$restore_marker"
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
