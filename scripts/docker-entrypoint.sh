#!/bin/sh
set -eu

mkdir -p /app/samata/data /app/samata/logs
chown -R node:node /app/samata/data /app/samata/logs 2>/dev/null || true

exec gosu node "$@"
