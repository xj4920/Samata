import Anthropic from '@anthropic-ai/sdk';

let client: Anthropic | null = null;

export function initClaude(): boolean {
  // Support both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN (Claude CLI style)
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey || apiKey === 'your-api-key-here') {
    return false;
  }

  const opts: ConstructorParameters<typeof Anthropic>[0] = { apiKey };

  // Support custom base URL (e.g. proxy/gateway)
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  if (baseURL) {
    opts.baseURL = baseURL;
  }

  client = new Anthropic(opts);
  return true;
}

export function getClaude(): Anthropic {
  if (!client) throw new Error('Claude 未初始化，请检查 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN');
  return client;
}
