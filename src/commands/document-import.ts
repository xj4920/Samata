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
import { getProvider, getModelName } from '../llm/provider.js';
import { parseLLMJsonArray } from '../utils/json-repair.js';
import { loadKnowledgeTagsFromConfig } from './knowledge-tag-audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportResult {
  success: boolean;
  documentId?: string;
  title?: string;
  chunkCount?: number;
  topics?: string[];
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
  tags?: string;
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
// Tag candidates
// ---------------------------------------------------------------------------

function collectTagCandidates(agentId: string): string[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT DISTINCT k.tags FROM knowledge k
     WHERE k.tags IS NOT NULL AND k.tags != ''
       AND k.id IN (SELECT knowledge_id FROM knowledge_agents WHERE agent_id = ?)`,
  ).all(agentId) as { tags: string }[];

  const tagSet = new Set<string>();
  for (const row of rows) {
    for (const t of row.tags.split(',')) {
      const trimmed = t.trim();
      if (trimmed) tagSet.add(trimmed);
    }
  }

  for (const t of loadKnowledgeTagsFromConfig(agentId)) {
    tagSet.add(t);
  }

  return [...tagSet];
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

  // Log images directory if it was populated during parsing
  const imgDir = path.join(dir, 'images');
  if (fs.existsSync(imgDir)) {
    const imgFiles = fs.readdirSync(imgDir).filter(f => !f.startsWith('.'));
    if (imgFiles.length === 0) {
      try { fs.rmdirSync(imgDir); } catch {}
    }
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
// LLM semantic chunking (fallback when heading-based split yields <= 1 chunk)
// ---------------------------------------------------------------------------

interface SplitPoint {
  heading: string;
  start_paragraph: number;
  tags?: string[];
}

/**
 * Number paragraphs and ask LLM to identify split points and assign tags.
 * We split programmatically — no content duplication in LLM output.
 */
async function chunkWithLLM(content: string, docTitle: string, tagCandidates: string[]): Promise<Chunk[]> {
  const paragraphs = content.split(/\n{2,}/).filter(p => p.trim());
  if (paragraphs.length < 2) return [];

  const numbered = paragraphs
    .map((p, i) => `[${i + 1}] ${p.length > 120 ? p.slice(0, 120) + '…' : p}`)
    .join('\n');

  const tagInstruction = tagCandidates.length > 0
    ? `\n可选标签（从中选取 1-3 个最相关的）：\n${tagCandidates.join('、')}\n如标签列表中没有合适的，可新建一个简短标签。`
    : '\n为每组生成 1-3 个简短标签。';

  const provider = getProvider();
  const response = await provider.createMessage({
    model: getModelName(),
    max_tokens: 2000,
    system: '你是一个文档结构化专家。请直接返回 JSON 结果，不要使用 markdown 代码块包裹。',
    tools: [],
    messages: [{
      role: 'user',
      content: `以下是一篇文档的段落摘要（共 ${paragraphs.length} 段），请按语义主题对其分组并打标签。

文档标题：${docTitle}

${numbered}

要求：
- 按语义主题分组，每组聚焦一个独立主题
- 为每组生成简明标题（如"港股雪球产品对冲策略"）
- 返回每组的起始段落编号
${tagInstruction}

以 JSON 数组返回，按段落顺序排列，每个元素：
- heading: 主题标题
- start_paragraph: 该组起始段落编号（从1开始）
- tags: 标签数组（1-3 个）

只返回 JSON 数组。`,
    }],
  });

  const text = response.content[0];
  if (text.type !== 'text') return [];

  const splits = parseLLMJsonArray<SplitPoint>(text.text)
    .filter(s => s.heading && typeof s.start_paragraph === 'number')
    .sort((a, b) => a.start_paragraph - b.start_paragraph);

  if (splits.length < 2) return [];

  const chunks: Chunk[] = [];
  for (let i = 0; i < splits.length; i++) {
    const startIdx = Math.max(0, splits[i].start_paragraph - 1);
    const endIdx = i + 1 < splits.length
      ? Math.max(0, splits[i + 1].start_paragraph - 1)
      : paragraphs.length;
    const body = paragraphs.slice(startIdx, endIdx).join('\n\n').trim();
    if (body) {
      chunks.push({
        heading: splits[i].heading,
        content: body,
        tags: splits[i].tags?.join(',') || '',
      });
    }
  }

  return chunks;
}

/**
 * Attempt LLM chunking when heading-based split produced <= 1 chunk.
 * Retries once on transient failure; returns original chunks if LLM can't improve.
 */
async function tryLLMChunking(chunks: Chunk[], rawContent: string, docTitle: string, agentId: string): Promise<Chunk[]> {
  if (chunks.length > 1 || rawContent.length <= 500) return chunks;

  const tagCandidates = collectTagCandidates(agentId);
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const llmChunks = await chunkWithLLM(rawContent, docTitle, tagCandidates);
      if (llmChunks.length > 1) {
        return llmChunks.map(c => ({
          heading: `${docTitle} - ${c.heading}`,
          content: c.content,
          tags: c.tags,
        }));
      }
      break;
    } catch (e: any) {
      if (attempt < MAX_ATTEMPTS) {
        log.warn(`LLM 分段第 ${attempt} 次失败，重试: ${e.message}`);
      } else {
        log.warn(`LLM 分段失败，使用原始分段: ${e.message}`);
      }
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Image description via LLM Vision
// ---------------------------------------------------------------------------

interface ExtractedImage {
  filename: string;
  relativePath: string;
}

async function describeImagesInMarkdown(
  content: string,
  images: ExtractedImage[],
  imageDir: string,
  onProgress?: (event: { type: 'tool_progress'; message: string }) => void,
): Promise<string> {
  if (images.length === 0) return content;

  let provider: import('../llm/provider.js').LLMProvider;
  try {
    const { getProvider } = await import('../llm/provider.js');
    provider = getProvider();
  } catch {
    return content;
  }
  if (!provider.describeImage) return content;

  const described = new Map<string, string>();
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const DELAY_MS = 500;
  const MAX_RETRIES = 2;

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (images.length >= 10 && (i + 1) % 10 === 0) {
      const msg = `图片描述进度: ${i + 1}/${images.length}`;
      log.info(msg);
      onProgress?.({ type: 'tool_progress', message: msg });
    }

    const imgPath = path.join(imageDir, img.filename);
    if (!fs.existsSync(imgPath)) continue;

    const buffer = fs.readFileSync(imgPath);
    const ext = path.extname(img.filename).toLowerCase().slice(1);
    const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
    const mime = mimeMap[ext] || 'image/png';
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const desc = await provider.describeImage!(dataUrl, '用一两句中文简要描述这张图片的内容，重点说明图中的关键信息（如数据、流程、结构等）。');
        if (desc) described.set(img.relativePath, desc);
        break;
      } catch (e: any) {
        if (attempt < MAX_RETRIES) {
          const backoff = DELAY_MS * 2 ** (attempt + 1);
          log.warn(`图片描述失败 (${img.filename}), ${backoff}ms 后重试 (${attempt + 1}/${MAX_RETRIES}): ${e.message}`);
          await sleep(backoff);
        } else {
          log.warn(`图片描述失败 (${img.filename}): ${e.message}`);
        }
      }
    }

    if (i < images.length - 1) await sleep(DELAY_MS);
  }

  const doneMsg = `图片描述完成: ${described.size}/${images.length} 张成功`;
  log.info(doneMsg);
  onProgress?.({ type: 'tool_progress', message: doneMsg });
  if (described.size === 0) return content;

  // Insert descriptions after each image reference
  let result = content;
  for (const [relPath, desc] of described) {
    const escaped = relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(!\\[[^\\]]*\\]\\(${escaped}\\))`, 'g');
    result = result.replace(pattern, `$1\n\n> **[图片内容]** ${desc}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Content loading per file type
// ---------------------------------------------------------------------------

interface LoadResult {
  chunks: Chunk[];
  rawContent?: string;
  images?: ExtractedImage[];
  error?: string;
}

async function loadAndChunk(
  filePath: string,
  fileType: string,
  docTitle: string,
  agentId: string,
  options?: { imageOutputDir?: string; onProgress?: (event: { type: 'tool_progress'; message: string }) => void },
): Promise<LoadResult> {
  switch (fileType) {
    case 'md': {
      const content = fs.readFileSync(filePath, 'utf-8');
      const chunks = splitMarkdownByHeadings(content, docTitle);
      return { chunks: await tryLLMChunking(chunks, content, docTitle, agentId), rawContent: content };
    }

    case 'docx': {
      const pluginInput: Record<string, any> = { file_path: filePath, format: 'markdown', max_chars: 100000 };
      if (options?.imageOutputDir) pluginInput.image_output_dir = options.imageOutputDir;

      const result = await executePluginTool('parse_word', pluginInput);
      if (!result) return { chunks: [], error: '需要 word-parser 插件（plugins/word-parser/），请确认已安装' };
      const parsed = JSON.parse(result);
      if (parsed.error) return { chunks: [], error: parsed.error };

      let content: string = parsed.content;
      const images: ExtractedImage[] = parsed.images || [];

      // Enrich markdown with Vision descriptions for extracted images
      if (images.length > 0 && options?.imageOutputDir) {
        const shouldDescribe = process.env.DOC_IMPORT_DESCRIBE_IMAGES !== 'false';
        if (shouldDescribe) {
          log.info(`为 ${images.length} 张图片生成 AI 描述...`);
          content = await describeImagesInMarkdown(content, images, options.imageOutputDir, options?.onProgress);
        }
      }

      if (parsed.engine) log.dim(`  Word 解析引擎: ${parsed.engine}`);

      const chunks = splitMarkdownByHeadings(content, docTitle);
      return {
        chunks: await tryLLMChunking(chunks, content, docTitle, agentId),
        rawContent: content,
        images,
      };
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
      const pluginInput: Record<string, any> = { file_path: filePath, max_chars: 100000 };
      if (options?.imageOutputDir) pluginInput.image_output_dir = options.imageOutputDir;

      const pdfResult = await executePluginTool('parse_pdf', pluginInput);
      if (!pdfResult) return { chunks: [], error: '需要 pdf-parser 插件（plugins/pdf-parser/），请确认已安装' };
      const pdfParsed = JSON.parse(pdfResult);
      if (pdfParsed.error) return { chunks: [], error: pdfParsed.error };

      let content: string = pdfParsed.content;
      const images: ExtractedImage[] = pdfParsed.images || [];

      if (images.length > 0 && options?.imageOutputDir) {
        const shouldDescribe = process.env.DOC_IMPORT_DESCRIBE_IMAGES !== 'false';
        if (shouldDescribe) {
          log.info(`为 ${images.length} 张图片生成 AI 描述...`);
          content = await describeImagesInMarkdown(content, images, options.imageOutputDir, options?.onProgress);
        }
      }

      const chunks = splitMarkdownByHeadings(content, docTitle);
      return {
        chunks: await tryLLMChunking(chunks, content, docTitle, agentId),
        rawContent: content,
        images,
      };
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
  options?: { title?: string; actorUserId?: string; onProgress?: (event: { type: 'tool_progress'; message: string }) => void },
): Promise<ImportResult> {
  const perm = ensureDocWriteAccess(agentId);
  if (!perm.success) return { success: false, error: perm.error };
  const actorUserId = options?.actorUserId ?? getCurrentUser().id;

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

  // Generate doc ID early so we can set up the image output directory before parsing
  const docId = uuid();
  const docStorageDir = getDocStorageDir(docId);
  const imageOutputDir = path.join(docStorageDir, 'images');

  const { chunks, rawContent, images, error } = await loadAndChunk(resolved, fileType, docTitle, agentId, {
    imageOutputDir,
    onProgress: options?.onProgress,
  });
  if (error) {
    // Clean up any partially created directories
    try { fs.rmSync(docStorageDir, { recursive: true, force: true }); } catch {}
    return { success: false, error };
  }
  if (chunks.length === 0) {
    try { fs.rmSync(docStorageDir, { recursive: true, force: true }); } catch {}
    return { success: false, error: '文档内容为空，无法导入' };
  }

  const storedPath = persistDocumentFiles(docId, resolved, fileType, chunks);

  if (images && images.length > 0) {
    log.info(`  提取了 ${images.length} 张图片 → ${imageOutputDir}`);
  }

  // Insert document record
  db.prepare(
    'INSERT INTO documents (id, title, source_path, file_type, chunk_count, agent_id, created_by, stored_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(docId, docTitle, resolved, fileType, chunks.length, agentId, actorUserId, storedPath);

  // Insert knowledge entries
  const insKnowledge = db.prepare(
    'INSERT INTO knowledge (id, question, answer, tags, created_by, document_id) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insKA = db.prepare(
    'INSERT OR IGNORE INTO knowledge_agents (id, knowledge_id, agent_id) VALUES (?, ?, ?)',
  );

  for (const chunk of chunks) {
    const kid = uuid();
    const tags = chunk.tags || docTitle;
    insKnowledge.run(kid, chunk.heading, chunk.content, tags, actorUserId, docId);
    insKA.run(uuid(), kid, agentId);
  }

  recordEvent('document', docId, 'import', { title: docTitle, file_type: fileType, chunks: chunks.length });

  return {
    success: true,
    documentId: docId.slice(0, 8),
    title: docTitle,
    chunkCount: chunks.length,
    topics: chunks.map(c => c.heading),
  };
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

export async function reimportDocument(
  docIdPrefix: string,
  agentId: string,
  options?: { actorUserId?: string },
): Promise<ImportResult> {
  const actorUserId = options?.actorUserId ?? getCurrentUser().id;
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

  const result = await importDocument(reimportPath, agentId, { title, actorUserId });

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

  const result = await importDocument(filePath, agentId, { actorUserId: getCurrentUser().id });
  if (result.success) {
    log.print(`文档已导入: [${result.documentId}] ${result.title} (${result.chunkCount} 条知识)`);
    if (result.topics && result.topics.length > 1) {
      log.print('按主题拆分为：');
      for (const t of result.topics) log.print(`  · ${t}`);
    }
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
