const DISABLED_TOOLS_ENV = 'SAMATA_DISABLED_TOOLS';

export function getDisabledToolNames(raw = process.env[DISABLED_TOOLS_ENV] ?? ''): ReadonlySet<string> {
  return new Set(
    raw
      .split(',')
      .map(name => name.trim())
      .filter(Boolean),
  );
}

export function isToolDisabled(name: string): boolean {
  return getDisabledToolNames().has(name);
}

export function filterDisabledTools<T extends { name: string }>(tools: T[]): T[] {
  const disabled = getDisabledToolNames();
  if (disabled.size === 0) return tools;
  return tools.filter(tool => !disabled.has(tool.name));
}

export function disabledToolResult(name: string): string {
  return JSON.stringify({
    error: `工具已被运行环境禁用: ${name}`,
    code: 'TOOL_DISABLED_BY_RUNTIME_POLICY',
  });
}
