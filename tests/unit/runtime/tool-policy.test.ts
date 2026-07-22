import { afterEach, describe, expect, it } from 'vitest';
import {
  filterDisabledTools,
  getDisabledToolNames,
  isToolDisabled,
} from '../../../src/runtime/tool-policy.js';

const originalDisabledTools = process.env.SAMATA_DISABLED_TOOLS;

afterEach(() => {
  if (originalDisabledTools === undefined) delete process.env.SAMATA_DISABLED_TOOLS;
  else process.env.SAMATA_DISABLED_TOOLS = originalDisabledTools;
});

describe('runtime tool policy', () => {
  it('trims and deduplicates configured tool names', () => {
    expect([...getDisabledToolNames(' generate_image,generate_video, generate_image ,,')])
      .toEqual(['generate_image', 'generate_video']);
  });

  it('filters only exact tool names', () => {
    process.env.SAMATA_DISABLED_TOOLS = 'generate_image,mcp_media_generate_video';
    const tools = [
      { name: 'generate_image' },
      { name: 'generate_image_preview' },
      { name: 'mcp_media_generate_video' },
    ];

    expect(filterDisabledTools(tools).map(tool => tool.name)).toEqual(['generate_image_preview']);
    expect(isToolDisabled('generate_image')).toBe(true);
    expect(isToolDisabled('Generate_Image')).toBe(false);
  });

  it('blocks direct native, plugin, and MCP execution paths', async () => {
    process.env.SAMATA_DISABLED_TOOLS = 'generate_image,plugin_hidden,mcp_hidden_run';
    const { executeNativeTool } = await import('../../../src/tools/index.js');
    const { executePluginTool } = await import('../../../src/plugins/registry.js');
    const { callMcpTool } = await import('../../../src/services/mcp-manager.js');

    for (const result of [
      await executeNativeTool('generate_image', {}),
      await executePluginTool('plugin_hidden', {}),
      await callMcpTool('mcp_hidden_run', {}),
    ]) {
      expect(JSON.parse(result!).code).toBe('TOOL_DISABLED_BY_RUNTIME_POLICY');
    }
  });
});
