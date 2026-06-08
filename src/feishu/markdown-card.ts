export type FeishuMarkdownCard = {
  config: {
    wide_screen_mode: boolean;
  };
  elements: Array<{
    tag: 'markdown';
    content: string;
  }>;
};

export function buildFeishuMarkdownCard(markdown: string): FeishuMarkdownCard {
  return {
    config: {
      wide_screen_mode: true,
    },
    elements: [
      {
        tag: 'markdown',
        content: markdown,
      },
    ],
  };
}
