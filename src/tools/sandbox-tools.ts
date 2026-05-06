import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';
import { getCurrentAgent } from '../llm/agents/config.js';
import { getCurrentUser } from '../auth/rbac.js';
import {
  sandboxWriteFile,
  sandboxReadFile,
  sandboxList,
  sandboxExec,
} from '../commands/sandbox.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'sandbox_write_file',
    description: '在沙箱中写入文件。沙箱是隔离的执行环境，与项目源码完全隔离。适合编写临时脚本、测试代码、数据处理等。',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: '文件路径（相对于沙箱根目录），如 "script.js" 或 "lib/utils.js"' },
        content: { type: 'string', description: '要写入的文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'sandbox_read_file',
    description: '读取沙箱中的文件内容，用于查看之前写入的代码或通过 sandbox_exec 生成的输出文件。',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: '文件路径（相对于沙箱根目录）' },
        max_lines: { type: 'number', description: '最多读取行数，默认 500' },
      },
      required: ['path'],
    },
  },
  {
    name: 'sandbox_list',
    description: '列出沙箱目录下的文件和子目录',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: '子目录路径（相对沙箱根目录），不传则列出根目录' },
      },
      required: [],
    },
  },
  {
    name: 'sandbox_exec',
    description: '在沙箱中执行代码。支持 JavaScript（Node.js）和 shell 命令。沙箱与项目完全隔离，cwd 为沙箱根目录。适合配合 sandbox_write_file 运行自研工具脚本。若 shell 命令需要 pip install，必须使用内网源参数：--index http://pypi.gf.com.cn/simple/ --trusted-host pypi.gf.com.cn。超时默认 30 秒，最大 120 秒。',
    input_schema: {
      type: 'object' as const,
      properties: {
        language: { type: 'string', enum: ['js', 'shell'], description: '执行语言：js=Node.js，shell=shell 命令' },
        code: { type: 'string', description: '要执行的代码' },
        timeout_ms: { type: 'number', description: '超时毫秒数，默认 30000，最大 120000' },
      },
      required: ['language', 'code'],
    },
  },
];

function getSandboxContext(): { agentName: string; userId: string } | string {
  const agent = getCurrentAgent();
  const user = getCurrentUser();
  if (!agent || !user) return '无法获取当前 Agent 或用户上下文';
  return { agentName: agent.name, userId: user.id };
}

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  const ctx = getSandboxContext();
  if (typeof ctx === 'string') return JSON.stringify({ error: ctx });
  const { agentName, userId } = ctx;

  switch (name) {
    case 'sandbox_write_file':
      return JSON.stringify(sandboxWriteFile(agentName, userId, input.path, input.content));
    case 'sandbox_read_file':
      return JSON.stringify(sandboxReadFile(agentName, userId, input.path, input.max_lines));
    case 'sandbox_list':
      return JSON.stringify(sandboxList(agentName, userId, input.path));
    case 'sandbox_exec':
      return JSON.stringify(sandboxExec(agentName, userId, {
        language: input.language,
        code: input.code,
        timeout_ms: input.timeout_ms,
      }));
    default:
      return null;
  }
}
