import type Anthropic from '@anthropic-ai/sdk';
import type { ToolFixture } from './types.js';

function jsonSchema(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { type: 'array' };
  if (value === null) return {};
  if (typeof value === 'string') return { type: 'string' };
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'object') return { type: 'object' };
  return {};
}

export function createFixtureToolDefinition(fixture: ToolFixture): Anthropic.Tool {
  const matcher = fixture.responses
    .map(response => response.input)
    .find(input => (
      (input?.mode === 'exact' || input?.mode === 'subset')
      && typeof input.value === 'object'
      && input.value !== null
      && !Array.isArray(input.value)
    ));
  const expected = (matcher?.value ?? {}) as Record<string, unknown>;
  const keys = Object.keys(expected);
  return {
    name: fixture.tool,
    description: `[场景回归 fixture] ${fixture.tool}。用户明确要求此操作时必须调用；返回值由冻结 fixture 提供。${keys.length > 0 ? `必需参数：${keys.join(', ')}。` : ''}`,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, jsonSchema(value)])),
      required: keys,
      additionalProperties: true,
    },
  } as Anthropic.Tool;
}
