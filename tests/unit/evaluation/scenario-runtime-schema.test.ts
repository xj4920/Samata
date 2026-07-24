import { describe, expect, it } from 'vitest';
import { createFixtureToolDefinition } from '../../../src/evaluation/fixture-tool-definition.js';
import type { ToolFixture } from '../../../src/evaluation/types.js';

describe('scenario fixture schema source', () => {
  it('derives required typed parameters from subset matchers', () => {
    const fixture: ToolFixture = {
      tool: 'export_north_info_csv',
      responses: [{
        input: {
          mode: 'subset',
          value: { date_from: '20260601', date_to: '20260630', limit: 10 },
        },
        output: { success: true },
      }],
    };
    const tool = createFixtureToolDefinition(fixture);
    expect(tool.input_schema).toMatchObject({
      required: ['date_from', 'date_to', 'limit'],
      properties: {
        date_from: { type: 'string' },
        date_to: { type: 'string' },
        limit: { type: 'number' },
      },
    });
    expect(tool.description).toContain('date_from, date_to, limit');
  });
});
