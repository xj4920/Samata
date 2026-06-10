import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUnitDb } from '../../helpers/unit-harness.js';

const mockSendMessage = vi.hoisted(() => vi.fn());
const mockGetConnectedWsClient = vi.hoisted(() => vi.fn());

vi.mock('../../../src/wework/bot.js', () => ({
  getConnectedWsClient: mockGetConnectedWsClient,
}));

describe('deliver service', () => {
  const unit = useUnitDb();

  beforeEach(() => {
    mockSendMessage.mockReset();
    mockGetConnectedWsClient.mockReset();
  });

  it('sends Feishu oc_ targets as chat_id', async () => {
    unit.db.prepare(
      `INSERT INTO bot_apps (id, channel, name, secret, config, show_thinking, auto_start)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('cli_test_app', 'feishu', 'test-bot', 'test-secret', '{}', 1, 1);

    const { FeishuAPI } = await import('../../../src/feishu/api.js');
    const sendSpy = vi.spyOn(FeishuAPI.prototype, 'sendMessageTo').mockResolvedValue('om_test');
    const { deliverMessage } = await import('../../../src/services/deliver.js');

    expect(await deliverMessage('feishu', 'oc_group_chat', 'cli_test_app', 'hello')).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith('oc_group_chat', 'chat_id', 'text', { text: 'hello' });

    sendSpy.mockRestore();
  });

  it('sends Wework notifications through the selected bot', async () => {
    mockGetConnectedWsClient.mockReturnValue({ sendMessage: mockSendMessage });
    mockSendMessage.mockResolvedValue({});

    const { deliverMessage } = await import('../../../src/services/deliver.js');

    expect(await deliverMessage('wework:wework-bot', 'gzxujun', null, '任务完成')).toBe(true);
    expect(mockGetConnectedWsClient).toHaveBeenCalledWith('wework-bot');
    expect(mockSendMessage).toHaveBeenCalledWith('gzxujun', {
      msgtype: 'markdown',
      markdown: { content: '任务完成' },
    });
  });
});
