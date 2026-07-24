import { describe, expect, it } from 'vitest';
import { ToolFixtureMismatchError, ToolFixtureRouter, UnexpectedToolCallError } from '../../../src/evaluation/fixture-router.js';

describe('tool fixture router', () => {
  it('routes sequential fixture responses and captures calls', async () => {
    const router = new ToolFixtureRouter([{
      tool: 'lookup',
      responses: [
        { input: { mode: 'subset', value: { id: 1 } }, output: { value: 'first' } },
        { input: { mode: 'any' }, output: 'second' },
      ],
    }]);
    await expect(router.execute('lookup', { id: 1, extra: true })).resolves.toBe('{"value":"first"}');
    await expect(router.execute('lookup', {})).resolves.toBe('second');
    expect(router.calls).toHaveLength(2);
    expect(router.unusedResponses()).toEqual([]);
  });

  it('fails closed for undeclared tools, mismatched input and exhausted fixtures', async () => {
    const router = new ToolFixtureRouter([{
      tool: 'lookup',
      responses: [{ input: { mode: 'exact', value: { id: 1 } }, output: 'ok' }],
    }]);
    await expect(router.execute('send_file', {})).rejects.toBeInstanceOf(UnexpectedToolCallError);
    await expect(router.execute('lookup', { id: 2 })).rejects.toMatchObject({
      name: 'ToolFixtureMismatchError',
      message: expect.stringContaining('actual={"id":2}'),
    });
    await router.execute('lookup', { id: 1 });
    await expect(router.execute('lookup', { id: 1 })).rejects.toBeInstanceOf(ToolFixtureMismatchError);
  });
});
