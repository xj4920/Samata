import fs from 'node:fs';
import path from 'node:path';
import type { DeliveryContext } from '../llm/agents/config.js';
import { getFeishuApp } from '../llm/agents/config.js';
import { getArtifactRoot } from './artifact.js';
import { FeishuAPI, detectFileType, isImageFile } from '../feishu/api.js';
import { TelegramAPI } from '../telegram/api.js';
import { log } from '../utils/logger.js';

type DeliveryResult =
  | { success: true; channel: DeliveryContext['channel']; filename: string; message_id?: string }
  | { success: false; error: string };

function resolveInputPath(inputPath: string): string {
  if (inputPath.startsWith('~/')) {
    return path.join(process.env.HOME || '', inputPath.slice(2));
  }
  return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(process.cwd(), inputPath);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateDeliverablePath(inputPath: string): { ok: true; path: string; filename: string } | { ok: false; error: string } {
  const resolved = resolveInputPath(inputPath);
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `文件不存在: ${resolved}` };
  }

  const allowedRoots = [getArtifactRoot(), process.cwd()];
  if (!allowedRoots.some(root => isInside(root, resolved))) {
    return { ok: false, error: `仅允许发送 ${getArtifactRoot()} 或项目目录下的文件: ${resolved}` };
  }

  return { ok: true, path: resolved, filename: path.basename(resolved) };
}

function resolveFeishuReceiveIdType(targetId: string): 'chat_id' | 'open_id' {
  return targetId.startsWith('oc_') ? 'chat_id' : 'open_id';
}

async function createTelegramApi(): Promise<TelegramAPI> {
  const configPath = path.resolve(process.cwd(), 'config/monitor.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const token = config.telegram?.botToken;
  if (!token) {
    throw new Error('未配置 telegram.botToken');
  }
  return new TelegramAPI(token, config.telegram?.proxy);
}

async function sendViaFeishu(filePath: string, fileName: string, deliveryContext: DeliveryContext): Promise<DeliveryResult> {
  if (!deliveryContext.appId) {
    return { success: false, error: '飞书发送失败：缺少 appId 投递上下文' };
  }

  const appRow = getFeishuApp(deliveryContext.appId);
  if (!appRow) {
    return { success: false, error: `飞书发送失败：未找到 app ${deliveryContext.appId}` };
  }

  const api = new FeishuAPI({
    appId: appRow.app_id,
    appSecret: appRow.app_secret,
    verificationToken: appRow.verification_token,
    encryptKey: appRow.encrypt_key,
  });
  const receiveIdType = resolveFeishuReceiveIdType(deliveryContext.targetId);

  if (isImageFile(fileName)) {
    const imageKey = await api.uploadImage(filePath);
    if (!imageKey) {
      return { success: false, error: `飞书图片上传失败: ${fileName}` };
    }
    const messageId = await api.sendMessageTo(deliveryContext.targetId, receiveIdType, 'image', { image_key: imageKey });
    log.file(`[delivery] 实际已发送图片: ${fileName} -> feishu/${deliveryContext.targetId}`);
    return { success: true, channel: 'feishu', filename: fileName, message_id: messageId };
  }

  const fileKey = await api.uploadFile(filePath, fileName, detectFileType(fileName));
  if (!fileKey) {
    return { success: false, error: `飞书文件上传失败: ${fileName}` };
  }
  const messageId = await api.sendMessageTo(deliveryContext.targetId, receiveIdType, 'file', { file_key: fileKey });
  log.file(`[delivery] 实际已发送文件: ${fileName} -> feishu/${deliveryContext.targetId}`);
  return { success: true, channel: 'feishu', filename: fileName, message_id: messageId };
}

async function sendViaTelegram(filePath: string, fileName: string, deliveryContext: DeliveryContext): Promise<DeliveryResult> {
  const chatId = Number(deliveryContext.targetId);
  if (!Number.isFinite(chatId)) {
    return { success: false, error: `Telegram 发送失败：无效 chatId ${deliveryContext.targetId}` };
  }

  const api = await createTelegramApi();
  if (isImageFile(fileName)) {
    const msg = await api.sendPhoto(chatId, filePath, fileName);
    log.file(`[delivery] 实际已发送图片: ${fileName} -> telegram/${deliveryContext.targetId}`);
    return { success: true, channel: 'telegram', filename: fileName, message_id: String(msg.message_id) };
  }

  const msg = await api.sendDocument(chatId, filePath, fileName);
  log.file(`[delivery] 实际已发送文件: ${fileName} -> telegram/${deliveryContext.targetId}`);
  return { success: true, channel: 'telegram', filename: fileName, message_id: String(msg.message_id) };
}

async function sendPathToCurrentChannel(input: { path: string }, deliveryContext: DeliveryContext | undefined, mode: 'file' | 'image'): Promise<DeliveryResult> {
  if (!deliveryContext || deliveryContext.channel === 'cli') {
    return { success: false, error: '缺少可投递的渠道上下文，请通过飞书或 Telegram 使用此工具。' };
  }

  const checked = validateDeliverablePath(input.path);
  if (!checked.ok) {
    return { success: false, error: checked.error };
  }
  if (mode === 'image' && !isImageFile(checked.filename)) {
    return { success: false, error: `send_image 仅支持图片文件: ${checked.filename}` };
  }

  if (deliveryContext.channel === 'feishu') {
    return sendViaFeishu(checked.path, checked.filename, deliveryContext);
  }
  if (deliveryContext.channel === 'telegram') {
    return sendViaTelegram(checked.path, checked.filename, deliveryContext);
  }
  return { success: false, error: `暂不支持的渠道: ${deliveryContext.channel}` };
}

export async function sendFileToCurrentChannel(input: { path: string }, deliveryContext?: DeliveryContext): Promise<DeliveryResult> {
  return sendPathToCurrentChannel(input, deliveryContext, 'file');
}

export async function sendImageToCurrentChannel(input: { path: string }, deliveryContext?: DeliveryContext): Promise<DeliveryResult> {
  return sendPathToCurrentChannel(input, deliveryContext, 'image');
}
