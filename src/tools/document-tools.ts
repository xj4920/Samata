import Anthropic from '@anthropic-ai/sdk';
import type { ImportDocumentInput, DeleteDocumentInput } from '../llm/tool-types.js';
import { getCurrentUser } from '../auth/rbac.js';
import { getCurrentAgent, type ToolContext } from '../llm/agents/config.js';
import { importDocument, deleteDocument, listDocuments, formatFileSize } from '../commands/document-import.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'import_document',
    description: '将文件导入为知识库文档。支持 .md、.docx、.xlsx、.csv、.pdf 以及图片（.png/.jpg/.jpeg/.gif/.webp/.svg）。图片与 PDF 内的图会通过 vision 模型自动转录文字。文档以完整 Markdown 存储，可通过 search_knowledge 检索。',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: '文件路径（支持 ~/ 相对路径）' },
        title: { type: 'string', description: '文档标题（可选，默认从文件名提取）' },
        doc_date: { type: 'string', description: '材料日期，格式 YYYY-MM-DD（如检查报告的检查日期）。应先尝试从文件内容中提取；若无法确定，应询问用户确认，不得未经确认直接使用当日' },
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
    docDate: input.doc_date,
    actorUserId: getCurrentUser().id,
    onProgress: ctx?.onProgress,
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
    file_size: typeof d.size_bytes === 'number' && d.size_bytes > 0 ? formatFileSize(d.size_bytes) : null,
    doc_date: d.doc_date || null,
    created_at: d.created_at,
  })));
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
