import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';
import { getCurrentAgent } from '../llm/agents/config.js';
import { getCurrentUser } from '../auth/rbac.js';
import {
  addHealthRecord,
  queryHealthRecords,
  getHealthSummary,
  archiveHealthFile,
  listHealthFiles,
  getHealthFile,
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
    name: 'archive_health_file',
    description: '将健康相关图片（检查报告、化验单、处方等）存档到健康档案目录，并记录元数据',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: {
          type: 'string',
          description: '图片或文件的本地路径（支持 ~ 前缀）',
        },
        doc_type: {
          type: 'string',
          description: '文档类型：blood_test（血检）、imaging（影像）、prescription（处方）、report（报告）、other',
        },
        measured_at: { type: 'string', description: '检查日期，ISO8601 格式（可选，默认当前时间）' },
        notes: { type: 'string', description: '备注（可选）' },
      },
      required: ['file_path', 'doc_type'],
    },
  },
  {
    name: 'list_health_files',
    description: '列出已存档的健康文件记录，支持按文档类型筛选',
    input_schema: {
      type: 'object' as const,
      properties: {
        doc_type: { type: 'string', description: '文档类型筛选（可选）' },
        limit: { type: 'number', description: '返回条数，默认 20' },
      },
      required: [],
    },
  },
  {
    name: 'view_health_file',
    description: '根据 ID 获取存档健康文件的路径，可用于重新加载图片进行对比分析',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: '文件记录 ID 或 ID 前缀（通过 list_health_files 获取）' },
      },
      required: ['id'],
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

function handleArchiveHealthFile(input: {
  file_path: string;
  doc_type: string;
  measured_at?: string;
  notes?: string;
}): string {
  const { userId, agentId } = getUserAndAgent();
  const result = archiveHealthFile(userId, agentId, input.file_path, input.doc_type, input.measured_at, input.notes);
  return JSON.stringify(result);
}

function handleListHealthFiles(input: { doc_type?: string; limit?: number }): string {
  const { userId, agentId } = getUserAndAgent();
  const files = listHealthFiles(userId, agentId, input.doc_type, input.limit);
  if (files.length === 0) return JSON.stringify({ message: '暂无存档文件' });
  return JSON.stringify(files.map(f => ({
    id: f.id.slice(0, 8),
    doc_type: f.doc_type,
    measured_at: f.measured_at,
    notes: f.notes,
    file_path: f.file_path,
  })));
}

function handleViewHealthFile(input: { id: string }): string {
  const { userId } = getUserAndAgent();
  const file = getHealthFile(input.id, userId);
  if (!file) return JSON.stringify({ error: `未找到文件记录: ${input.id}` });
  return JSON.stringify({
    id: file.id.slice(0, 8),
    doc_type: file.doc_type,
    measured_at: file.measured_at,
    notes: file.notes,
    file_path: file.file_path,
  });
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
    case 'archive_health_file': return handleArchiveHealthFile(input);
    case 'list_health_files': return handleListHealthFiles(input);
    case 'view_health_file': return handleViewHealthFile(input);
    case 'set_medication_reminder': return handleSetMedicationReminder(input, ctx);
    default: return null;
  }
}
