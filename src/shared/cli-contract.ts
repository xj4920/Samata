export interface CliUserInfo {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

export interface CliSessionInfo {
  sessionId: string;
  user: CliUserInfo;
  agentName: string;
  agentDisplayName: string;
}

export interface CliExecuteResponse {
  ok: boolean;
  output: string[];
  session?: CliSessionInfo;
  error?: string;
}

export type CliStreamEvent =
  | { type: 'text';       chunk: string }
  | { type: 'tool_start'; name: string; input: unknown; round: number }
  | { type: 'tool_end';   name: string; result: string; round: number; durationMs: number }
  | { type: 'thinking';   text: string; round: number }
  | { type: 'log';        line: string }
  | { type: 'done';       session: CliSessionInfo }
  | { type: 'error';      message: string }
