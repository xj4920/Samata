import Anthropic from '@anthropic-ai/sdk';
import { calculateDate } from '../commands/date.js';
import type { CalculateDateInput } from '../llm/tool-types.js';
import type { ToolContext } from '../llm/agents/config.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'calculate_date',
    description: [
      '日期计算工具，支持 4 种操作（所有日期默认 Asia/Shanghai 时区，格式 YYYY-MM-DD）：',
      '',
      '1. shift — 日期平移：给定日期加减天数/月数/年数。skip_non_trading=true 时遇非交易日顺延到下一交易日。',
      '   适用于场外期权按自然日加 N 月后顺延到下一交易日的到期日推算。',
      '   ⚠️ 场内 ETF 期权（第四个周三）/ 股指期权（第三个周五）到期日请勿用本工具，需告知用户具体规则后人工确认。',
      '2. diff — 计算两日期之间的自然日差和交易日差。',
      '3. is_trading_day — 查询某日是否为 A 股交易日（含周末调休上班日判断）。',
      '4. now — 返回当前精确时间（到秒）+ 交易日状态。长对话中追问"现在几点"应调用此操作而非依赖 prompt 中的日期。',
      '',
      '交易日历数据来源：上海证券交易所（SSE）官方交易日历，覆盖 1990 年至 2040 年。',
      '超出覆盖范围的日期查询将返回错误，绝不 fallback 到简单的周末检测。',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        operation: {
          type: 'string' as const,
          enum: ['shift', 'diff', 'is_trading_day', 'now'] as const,
          description: '操作类型：shift（日期平移）、diff（日期差计算）、is_trading_day（交易日查询）、now（当前时间）',
        },
        date: { type: 'string', description: '基准日期，YYYY-MM-DD 格式（shift / is_trading_day 操作必填）' },
        days: { type: 'number', description: '平移天数，负数为减（shift 操作可选）' },
        months: { type: 'number', description: '平移月数，负数为减（shift 操作可选）。注：月末日期加月会自动修正，如 2025-01-31 + 1月 = 2025-02-28' },
        years: { type: 'number', description: '平移年数，负数为减（shift 操作可选）。注：闰年 02-29 加 1年 = 02-28' },
        skip_non_trading: { type: 'boolean', description: '是否将非交易日顺延到下一交易日（shift 操作可选，默认 false）' },
        start_date: { type: 'string', description: '起始日期，YYYY-MM-DD（diff 操作必填）' },
        end_date: { type: 'string', description: '结束日期，YYYY-MM-DD（diff 操作必填）' },
        tz: { type: 'string', description: '时区，默认 Asia/Shanghai（now 操作可选）' },
      },
      required: ['operation'],
    },
  },
];

export async function handleTool(name: string, input: CalculateDateInput, _ctx?: ToolContext): Promise<string | null> {
  if (name !== 'calculate_date') return null;

  const result = calculateDate(input.operation, input);
  return JSON.stringify(result);
}