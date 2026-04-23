import { getDb } from '../db/connection.js';
import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { getCurrentAgent } from '../llm/agent.js';
import { getCurrentUser } from '../auth/rbac.js';
import { log } from '../utils/logger.js';
import { renderTable } from '../utils/table.js';
import type {
  ListWrongQuestionsInput,
  RecordWrongQuestionInput,
  WrongQuestionErrorType,
  WrongQuestionReportInput,
  WrongQuestionSourceType,
  WrongQuestionSubject,
} from '../llm/tool-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRONG_QUESTIONS_ROOT_ABS = path.resolve(__dirname, '../../data/wrong-questions');

const SUBJECT_LABELS: Record<WrongQuestionSubject, string> = {
  math: '数学',
  chinese: '语文',
  english: '英语',
  science: '科学',
};

const ERROR_TYPE_LABELS: Record<WrongQuestionErrorType, string> = {
  knowledge: '知识性',
  logic: '逻辑性',
};

const SOURCE_EXT_TO_TYPE: Record<string, WrongQuestionSourceType> = {
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.doc': 'document',
  '.docx': 'document',
  '.pdf': 'document',
  '.txt': 'document',
  '.md': 'document',
};

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
};

export interface WrongQuestion {
  id: string;
  agent_id: string;
  user_id: string;
  subject: WrongQuestionSubject;
  question_summary: string;
  wrong_answer: string | null;
  expected_direction: string | null;
  error_type: WrongQuestionErrorType;
  error_subtype: string | null;
  analysis: string | null;
  status: 'open' | 'mastered';
  mistake_count: number;
  source_type: WrongQuestionSourceType;
  storage_dir: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_wrong_at: string;
  mastered_at: string | null;
}

export interface WrongQuestionAsset {
  id: string;
  wrong_question_id: string;
  asset_role: 'original' | 'annotated' | 'cropped' | 'ocr';
  file_name: string;
  file_ext: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  stored_path: string;
  created_at: string;
}

export interface WrongQuestionDetail {
  question: WrongQuestion;
  assets: WrongQuestionAsset[];
}

function requireTutorAgent(): { success: true; agentId: string } | { success: false; error: string } {
  const agent = getCurrentAgent();
  if (!agent || agent.name !== 'tutor') {
    return { success: false, error: '错题集仅在 tutor agent 下可用' };
  }
  return { success: true, agentId: agent.id };
}

function resolveAttachmentPath(filePath: string): string {
  return filePath.startsWith('~/') ? path.join(os.homedir(), filePath.slice(2)) : path.resolve(filePath);
}

function getStorageDirAbs(questionId: string, agentId: string, userId: string): string {
  return path.join(WRONG_QUESTIONS_ROOT_ABS, agentId, userId, questionId.slice(0, 8));
}

function getStorageDirRel(questionId: string, agentId: string, userId: string): string {
  return path.posix.join('data', 'wrong-questions', agentId, userId, questionId.slice(0, 8));
}

function detectSourceType(filePaths?: string[]): WrongQuestionSourceType {
  if (!filePaths || filePaths.length === 0) return 'text';
  const allImages = filePaths.every(filePath => {
    const ext = path.extname(filePath).toLowerCase();
    return SOURCE_EXT_TO_TYPE[ext] === 'image';
  });
  return allImages ? 'image' : 'document';
}

function persistAssets(
  questionId: string,
  agentId: string,
  userId: string,
  filePaths: string[],
): { success: true; storageDir: string; assets: Omit<WrongQuestionAsset, 'created_at'>[] } | { success: false; error: string } {
  const storageDirAbs = getStorageDirAbs(questionId, agentId, userId);
  const storageDirRel = getStorageDirRel(questionId, agentId, userId);
  fs.mkdirSync(storageDirAbs, { recursive: true });

  const assets: Omit<WrongQuestionAsset, 'created_at'>[] = [];
  for (let i = 0; i < filePaths.length; i += 1) {
    const originalPath = filePaths[i];
    const resolved = resolveAttachmentPath(originalPath);
    if (!fs.existsSync(resolved)) {
      return { success: false, error: `附件不存在: ${originalPath}` };
    }

    const ext = path.extname(resolved).toLowerCase();
    const destName = `original-${i + 1}${ext}`;
    const destAbs = path.join(storageDirAbs, destName);
    const storedPath = path.posix.join(storageDirRel, destName);

    fs.copyFileSync(resolved, destAbs);

    assets.push({
      id: uuid(),
      wrong_question_id: questionId,
      asset_role: 'original',
      file_name: path.basename(resolved),
      file_ext: ext || null,
      mime_type: MIME_BY_EXT[ext] ?? null,
      size_bytes: fs.statSync(destAbs).size,
      stored_path: storedPath,
    });
  }

  return { success: true, storageDir: storageDirRel, assets };
}

