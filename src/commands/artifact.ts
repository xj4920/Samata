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
