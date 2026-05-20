import { getDb } from '../db/connection.js';
import { getCurrentUser, isAgentAdmin } from '../auth/rbac.js';
import { getCurrentAgent } from '../llm/agent.js';
import { recordEvent } from '../models/event.js';
import { log } from '../utils/logger.js';
import { v4 as uuid } from 'uuid';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import XLSX from 'xlsx';
import { fileURLToPath } from 'url';
import { executePluginTool } from '../plugins/registry.js';
import { getProvider, getModelName, getProviderByName } from '../llm/provider.js';
import { describeImageWithFallback } from '../llm/agent.js';
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
  topics?: string[];
  error?: string;
}

export interface DocumentInfo {
  id: string;
  title: string;
  source_path: string;
  stored_path: string | null;
  file_type: string;
  /** Deprecated: retained for DB compatibility only; documents are no longer chunked. */
  chunk_count?: number;
  /** Size of parsed.md in bytes (post-migration). Null for legacy rows not yet backfilled. */
  size_bytes?: number | null;
  agent_id: string | null;
  content_hash?: string | null;
  /** Material date (e.g. checkup report date), distinct from created_at (import time). */
  doc_date?: string | null;
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
    '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg', '.gif': 'gif', '.webp': 'webp', '.svg': 'svg',
    '.html': 'html', '.htm': 'html',
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

/** Resolve the human-readable agent name for filesystem directory naming. */
export function getAgentFsName(agentId: string): string {
  const db = getDb();
  const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
  return row?.name || agentId;
}

// ---------------------------------------------------------------------------
// Tag candidates
// ---------------------------------------------------------------------------

/**
 * Read only the YAML frontmatter (first `---` block) from a parsed.md file
 * and extract its `tags:` value. Used for tag candidate collection.
 */
function readFrontmatterTags(parsedMdPath: string): string[] {
  try {
    const fh = fs.openSync(parsedMdPath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fh, buf, 0, buf.length, 0);
      const head = buf.slice(0, n).toString('utf-8');
      if (!head.startsWith('---\n')) return [];
      const rest = head.slice(4);
      const endIdx = rest.indexOf('\n---');
      if (endIdx === -1) return [];
      const body = rest.slice(0, endIdx);
      for (const line of body.split('\n')) {
        const m = line.match(/^tags\s*:\s*(.*)$/);
        if (!m) continue;
        const val = m[1].trim().replace(/^"(.*)"$/, '$1');
        if (!val) return [];
        return val.split(',').map(s => s.trim()).filter(Boolean);
      }
      return [];
    } finally {
      fs.closeSync(fh);
    }
  } catch {
    return [];
  }
}

/**
 * Collect tag candidates for LLM tag generation, three sources merged:
 *   1. frontmatter `tags` of every parsed.md under data/documents/<agentName>/
 *   2. manual FAQ tags (knowledge.tags WHERE document_id IS NULL) for this agent
 *   3. loadKnowledgeTagsFromConfig(agentId)
 *
 * Document-side chunks were removed by the earlier migration, so the DB can
 * no longer be the sole source — tags must flow back from the filesystem.
 */
function collectTagCandidatesFromFs(agentId: string): string[] {
  const tagSet = new Set<string>();

  // 1. Frontmatter tags from existing documents
  const agentDocDir = path.resolve(__dirname, '../../data/documents', getAgentFsName(agentId));
  if (fs.existsSync(agentDocDir)) {
    for (const docDir of fs.readdirSync(agentDocDir)) {
      const parsedMd = path.join(agentDocDir, docDir, 'parsed.md');
      if (!fs.existsSync(parsedMd)) continue;
      for (const t of readFrontmatterTags(parsedMd)) tagSet.add(t);
    }
  }

  // 2. Manual FAQ tags (no document link)
  const db = getDb();
  const faqRows = db.prepare(
    `SELECT DISTINCT k.tags FROM knowledge k
     WHERE k.tags IS NOT NULL AND k.tags != ''
       AND k.document_id IS NULL
       AND k.id IN (SELECT knowledge_id FROM knowledge_agents WHERE agent_id = ?)`,
  ).all(agentId) as { tags: string }[];
  for (const row of faqRows) {
    for (const t of row.tags.split(',')) {
      const trimmed = t.trim();
      if (trimmed) tagSet.add(trimmed);
    }
  }

  // 3. Config-declared tags
  for (const t of loadKnowledgeTagsFromConfig(agentId)) {
    tagSet.add(t);
  }

  return [...tagSet];
}

