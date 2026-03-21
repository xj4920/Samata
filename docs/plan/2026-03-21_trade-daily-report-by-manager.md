# 执行计划 - 按管理人查看交易日报 Prompt 优化

## 需求理解
用户需要一个能够生成“按管理人查看交易日报”的 Prompt（Skill），并确保计算结果与提供的样例完全一致。

### 样例输出要求
1. **标题**: 📊 {Date} 北向极速交易日报（管理人维度）
2. **表格字段**: 排名、管理人、存续本金 (notional_t)、T日成交 (trade_amt)、成交笔数、T日净买入 (ft_net)、校验 (✅)
3. **数据汇总**: 存续名义本金、成交总额 (trade_amt_ft)、净买入 (ft_net)
4. **格式**: 使用表格布局，包含 Emoji 奖牌（🥇🥈🥉），金额需格式化（亿/万），净买入需带正负号。

## 影响范围
- `src/llm/agents/prompt.ts` (Skill 内容)
- 数据库中的 `skills` 表

## 实施步骤
1. **数据调研**: 
   - 使用 `query_trades` 工具获取 20260320 的原始数据。
   - 验证 `notional_t`, `trade_amt_ft`, `ft_net` 的计算逻辑。
   - `notional_t` 在 `src/commands/trade.ts` 中定义为 `(r.notional_ft_t_1 ?? 0) + (r.ft_net ?? 0)`。
   - `trade_amt` 对应 `trade_amt_ft`。
   - `ft_net` 对应 `ft_net`。
   - 成交笔数对应 `trade_num`。

2. **逻辑核对**:
   - Jump: notional_t=60.05亿, trade_amt=62.09亿, ft_net=+6589万
   - Expedition: notional_t=50.88亿, trade_amt=48.97亿, ft_net=-1845万
   - ...以此类推。
   - 汇总数据: notional_t=143.32亿, trade_amt_ft=132.16亿, ft_net=+1.55亿。

3. **Prompt 编写**:
   - 明确指令：获取所有管理人的交易数据（`list_customers` 获取列表，遍历 `query_trades`）。
   - 数据处理：按管理人聚合数据（`notional_t`, `trade_amt_ft`, `ft_net`, `trade_num`）。
   - 格式化输出：亿/万单位转换，保留两位小数，表格布局，Emoji 奖牌。
   - 校验逻辑：每行后面加 ✅。

4. **测试与验证**:
   - 在 Agent 中运行该 Skill。
   - 对比输出结果与样例，调整 Prompt 直到完全匹配。

## 验收标准
- 输出格式与样例一致。
- 20260320 的数据计算结果完全正确。
- 汇总数据正确。
