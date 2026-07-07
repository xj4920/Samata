import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUnitDb } from '../../helpers/unit-harness.js';

const mockSendMessage = vi.hoisted(() => vi.fn());
const mockGetConnectedWsClient = vi.hoisted(() => vi.fn());

vi.mock('../../../src/wework/bot.js', () => ({
  getConnectedWsClient: mockGetConnectedWsClient,
}));

describe('deliver service', () => {
  const unit = useUnitDb();
  const originalMinInterval = process.env.WEWORK_SEND_MIN_INTERVAL_MS;

  beforeEach(async () => {
    mockSendMessage.mockReset();
    mockGetConnectedWsClient.mockReset();
    const queue = await import('../../../src/wework/notification-queue.js');
    queue.__resetWeworkNotificationQueuesForTests();
    process.env.WEWORK_SEND_MIN_INTERVAL_MS = '800';
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalMinInterval === undefined) {
      delete process.env.WEWORK_SEND_MIN_INTERVAL_MS;
    } else {
      process.env.WEWORK_SEND_MIN_INTERVAL_MS = originalMinInterval;
    }
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

  it('serializes Wework notifications for the same bot', async () => {
    vi.useFakeTimers();
    mockGetConnectedWsClient.mockReturnValue({ sendMessage: mockSendMessage });
    mockSendMessage.mockResolvedValue({});

    const { deliverWework } = await import('../../../src/services/deliver.js');

    const first = deliverWework('gzxujun', 'one', 'wework-bot');
    const second = deliverWework('gzxujun', 'two', 'wework-bot');
    const third = deliverWework('gzxujun', 'three', 'wework-bot');

    await vi.advanceTimersByTimeAsync(0);
    await first;
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(799);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(mockSendMessage).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(800);
    await third;
    expect(mockSendMessage).toHaveBeenCalledTimes(3);
    expect(mockSendMessage.mock.calls.map(call => call[1].markdown.content)).toEqual(['one', 'two', 'three']);
  });

  it('keeps Wework queues independent across bots', async () => {
    vi.useFakeTimers();
    mockGetConnectedWsClient.mockImplementation(() => ({ sendMessage: mockSendMessage }));
    mockSendMessage.mockResolvedValue({});

    const { deliverWework } = await import('../../../src/services/deliver.js');

    const first = deliverWework('gzxujun', 'one', 'bot-a');
    const second = deliverWework('gzxujun', 'two', 'bot-b');

    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([first, second]);

    expect(mockGetConnectedWsClient).toHaveBeenCalledWith('bot-a');
    expect(mockGetConnectedWsClient).toHaveBeenCalledWith('bot-b');
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('backs off and retries Wework frequency limit errors', async () => {
    vi.useFakeTimers();
    mockGetConnectedWsClient.mockReturnValue({ sendMessage: mockSendMessage });
    mockSendMessage
      .mockRejectedValueOnce({ errcode: 846607, errmsg: 'aibot send msg frequency limit exceeded', hint: 'h1' })
      .mockResolvedValueOnce({});

    const { deliverWework } = await import('../../../src/services/deliver.js');
    const pending = deliverWework('gzxujun', '任务完成', 'wework-bot');

    await vi.advanceTimersByTimeAsync(0);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4999);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('returns false after Wework frequency limit retries are exhausted', async () => {
    vi.useFakeTimers();
    mockGetConnectedWsClient.mockReturnValue({ sendMessage: mockSendMessage });
    mockSendMessage.mockRejectedValue({ errcode: 846607, errmsg: 'aibot send msg frequency limit exceeded' });

    const { deliverMessage } = await import('../../../src/services/deliver.js');
    const pending = deliverMessage('wework:wework-bot', 'gzxujun', null, '任务完成');

    await vi.advanceTimersByTimeAsync(50_000);

    await expect(pending).resolves.toBe(false);
    expect(mockSendMessage).toHaveBeenCalledTimes(4);
  });
});
