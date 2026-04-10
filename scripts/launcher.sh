#!/usr/bin/env bash
# 衍语 launcher — 支持热重载（退出码 120 时自动重启）

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

# 如果 node_modules 不存在，先安装依赖
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "node_modules 不存在，正在安装依赖..."
  npm install
  if [ $? -ne 0 ]; then
    echo "npm install 失败！"
    exit 1
  fi
fi

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
