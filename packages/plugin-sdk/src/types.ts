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
}

export interface PluginModule {
  name: string;
  description: string;
  /**
   * 'universal': 自动对所有 standard-mode agent 可见（默认值，向后兼容）
   * 'agent-bound': 仅当 tool name 出现在 agent.tools_list 时可见
   */
  scope?: PluginScope;
  toolDefinitions: ToolDefinition[];
  handleTool(name: string, input: any, ctx: PluginContext): Promise<string | null>;
  init?(ctx: PluginContext): Promise<void>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface PluginSkill {
  name: string;
  description: string;
  content: string;
}
