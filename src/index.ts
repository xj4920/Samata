import 'dotenv/config';
import * as readline from 'node:readline';
import { select } from '@inquirer/prompts';
import { initSchema } from './db/schema.js';
import { closeDb } from './db/connection.js';
import { getAllUsers, setCurrentUser } from './auth/rbac.js';
import { route, setLlmEnabled, getCommandNames, getCommandEntries } from './commands/router.js';
import { resetAbort, abort as abortCommand } from './utils/abort.js';
import { initProviders } from './llm/provider.js';
import { startMonitor, stopMonitor } from './services/wework-monitor.js';
import { startHedgeRatioMonitor, stopHedgeRatioMonitor } from './services/hedge-ratio-monitor.js';
import { startReminderScheduler, stopReminderScheduler } from './services/reminder-scheduler.js';
import { startTaskScheduler, stopTaskScheduler } from './services/task-scheduler.js';
import { initMcpServers, stopMcpServers } from './services/mcp-manager.js';
import { initPlugins, stopPluginWatcher } from './plugins/registry.js';
import { startAllFeishuBots, stopAllFeishuBots, type FeishuBotMode } from './feishu/bot.js';
import { startAllWeworkBots, stopAllWeworkBots } from './wework/bot.js';
import { log } from './utils/logger.js';
import { getCurrentAgent } from './llm/agent.js';
import { getAllSkills } from './commands/skill.js';
import { startCliApiServer } from './server/cli-api.js';
import type { Server } from 'node:http';
import { runWithExecutionContext } from './runtime/execution-context.js';

let cliApiServer: Server | null = null;

export function gracefulShutdown(): void {
  cliApiServer?.close();
  cliApiServer = null;
  stopPluginWatcher();
  stopMonitor();
  stopHedgeRatioMonitor();
  stopReminderScheduler();
  stopTaskScheduler();
  stopAllFeishuBots();
  stopAllWeworkBots();
  stopMcpServers();
  closeDb();
}

async function login(): Promise<void> {
  const users = getAllUsers();
  const adminUser = users.find(u => u.username === 'admin');

  if (adminUser) {
    setCurrentUser(adminUser);
    log.print(`已登录：${adminUser.username} [${adminUser.role}]`);
  } else {
    log.print('未找到 admin 用户，请选择登录用户：');
    const userId = await select({
      message: '请选择登录用户：',
      choices: users.map(u => ({
        name: `${u.username} (${u.role})`,
        value: u.id,
      })),
    });
    const user = users.find(u => u.id === userId)!;
    setCurrentUser(user);
    log.print(`已登录：${user.username} [${user.role}]`);
  }
}

