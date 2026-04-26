import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';
import { getCurrentAgent } from '../llm/agents/config.js';
import { getCurrentUser } from '../auth/rbac.js';
import {
  addHealthRecord,
  queryHealthRecords,
  getHealthSummary,
} from '../commands/health.js';
import { createReminder } from '../commands/reminder.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'add_health_record',
    description: '记录一条健康数据（血压、血糖、体重、BMI等）。测量时间不填则默认为现在。',
    input_schema: {
      type: 'object' as const,
      properties: {
        record_type: {
          type: 'string',
          description: '指标类型，如 blood_pressure、blood_sugar、weight、bmi、heart_rate、custom',
        },
        value: {
          type: 'string',
          description: '数值，血压用 JSON 如 {"systolic":120,"diastolic":80}，其他为数字字符串',
        },
        unit: { type: 'string', description: '单位，如 mmHg、mmol/L、kg、bpm' },
        measured_at: { type: 'string', description: '测量时间，ISO8601 格式（可选，默认当前时间）' },
        notes: { type: 'string', description: '备注（可选）' },
      },
      required: ['record_type', 'value'],
    },
  },
  {
    name: 'query_health_records',
    description: '查询历史健康数据，支持按指标类型和时间范围筛选',
    input_schema: {
      type: 'object' as const,
      properties: {
        record_type: { type: 'string', description: '指标类型筛选（可选）' },
        start_date: { type: 'string', description: '开始日期，格式 YYYY-MM-DD（可选）' },
        end_date: { type: 'string', description: '结束日期，格式 YYYY-MM-DD（可选）' },
        limit: { type: 'number', description: '返回条数，默认 20' },
      },
      required: [],
    },
  },
  {
    name: 'health_summary',
    description: '获取健康数据概览，返回各指标最近3条记录',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'log_sleep',
    description: '记录一次睡眠/作息情况，包括入睡时间、起床时间、睡眠质量等',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: '日期，格式 YYYY-MM-DD（可选，默认今天）' },
        bedtime: { type: 'string', description: '入睡时间，格式 HH:MM（可选）' },
        wake_time: { type: 'string', description: '起床时间，格式 HH:MM（可选）' },
        duration_hours: { type: 'number', description: '睡眠时长（小时），可不填由系统根据入睡/起床时间推算' },
        quality: { type: 'string', description: '睡眠质量：excellent（极好）、good（良好）、fair（一般）、poor（差）' },
        notes: { type: 'string', description: '备注，如"多梦"、"入睡困难"等（可选）' },
      },
      required: [],
    },
  },
  {
    name: 'log_meal',
    description: '记录一次饮食/用餐情况',
    input_schema: {
      type: 'object' as const,
      properties: {
        meal_type: { type: 'string', description: '餐次：breakfast（早餐）、lunch（午餐）、dinner（晚餐）、snack（零食/加餐）' },
        foods: { type: 'string', description: '食物描述，如"米饭、红烧肉、青菜汤"' },
        calories: { type: 'number', description: '估算卡路里（kcal，可选）' },
        meal_time: { type: 'string', description: '用餐时间，ISO8601 格式（可选，默认当前时间）' },
        notes: { type: 'string', description: '备注（可选）' },
      },
      required: ['foods'],
    },
  },
  {
    name: 'log_symptom',
    description: '记录一次身体症状，用于健康追踪和就诊参考',
    input_schema: {
      type: 'object' as const,
      properties: {
        symptom: { type: 'string', description: '症状名称，如"头痛"、"发烧"、"咳嗽"' },
        severity: { type: 'number', description: '严重程度 1-5（1=轻微，5=严重）' },
        body_part: { type: 'string', description: '部位（可选），如"前额"、"腹部"' },
        duration: { type: 'string', description: '持续时间（可选），如"2小时"、"3天"' },
        onset_at: { type: 'string', description: '症状出现时间，ISO8601 格式（可选，默认当前时间）' },
        notes: { type: 'string', description: '其他说明（可选）' },
      },
      required: ['symptom'],
    },
  },
  {
    name: 'set_medication_reminder',
    description: '设置用药提醒，支持指定药物名称、剂量和服药时间',
    input_schema: {
      type: 'object' as const,
      properties: {
        drug: { type: 'string', description: '药物名称' },
        dose: { type: 'string', description: '剂量，如 100mg、1片' },
        instruction: { type: 'string', description: '服药说明（可选），如 饭后服用、空腹服用' },
        remind_at: { type: 'string', description: '提醒时间，ISO8601 格式' },
        delay_minutes: { type: 'number', description: '从现在起延迟多少分钟后提醒（与 remind_at 二选一）' },
      },
      required: ['drug', 'dose'],
    },
  },
];

function getUserAndAgent() {
  const user = getCurrentUser();
  const agent = getCurrentAgent();
  return { userId: user.id, agentId: agent?.id ?? 'default' };
}

