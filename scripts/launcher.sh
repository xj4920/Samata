#!/usr/bin/env bash
# 衍语 launcher — 支持热重载（退出码 120 时自动重启）

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

while true; do
  node --import tsx/esm src/index.ts "$@"
  EXIT_CODE=$?

  if [ "$EXIT_CODE" -eq 120 ]; then
    echo ""
    echo "🔄 正在重载应用..."
    echo ""
    sleep 0.3
  else
    exit $EXIT_CODE
  fi
done
