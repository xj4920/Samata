#!/usr/bin/env bash
# 确保 vitest 使用与 launcher.sh 相同的 Node 版本运行，
# 避免 Cursor 内置 Node 版本与 better-sqlite3 native 模块 ABI 不匹配

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

if [ -f "$HOME/.nvm/alias/default" ]; then
  NVM_DEFAULT=$(cat "$HOME/.nvm/alias/default" | tr -d '[:space:]')
  if [ -n "$NVM_DEFAULT" ] && [ -d "$HOME/.nvm/versions/node/$NVM_DEFAULT/bin" ]; then
    export PATH="$HOME/.nvm/versions/node/$NVM_DEFAULT/bin:$PATH"
  fi
fi

node -e "require('better-sqlite3')" 2>/dev/null
if [ $? -ne 0 ]; then
  echo "⚙️  better-sqlite3 ABI 不匹配，正在 rebuild..."
  npm rebuild better-sqlite3
fi

exec npx vitest run "$@"
