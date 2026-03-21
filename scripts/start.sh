#!/usr/bin/env bash
# Samata — 后台启动（SSH 远程用）

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

nohup bash "$SCRIPT_DIR/scripts/launcher.sh" --server < /dev/null >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

# 等待一下，确认进程没有立即退出
sleep 2
if [ -f "$PID_FILE" ]; then
  CUR_PID=$(cat "$PID_FILE")
  if kill -0 "$CUR_PID" 2>/dev/null; then
    echo "Samata 已启动 (PID: $CUR_PID)，日志: $LOG_FILE"
    echo "查看日志: tail -f $LOG_FILE"
  else
    echo "启动失败！详情请查看日志: $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
  fi
fi
