#!/usr/bin/env bash
# 切换企微 bot 运行模式：prod（生产）或 test（测试）
#
# 用法:
#   ./scripts/wework-switch.sh prod   # 启用 wework-bot + ticlaw-bot，关闭 otcclaw-test-bot
#   ./scripts/wework-switch.sh test   # 启用 otcclaw-test-bot，关闭 wework-bot + ticlaw-bot
#   ./scripts/wework-switch.sh        # 查看当前状态

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# 使用 nvm default Node（与 launcher.sh 一致）
if [ -f "$HOME/.nvm/alias/default" ]; then
  NVM_DEFAULT=$(cat "$HOME/.nvm/alias/default" | tr -d '[:space:]')
  if [ -n "$NVM_DEFAULT" ] && [ -d "$HOME/.nvm/versions/node/$NVM_DEFAULT/bin" ]; then
    export PATH="$HOME/.nvm/versions/node/$NVM_DEFAULT/bin:$PATH"
  fi
fi

node -e "
const Database = require('$SCRIPT_DIR/node_modules/better-sqlite3');
const db = new Database('$SCRIPT_DIR/data/samata.db');
const mode = '${1:-}';

const PROD_ON  = ['wework-bot', 'ticlaw-bot'];
const TEST_ON  = ['otcclaw-test-bot'];

function showStatus() {
  const rows = db.prepare(\"SELECT name, id, auto_start FROM bot_apps WHERE channel = 'wework'\").all();
  console.log('=== 企微 Bot 状态 ===');
  rows.forEach(r => {
    const flag = r.auto_start ? '✅ ON ' : '❌ OFF';
    console.log('  ' + flag + '  ' + r.name + '  (' + r.id.slice(0, 12) + '...)');
  });
}

if (mode === 'prod' || mode === 'production') {
  db.prepare(\"UPDATE bot_apps SET auto_start = 1 WHERE channel = 'wework' AND name IN ('wework-bot','ticlaw-bot')\").run();
  db.prepare(\"UPDATE bot_apps SET auto_start = 0 WHERE channel = 'wework' AND name = 'otcclaw-test-bot'\").run();
  console.log('🏭 已切换到【生产模式】');
  showStatus();
  console.log('\n⚠️  需要重启服务生效');
} else if (mode === 'test') {
  db.prepare(\"UPDATE bot_apps SET auto_start = 0 WHERE channel = 'wework' AND name IN ('wework-bot','ticlaw-bot')\").run();
  db.prepare(\"UPDATE bot_apps SET auto_start = 1 WHERE channel = 'wework' AND name = 'otcclaw-test-bot'\").run();
  console.log('🧪 已切换到【测试模式】');
  showStatus();
  console.log('\n⚠️  需要重启服务生效');
} else if (mode === '') {
  showStatus();
} else {
  console.log('用法: wework-switch.sh {prod|test}');
  console.log('  prod  — 启用 wework-bot + ticlaw-bot');
  console.log('  test  — 启用 otcclaw-test-bot');
  process.exit(1);
}
db.close();
"
