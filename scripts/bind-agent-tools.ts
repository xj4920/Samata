import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initSchema } from '../src/db/schema.js';
import { getAllUsers, getUserByIdOrUsername, setCurrentUser, type User } from '../src/auth/rbac.js';
import { runWithExecutionContext } from '../src/runtime/execution-context.js';
import { applyAgentToolBinding, type AgentToolBindingInput } from '../src/llm/agents/tool-binding.js';

interface CliOptions {
  agent?: string;
  user: string;
  config?: string;
  dryRun: boolean;
  json: boolean;
  help: boolean;
  addTools: string[];
  removeTools: string[];
  blockTools: string[];
  unblockTools: string[];
  memberBlockTools: string[];
  memberUnblockTools: string[];
}

type ConfigBinding = Record<string, unknown>;

function splitTools(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function readList(value: unknown): string[] {
  if (typeof value === 'string') return splitTools(value);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    user: 'admin',
    dryRun: false,
    json: false,
    help: false,
    addTools: [],
    removeTools: [],
    blockTools: [],
    unblockTools: [],
    memberBlockTools: [],
    memberUnblockTools: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要参数`);
      i += 1;
      return value;
    };

    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--agent') options.agent = next();
    else if (arg === '--user') options.user = next();
    else if (arg === '--config') options.config = next();
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--add') options.addTools.push(...splitTools(next()));
    else if (arg === '--remove') options.removeTools.push(...splitTools(next()));
    else if (arg === '--block') options.blockTools.push(...splitTools(next()));
    else if (arg === '--unblock') options.unblockTools.push(...splitTools(next()));
    else if (arg === '--member-block') options.memberBlockTools.push(...splitTools(next()));
    else if (arg === '--member-unblock') options.memberUnblockTools.push(...splitTools(next()));
    else throw new Error(`未知参数: ${arg}`);
  }

  return options;
}

function printHelp(): void {
  console.log(`用法:
  npx tsx scripts/bind-agent-tools.ts --agent <name> [options]
  npx tsx scripts/bind-agent-tools.ts --config config/agent-tool-bindings.local.json

选项:
  --user <username|id>          CLI 管理用户，默认 admin
  --add a,b                    加入 tools_list
  --remove a,b                 从 tools_list 移除
  --block a,b                  加入 block_tools
  --unblock a,b                从 block_tools 移除
  --member-block a,b           加入 user_tools_list，并设置 user_tools_mode=blocklist
  --member-unblock a,b         从 user_tools_list 移除
  --dry-run                    只显示将要修改的结果，不写 DB
  --json                       输出 JSON`);
}

function bindingFromObject(raw: ConfigBinding, fallbackDryRun: boolean): AgentToolBindingInput {
  const agentName = String(raw.agentName ?? raw.agent ?? '').trim();
  return {
    agentName,
    addTools: readList(raw.addTools ?? raw.add ?? raw.tools),
    removeTools: readList(raw.removeTools ?? raw.remove),
    blockTools: readList(raw.blockTools ?? raw.block),
    unblockTools: readList(raw.unblockTools ?? raw.unblock),
    memberBlockTools: readList(raw.memberBlockTools ?? raw.memberBlock ?? raw.member_block),
    memberUnblockTools: readList(raw.memberUnblockTools ?? raw.memberUnblock ?? raw.member_unblock),
    dryRun: raw.dryRun === true || fallbackDryRun,
  };
}

function loadConfigBindings(path: string, dryRun: boolean): AgentToolBindingInput[] {
  const configPath = resolve(process.cwd(), path);
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  const bindings = Array.isArray(raw) ? raw : Array.isArray(raw.bindings) ? raw.bindings : [raw];
  return bindings.map((item: ConfigBinding) => bindingFromObject(item, dryRun));
}

function buildBindings(options: CliOptions): AgentToolBindingInput[] {
  if (options.config) return loadConfigBindings(options.config, options.dryRun);
  if (!options.agent) throw new Error('缺少 --agent；或使用 --config 指定批量配置');
  return [{
    agentName: options.agent,
    addTools: options.addTools,
    removeTools: options.removeTools,
    blockTools: options.blockTools,
    unblockTools: options.unblockTools,
    memberBlockTools: options.memberBlockTools,
    memberUnblockTools: options.memberUnblockTools,
    dryRun: options.dryRun,
  }];
}

function resolveCliUser(ref: string): User {
  const user = getUserByIdOrUsername(ref) ?? getAllUsers().find(item => item.username === ref || item.id === ref);
  if (!user) throw new Error(`未找到 CLI 用户: ${ref}`);
  if (user.role !== 'admin') throw new Error(`用户 ${user.username} 不是系统管理员`);
  return user;
}

function formatList(items: string[]): string {
  return items.length > 0 ? items.join(', ') : '-';
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  initSchema();
  const user = resolveCliUser(options.user);
  setCurrentUser(user);
  const bindings = buildBindings(options);

  const results = await runWithExecutionContext({ channel: 'cli', user }, () =>
    bindings.map(binding => applyAgentToolBinding(binding)),
  );

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      if (!result.success) {
        console.error(`失败: ${result.error}`);
        continue;
      }
      const prefix = result.dryRun ? '[dry-run]' : '[bind]';
      console.log(`${prefix} ${result.agentName}: ${result.changed ? 'changed' : 'unchanged'}`);
      console.log(`  tools_list + ${formatList(result.added.toolsList)} | - ${formatList(result.removed.toolsList)}`);
      console.log(`  block_tools + ${formatList(result.added.blockTools)} | - ${formatList(result.removed.blockTools)}`);
      console.log(`  user_tools_list + ${formatList(result.added.userToolsList)} | - ${formatList(result.removed.userToolsList)}`);
    }
  }

  if (results.some(result => !result.success)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
