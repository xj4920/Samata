/**
 * import-bridge.ts — 通过 Samata CLI HTTP API 桥接导入文档
 *
 * 通信协议（定义在 src/server/cli-api.ts）:
 *   POST /api/cli/session  → { username, agentName } → { sessionId, user, agentName }
 *   POST /api/cli/execute   → { sessionId, input }     → { ok, output[], error? }
 *   DELETE /api/cli/session → { sessionId }             → { ok }
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SamataConfig {
  base_url: string;
  username: string;
  agent_name: string;
}

export interface ImportResult {
  page_id: string;
  title: string;
  document_id?: string;
  version: number;
  status: 'imported' | 'updated' | 'skipped' | 'failed';
  error?: string;
  attachments?: { filename: string; document_id: string }[];
}

interface CliSession {
  sessionId: string;
  user: { id: string; username: string; role: string };
  agentName: string;
}

interface CliExecuteResponse {
  ok: boolean;
  output: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Samata HTTP client
// ---------------------------------------------------------------------------

export class SamataClient {
  private baseUrl: string;
  private sessionId: string | null = null;
  private username: string = '';
  private agentName: string = '';

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${method} ${path}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async createSession(username: string, agentName: string): Promise<void> {
    this.username = username;
    this.agentName = agentName;
    const data = await this.request<{ ok: boolean; session: CliSession }>(
      'POST', '/api/cli/session', { username, agentName },
    );
    if (!data.ok || !data.session?.sessionId) {
      throw new Error('创建 Samata session 失败: ' + JSON.stringify(data));
    }
    this.sessionId = data.session.sessionId;
  }

  hasSession(): boolean {
    return this.sessionId !== null;
  }

  async ensureSession(): Promise<boolean> {
    if (!this.username || !this.agentName) return false;
    // Destroy stale session first (best effort)
    if (this.sessionId) {
      try {
        await this.request('DELETE', '/api/cli/session', { sessionId: this.sessionId });
      } catch { /* ignore */ }
      this.sessionId = null;
    }
    try {
      await this.createSession(this.username, this.agentName);
      return true;
    } catch {
      return false;
    }
  }

  async execute(input: string): Promise<CliExecuteResponse> {
    if (!this.sessionId) throw new Error('未创建 session，请先调用 createSession()');
    return this.request<CliExecuteResponse>(
      'POST', '/api/cli/execute', { sessionId: this.sessionId, input },
    );
  }

  async destroySession(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.request('DELETE', '/api/cli/session', { sessionId: this.sessionId });
    } catch {
      // best effort
    }
    this.sessionId = null;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Check if an error message indicates a stale/broken session */
  private static isSessionError(err: Error): boolean {
    const msg = err.message;
    return msg.includes('fetch failed')
      || msg.includes('会话不存在')
      || msg.includes('CLI 会话')
      || msg.includes('session')
      || msg.includes('ECONNREFUSED')
      || msg.includes('ETIMEDOUT');
  }

  async executeWithRetry(input: string, onProgress?: (msg: string) => void): Promise<CliExecuteResponse> {
    try {
      return await this.execute(input);
    } catch (err: any) {
      if (!SamataClient.isSessionError(err)) throw err;
      onProgress?.(`  会话失效，重建中...`);
      const recreated = await this.ensureSession();
      if (!recreated) throw new Error(`会话重建失败: ${err.message}`);
      onProgress?.(`  会话已重建，重试...`);
      return this.execute(input);
    }
  }
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** 从 /doc-import 的 output 中提取 document ID */
function parseDocumentId(output: string[]): string | undefined {
  for (const line of output) {
    // 格式: 文档已导入: [a1b2c3d4] 标题
    const m = line.match(/文档已导入:\s*\[([a-f0-9]{8})\]/);
    if (m) return m[1];
  }
  return undefined;
}

/** 检查 output 是否表示"已导入过"（内容重复） */
function isDuplicateError(output: string[]): boolean {
  return output.some(line => line.includes('已导入过') || line.includes('请勿重复导入'));
}

// ---------------------------------------------------------------------------
// YAML frontmatter helpers
// ---------------------------------------------------------------------------

interface PageMetadata {
  confluence_page_id?: string;
  title?: string;
  confluence_space_key?: string;
  confluence_url?: string;
  updated?: string;
}

