import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getArtifactRoot } from './artifact.js';
import { log } from '../utils/logger.js';

const DEFAULT_IMAGE_MODEL = 'image-01-live';
const DEFAULT_VIDEO_MODEL = process.env.MINIMAX_VIDEO_MODEL || 'MiniMax-Hailuo-2.3';
const VIDEO_POLL_INTERVAL_MS = 5_000;
const VIDEO_MAX_POLL_MS = 5 * 60_000;

function getMinimaxApiKey(): string {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error('MINIMAX_API_KEY 未配置');
  return key;
}

function getMinimaxBaseUrl(): string {
  const url = process.env.MINIMAX_BASE_URL?.replace(/\/+$/, '');
  return url || 'https://api.minimaxi.com/v1';
}

// ── Image Generation ──

export interface GenerateImageOptions {
  aspectRatio?: string;
  count?: number;
}

export interface GenerateImageResult {
  paths: string[];
  model: string;
}

type MinimaxImageResponse = {
  data?: { image_base64?: string[] };
  metadata?: { success_count?: number; failed_count?: number };
  base_resp?: { status_code?: number; status_msg?: string };
};

export async function generateImage(prompt: string, opts: GenerateImageOptions = {}): Promise<GenerateImageResult> {
  const apiKey = getMinimaxApiKey();
  const baseUrl = getMinimaxBaseUrl();
  const count = Math.min(Math.max(opts.count ?? 1, 1), 9);
  const aspectRatio = opts.aspectRatio ?? '1:1';

  const body: Record<string, unknown> = {
    model: DEFAULT_IMAGE_MODEL,
    prompt,
    response_format: 'base64',
    n: count,
    aspect_ratio: aspectRatio,
  };

  log.dim(`🎨 调用 MiniMax 图片生成 (${DEFAULT_IMAGE_MODEL}, ${aspectRatio}, ×${count})...`);

  const resp = await fetch(`${baseUrl}/image_generation`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`MiniMax 图片生成失败 (${resp.status}): ${text || resp.statusText}`);
  }

  const data = await resp.json() as MinimaxImageResponse;

  if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
    throw new Error(`MiniMax 图片生成 API 错误 (${data.base_resp.status_code}): ${data.base_resp.status_msg ?? ''}`);
  }

  const base64Images = data.data?.image_base64 ?? [];
  if (base64Images.length === 0) {
    const failed = data.metadata?.failed_count ?? 0;
    throw new Error(`MiniMax 图片生成未返回图片${failed > 0 ? `（${failed} 张失败）` : ''}`);
  }

  const outDir = getArtifactRoot();
  const paths: string[] = [];
  for (let i = 0; i < base64Images.length; i++) {
    const b64 = base64Images[i];
    if (!b64) continue;
    const filename = `img_${randomUUID().slice(0, 8)}.png`;
    const filePath = path.join(outDir, filename);
    fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
    paths.push(filePath);
  }

  log.dim(`✅ 已生成 ${paths.length} 张图片`);
  return { paths, model: DEFAULT_IMAGE_MODEL };
}

// ── Video Generation ──

export interface GenerateVideoOptions {
  duration?: number;
  resolution?: string;
}

export interface GenerateVideoResult {
  path: string;
  model: string;
  taskId: string;
  width?: number;
  height?: number;
}

type MinimaxVideoSubmitResponse = {
  task_id?: string;
  base_resp?: { status_code?: number; status_msg?: string };
};

type MinimaxVideoQueryResponse = {
  task_id?: string;
  status?: string;
  file_id?: string;
  video_width?: number;
  video_height?: number;
  base_resp?: { status_code?: number; status_msg?: string };
};

type MinimaxFileRetrieveResponse = {
  file_id?: number;
  download_url?: string;
  base_resp?: { status_code?: number; status_msg?: string };
};

