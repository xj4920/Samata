import type { PluginModule, PluginContext } from '@samata/plugin-sdk';
import { toolDefinitions } from './src/tools.js';
import { fetchHedgeShort } from './src/commands.js';
import { startHedgeRatioMonitor, stopHedgeRatioMonitor, setSendMessage } from './src/monitor.js';

const plugin: PluginModule = {
  name: 'hedge-ratio',
  description: '对冲比查询与监控：查询QFII对冲账户数据，定时推送套保比例提醒',
  scope: 'agent-bound',
  toolDefinitions,

  async init(_ctx: PluginContext) {
    // No DB needed; InfluxDB connection via env vars
  },

  async start(ctx: PluginContext) {
    if (ctx.sendNotification) {
      setSendMessage(async (chatId, msg) => {
        await ctx.sendNotification!('wework', chatId, msg.markdown.content);
      });
    }
    startHedgeRatioMonitor();
  },

  async stop() {
    stopHedgeRatioMonitor();
  },

  async handleTool(name: string, input: any, _ctx: PluginContext) {
    switch (name) {
      case 'query_hedge_short': {
        try {
          const rows = await fetchHedgeShort({
            date: input.date,
            productName: input.product_name,
            limit: input.limit,
          });
          if (rows.length === 0) return JSON.stringify({ message: '未查询到对冲账户数据' });
          return JSON.stringify(rows);
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
