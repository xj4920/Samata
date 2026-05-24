export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

export type PluginScope = 'universal' | 'agent-bound';

export interface DeliveryInfo {
  channel: string;
  targetId: string;
  appId?: string;
}

export interface PluginContext {
  getCurrentUser(): { id: string; name: string; role: string };
  getDataDir(): string;
  getAgentId(): string | undefined;
  getDeliveryContext(): DeliveryInfo | undefined;
  isAdmin?(): boolean;
  createReminder?(params: { agentId: string; message: string; remindAt: number; channel: string; targetId: string; appId?: string }): { success: boolean; id?: string };
  callLLM?(messages: Array<{role: string; content: string}>, options?: {system?: string; max_tokens?: number}): Promise<string>;
  sendNotification?(channel: string, targetId: string, message: string): Promise<void>;
  getConfigDir?(): string;
}

export interface PluginModule {
  name: string;
  description: string;
  scope?: PluginScope;
  toolDefinitions: ToolDefinition[];
  handleTool(name: string, input: any, ctx: PluginContext): Promise<string | null>;
  init?(ctx: PluginContext): Promise<void>;
  start?(ctx: PluginContext): Promise<void>;
  stop?(): Promise<void>;
}

export interface PluginSkill {
  name: string;
  description: string;
  content: string;
}

export interface LoadedPlugin {
  module: PluginModule;
  context: PluginContext;
  skill?: PluginSkill;
  dir: string;
  loadedAt: Date;
}
