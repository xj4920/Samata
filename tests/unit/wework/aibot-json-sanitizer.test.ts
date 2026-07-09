import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createWsClient,
  escapeJsonStringControlChars,
  installWeworkJsonControlCharPatch,
  parseWeworkWsJsonFrame,
} from '../../../src/wework/aibot-ws.js';

describe('wework ai bot JSON control character sanitizer', () => {
  it('parses raw FIX SOH separators inside text content', () => {
    const raw = '{"cmd":"aibot_msg_callback","body":{"msgtype":"text","text":{"content":"8=FIX.4.2\x019=0100"}}}';

    const frame = parseWeworkWsJsonFrame(raw) as any;

    expect(frame.body.text.content).toBe('8=FIX.4.2\x019=0100');
  });

  it('escapes multiple string control characters while preserving ordinary JSON whitespace', () => {
    const raw = '{\n\t"body":{"text":{"content":"a\x00b\tc\nd"}}\n}';

    const escaped = escapeJsonStringControlChars(raw);
    const frame = JSON.parse(escaped) as any;

    expect(frame.body.text.content).toBe('a\x00b\tc\nd');
    expect(escaped.startsWith('{\n\t')).toBe(true);
  });

  it('does not rewrite already escaped content', () => {
    const raw = '{"body":{"text":{"content":"a\\u0001b"}}}';

    expect(escapeJsonStringControlChars(raw)).toBe(raw);
    expect((parseWeworkWsJsonFrame(raw) as any).body.text.content).toBe('a\x01b');
  });

  it('still rejects malformed JSON unrelated to control characters', () => {
    const raw = '{"body":{"text":{"content":"abc",}}}';

    expect(() => parseWeworkWsJsonFrame(raw)).toThrow(SyntaxError);
  });

  it('lets the SDK message path dispatch text messages after patching', () => {
    installWeworkJsonControlCharPatch();
    const client = createWsClient('aib-unit-test-bot', 'secret');
    const wsManager = (client as any).wsManager;
    const fakeWs = new EventEmitter() as EventEmitter & { pong: ReturnType<typeof vi.fn> };
    const handler = vi.fn();
    fakeWs.pong = vi.fn();
    wsManager.ws = fakeWs;
    wsManager.setupEventHandlers();
    client.on('message.text', handler);

    const raw = '{"cmd":"aibot_msg_callback","headers":{"req_id":"req-unit"},"body":{"msgid":"msg-unit","msgtype":"text","from":{"userid":"gzxujun"},"text":{"content":"35=8\x01150=1"}}}';
    fakeWs.emit('message', Buffer.from(raw));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].body.text.content).toBe('35=8\x01150=1');
  });
});
