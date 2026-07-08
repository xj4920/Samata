import { describe, expect, it } from 'vitest';

describe('agent delivery context prompt', () => {
  it('exposes WeWork chat metadata to the agent', async () => {
    const { buildDeliveryContextSystemPrompt } = await import('../../../src/llm/agent.js');

    const prompt = buildDeliveryContextSystemPrompt({
      channel: 'wework',
      targetId: 'wrfvtgBgAAjdsXmbge5nt_WrtDP_4Zfw',
      appId: 'aibsBv1aVuu8jyVwy3nWvFovDz1rltvleDO',
      weworkChatId: 'wrfvtgBgAAjdsXmbge5nt_WrtDP_4Zfw',
      weworkChatType: 'group',
      weworkUserId: 'gzxujun',
      weworkBotName: 'wework-bot',
    });

    expect(prompt).toContain('wework_chatid: wrfvtgBgAAjdsXmbge5nt_WrtDP_4Zfw');
    expect(prompt).toContain('delivery_target_id: wrfvtgBgAAjdsXmbge5nt_WrtDP_4Zfw');
    expect(prompt).toContain('wework_chattype: group');
    expect(prompt).toContain('不要说系统无法获取');
  });
});
