#!/usr/bin/env bash
# Samata — 停止脚本

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$SCRIPT_DIR/.samata.pid"

kill_tree() {
  local pid=$1
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null
}

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    # 递归杀掉整个进程树（nohup → launcher bash → node）
    kill_tree "$PID"
    echo "Samata 已停止 (PID: $PID)"
  else
    echo "Samata 未在运行"
  fi
  rm -f "$PID_FILE"
else
  echo "Samata 未在运行"
fi
