import Anthropic from '@anthropic-ai/sdk';
import type {
  ListWrongQuestionsInput,
  MarkWrongQuestionMasteredInput,
  RecordWrongQuestionInput,
  WrongQuestionReportInput,
} from '../llm/tool-types.js';
import { getCurrentAgent, type ToolContext } from '../llm/agents/config.js';
import { getCurrentUser } from '../auth/rbac.js';
import {
  recordWrongQuestion,
  listWrongQuestions,
  markWrongQuestionMastered,
  getWrongQuestionReport,
} from '../commands/wrong-question.js';

function ensureTutorToolAccess(): string | null {
  const agent = getCurrentAgent();
  if (!agent || agent.name !== 'tutor') {
    return JSON.stringify({ error: '错题工具仅对 tutor agent 可见' });
  }
  return null;
}

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'record_wrong_question',
    description: '为当前 tutor 用户记录一条结构化错题，可附带本地图片、Word、PDF 等原始附件路径。',
    input_schema: {
      type: 'object' as const,
      properties: {
        subject: {
          type: 'string',
          enum: ['math', 'chinese', 'english', 'science'],
          description: '学科：math（数学）、chinese（语文）、english（英语）、science（科学）',
        },
        question_summary: { type: 'string', description: '题目摘要，用于回顾和去重' },
        wrong_answer: { type: 'string', description: '孩子当时给出的错误答案（可选）' },
        expected_direction: { type: 'string', description: '希望孩子回顾时重新思考的方向或提示（可选）' },
        error_type: {
          type: 'string',
          enum: ['knowledge', 'logic'],
          description: '错误类型：knowledge（知识性）、logic（逻辑性）',
        },
        error_subtype: { type: 'string', description: '更细的错误子类，如 因果倒置、跳步推理（可选）' },
        analysis: { type: 'string', description: '漏洞分析或讲解要点（可选）' },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: '原始附件路径列表，可传图片、Word、PDF 等本地文件（可选）',
        },
      },
      required: ['subject', 'question_summary'],
    },
  },
  {
    name: 'list_wrong_questions',
    description: '列出当前 tutor 用户的错题。默认只显示未掌握错题，可按学科、错误类型筛选。',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'mastered', 'all'],
          description: '筛选状态：open（未掌握）、mastered（已掌握）、all（全部）',
        },
        subject: {
          type: 'string',
          enum: ['math', 'chinese', 'english', 'science'],
          description: '按学科筛选（可选）',
        },
        error_type: {
          type: 'string',
          enum: ['knowledge', 'logic'],
          description: '按错误类型筛选（可选）',
        },
        limit: { type: 'number', description: '返回条数，默认 20，最大 100' },
      },
      required: [],
    },
  },
  {
    name: 'mark_wrong_question_mastered',
    description: '把一条错题标记为已掌握。需先通过 list_wrong_questions 获取 ID。',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: '错题 ID 或 ID 前缀（通过 list_wrong_questions 获取）' },
      },
      required: ['id'],
    },
  },
  {
    name: 'wrong_question_report',
    description: '生成当前 tutor 用户的错题汇总报告，按学科和错误类型统计，并列出高频错题。',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'mastered', 'all'],
          description: '按掌握状态筛选（可选）',
        },
        subject: {
          type: 'string',
          enum: ['math', 'chinese', 'english', 'science'],
          description: '按学科筛选（可选）',
        },
        error_type: {
          type: 'string',
          enum: ['knowledge', 'logic'],
          description: '按错误类型筛选（可选）',
        },
        limit: { type: 'number', description: '高频错题返回条数，默认 10，最大 50' },
      },
      required: [],
    },
  },
];

function handleRecordWrongQuestion(input: RecordWrongQuestionInput): string {
  const denied = ensureTutorToolAccess();
  if (denied) return denied;
  const result = recordWrongQuestion(input, getCurrentUser().id, getCurrentUser().id);
  if (!result.success || !result.question) return JSON.stringify(result);
  return JSON.stringify({
    success: true,
    created: result.created,
    id: result.question.id.slice(0, 8),
    subject: result.question.subject,
    question_summary: result.question.question_summary,
    status: result.question.status,
    mistake_count: result.question.mistake_count,
    source_type: result.question.source_type,
    assets: result.assets ?? 0,
  });
}

function handleListWrongQuestions(input: ListWrongQuestionsInput): string {
  const denied = ensureTutorToolAccess();
  if (denied) return denied;
  const items = listWrongQuestions(input, getCurrentUser().id);
  if (items.length === 0) return JSON.stringify({ message: '暂无错题记录' });
  return JSON.stringify(items.map(item => ({
    id: item.id.slice(0, 8),
    subject: item.subject,
    question_summary: item.question_summary,
    error_type: item.error_type,
    error_subtype: item.error_subtype,
    status: item.status,
    mistake_count: item.mistake_count,
    source_type: item.source_type,
    last_wrong_at: item.last_wrong_at,
  })));
}

function handleMarkWrongQuestionMastered(input: MarkWrongQuestionMasteredInput): string {
  const denied = ensureTutorToolAccess();
  if (denied) return denied;
  const result = markWrongQuestionMastered(input.id, getCurrentUser().id);
  if (!result.success || !result.question) return JSON.stringify(result);
  return JSON.stringify({
    success: true,
    id: result.question.id.slice(0, 8),
    question_summary: result.question.question_summary,
    status: result.question.status,
    mastered_at: result.question.mastered_at,
  });
}

function handleWrongQuestionReport(input: WrongQuestionReportInput): string {
  const denied = ensureTutorToolAccess();
  if (denied) return denied;
  return JSON.stringify(getWrongQuestionReport(input, getCurrentUser().id));
}

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'record_wrong_question':
      return handleRecordWrongQuestion(input);
    case 'list_wrong_questions':
      return handleListWrongQuestions(input);
    case 'mark_wrong_question_mastered':
      return handleMarkWrongQuestionMastered(input);
    case 'wrong_question_report':
      return handleWrongQuestionReport(input);
    default:
      return null;
  }
}
