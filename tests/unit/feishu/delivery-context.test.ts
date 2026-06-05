import { describe, expect, it } from 'vitest';

describe('Feishu delivery context', () => {
  it('uses the current chat_id as the delivery target', async () => {
    const { buildFeishuDeliveryContext } = await import('../../../src/feishu/bot.js');

    expect(buildFeishuDeliveryContext('oc_group_chat', 'cli_test_app')).toEqual({
      channel: 'feishu',
      targetId: 'oc_group_chat',
      appId: 'cli_test_app',
    });
  });
});
