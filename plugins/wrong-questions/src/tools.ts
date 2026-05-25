import type { ToolDefinition } from '@samata-platform/plugin-sdk';

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'record_wrong_question',
    description: '为当前用户记录一条结构化错题，可附带本地图片、Word、PDF 等原始附件路径。',
    input_schema: {
      type: 'object',
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
        error_subtype: { type: 'string', description: '更细的错误子类（可选）' },
        analysis: { type: 'string', description: '漏洞分析或讲解要点（可选）' },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: '原始附件路径列表（可选）',
        },
      },
      required: ['subject', 'question_summary'],
    },
  },
  {
    name: 'list_wrong_questions',
    description: '列出当前用户的错题。默认只显示未掌握错题，可按学科、错误类型筛选。',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'mastered', 'all'], description: '筛选状态' },
        subject: { type: 'string', enum: ['math', 'chinese', 'english', 'science'], description: '按学科筛选' },
        error_type: { type: 'string', enum: ['knowledge', 'logic'], description: '按错误类型筛选' },
        limit: { type: 'number', description: '返回条数，默认 20，最大 100' },
      },
      required: [],
    },
  },
  {
    name: 'mark_wrong_question_mastered',
    description: '把一条错题标记为已掌握。需先通过 list_wrong_questions 获取 ID。',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '错题 ID 或 ID 前缀' },
      },
      required: ['id'],
    },
  },
  {
    name: 'wrong_question_report',
    description: '生成错题汇总报告，按学科和错误类型统计，并列出高频错题。',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'mastered', 'all'], description: '按掌握状态筛选' },
        subject: { type: 'string', enum: ['math', 'chinese', 'english', 'science'], description: '按学科筛选' },
        error_type: { type: 'string', enum: ['knowledge', 'logic'], description: '按错误类型筛选' },
        limit: { type: 'number', description: '高频错题返回条数，默认 10' },
      },
      required: [],
    },
  },
];
