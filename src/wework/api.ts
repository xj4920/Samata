/**
 * 企业微信 API 封装
 *
 * 处理：
 * 1. 回调消息解析（XML + AES 解密）
 * 2. URL 验证（echostr 挑战）
 * 3. 被动回复（XML 加密响应）
 * 4. 主动发送消息（需要 agentSecret）
 *
 * 参考文档：https://developer.work.weixin.qq.com/document/path/96238
 */
import crypto from 'node:crypto';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { decryptMessage, encryptMessage, verifySignature, generateSignature } from './crypto.js';
import { log } from '../utils/logger.js';

export interface WeworkConfig {
  token: string;
  aesKey: string;
  corpId?: string;
  agentId?: string;
  agentSecret?: string;
  encryptEnabled?: boolean;  // 是否启用加密，默认 false
}

export interface WeworkMessage {
  toUserName: string;   // 企业 CorpID
  fromUserName: string; // 发送者 UserID
  createTime: number;
  msgType: string;      // text | image | voice | video | location | link | event
  content?: string;     // 文本消息内容
  msgId?: string;
  agentId?: string;
  event?: string;       // 事件类型（msgType=event 时）
  eventKey?: string;
}

const xmlParser = new XMLParser({ ignoreAttributes: false });
const xmlBuilder = new XMLBuilder({ ignoreAttributes: false });

export class WeworkAPI {
  private config: WeworkConfig;
  private accessToken = '';
  private tokenExpireTime = 0;

  constructor(config: WeworkConfig) {
    this.config = config;
  }

  /**
   * 解析并验证企微回调请求
   * @param query URL 查询参数 { msg_signature, timestamp, nonce, echostr? }
   * @param body 请求体（加密模式为 XML，明文模式为 JSON 或 XML）
   */
  parseCallback(query: Record<string, string>, body: string): WeworkMessage {
    const { msg_signature, timestamp, nonce } = query;

    // 明文模式：直接解析 XML 或 JSON
    if (!this.config.encryptEnabled) {
      try {
        // 尝试 JSON 格式
        const json = JSON.parse(body);
        return {
          toUserName: json.ToUserName || '',
          fromUserName: json.FromUserName || '',
          createTime: Number(json.CreateTime) || 0,
          msgType: (json.MsgType || '').toLowerCase(),
          content: json.Content || json.Recognition || '',
          msgId: String(json.MsgId || ''),
          agentId: String(json.AgentID || ''),
          event: json.Event || '',
          eventKey: json.EventKey || '',
        };
      } catch {
        // 尝试 XML 格式
        const parsed = xmlParser.parse(body);
        const xml = parsed.xml || parsed;
        return {
          toUserName: xml.ToUserName || '',
          fromUserName: xml.FromUserName || '',
          createTime: Number(xml.CreateTime) || 0,
          msgType: (xml.MsgType || '').toLowerCase(),
          content: xml.Content || xml.Recognition || '',
          msgId: String(xml.MsgId || ''),
          agentId: String(xml.AgentID || ''),
          event: xml.Event || '',
          eventKey: xml.EventKey || '',
        };
      }
    }

    // 加密模式：解析 XML 获取加密消息
    const parsed = xmlParser.parse(body);
    const xml = parsed.xml || parsed;
    const encrypted = xml.Encrypt as string;

    if (!encrypted) {
      throw new Error('回调消息缺少 Encrypt 字段');
    }

    // 验证签名
    if (msg_signature) {
      const valid = verifySignature(this.config.token, timestamp, nonce, encrypted, msg_signature);
      if (!valid) {
        throw new Error('企微回调签名验证失败');
      }
    }

    // 解密消息
    const { message } = decryptMessage(encrypted, this.config.aesKey);

    // 解析解密后的 XML
    const innerParsed = xmlParser.parse(message);
    const inner = innerParsed.xml || innerParsed;

    return {
      toUserName: inner.ToUserName || '',
      fromUserName: inner.FromUserName || '',
      createTime: Number(inner.CreateTime) || 0,
      msgType: (inner.MsgType || '').toLowerCase(),
      content: inner.Content || inner.Recognition || '',
      msgId: String(inner.MsgId || ''),
      agentId: String(inner.AgentID || ''),
      event: inner.Event || '',
      eventKey: inner.EventKey || '',
    };
  }

  /**
   * 处理 URL 验证挑战（GET 请求）
   * 加密模式：解密 echostr 并返回明文
   * 明文模式：直接返回 echostr
   */
  replyEchostr(echostr: string, query: Record<string, string>): string {
    // 明文模式：直接返回
    if (!this.config.encryptEnabled) {
      return echostr;
    }

    // 加密模式：验证签名并解密
    const { msg_signature, timestamp, nonce } = query;

    if (msg_signature) {
      const valid = verifySignature(this.config.token, timestamp, nonce, echostr, msg_signature);
      if (!valid) {
        throw new Error('URL 验证签名失败');
      }
    }

    const { message } = decryptMessage(echostr, this.config.aesKey);
    return message;
  }

  /**
   * 构建被动回复 XML
   * 加密模式：返回加密 XML
   * 明文模式：返回明文 XML
   */
  buildReply(toUser: string, fromUser: string, content: string): string {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const corpId = this.config.corpId || fromUser;

    const innerXml = `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${timestamp}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
</xml>`;

    // 明文模式：直接返回
    if (!this.config.encryptEnabled) {
      return innerXml;
    }

    // 加密模式：加密并签名
    const nonce = crypto.randomBytes(8).toString('hex');
    const encrypted = encryptMessage(innerXml, corpId, this.config.aesKey);
    const signature = generateSignature(this.config.token, timestamp, nonce, encrypted);

    return `<xml>
<Encrypt><![CDATA[${encrypted}]]></Encrypt>
<MsgSignature><![CDATA[${signature}]]></MsgSignature>
<TimeStamp>${timestamp}</TimeStamp>
<Nonce><![CDATA[${nonce}]]></Nonce>
</xml>`;
  }

  /**
   * 主动发送文本消息（需要 agentSecret）
   */
  async sendTextMessage(userId: string, content: string): Promise<void> {
    if (!this.config.agentSecret || !this.config.agentId) {
      log.warn('[企微] 未配置 agentSecret/agentId，跳过主动发送');
      return;
    }

    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

    const payload = {
      touser: userId,
      msgtype: 'text',
      agentid: this.config.agentId,
      text: { content },
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await resp.json() as { errcode: number; errmsg: string };
    if (data.errcode !== 0) {
      throw new Error(`企微发送消息失败: ${data.errmsg} (${data.errcode})`);
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpireTime) {
      return this.accessToken;
    }

    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.config.corpId}&corpsecret=${this.config.agentSecret}`;
    const resp = await fetch(url);
    const data = await resp.json() as { access_token: string; expires_in: number; errcode?: number; errmsg?: string };

    if (data.errcode && data.errcode !== 0) {
      throw new Error(`获取企微 access_token 失败: ${data.errmsg}`);
    }

    this.accessToken = data.access_token;
    this.tokenExpireTime = Date.now() + (data.expires_in - 60) * 1000;
    return this.accessToken;
  }
}
