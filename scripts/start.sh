#!/usr/bin/env bash
# Samata — 后台启动（SSH 远程用）

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$SCRIPT_DIR/.samata.pid"
LOG_FILE="$SCRIPT_DIR/logs/samata-$(date +%Y-%m-%d).log"

mkdir -p "$SCRIPT_DIR/logs"

# 读取 .env 中的 CLI_API_PORT（避开 ccr 默认占用的 3456），默认 3457
if [ -f "$SCRIPT_DIR/.env" ]; then
  CLI_API_PORT=$(grep -E '^CLI_API_PORT=' "$SCRIPT_DIR/.env" | tail -n1 | cut -d= -f2- | tr -d '\r\n "'"'"'')
fi
CLI_API_PORT="${CLI_API_PORT:-3457}"

# 如果 node_modules 不存在，先安装依赖
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "node_modules 不存在，正在安装依赖..."
  cd "$SCRIPT_DIR" && npm install
  if [ $? -ne 0 ]; then
    echo "npm install 失败！"
    exit 1
  fi
fi

# 停止已有进程（杀整个进程组，确保 node 子进程也被终止）
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "停止已有进程 (PID: $OLD_PID)..."
    kill -- -"$OLD_PID" 2>/dev/null || kill "$OLD_PID" 2>/dev/null
    for i in $(seq 1 10); do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "进程未响应，强制终止..."
      kill -9 -- -"$OLD_PID" 2>/dev/null || kill -9 "$OLD_PID" 2>/dev/null
      sleep 0.5
    fi
  fi
  rm -f "$PID_FILE"
fi

# 兜底：如果端口仍被占用（孤儿进程），强制清理
PORT_PID=$(lsof -ti :"$CLI_API_PORT" 2>/dev/null)
if [ -n "$PORT_PID" ]; then
  echo "清理残留端口 $CLI_API_PORT 占用进程 (PID: $PORT_PID)..."
  kill "$PORT_PID" 2>/dev/null
  sleep 1
  lsof -ti :"$CLI_API_PORT" 2>/dev/null | xargs -r kill -9 2>/dev/null
fi

setsid bash "$SCRIPT_DIR/scripts/launcher.sh" --server < /dev/null >> "$LOG_FILE" 2>&1 &
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