function parseFrontmatter(filePath: string): PageMetadata {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.startsWith('---\n')) return {};
    const endIdx = content.indexOf('\n---', 4);
    if (endIdx === -1) return {};
    const raw = yaml.parse(content.slice(4, endIdx)) as Record<string, unknown> | null;
    if (!raw) return {};
    return {
      confluence_page_id: raw.confluence_page_id != null ? String(raw.confluence_page_id) : undefined,
      title: typeof raw.title === 'string' ? raw.title : undefined,
      confluence_space_key: typeof raw.confluence_space_key === 'string' ? raw.confluence_space_key : undefined,
      confluence_url: typeof raw.confluence_url === 'string' ? raw.confluence_url : undefined,
      updated: typeof raw.updated === 'string' ? raw.updated : undefined,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Attachment discovery
// ---------------------------------------------------------------------------

const NON_IMAGE_EXTS = new Set(['.xlsx', '.xls', '.csv', '.pdf', '.docx', '.doc']);

function findAttachments(pageDir: string): string[] {
  const imagesDir = path.join(pageDir, 'images');
  if (!fs.existsSync(imagesDir)) return [];
  return fs.readdirSync(imagesDir)
    .filter(f => NON_IMAGE_EXTS.has(path.extname(f).toLowerCase()))
    .map(f => path.join(imagesDir, f));
}

// ---------------------------------------------------------------------------
// Import logic
// ---------------------------------------------------------------------------

export async function importPage(
  client: SamataClient,
  mdPath: string,
  pageId: string,
  version: number,
  onProgress?: (msg: string) => void,
): Promise<ImportResult> {
  const absPath = path.resolve(mdPath);
  if (!fs.existsSync(absPath)) {
    return { page_id: pageId, title: path.basename(mdPath), version, status: 'failed', error: `文件不存在: ${absPath}` };
  }

  const meta = parseFrontmatter(absPath);
  const title = meta.title || path.basename(mdPath, '.md');

  // Build /doc-import command with optional flags
  let importCmd = `/doc-import ${absPath} --no-compile`;
  // Extract doc_date from frontmatter 'updated' field (e.g. "2026-04-27T10:30:00Z")
  const docDate = meta.updated ? meta.updated.slice(0, 10) : undefined;
  if (docDate) importCmd += ` --doc-date ${docDate}`;
  if (meta.title) importCmd += ` --title ${meta.title}`;

  const result: ImportResult = { page_id: pageId, title, version, status: 'failed' };

  // 1. Import the markdown page
  const pageRes = await client.executeWithRetry(importCmd, onProgress);
  if (!pageRes.ok) {
    result.error = pageRes.error || pageRes.output?.join('; ') || '导入失败';
    return result;
  }

  const docId = parseDocumentId(pageRes.output || []);
  if (docId) {
    result.document_id = docId;
    result.status = 'imported';
  } else if (isDuplicateError(pageRes.output || [])) {
    result.status = 'skipped';
    result.error = '内容未变更，跳过';
    return result;
  } else {
    result.error = `无法解析 document ID: ${JSON.stringify(pageRes.output)}`;
    return result;
  }

  // 2. Import non-image attachments
  const pageDir = path.dirname(absPath);
  const attachments = findAttachments(pageDir);
  const importedAttachments: { filename: string; document_id: string }[] = [];

  for (const attPath of attachments) {
    const attRes = await client.executeWithRetry(`/doc-import ${attPath}`);
    if (attRes.ok) {
      const attId = parseDocumentId(attRes.output || []);
      if (attId) {
        importedAttachments.push({ filename: path.basename(attPath), document_id: attId });
      }
    }
    // 附件导入失败不阻塞
  }

  if (importedAttachments.length > 0) {
    result.attachments = importedAttachments;
  }

  return result;
}

export async function reimportPage(
  client: SamataClient,
  mdPath: string,
  pageId: string,
  version: number,
  oldDocumentId: string,
  onProgress?: (msg: string) => void,
): Promise<ImportResult> {
  // 删除旧文档
  const delRes = await client.executeWithRetry(`/doc-del ${oldDocumentId}`, onProgress);
  if (!delRes.ok) {
    return {
      page_id: pageId,
      title: path.basename(mdPath, '.md'),
      version,
      status: 'failed',
      error: `删除旧文档失败: ${delRes.error || JSON.stringify(delRes.output)}`,
    };
  }

  // 导入新版本
  const result = await importPage(client, mdPath, pageId, version, onProgress);
  result.status = 'updated';
  return result;
}

// ---------------------------------------------------------------------------
// Batch import with session management
// ---------------------------------------------------------------------------

export async function importPages(
  samataConfig: SamataConfig,
  pages: Array<{ mdPath: string; pageId: string; version: number; oldDocumentId?: string }>,
  onProgress?: (msg: string) => void,
): Promise<ImportResult[]> {
  const client = new SamataClient(samataConfig.base_url);

  // 等待 Samata API 在线
  for (let i = 0; i < 3; i++) {
    if (await client.healthCheck()) break;
    const waitMs = 60_000 * (i + 1);
    onProgress?.(`Samata API 不在线，${waitMs / 1000}s 后重试 (${i + 1}/3)...`);
    await sleep(waitMs);
  }

  if (!(await client.healthCheck())) {
    return pages.map(p => ({
      page_id: p.pageId,
      title: path.basename(p.mdPath),
      version: p.version,
      status: 'failed' as const,
      error: 'Samata API 不可达',
    }));
  }

  try {
    await client.createSession(samataConfig.username, samataConfig.agent_name);
  } catch (e: any) {
    return pages.map(p => ({
      page_id: p.pageId,
      title: path.basename(p.mdPath),
      version: p.version,
      status: 'failed' as const,
      error: `创建 session 失败: ${e.message}`,
    }));
  }

  const results: ImportResult[] = [];
  const total = pages.length;

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const label = p.oldDocumentId ? '更新' : '导入';
    onProgress?.(`[${i + 1}/${total}] ${label}: ${path.basename(p.mdPath)}`);

    try {
      const r = p.oldDocumentId
        ? await reimportPage(client, p.mdPath, p.pageId, p.version, p.oldDocumentId, onProgress)
        : await importPage(client, p.mdPath, p.pageId, p.version, onProgress);
      results.push(r);

      if (r.status === 'failed') {
        onProgress?.(`  失败: ${r.error}`);
      } else if (r.status === 'skipped') {
        onProgress?.(`  跳过: ${r.error}`);
      } else {
        onProgress?.(`  完成: [${r.document_id}] ${r.title}`);
      }
    } catch (e: any) {
      results.push({
        page_id: p.pageId,
        title: path.basename(p.mdPath),
        version: p.version,
        status: 'failed',
        error: e.message,
      });
      onProgress?.(`  异常: ${e.message}`);
    }
  }

  await client.destroySession();
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
