import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: lark.Client | null = null;
  private wsClient: any = null;
  private opts: FeishuChannelOpts;
  private appId: string;
  private appSecret: string;
  private domain: string;
  private botOpenId = '';
  private connected = false;
  private userNameCache = new Map<string, string>();
  private outgoingQueue: Array<{ chatId: string; text: string }> = [];

  constructor(
    appId: string,
    appSecret: string,
    opts: FeishuChannelOpts,
    domain = 'feishu',
  ) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.opts = opts;
    this.domain = domain;
  }

  async connect(): Promise<void> {
    const domainConfig =
      this.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: domainConfig,
    });

    // Fetch bot identity
    try {
      const botInfo = await (this.client as any).request({
        method: 'GET',
        url: '/open-apis/bot/v3/info/',
      });
      this.botOpenId = botInfo?.bot?.open_id || '';
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch Feishu bot identity');
    }

    // Set up event dispatcher for incoming messages
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        await this.handleMessage(data);
      },
    });

    // Connect via WebSocket (no public URL needed)
    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: domainConfig,
    });

    await this.wsClient.start({ eventDispatcher });
    this.connected = true;

    logger.info(
      { botOpenId: this.botOpenId },
      'Feishu bot connected via WebSocket',
    );
    console.log(`\n  Feishu bot connected (open_id: ${this.botOpenId})`);
    console.log(`  Messages from registered chats will be processed\n`);

    // Flush any messages queued while disconnected
    await this.flushOutgoingQueue();
  }

  private async handleMessage(data: any): Promise<void> {
    try {
      const message = data.message;
      if (!message) return;

      const chatId = message.chat_id;
      const chatJid = `feishu:${chatId}`;
      const messageType = message.message_type;

      // Feishu create_time is milliseconds since epoch as a string
      const timestamp = new Date(
        parseInt(message.create_time, 10),
      ).toISOString();

      const msgId = message.message_id || '';
      const senderId = data.sender?.sender_id?.open_id || '';
      const senderType = data.sender?.sender_type || '';

      // Skip bot's own messages
      if (senderId === this.botOpenId) return;

      let content = '';
      if (messageType === 'text') {
        try {
          const parsed = JSON.parse(message.content);
          content = parsed.text || '';
        } catch {
          content = message.content || '';
        }
      } else {
        // Non-text message placeholders
        const placeholders: Record<string, string> = {
          image: '[Image]',
          file: '[File]',
          audio: '[Audio]',
          media: '[Video]',
          sticker: '[Sticker]',
          interactive: '[Interactive card]',
          share_chat: '[Shared chat]',
          share_user: '[Shared contact]',
          location: '[Location]',
          post: '[Rich text]',
        };
        content = placeholders[messageType] || `[${messageType}]`;
      }

      // Handle @mentions — translate Feishu @bot mentions to trigger format.
      // Feishu uses placeholder keys like @_user_1 in message text, with a
      // separate mentions array mapping keys to user IDs and display names.
      const mentions = message.mentions || [];
      if (mentions.length > 0) {
        let isBotMentioned = false;
        for (const mention of mentions) {
          if (mention.id?.open_id === this.botOpenId) {
            isBotMentioned = true;
          }
          // Replace @_user_N placeholders with actual names
          if (mention.key && mention.name) {
            content = content.replace(mention.key, `@${mention.name}`);
          }
        }
        // If bot is mentioned and doesn't already match trigger, prepend trigger
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      if (!content) return;

      // Resolve sender name
      const senderName = await this.resolveUserName(senderId, senderType);

      // Determine chat type
      const isGroup = message.chat_type === 'group';
      // For p2p chats, pass sender name as chat name; group names resolved via syncChatMetadata
      const chatName = isGroup ? undefined : senderName;

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'feishu', isGroup);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid }, 'Message from unregistered Feishu chat');
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender: senderId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info({ chatJid, sender: senderName }, 'Feishu message stored');
    } catch (err) {
      logger.error({ err }, 'Error handling Feishu message');
    }
  }

  private async resolveUserName(
    openId: string,
    senderType: string,
  ): Promise<string> {
    if (!openId) return 'Unknown';
    if (senderType === 'bot') return 'Bot';

    const cached = this.userNameCache.get(openId);
    if (cached) return cached;

    if (!this.client) return openId;

    try {
      const resp = await this.client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      });
      const name = resp?.data?.user?.name || openId;
      this.userNameCache.set(openId, name);
      return name;
    } catch (err) {
      logger.debug({ openId, err }, 'Failed to resolve Feishu user name');
      return openId;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client || !this.connected) {
      this.outgoingQueue.push({ chatId: jid.replace(/^feishu:/, ''), text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Feishu disconnected, message queued',
      );
      return;
    }

    try {
      const chatId = jid.replace(/^feishu:/, '');

      // Feishu has a ~30KB limit per message — split at 4000 chars to be safe
      const MAX_LENGTH = 4000;
      if (text.length <= MAX_LENGTH) {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
        });
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text: text.slice(i, i + MAX_LENGTH) }),
            },
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.wsClient = null;
    this.client = null;
    logger.info('Feishu bot stopped');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Feishu Bot API does not support typing indicators — no-op
  }

  /**
   * Sync chat metadata from Feishu.
   * Fetches all bot chats and stores their names in the database.
   * Called on startup and on-demand via IPC.
   */
  async syncChatMetadata(): Promise<void> {
    if (!this.client) return;

    try {
      logger.info('Syncing chat metadata from Feishu...');
      let pageToken: string | undefined;
      let count = 0;

      do {
        const resp = await this.client.im.chat.list({
          params: {
            page_size: 100,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        });

        const items = resp?.data?.items || [];
        for (const chat of items) {
          if (chat.chat_id && chat.name) {
            this.opts.onChatMetadata(
              `feishu:${chat.chat_id}`,
              new Date().toISOString(),
              chat.name,
              'feishu',
              true,
            );
            count++;
          }
        }

        pageToken = resp?.data?.page_token || undefined;
        if (!resp?.data?.has_more) break;
      } while (pageToken);

      logger.info({ count }, 'Feishu chat metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Feishu chat metadata');
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.outgoingQueue.length === 0 || !this.client) return;

    logger.info(
      { count: this.outgoingQueue.length },
      'Flushing Feishu outgoing message queue',
    );
    while (this.outgoingQueue.length > 0) {
      const item = this.outgoingQueue.shift()!;
      try {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: item.chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: item.text }),
          },
        });
      } catch (err) {
        logger.error(
          { chatId: item.chatId, err },
          'Failed to send queued Feishu message',
        );
      }
    }
  }
}
