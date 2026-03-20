#!/usr/bin/env bash
# Samata — 本地开发，前台运行（有 CLI 界面）

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$SCRIPT_DIR/.samata.pid"

# 杀掉已有进程
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "停止已有进程 (PID: $PID)..."
    kill "$PID"
    sleep 0.5
  fi
  rm -f "$PID_FILE"
fi

exec bash "$SCRIPT_DIR/scripts/launcher.sh"
