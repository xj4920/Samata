import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { readFileSync } from 'fs';
import { join } from 'path';

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = 'Asia/Shanghai';

// --- Trading Calendar (lazy-loaded in-memory Set) ---
let tradingDays: Set<string> | null = null;
let calendarRange: { first: string; last: string } | null = null;

function loadTradingCalendar(): Set<string> {
  if (tradingDays) return tradingDays;

  const filePath = join(process.cwd(), 'config', 'trading-calendar-sse.json');
  const raw = readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw) as { days: string[] };

  tradingDays = new Set(data.days);
  calendarRange = { first: data.days[0], last: data.days[data.days.length - 1] };
  return tradingDays;
}

export function getCalendarRange(): { first: string; last: string } {
  loadTradingCalendar();
  return calendarRange!;
}

export function isChineseTradingDay(date: string): { is_trading: boolean; reason?: string } {
  const days = loadTradingCalendar();
  const d = dayjs.tz(date, TZ);

  if (!d.isValid()) return { is_trading: false, reason: '无效日期' };

  if (d.isBefore(dayjs.tz(calendarRange!.first, TZ)) || d.isAfter(dayjs.tz(calendarRange!.last, TZ))) {
    return { is_trading: false, reason: '日期超出交易日历覆盖范围（' + calendarRange!.first + ' ~ ' + calendarRange!.last + '）' };
  }

  if (days.has(date)) return { is_trading: true };
  const weekday = d.day();
  if (weekday === 0 || weekday === 6) return { is_trading: false, reason: '周末' };
  return { is_trading: false, reason: '法定假日' };
}

export function getNextTradingDay(date: string): string {
  const days = loadTradingCalendar();
  const d = dayjs.tz(date, TZ);
  let cur = d.add(1, 'day');
  const maxIter = 30; // 最长跳 30 天（春节/国庆最多 7+天）
  for (let i = 0; i < maxIter; i++) {
    const s = cur.format('YYYY-MM-DD');
    if (days.has(s)) return s;
    cur = cur.add(1, 'day');
  }
  throw new Error(`从 ${date} 起找不到下一交易日（已搜索 30 天）`);
}

export function getPreviousTradingDay(date: string): string {
  const days = loadTradingCalendar();
  const d = dayjs.tz(date, TZ);
  let cur = d.subtract(1, 'day');
  const maxIter = 30;
  for (let i = 0; i < maxIter; i++) {
    const s = cur.format('YYYY-MM-DD');
    if (days.has(s)) return s;
    cur = cur.subtract(1, 'day');
  }
  throw new Error(`从 ${date} 起找不到上一交易日（已搜索 30 天）`);
}

export function getTradingDaysBetween(start: string, end: string): string[] {
  const days = loadTradingCalendar();
  const result: string[] = [];
  let cur = dayjs.tz(start, TZ);
  const endD = dayjs.tz(end, TZ);
  while (cur.isBefore(endD) || cur.isSame(endD, 'day')) {
    const s = cur.format('YYYY-MM-DD');
    if (days.has(s)) result.push(s);
    cur = cur.add(1, 'day');
  }
  return result;
}

// --- 4 operations ---
export type ShiftInput = {
  date: string;
  days?: number;
  months?: number;
  years?: number;
  skip_non_trading?: boolean;
};
export type DiffInput = { start_date: string; end_date: string };
export type IsTradingDayInput = { date: string };
export type NowInput = { tz?: string };

