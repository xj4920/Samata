import type { CliExecuteResponse, CliSessionInfo, CliUserInfo, CliStreamEvent } from '../shared/cli-contract.js';

const BASE_URL = process.env.CLI_SERVER_URL || `http://127.0.0.1:${process.env.CLI_API_PORT || '3456'}`;

async function request<T>(pathname: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE_URL}${pathname}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(json.error || `请求失败: ${resp.status}`);
  }
  return json as T;
}

export async function listCliUsers(): Promise<CliUserInfo[]> {
  const result = await request<{ users: CliUserInfo[] }>('/api/cli/users');
  return result.users;
}

export async function createCliSession(username: string): Promise<CliSessionInfo> {
  const result = await request<{ ok: true; session: CliSessionInfo }>('/api/cli/session', {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
  return result.session;
}

export async function executeCliInput(sessionId: string, input: string): Promise<CliExecuteResponse> {
  return request<CliExecuteResponse>('/api/cli/execute', {
    method: 'POST',
    body: JSON.stringify({ sessionId, input }),
  });
}

export async function destroyCliSession(sessionId: string): Promise<void> {
  await request('/api/cli/session', {
    method: 'DELETE',
    body: JSON.stringify({ sessionId }),
  });
}

export async function sendPromptReply(sessionId: string, promptId: string, value: string): Promise<void> {
  await request('/api/cli/prompt-reply', {
    method: 'POST',
    body: JSON.stringify({ sessionId, promptId, value }),
  });
}

export async function* streamCliInput(
  sessionId: string,
  input: string,
): AsyncGenerator<CliStreamEvent> {
  const resp = await fetch(`${BASE_URL}/api/cli/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, input }),
  });
  if (!resp.ok || !resp.body) throw new Error(`stream 请求失败: ${resp.status}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        yield JSON.parse(line.slice(6)) as CliStreamEvent;
      }
    }
  }
}
