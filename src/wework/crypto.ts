/**
 * 企业微信消息加解密
 *
 * 企微使用 AES-256-CBC 加密，PKCS7 padding，Base64 编码
 * 参考：https://developer.work.weixin.qq.com/document/path/96238
 *
 * 消息体格式（解密后）：
 *   [4字节随机数][4字节消息长度(大端)][消息内容][CorpID]
 */
import crypto from 'node:crypto';

/**
 * 企微 AES Key 解码（Base64 → 32字节 key + 16字节 iv）
 * 企微的 AES Key 是 43 位 Base64，解码后 32 字节，iv 取前 16 字节
 */
function decodeAesKey(aesKeyBase64: string): { key: Buffer; iv: Buffer } {
  const key = Buffer.from(aesKeyBase64 + '=', 'base64');
  const iv = key.subarray(0, 16);
  return { key, iv };
}

/**
 * PKCS7 去除 padding
 */
function pkcs7Unpad(buf: Buffer): Buffer {
  const padLen = buf[buf.length - 1];
  return buf.subarray(0, buf.length - padLen);
}

/**
 * PKCS7 添加 padding（block size = 32）
 */
function pkcs7Pad(buf: Buffer, blockSize = 32): Buffer {
  const padLen = blockSize - (buf.length % blockSize);
  const padBuf = Buffer.alloc(padLen, padLen);
  return Buffer.concat([buf, padBuf]);
}

/**
 * 解密企微消息
 * @param encrypted Base64 编码的密文
 * @param aesKey 43位 Base64 AES Key
 * @returns { message: string; corpId: string }
 */
export function decryptMessage(encrypted: string, aesKey: string): { message: string; corpId: string } {
  const { key, iv } = decodeAesKey(aesKey);
  const cipherBuf = Buffer.from(encrypted, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
  const unpadded = pkcs7Unpad(decrypted);

  // 跳过前 16 字节随机数
  const msgLen = unpadded.readUInt32BE(16);
  const message = unpadded.subarray(20, 20 + msgLen).toString('utf-8');
  const corpId = unpadded.subarray(20 + msgLen).toString('utf-8');

  return { message, corpId };
}

/**
 * 加密消息（用于被动回复）
 * @param message 明文消息
 * @param corpId 企业 ID
 * @param aesKey 43位 Base64 AES Key
 * @returns Base64 编码的密文
 */
export function encryptMessage(message: string, corpId: string, aesKey: string): string {
  const { key, iv } = decodeAesKey(aesKey);

  const random = crypto.randomBytes(16);
  const msgBuf = Buffer.from(message, 'utf-8');
  const corpBuf = Buffer.from(corpId, 'utf-8');

  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);

  const plain = Buffer.concat([random, lenBuf, msgBuf, corpBuf]);
  const padded = pkcs7Pad(plain);

  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);

  return encrypted.toString('base64');
}

/**
 * 验证企微回调签名
 * 签名算法：SHA1(sort([token, timestamp, nonce, encrypted_msg]))
 */
export function verifySignature(
  token: string,
  timestamp: string,
  nonce: string,
  encryptedMsg: string,
  signature: string,
): boolean {
  const parts = [token, timestamp, nonce, encryptedMsg].sort();
  const str = parts.join('');
  const computed = crypto.createHash('sha1').update(str).digest('hex');
  return computed === signature;
}

/**
 * 生成回调签名（用于被动回复）
 */
export function generateSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encryptedMsg: string,
): string {
  const parts = [token, timestamp, nonce, encryptedMsg].sort();
  const str = parts.join('');
  return crypto.createHash('sha1').update(str).digest('hex');
}