// ---------------------------------------------------------------------------
// Document storage
// ---------------------------------------------------------------------------

const DOCUMENTS_ROOT_ABS = path.resolve(__dirname, '../../data/documents');

/** Relative path (stored in DB) — stable across deployments / cwd changes. */
function getDocStorageRelPath(docId: string, agentId: string): string {
  return path.posix.join('data/documents', getAgentFsName(agentId), docId.slice(0, 8));
}

/** Absolute path (used for all FS operations). */
function getDocStorageDir(docId: string, agentId: string): string {
  return path.join(DOCUMENTS_ROOT_ABS, getAgentFsName(agentId), docId.slice(0, 8));
}

/**
 * Convert a DB-stored `stored_path` (which should be a relative path like
 * `data/documents/<agent>/<docId8>`) into an absolute path.
 *
 * For robustness we also accept absolute paths — legacy rows written before
 * migration v2 will still resolve correctly. The returned string is an
 * absolute path suitable for `fs.*` calls.
 */
export function resolveStoredPath(rel: string): string {
  if (path.isAbsolute(rel)) return rel;
  // Prefer resolving relative to the package root so the answer is
  // independent of process.cwd(). `__dirname` points at .../dist/commands or
  // .../src/commands; two levels up is the package root either way.
  return path.resolve(__dirname, '../..', rel);
}

interface PersistOutcome {
  /** Relative path for the `documents.stored_path` DB column. */
  relPath: string;
  /** Absolute path to parsed.md (for size_bytes bookkeeping). */
  parsedMdAbs: string;
  /** parsed.md size in bytes after write. */
  sizeBytes: number;
}

// 同卷 hardlink，跨卷或不允许时退回 copyFileSync。dst 已存在则先 unlink 再尝试一次。
function linkOrCopy(src: string, dst: string): void {
  try {
    fs.linkSync(src, dst);
    return;
  } catch (e: any) {
    if (e?.code === 'EEXIST') {
      try { fs.unlinkSync(dst); fs.linkSync(src, dst); return; } catch {}
    }
    fs.copyFileSync(src, dst);
  }
}

