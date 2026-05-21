import type { PluginModule, PluginContext } from '@samata/plugin-sdk';
import { toolDefinitions } from './src/tools.js';
import { getWrongQuestionsDb, closeWrongQuestionsDb } from './src/db.js';
import {
  recordWrongQuestion,
  listWrongQuestions,
  markWrongQuestionMastered,
  getWrongQuestionReport,
} from './src/commands.js';
import type Database from 'better-sqlite3';

let db: Database.Database | null = null;
let dataDir: string = '';

const plugin: PluginModule = {
  name: 'wrong-questions',
  description: '错题管理：记录、查询、标记掌握、生成报告',
  scope: 'agent-bound',
  toolDefinitions,

  async init(ctx: PluginContext) {
    dataDir = ctx.getDataDir();
    db = getWrongQuestionsDb(dataDir);
  },

  async stop() {
    closeWrongQuestionsDb();
    db = null;
  },

  async handleTool(name: string, input: any, ctx: PluginContext) {
    if (!db) return null;

    const user = ctx.getCurrentUser();
    const agentId = ctx.getAgentId() || 'tutor';
    const userId = user.id;

    switch (name) {
      case 'record_wrong_question': {
        const result = recordWrongQuestion(db, dataDir, input, agentId, userId);
        if (!result.success || !result.question) return JSON.stringify(result);
        return JSON.stringify({
          success: true,
          created: result.created,
          id: result.question.id.slice(0, 8),
          subject: result.question.subject,
          question_summary: result.question.question_summary,
          status: result.question.status,
          mistake_count: result.question.mistake_count,
          source_type: result.question.source_type,
          assets: result.assets ?? 0,
        });
      }
      case 'list_wrong_questions': {
        const items = listWrongQuestions(db, input, agentId, userId);
        if (items.length === 0) return JSON.stringify({ message: '暂无错题记录' });
        return JSON.stringify(items.map(item => ({
          id: item.id.slice(0, 8),
          subject: item.subject,
          question_summary: item.question_summary,
          error_type: item.error_type,
          error_subtype: item.error_subtype,
          status: item.status,
          mistake_count: item.mistake_count,
          source_type: item.source_type,
          last_wrong_at: item.last_wrong_at,
        })));
      }
      case 'mark_wrong_question_mastered': {
        const result = markWrongQuestionMastered(db, input.id, agentId, userId);
        if (!result.success || !result.question) return JSON.stringify(result);
        return JSON.stringify({
          success: true,
          id: result.question.id.slice(0, 8),
          question_summary: result.question.question_summary,
          status: result.question.status,
          mastered_at: result.question.mastered_at,
        });
      }
      case 'wrong_question_report': {
        return JSON.stringify(getWrongQuestionReport(db, input, agentId, userId));
      }
      default:
        return null;
    }
  },
};

export default plugin;
