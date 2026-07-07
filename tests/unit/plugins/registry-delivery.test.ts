import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('plugin delivery context', () => {
  const originalPluginsDir = process.env.SAMATA_PLUGINS_DIR;
  const originalWeworkMinInterval = process.env.WEWORK_SEND_MIN_INTERVAL_MS;
  let pluginRoot: string | undefined;

  afterEach(() => {
    if (originalPluginsDir === undefined) {
      delete process.env.SAMATA_PLUGINS_DIR;
    } else {
      process.env.SAMATA_PLUGINS_DIR = originalPluginsDir;
    }
    if (originalWeworkMinInterval === undefined) {
      delete process.env.WEWORK_SEND_MIN_INTERVAL_MS;
    } else {
      process.env.WEWORK_SEND_MIN_INTERVAL_MS = originalWeworkMinInterval;
    }
    if (pluginRoot) fs.rmSync(pluginRoot, { recursive: true, force: true });
    pluginRoot = undefined;
    vi.resetModules();
    vi.doUnmock('../../../src/db/connection.js');
    vi.doUnmock('../../../src/feishu/api.js');
    vi.doUnmock('../../../src/wework/bot.js');
    vi.doUnmock('../../../src/utils/logger.js');
  });

  it('passes delivery context to plugins and sends Feishu notifications with the current app', async () => {
    pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'samata-plugin-test-'));
    const pluginDir = path.join(pluginRoot, 'delivery-test');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'index.ts'), `
export default {
  name: 'delivery-test',
  description: 'delivery context test plugin',
  toolDefinitions: [
    { name: 'plugin_delivery_context', description: 'returns context', input_schema: { type: 'object', properties: {} } },
    { name: 'plugin_notify', description: 'sends notification', input_schema: { type: 'object', properties: { targetId: { type: 'string' }, message: { type: 'string' } }, required: ['targetId', 'message'] } },
  ],
  async handleTool(name, input, ctx) {
    if (name === 'plugin_delivery_context') return JSON.stringify(ctx.getDeliveryContext());
    if (name === 'plugin_notify') {
      await ctx.sendNotification('feishu', input.targetId, input.message);
      return JSON.stringify({ ok: true });
    }
    return null;
  },
};
`);

    process.env.SAMATA_PLUGINS_DIR = pluginRoot;

    const currentApp = {
      id: 'cli_current_app',
      channel: 'feishu',
      name: 'current-bot',
      secret: 'current-secret',
      config: JSON.stringify({ verification_token: 'verify-current', encrypt_key: 'encrypt-current' }),
    };
    const monitorApp = {
      id: 'cli_monitor_app',
      channel: 'feishu',
      name: 'monitor-bot',
      secret: 'monitor-secret',
      config: '{}',
    };
    const preparedQueries: Array<{ sql: string; arg?: string }> = [];
    const constructedConfigs: any[] = [];
    const sentMessages: any[] = [];

    vi.doMock('../../../src/db/connection.js', () => ({
      getDb: () => ({
        prepare: (sql: string) => ({
          get: (arg?: string) => {
            preparedQueries.push({ sql, arg });
            if (sql.includes('WHERE id = ?')) return arg === currentApp.id ? currentApp : undefined;
            if (sql.includes("name = 'monitor-bot'")) return monitorApp;
            return undefined;
          },
        }),
      }),
    }));
    vi.doMock('../../../src/feishu/api.js', () => ({
      FeishuAPI: class {
        constructor(config: any) {
          constructedConfigs.push(config);
        }

        async sendMessageTo(receiveId: string, receiveIdType: string, messageType: string, content: any) {
          sentMessages.push({ receiveId, receiveIdType, messageType, content });
          return 'om_test';
        }
      },
    }));
    vi.doMock('../../../src/utils/logger.js', () => ({
      log: {
        info: () => {},
        success: () => {},
        warn: () => {},
        error: () => {},
        dim: () => {},
        file: () => {},
        print: () => {},
      },
    }));

    vi.resetModules();
    const registry = await import('../../../src/plugins/registry.js');
    await registry.initPlugins();

    const deliveryCtx = { channel: 'feishu', targetId: 'oc_group_chat', appId: currentApp.id };
    const contextResult = await registry.executePluginTool('plugin_delivery_context', {}, deliveryCtx);
    expect(JSON.parse(contextResult!)).toEqual(deliveryCtx);

    const notifyResult = await registry.executePluginTool(
      'plugin_notify',
      { targetId: 'oc_group_chat', message: 'hello' },
      deliveryCtx,
    );

    expect(JSON.parse(notifyResult!)).toEqual({ ok: true });
    expect(preparedQueries.some(q => q.sql.includes('WHERE id = ?') && q.arg === currentApp.id)).toBe(true);
    expect(constructedConfigs[0]).toEqual({
      appId: currentApp.id,
      appSecret: currentApp.secret,
      verificationToken: 'verify-current',
      encryptKey: 'encrypt-current',
    });
    expect(sentMessages[0]).toEqual({
      receiveId: 'oc_group_chat',
      receiveIdType: 'chat_id',
      messageType: 'text',
      content: { text: 'hello' },
    });

    registry.stopPluginWatcher();
    await registry.stopAllPlugins();
  });

  it('sends Wework plugin notifications through the selected bot queue', async () => {
    pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'samata-plugin-test-'));
    const pluginDir = path.join(pluginRoot, 'delivery-test');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'index.ts'), `
export default {
  name: 'delivery-test',
  description: 'delivery context test plugin',
  toolDefinitions: [
    { name: 'plugin_notify_wework', description: 'sends wework notification', input_schema: { type: 'object', properties: { channel: { type: 'string' }, targetId: { type: 'string' }, message: { type: 'string' } }, required: ['channel', 'targetId', 'message'] } },
  ],
  async handleTool(name, input, ctx) {
    if (name === 'plugin_notify_wework') {
      await ctx.sendNotification(input.channel, input.targetId, input.message);
      return JSON.stringify({ ok: true });
    }
    return null;
  },
};
`);

    process.env.SAMATA_PLUGINS_DIR = pluginRoot;
    process.env.WEWORK_SEND_MIN_INTERVAL_MS = '800';

    const sendMessage = vi.fn().mockResolvedValue({});
    const getConnectedWsClient = vi.fn().mockReturnValue({ sendMessage });

    vi.doMock('../../../src/wework/bot.js', () => ({
      getConnectedWsClient,
    }));
    vi.doMock('../../../src/utils/logger.js', () => ({
      log: {
        info: () => {},
        success: () => {},
        warn: () => {},
        error: () => {},
        dim: () => {},
        file: () => {},
        print: () => {},
      },
    }));

    vi.resetModules();
    const queue = await import('../../../src/wework/notification-queue.js');
    queue.__resetWeworkNotificationQueuesForTests();
    const registry = await import('../../../src/plugins/registry.js');
    await registry.initPlugins();

    const result = await registry.executePluginTool(
      'plugin_notify_wework',
      { channel: 'wework:hedge-bot', targetId: 'gzxujun', message: 'hello' },
      { channel: 'wework', targetId: 'gzxujun', appId: 'hedge-bot' },
    );

    expect(JSON.parse(result!)).toEqual({ ok: true });
    expect(getConnectedWsClient).toHaveBeenCalledWith('hedge-bot');
    expect(sendMessage).toHaveBeenCalledWith('gzxujun', {
      msgtype: 'markdown',
      markdown: { content: 'hello' },
    });

    registry.stopPluginWatcher();
    await registry.stopAllPlugins();
  });
});
