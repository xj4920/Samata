#!/usr/bin/env bash
# Samata — 后台启动脚本，自动停止已有进程

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$SCRIPT_DIR/.samata.pid"
LOG_FILE="$SCRIPT_DIR/logs/samata.log"

mkdir -p "$SCRIPT_DIR/logs"

# 停止已有进程
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "停止已有进程 (PID: $OLD_PID)..."
    kill "$OLD_PID"
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

# 后台启动
nohup bash "$SCRIPT_DIR/scripts/launcher.sh" >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "Samata 已启动 (PID: $NEW_PID)，日志: $LOG_FILE"
