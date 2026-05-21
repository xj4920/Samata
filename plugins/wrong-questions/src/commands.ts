import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type Database from 'better-sqlite3';
import type {
  WrongQuestion,
  WrongQuestionAsset,
  WrongQuestionSourceType,
  RecordWrongQuestionInput,
  ListWrongQuestionsInput,
  WrongQuestionReportInput,
  WrongQuestionSubject,
  WrongQuestionErrorType,
} from './types.js';

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
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image',
  '.webp': 'image', '.bmp': 'image',
  '.doc': 'document', '.docx': 'document', '.pdf': 'document',
  '.txt': 'document', '.md': 'document',
};

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
};

function resolveAttachmentPath(filePath: string): string {
  return filePath.startsWith('~/') ? path.join(os.homedir(), filePath.slice(2)) : path.resolve(filePath);
}

function detectSourceType(filePaths?: string[]): WrongQuestionSourceType {
  if (!filePaths || filePaths.length === 0) return 'text';
  const allImages = filePaths.every(fp => SOURCE_EXT_TO_TYPE[path.extname(fp).toLowerCase()] === 'image');
  return allImages ? 'image' : 'document';
}

function persistAssets(
  db: Database.Database,
  dataDir: string,
  questionId: string,
  agentId: string,
  userId: string,
  filePaths: string[],
): { success: true; storageDir: string; assets: Omit<WrongQuestionAsset, 'created_at'>[] } | { success: false; error: string } {
  const storageDirAbs = path.join(dataDir, 'files', agentId, userId, questionId.slice(0, 8));
  const storageDirRel = path.posix.join('files', agentId, userId, questionId.slice(0, 8));
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

export function recordWrongQuestion(
  db: Database.Database,
  dataDir: string,
  input: RecordWrongQuestionInput,
  agentId: string,
  userId: string,
): { success: boolean; created?: boolean; question?: WrongQuestion; assets?: number; error?: string } {
  const summary = input.question_summary.trim();
  if (!summary) return { success: false, error: '题目摘要不能为空' };

  const now = new Date().toISOString();
  const filePaths = input.file_paths?.filter(Boolean) ?? [];

  const existing = db.prepare(
    `SELECT * FROM wrong_questions WHERE agent_id = ? AND user_id = ? AND subject = ? AND question_summary = ? LIMIT 1`
  ).get(agentId, userId, input.subject, summary) as WrongQuestion | undefined;
  const sourceType = filePaths.length > 0 ? detectSourceType(filePaths) : (existing?.source_type ?? 'text');

  let questionId = existing?.id ?? uuid();
  let storageDir: string | null = existing?.storage_dir ?? null;
  let persistedAssets: Omit<WrongQuestionAsset, 'created_at'>[] = [];
  if (filePaths.length > 0) {
    const persisted = persistAssets(db, dataDir, questionId, agentId, userId, filePaths);
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
        sourceType, storageDir, now, now, existing.id,
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
        questionId, agentId, userId, input.subject, summary,
        input.wrong_answer ?? null, input.expected_direction ?? null,
        input.error_type ?? 'knowledge', input.error_subtype ?? null, input.analysis ?? null,
        sourceType, storageDir, userId, now, now, now,
      );
    }

    if (persistedAssets.length > 0) {
      const insertAsset = db.prepare(
        `INSERT INTO wrong_question_assets (id, wrong_question_id, asset_role, file_name, file_ext, mime_type, size_bytes, stored_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const asset of persistedAssets) {
        insertAsset.run(asset.id, questionId, asset.asset_role, asset.file_name, asset.file_ext, asset.mime_type, asset.size_bytes, asset.stored_path);
      }
    }
  });

  tx();
  const question = db.prepare('SELECT * FROM wrong_questions WHERE id = ?').get(questionId) as WrongQuestion;
  return { success: true, created: !existing, question, assets: persistedAssets.length };
}

export function listWrongQuestions(
  db: Database.Database,
  input: ListWrongQuestionsInput,
  agentId: string,
  userId: string,
): WrongQuestion[] {
  const conditions = ['agent_id = ?', 'user_id = ?'];
  const params: any[] = [agentId, userId];

  const status = input.status ?? 'open';
  if (status !== 'all') { conditions.push('status = ?'); params.push(status); }
  if (input.subject) { conditions.push('subject = ?'); params.push(input.subject); }
  if (input.error_type) { conditions.push('error_type = ?'); params.push(input.error_type); }

  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  params.push(limit);

  return db.prepare(
    `SELECT * FROM wrong_questions WHERE ${conditions.join(' AND ')}
     ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, mistake_count DESC, last_wrong_at DESC
     LIMIT ?`
  ).all(...params) as WrongQuestion[];
}

export function markWrongQuestionMastered(
  db: Database.Database,
  idPrefix: string,
  agentId: string,
  userId: string,
): { success: boolean; question?: WrongQuestion; error?: string } {
  const question = db.prepare(
    `SELECT * FROM wrong_questions WHERE id LIKE ? AND agent_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(`${idPrefix}%`, agentId, userId) as WrongQuestion | null;
  if (!question) return { success: false, error: `未找到错题: ${idPrefix}` };

  const now = new Date().toISOString();
  db.prepare(`UPDATE wrong_questions SET status = 'mastered', mastered_at = ?, updated_at = ? WHERE id = ?`).run(now, now, question.id);
  const updated = db.prepare('SELECT * FROM wrong_questions WHERE id = ?').get(question.id) as WrongQuestion;
  return { success: true, question: updated };
}

export function getWrongQuestionReport(
  db: Database.Database,
  input: WrongQuestionReportInput,
  agentId: string,
  userId: string,
): { success: boolean; report?: any; error?: string } {
  const conditions = ['agent_id = ?', 'user_id = ?'];
  const params: any[] = [agentId, userId];

  const status = input.status ?? 'all';
  if (status !== 'all') { conditions.push('status = ?'); params.push(status); }
  if (input.subject) { conditions.push('subject = ?'); params.push(input.subject); }
  if (input.error_type) { conditions.push('error_type = ?'); params.push(input.error_type); }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);

  const totals = db.prepare(
    `SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status = 'mastered' THEN 1 ELSE 0 END) AS mastered_count
     FROM wrong_questions ${where}`
  ).get(...params) as { total: number; open_count: number | null; mastered_count: number | null };

  const bySubject = db.prepare(
    `SELECT subject, COUNT(*) AS total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status = 'mastered' THEN 1 ELSE 0 END) AS mastered_count
     FROM wrong_questions ${where} GROUP BY subject ORDER BY total DESC`
  ).all(...params) as Array<{ subject: WrongQuestionSubject; total: number; open_count: number | null; mastered_count: number | null }>;

  const byErrorType = db.prepare(
    `SELECT error_type, COUNT(*) AS total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status = 'mastered' THEN 1 ELSE 0 END) AS mastered_count
     FROM wrong_questions ${where} GROUP BY error_type ORDER BY total DESC`
  ).all(...params) as Array<{ error_type: WrongQuestionErrorType; total: number; open_count: number | null; mastered_count: number | null }>;

  const topMistakes = db.prepare(
    `SELECT id, subject, question_summary, error_type, status, mistake_count, last_wrong_at
     FROM wrong_questions ${where} ORDER BY mistake_count DESC, last_wrong_at DESC LIMIT ?`
  ).all(...params, limit) as Array<any>;

  return {
    success: true,
    report: {
      total: totals.total ?? 0,
      open_count: totals.open_count ?? 0,
      mastered_count: totals.mastered_count ?? 0,
      by_subject: bySubject.map(item => ({
        subject: item.subject, subject_label: SUBJECT_LABELS[item.subject],
        total: item.total, open_count: item.open_count ?? 0, mastered_count: item.mastered_count ?? 0,
      })),
      by_error_type: byErrorType.map(item => ({
        error_type: item.error_type, error_type_label: ERROR_TYPE_LABELS[item.error_type],
        total: item.total, open_count: item.open_count ?? 0, mastered_count: item.mastered_count ?? 0,
      })),
      top_mistakes: topMistakes.map(item => ({
        id: item.id.slice(0, 8), subject: item.subject, subject_label: SUBJECT_LABELS[item.subject],
        question_summary: item.question_summary, error_type: item.error_type,
        error_type_label: ERROR_TYPE_LABELS[item.error_type],
        status: item.status, mistake_count: item.mistake_count, last_wrong_at: item.last_wrong_at,
      })),
    },
  };
}
