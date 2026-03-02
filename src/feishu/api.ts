/**
 * 飞书 API 封装
 *
 * 参考文档：https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json
 */
import crypto from 'node:crypto';
import { log } from '../utils/logger.js';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
}

export interface FeishuMessage {
  header: {
    message_id: string;
    patch_id?: string;
    create_time: string;
    update_time: string;
    chat_id: string;
    chat_type: 'group' | 'private';
    message_type: 'text' | 'post' | 'image' | 'file' | 'audio' | 'media' | 'interactive';
    root_id?: string;
    parent_id?: string;
  };
  event: {
    type: 'message' | 'message_updated' | 'message_deleted' | 'added_to_chat' | 'removed_from_chat';
    message_type: string;
    sender_id: {
      string_id: string;
      id: string;
      name?: string;
      avatar?: string;
    };
    sender_id_type?: string;
    body?: {
      content: string;
    };
  };
}

export interface FeishuUser {
  string_id: string;
  id: string;
  name: string;
  avatar?: string;
  avatar_url?: string;
}

export class FeishuAPI {
  private config: FeishuConfig;
  private tenantAccessToken: string = '';
  private tokenExpireTime: number = 0;

  constructor(config: FeishuConfig) {
    this.config = config;
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

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

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
   * 发送消息
   * 文档：https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json
   */
  async sendMessage(chatId: string, messageType: string, content: any): Promise<void> {
    const token = await this.getTenantAccessToken();

    const url = 'https://open.feishu.cn/open-apis/im/v1/messages';
    const params = new URLSearchParams({
      receive_id_type: 'chat_id',
    });

    const body = {
      receive_id: chatId,
      msg_type: messageType,
      content: typeof content === 'string' ? content : JSON.stringify(content),
    };

    const response = await fetch(`${url}?${params}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json() as any;

    if (data.code !== 0) {
      throw new Error(`发送消息失败: ${data.msg} (code: ${data.code})`);
    }

    log.dim(`[飞书] 消息已发送至 chat_id: ${chatId}`);
  }

  /**
   * 发送文本消息
   */
  async sendText(chatId: string, text: string): Promise<void> {
    await this.sendMessage(chatId, 'text', { text });
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
  async replyMessage(rootId: string, messageType: string, content: any): Promise<void> {
    const token = await this.getTenantAccessToken();

    const url = 'https://open.feishu.cn/open-apis/im/v1/messages';
    const params = new URLSearchParams({
      receive_id_type: 'chat_id',
    });

    const body = {
      msg_type: messageType,
      content: typeof content === 'string' ? content : JSON.stringify(content),
      reply_id: rootId,
    };

    const response = await fetch(`${url}?${params}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json() as any;

    if (data.code !== 0) {
      throw new Error(`回复消息失败: ${data.msg} (code: ${data.code})`);
    }

    log.dim(`[飞书] 已回复消息: ${rootId}`);
  }

  /**
   * 获取用户信息
   */
  async getUser(userId: string): Promise<FeishuUser | null> {
    const token = await this.getTenantAccessToken();

    const url = `https://open.feishu.cn/open-apis/authen/v1/users/${userId}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const data = await response.json() as any;

    if (data.code !== 0) {
      log.error(`获取用户信息失败: ${data.msg}`);
      return null;
    }

    return data.data as FeishuUser;
  }

  /**
   * 上传图片
   */
  async uploadImage(imageUrl: string): Promise<string | null> {
    const token = await this.getTenantAccessToken();

    // 下载图片
    const imageResponse = await fetch(imageUrl);
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

    const url = 'https://open.feishu.cn/open-apis/im/v1/images';

    const boundary = `----FeishuBoundary${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from('Content-Disposition: form-data; name="image"; filename="image.png"\r\n'),
      Buffer.from('Content-Type: image/png\r\n\r\n'),
      imageBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Authorization': `Bearer ${token}`,
      },
      body,
    });

    const data = await response.json() as any;

    if (data.code !== 0) {
      log.error(`上传图片失败: ${data.msg}`);
      return null;
    }

    return data.data.image_key;
  }
}
