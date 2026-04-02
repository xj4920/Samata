/**
 * 飞书 API 封装
 *
 * 参考文档：https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json
 */
import crypto from 'node:crypto';
import { Agent, ProxyAgent } from 'undici';
import { log } from '../utils/logger.js';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  proxy?: string;
}

/**
 * 飞书 Event API v2 消息事件结构
 * 对应事件类型：im.message.receive_v1
 * 文档：https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive_v1
 */
export interface FeishuMessage {
  sender: {
    sender_id: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    update_time?: string;
    chat_id: string;
    chat_type: string; // "p2p" (私聊) | "group" (群聊)
    message_type: string; // "text" | "post" | "image" | "file" | "audio" | "media" | "interactive"
    content: string; // JSON 字符串，如 '{"text":"hello"}'
    mentions?: Array<{
      key: string;
      id: { union_id?: string; user_id?: string; open_id?: string };
      name: string;
      tenant_key?: string;
    }>;
  };
}

export interface FeishuUser {
  string_id: string;
  id: string;
  name: string;
  avatar?: string;
  avatar_url?: string;
}

// 接收者类型
export type FeishuReceiveIdType = 'chat_id' | 'user_id' | 'open_id';

export class FeishuAPI {
  private config: FeishuConfig;
  private tenantAccessToken: string = '';
  private tokenExpireTime: number = 0;
  private dispatcher: Agent | ProxyAgent;

  constructor(config: FeishuConfig) {
    this.config = config;
    if (config.proxy) {
      this.dispatcher = new ProxyAgent(config.proxy);
      log.dim(`[飞书] 使用代理: ${config.proxy}`);
    } else {
      // 显式使用无代理 Agent，绕过 HTTPS_PROXY 等全局环境变量
      this.dispatcher = new Agent();
    }
  }

  /** 构造 fetch options，自动附加 dispatcher */
  private fetchOpts(init: RequestInit): RequestInit {
    (init as any).dispatcher = this.dispatcher;
    return init;
  }

  /**
   * 验证请求是否来自飞书
   */
  verifyRequest(timestamp: string, nonce: string, signature: string): boolean {
    if (!this.config.verificationToken) {
      log.warn('[飞书] 未配置 verificationToken，跳过验证');
      return true;
    }

    const str = `${timestamp}${nonce}${this.config.verificationToken}`;
    const hash = crypto.createHash('sha256').update(str).digest('hex');
    return hash === signature;
  }

