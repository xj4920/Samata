import { getDueScheduledTasks, claimDueScheduledTask, markTaskExecuted, computeNextRun, type ScheduledTask } from '../commands/scheduled-task.js';
import { sandboxExecAsync } from '../commands/sandbox.js';
import { getAgentById, getAgentTools, type DeliveryContext } from '../llm/agents/config.js';
import { runAgenticChat } from '../llm/agent.js';
import { getUser, type User } from '../auth/rbac.js';
import { runWithExecutionContext, type AppChannel } from '../runtime/execution-context.js';
import { getAllNativeTools } from '../tools/index.js';
import { getPluginTools, executePluginTool } from '../plugins/registry.js';
import { getMcpTools } from './mcp-manager.js';
import { deliverMessage } from './deliver.js';
import { log } from '../utils/logger.js';

let timer: ReturnType<typeof setInterval> | null = null;

const TAG = '[task-scheduler]';
const SYSTEM_USER: User = { id: 'system', username: 'system', role: 'admin' };
const DEFAULT_TASK_LOCK_MS = 10 * 60 * 1000;
const TOOL_CALL_TASK_LOCK_MS = 6 * 60 * 60 * 1000;
const TASK_NOTIFY_CHANNEL = process.env.SCHEDULED_TASK_NOTIFY_CHANNEL || 'wework:wework-bot';
const TASK_NOTIFY_TARGET_ID = process.env.SCHEDULED_TASK_NOTIFY_TARGET_ID || 'gzxujun';

function getLockMs(task: ScheduledTask): number {
  return task.task_type === 'tool_call' || task.task_type === 'agent_chat'
    ? TOOL_CALL_TASK_LOCK_MS
    : DEFAULT_TASK_LOCK_MS;
}

function toExecutionChannel(channel: string): AppChannel {
  if (channel === 'cli' || channel === 'feishu' || channel === 'telegram' || channel === 'wework') return channel;
  return 'system';
}

function buildDeliveryContext(task: ScheduledTask): DeliveryContext | undefined {
  if (
    task.channel !== 'cli' &&
    task.channel !== 'feishu' &&
    task.channel !== 'telegram' &&
    task.channel !== 'wework'
  ) {
    return undefined;
  }
  const targetId = task.target_id ?? undefined;
  const appId = task.app_id ?? undefined;
  return {
    channel: task.channel,
    targetId,
    appId,
    weworkChatId: task.channel === 'wework' && targetId?.startsWith('wr') ? targetId : undefined,
    weworkChatType: task.channel === 'wework' && targetId?.startsWith('wr') ? 'group' : undefined,
  };
}

async function executeRemind(task: ScheduledTask): Promise<string | null> {
  const payload = JSON.parse(task.payload) as { message: string };
  const msg = `⏰ 定时提醒（${task.name}）：${payload.message}`;
  const ok = await deliverMessage(task.channel, task.target_id, task.app_id, msg, TAG);
  return ok ? 'delivered' : 'delivery_failed';
}

async function executeSandbox(task: ScheduledTask): Promise<string | null> {
  const payload = JSON.parse(task.payload) as {
    language: 'js' | 'shell' | 'python';
    code: string;
    notify?: boolean;
    timeout_ms?: number;
  };

  const result = await sandboxExecAsync(
    task.agent_id,
    task.created_by ?? 'system',
    { language: payload.language, code: payload.code, timeout_ms: payload.timeout_ms },
  );

  const summary = result.exit_code === 0
    ? (result.stdout || '(无输出)').slice(0, 2000)
    : `[exit ${result.exit_code}] ${(result.stderr || result.stdout || '').slice(0, 2000)}`;

  if (payload.notify) {
    const msg = `📋 定时任务「${task.name}」执行完成：\n${summary}`;
    await deliverMessage(task.channel, task.target_id, task.app_id, msg, TAG);
  }

  return summary;
}

async function executeToolCall(task: ScheduledTask): Promise<string | null> {
  const payload = JSON.parse(task.payload) as {
    tool_name: string;
    input: Record<string, unknown>;
    notify: false;
  };
  const agent = getAgentById(task.agent_id);
  if (!agent) throw new Error(`Agent not found: ${task.agent_id}`);

  const globalTools = [...getAllNativeTools(), ...getPluginTools(), ...getMcpTools()];
  const allowedTools = getAgentTools(agent, globalTools, true).map(t => t.name);
  if (!allowedTools.includes(payload.tool_name)) {
    throw new Error(`Tool not available for agent ${agent.name}: ${payload.tool_name}`);
  }

  const result = await runWithExecutionContext(
    { channel: 'system', user: SYSTEM_USER, agent, scheduledTaskAuthorized: true },
    () => executePluginTool(payload.tool_name, payload.input),
  );
  if (result === null) throw new Error(`Plugin tool not found: ${payload.tool_name}`);

  return result.slice(0, 4000);
}