function getWrongQuestionByPrefix(idPrefix: string, agentId: string, userId: string): WrongQuestion | null {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM wrong_questions
     WHERE id LIKE ? AND agent_id = ? AND user_id = ?
     ORDER BY created_at DESC
     LIMIT 1`
  ).get(`${idPrefix}%`, agentId, userId) as WrongQuestion | null;
}

export function recordWrongQuestion(
  input: RecordWrongQuestionInput,
  userId: string,
  createdBy: string,
): { success: boolean; created?: boolean; id?: string; question?: WrongQuestion; assets?: number; error?: string } {
  const access = requireTutorAgent();
  if (!access.success) return access;
  const agentId = access.agentId;
  const db = getDb();
  const summary = input.question_summary.trim();
  if (!summary) return { success: false, error: '题目摘要不能为空' };

  const now = new Date().toISOString();
  const filePaths = input.file_paths?.filter(Boolean) ?? [];

  const existing = db.prepare(
    `SELECT * FROM wrong_questions
     WHERE agent_id = ? AND user_id = ? AND subject = ? AND question_summary = ?
     LIMIT 1`
  ).get(agentId, userId, input.subject, summary) as WrongQuestion | undefined;
  const sourceType = filePaths.length > 0 ? detectSourceType(filePaths) : (existing?.source_type ?? 'text');

  let questionId = existing?.id ?? uuid();
  let storageDir: string | null = existing?.storage_dir ?? null;
  let persistedAssets: Omit<WrongQuestionAsset, 'created_at'>[] = [];
  if (filePaths.length > 0) {
    const persisted = persistAssets(questionId, agentId, userId, filePaths);
    if (!persisted.success) return persisted;
    storageDir = persisted.storageDir;
    persistedAssets = persisted.assets;
  }

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE wrong_questions
         SET wrong_answer = ?, expected_direction = ?, error_type = ?, error_subtype = ?, analysis = ?,
             source_type = ?, storage_dir = ?, status = 'open', mistake_count = mistake_count + 1,
             mastered_at = NULL, last_wrong_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        input.wrong_answer ?? existing.wrong_answer,
        input.expected_direction ?? existing.expected_direction,
        input.error_type ?? existing.error_type,
        input.error_subtype ?? existing.error_subtype,
        input.analysis ?? existing.analysis,
        sourceType,
        storageDir,
        now,
        now,
        existing.id,
      );
      questionId = existing.id;
    } else {
      db.prepare(
        `INSERT INTO wrong_questions (
          id, agent_id, user_id, subject, question_summary, wrong_answer, expected_direction,
          error_type, error_subtype, analysis, status, mistake_count, source_type, storage_dir,
          created_by, created_at, updated_at, last_wrong_at, mastered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, ?, ?, ?, NULL)`
      ).run(
        questionId,
        agentId,
        userId,
        input.subject,
        summary,
        input.wrong_answer ?? null,
        input.expected_direction ?? null,
        input.error_type ?? 'knowledge',
        input.error_subtype ?? null,
        input.analysis ?? null,
        sourceType,
        storageDir,
        createdBy,
        now,
        now,
        now,
      );
    }

    if (persistedAssets.length > 0) {
      const insertAsset = db.prepare(
        `INSERT INTO wrong_question_assets (
          id, wrong_question_id, asset_role, file_name, file_ext, mime_type, size_bytes, stored_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const asset of persistedAssets) {
        insertAsset.run(
          asset.id,
          questionId,
          asset.asset_role,
          asset.file_name,
          asset.file_ext,
          asset.mime_type,
          asset.size_bytes,
          asset.stored_path,
        );
      }
    }
  });

  tx();
  const question = db.prepare('SELECT * FROM wrong_questions WHERE id = ?').get(questionId) as WrongQuestion;
  return {
    success: true,
    created: !existing,
    id: question.id.slice(0, 8),
    question,
    assets: persistedAssets.length,
  };
}