export async function generateVideo(prompt: string, opts: GenerateVideoOptions = {}): Promise<GenerateVideoResult> {
  const apiKey = getMinimaxApiKey();
  const baseUrl = getMinimaxBaseUrl();
  const duration = 6;
  const resolution = '768P';

  // Step 1: submit task
  log.dim(`🎬 提交 MiniMax 视频生成任务 (${DEFAULT_VIDEO_MODEL}, ${resolution}, ${duration}s)...`);

  const submitBody: Record<string, unknown> = {
    model: DEFAULT_VIDEO_MODEL,
    prompt,
  };

  const submitResp = await fetch(`${baseUrl}/video_generation`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(submitBody),
  });

  if (!submitResp.ok) {
    const text = await submitResp.text().catch(() => '');
    throw new Error(`MiniMax 视频生成提交失败 (${submitResp.status}): ${text || submitResp.statusText}`);
  }

  const submitData = await submitResp.json() as MinimaxVideoSubmitResponse;
  if (submitData.base_resp?.status_code && submitData.base_resp.status_code !== 0) {
    throw new Error(`MiniMax 视频生成 API 错误 (${submitData.base_resp.status_code}): ${submitData.base_resp.status_msg ?? ''}`);
  }

  const taskId = submitData.task_id;
  if (!taskId) throw new Error('MiniMax 视频生成未返回 task_id');

  log.dim(`📋 任务已提交: ${taskId}，开始轮询状态...`);

  // Step 2: poll until success or timeout
  const startTime = Date.now();
  let fileId: string | undefined;
  let videoWidth: number | undefined;
  let videoHeight: number | undefined;

  while (Date.now() - startTime < VIDEO_MAX_POLL_MS) {
    await sleep(VIDEO_POLL_INTERVAL_MS);

    const queryResp = await fetch(`${baseUrl}/query/video_generation?task_id=${taskId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!queryResp.ok) {
      log.dim(`⚠️ 查询状态失败 (${queryResp.status})，继续重试...`);
      continue;
    }

    const queryData = await queryResp.json() as MinimaxVideoQueryResponse;
    const status = queryData.status;

    if (status === 'Success') {
      fileId = queryData.file_id;
      videoWidth = queryData.video_width;
      videoHeight = queryData.video_height;
      log.dim(`✅ 视频生成完成 (${videoWidth}×${videoHeight})`);
      break;
    }

    if (status === 'Fail') {
      throw new Error(`MiniMax 视频生成失败: ${queryData.base_resp?.status_msg ?? '未知错误'}`);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log.dim(`⏳ 视频生成中 (${status}, ${elapsed}s)...`);
  }

  if (!fileId) {
    throw new Error(`MiniMax 视频生成超时（已等待 ${Math.round(VIDEO_MAX_POLL_MS / 1000)}s）`);
  }

  // Step 3: retrieve download URL (retry up to 3 times — URL may not be ready immediately)
  let downloadUrl: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(3_000);

    const fileResp = await fetch(`${baseUrl}/files/retrieve?file_id=${fileId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!fileResp.ok) {
      const text = await fileResp.text().catch(() => '');
      log.dim(`⚠️ 文件获取失败 (${fileResp.status}): ${text || fileResp.statusText}`);
      continue;
    }

    const fileData = await fileResp.json() as MinimaxFileRetrieveResponse;
    log.dim(`📄 文件信息: file_id=${fileData.file_id}, has_url=${!!fileData.download_url}, status=${fileData.base_resp?.status_code}`);

    if (fileData.base_resp?.status_code && fileData.base_resp.status_code !== 0) {
      log.dim(`⚠️ 文件获取 API 错误: ${fileData.base_resp.status_msg}`);
      continue;
    }

    if (fileData.download_url) {
      downloadUrl = fileData.download_url;
      break;
    }
  }

  if (!downloadUrl) {
    throw new Error(`MiniMax 文件获取未返回 download_url (file_id=${fileId})，可能是服务端延迟，请稍后重试`);
  }

  // Step 4: download video
  log.dim('⬇️ 下载视频文件...');
  const dlResp = await fetch(downloadUrl);
  if (!dlResp.ok) {
    throw new Error(`视频下载失败 (${dlResp.status})`);
  }

  const videoBuffer = Buffer.from(await dlResp.arrayBuffer());
  const outDir = getArtifactRoot();
  const filename = `video_${randomUUID().slice(0, 8)}.mp4`;
  const filePath = path.join(outDir, filename);
  fs.writeFileSync(filePath, videoBuffer);

  log.dim(`✅ 视频已保存: ${filePath} (${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB)`);

  return { path: filePath, model: DEFAULT_VIDEO_MODEL, taskId, width: videoWidth, height: videoHeight };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
