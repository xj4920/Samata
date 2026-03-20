#!/usr/bin/env bash
# Samata — 停止脚本

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$SCRIPT_DIR/.samata.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    echo "Samata 已停止 (PID: $PID)"
  else
    echo "Samata 未在运行"
  fi
  rm -f "$PID_FILE"
else
  echo "Samata 未在运行"
fi
