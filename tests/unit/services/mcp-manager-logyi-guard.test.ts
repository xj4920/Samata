import { describe, expect, it } from 'vitest';
import { __mcpManagerTest } from '../../../src/services/mcp-manager.js';

describe('LogYi MCP time range guard', () => {
  const guard = __mcpManagerTest.guardLogyiSearchTimeRange;

  it('adds absolute time range guidance to LogYi search tool descriptions', () => {
    const description = __mcpManagerTest.buildMcpToolDescription('logyi', 'logyi_submit_search', 'submit logs');
    expect(description).toContain('时间范围约束');
    expect(description).toContain('默认使用 Asia/Shanghai 当日');
    expect(description).toContain('不要自行跨日、跨年或扩大到历史年份');
  });

  it('adds LogYi guidance to per-agent LogYi server instances', () => {
    __mcpManagerTest.serverConfigs.set('logyiotcmsclaw', { kind: 'logyi', command: 'npx', agents: ['OtcmsClaw'] });
    const description = __mcpManagerTest.buildMcpToolDescription('logyiotcmsclaw', 'logyi_submit_search', 'submit logs');
    expect(description).toContain('时间范围约束');
    expect(description).toContain('默认使用 Asia/Shanghai 当日');
    __mcpManagerTest.serverConfigs.delete('logyiotcmsclaw');
  });

  it('rejects search tools without an absolute time range', () => {
    const result = guard('logyi_submit_search', { query: 'Future IF2506 has expire' });
    expect(result.error).toContain('缺少绝对时间范围');
  });

  it('allows the explicit default current-day range', () => {
    const result = guard('logyi_submit_search', {
      query: '拒单',
      start_time: '2026-06-22 00:00:00',
      end_time: '2026-06-22 10:15:00',
    });
    expect(result.error).toBeUndefined();
  });

  it('rejects unconfirmed cross-year searches', () => {
    const result = guard('logyi_submit_search', {
      query: 'IF2506',
      start_time: '2025-12-31 00:00:00',
      end_time: '2026-01-01 00:00:00',
    });
    expect(result.error).toContain('跨年范围');
  });

  it('allows an explicitly specified historical single day', () => {
    const result = guard('logyi_submit_search', {
      query: 'Future IF2506 has expire',
      start_time: '2025-06-20 00:00:00',
      end_time: '2025-06-20 23:59:59',
    });
    expect(result.error).toBeUndefined();
  });

  it('requires confirmation for ranges wider than seven days and strips confirmation fields', () => {
    const wide = guard('logyi_submit_search', {
      query: '拒单',
      start_time: '2025-06-01 00:00:00',
      end_time: '2025-06-10 23:59:59',
    });
    expect(wide.error).toContain('超过 7 天');

    const confirmed = guard('logyi_submit_search', {
      query: '拒单',
      start_time: '2025-06-01 00:00:00',
      end_time: '2025-06-10 23:59:59',
      time_range_confirmed: true,
    });
    expect(confirmed.error).toBeUndefined();
    expect(confirmed.input).not.toHaveProperty('time_range_confirmed');
  });

  it('does not guard LogYi result-fetch tools', () => {
    const result = guard('logyi_fetch_search', { search_id: 'abc' });
    expect(result.error).toBeUndefined();
  });
});
