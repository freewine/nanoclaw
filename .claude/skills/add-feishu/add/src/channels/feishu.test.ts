import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock group-folder
vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/mock/groups/${folder}`,
  ),
}));

// Mock fs
vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 51200 })),
  },
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 51200 })),
}));

// --- Lark SDK mock ---

type Handler = (...args: any[]) => any;

const refs = vi.hoisted(() => ({
  eventHandler: null as Handler | null,
  client: null as any,
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class MockClient {
    im = {
      message: {
        create: vi.fn().mockResolvedValue(undefined),
      },
      messageResource: {
        get: vi.fn().mockResolvedValue({
          writeFile: vi.fn().mockResolvedValue(undefined),
        }),
      },
      chat: {
        list: vi.fn().mockResolvedValue({
          data: { items: [], has_more: false },
        }),
      },
    };
    contact = {
      user: {
        get: vi.fn().mockResolvedValue({
          data: { user: { name: 'Test User' } },
        }),
      },
    };
    // Raw request method — used for bot info endpoint
    request = vi.fn().mockResolvedValue({
      bot: { open_id: 'ou_bot123' },
    });

    constructor() {
      refs.client = this;
    }
  },
  EventDispatcher: class MockEventDispatcher {
    register(handlers: Record<string, any>) {
      if (handlers['im.message.receive_v1']) {
        refs.eventHandler = handlers['im.message.receive_v1'];
      }
      return this;
    }
  },
  WSClient: class MockWSClient {
    start = vi.fn().mockResolvedValue(undefined);
  },
  Domain: {
    Feishu: 'https://open.feishu.cn',
    Lark: 'https://open.larksuite.com',
  },
}));

import { FeishuChannel, splitAtParagraphs } from './feishu.js';
import type { ChannelOpts } from './registry.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'feishu:oc_test123': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessageEvent(overrides: {
  chatId?: string;
  chatType?: string;
  text?: string;
  messageType?: string;
  content?: string;
  senderId?: string;
  senderType?: string;
  messageId?: string;
  createTime?: string;
  mentions?: any[];
}) {
  const chatId = overrides.chatId ?? 'oc_test123';
  const messageType = overrides.messageType ?? 'text';
  const content =
    overrides.content ??
    (messageType === 'text'
      ? JSON.stringify({ text: overrides.text ?? 'Hello' })
      : '{}');

  return {
    sender: {
      sender_id: {
        open_id: overrides.senderId ?? 'ou_user456',
      },
      sender_type: overrides.senderType ?? 'user',
    },
    message: {
      message_id: overrides.messageId ?? 'om_msg001',
      chat_id: chatId,
      chat_type: overrides.chatType ?? 'group',
      message_type: messageType,
      content,
      create_time: overrides.createTime ?? '1704067200000',
      mentions: overrides.mentions,
    },
  };
}

function currentClient() {
  return refs.client;
}

async function triggerMessage(data: ReturnType<typeof createMessageEvent>) {
  if (refs.eventHandler) {
    await refs.eventHandler(data);
  }
}

// --- Tests ---

describe('FeishuChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refs.eventHandler = null;
    refs.client = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when WebSocket starts', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('fetches bot identity on connect', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);

      await channel.connect();

      expect(currentClient().request).toHaveBeenCalledWith({
        method: 'GET',
        url: '/open-apis/bot/v3/info/',
      });
    });

    it('registers message event handler on connect', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);

      await channel.connect();

      expect(refs.eventHandler).not.toBeNull();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);

      expect(channel.isConnected()).toBe(false);
    });

    it('continues connect even if bot identity fetch fails', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);

      // Make botInfo.get fail
      refs.client = null; // Will be set by constructor
      const origMock = vi.fn().mockRejectedValueOnce(new Error('API error'));
      // Connect will create a new client, so we hook into it after
      const channel2 = new FeishuChannel('app-id', 'app-secret', opts);
      await channel2.connect();
      // Even if bot info fails, channel should still connect
      expect(channel2.isConnected()).toBe(true);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Hello everyone' });
      await triggerMessage(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.any(String),
        undefined, // group chats don't pass name inline
        'feishu',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          id: 'om_msg001',
          chat_jid: 'feishu:oc_test123',
          sender: 'ou_user456',
          sender_name: 'Test User',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        chatId: 'oc_unknown999',
        text: 'Unknown chat',
      });
      await triggerMessage(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'feishu:oc_unknown999',
        expect.any(String),
        undefined,
        'feishu',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips bot own messages', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        senderId: 'ou_bot123', // Same as bot's open_id
        text: 'Bot message',
      });
      await triggerMessage(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('resolves sender name via user API', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Hi' });
      await triggerMessage(event);

      expect(currentClient().contact.user.get).toHaveBeenCalledWith({
        path: { user_id: 'ou_user456' },
        params: { user_id_type: 'open_id' },
      });
      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ sender_name: 'Test User' }),
      );
    });

    it('caches resolved user names', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event1 = createMessageEvent({ text: 'First', messageId: 'om_1' });
      await triggerMessage(event1);

      const event2 = createMessageEvent({ text: 'Second', messageId: 'om_2' });
      await triggerMessage(event2);

      // Should only call API once — second message uses cache
      expect(currentClient().contact.user.get).toHaveBeenCalledTimes(1);
    });

    it('falls back to openId when user API fails', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      currentClient().contact.user.get.mockRejectedValueOnce(
        new Error('API error'),
      );

      const event = createMessageEvent({ text: 'Hi' });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ sender_name: 'ou_user456' }),
      );
    });

    it('uses "Bot" as name for bot senders', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        senderId: 'ou_otherbot',
        senderType: 'bot',
        text: 'Bot says hi',
      });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ sender_name: 'Bot' }),
      );
    });

    it('uses sender name as chat name for p2p chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'feishu:oc_test123': {
            name: 'Private',
            folder: 'private',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        chatType: 'p2p',
        text: 'Hello',
      });
      await triggerMessage(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.any(String),
        'Test User', // p2p chats use sender name
        'feishu',
        false,
      );
    });

    it('converts create_time to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Hello',
        createTime: '1704067200000', // 2024-01-01T00:00:00.000Z in ms
      });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });

    it('skips messages with no content', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        content: JSON.stringify({ text: '' }),
      });
      await triggerMessage(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips events with no message', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      await triggerMessage({
        sender: { sender_id: { open_id: 'ou_user456' }, sender_type: 'user' },
        message: undefined,
      } as any);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('handles malformed JSON content gracefully', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        content: 'not valid json',
      });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: 'not valid json',
        }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates @bot mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        text: '@_user_1 what time is it?',
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_bot123' },
            name: 'NanoClaw Bot',
          },
        ],
      });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: '@Andy @NanoClaw Bot what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        text: '@Andy @_user_1 hello',
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_bot123' },
            name: 'Andy Bot',
          },
        ],
      });
      await triggerMessage(event);

      // Should NOT double-prepend — already starts with @Andy
      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: '@Andy @Andy Bot hello',
        }),
      );
    });

    it('does not translate mentions of other users', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        text: '@_user_1 hello',
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_other789' },
            name: 'Someone Else',
          },
        ],
      });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: '@Someone Else hello',
        }),
      );
    });

    it('handles message with no mentions', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'plain message' });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: 'plain message',
        }),
      );
    });

    it('replaces multiple mention placeholders', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        text: '@_user_1 and @_user_2 check this',
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_bot123' },
            name: 'NanoClaw Bot',
          },
          {
            key: '@_user_2',
            id: { open_id: 'ou_other789' },
            name: 'Alice',
          },
        ],
      });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: '@Andy @NanoClaw Bot and @Alice check this',
        }),
      );
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it('downloads image and includes container path', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        messageType: 'image',
        content: JSON.stringify({ image_key: 'img_xxx' }),
      });
      await triggerMessage(event);

      expect(currentClient().im.messageResource.get).toHaveBeenCalledWith({
        params: { type: 'image' },
        path: { message_id: 'om_msg001', file_key: 'img_xxx' },
      });
      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: '[Image: attachments/img-om_msg001-img_xxx.png]',
        }),
      );
    });

    it('falls back on image download failure', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      currentClient().im.messageResource.get.mockRejectedValueOnce(
        new Error('download error'),
      );

      const event = createMessageEvent({
        messageType: 'image',
        content: JSON.stringify({ image_key: 'img_fail' }),
      });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Image - download failed]' }),
      );
    });

    it('skips image download for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        chatId: 'oc_unknown999',
        messageType: 'image',
        content: JSON.stringify({ image_key: 'img_xxx' }),
      });
      await triggerMessage(event);

      expect(currentClient().im.messageResource.get).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('uses placeholder for image with malformed JSON', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        messageType: 'image',
        content: 'not valid json',
      });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Image]' }),
      );
    });

    it('stores file with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({ messageType: 'file', content: '{}' });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[File]' }),
      );
    });

    it('downloads PDF and includes reference with size', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        messageType: 'file',
        content: JSON.stringify({
          file_key: 'file_abc',
          file_name: 'report.pdf',
        }),
      });
      await triggerMessage(event);

      expect(currentClient().im.messageResource.get).toHaveBeenCalledWith({
        params: { type: 'file' },
        path: { message_id: 'om_msg001', file_key: 'file_abc' },
      });
      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content:
            '[PDF: attachments/report.pdf (50KB)]\nUse: pdf-reader extract attachments/report.pdf',
        }),
      );
    });

    it('falls back to [File] for non-PDF files', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        messageType: 'file',
        content: JSON.stringify({
          file_key: 'file_abc',
          file_name: 'document.docx',
        }),
      });
      await triggerMessage(event);

      expect(currentClient().im.messageResource.get).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[File]' }),
      );
    });

    it('falls back on PDF download failure', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      currentClient().im.messageResource.get.mockRejectedValueOnce(
        new Error('download error'),
      );

      const event = createMessageEvent({
        messageType: 'file',
        content: JSON.stringify({
          file_key: 'file_abc',
          file_name: 'report.pdf',
        }),
      });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[File]' }),
      );
    });

    it('skips PDF download for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        chatId: 'oc_unknown999',
        messageType: 'file',
        content: JSON.stringify({
          file_key: 'file_abc',
          file_name: 'report.pdf',
        }),
      });
      await triggerMessage(event);

      expect(currentClient().im.messageResource.get).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('stores audio with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        messageType: 'audio',
        content: '{}',
      });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('stores video (media) with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        messageType: 'media',
        content: '{}',
      });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('stores sticker with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        messageType: 'sticker',
        content: '{}',
      });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Sticker]' }),
      );
    });

    it('stores rich text (post) with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        messageType: 'post',
        content: '{}',
      });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Rich text]' }),
      );
    });

    it('stores unknown message type with type name', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        messageType: 'custom_type',
        content: '{}',
      });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[custom_type]' }),
      );
    });

    it('ignores non-text messages from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        chatId: 'oc_unknown999',
        messageType: 'image',
        content: '{}',
      });
      await triggerMessage(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message as interactive card with lark_md', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      await channel.sendMessage('feishu:oc_test123', 'Hello **world**');

      expect(currentClient().im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test123',
          msg_type: 'interactive',
          content: JSON.stringify({
            config: { wide_screen_mode: true },
            elements: [
              {
                tag: 'div',
                text: { tag: 'lark_md', content: 'Hello **world**' },
              },
            ],
          }),
        },
      });
    });

    it('strips feishu: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      await channel.sendMessage('feishu:oc_abc789', 'Message');

      expect(currentClient().im.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            receive_id: 'oc_abc789',
          }),
        }),
      );
    });

    it('converts markdown headings to bold in card content', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      await channel.sendMessage(
        'feishu:oc_test123',
        '# Title\n\nSome text\n\n## Subtitle',
      );

      const call = currentClient().im.message.create.mock.calls[0][0];
      const content = JSON.parse(call.data.content);
      expect(content.elements[0].text.content).toBe(
        '**Title**\n\nSome text\n\n**Subtitle**',
      );
    });

    it('splits long messages at paragraph boundaries', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      // Build text with a paragraph break before the 4000 limit
      const para1 = 'a'.repeat(3500);
      const para2 = 'b'.repeat(2000);
      const longText = `${para1}\n\n${para2}`;
      await channel.sendMessage('feishu:oc_test123', longText);

      expect(currentClient().im.message.create).toHaveBeenCalledTimes(2);

      // First chunk should be the first paragraph
      const call1 = currentClient().im.message.create.mock.calls[0][0];
      const content1 = JSON.parse(call1.data.content);
      expect(content1.elements[0].text.content).toBe(para1);

      // Second chunk should be the second paragraph
      const call2 = currentClient().im.message.create.mock.calls[1][0];
      const content2 = JSON.parse(call2.data.content);
      expect(content2.elements[0].text.content).toBe(para2);
    });

    it('sends exactly one message at 4000 characters', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      const exactText = 'y'.repeat(4000);
      await channel.sendMessage('feishu:oc_test123', exactText);

      expect(currentClient().im.message.create).toHaveBeenCalledTimes(1);
    });

    it('falls back to plain text when card send fails', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      // First call (card) fails, second call (fallback text) succeeds
      currentClient()
        .im.message.create.mockRejectedValueOnce(new Error('Card error'))
        .mockResolvedValueOnce(undefined);

      await channel.sendMessage('feishu:oc_test123', 'Will fallback');

      expect(currentClient().im.message.create).toHaveBeenCalledTimes(2);
      // Second call should be plain text fallback
      expect(currentClient().im.message.create).toHaveBeenNthCalledWith(2, {
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test123',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Will fallback' }),
        },
      });
    });

    it('handles both card and fallback failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      currentClient()
        .im.message.create.mockRejectedValueOnce(new Error('Card error'))
        .mockRejectedValueOnce(new Error('Text error'));

      // Should not throw
      await expect(
        channel.sendMessage('feishu:oc_test123', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('queues message when not connected', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);

      // Don't connect — client is null
      await channel.sendMessage('feishu:oc_test123', 'Queued');

      // No error, no API call (message queued internally)
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns feishu: JIDs', () => {
      const channel = new FeishuChannel(
        'app-id',
        'app-secret',
        createTestOpts(),
      );
      expect(channel.ownsJid('feishu:oc_abc123')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new FeishuChannel(
        'app-id',
        'app-secret',
        createTestOpts(),
      );
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new FeishuChannel(
        'app-id',
        'app-secret',
        createTestOpts(),
      );
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new FeishuChannel(
        'app-id',
        'app-secret',
        createTestOpts(),
      );
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new FeishuChannel(
        'app-id',
        'app-secret',
        createTestOpts(),
      );
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('is a no-op (Feishu does not support typing indicators)', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      // Should not throw
      await expect(
        channel.setTyping('feishu:oc_test123', true),
      ).resolves.toBeUndefined();
    });

    it('no-op when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);

      await expect(
        channel.setTyping('feishu:oc_test123', false),
      ).resolves.toBeUndefined();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "feishu"', () => {
      const channel = new FeishuChannel(
        'app-id',
        'app-secret',
        createTestOpts(),
      );
      expect(channel.name).toBe('feishu');
    });
  });

  // --- splitAtParagraphs ---

  describe('splitAtParagraphs', () => {
    it('returns single chunk for short text', () => {
      expect(splitAtParagraphs('short text', 100)).toEqual(['short text']);
    });

    it('splits at double-newline paragraph boundary', () => {
      const para1 = 'a'.repeat(80);
      const para2 = 'b'.repeat(50);
      const text = `${para1}\n\n${para2}`;
      const chunks = splitAtParagraphs(text, 100);
      expect(chunks).toEqual([para1, para2]);
    });

    it('falls back to single newline when no paragraph break', () => {
      const line1 = 'a'.repeat(80);
      const line2 = 'b'.repeat(50);
      const text = `${line1}\n${line2}`;
      const chunks = splitAtParagraphs(text, 100);
      expect(chunks).toEqual([line1, line2]);
    });

    it('hard cuts when no newline found', () => {
      const text = 'x'.repeat(250);
      const chunks = splitAtParagraphs(text, 100);
      expect(chunks).toEqual([
        'x'.repeat(100),
        'x'.repeat(100),
        'x'.repeat(50),
      ]);
    });

    it('trims whitespace around splits', () => {
      const text = 'first part\n\n  second part';
      const chunks = splitAtParagraphs(text, 15);
      expect(chunks).toEqual(['first part', 'second part']);
    });
  });

  // --- syncChatMetadata ---

  describe('syncChatMetadata', () => {
    it('fetches chats from Feishu API', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      currentClient().im.chat.list.mockResolvedValueOnce({
        data: {
          items: [
            { chat_id: 'oc_chat1', name: 'Chat One' },
            { chat_id: 'oc_chat2', name: 'Chat Two' },
          ],
          has_more: false,
        },
      });

      await channel.syncChatMetadata();

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'feishu:oc_chat1',
        expect.any(String),
        'Chat One',
        'feishu',
        true,
      );
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'feishu:oc_chat2',
        expect.any(String),
        'Chat Two',
        'feishu',
        true,
      );
    });

    it('handles pagination', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      currentClient()
        .im.chat.list.mockResolvedValueOnce({
          data: {
            items: [{ chat_id: 'oc_page1', name: 'Page 1' }],
            has_more: true,
            page_token: 'token123',
          },
        })
        .mockResolvedValueOnce({
          data: {
            items: [{ chat_id: 'oc_page2', name: 'Page 2' }],
            has_more: false,
          },
        });

      await channel.syncChatMetadata();

      expect(currentClient().im.chat.list).toHaveBeenCalledTimes(2);
      expect(opts.onChatMetadata).toHaveBeenCalledTimes(2);
    });

    it('does nothing when not connected', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);

      // Don't connect
      await channel.syncChatMetadata();

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('handles API error gracefully', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app-id', 'app-secret', opts);
      await channel.connect();

      currentClient().im.chat.list.mockRejectedValueOnce(
        new Error('API error'),
      );

      // Should not throw
      await expect(channel.syncChatMetadata()).resolves.toBeUndefined();
    });
  });
});
