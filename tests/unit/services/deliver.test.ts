import { describe, expect, it, vi } from 'vitest';
import { useUnitDb } from '../../helpers/unit-harness.js';

describe('deliver service', () => {
  const unit = useUnitDb();

  it('sends Feishu oc_ targets as chat_id', async () => {
    unit.db.prepare(
      `INSERT INTO bot_apps (id, channel, name, secret, config, show_thinking, auto_start)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('cli_test_app', 'feishu', 'test-bot', 'test-secret', '{}', 1, 1);

    const { FeishuAPI } = await import('../../../src/feishu/api.js');
    const sendSpy = vi.spyOn(FeishuAPI.prototype, 'sendMessageTo').mockResolvedValue('om_test');
    const { deliverMessage } = await import('../../../src/services/deliver.js');

    expect(await deliverMessage('feishu', 'oc_group_chat', 'cli_test_app', '**hello**')).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith('oc_group_chat', 'chat_id', 'interactive', {
      config: { wide_screen_mode: true },
      elements: [{ tag: 'markdown', content: '**hello**' }],
    });

    sendSpy.mockRestore();
  });
});
