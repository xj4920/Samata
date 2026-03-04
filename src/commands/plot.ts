import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fetchTrades, type TradeRow } from './trade.js';
import { log } from '../utils/logger.js';

interface ChartDataset {
  label: string;
  dates: string[];
  values: number[];
}

function groupByParty(rows: TradeRow[], field: keyof TradeRow): ChartDataset[] {
  const map = new Map<string, { dates: string[]; values: number[] }>();

  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  for (const r of sorted) {
    const party = r.counter_party;
    if (!map.has(party)) map.set(party, { dates: [], values: [] });
    const entry = map.get(party)!;
    entry.dates.push(r.date);
    entry.values.push(Number(r[field]) || 0);
  }

  return Array.from(map.entries()).map(([label, data]) => ({
    label,
    dates: data.dates,
    values: data.values,
  }));
}

function fmtYi(val: number): number {
  return Math.round(val / 1e6) / 100; // 转亿，保留2位
}

function buildHtml(title: string, rows: TradeRow[]): string {
  const notionalSeries = groupByParty(rows, 'notional_t');
  const tradeSeries = groupByParty(rows, 'trade_amt_ft');
  const netSeries = groupByParty(rows, 'ft_net');

  const toEcharts = (datasets: ChartDataset[], name: string) => ({
    title: { text: name, left: 'center', textStyle: { fontSize: 14 } },
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0 },
    grid: { left: 80, right: 30, top: 40, bottom: 40 },
    xAxis: { type: 'category', data: datasets[0]?.dates ?? [] },
    yAxis: { type: 'value', name: '亿元', axisLabel: { formatter: '{value}' } },
    series: datasets.map(ds => ({
      name: ds.label,
      type: 'line',
      data: ds.values.map(fmtYi),
      smooth: true,
      symbol: 'circle',
      symbolSize: 5,
    })),
  });

  const charts = [
    toEcharts(notionalSeries, '存续名义本金'),
    toEcharts(tradeSeries, '成交金额'),
    toEcharts(netSeries, '净交易头寸'),
  ];

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>${title}</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
<style>
  body { margin: 0; padding: 20px; background: #f5f5f5; font-family: -apple-system, sans-serif; }
  h1 { text-align: center; color: #333; margin-bottom: 20px; }
  .chart { width: 100%; height: 350px; background: #fff; border-radius: 8px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
</style>
</head><body>
<h1>${title}</h1>
<div id="c0" class="chart"></div>
<div id="c1" class="chart"></div>
<div id="c2" class="chart"></div>
<script>
const options = ${JSON.stringify(charts)};
options.forEach((opt, i) => {
  const chart = echarts.init(document.getElementById('c' + i));
  chart.setOption(opt);
  window.addEventListener('resize', () => chart.resize());
});
</script>
</body></html>`;
}

export async function plotTrades(params: {
  client?: string;
  party?: string;
  limit?: number;
}): Promise<string> {
  const rows = await fetchTrades({
    client: params.client,
    party: params.party,
    limit: params.limit ?? 200,
  });

  if (rows.length === 0) throw new Error('未查询到交易数据');

  const filtered = rows.filter(r => (r.trade_amt_ft ?? 0) !== 0);
  if (filtered.length === 0) throw new Error('过滤成交金额为0后无数据');

  const label = params.client ?? params.party ?? 'all';
  const title = `${label} 交易曲线`;
  const html = buildHtml(title, filtered);

  const filePath = path.join(tmpdir(), `otcclaw-plot-${label}-${Date.now()}.html`);
  writeFileSync(filePath, html, 'utf-8');
  execSync(`open "${filePath}"`);

  return filePath;
}

function parseArgs(args: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /(\w+)=(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    params[m[1].toLowerCase()] = m[2];
  }
  return params;
}

export async function handlePlot(args: string): Promise<void> {
  const params = parseArgs(args);

  if (!params.client && !params.party) {
    log.print('用法: /plot client=Jump [limit=200]');
    log.print('      /plot party=JUMPZL01 [limit=200]');
    return;
  }

  try {
    const filePath = await plotTrades({
      client: params.client,
      party: params.party,
      limit: params.limit ? Number(params.limit) : undefined,
    });
    log.success(`图表已在浏览器中打开: ${filePath}`);
  } catch (err: any) {
    log.print(err.message);
  }
}
