import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getArtifactRoot } from './artifact.js';
import { log } from '../utils/logger.js';

const DEFAULT_IMAGE_MODEL = process.env.MINIMAX_IMAGE_MODEL || 'image-01';
const T2V_MODELS = ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02'];
const T2V_DEFAULT = T2V_MODELS[0];
const T2V_FALLBACK = T2V_MODELS[1];
const I2V_MODELS = ['MiniMax-Hailuo-2.3-Fast', 'MiniMax-Hailuo-2.3'];
const I2V_DEFAULT = process.env.MINIMAX_I2V_MODEL || I2V_MODELS[0];
const I2V_FALLBACK = I2V_MODELS.find(m => m !== I2V_DEFAULT) ?? I2V_MODELS[1];
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
  referenceImage?: string;
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

  // 图生图：读取参考图片并添加 subject_reference
  if (opts.referenceImage) {
    const refPath = opts.referenceImage.startsWith('~/')
      ? path.join(process.env.HOME || '', opts.referenceImage.slice(1))
      : path.resolve(opts.referenceImage);
    if (!fs.existsSync(refPath)) {
      throw new Error(`参考图片不存在: ${refPath}`);
    }
    const buf = fs.readFileSync(refPath);
    const ext = path.extname(refPath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    body.subject_reference = [{ type: 'character', image_file: dataUrl }];
    log.dim(`🎨 图生图模式：参考图片 ${path.basename(refPath)} (${(buf.length / 1024).toFixed(0)} KB)`);
  }

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
  firstFrameImage?: string;
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
  file?: { file_id?: number; download_url?: string };
  base_resp?: { status_code?: number; status_msg?: string };
};

function isQuotaOrRateError(status: number, statusMsg?: string): boolean {
  if (status === 429 || status === 1042) return true;
  const msg = (statusMsg || '').toLowerCase();
  return msg.includes('rate') || msg.includes('quota') || msg.includes('limit') || msg.includes('exceeded');
}

type SubmitExtra = {
  duration?: number;
  resolution?: string;
  firstFrameImage?: string;
  fallbackModel?: string;
};

async function submitVideoTask(
  baseUrl: string, apiKey: string, prompt: string, model: string,
  extra: SubmitExtra = {},
): Promise<{ taskId: string; usedModel: string }> {
  const body: Record<string, unknown> = { model, prompt };
  if (extra.duration) body.duration = extra.duration;
  if (extra.resolution) body.resolution = extra.resolution;
  if (extra.firstFrameImage) body.first_frame_image = extra.firstFrameImage;

  const mode = extra.firstFrameImage ? 'I2V' : 'T2V';
  log.dim(`🎬 提交 MiniMax ${mode} 任务 (${model}, ${extra.resolution ?? '768P'}, ${extra.duration ?? 6}s)...`);
  const resp = await fetch(`${baseUrl}/video_generation`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const fb = extra.fallbackModel;
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (fb && model !== fb && isQuotaOrRateError(resp.status, text)) {
      log.dim(`⚠️ ${model} 额度受限 (${resp.status})，尝试 fallback → ${fb}`);
      return submitVideoTask(baseUrl, apiKey, prompt, fb, { ...extra, fallbackModel: undefined });
    }
    throw new Error(`MiniMax 视频生成提交失败 (${resp.status}): ${text || resp.statusText}`);
  }

  const data = await resp.json() as MinimaxVideoSubmitResponse;
  if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
    const code = data.base_resp.status_code;
    const msg = data.base_resp.status_msg ?? '';

    // 2061/2013: plan or params don't support this resolution/duration — auto-downgrade
    if ((code === 2061 || code === 2013) && (extra.resolution === '1080P' || (extra.duration ?? 6) > 6)) {
      const downgraded: SubmitExtra = { ...extra };
      if (extra.resolution === '1080P') { downgraded.resolution = '768P'; }
      if ((extra.duration ?? 6) > 6) { downgraded.duration = 6; }
      log.dim(`⚠️ 当前套餐不支持 ${extra.resolution ?? '768P'}/${extra.duration ?? 6}s，自动降级 → ${downgraded.resolution}/${downgraded.duration}s`);
      return submitVideoTask(baseUrl, apiKey, prompt, model, downgraded);
    }

    if (fb && model !== fb && isQuotaOrRateError(code, msg)) {
      log.dim(`⚠️ ${model} 额度受限 (${code}: ${msg})，尝试 fallback → ${fb}`);
      return submitVideoTask(baseUrl, apiKey, prompt, fb, { ...extra, fallbackModel: undefined });
    }
    throw new Error(`MiniMax 视频生成 API 错误 (${code}): ${msg}`);
  }
  if (!data.task_id) throw new Error('MiniMax 视频生成未返回 task_id');
  return { taskId: data.task_id, usedModel: model };
}

function readImageAsDataUrl(imagePath: string): string {
  const resolved = imagePath.startsWith('~/')
    ? path.join(process.env.HOME || '', imagePath.slice(1))
    : path.resolve(imagePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`首帧图片不存在: ${resolved}`);
  }
  const buf = fs.readFileSync(resolved);
  if (buf.length > 20 * 1024 * 1024) {
    throw new Error(`首帧图片超过 20MB 限制: ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
  }
  const ext = path.extname(resolved).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

export async function generateVideo(prompt: string, opts: GenerateVideoOptions = {}): Promise<GenerateVideoResult> {
  const apiKey = getMinimaxApiKey();
  const baseUrl = getMinimaxBaseUrl();

  const isI2V = !!opts.firstFrameImage;
  let firstFrameDataUrl: string | undefined;
  if (isI2V) {
    firstFrameDataUrl = readImageAsDataUrl(opts.firstFrameImage!);
    log.dim(`🖼️ 图生视频模式：首帧图片 ${path.basename(opts.firstFrameImage!)}`);
  }

  const model = isI2V ? I2V_DEFAULT : T2V_DEFAULT;
  const fallback = isI2V ? I2V_FALLBACK : T2V_FALLBACK;

  const { taskId, usedModel } = await submitVideoTask(baseUrl, apiKey, prompt, model, {
    duration: opts.duration,
    resolution: opts.resolution,
    firstFrameImage: firstFrameDataUrl,
    fallbackModel: fallback,
  });

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
    const file = fileData.file;
    log.dim(`📄 文件信息: file_id=${file?.file_id}, has_url=${!!file?.download_url}, status=${fileData.base_resp?.status_code}`);

    if (fileData.base_resp?.status_code && fileData.base_resp.status_code !== 0) {
      log.dim(`⚠️ 文件获取 API 错误: ${fileData.base_resp.status_msg}`);
      continue;
    }

    if (file?.download_url) {
      downloadUrl = file.download_url;
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

  return { path: filePath, model: usedModel, taskId, width: videoWidth, height: videoHeight };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
