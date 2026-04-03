/**
 * Telegram API 封装 — 纯 HTTP 长轮询
 * 使用 node 内置 fetch (undici)，支持 HTTP 代理
 */
import fs from 'node:fs';
import path from 'node:path';
import { ProxyAgent } from 'undici';
import { log } from '../utils/logger.js';

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export class TelegramAPI {
  private baseUrl: string;
  private offset = 0;
  private dispatcher?: ProxyAgent;

  constructor(private token: string, proxy?: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    if (proxy) {
      this.dispatcher = new ProxyAgent(proxy);
      log.dim(`[TG] 使用代理: ${proxy}`);
    }
  }

  private async request(method: string, body?: Record<string, any>): Promise<any> {
    const url = `${this.baseUrl}/${method}`;
    const opts: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    };
    if (this.dispatcher) {
      (opts as any).dispatcher = this.dispatcher;
    }
    const res = await fetch(url, opts);
    const data = await res.json() as any;
    if (!data.ok) {
      throw new Error(`Telegram API error [${method}]: ${data.description ?? JSON.stringify(data)}`);
    }
    return data.result;
  }

  async getMe(): Promise<TgUser> {
    return this.request('getMe');
  }

  /**
   * 发送文本消息，自动按 4096 字符分片
   */
  async sendMessage(chatId: number, text: string, parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML'): Promise<TgMessage[]> {
    const MAX_LEN = 4096;
    const messages: TgMessage[] = [];

    // 按行分片，尽量不拆断
    const chunks: string[] = [];
    if (text.length <= MAX_LEN) {
      chunks.push(text);
    } else {
      let remaining = text;
      while (remaining.length > 0) {
        if (remaining.length <= MAX_LEN) {
          chunks.push(remaining);
          break;
        }
        // 找最后一个换行符进行分割
        let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
        if (splitAt <= 0 || splitAt < MAX_LEN * 0.3) {
          splitAt = MAX_LEN;
        }
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).replace(/^\n/, '');
      }
    }

    for (const chunk of chunks) {
      const params: Record<string, any> = { chat_id: chatId, text: chunk };
      if (parseMode) params.parse_mode = parseMode;
      const msg = await this.request('sendMessage', params);
      messages.push(msg);
    }
    return messages;
  }

  /**
   * 发送「正在输入」状态
   */
  async sendChatAction(chatId: number, action = 'typing'): Promise<void> {
    await this.request('sendChatAction', { chat_id: chatId, action });
  }

  /**
   * 长轮询获取更新
   */
  async getUpdates(timeout = 30): Promise<TgUpdate[]> {
    const updates: TgUpdate[] = await this.request('getUpdates', {
      offset: this.offset,
      timeout,
      allowed_updates: ['message'],
    });
    if (updates.length > 0) {
      this.offset = updates[updates.length - 1].update_id + 1;
    }
    return updates;
  }

  /**
   * 设置 bot 命令菜单
   */
  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    await this.request('setMyCommands', { commands });
  }

  private async requestMultipart(
    method: string,
    fields: Record<string, string>,
    fileField: string,
    file: Buffer | string,
    fallbackFileName: string,
  ): Promise<any> {
    const boundary = `----TelegramBoundary${Date.now()}`;
    const chunks: Buffer[] = [];

    for (const [key, value] of Object.entries(fields)) {
      chunks.push(Buffer.from(`--${boundary}\r\n`));
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
    }

    const fileBuffer = Buffer.isBuffer(file) ? file : fs.readFileSync(file);
    const fileName = Buffer.isBuffer(file) ? fallbackFileName : path.basename(file);

    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\n`));
    chunks.push(Buffer.from('Content-Type: application/octet-stream\r\n\r\n'));
    chunks.push(fileBuffer);
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const url = `${this.baseUrl}/${method}`;
    const opts: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat(chunks),
    };
    if (this.dispatcher) {
      (opts as any).dispatcher = this.dispatcher;
    }
    const res = await fetch(url, opts);
    const data = await res.json() as any;
    if (!data.ok) {
      throw new Error(`Telegram API error [${method}]: ${data.description ?? JSON.stringify(data)}`);
    }
    return data.result;
  }

  async sendDocument(chatId: number, file: Buffer | string, filename = 'document.bin'): Promise<TgMessage> {
    return this.requestMultipart('sendDocument', { chat_id: String(chatId) }, 'document', file, filename);
  }

  async sendPhoto(chatId: number, file: Buffer | string, filename = 'photo.png'): Promise<TgMessage> {
    return this.requestMultipart('sendPhoto', { chat_id: String(chatId) }, 'photo', file, filename);
  }
}