export function listWrongQuestions(input: ListWrongQuestionsInput, userId: string): WrongQuestion[] {
  const access = requireTutorAgent();
  if (!access.success) return [];
  const agentId = access.agentId;
  const db = getDb();
  const conditions = ['agent_id = ?', 'user_id = ?'];
  const params: any[] = [agentId, userId];

  const status = input.status ?? 'open';
  if (status !== 'all') {
    conditions.push('status = ?');
    params.push(status);
  }
  if (input.subject) {
    conditions.push('subject = ?');
    params.push(input.subject);
  }
  if (input.error_type) {
    conditions.push('error_type = ?');
    params.push(input.error_type);
  }

  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  params.push(limit);

  return db.prepare(
    `SELECT * FROM wrong_questions
     WHERE ${conditions.join(' AND ')}
     ORDER BY
       CASE status WHEN 'open' THEN 0 ELSE 1 END,
       mistake_count DESC,
       last_wrong_at DESC
     LIMIT ?`
  ).all(...params) as WrongQuestion[];
}

export function getWrongQuestionDetail(idPrefix: string, userId: string): { success: boolean; detail?: WrongQuestionDetail; error?: string } {
  const access = requireTutorAgent();
  if (!access.success) return access;
  const agentId = access.agentId;
  const db = getDb();
  const question = getWrongQuestionByPrefix(idPrefix, agentId, userId);
  if (!question) return { success: false, error: `未找到错题: ${idPrefix}` };

  const assets = db.prepare(
    `SELECT * FROM wrong_question_assets
     WHERE wrong_question_id = ?
     ORDER BY created_at ASC, stored_path ASC`
  ).all(question.id) as WrongQuestionAsset[];

  return { success: true, detail: { question, assets } };
}

export function markWrongQuestionMastered(
  idPrefix: string,
  userId: string,
): { success: boolean; id?: string; question?: WrongQuestion; error?: string } {
  const access = requireTutorAgent();
  if (!access.success) return access;
  const agentId = access.agentId;
  const db = getDb();
  const question = getWrongQuestionByPrefix(idPrefix, agentId, userId);
  if (!question) return { success: false, error: `未找到错题: ${idPrefix}` };

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE wrong_questions
     SET status = 'mastered', mastered_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(now, now, question.id);

  const updated = db.prepare('SELECT * FROM wrong_questions WHERE id = ?').get(question.id) as WrongQuestion;
  return { success: true, id: updated.id.slice(0, 8), question: updated };
}

