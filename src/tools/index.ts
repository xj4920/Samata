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

interface ToolModule {
  toolDefinitions: Anthropic.Tool[];
  handleTool(name: string, input: any, ctx?: ToolContext): Promise<string | null>;
}

const modules: ToolModule[] = [
  clientTools,
  knowledgeTools,
  tradeTools,
  skillTools,
  agentTools,
  memoryTools,
  fileTools,
  weworkTools,
  reminderTools,
  systemTools,
  healthTools,
  todoTools,
  markdownTools,
  artifactTools,
  deliveryTools,
  mediaGenTools,
  hedgeRatioTools,
  documentTools,
  pricingQuoteTools,
];

export function getAllNativeTools(): Anthropic.Tool[] {
  return modules.flatMap(m => m.toolDefinitions);
}

export async function executeNativeTool(name: string, input: any, ctx: ToolContext = {}): Promise<string> {
  for (const m of modules) {
    const result = await m.handleTool(name, input, ctx);
    if (result !== null) return result;
  }
  return JSON.stringify({ error: `未知工具: ${name}` });
}
