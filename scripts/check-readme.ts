/**
 * check-readme.ts
 * 检查 README.md 是否包含所有源文件中的关键内容。
 * 用法：npx tsx scripts/check-readme.ts
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const root = process.cwd();
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

let errors = 0;

function check(items: string[], source: string) {
  for (const item of items) {
    if (!readme.includes(item)) {
      console.error(`❌ [${source}] "${item}" 未出现在 README.md`);
      errors++;
    }
  }
}

// 1. 从 router.ts 提取命令名（commands 对象的顶层 key）
const routerSrc = readFileSync(resolve(root, 'src/commands/router.ts'), 'utf8');
const cmdMatches = routerSrc.match(/^\s{2}['"]?([\w-]+)['"]?\s*:/gm) ?? [];
const ROUTER_RESERVED = ['description', 'usage', 'adminOnly', 'agentId', 'handler', 'subcommands'];
const commands = cmdMatches
  .map(m => m.trim().replace(/['":\s]/g, ''))
  .filter(c => !ROUTER_RESERVED.includes(c));
check(commands.map(c => `/${c}`), 'router.ts');

// 2. 从 package.json 提取 scripts 键名
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const scripts: string[] = Object.keys(pkg.scripts ?? {});
check(scripts.map(s => `npm run ${s}`), 'package.json');

// 3. 从 .env.example 提取变量名（注释行和非注释行都算）
const envSrc = readFileSync(resolve(root, '.env.example'), 'utf8');
const envVars = envSrc
  .split('\n')
  .map(l => l.replace(/^#\s*/, '').match(/^([A-Z_][A-Z0-9_]*)=/)?.[1])
  .filter((v): v is string => Boolean(v));
check(envVars, '.env.example');

if (errors === 0) {
  console.log('✅ README 与实现一致');
} else {
  console.error(`\n共 ${errors} 项缺失，请更新 README.md`);
  process.exit(1);
}