async function executeAgentChat(task: ScheduledTask): Promise<string | null> {
  const payload = JSON.parse(task.payload) as { prompt?: string; message?: string };
  const prompt = (payload.prompt ?? payload.message ?? '').trim();
  if (!prompt) throw new Error('agent_chat payload.prompt is required');

  const agent = getAgentById(task.agent_id);
  if (!agent) throw new Error(`Agent not found: ${task.agent_id}`);

  const user = task.created_by ? (getUser(task.created_by) ?? SYSTEM_USER) : SYSTEM_USER;
  const deliveryContext = buildDeliveryContext(task);
  const history: Parameters<typeof runAgenticChat>[0] = [];

  const reply = await runWithExecutionContext(
    {
      channel: toExecutionChannel(task.channel),
      user,
      appId: task.app_id ?? undefined,
      agent,
    },
    () => runAgenticChat(history, prompt, user, {
      streamEnabled: false,
      showThinking: false,
      agentConfig: agent,
      deliveryContext,
      logPrefix: `${TAG}[${agent.name}:${task.id.slice(0, 8)}] `,
    }),
  );

  const message = reply.trim() || '（无回复内容）';
  const ok = await deliverMessage(task.channel, task.target_id, task.app_id, message, TAG);
  return ok ? message.slice(0, 4000) : `delivery_failed: ${message.slice(0, 3983)}`;
}

function formatScheduledTaskTime(task: ScheduledTask): string {
  const time = new Date(task.next_run_at ?? Date.now()).toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return time.replace(/:/g, '：');
}

async function notifyTaskFinished(
  task: ScheduledTask,
  status: '执行完成' | '执行失败',
  detail: string,
): Promise<void> {
  if (!TASK_NOTIFY_TARGET_ID) return;
  const message = `${formatScheduledTaskTime(task)} ： [${task.id}], ${task.name}, ${status}， ${detail || 'null'}`;
  try {
    const ok = await deliverMessage(TASK_NOTIFY_CHANNEL, TASK_NOTIFY_TARGET_ID, null, message, TAG);
    if (!ok) log.warn(`${TAG} 定时任务状态通知失败: ${task.id}`);
  } catch (err: any) {
    log.warn(`${TAG} 定时任务状态通知异常 ${task.id}: ${err?.message ?? err}`);
  }
}

export async function checkAndExecute(): Promise<void> {
  let tasks: ScheduledTask[];
  try {
    tasks = getDueScheduledTasks();
  } catch (err: any) {
    log.error(`${TAG} 查询失败: ${err.message}`);
    return;
  }

  for (const candidate of tasks) {
    const task = claimDueScheduledTask(candidate.id, getLockMs(candidate));
    if (!task) continue;

    try {
      let result: string | null = null;

      if (task.task_type === 'remind') {
        result = await executeRemind(task);
      } else if (task.task_type === 'sandbox_exec') {
        result = await executeSandbox(task);
      } else if (task.task_type === 'tool_call') {
        result = await executeToolCall(task);
      } else if (task.task_type === 'agent_chat') {
        result = await executeAgentChat(task);
      } else {
        throw new Error(`Unsupported task type: ${task.task_type}`);
      }

      const nextRun = computeNextRun(task.cron_expr);
      markTaskExecuted(task.id, result, nextRun);
      await notifyTaskFinished(task, '执行完成', 'null');
      log.file(`${TAG} 已执行: ${task.id.slice(0, 8)} (${task.name}) → next ${new Date(nextRun).toISOString()}`);
    } catch (err: any) {
      const errorMessage = err?.message ?? String(err);
      log.error(`${TAG} 执行失败 ${task.id.slice(0, 8)}: ${errorMessage}`);
      // Still advance next_run_at to avoid stuck retries
      try {
        const nextRun = computeNextRun(task.cron_expr);
        markTaskExecuted(task.id, `error: ${errorMessage}`, nextRun);
      } catch { /* ignore */ }
      await notifyTaskFinished(task, '执行失败', errorMessage);
    }
  }
}

export function startTaskScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    checkAndExecute().catch(err => log.error(`${TAG} checkAndExecute 异常: ${err.message}`));
  }, 30_000);
  log.file(`${TAG} 定时任务调度器已启动（轮询间隔 30s）`);
}

export function stopTaskScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
