import type { PluginModule, PluginContext } from '@samata-platform/plugin-sdk';
import { toolDefinitions } from './src/tools.js';
import { getHealthDb, closeHealthDb } from './src/db.js';
import { addHealthRecord, queryHealthRecords, getHealthSummary } from './src/commands.js';
import type Database from 'better-sqlite3';

let db: Database.Database | null = null;

const plugin: PluginModule = {
  name: 'health-tracker',
  description: '健康管理：记录血压/血糖/体重等指标、睡眠、饮食、症状，设置用药提醒',
  scope: 'agent-bound',
  toolDefinitions,

  async init(ctx: PluginContext) {
    db = getHealthDb(ctx.getDataDir());
  },

  async stop() {
    closeHealthDb();
    db = null;
  },

  async handleTool(name: string, input: any, ctx: PluginContext) {
    if (!db) return null;

    const user = ctx.getCurrentUser();
    const agentId = ctx.getAgentId() || 'doctor';
    const userId = user.id;

    switch (name) {
      case 'add_health_record': {
        const result = addHealthRecord(db, userId, agentId, input.record_type, input.value, input.unit, input.measured_at, input.notes);
        return JSON.stringify(result);
      }
      case 'query_health_records': {
        const records = queryHealthRecords(db, userId, agentId, input.record_type, input.start_date, input.end_date, input.limit);
        if (records.length === 0) return JSON.stringify({ message: '暂无健康数据记录' });
        return JSON.stringify(records);
      }
      case 'health_summary': {
        const summary = getHealthSummary(db, userId, agentId);
        if (Object.keys(summary).length === 0) return JSON.stringify({ message: '暂无健康数据' });
        return JSON.stringify(summary);
      }
      case 'log_sleep': {
        const date = input.date ?? new Date().toISOString().slice(0, 10);
        let duration = input.duration_hours;
        if (duration == null && input.bedtime && input.wake_time) {
          const [bh, bm] = input.bedtime.split(':').map(Number);
          const [wh, wm] = input.wake_time.split(':').map(Number);
          let mins = (wh * 60 + wm) - (bh * 60 + bm);
          if (mins < 0) mins += 24 * 60;
          duration = Math.round(mins / 60 * 10) / 10;
        }
        const value = JSON.stringify({ date, bedtime: input.bedtime, wake_time: input.wake_time, duration_hours: duration, quality: input.quality });
        return JSON.stringify(addHealthRecord(db, userId, agentId, 'sleep', value, undefined, `${date}T00:00:00`, input.notes));
      }
      case 'log_meal': {
        const value = JSON.stringify({ meal_type: input.meal_type, foods: input.foods, calories: input.calories });
        return JSON.stringify(addHealthRecord(db, userId, agentId, 'meal', value, undefined, input.meal_time, input.notes));
      }
      case 'log_symptom': {
        const value = JSON.stringify({ symptom: input.symptom, severity: input.severity, body_part: input.body_part, duration: input.duration });
        const onset = input.onset_at ?? new Date(Date.now() + 8 * 3_600_000).toISOString().replace('Z', '+08:00');
        return JSON.stringify(addHealthRecord(db, userId, agentId, 'symptom', value, undefined, onset, input.notes));
      }
      case 'set_medication_reminder': {
        const delivery = ctx.getDeliveryContext();
        if (!delivery) {
          return JSON.stringify({ error: '无法设置提醒：缺少投递上下文。请通过飞书或 Telegram 渠道使用此功能。' });
        }
        let remindAt: number;
        if (input.remind_at) {
          remindAt = new Date(input.remind_at).getTime();
          if (isNaN(remindAt)) return JSON.stringify({ error: `无效的时间格式: ${input.remind_at}` });
        } else if (input.delay_minutes != null) {
          remindAt = Date.now() + input.delay_minutes * 60_000;
        } else {
          return JSON.stringify({ error: '请提供 remind_at 或 delay_minutes' });
        }
        if (remindAt <= Date.now()) return JSON.stringify({ error: '提醒时间必须在未来' });

        const instruction = input.instruction ? `（${input.instruction}）` : '';
        const message = `💊 用药提醒：${input.drug} ${input.dose}${instruction}`;

        if (!ctx.createReminder) return JSON.stringify({ error: '提醒功能不可用' });
        const result = ctx.createReminder({
          agentId,
          message,
          remindAt,
          channel: delivery.channel,
          targetId: delivery.targetId,
          appId: delivery.appId,
        });
        const readableTime = new Date(remindAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        return JSON.stringify({ ...result, remind_at: readableTime, message });
      }
      default:
        return null;
    }
  },
};

export default plugin;