export function getWrongQuestionReport(
  input: WrongQuestionReportInput,
  userId: string,
): { success: boolean; report?: any; error?: string } {
  const access = requireTutorAgent();
  if (!access.success) return access;
  const agentId = access.agentId;
  const db = getDb();
  const conditions = ['agent_id = ?', 'user_id = ?'];
  const params: any[] = [agentId, userId];

  const status = input.status ?? 'all';
  if (status !== 'all') {
    conditions.push('status = ?');
    params.push(status);
  }
  if (input.subject) {
    conditions.push('subject = ?');
    params.push(input.subject);
  }
  if (input.error_type) {
    conditions.push('error_type = ?');
    params.push(input.error_type);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);

  const totals = db.prepare(
    `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status = 'mastered' THEN 1 ELSE 0 END) AS mastered_count
     FROM wrong_questions ${where}`
  ).get(...params) as { total: number; open_count: number | null; mastered_count: number | null };

  const bySubject = db.prepare(
    `SELECT
      subject,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status = 'mastered' THEN 1 ELSE 0 END) AS mastered_count
     FROM wrong_questions ${where}
     GROUP BY subject
     ORDER BY total DESC, subject ASC`
  ).all(...params) as Array<{ subject: WrongQuestionSubject; total: number; open_count: number | null; mastered_count: number | null }>;

  const byErrorType = db.prepare(
    `SELECT
      error_type,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status = 'mastered' THEN 1 ELSE 0 END) AS mastered_count
     FROM wrong_questions ${where}
     GROUP BY error_type
     ORDER BY total DESC, error_type ASC`
  ).all(...params) as Array<{ error_type: WrongQuestionErrorType; total: number; open_count: number | null; mastered_count: number | null }>;

  const topMistakes = db.prepare(
    `SELECT id, subject, question_summary, error_type, status, mistake_count, last_wrong_at
     FROM wrong_questions ${where}
     ORDER BY mistake_count DESC, last_wrong_at DESC
     LIMIT ?`
  ).all(...params, limit) as Array<{
    id: string;
    subject: WrongQuestionSubject;
    question_summary: string;
    error_type: WrongQuestionErrorType;
    status: 'open' | 'mastered';
    mistake_count: number;
    last_wrong_at: string;
  }>;

  return {
    success: true,
    report: {
      total: totals.total ?? 0,
      open_count: totals.open_count ?? 0,
      mastered_count: totals.mastered_count ?? 0,
      by_subject: bySubject.map(item => ({
        subject: item.subject,
        subject_label: SUBJECT_LABELS[item.subject],
        total: item.total,
        open_count: item.open_count ?? 0,
        mastered_count: item.mastered_count ?? 0,
      })),
      by_error_type: byErrorType.map(item => ({
        error_type: item.error_type,
        error_type_label: ERROR_TYPE_LABELS[item.error_type],
        total: item.total,
        open_count: item.open_count ?? 0,
        mastered_count: item.mastered_count ?? 0,
      })),
      top_mistakes: topMistakes.map(item => ({
        id: item.id.slice(0, 8),
        subject: item.subject,
        subject_label: SUBJECT_LABELS[item.subject],
        question_summary: item.question_summary,
        error_type: item.error_type,
        error_type_label: ERROR_TYPE_LABELS[item.error_type],
        status: item.status,
        mistake_count: item.mistake_count,
        last_wrong_at: item.last_wrong_at,
      })),
    },
  };
}

function parseFlag(args: string, name: string): string | undefined {
  const match = args.match(new RegExp(`(?:^|\\s)--${name}=([^\\s]+)`));
  return match?.[1];
}

function showHelp(): void {
  log.print('Wrong Question 用法：');
  log.print('  /wrongq list [--status=open|mastered|all] [--subject=math|chinese|english|science] [--type=knowledge|logic] [--limit=20]');
  log.print('  /wrongq show <id>');
  log.print('  /wrongq mastered <id>');
  log.print('  /wrongq report [--status=open|mastered|all] [--subject=math|chinese|english|science] [--type=knowledge|logic]');
}

function printQuestionTable(rows: WrongQuestion[]): void {
  if (rows.length === 0) {
    log.print('暂无错题记录');
    return;
  }

  renderTable(
    ['ID', '学科', '类型', '状态', '次数', '题目摘要', '最近错误'],
    rows.map(row => [
      row.id.slice(0, 8),
      SUBJECT_LABELS[row.subject],
      ERROR_TYPE_LABELS[row.error_type],
      row.status === 'open' ? '未掌握' : '已掌握',
      String(row.mistake_count),
      row.question_summary.length > 24 ? `${row.question_summary.slice(0, 21)}...` : row.question_summary,
      row.last_wrong_at.replace('T', ' ').slice(0, 16),
    ]),
  );
  log.print(`共 ${rows.length} 条错题`);
}

function handleList(args: string): void {
  const userId = getCurrentUser().id;
  const rows = listWrongQuestions(
    {
      status: (parseFlag(args, 'status') as ListWrongQuestionsInput['status']) ?? 'open',
      subject: parseFlag(args, 'subject') as WrongQuestionSubject | undefined,
      error_type: parseFlag(args, 'type') as WrongQuestionErrorType | undefined,
      limit: parseFlag(args, 'limit') ? Number(parseFlag(args, 'limit')) : undefined,
    },
    userId,
  );
  printQuestionTable(rows);
}

