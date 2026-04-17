/**
 * 将底层 LLM / provider 抛出的错误，收敛为面向最终用户的简短提示。
 * 日志侧仍应记录原始 err.message，以便排查。
 */
export function friendlyAIError(err: unknown): string {
  const msg = (err as any)?.message ?? String(err);

  if (/MiniMax API \d{3}|server_error|upstream|Bad Gateway|520|502|503|504/i.test(msg)) {
    return 'AI 暂时无法访问（上游服务抖动），请稍后重试。';
  }
  if (/context.window|token.*limit|maximum.*context/i.test(msg)) {
    return '本次对话上下文过长，请使用 /reset 重置后再试。';
  }
  if (/AgentUnbound/i.test(msg)) return msg;
  return 'AI 请求失败，请稍后重试。';
}
