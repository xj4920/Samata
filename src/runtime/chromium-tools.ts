const CHROMIUM_MCP_SERVERS = new Set(['devtools']);

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return undefined;
}

export function areChromiumToolsDisabled(): boolean {
  const explicitDisable = parseBooleanEnv(process.env.SAMATA_DISABLE_CHROMIUM_TOOLS);
  if (explicitDisable !== undefined) return explicitDisable;

  const explicitEnable = parseBooleanEnv(process.env.SAMATA_ENABLE_CHROMIUM_TOOLS);
  if (explicitEnable !== undefined) return !explicitEnable;

  return process.env.NODE_ENV === 'production';
}

export function isChromiumMcpServer(serverName: string): boolean {
  return CHROMIUM_MCP_SERVERS.has(serverName);
}

export function isChromiumMcpServerDisabled(serverName: string): boolean {
  return isChromiumMcpServer(serverName) && areChromiumToolsDisabled();
}

export function chromiumToolsDisabledMessage(): string {
  return '当前运行环境已禁用 Chromium/Chrome DevTools 浏览器工具（mcp_devtools_*）。请改用 web_search/web_fetch、知识库或已有上下文；如果生产网络不可访问，请直接说明无法在线访问。';
}
