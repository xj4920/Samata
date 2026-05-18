import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import type { ToolContext } from '../llm/agents/config.js';
import { getCurrentAgent } from '../llm/agents/config.js';
import { getCurrentUser } from '../auth/rbac.js';
import {
  sandboxWriteFile,
  sandboxReadFile,
  sandboxList,
  sandboxExecAsync,
} from '../commands/sandbox.js';

const GENERATED_IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
const MAX_WEWORK_PUSH_IMAGE_BYTES = 5 * 1024 * 1024;

function appendPgFailureHints(stderr: string): string {
  if (!stderr || !/psycopg2|PostgreSQL|UndefinedColumn|InvalidColumnReference|syntax error|relation .* does not exist/i.test(stderr)) {
    return stderr;
  }
  return `${stderr.trimEnd()}\n\n提示（Wind/PG）：请用 information_schema.columns 核对列名；写 SQL 前 read_file docs/wind-tables/<表>.md。ASHAREINDUSTRIESCODE 仅为行业字典，不能按 S_INFO_WINDCODE 与行情表 JOIN；同业筛选需存在「证券–行业」映射表（若库中无此表则勿编造 JOIN）。`;
}

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'sandbox_write_file',
    description: '在沙箱中写入文件。沙箱是隔离的执行环境，与项目源码完全隔离。适合编写临时脚本、测试代码、数据处理等。写入后可在 sandbox_exec 中通过相对路径直接引用。注意：写入 .py 文件时会自动做语法检查，若有语法错误会在返回结果中提示。Python 代码中的 SQL 请用单引号包裹（如 \'SELECT "COL" FROM "TABLE"\'），不要用三引号（"""），三引号在 JSON 传输中容易损坏。如果只需运行一次 Python 脚本，推荐直接使用 sandbox_exec 的 language="python" 模式。',
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
    description: '在沙箱中执行代码。支持 JavaScript（Node.js）、shell 命令和 Python。沙箱与项目完全隔离。重要：cwd 已自动设为沙箱根目录（sandbox_write_file 写入的文件就在此），禁止使用 cd 切换目录或拼接 /tmp 等绝对路径（会被拒绝），直接用相对路径即可。language="python" 模式可直接传入 Python 代码执行（推荐），无需先 sandbox_write_file 再 shell 调用；执行前会自动做语法检查。Python 代码中的 SQL 请用单引号包裹（如 \'SELECT "COL" FROM "TABLE"\'），不要用三引号。项目白名单文件已只读挂载到 .data/ 目录下，可通过 .data/<相对路径> 访问（如 open(".data/docs/wind-tables-schema.md")）。Python 环境（python3）已预装：psycopg2, pandas, numpy, matplotlib, openpyxl, xlrd, requests, beautifulsoup4, lxml, pillow, paramiko, cryptography，无需 pip install。matplotlib 保存图表请用 cwd 下相对文件名（如 plt.savefig(\"chart.png\")）；沙箱已为 Matplotlib 写入默认中文字体优先配置（依赖宿主机安装 Noto CJK 等字体，与系统共享 /usr/share/fonts）。查询 Wind PostgreSQL 时 WHERE 顺序必须与索引一致：先 \"S_INFO_WINDCODE\" 等值，再日期/报告期（详见 read_file docs/wind-database.md「索引与查询形状」）。若确需安装额外包，必须使用内网源参数：--index http://pypi.gf.com.cn/simple/ --trusted-host pypi.gf.com.cn。超时默认 60 秒，最大 120 秒（Wind 大表查询可在参数里增大 timeout_ms）。',
    input_schema: {
      type: 'object' as const,
      properties: {
        language: { type: 'string', enum: ['js', 'shell', 'python'], description: '执行语言：js=Node.js，shell=shell 命令，python=直接执行 Python 代码（推荐用于数据查询脚本）' },
        code: { type: 'string', description: '要执行的代码。language=python 时直接传 Python 源码；language=shell 时传 shell 命令（禁止使用绝对路径）' },
        timeout_ms: { type: 'number', description: '超时毫秒数，默认 60000，最大 120000（Wind 大表查询可适当加大）' },
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

export async function handleTool(name: string, input: any, ctx?: ToolContext): Promise<string | null> {
  const sandboxCtx = getSandboxContext();
  if (typeof sandboxCtx === 'string') return JSON.stringify({ error: sandboxCtx });
  const { agentName, userId } = sandboxCtx;

  switch (name) {
    case 'sandbox_write_file':
      return JSON.stringify(sandboxWriteFile(agentName, userId, input.path, input.content));
    case 'sandbox_read_file':
      return JSON.stringify(sandboxReadFile(agentName, userId, input.path, input.max_lines));
    case 'sandbox_list':
      return JSON.stringify(sandboxList(agentName, userId, input.path));
    case 'sandbox_exec': {
      const execResult = await sandboxExecAsync(agentName, userId, {
        language: input.language,
        code: input.code,
        timeout_ms: input.timeout_ms,
      }, ctx?.onProgress);

      const dc = ctx?.deliveryContext;
      if (dc?.channel === 'wework' && execResult.generated_files?.length) {
        dc.pendingWeworkImagePaths ??= [];
        const seen = new Set(dc.pendingWeworkImagePaths);
        for (const absPath of execResult.generated_files) {
          if (!GENERATED_IMAGE_RE.test(absPath)) continue;
          try {
            if (!fs.existsSync(absPath)) continue;
            const st = fs.statSync(absPath);
            if (st.size === 0 || st.size > MAX_WEWORK_PUSH_IMAGE_BYTES) continue;
            if (!seen.has(absPath)) {
              seen.add(absPath);
              dc.pendingWeworkImagePaths.push(absPath);
            }
          } catch {
            // ignore
          }
        }
      }

      const errOut = execResult.exit_code !== 0 && execResult.stderr
        ? appendPgFailureHints(execResult.stderr)
        : execResult.stderr;
      return JSON.stringify(errOut !== execResult.stderr ? { ...execResult, stderr: errOut } : execResult);
    }
    default:
      return null;
  }
}
