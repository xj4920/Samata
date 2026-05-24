import type { PluginModule, PluginContext } from '@samata/plugin-sdk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { toolDefinitions } from './src/tools.js';
import { setConfigDir, loadCustomers } from './src/customers.js';
import { fetchTrades, fetchTradeSummary, fetchNorthInfo, type NorthInfoRow } from './src/commands.js';
import { plotTrades } from './src/plot.js';

const ARTIFACT_DIR = path.join(os.tmpdir(), 'samata');

function escapeCsvField(v: any): string {
  const s = v == null ? '' : String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

const NORTH_INFO_COLUMNS: (keyof NorthInfoRow)[] = [
  'trade_dt',
  'counter_party_short_name',
  'notional_ft_t',
  'notional_ft_short_t',
  'trade_amt_ft',
  'trade_amt_ft_short',
  'ft_net',
  'ft_net_short',
  'is_ft',
  'update_time',
];

const plugin: PluginModule = {
  name: 'trade-query',
  description: '交易查询：查询成交记录、日报汇总、绘图、导出CSV',
  scope: 'agent-bound',
  toolDefinitions,

  async init(ctx: PluginContext) {
    const dataDir = ctx.getDataDir();
    const projectRoot = dataDir.replace(/\/data\/plugins\/trade-query$/, '');
    setConfigDir(path.join(projectRoot, 'config'));
  },

  async handleTool(name: string, input: any, ctx: PluginContext) {
    switch (name) {
      case 'query_trades': {
        try {
          const rows = await fetchTrades(input);
          if (rows.length === 0) return JSON.stringify({ message: '未查询到交易数据' });
          return JSON.stringify(rows);
        } catch (err: any) {
          return JSON.stringify({ error: err.message });
        }
      }

      case 'trade_summary': {
        try {
          const result = await fetchTradeSummary(input.date);
          return JSON.stringify(result);
        } catch (err: any) {
          return JSON.stringify({ error: err.message });
        }
      }

      case 'plot_trades': {
        try {
          const filePath = await plotTrades(input);
          return JSON.stringify({ success: true, message: '图表已在浏览器中打开', path: filePath });
        } catch (err: any) {
          return JSON.stringify({ error: err.message });
        }
      }

      case 'list_customers': {
        const customers = loadCustomers();
        return JSON.stringify(customers.map(c => ({
          name: c.name,
          sales: c.sales,
          products: c.products.map((p: any) => p.counter_party),
        })));
      }

      case 'export_trades_csv': {
        try {
          const rows = await fetchTrades({ ...input, limit: 10000 });
          if (rows.length === 0) return JSON.stringify({ message: '未查询到交易数据' });

          const cols = input.columns?.length ? input.columns : ['date', 'client', 'counter_party', 'user_id', 'notional_t', 'trade_amt_ft', 'ft_net'];
          const lines = [cols.map(escapeCsvField).join(',')];
          for (const row of rows) {
            lines.push(cols.map((c: string) => escapeCsvField((row as any)[c])).join(','));
          }
          const content = lines.join('\n') + '\n';

          fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
          const filename = path.basename(input.filename || `trades_${input.client || 'all'}_${new Date().toISOString().slice(0, 10)}.csv`);
          const filePath = path.join(ARTIFACT_DIR, filename);
          fs.writeFileSync(filePath, content, 'utf-8');

          return JSON.stringify({
            success: true,
            path: filePath,
            filename,
            rows: rows.length,
            columns: cols,
            bytes: Buffer.byteLength(content, 'utf-8'),
          });
        } catch (err: any) {
          return JSON.stringify({ error: err.message });
        }
      }

      case 'export_north_info_csv': {
        try {
          const { rows, tradeDate } = await fetchNorthInfo({
            date_from: input.date_from,
            date_to: input.date_to,
          });
          if (rows.length === 0) return JSON.stringify({ message: '未查询到 north_info 数据' });

          const lines = [NORTH_INFO_COLUMNS.map(escapeCsvField).join(',')];
          for (const row of rows) {
            lines.push(NORTH_INFO_COLUMNS.map(c => escapeCsvField(row[c])).join(','));
          }
          const content = lines.join('\n') + '\n';

          fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
          const safeDate = tradeDate.replace(/[^\d~-]/g, '') || new Date().toISOString().slice(0, 10);
          const filename = path.basename(input.filename || `north_info_${safeDate}.csv`);
          const filePath = path.join(ARTIFACT_DIR, filename);
          fs.writeFileSync(filePath, content, 'utf-8');

          return JSON.stringify({
            success: true,
            path: filePath,
            filename,
            rows: rows.length,
            columns: NORTH_INFO_COLUMNS,
            tradeDate,
            bytes: Buffer.byteLength(content, 'utf-8'),
          });
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
