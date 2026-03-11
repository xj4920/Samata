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
 * 构建飞书消息卡片 JSON（schema 2.0）
 *
 * 直接将 markdown 文本放入 body.elements 的 markdown 元素中，
 * 飞书卡片原生支持表格、加粗、列表、代码块等 markdown 语法。
 */
export function buildCard(rawMarkdown: string): FeishuCard {
  const content = stripThinkBlocks(rawMarkdown);

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
