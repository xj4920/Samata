import { AsyncLocalStorage } from 'node:async_hooks';
import util from 'node:util';
import { input as inquirerInput, select as inquirerSelect, confirm as inquirerConfirm } from '@inquirer/prompts';
import type { AgentConfig } from '../llm/agents/config.js';

export type AppChannel = 'cli' | 'feishu' | 'telegram' | 'wework' | 'system';

export interface OutputCapture {
  lines: string[];
}

export type PromptFn = (message: string, defaultValue?: string) => Promise<string>;

export interface ContextUser {
  id: string;
  username: string;
  role: string;
  display_name?: string;
}

export interface ExecutionContext {
  channel: AppChannel;
  user?: ContextUser;
  /** bot_apps.id for feishu/wework/telegram bot instances; undefined in CLI/system */
  appId?: string;
  agent?: AgentConfig;
  interactive?: boolean;
  promptFn?: PromptFn;
  outputCapture?: OutputCapture;
  onOutputLine?: (line: string) => void;
  /** Scheduled task tool_call execution: authorization was checked when the task was created or updated. */
  scheduledTaskAuthorized?: boolean;
}

const storage = new AsyncLocalStorage<ExecutionContext>();

export function runWithExecutionContext<T>(ctx: ExecutionContext, fn: () => T): T;
export function runWithExecutionContext<T>(ctx: ExecutionContext, fn: () => Promise<T>): Promise<T>;
export function runWithExecutionContext<T>(ctx: ExecutionContext, fn: () => T | Promise<T>): T | Promise<T> {
  return storage.run(ctx, fn);
}

export function getExecutionContext(): ExecutionContext | undefined {
  return storage.getStore();
}

export function isScheduledTaskAuthorized(): boolean {
  return storage.getStore()?.scheduledTaskAuthorized === true;
}

export function getExecutionChannel(): AppChannel {
  return storage.getStore()?.channel ?? 'system';
}

export function isInteractive(): boolean {
  return storage.getStore()?.interactive === true;
}

export function getContextUser(): ContextUser | undefined {
  return storage.getStore()?.user;
}

export function getContextAgent(): AgentConfig | undefined {
  return storage.getStore()?.agent;
}

export function setContextAgent(agent: AgentConfig | undefined): void {
  const store = storage.getStore();
  if (store) store.agent = agent;
}

export async function remoteInput(message: string, defaultValue?: string): Promise<string> {
  const ctx = storage.getStore();
  if (ctx?.promptFn) return ctx.promptFn(message, defaultValue);
  if (ctx?.interactive) return inquirerInput({ message, default: defaultValue });
  throw new Error('当前环境不支持交互式输入');
}

export async function remoteSelect(message: string, choices: Array<{ name: string; value: string }>): Promise<string> {
  const ctx = storage.getStore();
  if (ctx?.promptFn) {
    const choiceText = choices.map((c, i) => `  ${i + 1}. ${c.name}`).join('\n');
    const reply = await ctx.promptFn(`${message}\n${choiceText}\n请输入编号`, '1');
    const idx = parseInt(reply, 10) - 1;
    return (idx >= 0 && idx < choices.length) ? choices[idx].value : choices[0].value;
  }
  if (ctx?.interactive) return inquirerSelect({ message, choices });
  throw new Error('当前环境不支持交互式输入');
}

export async function remoteConfirm(message: string, defaultValue = true): Promise<boolean> {
  const ctx = storage.getStore();
  if (ctx?.promptFn) {
    const hint = defaultValue ? '(Y/n)' : '(y/N)';
    const reply = await ctx.promptFn(`${message} ${hint}`, defaultValue ? 'y' : 'n');
    const v = reply.trim().toLowerCase();
    if (!v) return defaultValue;
    return v === 'y' || v === 'yes';
  }
  if (ctx?.interactive) return inquirerConfirm({ message, default: defaultValue });
  throw new Error('当前环境不支持交互式输入');
}

export function captureOutputLine(...args: any[]): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  const line = util.format(...args);
  if (ctx.onOutputLine) {
    ctx.onOutputLine(line);
  } else if (ctx.outputCapture) {
    ctx.outputCapture.lines.push(line);
  }
}

export async function runWithCapturedOutput<T>(
  ctx: Omit<ExecutionContext, 'outputCapture'>,
  fn: () => Promise<T>,
): Promise<{ result: T; output: string[] }> {
  const outputCapture: OutputCapture = { lines: [] };
  const result = await runWithExecutionContext({ ...ctx, outputCapture }, fn);
  return { result, output: outputCapture.lines };
}
