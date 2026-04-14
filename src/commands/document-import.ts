import { getDb } from '../db/connection.js';
import { getCurrentUser, isAgentAdmin } from '../auth/rbac.js';
import { getCurrentAgent } from '../llm/agent.js';
import { recordEvent } from '../models/event.js';
import { log } from '../utils/logger.js';
import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { fileURLToPath } from 'url';
import { executePluginTool } from '../plugins/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportResult {
  success: boolean;
  documentId?: string;
  title?: string;
  chunkCount?: number;
  error?: string;
}

export interface DocumentInfo {
  id: string;
  title: string;
  source_path: string;
  stored_path: string | null;
  file_type: string;
  chunk_count: number;
  agent_id: string | null;
  created_by: string;
  created_at: string;
}

interface Chunk {
  heading: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveFilePath(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(process.env.HOME || '', filePath.slice(1));
  }
  return path.resolve(filePath);
}

function detectFileType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.md': 'md', '.markdown': 'md',
    '.docx': 'docx',
    '.xlsx': 'xlsx', '.xls': 'xlsx', '.csv': 'csv',
    '.pdf': 'pdf',
  };
  return map[ext] ?? null;
}

function extractTitleFromFilename(filePath: string): string {
  return path.basename(filePath).replace(/\.[^.]+$/, '');
}

function ensureDocWriteAccess(agentId?: string): { success: true } | { success: false; error: string } {
  if (agentId) {
    if (!isAgentAdmin(agentId)) {
      return { success: false, error: '权限不足：需要当前 Agent 的管理员权限' };
    }
    return { success: true };
  }
  return { success: false, error: '需要指定 agent' };
}

// ---------------------------------------------------------------------------
// Document storage
// ---------------------------------------------------------------------------

function getDocStorageDir(docId: string): string {
  return path.resolve(__dirname, '../../data/documents', docId.slice(0, 8));
}

function persistDocumentFiles(
  docId: string,
  sourceFilePath: string,
  fileType: string,
  chunks: Chunk[],
): string {
  const dir = getDocStorageDir(docId);
  fs.mkdirSync(dir, { recursive: true });

  const ext = path.extname(sourceFilePath);
  fs.copyFileSync(sourceFilePath, path.join(dir, `original${ext}`));

  if (fileType === 'xlsx' || fileType === 'csv') {
    const sheetsData = chunks.map(c => ({ heading: c.heading, content: c.content }));
    fs.writeFileSync(path.join(dir, 'parsed.json'), JSON.stringify(sheetsData, null, 2), 'utf-8');
  } else {
    const fullMd = chunks.map(c => `## ${c.heading}\n\n${c.content}`).join('\n\n');
    fs.writeFileSync(path.join(dir, 'parsed.md'), fullMd, 'utf-8');
  }

  return dir;
}

// ---------------------------------------------------------------------------
// Markdown chunking
// ---------------------------------------------------------------------------

