import { describe, it, expect } from 'vitest';
import { useUnitDb } from '../../helpers/unit-harness.js';

describe('date tools', () => {
  useUnitDb();

  describe('calculateDate operations', () => {
    it('now: returns current date info', async () => {
      const { calculateDate } = await import('../../../src/commands/date.js');
      const result = calculateDate('now', {});
      expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(result).toHaveProperty('is_trading_day');
      expect(result).toHaveProperty('weekday');
      expect(result).toHaveProperty('timezone');
    });

    it('is_trading_day: weekday detection', async () => {
      const { calculateDate } = await import('../../../src/commands/date.js');
      const monday = calculateDate('is_trading_day', { date: '2026-05-18' });
      expect(monday.is_trading_day).toBe(true);

      const saturday = calculateDate('is_trading_day', { date: '2026-05-16' });
      expect(saturday.is_trading_day).toBe(false);
    });

    it('shift: adds days correctly', async () => {
      const { calculateDate } = await import('../../../src/commands/date.js');
      const result = calculateDate('shift', { date: '2026-05-20', days: 3 });
      expect(result.date).toBe('2026-05-23');
    });

    it('shift with skip_non_trading: skips weekends', async () => {
      const { calculateDate } = await import('../../../src/commands/date.js');
      const result = calculateDate('shift', { date: '2026-05-22', days: 1, skip_non_trading: true });
      expect(result.is_trading_day).toBe(true);
    });

    it('diff: calculates trading days between dates', async () => {
      const { calculateDate } = await import('../../../src/commands/date.js');
      const result = calculateDate('diff', { start_date: '2026-05-18', end_date: '2026-05-22' });
      expect(result.calendar_days).toBe(4);
      expect(result).toHaveProperty('trading_days');
    });

    it('unknown operation returns error', async () => {
      const { calculateDate } = await import('../../../src/commands/date.js');
      const result = calculateDate('unknown_op', {});
      expect(result).toHaveProperty('error');
    });
  });

  describe('tool handler', () => {
    it('calculate_date via handleTool', async () => {
      const dateTools = await import('../../../src/tools/date-tools.js');
      const result = await dateTools.handleTool('calculate_date', { operation: 'now' });
      expect(result).toBeTruthy();
      const parsed = JSON.parse(result!);
      expect(parsed).toHaveProperty('date');
    });

    it('non-matching name returns null', async () => {
      const dateTools = await import('../../../src/tools/date-tools.js');
      const result = await dateTools.handleTool('not_a_date_tool', { operation: 'now' });
      expect(result).toBeNull();
    });
  });

  describe('helper functions', () => {
    it('getCalendarRange returns valid range', async () => {
      const { getCalendarRange } = await import('../../../src/commands/date.js');
      const range = getCalendarRange();
      expect(range.first).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(range.last).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(range.first < range.last).toBe(true);
    });

    it('getNextTradingDay from Friday returns Monday', async () => {
      const { getNextTradingDay } = await import('../../../src/commands/date.js');
      const result = getNextTradingDay('2026-05-22');
      expect(result).toBe('2026-05-25');
    });

    it('getPreviousTradingDay from Monday returns Friday', async () => {
      const { getPreviousTradingDay } = await import('../../../src/commands/date.js');
      const result = getPreviousTradingDay('2026-05-25');
      expect(result).toBe('2026-05-22');
    });
  });
});
