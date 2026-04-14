import Anthropic from '@anthropic-ai/sdk';
import type { ImportDocumentInput, DeleteDocumentInput } from '../llm/tool-types.js';
import { getCurrentUser } from '../auth/rbac.js';
import { getCurrentAgent, type ToolContext } from '../llm/agents/config.js';
import { importDocument, deleteDocument, listDocuments } from '../commands/document-import.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'import_document',
    description: '将文件导入为知识库条目。支持 .md、.docx、.xlsx、.csv 格式。文档会按章节自动拆分为多条知识，每条可通过 search_knowledge 搜索。',
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
    description: '列出当前 Agent 已导入的文档。返回文档 ID、标题、类型、知识条目数等信息。',
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

async function handleImportDocument(input: ImportDocumentInput): Promise<string> {
  const agentId = getCurrentAgent()?.id;
  if (!agentId) return JSON.stringify({ error: '未关联 Agent，无法导入' });
  const result = await importDocument(input.file_path, agentId, {
    title: input.title,
    actorUserId: getCurrentUser().id,
  });
  return JSON.stringify(result);
}

function handleListDocuments(): string {
  const agentId = getCurrentAgent()?.id;
  const docs = listDocuments(agentId);
  if (docs.length === 0) return JSON.stringify({ message: '暂无已导入的文档' });
  return JSON.stringify(docs.map(d => ({
    id: d.id.slice(0, 8),
    title: d.title,
    file_type: d.file_type,
    chunk_count: d.chunk_count,
    created_at: d.created_at,
  })));
}

function handleDeleteDocument(input: DeleteDocumentInput): string {
  const agentId = getCurrentAgent()?.id;
  return JSON.stringify(deleteDocument(input.id_prefix, agentId));
}

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'import_document': return handleImportDocument(input);
    case 'list_documents': return handleListDocuments();
    case 'delete_document': return handleDeleteDocument(input);
    default: return null;
  }
}
