/**
 * 飞书消息卡片构建
 *
 * 将 LLM 返回的 Markdown 文本转换为飞书 Interactive Card JSON（schema 2.0），
 * 使消息在飞书客户端中以卡片形式渲染（表格、加粗、列表等）。
 *
 * 参考 openclaw 实现：使用 schema 2.0 + body.elements 结构，
 * 飞书卡片 markdown 原生支持表格、加粗、列表、代码块等。
 *
 * 参考：https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags
 */

export interface FeishuCard {
  schema: '2.0';
  config: { wide_screen_mode: boolean };
  body: {
    elements: FeishuCardElement[];
  };
}

export type FeishuCardElement =
  | { tag: 'markdown'; content: string }
  | { tag: 'hr' };

/**
 * 移除 <think>...</think> 块（LLM 返回的原始文本可能包含）
 */
function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * 修复 Markdown 表格格式
 * 飞书卡片对表格非常挑剔：
 * 1. 必须有分隔行 | --- |
 * 2. 分隔行前后必须有换行
 * 3. 列数必须对齐
 */
function fixMarkdownTables(text: string): string {
  const lines = text.split('\n');
  let inTable = false;
  const processedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const isTableRow = line.startsWith('|') && line.endsWith('|') && line.includes('|');
    const isDivider = line.match(/^\|? *[-:]+ *\| *[-:| ]*$/);

    if (isTableRow && !inTable) {
      // 表格开始，确保前面有换行
      if (processedLines.length > 0 && processedLines[processedLines.length - 1] !== '') {
        processedLines.push('');
      }
      inTable = true;
    }

    if (inTable && !isTableRow && line !== '') {
      // 表格结束，确保后面有换行
      inTable = false;
      processedLines.push('');
    }

    processedLines.push(lines[i]);
  }

  return processedLines.join('\n');
}

/**
 * 构建飞书消息卡片 JSON（schema 2.0）
 *
 * 直接将 markdown 文本放入 body.elements 的 markdown 元素中，
 * 飞书卡片原生支持表格、加粗、列表、代码块等 markdown 语法。
 */
export function buildCard(rawMarkdown: string): FeishuCard {
  let content = stripThinkBlocks(rawMarkdown);
  content = fixMarkdownTables(content);

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [
        { tag: 'markdown', content },
      ],
    },
  };
}

/**
 * 构建"处理中"占位卡片
 */
export function buildThinkingCard(hint?: string): FeishuCard {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [
        { tag: 'markdown', content: hint || '⏳ 处理中...' },
      ],
    },
  };
}
