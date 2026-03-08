import fs from 'fs';
import path from 'path';

import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: lark.Client | null = null;
  private wsClient: any = null;
  private opts: ChannelOpts;
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
    opts: ChannelOpts,
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
      } else if (messageType === 'image') {
        let imageKey = '';
        try {
          const parsed = JSON.parse(message.content);
          imageKey = parsed.image_key || '';
        } catch {
          /* ignore */
        }

        const group = this.opts.registeredGroups()[chatJid];
        if (imageKey && group) {
          const containerPath = await this.downloadImage(
            msgId,
            imageKey,
            group.folder,
          );
          content = containerPath
            ? `[Image: ${containerPath}]`
            : '[Image - download failed]';
        } else {
          content = '[Image]';
        }
      } else if (messageType === 'audio') {
        let fileKey = '';
        try {
          const parsed = JSON.parse(message.content);
          fileKey = parsed.file_key || '';
        } catch {
          /* ignore */
        }

        const group = this.opts.registeredGroups()[chatJid];
        if (fileKey && group) {
          const containerPath = await this.downloadAudio(
            msgId,
            fileKey,
            group.folder,
          );
          content = containerPath
            ? `[Audio: ${containerPath}]`
            : '[Audio - download failed]';
        } else {
          content = '[Audio]';
        }
      } else if (messageType === 'sticker') {
        let fileKey = '';
        try {
          const parsed = JSON.parse(message.content);
          fileKey = parsed.file_key || '';
        } catch {
          /* ignore */
        }

        const group = this.opts.registeredGroups()[chatJid];
        if (fileKey && group) {
          const containerPath = await this.downloadSticker(
            msgId,
            fileKey,
            group.folder,
          );
          content = containerPath
            ? `[Sticker: ${containerPath}]`
            : '[Sticker - download failed]';
        } else {
          content = '[Sticker]';
        }
      } else if (messageType === 'file') {
        let fileKey = '';
        let fileName = '';
        try {
          const parsed = JSON.parse(message.content);
          fileKey = parsed.file_key || '';
          fileName = parsed.file_name || '';
        } catch {
          /* ignore */
        }

        const group = this.opts.registeredGroups()[chatJid];
        if (fileKey && group) {
          const result = await this.downloadFile(
            msgId,
            fileKey,
            fileName,
            group.folder,
          );
          if (result) {
            if (fileName.toLowerCase().endsWith('.pdf')) {
              content = `[PDF: ${result.relativePath} (${result.sizeKB}KB)]\nUse: pdf-reader extract ${result.relativePath}`;
            } else {
              content = `[File: ${result.relativePath} (${result.sizeKB}KB)]`;
            }
          } else {
            content = '[File - download failed]';
          }
        } else {
          content = '[File]';
        }
      } else {
        // Non-text message placeholders
        const placeholders: Record<string, string> = {
          media: '[Video]',
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

  private async downloadImage(
    messageId: string,
    imageKey: string,
    groupFolder: string,
  ): Promise<string | null> {
    if (!this.client) return null;
    const groupDir = resolveGroupFolderPath(groupFolder);
    const attachDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });
    const filename = `img-${messageId}-${imageKey}.png`;
    const hostPath = path.join(attachDir, filename);
    try {
      const resp = await this.client.im.messageResource.get({
        params: { type: 'image' },
        path: { message_id: messageId, file_key: imageKey },
      });
      await (resp as any).writeFile(hostPath);
      return `attachments/${filename}`;
    } catch (err) {
      logger.error(
        { messageId, imageKey, err },
        'Failed to download Feishu image',
      );
      return null;
    }
  }

  private async downloadAudio(
    messageId: string,
    fileKey: string,
    groupFolder: string,
  ): Promise<string | null> {
    if (!this.client) return null;
    const groupDir = resolveGroupFolderPath(groupFolder);
    const attachDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });
    const filename = `audio-${messageId}-${fileKey}.opus`;
    const hostPath = path.join(attachDir, filename);
    try {
      const resp = await this.client.im.messageResource.get({
        params: { type: 'file' },
        path: { message_id: messageId, file_key: fileKey },
      });
      await (resp as any).writeFile(hostPath);
      return `attachments/${filename}`;
    } catch (err) {
      logger.error(
        { messageId, fileKey, err },
        'Failed to download Feishu audio',
      );
      return null;
    }
  }

  private async downloadSticker(
    messageId: string,
    fileKey: string,
    groupFolder: string,
  ): Promise<string | null> {
    if (!this.client) return null;
    const groupDir = resolveGroupFolderPath(groupFolder);
    const attachDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });
    const filename = `sticker-${messageId}-${fileKey}.png`;
    const hostPath = path.join(attachDir, filename);
    try {
      const resp = await this.client.im.messageResource.get({
        params: { type: 'image' },
        path: { message_id: messageId, file_key: fileKey },
      });
      await (resp as any).writeFile(hostPath);
      return `attachments/${filename}`;
    } catch (err) {
      logger.error(
        { messageId, fileKey, err },
        'Failed to download Feishu sticker',
      );
      return null;
    }
  }

  private async downloadFile(
    messageId: string,
    fileKey: string,
    fileName: string,
    groupFolder: string,
  ): Promise<{ relativePath: string; sizeKB: number } | null> {
    if (!this.client) return null;
    const groupDir = resolveGroupFolderPath(groupFolder);
    const attachDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });
    const hostPath = path.join(attachDir, fileName);
    try {
      const resp = await this.client.im.messageResource.get({
        params: { type: 'file' },
        path: { message_id: messageId, file_key: fileKey },
      });
      await (resp as any).writeFile(hostPath);
      const stats = fs.statSync(hostPath);
      const sizeKB = Math.round(stats.size / 1024);
      return { relativePath: `attachments/${fileName}`, sizeKB };
    } catch (err) {
      logger.error(
        { messageId, fileKey, err },
        'Failed to download Feishu file',
      );
      return null;
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

    const chatId = jid.replace(/^feishu:/, '');

    // Feishu interactive cards have a ~30KB limit — split at 4000 chars to be safe
    const MAX_LENGTH = 4000;
    const chunks =
      text.length <= MAX_LENGTH ? [text] : splitAtParagraphs(text, MAX_LENGTH);

    for (const chunk of chunks) {
      try {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: this.buildCardContent(chunk),
          },
        });
      } catch (err) {
        // Fall back to plain text if card send fails
        logger.warn(
          { jid, err },
          'Card send failed, falling back to plain text',
        );
        try {
          await this.client!.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text: chunk }),
            },
          });
        } catch (fallbackErr) {
          logger.error(
            { jid, err: fallbackErr },
            'Failed to send Feishu message (fallback)',
          );
        }
      }
    }
    logger.info({ jid, length: text.length }, 'Feishu message sent');
  }

  private buildCardContent(markdown: string): string {
    // Convert markdown headings to bold (lark_md doesn't support # headings)
    const sanitized = markdown.replace(/^#{1,6}\s+(.+)$/gm, '**$1**');
    return JSON.stringify({
      config: { wide_screen_mode: true },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: sanitized } }],
    });
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

  async sendAudio(jid: string, audioPath: string): Promise<void> {
    if (!this.client || !this.connected) {
      logger.warn({ jid }, 'Feishu disconnected, cannot send audio');
      return;
    }

    const chatId = jid.replace(/^feishu:/, '');

    try {
      // Upload audio file to Feishu
      const uploadResp = await this.client.im.file.create({
        data: {
          file_type: 'opus',
          file_name: path.basename(audioPath),
          file: fs.createReadStream(audioPath),
        },
      });

      const respData = uploadResp as any;
      const fileKey = (respData?.data?.file_key || respData?.file_key) as string | undefined;
      if (!fileKey) {
        logger.error(
          { jid, audioPath, resp: JSON.stringify(respData).slice(0, 500) },
          'Feishu file upload returned no file_key',
        );
        return;
      }

      // Send as audio message
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'audio',
          content: JSON.stringify({ file_key: fileKey }),
        },
      });

      logger.info({ jid, audioPath }, 'Feishu audio message sent');
    } catch (err) {
      logger.error({ jid, audioPath, err }, 'Failed to send Feishu audio message');
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Feishu Bot API does not support typing indicators — no-op
  }

  async syncGroups(_force: boolean): Promise<void> {
    return this.syncChatMetadata();
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
      await this.sendMessage(`feishu:${item.chatId}`, item.text);
    }
  }
}

/** Split long text at paragraph boundaries instead of mid-sentence. */
export function splitAtParagraphs(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIdx = -1;

    // Try splitting at double-newline (paragraph break)
    const paraSearch = remaining.lastIndexOf('\n\n', maxLength);
    if (paraSearch > 0) {
      splitIdx = paraSearch;
    }

    // Fall back to single newline
    if (splitIdx <= 0) {
      const lineSearch = remaining.lastIndexOf('\n', maxLength);
      if (lineSearch > 0) {
        splitIdx = lineSearch;
      }
    }

    // Hard cut if no newline found
    if (splitIdx <= 0) {
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

registerChannel('feishu', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_DOMAIN',
  ]);
  const appId = process.env.FEISHU_APP_ID || envVars.FEISHU_APP_ID || '';
  const appSecret =
    process.env.FEISHU_APP_SECRET || envVars.FEISHU_APP_SECRET || '';
  if (!appId || !appSecret) {
    logger.warn('Feishu: FEISHU_APP_ID or FEISHU_APP_SECRET not set');
    return null;
  }
  const domain = process.env.FEISHU_DOMAIN || envVars.FEISHU_DOMAIN || 'feishu';
  return new FeishuChannel(appId, appSecret, opts, domain);
});
