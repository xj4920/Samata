import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';

export interface PluginModule {
  name: string;
  description: string;
  toolDefinitions: Anthropic.Tool[];
  handleTool(name: string, input: any, ctx?: ToolContext): Promise<string | null>;
}

export interface PluginSkill {
  name: string;
  description: string;
  content: string;
}

export interface LoadedPlugin {
  module: PluginModule;
  skill?: PluginSkill;
  dir: string;
  loadedAt: Date;
}