async function repl(): Promise<void> {
  const currentAgent = getCurrentAgent();
  const agentSkills = getAllSkills(currentAgent?.id);
  
  log.print('\n' + '-'.repeat(40));
  log.print(`  当前 Agent: ${currentAgent?.displayName ?? '默认'} (${currentAgent?.name ?? 'otcclaw'})`);
  if (currentAgent?.description) {
    log.print(`  职能: ${currentAgent.description}`);
  }
  
  const skillNames = agentSkills.map(s => s.name);
  if (skillNames.length > 0) {
    log.print(`  可用 Skill: ${skillNames.join(', ')}`);
  }
  log.print('-'.repeat(40));
  log.print('\nSamata — 输入命令开始操作，输入 /help 查看帮助，输入 /exit 退出\n');

  readline.emitKeypressEvents(process.stdin);

  let hintLines = 0;
  let suppressClear = false;
  let selectedIdx = -1;
  let currentHits: Array<{ name: string; description: string }> = [];
  let hintPrefix = '';

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const clearScreenDownSeq = '\x1B[0J';
  process.stdout.write = function (data: any, ...args: any[]) {
    if (suppressClear && typeof data === 'string' && data.includes(clearScreenDownSeq)) {
      data = data.replace(clearScreenDownSeq, '');
      if (!data) return true;
    }
    return (origStdoutWrite as any)(data, ...args);
  } as any;

  let rl: readline.Interface = null!;
  let savedHistory: string[] = [];

  const createRl = () => {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: 100,
      history: savedHistory,
      completer: (line: string) => {
        const entries = getCommandEntries('cli');
        const parts = line.split(/\s+/);
        
        if (!line.includes(' ')) {
          const cmds = entries.map(e => e.name);
          const hits = cmds.filter(c => c.startsWith(line));
          if (hits.length === 1) {
            return [[hits[0] + ' '], line];
          }
          return [hits.length ? hits : cmds, line];
        } else {
          const cmdPart = parts[0];
          const entry = entries.find(e => e.name === cmdPart);
          if (entry && entry.subcommands) {
             const subPart = line.slice(cmdPart.length).trimStart();
             const hits = entry.subcommands
               .filter(sub => sub.startsWith(subPart))
               .map(sub => `${cmdPart} ${sub} `);
             return [hits.length ? hits : [], line];
          }
        }
        return [[], line];
      },
    });
  };

  const clearHints = () => {
    if (hintLines > 0) {
      suppressClear = false;
      for (let i = 0; i < hintLines; i++) {
        origStdoutWrite(`\n\x1B[2K`);
      }
      origStdoutWrite(`\x1B[${hintLines}A`);
      (rl as any)._refreshLine();
      hintLines = 0;
    }
    selectedIdx = -1;
    currentHits = [];
    hintPrefix = '';
  };

  const renderHints = () => {
    const n = currentHits.length;
    origStdoutWrite('\n'.repeat(n));
    origStdoutWrite(`\x1B[${n}A`);
    (rl as any)._refreshLine();
    for (let i = 0; i < n; i++) {
      const e = currentHits[i];
      const label = `${e.name.padEnd(12)} ${e.description}`;
      if (i === selectedIdx) {
        origStdoutWrite(`\n\x1B[2K  \x1B[7m ${label} \x1B[0m`);
      } else {
        origStdoutWrite(`\n\x1B[2K  \x1B[2m${label}\x1B[0m`);
      }
    }
    origStdoutWrite(`\x1B[${n}A`);
    hintLines = n;
    suppressClear = true;
    (rl as any)._refreshLine();
  };

  const setLine = (text: string) => {
    (rl as any).line = text;
    (rl as any).cursor = text.length;
    (rl as any)._refreshLine();
  };

  const updateHints = (line: string) => {
    const parts = line.split(/\s+/);
    const cmdPart = parts[0];
    const entries = getCommandEntries('cli');

    if (parts.length === 1) {
      // Command completion
      if (cmdPart.startsWith('/')) {
        const hits = entries.filter(e => e.name.startsWith(cmdPart));
        if (hits.length > 0 && (cmdPart === '/' || hits.length <= 20)) {
          currentHits = hits.map(h => ({ name: h.name, description: h.description }));
          selectedIdx = -1;
          hintPrefix = cmdPart;
          renderHints();
          return;
        }
      }
    } else if (parts.length >= 2) {
      // Subcommand completion
      const entry = entries.find(e => e.name === cmdPart);
      if (entry && entry.subcommands) {
        const subPart = parts.slice(1).join(' ');
        const hits = entry.subcommands
          .filter(sub => sub.startsWith(subPart))
          .map(sub => ({ name: `${cmdPart} ${sub}`, description: `子命令: ${sub}` }));
        
        if (hits.length > 0) {
          currentHits = hits;
          selectedIdx = -1;
          hintPrefix = line;
          renderHints();
          return;
        }
      }
    }
    
    currentHits = [];
    selectedIdx = -1;
    hintPrefix = '';
  };

  // Multiline input support
  let multilineBuffer: string[] = [];   // previous lines (already committed via Shift+Enter)
  let multilineActive = false;

  const resetMultiline = () => {
    multilineBuffer = [];
    multilineActive = false;
  };

  const getFullInput = (currentLine: string): string => {
    if (multilineBuffer.length === 0) return currentLine;
    return [...multilineBuffer, currentLine].join('\n');
  };

  const attachTtyOverride = () => {
    if (typeof (rl as any)._ttyWrite === 'function') {
      const origTtyWrite = (rl as any)._ttyWrite;
      (rl as any)._ttyWrite = function (s: string, key: any) {
        const hintsVisible = currentHits.length > 0;

        // Shift+Enter: commit current line to buffer, start new line
        if (key?.name === 'return' && key?.shift) {
          clearHints();
          const currentLine = (rl as any).line as string ?? '';
          multilineBuffer.push(currentLine);
          multilineActive = true;
          // Move to next line and show continuation prompt
          origStdoutWrite('\n');
          setLine('');
          // Overwrite prompt for continuation
          (rl as any)._prompt = '  ... ';
          (rl as any)._refreshLine();
          return;
        }

        if (hintsVisible && key) {
          if (key.name === 'down' || key.name === 'up') {
            const savedHits = currentHits;
            const savedPrefix = hintPrefix;
            const prevIdx = selectedIdx;
            clearHints();
            currentHits = savedHits;
            hintPrefix = savedPrefix;
            if (key.name === 'down') {
              selectedIdx = prevIdx < savedHits.length - 1 ? prevIdx + 1 : 0;
            } else {
              selectedIdx = prevIdx > 0 ? prevIdx - 1 : savedHits.length - 1;
            }
            renderHints();
            if (selectedIdx >= 0) {
              setLine(currentHits[selectedIdx].name);
            }
            return;
          }
          if (key.name === 'return') {
            clearHints();
            origTtyWrite.call(this, s, key);
            return;
          }
          if (key.name === 'escape') {
            clearHints();
            setLine(hintPrefix);
            return;
          }
          if (key?.name === 'tab') {
            if (selectedIdx >= 0) {
              const selected = currentHits[selectedIdx];
              clearHints();
              setLine(selected.name + ' ');
              return;
            }
            // Fall through to default behavior if no hint is selected
          }
        }

        clearHints();
        origTtyWrite.call(this, s, key);

        const line = (rl as any).line as string ?? '';
        updateHints(line);
      };
    }
  };

  const prompt = (): Promise<string> =>
    new Promise((resolve, reject) => {
      resetMultiline();
      const onClose = () => reject(new Error('ExitPromptError'));
      rl.once('close', onClose);
      rl.question('衍语> ', (answer) => {
        rl.removeListener('close', onClose);
        clearHints();
        // Replace literal \n sequences with real newlines
        const full = getFullInput(answer).replace(/\\n/g, '\n');
        resetMultiline();
        resolve(full);
      });
    });

  createRl();
  attachTtyOverride();

  try {
    while (true) {
      const line = await prompt();
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === '/exit' || trimmed === '/quit') {
        log.print('再见 👋');
        break;
      }
      savedHistory = (rl as any).history?.slice() ?? [];
      rl.close();

      // Listen for ESC to abort the running command
      resetAbort();
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      const onData = (chunk: Buffer) => {
        if (chunk.length === 1 && chunk[0] === 0x1b) {
          abortCommand();
        }
      };
      process.stdin.on('data', onData);

      try {
        await runWithExecutionContext({ channel: 'cli', interactive: true }, async () => {
          await route(trimmed);
        });
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          log.print('\n⏹ 命令已取消');
        } else {
          throw err;
        }
      } finally {
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
      }

      createRl();
      attachTtyOverride();
    }
  } catch (err: any) {
    if (err?.message !== 'ExitPromptError') {
      log.error(err?.message ?? String(err));
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  log.print('\n' + '='.repeat(40));
  log.print('  Samata — 平等，技术平权');
  log.print('='.repeat(40) + '\n');

  initSchema();

  const llmReady = await initProviders();
  setLlmEnabled(llmReady);
  if (!llmReady) {
    log.print('AI 助手未启用（请在 .env 中配置 ANTHROPIC_API_KEY 或 MINIMAX_API_KEY）');
  }

  await login();

  // 启动企微监控
  startMonitor({ auto: true });

  // 启动提醒调度器
  startReminderScheduler();

  // 启动定时任务调度器
  startTaskScheduler();

  // 连接 MCP 服务器（SSE 模式下服务器需提前手动启动，连接失败不影响主程序）
  initMcpServers().catch(() => {});

  // 加载 plugins/ 目录下的插件（热加载 + 文件监听）
  await initPlugins();

  // 启动企微机器人（长连接模式，多实例）
  await startAllWeworkBots();

  // 启动套保比例监控（依赖企微长连接，需在 bot 启动之后）
  startHedgeRatioMonitor({ auto: true });

  // 启动飞书机器人
  const feishuMode = (process.env.FEISHU_MODE || 'ws') as FeishuBotMode;
  const feishuPort = parseInt(process.env.FEISHU_PORT || '3001', 10);
  await startAllFeishuBots({
    mode: feishuMode,
    httpPort: feishuMode === 'webhook' ? feishuPort : undefined,
  });

  const isServer = process.argv.includes('--server') || !process.stdin.isTTY;

  if (isServer) {
    cliApiServer = startCliApiServer();
    log.print('以服务器模式运行 (无交互 REPL)');
    // 监听信号以优雅关闭
    const handleSignal = () => {
      log.print('\n正在关闭服务...');
      gracefulShutdown();
      process.exit(0);
    };
    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);
    
    // 保持进程运行
    setInterval(() => {}, 1000);
  } else {
    await repl();
    gracefulShutdown();
    process.exit(0);
  }
}

main();