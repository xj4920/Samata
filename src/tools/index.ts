import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';

import * as clientTools from './client-tools.js';
import * as knowledgeTools from './knowledge-tools.js';
import * as tradeTools from './trade-tools.js';
import * as skillTools from './skill-tools.js';
import * as agentTools from './agent-tools.js';
import * as memoryTools from './memory-tools.js';
import * as fileTools from './file-tools.js';
import * as weworkTools from './wework-tools.js';
import * as reminderTools from './reminder-tools.js';
import * as systemTools from './system-tools.js';
import * as healthTools from './health-tools.js';
import * as todoTools from './todo-tools.js';
import * as markdownTools from './markdown-tools.js';
import * as artifactTools from './artifact-tools.js';
import * as deliveryTools from './delivery-tools.js';
import * as mediaGenTools from './media-gen-tools.js';
import * as hedgeRatioTools from './hedge-ratio-tools.js';
import * as documentTools from './document-tools.js';
import * as pricingQuoteTools from './pricing-quote-tools.js';
import * as dateTools from './date-tools.js';
import * as wrongQuestionTools from './wrong-question-tools.js';
import * as sandboxTools from './sandbox-tools.js';
import * as webTools from './web-tools.js';
import * as wechatArticleTools from './wechat-article-tools.js';
import * as archiveTools from './archive-tools.js';
import * as wikiTools from './wiki-tools.js';
import * as scheduleTools from './schedule-tools.js';

interface ToolModule {
  toolDefinitions: Anthropic.Tool[];
  handleTool(name: string, input: any, ctx?: ToolContext): Promise<string | null>;
}

const moduleEntries: { module: ToolModule; category: string }[] = [
  { module: clientTools,       category: '客户' },
  { module: knowledgeTools,    category: '知识库' },
  { module: tradeTools,        category: '交易' },
  { module: skillTools,        category: 'Skill' },
  { module: agentTools,        category: 'Agent' },
  { module: memoryTools,       category: '记忆' },
  { module: fileTools,         category: '文件' },
  { module: weworkTools,       category: '企微' },
  { module: reminderTools,     category: '提醒' },
  { module: systemTools,       category: '系统' },
  { module: healthTools,       category: '健康' },
  { module: todoTools,         category: '待办' },
  { module: markdownTools,     category: 'Markdown' },
  { module: artifactTools,     category: 'Artifact' },
  { module: deliveryTools,     category: '发送' },
  { module: mediaGenTools,     category: '媒体' },
  { module: hedgeRatioTools,   category: '对冲比' },
  { module: documentTools,     category: '文档' },
  { module: pricingQuoteTools, category: '报价' },
  { module: dateTools,         category: '日期' },
  { module: wrongQuestionTools, category: '错题' },
  { module: sandboxTools,       category: '沙箱' },
  { module: webTools,           category: '网页' },
  { module: wechatArticleTools, category: '公众号' },
  { module: archiveTools,        category: '解压' },
  { module: wikiTools,           category: 'Wiki' },
  { module: scheduleTools,       category: '定时任务' },
];

const modules: ToolModule[] = moduleEntries.map(e => e.module);

export function getAllNativeTools(): Anthropic.Tool[] {
  return modules.flatMap(m => m.toolDefinitions);
}

/** Returns a map from tool name → category label for all native tools */
export function getToolCategoryMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const { module, category } of moduleEntries) {
    for (const tool of module.toolDefinitions) {
      map.set(tool.name, category);
    }
  }
  return map;
}

export async function executeNativeTool(name: string, input: any, ctx: ToolContext = {}): Promise<string> {
  for (const m of modules) {
    const result = await m.handleTool(name, input, ctx);
    if (result !== null) return result;
  }
  return JSON.stringify({ error: `未知工具: ${name}` });
}
