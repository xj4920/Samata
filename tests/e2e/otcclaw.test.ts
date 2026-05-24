import { describe, it, expect } from 'vitest';
import { useTestAgent } from '../helpers/test-harness.js';

describe('otcclaw agent', () => {
  const { init } = useTestAgent();

  it('今天是交易日吗 → 应调用 calculate_date', async () => {
    const { runChat } = await init('otcclaw');
    const { reply, tools } = await runChat('今天是交易日吗？');

    expect(reply).toBeTruthy();
    const dateTool = tools.find(t => t.name === 'calculate_date');
    expect(dateTool).toBeDefined();
    const result = JSON.parse(dateTool!.result);
    expect(result).toHaveProperty('is_trading_day');
  });

  it('介绍下宽德最近交易 → 应调用 query_trades 或 trade_summary', async () => {
    const { runChat } = await init('otcclaw');
    const { reply, tools } = await runChat('介绍下宽德最近交易？');

    expect(reply).toBeTruthy();
    const tradeTool = tools.find(t => t.name === 'query_trades' || t.name === 'trade_summary');
    expect(tradeTool).toBeDefined();
  });

  it('查询长江电力最近一周收盘价 → 应调用 sandbox_exec', async () => {
    const { runChat } = await init('otcclaw');
    const { reply, tools } = await runChat('查询下长江电力最近一周收盘价');

    expect(reply).toBeTruthy();
    const sandbox = tools.find(t => t.name === 'sandbox_exec');
    expect(sandbox).toBeDefined();
    expect(sandbox!.result.length).toBeGreaterThan(0);
  });

  it('查一下昨天北向极速总成交额 → 应调用 trade_summary 或 query_trades', async () => {
    const { runChat } = await init('otcclaw');
    const { reply, tools } = await runChat('查一下昨天北向极速总成交额');

    expect(reply).toBeTruthy();
    const tradeTool = tools.find(t => t.name === 'trade_summary' || t.name === 'query_trades' || t.name === 'sandbox_exec');
    expect(tradeTool).toBeDefined();
  });

  it('按昨天Jump成交计算年化换手率 → 应调用 query_trades', async () => {
    const { runChat } = await init('otcclaw');
    const { reply, tools } = await runChat('按昨天Jump成交，计算年化换手率。');

    expect(reply).toBeTruthy();
    const tradeTool = tools.find(t => t.name === 'query_trades' || t.name === 'trade_summary' || t.name === 'sandbox_exec');
    expect(tradeTool).toBeDefined();
  });

  it('搜一下镁光与闪迪差异 → 应调用 web_search', async () => {
    const { runChat } = await init('otcclaw');
    const { reply, tools } = await runChat('搜一下镁光与闪迪、海力士、三星主营业务的差异。');

    expect(reply).toBeTruthy();
    const webTool = tools.find(t => t.name === 'web_search');
    expect(webTool).toBeDefined();
  });
});