export function calculateShift(input: ShiftInput): Record<string, any> {
  const d = dayjs.tz(input.date, TZ);
  if (!d.isValid()) return { error: '无效日期: ' + input.date };

  let result = d;
  if (input.years) result = result.add(input.years, 'year');
  if (input.months) result = result.add(input.months, 'month');
  if (input.days) result = result.add(input.days, 'day');

  // dayjs add('month') 对月末的处理：2025-01-31 + 1月 → 2025-02-28（已自动修正）
  const dateStr = result.format('YYYY-MM-DD');

  if (input.skip_non_trading) {
    const check = isChineseTradingDay(dateStr);
    if (!check.is_trading) {
      try {
        // 判断方向：净偏移为负时回溯到前一交易日，否则顺延到下一交易日
        const netShift = (input.days ?? 0) + (input.months ?? 0) + (input.years ?? 0);
        const adjusted = netShift < 0 ? getPreviousTradingDay(dateStr) : getNextTradingDay(dateStr);
        const direction = netShift < 0 ? '前一' : '下一';
        return {
          date: adjusted,
          weekday: dayjs.tz(adjusted, TZ).format('dddd'),
          is_trading_day: true,
          note: `原始计算结果 ${dateStr} 为非交易日（${check.reason}），已顺延至${direction}交易日`,
        };
      } catch (e: any) {
        return { error: e.message };
      }
    }
  }

  const tradingInfo = isChineseTradingDay(dateStr);
  return {
    date: dateStr,
    weekday: dayjs.tz(dateStr, TZ).format('dddd'),
    is_trading_day: tradingInfo.is_trading,
    ...(tradingInfo.reason ? { reason: tradingInfo.reason } : {}),
  };
}

export function calculateDiff(input: DiffInput): Record<string, any> {
  const start = dayjs.tz(input.start_date, TZ);
  const end = dayjs.tz(input.end_date, TZ);
  if (!start.isValid()) return { error: '无效起始日期: ' + input.start_date };
  if (!end.isValid()) return { error: '无效结束日期: ' + input.end_date };

  const calendarDays = end.diff(start, 'day');
  const tradingDays = getTradingDaysBetween(input.start_date, input.end_date).length;

  return { calendar_days: calendarDays, trading_days: tradingDays };
}

export function calculateIsTradingDay(input: IsTradingDayInput): Record<string, any> {
  const d = dayjs.tz(input.date, TZ);
  if (!d.isValid()) return { error: '无效日期: ' + input.date };

  const check = isChineseTradingDay(input.date);
  return {
    date: input.date,
    weekday: d.format('dddd'),
    is_trading_day: check.is_trading,
    ...(check.reason ? { reason: check.reason } : {}),
  };
}

export function calculateNow(input: NowInput = {}): Record<string, any> {
  const tz = input.tz || TZ;
  const now = dayjs().tz(tz);
  const dateStr = now.format('YYYY-MM-DD');
  const tradingInfo = isChineseTradingDay(dateStr);

  return {
    datetime_iso: now.format('YYYY-MM-DDTHH:mm:ssZ'),
    date: dateStr,
    time: now.format('HH:mm:ss'),
    weekday: now.format('dddd'),
    is_trading_day: tradingInfo.is_trading,
    ...(tradingInfo.reason ? { trading_day_reason: tradingInfo.reason } : {}),
    timezone: tz,
  };
}

export function calculateDate(operation: string, params: Record<string, any>): Record<string, any> {
  switch (operation) {
    case 'shift': return calculateShift(params as ShiftInput);
    case 'diff': return calculateDiff(params as DiffInput);
    case 'is_trading_day': return calculateIsTradingDay(params as IsTradingDayInput);
    case 'now': return calculateNow(params as NowInput);
    default: return { error: `未知操作: ${operation}，支持 shift / diff / is_trading_day / now` };
  }
}

// --- buildDateTimeBlock for system prompt ---
export function buildDateTimeBlock(): string {
  const now = dayjs().tz(TZ);
  const dateStr = now.format('YYYY-MM-DD');
  const weekdayZh: Record<number, string> = {
    0: '星期日', 1: '星期一', 2: '星期二', 3: '星期三', 4: '星期四', 5: '星期五', 6: '星期六',
  };
  const wd = weekdayZh[now.day()];
  const check = isChineseTradingDay(dateStr);

  let status: string;
  if (check.is_trading) status = 'A股交易日';
  else if (check.reason === '周末') status = '周末';
  else if (check.reason === '法定假日') status = '法定假日';
  else status = check.reason ?? '非交易日';

  return `📅 今天：${dateStr} ${wd}（${status}）`;
}