export function splitMarkdownByHeadings(content: string, docTitle: string): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];
  let currentHeading = '';
  let currentLines: string[] = [];
  let titleFromH1 = '';

  for (const line of lines) {
    const h1Match = line.match(/^#\s+(.+)/);
    const h2Match = line.match(/^##\s+(.+)/);

    if (h1Match && !titleFromH1) {
      titleFromH1 = h1Match[1].trim();
      continue;
    }

    if (h2Match) {
      if (currentLines.length > 0) {
        const body = currentLines.join('\n').trim();
        if (body) {
          chunks.push({
            heading: currentHeading || '概述',
            content: body,
          });
        }
      }
      currentHeading = h2Match[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Last section
  if (currentLines.length > 0) {
    const body = currentLines.join('\n').trim();
    if (body) {
      chunks.push({
        heading: currentHeading || '概述',
        content: body,
      });
    }
  }

  // If no h2 headings were found, return the whole content as one chunk
  if (chunks.length === 0 && content.trim()) {
    chunks.push({ heading: '全文', content: content.trim() });
  }

  const title = titleFromH1 || docTitle;
  return chunks.map(c => ({
    heading: `${title} - ${c.heading}`,
    content: c.content,
  }));
}

// ---------------------------------------------------------------------------
// Excel chunking
// ---------------------------------------------------------------------------

function splitExcelBySheets(filePath: string, docTitle: string): Chunk[] {
  const workbook = XLSX.readFile(filePath);
  const chunks: Chunk[] = [];

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;

    const rows: Record<string, any>[] = XLSX.utils.sheet_to_json(worksheet);
    if (rows.length === 0) continue;

    const headers = Object.keys(rows[0]);
    // Build a markdown table
    const mdLines: string[] = [];
    mdLines.push('| ' + headers.join(' | ') + ' |');
    mdLines.push('| ' + headers.map(() => '---').join(' | ') + ' |');

    const maxRows = 200;
    const displayRows = rows.slice(0, maxRows);
    for (const row of displayRows) {
      mdLines.push('| ' + headers.map(h => String(row[h] ?? '')).join(' | ') + ' |');
    }
    if (rows.length > maxRows) {
      mdLines.push(`\n> ... 共 ${rows.length} 行，已截取前 ${maxRows} 行`);
    }

    chunks.push({
      heading: `${docTitle} - ${sheetName}`,
      content: mdLines.join('\n'),
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Content loading per file type
// ---------------------------------------------------------------------------

async function loadAndChunk(filePath: string, fileType: string, docTitle: string): Promise<{ chunks: Chunk[]; error?: string }> {
  switch (fileType) {
    case 'md': {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { chunks: splitMarkdownByHeadings(content, docTitle) };
    }

    case 'docx': {
      const result = await executePluginTool('parse_word', { file_path: filePath, format: 'markdown', max_chars: 100000 });
      if (!result) return { chunks: [], error: '需要 word-parser 插件（plugins/word-parser/），请确认已安装' };
      const parsed = JSON.parse(result);
      if (parsed.error) return { chunks: [], error: parsed.error };
      return { chunks: splitMarkdownByHeadings(parsed.content, docTitle) };
    }

    case 'xlsx':
    case 'csv': {
      try {
        const chunks = splitExcelBySheets(filePath, docTitle);
        if (chunks.length === 0) return { chunks: [], error: '文件为空或无可读数据' };
        return { chunks };
      } catch (e: any) {
        return { chunks: [], error: `Excel 解析失败: ${e.message}` };
      }
    }

    case 'pdf': {
      const pdfResult = await executePluginTool('parse_pdf', { file_path: filePath, max_chars: 100000 });
      if (!pdfResult) return { chunks: [], error: '需要 pdf-parser 插件（plugins/pdf-parser/），请确认已安装' };
      const pdfParsed = JSON.parse(pdfResult);
      if (pdfParsed.error) return { chunks: [], error: pdfParsed.error };
      return { chunks: splitMarkdownByHeadings(pdfParsed.content, docTitle) };
    }

    default:
      return { chunks: [], error: `不支持的文件类型: ${fileType}` };
  }
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

export async function importDocument(
  filePath: string,
  agentId: string,
  options?: { title?: string },
): Promise<ImportResult> {
  const perm = ensureDocWriteAccess(agentId);
  if (!perm.success) return { success: false, error: perm.error };

  const resolved = resolveFilePath(filePath);
  if (!fs.existsSync(resolved)) {
    return { success: false, error: `文件不存在: ${resolved}` };
  }

  const fileType = detectFileType(resolved);
  if (!fileType) {
    return { success: false, error: `无法识别的文件类型: ${path.extname(resolved)}` };
  }

  const docTitle = options?.title || extractTitleFromFilename(resolved);

  // Check for duplicate import (same source_path + agent_id)
  const db = getDb();
  const existing = db.prepare(
    'SELECT id, title FROM documents WHERE source_path = ? AND agent_id = ?',
  ).get(resolved, agentId) as { id: string; title: string } | undefined;
  if (existing) {
    return { success: false, error: `文档已导入过 (${existing.id.slice(0, 8)}: ${existing.title})，如需更新请先删除或使用 reimport` };
  }

  const { chunks, error } = await loadAndChunk(resolved, fileType, docTitle);
  if (error) return { success: false, error };
  if (chunks.length === 0) return { success: false, error: '文档内容为空，无法导入' };

  const user = getCurrentUser();
  const docId = uuid();

  const storedPath = persistDocumentFiles(docId, resolved, fileType, chunks);

  // Insert document record
  db.prepare(
    'INSERT INTO documents (id, title, source_path, file_type, chunk_count, agent_id, created_by, stored_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(docId, docTitle, resolved, fileType, chunks.length, agentId, user.id, storedPath);

  // Insert knowledge entries
  const insKnowledge = db.prepare(
    'INSERT INTO knowledge (id, question, answer, tags, created_by, document_id) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insKA = db.prepare(
    'INSERT OR IGNORE INTO knowledge_agents (id, knowledge_id, agent_id) VALUES (?, ?, ?)',
  );

  for (const chunk of chunks) {
    const kid = uuid();
    insKnowledge.run(kid, chunk.heading, chunk.content, docTitle, user.id, docId);
    insKA.run(uuid(), kid, agentId);
  }

  recordEvent('document', docId, 'import', { title: docTitle, file_type: fileType, chunks: chunks.length });

  return { success: true, documentId: docId.slice(0, 8), title: docTitle, chunkCount: chunks.length };
}

export function deleteDocument(docIdPrefix: string, agentId?: string): ImportResult {
  const perm = ensureDocWriteAccess(agentId);
  if (!perm.success) return { success: false, error: perm.error };

  const db = getDb();
  const rows = db.prepare('SELECT * FROM documents WHERE id LIKE ?').all(`${docIdPrefix}%`) as DocumentInfo[];
  if (rows.length === 0) return { success: false, error: `未找到文档: ${docIdPrefix}` };
  if (rows.length > 1) return { success: false, error: '匹配到多个文档，请提供更长的 ID 前缀' };

  const doc = rows[0];
  if (agentId && doc.agent_id !== agentId) {
    return { success: false, error: '该文档不属于当前 Agent' };
  }

  // Delete knowledge entries linked to this document (cascade handles knowledge_agents)
  db.prepare('DELETE FROM knowledge WHERE document_id = ?').run(doc.id);
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);

  // Clean up stored files
  const storageDir = doc.stored_path ?? getDocStorageDir(doc.id);
  try { fs.rmSync(storageDir, { recursive: true, force: true }); } catch (_) {}

  recordEvent('document', doc.id, 'delete', { title: doc.title });

  return { success: true, documentId: doc.id.slice(0, 8), title: doc.title, chunkCount: doc.chunk_count };
}

export function listDocuments(agentId?: string): DocumentInfo[] {
  const db = getDb();
  if (agentId) {
    return db.prepare('SELECT * FROM documents WHERE agent_id = ? ORDER BY created_at DESC').all(agentId) as DocumentInfo[];
  }
  return db.prepare('SELECT * FROM documents ORDER BY created_at DESC').all() as DocumentInfo[];
}

export async function reimportDocument(docIdPrefix: string, agentId: string): Promise<ImportResult> {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM documents WHERE id LIKE ?').all(`${docIdPrefix}%`) as DocumentInfo[];
  if (rows.length === 0) return { success: false, error: `未找到文档: ${docIdPrefix}` };
  if (rows.length > 1) return { success: false, error: '匹配到多个文档，请提供更长的 ID 前缀' };

  const doc = rows[0];
  const title = doc.title;

  // Prefer stored original file; copy to temp before delete cleans up the dir
  let reimportPath = doc.source_path;
  if (doc.stored_path) {
    const ext = path.extname(doc.source_path);
    const storedOriginal = path.join(doc.stored_path, `original${ext}`);
    if (fs.existsSync(storedOriginal)) {
      const tmpCopy = path.join(path.dirname(doc.stored_path), `_reimport_${doc.id.slice(0, 8)}${ext}`);
      fs.copyFileSync(storedOriginal, tmpCopy);
      reimportPath = tmpCopy;
    }
  }

  // Delete old (cleans up stored files)
  const delResult = deleteDocument(doc.id, agentId);
  if (!delResult.success) {
    try { if (reimportPath !== doc.source_path) fs.unlinkSync(reimportPath); } catch (_) {}
    return delResult;
  }

  const result = await importDocument(reimportPath, agentId, { title });

  // Clean up temp copy
  if (reimportPath !== doc.source_path) {
    try { fs.unlinkSync(reimportPath); } catch (_) {}
  }

  return result;
}

export function getDocumentContent(docIdPrefix: string): { content: string; format: 'md' | 'json' } | { error: string } {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM documents WHERE id LIKE ?').all(`${docIdPrefix}%`) as DocumentInfo[];
  if (rows.length === 0) return { error: `未找到文档: ${docIdPrefix}` };
  if (rows.length > 1) return { error: '匹配到多个文档，请提供更长的 ID 前缀' };

  const doc = rows[0];
  const dir = doc.stored_path ?? getDocStorageDir(doc.id);

  for (const [file, fmt] of [['parsed.md', 'md'], ['parsed.json', 'json']] as const) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return { content: fs.readFileSync(p, 'utf-8'), format: fmt };
  }

  return { error: '未找到已存储的解析内容（可能是在持久化功能上线前导入的文档）' };
}

// ---------------------------------------------------------------------------
// CLI handlers
// ---------------------------------------------------------------------------

export async function cliImport(args: string): Promise<void> {
  const filePath = args.trim();
  if (!filePath) {
    log.print('用法: /doc-import <文件路径>');
    return;
  }

  const agentId = getCurrentAgent()?.id;
  if (!agentId) {
    log.print('请先切换到一个 Agent');
    return;
  }

  const result = await importDocument(filePath, agentId);
  if (result.success) {
    log.print(`文档已导入: [${result.documentId}] ${result.title} (${result.chunkCount} 条知识)`);
  } else {
    log.print(result.error!);
  }
}

export function cliList(): void {
  const agentId = getCurrentAgent()?.id;
  const docs = listDocuments(agentId);
  if (docs.length === 0) {
    log.print('暂无已导入的文档');
    return;
  }
  for (const doc of docs) {
    log.print(`  [${doc.id.slice(0, 8)}] ${doc.title}  (${doc.file_type}, ${doc.chunk_count} 条)  ${doc.created_at}`);
  }
  log.print(`共 ${docs.length} 个文档`);
}

export function cliDelete(args: string): void {
  const idPrefix = args.trim();
  if (!idPrefix) {
    log.print('用法: /doc-del <文档ID前缀>');
    return;
  }
  const agentId = getCurrentAgent()?.id;
  const result = deleteDocument(idPrefix, agentId);
  if (result.success) {
    log.print(`已删除: ${result.title} (${result.chunkCount} 条知识)`);
  } else {
    log.print(result.error!);
  }
}