function handleAddHealthRecord(input: {
  record_type: string;
  value: string;
  unit?: string;
  measured_at?: string;
  notes?: string;
}): string {
  const { userId, agentId } = getUserAndAgent();
  const result = addHealthRecord(userId, agentId, input.record_type, input.value, input.unit, input.measured_at, input.notes);
  return JSON.stringify(result);
}

function handleQueryHealthRecords(input: {
  record_type?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
}): string {
  const { userId, agentId } = getUserAndAgent();
  const records = queryHealthRecords(userId, agentId, input.record_type, input.start_date, input.end_date, input.limit);
  if (records.length === 0) return JSON.stringify({ message: '暂无健康数据记录' });
  return JSON.stringify(records);
}

function handleHealthSummary(): string {
  const { userId, agentId } = getUserAndAgent();
  const summary = getHealthSummary(userId, agentId);
  if (Object.keys(summary).length === 0) return JSON.stringify({ message: '暂无健康数据' });
  return JSON.stringify(summary);
}

function handleLogSleep(input: {
  date?: string;
  bedtime?: string;
  wake_time?: string;
  duration_hours?: number;
  quality?: string;
  notes?: string;
}): string {
  const { userId, agentId } = getUserAndAgent();
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  let duration = input.duration_hours;
  if (duration == null && input.bedtime && input.wake_time) {
    const [bh, bm] = input.bedtime.split(':').map(Number);
    const [wh, wm] = input.wake_time.split(':').map(Number);
    let mins = (wh * 60 + wm) - (bh * 60 + bm);
    if (mins < 0) mins += 24 * 60;
    duration = Math.round(mins / 60 * 10) / 10;
  }
  const value = JSON.stringify({
    date,
    bedtime: input.bedtime,
    wake_time: input.wake_time,
    duration_hours: duration,
    quality: input.quality,
  });
  const result = addHealthRecord(userId, agentId, 'sleep', value, undefined, `${date}T00:00:00`, input.notes);
  return JSON.stringify(result);
}

function handleLogMeal(input: {
  meal_type?: string;
  foods: string;
  calories?: number;
  meal_time?: string;
  notes?: string;
}): string {
  const { userId, agentId } = getUserAndAgent();
  const value = JSON.stringify({
    meal_type: input.meal_type,
    foods: input.foods,
    calories: input.calories,
  });
  const result = addHealthRecord(userId, agentId, 'meal', value, undefined, input.meal_time, input.notes);
  return JSON.stringify(result);
}

function handleLogSymptom(input: {
  symptom: string;
  severity?: number;
  body_part?: string;
  duration?: string;
  onset_at?: string;
  notes?: string;
}): string {
  const { userId, agentId } = getUserAndAgent();
  const value = JSON.stringify({
    symptom: input.symptom,
    severity: input.severity,
    body_part: input.body_part,
    duration: input.duration,
  });
  const onset = input.onset_at ?? new Date(Date.now() + 8 * 3_600_000).toISOString().replace('Z', '+08:00');
  const result = addHealthRecord(userId, agentId, 'symptom', value, undefined, onset, input.notes);
  return JSON.stringify(result);
}

function handleSetMedicationReminder(
  input: {
    drug: string;
    dose: string;
    instruction?: string;
    remind_at?: string;
    delay_minutes?: number;
  },
  ctx?: ToolContext,
): string {
  if (!ctx?.deliveryContext) {
    return JSON.stringify({ error: '无法设置提醒：缺少投递上下文。请通过飞书或 Telegram 渠道使用此功能。' });
  }
  const agentId = getCurrentAgent()?.id ?? 'default';
  let remindAt: number;
  if (input.remind_at) {
    remindAt = new Date(input.remind_at).getTime();
    if (isNaN(remindAt)) return JSON.stringify({ error: `无效的时间格式: ${input.remind_at}` });
  } else if (input.delay_minutes != null) {
    remindAt = Date.now() + input.delay_minutes * 60_000;
  } else {
    return JSON.stringify({ error: '请提供 remind_at 或 delay_minutes' });
  }
  if (remindAt <= Date.now()) {
    return JSON.stringify({ error: '提醒时间必须在未来' });
  }

  const instruction = input.instruction ? `（${input.instruction}）` : '';
  const message = `💊 用药提醒：${input.drug} ${input.dose}${instruction}`;

  const result = createReminder({
    agentId,
    message,
    remindAt,
    channel: ctx.deliveryContext.channel,
    targetId: ctx.deliveryContext.targetId,
    appId: ctx.deliveryContext.appId,
  });
  const readableTime = new Date(remindAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  return JSON.stringify({ ...result, remind_at: readableTime, message });
}

export async function handleTool(name: string, input: any, ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'add_health_record': return handleAddHealthRecord(input);
    case 'query_health_records': return handleQueryHealthRecords(input);
    case 'health_summary': return handleHealthSummary();
    case 'log_sleep': return handleLogSleep(input);
    case 'log_meal': return handleLogMeal(input);
    case 'log_symptom': return handleLogSymptom(input);
    case 'set_medication_reminder': return handleSetMedicationReminder(input, ctx);
    default: return null;
  }
}