  /**
   * 解密消息内容
   */
  decryptMessage(encrypt: string): string {
    if (!encrypt) return '';

    try {
      const key = Buffer.from(this.config.encryptKey + '=', 'base64');
      const encrypted = Buffer.from(encrypt, 'base64');

      // AES-256-CBC 解密
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, key);
      let decrypted = decipher.update(encrypted, undefined, 'utf8');
      decrypted += decipher.final('utf8');

      // 解析 JSON 并提取 content 字段
      const data = JSON.parse(decrypted);
      return data.content || encrypt;
    } catch (err: any) {
      log.error(`[飞书] 解密消息失败: ${err.message}`);
      return encrypt;
    }
  }

  /**
   * 获取 tenant_access_token
   * 文档：https://open.feishu.cn/document/server-docs/authentication-management/access-token
   */
  async getTenantAccessToken(): Promise<string> {
    // 检查缓存的 token 是否有效
    if (this.tenantAccessToken && Date.now() < this.tokenExpireTime - 60000) {
      return this.tenantAccessToken;
    }

    const url = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
    const body = {
      app_id: this.config.appId,
      app_secret: this.config.appSecret,
    };

    let response: Response;
    try {
      response = await fetch(url, this.fetchOpts({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
    } catch (err: any) {
      const cause = err.cause ? ` (${err.cause.message || err.cause.code || err.cause})` : '';
      throw new Error(`无法连接飞书 API: ${err.message}${cause}`);
    }

    const data = await response.json() as any;

    if (data.code !== 0) {
      throw new Error(`获取 tenant_access_token 失败: ${data.msg} (code: ${data.code})`);
    }

    this.tenantAccessToken = data.tenant_access_token;
    this.tokenExpireTime = Date.now() + (data.expire - 60) * 1000; // 提前 60 秒过期

    log.dim(`[飞书] 获取 tenant_access_token 成功`);
    return this.tenantAccessToken;
  }

  /**
   * 发送消息（默认发送到群聊）
   * 文档：https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json
   */
  async sendMessage(chatId: string, messageType: string, content: any): Promise<string> {
    return this.sendMessageTo(chatId, 'chat_id', messageType, content);
  }

  /**
   * 发送消息（支持指定接收者类型）
   * @param receiveId 接收者ID
   * @param receiveIdType 接收者类型: chat_id (群聊) | user_id | open_id
   * @param messageType 消息类型
   * @param content 消息内容
   */
  async sendMessageTo(receiveId: string, receiveIdType: FeishuReceiveIdType, messageType: string, content: any): Promise<string> {
    const token = await this.getTenantAccessToken();

    const url = 'https://open.feishu.cn/open-apis/im/v1/messages';
    const params = new URLSearchParams({
      receive_id_type: receiveIdType,
    });

    const body = {
      receive_id: receiveId,
      msg_type: messageType,
      content: typeof content === 'string' ? content : JSON.stringify(content),
    };

    let response: Response;
    try {
      response = await fetch(`${url}?${params}`, this.fetchOpts({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      }));
    } catch (err: any) {
      const cause = err.cause ? ` (${err.cause.message || err.cause.code || err.cause})` : '';
      throw new Error(`无法连接飞书 API: ${err.message}${cause}`);
    }

    const data = await response.json() as any;

    if (data.code !== 0) {
      throw new Error(`发送消息失败: ${data.msg} (code: ${data.code})`);
    }
    const msgId = data.data?.message_id || '';
    log.file(`[飞书] 消息已发送至 ${receiveIdType}: ${receiveId} (msg_id=${msgId})`);
    return msgId;
  }

  /**
   * 发送消息卡片（interactive card）
   */
  async sendCard(chatId: string, card: object): Promise<string> {
    return this.sendMessage(chatId, 'interactive', JSON.stringify(card));
  }

  /**
   * 发送文本消息
   */
  async sendText(chatId: string, text: string): Promise<string> {
    return this.sendMessage(chatId, 'text', { text });
  }

  /**
   * 更新消息卡片内容（仅支持 interactive 类型）
   * 文档：https://open.feishu.cn/document/server-docs/im-v1/message/patch
   */
  async updateCard(messageId: string, card: object): Promise<void> {
    const token = await this.getTenantAccessToken();
    const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`;
    const body = {
      msg_type: 'interactive',
      content: JSON.stringify(card),
    };
    const response = await fetch(url, this.fetchOpts({
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }));
    const data = await response.json() as any;
    if (data.code !== 0) {
      throw new Error(`更新消息失败: ${data.msg} (code: ${data.code})`);
    }
  }

  /**
   * 发送富文本消息 (post)
   * content 格式：https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message-content-description
   */
  async sendRichText(chatId: string, title: string, content: Array<{ tag: string; text?: string; href?: string }>): Promise<void> {
    const postContent = {
      zh_cn: {
        title,
        content: [
          {
            tag: 'div',
            text: content.map(c => c.text || '').join('\n'),
          },
        ],
      },
    };
    await this.sendMessage(chatId, 'post', postContent);
  }

  /**
   * 回复消息（带 @ 提醒）
   */
  async replyMessage(messageId: string, messageType: string, content: any): Promise<string> {
    const token = await this.getTenantAccessToken();

    const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`;

    const body = {
      msg_type: messageType,
      content: typeof content === 'string' ? content : JSON.stringify(content),
    };

    const response = await fetch(url, this.fetchOpts({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }));

    const data = await response.json() as any;

    if (data.code !== 0) {
      throw new Error(`回复消息失败: ${data.msg} (code: ${data.code})`);
    }

    const msgId = data.data?.message_id || '';
    log.dim(`[飞书] 已回复消息: ${messageId} (msg_id=${msgId})`);
    return msgId;
  }

  /**
   * 获取用户信息
   */
  async getUser(userId: string): Promise<FeishuUser | null> {
    const token = await this.getTenantAccessToken();

    const url = `https://open.feishu.cn/open-apis/authen/v1/users/${userId}`;

    const response = await fetch(url, this.fetchOpts({
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    }));

    const data = await response.json() as any;

    if (data.code !== 0) {
      log.error(`获取用户信息失败: ${data.msg}`);
      return null;
    }

    return data.data as FeishuUser;
  }

  /**
   * 通过手机号或邮箱获取用户ID
   * 文档：https://open.feishu.cn/document/server-docs/im-v1/contact-users/batch_get_id
   */
  async getUserIdByContact(employeeId?: string, userId?: string, unionId?: string, openId?: string): Promise<string | null> {
    const token = await this.getTenantAccessToken();

    const url = 'https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id';
    
    const body: any = {};
    if (employeeId) body.employee_ids = [employeeId];
    if (userId) body.user_ids = [userId];
    if (unionId) body.union_ids = [unionId];
    if (openId) body.open_ids = [openId];

    if (Object.keys(body).length === 0) {
      log.error('获取用户ID需要提供至少一个查询条件');
      return null;
    }

    const response = await fetch(url, this.fetchOpts({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }));

    const data = await response.json() as any;

    if (data.code !== 0) {
      log.error(`获取用户ID失败: ${data.msg}`);
      return null;
    }

    const users = data.data?.user_list || [];
    return users.length > 0 ? users[0].user_id : null;
  }

  /**
   * 下载消息中的图片/文件资源
   * 文档：https://open.feishu.cn/document/server-docs/im-v1/message-attachment/get
   */
  async downloadMessageResource(messageId: string, fileKey: string, type: 'image' | 'file' = 'image'): Promise<Buffer> {
    const token = await this.getTenantAccessToken();
    const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`;

    const response = await fetch(url, this.fetchOpts({
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    }));

    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.text();
        detail = ` body=${body.slice(0, 300)}`;
      } catch { /* ignore */ }
      throw new Error(`下载资源失败: HTTP ${response.status}${detail}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * 获取机器人自身信息（open_id 等）
   * 文档：https://open.feishu.cn/document/server-docs/application-v6/bot-v3/get
   */
  async getBotInfo(): Promise<{ open_id: string; app_name: string }> {
    const token = await this.getTenantAccessToken();
    const url = 'https://open.feishu.cn/open-apis/bot/v3/info';

    const response = await fetch(url, this.fetchOpts({
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    }));

    const data = await response.json() as any;
    if (data.code !== 0) {
      throw new Error(`获取机器人信息失败: ${data.msg} (code: ${data.code})`);
    }

    return {
      open_id: data.bot?.open_id || '',
      app_name: data.bot?.app_name || '',
    };
  }

  /**
   * 上传图片（支持 URL、Buffer 或本地路径）
   */
  async uploadImage(image: string | Buffer): Promise<string | null> {
    const token = await this.getTenantAccessToken();

    let imageBuffer: Buffer;
    let contentType = 'image/png';
    let filename = 'image.png';

    if (Buffer.isBuffer(image)) {
      imageBuffer = image;
      // 简单探测
      if (image[0] === 0xFF && image[1] === 0xD8) { contentType = 'image/jpeg'; filename = 'image.jpg'; }
      else if (image[0] === 0x47 && image[1] === 0x49 && image[2] === 0x46) { contentType = 'image/gif'; filename = 'image.gif'; }
      else if (image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4E && image[3] === 0x47) { contentType = 'image/png'; filename = 'image.png'; }
    } else if (typeof image === 'string') {
      if (image.startsWith('http://') || image.startsWith('https://')) {
        // 下载图片
        const imageResponse = await fetch(image, this.fetchOpts({}));
        imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        const typeMatch = imageResponse.headers.get('content-type');
        if (typeMatch) contentType = typeMatch;
      } else {
        // 本地文件
        const fs = await import('node:fs');
        const path = await import('node:path');
        const resolved = image.startsWith('~/')
          ? path.join(process.env.HOME || '', image.slice(1))
          : path.resolve(image);
        imageBuffer = fs.readFileSync(resolved);
        const ext = path.extname(resolved).toLowerCase();
        if (ext === '.jpg' || ext === '.jpeg') { contentType = 'image/jpeg'; filename = 'image.jpg'; }
        else if (ext === '.gif') { contentType = 'image/gif'; filename = 'image.gif'; }
        else if (ext === '.webp') { contentType = 'image/webp'; filename = 'image.webp'; }
      }
    } else {
      throw new Error('Unsupported image input');
    }

    const url = 'https://open.feishu.cn/open-apis/im/v1/images';
    const boundary = `----FeishuBoundary${Date.now()}`;
    const bodyForm = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="image_type"\r\n\r\nmessage\r\n`),
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="image"; filename="${filename}"\r\n`),
      Buffer.from(`Content-Type: ${contentType}\r\n\r\n`),
      imageBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await fetch(url, this.fetchOpts({
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Authorization': `Bearer ${token}`,
      },
      body: bodyForm,
    }));

    const data = await response.json() as any;

    if (data.code !== 0) {
      log.error(`[飞书] 上传图片失败: ${data.msg} (code: ${data.code})`);
      return null;
    }

    return data.data.image_key;
  }

  /**
   * 发送图片消息
   */
  async sendImage(chatId: string, imageKey: string): Promise<string> {
    return this.sendMessage(chatId, 'image', { image_key: imageKey });
  }

  /**
   * 回复图片消息
   */
  async replyImage(messageId: string, imageKey: string): Promise<string> {
    return this.replyMessage(messageId, 'image', { image_key: imageKey });
  }

  /**
   * 上传文件（支持 Buffer 或本地路径），最大 30MB
   * 文档：https://open.feishu.cn/document/server-docs/im-v1/file/create
   */
  async uploadFile(file: Buffer | string, fileName: string, fileType: FeishuFileType): Promise<string | null> {
    const token = await this.getTenantAccessToken();

    let fileBuffer: Buffer;
    if (Buffer.isBuffer(file)) {
      fileBuffer = file;
    } else {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const resolved = file.startsWith('~/')
        ? path.join(process.env.HOME || '', file.slice(1))
        : path.resolve(file);
      fileBuffer = fs.readFileSync(resolved);
    }

    const url = 'https://open.feishu.cn/open-apis/im/v1/files';
    const boundary = `----FeishuBoundary${Date.now()}`;
    const bodyForm = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file_type"\r\n\r\n${fileType}\r\n`),
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file_name"\r\n\r\n${fileName}\r\n`),
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`),
      Buffer.from(`Content-Type: application/octet-stream\r\n\r\n`),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await fetch(url, this.fetchOpts({
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Authorization': `Bearer ${token}`,
      },
      body: bodyForm,
    }));

    const data = await response.json() as any;

    if (data.code !== 0) {
      log.error(`[飞书] 上传文件失败: ${data.msg} (code: ${data.code})`);
      return null;
    }

    return data.data.file_key;
  }

  /**
   * 发送文件消息
   */
  async sendFile(chatId: string, fileKey: string, msgType: 'file' | 'audio' | 'media' = 'file'): Promise<string> {
    return this.sendMessage(chatId, msgType, { file_key: fileKey });
  }

  /**
   * 回复文件消息
   */
  async replyFile(messageId: string, fileKey: string, msgType: 'file' | 'audio' | 'media' = 'file'): Promise<string> {
    return this.replyMessage(messageId, msgType, { file_key: fileKey });
  }
}

// --- File type utilities ---

export type FeishuFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';

const EXT_TO_FILE_TYPE: Record<string, FeishuFileType> = {
  '.opus': 'opus', '.ogg': 'opus',
  '.mp4': 'mp4', '.mov': 'mp4', '.avi': 'mp4',
  '.pdf': 'pdf',
  '.doc': 'doc', '.docx': 'doc',
  '.xls': 'xls', '.xlsx': 'xls', '.csv': 'xls',
  '.ppt': 'ppt', '.pptx': 'ppt',
};

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff']);

export function detectFileType(fileName: string): FeishuFileType {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return EXT_TO_FILE_TYPE[ext] || 'stream';
}

export function isImageFile(fileName: string): boolean {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTS.has(ext);
}