function persistDocumentFiles(
  docId: string,
  agentId: string,
  sourceFilePath: string,
  fileType: string,
  markdown: string,
  tags: string,
  title: string,
  createdBy: string,
  docDate?: string,
): PersistOutcome {
  const dir = getDocStorageDir(docId, agentId);
  fs.mkdirSync(dir, { recursive: true });

  const ext = path.extname(sourceFilePath);
  linkOrCopy(sourceFilePath, path.join(dir, `original${ext}`));

  const frontmatterLines = [
    '---',
    `document_id: ${docId}`,
    `agent_id: ${agentId}`,
    `title: "${title.replace(/"/g, '\\"')}"`,
    `tags: ${tags}`,
    `file_type: ${fileType}`,
    `created_by: ${createdBy}`,
    `created_at: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
  ];
  if (docDate) {
    frontmatterLines.push(`doc_date: ${docDate}`);
  }
  frontmatterLines.push('---', '');
  const frontmatter = frontmatterLines.join('\n');

  const fullContent = frontmatter + markdown;
  const parsedMdAbs = path.join(dir, 'parsed.md');
  fs.writeFileSync(parsedMdAbs, fullContent, 'utf-8');

  const imgDir = path.join(dir, 'images');
  if (fs.existsSync(imgDir)) {
    const imgFiles = fs.readdirSync(imgDir).filter(f => !f.startsWith('.'));
    if (imgFiles.length === 0) {
      try { fs.rmdirSync(imgDir); } catch {}
    }
  }

  return {
    relPath: getDocStorageRelPath(docId, agentId),
    parsedMdAbs,
    sizeBytes: fs.statSync(parsedMdAbs).size,
  };
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

  const tagCandidates = collectTagCandidatesFromFs(agentId);
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

/**
 * Generate tags for a document.
 * LLM-based tag extraction is disabled: bulk import showed it consistently
 * returns the title verbatim (tag candidates snowball effect). Use
 * `/doc-retag --all` after import if meaningful tags are needed.
 */
async function generateTagsWithLLM(markdown: string, docTitle: string, _agentId: string): Promise<string> {
  return docTitle;
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
  let describeImageWithFallback: typeof import('../llm/agent.js').describeImageWithFallback;
  try {
    const { getProvider } = await import('../llm/provider.js');
    provider = getProvider();
    ({ describeImageWithFallback } = await import('../llm/agent.js'));
  } catch {
    return content;
  }
  const { getProviderByName } = await import('../llm/provider.js');
  const anyDescriber = !!(provider.describeImage
    || getProviderByName('minimax')?.describeImage
    || getProviderByName('anthropic')?.describeImage);
  if (!anyDescriber) return content;

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
        const { desc } = await describeImageWithFallback(
          provider,
          dataUrl,
          '用一两句中文简要描述这张图片的内容，重点说明图中的关键信息（如数据、流程、结构等）。',
        );
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
  markdown: string;
  tags: string;
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
  let markdown = '';
  let images: ExtractedImage[] = [];

  switch (fileType) {
    case 'md': {
      let raw = fs.readFileSync(filePath, 'utf-8');
      if (filePath.includes('.excalidraw.')) {
        raw = raw.replace(/%%\n[\s\S]*?%%/g, '').replace(/<!--\s*excalidraw[\s\S]*?-->/gi, '');
      }
      markdown = raw;
      break;
    }

    case 'docx': {
      const pluginInput: Record<string, any> = { file_path: filePath, format: 'markdown', max_chars: 100000 };
      if (options?.imageOutputDir) pluginInput.image_output_dir = options.imageOutputDir;

      const result = await executePluginTool('parse_word', pluginInput);
      if (!result) return { markdown: '', tags: '', error: '需要 word-parser 插件（plugins/word-parser/），请确认已安装' };
      const parsed = JSON.parse(result);
      if (parsed.error) return { markdown: '', tags: '', error: parsed.error };

      let content: string = parsed.content;
      images = parsed.images || [];

      if (images.length > 0 && options?.imageOutputDir) {
        const shouldDescribe = process.env.DOC_IMPORT_DESCRIBE_IMAGES !== 'false';
        if (shouldDescribe) {
          log.info(`为 ${images.length} 张图片生成 AI 描述...`);
          content = await describeImagesInMarkdown(content, images, options.imageOutputDir, options?.onProgress);
        }
      }

      if (parsed.engine) log.dim(`  Word 解析引擎: ${parsed.engine}`);
      markdown = content;
      break;
    }

    case 'xlsx':
    case 'csv': {
      try {
        const chunks = splitExcelBySheets(filePath, docTitle);
        if (chunks.length === 0) return { markdown: '', tags: '', error: '文件为空或无可读数据' };
        // Convert Excel chunks to full markdown
        markdown = chunks.map(c => `## ${c.heading}\n\n${c.content}`).join('\n\n');
      } catch (e: any) {
        return { markdown: '', tags: '', error: `Excel 解析失败: ${e.message}` };
      }
      break;
    }

    case 'pdf': {
      const pluginInput: Record<string, any> = { file_path: filePath, max_chars: 100000 };
      if (options?.imageOutputDir) pluginInput.image_output_dir = options.imageOutputDir;

      const pdfResult = await executePluginTool('parse_pdf', pluginInput);
      if (!pdfResult) return { markdown: '', tags: '', error: '需要 pdf-parser 插件（plugins/pdf-parser/），请确认已安装' };
      const pdfParsed = JSON.parse(pdfResult);
      if (pdfParsed.error) return { markdown: '', tags: '', error: pdfParsed.error };

      let content: string = pdfParsed.content;
      images = pdfParsed.images || [];

      if (images.length > 0 && options?.imageOutputDir) {
        const shouldDescribe = process.env.DOC_IMPORT_DESCRIBE_IMAGES !== 'false';
        if (shouldDescribe) {
          log.info(`为 ${images.length} 张图片生成 AI 描述...`);
          content = await describeImagesInMarkdown(content, images, options.imageOutputDir, options?.onProgress);
        }
      }

      markdown = content;
      break;
    }

    case 'html': {
      const html = fs.readFileSync(filePath, 'utf-8');
      const TurndownService = (await import('turndown')).default;
      // @ts-expect-error - no @types/turndown-plugin-gfm
      const { gfm } = await import('turndown-plugin-gfm');
      const turndown = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
        emDelimiter: '*',
      });
      turndown.use(gfm);
      markdown = turndown.turndown(html);
      break;
    }

    case 'png':
    case 'jpg':
    case 'gif':
    case 'webp':
    case 'svg': {
      const buffer = fs.readFileSync(filePath);
      const ext = fileType;
      const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
      const mime = mimeMap[ext] || 'image/png';
      const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

      const provider = getProvider();
      const imagePrompt = [
        '你是 OCR + 版面还原助手，请把图片中**所有**可见文字逐字转录为 markdown，严格遵守：',
        '1. 不省略任何字段、代码、数字、日期、金额、印章文字、表头、空白栏目名；空白单元格写 "(空)"，不要写"该栏空白"。',
        '2. 用 markdown 表格还原原图所有表格，**必须输出完整的列头行和所有数据行（含空行）**，列数与原图一致。',
        '3. 难辨认或被裁切的字符用 [?] 标记，**不要**跳过整段或用一句话概括。',
        '4. 印章/手写签名/手写备注单独成段列出原文。',
        '5. **不做总结、不做解读、不补充背景知识**，只做版面+文字还原。',
        '6. 顶部可输出一行 "图片类型：..." 用于分类（如：门诊处方笺/检查报告/...），其余内容必须是逐字转录。',
      ].join('\n');

      let desc = '';
      try {
        const result = await describeImageWithFallback(provider, dataUrl, imagePrompt);
        desc = result.desc;
      } catch (e: any) {
        log.warn(`图片描述失败 (${docTitle}): ${e.message}`);
      }
      const descBlock = desc ? `> **[图片内容]** ${desc}` : '> *（图片描述不可用）*';

      if (options?.imageOutputDir) {
        fs.mkdirSync(options.imageOutputDir, { recursive: true });
        linkOrCopy(filePath, path.join(options.imageOutputDir, path.basename(filePath)));
        images = [{ filename: path.basename(filePath), relativePath: `images/${path.basename(filePath)}` }];
      }

      markdown = `![${docTitle}](images/${path.basename(filePath)})\n\n${descBlock}`;
      break;
    }

    default:
      return { markdown: '', tags: '', error: `不支持的文件类型: ${fileType}` };
  }

  // Generate tags via LLM (no chunking)
  const tags = await generateTagsWithLLM(markdown, docTitle, agentId);
  return { markdown, tags, images };
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

