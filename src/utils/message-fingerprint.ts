import crypto from 'crypto';

export interface MessageFingerprint {
  id: string;           // 唯一标识（基于时间+发送人+会话）
  contentHash: string;  // 内容 hash（用于检测内容变化）
}

/**
 * 生成消息指纹（用于去重和追踪）
 *
 * @param time 消息时间
 * @param sender 发送人
 * @param content 消息内容
 * @param session 群组名称
 * @returns 消息指纹对象
 */
export function generateMessageFingerprint(
  time: string,
  sender: string,
  content: string,
  session: string
): MessageFingerprint {
  // ID: 基于时间+发送人+会话的稳定标识
  // 这样即使消息内容变化（撤回重发），ID 也保持不变
  const id = crypto
    .createHash('sha256')
    .update(`${time}|${sender}|${session}`)
    .digest('hex')
    .slice(0, 16);

  // Content Hash: 用于检测内容变化
  const contentHash = crypto
    .createHash('sha256')
    .update(content)
    .digest('hex')
    .slice(0, 16);

  return { id, contentHash };
}

/**
 * 批量生成消息指纹
 */
export function generateMessageFingerprints(
  messages: Array<{ time: string; sender: string; content: string; session: string }>
): Map<string, MessageFingerprint> {
  const fingerprints = new Map<string, MessageFingerprint>();

  for (const msg of messages) {
    const fp = generateMessageFingerprint(msg.time, msg.sender, msg.content, msg.session);
    fingerprints.set(fp.id, fp);
  }

  return fingerprints;
}
