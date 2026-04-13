export type { PluginModule, PluginSkill, ToolDefinition } from '@samata/plugin-sdk';

export interface LoadedPlugin {
  module: import('@samata/plugin-sdk').PluginModule;
  skill?: import('@samata/plugin-sdk').PluginSkill;
  dir: string;
  loadedAt: Date;
}
