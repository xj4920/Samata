import { AsyncLocalStorage } from 'node:async_hooks';
import util from 'node:util';

export type AppChannel = 'cli' | 'feishu' | 'telegram' | 'wework' | 'system';

export interface OutputCapture {
  lines: string[];
}

export interface ExecutionContext {
  channel: AppChannel;
  outputCapture?: OutputCapture;
  onOutputLine?: (line: string) => void;
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

export function getExecutionChannel(): AppChannel {
  return storage.getStore()?.channel ?? 'system';
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
