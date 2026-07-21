import { matchesToolInput } from './matcher.js';
import type { CapturedToolCall, ToolFixture } from './types.js';

export class UnexpectedToolCallError extends Error {
  constructor(
    public readonly tool: string,
    message = `场景 fixture 未声明工具调用: ${tool}`,
  ) {
    super(message);
    this.name = 'UnexpectedToolCallError';
  }
}

export class ToolFixtureMismatchError extends Error {
  constructor(
    public readonly tool: string,
    public readonly call: number,
    message: string,
  ) {
    super(message);
    this.name = 'ToolFixtureMismatchError';
  }
}

function outputString(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

export class ToolFixtureRouter {
  readonly calls: CapturedToolCall[] = [];
  private readonly offsets = new Map<string, number>();
  private readonly fixtures: Map<string, ToolFixture>;

  constructor(fixtures: ToolFixture[]) {
    this.fixtures = new Map(fixtures.map(fixture => [fixture.tool, fixture]));
  }

  async execute(tool: string, input: unknown): Promise<string> {
    const fixture = this.fixtures.get(tool);
    if (!fixture) throw new UnexpectedToolCallError(tool);

    const offset = this.offsets.get(tool) ?? 0;
    const response = fixture.responses[offset];
    if (!response) {
      throw new ToolFixtureMismatchError(tool, offset + 1, `工具 ${tool} 的 fixture 响应已用尽`);
    }
    if (response.input && !matchesToolInput(response.input, input)) {
      throw new ToolFixtureMismatchError(
        tool,
        offset + 1,
        `工具 ${tool} 第 ${offset + 1} 次调用参数与 fixture 不匹配`,
      );
    }

    this.offsets.set(tool, offset + 1);
    const output = outputString(response.output);
    this.calls.push({
      tool,
      input,
      output,
      success: response.success !== false,
      error: response.error,
    });
    return output;
  }

  unusedResponses(): Array<{ tool: string; count: number }> {
    return [...this.fixtures.values()].flatMap(fixture => {
      const used = this.offsets.get(fixture.tool) ?? 0;
      const count = fixture.responses.length - used;
      return count > 0 ? [{ tool: fixture.tool, count }] : [];
    });
  }
}
