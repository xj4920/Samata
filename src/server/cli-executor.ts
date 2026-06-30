import { randomUUID } from 'node:crypto';
import { route } from '../commands/router.js';
import { getAgent, getCurrentAgent } from '../llm/agents/config.js';
import { log } from '../utils/logger.js';
import { runWithCapturedOutput, runWithExecutionContext } from '../runtime/execution-context.js';
import { getCliSession, resetCliSession, toCliSessionInfo, updateCliSession, waitForPromptReply } from './cli-session.js';
import type { CliExecuteResponse, CliStreamEvent } from '../shared/cli-contract.js';
import { cancelActiveAgentTurn, makeAgentTurnKey, runCoordinatedAgentTurn } from '../session/agent-turn-coordinator.js';

function trimOutput(lines: string[]): string[] {
  return lines
    .map(line => line.trimEnd())
    .filter(line => line.length > 0);
}

export async function executeCliInput(sessionId: string, input: string): Promise<CliExecuteResponse> {
  const session = getCliSession(sessionId);
  const agent = getAgent(session.agentName);

  try {
    if (input.trim() === '/reset') {
      cancelActiveAgentTurn(makeAgentTurnKey('cli', undefined, session.id), 'CLI session reset');
      const next = resetCliSession(sessionId);
      return {
        ok: true,
        output: ['AI 对话上下文已重置'],
        session: toCliSessionInfo(next),
      };
    }

    if (input.trim().startsWith('/')) {
      const { output } = await runWithCapturedOutput({ channel: 'cli', user: session.user, agent }, async () => {
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

    const reply = await runWithCapturedOutput({ channel: 'cli', user: session.user, agent }, async () => {
      return await runCoordinatedAgentTurn({
        key: makeAgentTurnKey('cli', undefined, session.id),
        history: session.history,
        input,
        user: session.user,
        options: {
          streamEnabled: false,
          showThinking: false,
          agentConfig: agent,
          deliveryContext: {
            channel: 'cli',
            targetId: session.id,
          },
        },
      });
    });

    const next = updateCliSession(sessionId, {
      history: session.history,
      agentName: getCurrentAgent()?.name ?? session.agentName,
    });

    const finalReply = reply.result.status === 'superseded'
      ? '已收到补充信息，转由最新消息继续处理'
      : reply.result.reply || '（无回复内容）';
    const output = trimOutput([...reply.output, finalReply]);
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
  }
}

export async function executeCliStream(
  sessionId: string,
  input: string,
  emit: (event: CliStreamEvent) => void,
): Promise<void> {
  const session = getCliSession(sessionId);
  const agent = getAgent(session.agentName);

  try {
    if (input.trim() === '/reset') {
      cancelActiveAgentTurn(makeAgentTurnKey('cli', undefined, session.id), 'CLI session reset');
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
        { channel: 'cli', user: session.user, agent, interactive: true, promptFn, onOutputLine: line => emit({ type: 'log', line }) },
        async () => { await route(input); },
      );

      const next = updateCliSession(sessionId, {
        agentName: getCurrentAgent()?.name ?? session.agentName,
      });
      emit({ type: 'done', session: toCliSessionInfo(next) });
      return;
    }

    await runWithExecutionContext(
      { channel: 'cli', user: session.user, agent, interactive: true, promptFn, onOutputLine: line => emit({ type: 'log', line }) },
      async () => {
        const result = await runCoordinatedAgentTurn({
          key: makeAgentTurnKey('cli', undefined, session.id),
          history: session.history,
          input,
          user: session.user,
          options: {
            streamEnabled: true,
            showThinking: false,
            agentConfig: agent,
            onProgress: event => emit(event),
            onTextChunk: chunk => emit({ type: 'text', chunk }),
            deliveryContext: { channel: 'cli', targetId: session.id },
          },
        });
        if (result.status === 'superseded') {
          emit({ type: 'log', line: '已收到补充信息，转由最新消息继续处理' });
        }
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
  }
}
