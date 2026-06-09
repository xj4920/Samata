import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { useUnitDb } from '../../helpers/unit-harness.js';

describe('deferred and idempotent delivery', () => {
  const unit = useUnitDb();
  let filePath = '';

  beforeEach(async () => {
    const { getArtifactRoot } = await import('../../../src/commands/artifact.js');
    filePath = path.join(getArtifactRoot(), `delivery-test-${Date.now()}.txt`);
    fs.writeFileSync(filePath, 'same content', 'utf-8');
    const { resetDeliveryDedupForTests } = await import('../../../src/commands/delivery.js');
    resetDeliveryDedupForTests();
  });

  afterEach(async () => {
    try { fs.unlinkSync(filePath); } catch {}
    const { resetDeliveryDedupForTests } = await import('../../../src/commands/delivery.js');
    resetDeliveryDedupForTests();
    vi.restoreAllMocks();
  });

  it('queues send_file when a deferred delivery context is present', async () => {
    const queued: Array<{ mode: 'file' | 'image'; path: string }> = [];
    const { sendFileToCurrentChannel } = await import('../../../src/commands/delivery.js');

    const result = await sendFileToCurrentChannel({ path: filePath }, {
      channel: 'feishu',
      targetId: 'oc_test',
      appId: 'test_app',
      deferredDelivery: {
        runId: 'run_1',
        isCurrent: () => true,
        enqueue: (mode, p) => {
          queued.push({ mode, path: p });
          return { success: true, channel: 'feishu', filename: path.basename(p), queued: true };
        },
      },
    });

    expect(result).toEqual({
      success: true,
      channel: 'feishu',
      filename: path.basename(filePath),
      queued: true,
    });
    expect(queued).toEqual([{ mode: 'file', path: filePath }]);
  });

  it('deduplicates repeated direct sends with identical file content', async () => {
    unit.db.prepare(
      `INSERT INTO bot_apps (id, channel, name, secret, config, show_thinking, auto_start)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('test_app', 'feishu', 'test-bot', 'test-secret', '{}', 1, 1);

    const { FeishuAPI } = await import('../../../src/feishu/api.js');
    const uploadSpy = vi.spyOn(FeishuAPI.prototype, 'uploadFile').mockResolvedValue('file_key_test');
    const sendSpy = vi.spyOn(FeishuAPI.prototype, 'sendMessageTo').mockResolvedValue('om_test');
    const { sendFileToCurrentChannel } = await import('../../../src/commands/delivery.js');

    const ctx = { channel: 'feishu' as const, targetId: 'oc_test', appId: 'test_app' };
    const first = await sendFileToCurrentChannel({ path: filePath }, ctx);
    const second = await sendFileToCurrentChannel({ path: filePath }, ctx);

    expect(first).toMatchObject({ success: true, channel: 'feishu', filename: path.basename(filePath) });
    expect(second).toMatchObject({ success: true, already_sent: true });
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});