export async function importDocument(
  filePath: string,
  agentId: string,
  options?: { title?: string; docDate?: string; actorUserId?: string; onProgress?: (event: { type: 'tool_progress'; message: string }) => void },
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

  // Validate doc_date if provided
  const docDate = options?.docDate?.trim();
  if (docDate && isNaN(new Date(docDate).getTime())) {
    return { success: false, error: `无效的日期格式: ${docDate}，请使用 YYYY-MM-DD 格式` };
  }

  // Compute content hash for dedup
  let contentHash = '';
  try {
    contentHash = crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
  } catch (e: any) {
    return { success: false, error: `文件读取失败: ${e.message}` };
  }

  // Check for duplicate import (same source_path + agent_id, or same content hash + agent_id)
  const db = getDb();
  const existing = db.prepare(
    'SELECT id, title FROM documents WHERE source_path = ? AND agent_id = ?',
  ).get(resolved, agentId) as { id: string; title: string } | undefined;
  if (existing) {
    return { success: false, error: `文档已导入过 (${existing.id.slice(0, 8)}: ${existing.title})，如需更新请先删除或使用 reimport` };
  }

  const hashExisting = db.prepare(
    'SELECT id, title FROM documents WHERE content_hash = ? AND agent_id = ?',
  ).get(contentHash, agentId) as { id: string; title: string } | undefined;
  if (hashExisting) {
    return { success: false, error: `文档内容与已导入的文档相同 (${hashExisting.id.slice(0, 8)}: ${hashExisting.title})，请勿重复导入` };
  }

  // Generate doc ID early so we can set up the image output directory before parsing
  const docId = uuid();
  const docStorageDir = getDocStorageDir(docId, agentId);
  const imageOutputDir = path.join(docStorageDir, 'images');

  const { markdown, tags, images, error } = await loadAndChunk(resolved, fileType, docTitle, agentId, {
    imageOutputDir,
    onProgress: options?.onProgress,
  });
  if (error) {
    try { fs.rmSync(docStorageDir, { recursive: true, force: true }); } catch {}
    return { success: false, error };
  }
  if (!markdown.trim()) {
    try { fs.rmSync(docStorageDir, { recursive: true, force: true }); } catch {}
    return { success: false, error: '文档内容为空，无法导入' };
  }

  const { relPath, sizeBytes } = persistDocumentFiles(docId, agentId, resolved, fileType, markdown, tags, docTitle, actorUserId, docDate);

  if (images && images.length > 0) {
    log.info(`  提取了 ${images.length} 张图片 → ${imageOutputDir}`);
  }

  db.prepare(
    'INSERT INTO documents (id, title, source_path, file_type, agent_id, created_by, stored_path, size_bytes, content_hash, doc_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(docId, docTitle, resolved, fileType, agentId, actorUserId, relPath, sizeBytes, contentHash, docDate || null);

  recordEvent('document', docId, 'import', { title: docTitle, file_type: fileType });

  return {
    success: true,
    documentId: docId.slice(0, 8),
    title: docTitle,
    topics: tags.split(',').map(t => t.trim()),
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

  db.prepare('DELETE FROM knowledge WHERE document_id = ?').run(doc.id);
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);

  const storageDirAbs = doc.stored_path
    ? resolveStoredPath(doc.stored_path)
    : getDocStorageDir(doc.id, doc.agent_id || agentId || '');
  try { fs.rmSync(storageDirAbs, { recursive: true, force: true }); } catch (_) {}

  recordEvent('document', doc.id, 'delete', { title: doc.title });

  return { success: true, documentId: doc.id.slice(0, 8), title: doc.title };
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

  let reimportPath = doc.source_path;
  if (doc.stored_path) {
    const ext = path.extname(doc.source_path);
    const storedDirAbs = resolveStoredPath(doc.stored_path);
    const storedOriginal = path.join(storedDirAbs, `original${ext}`);
    if (fs.existsSync(storedOriginal)) {
      const tmpCopy = path.join(path.dirname(storedDirAbs), `_reimport_${doc.id.slice(0, 8)}${ext}`);
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

export function getDocumentContent(docIdPrefix: string): { content: string; format: 'md' } | { error: string } {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM documents WHERE id LIKE ?').all(`${docIdPrefix}%`) as DocumentInfo[];
  if (rows.length === 0) return { error: `未找到文档: ${docIdPrefix}` };
  if (rows.length > 1) return { error: '匹配到多个文档，请提供更长的 ID 前缀' };

  const doc = rows[0];
  const dirAbs = doc.stored_path
    ? resolveStoredPath(doc.stored_path)
    : getDocStorageDir(doc.id, doc.agent_id || '');

  const parsedMd = path.join(dirAbs, 'parsed.md');
  if (fs.existsSync(parsedMd)) {
    return { content: fs.readFileSync(parsedMd, 'utf-8'), format: 'md' };
  }
  return { error: '未找到 parsed.md（可能是在持久化功能上线前导入的文档）' };
}

// ---------------------------------------------------------------------------
// CLI handlers
// ---------------------------------------------------------------------------

export async function cliImport(args: string): Promise<void> {
  // Parse optional --doc-date <YYYY-MM-DD> and --title <title> from args
  // --title comes last and may contain spaces; --doc-date is a single word
  let docDate: string | undefined;
  let title: string | undefined;
  let rest = args.trim();

  // Extract --title (captures everything after the flag since it's always the last arg)
  const titleIdx = rest.lastIndexOf(' --title ');
  if (titleIdx !== -1) {
    title = rest.slice(titleIdx + 9).trim();
    rest = rest.slice(0, titleIdx);
  }

  // Extract --doc-date <YYYY-MM-DD>
  const dateMatch = rest.match(/\s+--doc-date\s+(\S+)/);
  if (dateMatch) {
    docDate = dateMatch[1];
    rest = rest.replace(dateMatch[0], '');
  }

  // Extract --no-compile
  let skipCompile = false;
  if (rest.includes('--no-compile')) {
    skipCompile = true;
    rest = rest.replace(/\s*--no-compile\s*/, ' ');
  }

  const filePath = rest.trim();
  if (!filePath) {
    log.print('用法: /doc-import <文件路径> [--doc-date YYYY-MM-DD] [--title <标题>]');
    return;
  }

  const agentId = getCurrentAgent()?.id;
  if (!agentId) {
    log.print('请先切换到一个 Agent');
    return;
  }

  const result = await importDocument(filePath, agentId, { actorUserId: getCurrentUser().id, docDate, title });
  if (result.success) {
    log.print(`文档已导入: [${result.documentId}] ${result.title}`);
    if (result.topics && result.topics.length > 0) {
      log.print(`标签: ${result.topics.join(', ')}`);
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
    const sizeInfo = typeof doc.size_bytes === 'number' && doc.size_bytes > 0
      ? formatFileSize(doc.size_bytes)
      : '未知大小';
    log.print(`  [${doc.id.slice(0, 8)}] ${doc.title}  (${doc.file_type}, ${sizeInfo})  ${doc.created_at}`);
  }
  log.print(`共 ${docs.length} 个文档`);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Retag: regenerate frontmatter tags for existing documents
// ---------------------------------------------------------------------------

/**
 * Re-run the LLM tag generator against an already-imported document and
 * rewrite only the `tags:` line in its parsed.md frontmatter. Used to fix
 * documents whose tags were filled with the title by the initial migration.
 *
 * Other frontmatter fields (document_id, agent_id, title, file_type,
 * created_by, created_at) are preserved verbatim. If tag generation fails,
 * the file is left untouched.
 */
export async function retagDocument(
  docIdPrefix: string,
  agentId: string,
): Promise<{ success: boolean; documentId?: string; title?: string; tags?: string; error?: string }> {
  const perm = ensureDocWriteAccess(agentId);
  if (!perm.success) return { success: false, error: perm.error };

  const db = getDb();
  const rows = db.prepare('SELECT * FROM documents WHERE id LIKE ?').all(`${docIdPrefix}%`) as DocumentInfo[];
  if (rows.length === 0) return { success: false, error: `未找到文档: ${docIdPrefix}` };
  if (rows.length > 1) return { success: false, error: '匹配到多个文档，请提供更长的 ID 前缀' };

  const doc = rows[0];
  if (doc.agent_id !== agentId) return { success: false, error: '该文档不属于当前 Agent' };

  const dirAbs = doc.stored_path
    ? resolveStoredPath(doc.stored_path)
    : getDocStorageDir(doc.id, doc.agent_id || agentId);
  const parsedMdPath = path.join(dirAbs, 'parsed.md');
  if (!fs.existsSync(parsedMdPath)) return { success: false, error: `parsed.md 不存在: ${parsedMdPath}` };

  const fullContent = fs.readFileSync(parsedMdPath, 'utf-8');

  // Separate frontmatter (first `---\n...\n---\n`) from body
  const fmMatch = fullContent.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return { success: false, error: 'parsed.md 缺少 YAML frontmatter，无法重标签' };
  const fmBlock = fmMatch[1];
  const body = fullContent.slice(fmMatch[0].length);

  const newTags = await generateTagsWithLLM(body, doc.title, agentId);

  // Replace only the tags line; preserve everything else
  const fmLines = fmBlock.split('\n');
  let replaced = false;
  for (let i = 0; i < fmLines.length; i++) {
    if (/^tags\s*:/.test(fmLines[i])) {
      fmLines[i] = `tags: ${newTags}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    fmLines.push(`tags: ${newTags}`);
  }

  const newContent = `---\n${fmLines.join('\n')}\n---\n${body}`;
  fs.writeFileSync(parsedMdPath, newContent, 'utf-8');

  // Keep size_bytes in sync with the edited file
  try {
    const newSize = fs.statSync(parsedMdPath).size;
    db.prepare('UPDATE documents SET size_bytes = ? WHERE id = ?').run(newSize, doc.id);
  } catch { /* non-fatal */ }

  recordEvent('document', doc.id, 'retag', { title: doc.title, tags: newTags });

  return {
    success: true,
    documentId: doc.id.slice(0, 8),
    title: doc.title,
    tags: newTags,
  };
}

export async function cliRetag(args: string): Promise<void> {
  const agentId = getCurrentAgent()?.id;
  if (!agentId) {
    log.print('请先切换到一个 Agent');
    return;
  }

  const arg = args.trim();
  if (!arg) {
    log.print('用法: /doc-retag <文档ID前缀> 或 /doc-retag --all');
    return;
  }

  if (arg === '--all') {
    const docs = listDocuments(agentId);
    if (docs.length === 0) {
      log.print('当前 Agent 下无文档');
      return;
    }
    log.print(`开始为 ${docs.length} 个文档重生成标签...`);
    let ok = 0;
    let fail = 0;
    for (const doc of docs) {
      const result = await retagDocument(doc.id, agentId);
      if (result.success) {
        ok += 1;
        log.print(`  [${result.documentId}] ${result.title} → ${result.tags}`);
      } else {
        fail += 1;
        log.print(`  [${doc.id.slice(0, 8)}] ${doc.title} 失败: ${result.error}`);
      }
    }
    log.print(`完成：成功 ${ok}，失败 ${fail}`);
    return;
  }

  const result = await retagDocument(arg, agentId);
  if (result.success) {
    log.print(`标签已更新: [${result.documentId}] ${result.title}`);
    log.print(`新标签: ${result.tags}`);
  } else {
    log.print(result.error!);
  }
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
    log.print(`已删除: ${result.title}`);
  } else {
    log.print(result.error!);
  }
}
