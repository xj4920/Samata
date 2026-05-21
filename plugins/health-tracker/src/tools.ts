import type { ToolDefinition } from '@samata/plugin-sdk';

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'add_health_record',
    description: '记录一条健康数据（血压、血糖、体重、BMI等）。测量时间不填则默认为现在。',
    input_schema: {
      type: 'object',
      properties: {
        record_type: { type: 'string', description: '指标类型，如 blood_pressure、blood_sugar、weight、bmi、heart_rate、custom' },
        value: { type: 'string', description: '数值，血压用 JSON 如 {"systolic":120,"diastolic":80}，其他为数字字符串' },
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
      type: 'object',
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
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'log_sleep',
    description: '记录一次睡眠/作息情况，包括入睡时间、起床时间、睡眠质量等',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期，格式 YYYY-MM-DD（可选，默认今天）' },
        bedtime: { type: 'string', description: '入睡时间，格式 HH:MM（可选）' },
        wake_time: { type: 'string', description: '起床时间，格式 HH:MM（可选）' },
        duration_hours: { type: 'number', description: '睡眠时长（小时）' },
        quality: { type: 'string', description: '睡眠质量：excellent、good、fair、poor' },
        notes: { type: 'string', description: '备注（可选）' },
      },
      required: [],
    },
  },
  {
    name: 'log_meal',
    description: '记录一次饮食/用餐情况',
    input_schema: {
      type: 'object',
      properties: {
        meal_type: { type: 'string', description: '餐次：breakfast、lunch、dinner、snack' },
        foods: { type: 'string', description: '食物描述' },
        calories: { type: 'number', description: '估算卡路里（kcal，可选）' },
        meal_time: { type: 'string', description: '用餐时间，ISO8601 格式（可选）' },
        notes: { type: 'string', description: '备注（可选）' },
      },
      required: ['foods'],
    },
  },
  {
    name: 'log_symptom',
    description: '记录一次身体症状，用于健康追踪和就诊参考',
    input_schema: {
      type: 'object',
      properties: {
        symptom: { type: 'string', description: '症状名称，如"头痛"、"发烧"' },
        severity: { type: 'number', description: '严重程度 1-5' },
        body_part: { type: 'string', description: '部位（可选）' },
        duration: { type: 'string', description: '持续时间（可选）' },
        onset_at: { type: 'string', description: '症状出现时间（可选）' },
        notes: { type: 'string', description: '其他说明（可选）' },
      },
      required: ['symptom'],
    },
  },
  {
    name: 'set_medication_reminder',
    description: '设置用药提醒，支持指定药物名称、剂量和服药时间',
    input_schema: {
      type: 'object',
      properties: {
        drug: { type: 'string', description: '药物名称' },
        dose: { type: 'string', description: '剂量，如 100mg、1片' },
        instruction: { type: 'string', description: '服药说明（可选）' },
        remind_at: { type: 'string', description: '提醒时间，ISO8601 格式' },
        delay_minutes: { type: 'number', description: '从现在起延迟多少分钟后提醒（与 remind_at 二选一）' },
      },
      required: ['drug', 'dose'],
    },
  },
];