function handleShow(idPrefix: string): void {
  if (!idPrefix) {
    log.print('用法: /wrongq show <id>');
    return;
  }
  const result = getWrongQuestionDetail(idPrefix, getCurrentUser().id);
  if (!result.success || !result.detail) {
    log.print(result.error ?? '读取错题失败');
    return;
  }

  const { question, assets } = result.detail;
  log.print(`ID: ${question.id.slice(0, 8)}`);
  log.print(`学科: ${SUBJECT_LABELS[question.subject]}`);
  log.print(`错误类型: ${ERROR_TYPE_LABELS[question.error_type]}${question.error_subtype ? ` / ${question.error_subtype}` : ''}`);
  log.print(`状态: ${question.status === 'open' ? '未掌握' : '已掌握'}`);
  log.print(`错误次数: ${question.mistake_count}`);
  log.print(`题目摘要: ${question.question_summary}`);
  if (question.wrong_answer) log.print(`错误答案: ${question.wrong_answer}`);
  if (question.expected_direction) log.print(`引导方向: ${question.expected_direction}`);
  if (question.analysis) log.print(`分析: ${question.analysis}`);
  log.print(`最近错误: ${question.last_wrong_at}`);
  if (assets.length > 0) {
    log.print('附件：');
    for (const asset of assets) {
      log.print(`  - ${asset.file_name} (${asset.stored_path})`);
    }
  }
}

function handleMastered(idPrefix: string): void {
  if (!idPrefix) {
    log.print('用法: /wrongq mastered <id>');
    return;
  }
  const result = markWrongQuestionMastered(idPrefix, getCurrentUser().id);
  if (!result.success || !result.question) {
    log.print(result.error ?? '更新错题失败');
    return;
  }
  log.print(`已标记为掌握: ${result.question.id.slice(0, 8)} ${result.question.question_summary}`);
}

function handleReport(args: string): void {
  const result = getWrongQuestionReport(
    {
      status: (parseFlag(args, 'status') as WrongQuestionReportInput['status']) ?? 'all',
      subject: parseFlag(args, 'subject') as WrongQuestionSubject | undefined,
      error_type: parseFlag(args, 'type') as WrongQuestionErrorType | undefined,
    },
    getCurrentUser().id,
  );
  if (!result.success || !result.report) {
    log.print(result.error ?? '生成报告失败');
    return;
  }

  const report = result.report;
  log.print(`错题总数: ${report.total} | 未掌握: ${report.open_count} | 已掌握: ${report.mastered_count}`);
  if (report.by_subject.length > 0) {
    renderTable(
      ['学科', '总数', '未掌握', '已掌握'],
      report.by_subject.map((item: any) => [
        item.subject_label,
        String(item.total),
        String(item.open_count),
        String(item.mastered_count),
      ]),
    );
  }
  if (report.by_error_type.length > 0) {
    renderTable(
      ['错误类型', '总数', '未掌握', '已掌握'],
      report.by_error_type.map((item: any) => [
        item.error_type_label,
        String(item.total),
        String(item.open_count),
        String(item.mastered_count),
      ]),
    );
  }
  if (report.top_mistakes.length > 0) {
    renderTable(
      ['ID', '学科', '类型', '次数', '状态', '题目摘要'],
      report.top_mistakes.map((item: any) => [
        item.id,
        item.subject_label,
        item.error_type_label,
        String(item.mistake_count),
        item.status === 'open' ? '未掌握' : '已掌握',
        item.question_summary.length > 24 ? `${item.question_summary.slice(0, 21)}...` : item.question_summary,
      ]),
    );
  }
}

export function handleWrongQuestion(args: string): void {
  const access = requireTutorAgent();
  if (!access.success) {
    log.print(access.error);
    return;
  }

  const match = args.match(/^(\S+)\s*(.*)$/s);
  if (!match) {
    showHelp();
    return;
  }

  const sub = match[1].toLowerCase();
  const rest = match[2].trim();
  switch (sub) {
    case 'list':
      handleList(rest);
      return;
    case 'show':
      handleShow(rest);
      return;
    case 'mastered':
      handleMastered(rest);
      return;
    case 'report':
      handleReport(rest);
      return;
    default:
      showHelp();
  }
}
