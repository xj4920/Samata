import Anthropic from '@anthropic-ai/sdk';
import type { ImportDocumentInput, DeleteDocumentInput } from '../llm/tool-types.js';
import { getCurrentUser } from '../auth/rbac.js';
import { getCurrentAgent, type ToolContext } from '../llm/agents/config.js';
import { importDocument, deleteDocument, listDocuments } from '../commands/document-import.js';
import * as fs from 'fs';
import * as path from 'path';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'import_document',
    description: '将文件导入为知识库文档。支持 .md、.docx、.xlsx、.csv 格式。文档以完整 Markdown 存储，可通过 search_knowledge 搜索到相关内容。',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: '文件路径（支持 ~/ 相对路径）' },
        title: { type: 'string', description: '文档标题（可选，默认从文件名提取）' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'list_documents',
    description: '列出当前 Agent 已导入的文档。返回文档 ID、标题、类型、文件大小等信息。',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'delete_document',
    description: '删除已导入的文档及其所有关联知识条目。需提供文档 ID 或 ID 前缀（通过 list_documents 获取）。',
    input_schema: {
      type: 'object' as const,
      properties: {
        id_prefix: { type: 'string', description: '文档 ID 或 ID 前缀（通过 list_documents 获取）' },
      },
      required: ['id_prefix'],
    },
  },
];

async function handleImportDocument(input: ImportDocumentInput, ctx?: ToolContext): Promise<string> {
  const agentId = getCurrentAgent()?.id;
  if (!agentId) return JSON.stringify({ error: '未关联 Agent，无法导入' });
  const result = await importDocument(input.file_path, agentId, {
    title: input.title,
    actorUserId: getCurrentUser().id,
    onProgress: ctx?.onProgress,
  });
  return JSON.stringify(result);
}

function handleListDocuments(): string {
  const agentId = getCurrentAgent()?.id;
  const docs = listDocuments(agentId);
  if (docs.length === 0) return JSON.stringify({ message: '暂无已导入的文档' });
  return JSON.stringify(docs.map(d => {
    let fileSize: string | null = null;
    if (d.stored_path) {
      const mdPath = path.join(d.stored_path, 'parsed.md');
      if (fs.existsSync(mdPath)) {
        const size = fs.statSync(mdPath).size;
        if (size < 1024) fileSize = `${size}B`;
        else if (size < 1024 * 1024) fileSize = `${(size / 1024).toFixed(1)}KB`;
        else fileSize = `${(size / (1024 * 1024)).toFixed(1)}MB`;
      }
    }
    return {
      id: d.id.slice(0, 8),
      title: d.title,
      file_type: d.file_type,
      file_size: fileSize,
      created_at: d.created_at,
    };
  }));
}

function handleDeleteDocument(input: DeleteDocumentInput): string {
  const agentId = getCurrentAgent()?.id;
  return JSON.stringify(deleteDocument(input.id_prefix, agentId));
}

export async function handleTool(name: string, input: any, ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'import_document': return handleImportDocument(input, ctx);
    case 'list_documents': return handleListDocuments();
    case 'delete_document': return handleDeleteDocument(input);
    default: return null;
  }
}
