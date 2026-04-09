import { randomUUID } from 'node:crypto';
import { getCurrentUser, setCurrentUser } from '../auth/rbac.js';
import { route } from '../commands/router.js';
import { runAgenticChat } from '../llm/agent.js';
import { getAgent, getCurrentAgent, setCurrentAgent } from '../llm/agents/config.js';
import { log } from '../utils/logger.js';
import { runWithCapturedOutput, runWithExecutionContext } from '../runtime/execution-context.js';
import { getCliSession, resetCliSession, toCliSessionInfo, updateCliSession, waitForPromptReply } from './cli-session.js';
import type { CliExecuteResponse, CliStreamEvent } from '../shared/cli-contract.js';

function trimOutput(lines: string[]): string[] {
  return lines
    .map(line => line.trimEnd())
    .filter(line => line.length > 0);
}

export async function executeCliInput(sessionId: string, input: string): Promise<CliExecuteResponse> {
  const session = getCliSession(sessionId);
  let prevUser: ReturnType<typeof getCurrentUser> | null = null;
  try {
    prevUser = getCurrentUser();
  } catch {
    prevUser = null;
  }
  const prevAgent = getCurrentAgent();

  try {
    setCurrentUser(session.user);
    setCurrentAgent(getAgent(session.agentName));

    if (input.trim() === '/reset') {
      const next = resetCliSession(sessionId);
      return {
        ok: true,
        output: ['AI 对话上下文已重置'],
        session: toCliSessionInfo(next),
      };
    }

    if (input.trim().startsWith('/')) {
      const { output } = await runWithCapturedOutput({ channel: 'cli' }, async () => {
        await route(input);
      });

      const next = updateCliSession(sessionId, {
        agentName: getCurrentAgent()?.name ?? session.agentName,
      });
      return {
        ok: true,
        output: trimOutput(output),
        session: toCliSessionInfo(next),
      };
    }

    const agent = getAgent(session.agentName);
    const reply = await runWithCapturedOutput({ channel: 'cli' }, async () => {
      return await runAgenticChat(session.history, input, session.user, {
        streamEnabled: false,
        showThinking: false,
        agentConfig: agent,
        deliveryContext: {
          channel: 'cli',
          targetId: session.id,
        },
      });
    });

    const next = updateCliSession(sessionId, {
      history: session.history,
      agentName: getCurrentAgent()?.name ?? session.agentName,
    });

    const output = trimOutput([...reply.output, reply.result || '（无回复内容）']);
    return {
      ok: true,
      output,
      session: toCliSessionInfo(next),
    };
  } catch (err: any) {
    log.error(`CLI 执行失败: ${err.message}`);
    return {
      ok: false,
      output: [],
      error: err.message ?? String(err),
    };
  } finally {
    if (prevUser) setCurrentUser(prevUser);
    setCurrentAgent(prevAgent);
  }
}

export async function executeCliStream(
  sessionId: string,
  input: string,
  emit: (event: CliStreamEvent) => void,
): Promise<void> {
  const session = getCliSession(sessionId);
  let prevUser: ReturnType<typeof getCurrentUser> | null = null;
  try {
    prevUser = getCurrentUser();
  } catch {
    prevUser = null;
  }
  const prevAgent = getCurrentAgent();

  try {
    setCurrentUser(session.user);
    setCurrentAgent(getAgent(session.agentName));

    if (input.trim() === '/reset') {
      const next = resetCliSession(sessionId);
      emit({ type: 'log', line: 'AI 对话上下文已重置' });
      emit({ type: 'done', session: toCliSessionInfo(next) });
      return;
    }

    const promptFn = async (message: string, defaultValue?: string): Promise<string> => {
      const promptId = randomUUID();
      emit({ type: 'prompt', promptId, message, defaultValue });
      return waitForPromptReply(sessionId, promptId);
    };

    if (input.trim().startsWith('/')) {
      await runWithExecutionContext(
        { channel: 'cli', interactive: true, promptFn, onOutputLine: line => emit({ type: 'log', line }) },
        async () => { await route(input); },
      );

      const next = updateCliSession(sessionId, {
        agentName: getCurrentAgent()?.name ?? session.agentName,
      });
      emit({ type: 'done', session: toCliSessionInfo(next) });
      return;
    }

    const agent = getAgent(session.agentName);
    await runWithExecutionContext(
      { channel: 'cli', interactive: true, promptFn, onOutputLine: line => emit({ type: 'log', line }) },
      async () => {
        await runAgenticChat(session.history, input, session.user, {
          streamEnabled: true,
          showThinking: false,
          agentConfig: agent,
          onProgress: event => emit(event),
          onTextChunk: chunk => emit({ type: 'text', chunk }),
          deliveryContext: { channel: 'cli', targetId: session.id },
        });
      },
    );

    const next = updateCliSession(sessionId, {
      history: session.history,
      agentName: getCurrentAgent()?.name ?? session.agentName,
    });
    emit({ type: 'done', session: toCliSessionInfo(next) });
  } catch (err: any) {
    log.error(`CLI stream 执行失败: ${err.message}`);
    emit({ type: 'error', message: err.message ?? String(err) });
  } finally {
    if (prevUser) setCurrentUser(prevUser);
    setCurrentAgent(prevAgent);
  }
}
