import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  log: {
    warn: vi.fn(),
    file: vi.fn(),
    error: vi.fn(),
  },
}));

describe('dream analyze quality guards', () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'samata-dream-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  function writeDream(agent: string, file: string, content: string): void {
    const dir = path.join(tmpDir, 'data', 'dreams', agent);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), content, 'utf-8');
  }

  function validDream(label = '稳定经验'): string {
    return [
      '## 工具使用经验',
      '',
      '### query_trades',
      `- **场景**：需要查询客户交易数据时，先确认用户给的是管理人名还是交易对手代码，避免把中文简称直接传给只接受原始代码的参数。${label}`,
      '- **正确做法**：若已知交易对手代码，优先使用 `party` 精确查询；若未知，先用客户详情或小范围查询识别 `counter_party` 后再精确查询。',
      '- **参数陷阱**：不要把 `view_client` 返回的数字 ID 当作 `client` 传入；当内部映射缺失时，直接使用原始交易对手代码更稳定。',
    ].join('\n');
  }

  it('loads the newest valid dream and skips a truncated newer file', async () => {
    const complete = validDream();
    const truncated = [
      '## 工具使用经验',
      '',
      '### query_trades',
      '- **场景**：用户只提供中文简称时，需要定位交易记录。',
      '- **正确做法**：先用 `view_client` 获取结构化信息。',
      '  1. 用 `view_client` 传入中文简称获取 id、name、微信群名等。',
      '  2. 从返回的 `name` 或',
    ].join('\n');

    writeDream('otcclaw', '2026-06-02.md', complete);
    writeDream('otcclaw', '2026-06-03.md', truncated);

    const { loadDreamFile } = await import('../../../src/services/dream-analyze.js');

    expect(loadDreamFile('otcclaw')).toBe(complete);
  });

  it('rejects a new dream that shrinks far below the previous valid version', async () => {
    const existingDream = `${validDream('历史版本')}\n\n${'补充经验。'.repeat(240)}`;
    const newDream = validDream('短版本');

    const { validateDream } = await import('../../../src/services/dream-analyze.js');
    const result = validateDream(newDream, { existingDream });

    expect(result.pass).toBe(false);
    expect(result.reasons.some(r => r.includes('异常缩水'))).toBe(true);
  });

  it('requires a completion marker for newly generated dream output', async () => {
    const { validateDream } = await import('../../../src/services/dream-analyze.js');

    const missing = validateDream(validDream(), { requireCompletionMarker: true, strictSections: true });
    const complete = validateDream(`${validDream()}\n\n<!-- DREAM_COMPLETE -->`, {
      requireCompletionMarker: true,
      strictSections: true,
    });

    expect(missing.pass).toBe(false);
    expect(missing.reasons).toContain('缺少完成标记');
    expect(missing.retryable).toBe(true);
    expect(complete.pass).toBe(true);
  });

  it('rejects unclosed markdown fences in newly generated dream output', async () => {
    const broken = [
      validDream(),
      '',
      '```ts',
      'const unfinished = true;',
      '',
      '<!-- DREAM_COMPLETE -->',
    ].join('\n');

    const { validateDream } = await import('../../../src/services/dream-analyze.js');
    const result = validateDream(broken, { requireCompletionMarker: true, strictSections: true });

    expect(result.pass).toBe(false);
    expect(result.reasons).toContain('代码块未闭合');
    expect(result.retryable).toBe(true);
  });

  it('retries truncated generation once and writes the completed dream without marker', async () => {
    const provider = {
      name: 'mock',
      defaultModel: 'mock-dream',
      createMessage: vi.fn()
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: validDream('第一次输出') }],
          stop_reason: 'max_tokens',
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: `${validDream('重试输出')}\n\n<!-- DREAM_COMPLETE -->` }],
          stop_reason: 'end_turn',
        }),
    };
    const db = {
      prepare: vi.fn(() => ({
        all: vi.fn(() => [{
          agent_id: 'agent-1',
          channel: 'wework',
          loop_rounds: 4,
          total_tool_calls: 1,
          tools_json: JSON.stringify([{
            name: 'sandbox_exec',
            success: false,
            input: '{"language":"shell"}',
            error: 'missing language',
          }]),
          answer_preview: '用户需要分析 CSV 文件。',
          model: 'mock-dream',
        }]),
      })),
    };

    vi.doMock('../../../src/llm/provider.js', () => ({
      getDreamProvider: () => ({ provider, model: 'mock-dream' }),
    }));
    vi.doMock('../../../src/db/connection.js', () => ({
      getDb: () => db,
    }));

    const { runDreamForAgent } = await import('../../../src/services/dream-analyze.js');
    const ok = await runDreamForAgent('agent-1', 'ticlaw', '2026-06-16');

    expect(ok).toBe(true);
    expect(provider.createMessage).toHaveBeenCalledTimes(2);
    const written = fs.readFileSync(path.join(tmpDir, 'data', 'dreams', 'ticlaw', '2026-06-16.md'), 'utf-8');
    expect(written).toContain('重试输出');
    expect(written).not.toContain('DREAM_COMPLETE');
  });
});
