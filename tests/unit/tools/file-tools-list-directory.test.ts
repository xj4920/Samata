import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupUnitDb, teardownDb, withContext, type UnitTestContext } from '../../helpers/unit-harness.js';

describe('list_directory allowlist guard', () => {
  let ctx: UnitTestContext;

  beforeEach(async () => {
    ctx = await setupUnitDb();
  });

  afterEach(() => {
    teardownDb();
  });

  async function listAs(agentName: string, role: 'admin' | 'user', path: string, channel = 'feishu') {
    const { handleTool } = await import('../../../src/tools/file-tools.js');
    return withContext({ channel, role, agentName }, () =>
      handleTool('list_directory', { path }),
    );
  }

  it('allows directories covered by the agent file allowlist', async () => {
    const result = await listAs('ticlaw', 'user', 'docs/wind-tables');
    const parsed = JSON.parse(result as string);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((entry: any) => entry.name === 'ASHAREEODPRICES.md')).toBe(true);
  });

  it('rejects directories outside the agent file allowlist', async () => {
    const result = await listAs('ticlaw', 'user', 'src');
    const parsed = JSON.parse(result as string);

    expect(parsed.error).toMatch(/list_directory 拒绝/);
    expect(parsed.error).toMatch(/不在 ticlaw 的可读白名单/);
  });

  it('rejects project-outside traversal', async () => {
    const result = await listAs('ticlaw', 'user', '../samata-plugin-work');
    const parsed = JSON.parse(result as string);

    expect(parsed.error).toMatch(/list_directory 拒绝/);
    expect(parsed.error).toMatch(/路径不在项目目录内/);
  });

  it('filters internal directories even for admins', async () => {
    const result = await listAs('admin', 'admin', '.', 'cli');
    const parsed = JSON.parse(result as string);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((entry: any) => entry.name === '.git')).toBe(false);
  });
});
