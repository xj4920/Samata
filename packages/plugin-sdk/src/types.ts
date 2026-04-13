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

export interface PluginModule {
  name: string;
  description: string;
  toolDefinitions: ToolDefinition[];
  handleTool(name: string, input: any): Promise<string | null>;
}

export interface PluginSkill {
  name: string;
  description: string;
  content: string;
}
