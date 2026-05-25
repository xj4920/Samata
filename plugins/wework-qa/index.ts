import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PluginModule, PluginContext } from '@samata-platform/plugin-sdk';
import { toolDefinitions } from './src/tools.js';
import { extractWeworkQA, setCallLLM } from './src/commands.js';
import { startWeworkMonitor, stopWeworkMonitor, setSendTelegram, setSendFeishu } from './src/monitor.js';

const plugin: PluginModule = {
  name: 'wework-qa',
  description: '企微 QA 提取与消息监控：从聊天记录提取知识问答对，监听关键消息并推送通知',
  scope: 'agent-bound',
  toolDefinitions,

  async init(ctx: PluginContext) {
    if (ctx.callLLM) {
      setCallLLM(ctx.callLLM);
    } else {
      console.warn('[wework-qa] callLLM not available — extract_wework_qa will fail');
    }
  },

  async start(ctx: PluginContext) {
    try {
      const configPath = resolve(process.cwd(), 'config/monitor.json');
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      const channels: string[] = cfg.notification?.channels || ['telegram'];

      if (channels.includes('telegram') && cfg.telegram?.botToken && cfg.telegram?.chatId) {
        const { ProxyAgent } = await import('undici');
        const { botToken, chatId, proxy } = cfg.telegram;
        setSendTelegram(async (text: string) => {
          const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
          const opts: RequestInit = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
          };
          if (proxy) (opts as any).dispatcher = new ProxyAgent(proxy);
          const resp = await fetch(url, opts);
          if (!resp.ok) {
            const body = await resp.text();
            console.error(`[wework-monitor] Telegram send failed (${resp.status}): ${body}`);
          }
        });
      }

      if (channels.includes('feishu') && ctx.sendNotification) {
        setSendFeishu(async (text, receiveId, _receiveIdType) => {
          await ctx.sendNotification!('feishu', receiveId, text);
        });
      }
    } catch {
      // Config not available — monitor will skip
    }

    startWeworkMonitor();
  },

  async stop() {
    stopWeworkMonitor();
  },

  async handleTool(name: string, input: any, _ctx: PluginContext) {
    switch (name) {
      case 'extract_wework_qa': {
        try {
          const qaPairs = await extractWeworkQA({
            topics: input.topics,
            people: input.people,
            startDate: input.start_date,
            endDate: input.end_date,
            session: input.session,
            limit: input.limit,
          });
          if (qaPairs.length === 0) {
            return JSON.stringify({ message: '未提取到有价值的 Q&A 对' });
          }
          return JSON.stringify(qaPairs);
        } catch (err: any) {
          return JSON.stringify({ error: err.message });
        }
      }
      default:
        return null;
    }
  },
};

export default plugin;
