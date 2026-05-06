import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ARTIFACT_DIR_NAME = 'samata';

export function getArtifactRoot(): string {
  const dir = path.join(os.tmpdir(), ARTIFACT_DIR_NAME);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function sanitizeArtifactFilename(filename: string): string {
  const base = path.basename((filename || '').trim());
  const sanitized = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    return `artifact-${Date.now()}.txt`;
  }
  return sanitized;
}

export function saveUploadedFile(buffer: Buffer, filename: string): string {
  const uploadDir = path.join(getArtifactRoot(), 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const safeName = `${randomUUID().slice(0, 8)}_${sanitizeArtifactFilename(filename)}`;
  const filePath = path.join(uploadDir, safeName);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

export function writeArtifact(input: { filename: string; content: string }): {
  success: true;
  path: string;
  filename: string;
  bytes: number;
} {
  const filename = sanitizeArtifactFilename(input.filename);
  const filePath = path.join(getArtifactRoot(), filename);
  fs.writeFileSync(filePath, input.content, 'utf-8');

  return {
    success: true,
    path: filePath,
    filename,
    bytes: Buffer.byteLength(input.content, 'utf-8'),
  };
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;

  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, ''));
    } catch {
      return utf8Match[1].trim().replace(/^"|"$/g, '');
    }
  }

  const match = value.match(/filename=([^;]+)/i);
  return match?.[1]?.trim().replace(/^"|"$/g, '') || null;
}

function extensionFromContentType(contentType: string | null): string {
  const mime = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const map: Record<string, string> = {
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-excel': '.xls',
    'text/csv': '.csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/msword': '.doc',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };
  return map[mime] ?? '';
}

function filenameFromUrl(url: URL): string | null {
  const lastSegment = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
  return lastSegment || null;
}

export async function downloadFileArtifact(input: {
  url: string;
  filename?: string;
  headers?: Record<string, string>;
  timeout?: number;
}): Promise<
  | { success: true; path: string; filename: string; bytes: number; content_type: string | null; status: number; url: string }
  | { success: false; error: string; status?: number }
> {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { success: false, error: 'URL 无效' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { success: false, error: '仅支持 http/https URL' };
  }

  const timeout = input.timeout ?? 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(parsed, {
      headers: input.headers,
      signal: controller.signal,
    });
    const contentType = resp.headers.get('content-type');

    if (!resp.ok) {
      return { success: false, error: `下载失败: HTTP ${resp.status}`, status: resp.status };
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    const fallbackName = `download-${Date.now()}${extensionFromContentType(contentType)}`;
    const rawName =
      input.filename ||
      filenameFromContentDisposition(resp.headers.get('content-disposition')) ||
      filenameFromUrl(parsed) ||
      fallbackName;
    let filename = sanitizeArtifactFilename(rawName);

    if (!path.extname(filename)) {
      filename += extensionFromContentType(contentType);
    }

    const filePath = path.join(getArtifactRoot(), filename);
    fs.writeFileSync(filePath, buffer);

    return {
      success: true,
      path: filePath,
      filename,
      bytes: buffer.length,
      content_type: contentType,
      status: resp.status,
      url: resp.url,
    };
  } catch (err: any) {
    const message = err?.name === 'AbortError' ? `下载超时（${timeout}ms）` : err.message;
    return { success: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}
