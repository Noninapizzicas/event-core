/**
 * Telegram Service Module v3.0
 * Multi-bot management with credential-manager integration
 *
 * Features:
 * - Centralized multi-bot management
 * - Auto-start/stop via credential-manager events
 * - Polling-based (no webhook needed)
 * - Rate-limited message queue
 * - All events include botName for filtering
 */

const path = require('path');
const fs = require('fs').promises;
const TelegramClient = require('./services/telegram-client');

// Event names
const EVENTS = {
  TEXT_RECEIVED: 'telegram.text.received',
  PHOTO_RECEIVED: 'telegram.photo.received',
  DOCUMENT_RECEIVED: 'telegram.document.received',
  VIDEO_RECEIVED: 'telegram.video.received',
  AUDIO_RECEIVED: 'telegram.audio.received',
  VOICE_RECEIVED: 'telegram.voice.received',
  LOCATION_RECEIVED: 'telegram.location.received',
  CONTACT_RECEIVED: 'telegram.contact.received',
  COMMAND_RECEIVED: 'telegram.command.received',
  CALLBACK_RECEIVED: 'telegram.callback.received',
  MESSAGE_SENT: 'telegram.message.sent',
  SEND_FAILED: 'telegram.send.failed',
  BOT_STARTED: 'telegram.bot.started',
  BOT_STOPPED: 'telegram.bot.stopped',
  BOT_ERROR: 'telegram.bot.error',
  QUEUE_OVERFLOW: 'telegram.queue.overflow'
};

// Credential pattern: TELEGRAM_API_KEY_{type}_{botName}
// Supports BOT and CUSTOM types (credential-manager uses CUSTOM for custom credentials)
const CREDENTIAL_PATTERN = /^TELEGRAM_API_KEY_(?:BOT|CUSTOM)_(.+)$/;

class TelegramServiceModule {
  constructor() {
    this.name = 'telegram-service';
    this.version = '3.0.0';

    // Dependencies
    this.logger = null;
    this.metrics = null;
    this.eventBus = null;
    this.config = null;

    // Multi-bot state
    this.bots = new Map(); // botName -> TelegramClient

    // Unsubscribe functions
    this.unsubscribes = [];
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(core) {
    this.logger = core.logger;
    this.metrics = core.metrics;
    this.eventBus = core.eventBus;

    // Load config from module.json
    const moduleJsonPath = path.join(__dirname, 'module.json');
    const moduleJson = JSON.parse(await fs.readFile(moduleJsonPath, 'utf-8'));
    this.config = moduleJson.config || {};

    this.logger.info('module.loading', {
      module: this.name,
      version: this.version
    });

    // Event subscriptions are auto-wired by the loader from module.json

    // Load existing Telegram credentials
    await this.loadExistingBots();

    this.logger.info('module.loaded', {
      module: this.name,
      version: this.version,
      activeBots: this.bots.size
    });
  }

  async onUnload() {
    this.logger.info('module.unloading', { module: this.name });

    // Stop all bots
    for (const [botName, client] of this.bots) {
      this.logger.info('telegram.bot.stopping', { botName });
      client.stopPolling();
    }
    this.bots.clear();

    // Event subscriptions are auto-cleaned by the loader
    this.logger.info('module.unloaded', { module: this.name });
  }

  // ==========================================
  // Request Event Handlers (wired by loader from module.json)
  // ==========================================

  async onSendMessageRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, botName, chatId, text, parseMode, replyMarkup } = data;

    this.logger.info('telegram.send_message.request', { botName, chatId, request_id });

    const result = await this.handleToolSendMessage({ botName, chatId, text, parseMode, replyMarkup });

    // Publish response
    await this.eventBus.publish('telegram.send_message.response', {
      request_id,
      ...result
    });
  }

  async onGetFileRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, botName, fileId, download, destPath, _meta } = data;

    this.logger.info('telegram.get_file.request', { botName, fileId, request_id, destPath });

    const result = await this.handleToolGetFile({ botName, fileId, download, destPath });

    // Publish response - include botName and _meta for handler chaining
    await this.eventBus.publish('telegram.get_file.response', {
      request_id,
      botName,
      _meta,
      ...result
    });
  }

  async onSendPhotoRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, botName, chatId, photo, caption } = data;

    this.logger.info('telegram.send_photo.request', { botName, chatId, request_id });

    const result = await this.handleToolSendPhoto({ botName, chatId, photo, caption });

    await this.eventBus.publish('telegram.send_photo.response', {
      request_id,
      ...result
    });
  }

  async onSendDocumentRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, botName, chatId, document, caption } = data;

    this.logger.info('telegram.send_document.request', { botName, chatId, request_id });

    const result = await this.handleToolSendDocument({ botName, chatId, document, caption });

    await this.eventBus.publish('telegram.send_document.response', {
      request_id,
      ...result
    });
  }

  async onSendVideoRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, botName, chatId, video, caption } = data;

    this.logger.info('telegram.send_video.request', { botName, chatId, request_id });

    const result = await this.handleToolSendVideo({ botName, chatId, video, caption });

    await this.eventBus.publish('telegram.send_video.response', {
      request_id,
      ...result
    });
  }

  async onSendLocationRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, botName, chatId, latitude, longitude } = data;

    this.logger.info('telegram.send_location.request', { botName, chatId, request_id });

    const result = await this.handleToolSendLocation({ botName, chatId, latitude, longitude });

    await this.eventBus.publish('telegram.send_location.response', {
      request_id,
      ...result
    });
  }

  async onEditMessageRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, botName, chatId, messageId, text } = data;

    this.logger.info('telegram.edit_message.request', { botName, chatId, messageId, request_id });

    const result = await this.handleToolEditMessage({ botName, chatId, messageId, text });

    await this.eventBus.publish('telegram.edit_message.response', {
      request_id,
      ...result
    });
  }

  async onDeleteMessageRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, botName, chatId, messageId } = data;

    this.logger.info('telegram.delete_message.request', { botName, chatId, messageId, request_id });

    const result = await this.handleToolDeleteMessage({ botName, chatId, messageId });

    await this.eventBus.publish('telegram.delete_message.response', {
      request_id,
      ...result
    });
  }

  async onAnswerCallbackRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, botName, callbackId, text, showAlert } = data;

    this.logger.info('telegram.answer_callback.request', { botName, callbackId, request_id });

    const result = await this.handleToolAnswerCallback({ botName, callbackId, text, showAlert });

    await this.eventBus.publish('telegram.answer_callback.response', {
      request_id,
      ...result
    });
  }

  async onGetChatRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, botName, chatId } = data;

    this.logger.info('telegram.get_chat.request', { botName, chatId, request_id });

    const result = await this.handleToolGetChat({ botName, chatId });

    await this.eventBus.publish('telegram.get_chat.response', {
      request_id,
      ...result
    });
  }

  async onSetCommandsRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, botName, commands } = data;

    this.logger.info('telegram.set_commands.request', { botName, request_id });

    const result = await this.handleToolSetCommands({ botName, commands });

    await this.eventBus.publish('telegram.set_commands.response', {
      request_id,
      ...result
    });
  }

  async onListBotsRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id } = data;

    this.logger.info('telegram.list_bots.request', { request_id });

    const result = await this.handleToolListBots({});

    await this.eventBus.publish('telegram.list_bots.response', {
      request_id,
      ...result
    });
  }

  // ==========================================
  // Credential Event Handlers
  // ==========================================

  async loadExistingBots() {
    // Scan process.env for existing Telegram bot tokens
    for (const [key, value] of Object.entries(process.env)) {
      const match = key.match(CREDENTIAL_PATTERN);
      if (match && value) {
        const botName = match[1];
        await this.startBot(botName, value);
      }
    }
  }

  async onCredentialSaved(event) {
    const data = event?.data || event?.payload || event;
    const { key, provider, level } = data;

    // Only handle Telegram BOT credentials
    if (provider !== 'TELEGRAM' || level !== 'BOT') return;

    const match = key?.match(CREDENTIAL_PATTERN);
    if (!match) return;

    const botName = match[1];
    const token = process.env[key];

    if (!token) {
      this.logger.warn('telegram.credential.no_token', { key, botName });
      return;
    }

    this.logger.info('telegram.credential.saved', { botName });

    // Stop existing bot if any
    if (this.bots.has(botName)) {
      await this.stopBot(botName);
    }

    // Start new bot
    await this.startBot(botName, token);
  }

  async onCredentialDeleted(event) {
    const data = event?.data || event?.payload || event;
    const { key } = data;

    const match = key?.match(CREDENTIAL_PATTERN);
    if (!match) return;

    const botName = match[1];
    this.logger.info('telegram.credential.deleted', { botName });

    await this.stopBot(botName);
  }

  // ==========================================
  // Bot Management
  // ==========================================

  async startBot(botName, token) {
    if (this.bots.has(botName)) {
      this.logger.warn('telegram.bot.already_running', { botName });
      return;
    }

    try {
      const client = new TelegramClient(token, botName, {
        pollingInterval: this.config.pollingInterval || 1000,
        rateLimitPerSecond: this.config.rateLimitPerSecond || 25,
        maxQueueSize: this.config.maxQueueSize || 100
      });

      // Wire up client events to eventBus
      this.wireClientEvents(client, botName);

      // Start polling
      await client.startPolling();

      this.bots.set(botName, client);
      this.updateMetrics();

      this.logger.info('telegram.bot.started', {
        botName,
        username: client.botInfo?.username
      });

      await this.eventBus.publish(EVENTS.BOT_STARTED, {
        botName,
        username: client.botInfo?.username
      });

      this.metrics?.increment('telegram.bots.started.total');

    } catch (error) {
      this.logger.error('telegram.bot.start_failed', {
        botName,
        error: error.message
      });

      await this.eventBus.publish(EVENTS.BOT_ERROR, {
        botName,
        reason: 'start_failed',
        error: error.message
      });

      this.metrics?.increment('telegram.errors.total');
    }
  }

  async stopBot(botName) {
    const client = this.bots.get(botName);
    if (!client) return;

    client.stopPolling();
    this.bots.delete(botName);
    this.updateMetrics();

    this.logger.info('telegram.bot.stopped', { botName });

    await this.eventBus.publish(EVENTS.BOT_STOPPED, { botName });
    this.metrics?.increment('telegram.bots.stopped.total');
  }

  wireClientEvents(client, botName) {
    // Map client events to eventBus events
    const eventMap = {
      'text': EVENTS.TEXT_RECEIVED,
      'photo': EVENTS.PHOTO_RECEIVED,
      'document': EVENTS.DOCUMENT_RECEIVED,
      'video': EVENTS.VIDEO_RECEIVED,
      'audio': EVENTS.AUDIO_RECEIVED,
      'voice': EVENTS.VOICE_RECEIVED,
      'location': EVENTS.LOCATION_RECEIVED,
      'contact': EVENTS.CONTACT_RECEIVED,
      'command': EVENTS.COMMAND_RECEIVED,
      'callback': EVENTS.CALLBACK_RECEIVED
    };

    for (const [clientEvent, busEvent] of Object.entries(eventMap)) {
      client.on(clientEvent, async (data) => {
        await this.eventBus.publish(busEvent, data);
        this.metrics?.increment('telegram.messages.received.total');
      });
    }

    // Error events
    client.on('error', async (data) => {
      await this.eventBus.publish(EVENTS.BOT_ERROR, data);
      this.metrics?.increment('telegram.errors.total');
    });

    // Queue overflow
    client.on('queue_overflow', async (data) => {
      await this.eventBus.publish(EVENTS.QUEUE_OVERFLOW, data);
    });
  }

  updateMetrics() {
    // Bots count logged, no gauge needed
  }

  // ==========================================
  // Tool Handlers
  // ==========================================

  getBot(botName) {
    const client = this.bots.get(botName);
    if (!client) {
      throw new Error(`Bot not found: ${botName}`);
    }
    return client;
  }

  async handleToolSendMessage(args) {
    const { botName, chatId, text, parseMode, replyMarkup } = args;

    try {
      const client = this.getBot(botName);
      const result = await client.sendMessage(chatId, text, { parseMode, replyMarkup });

      await this.eventBus.publish(EVENTS.MESSAGE_SENT, {
        botName,
        chatId,
        messageId: result.message_id,
        type: 'text'
      });

      this.metrics?.increment('telegram.messages.sent.total');

      return {
        success: true,
        messageId: result.message_id,
        message: `Mensaje enviado a chat ${chatId}`
      };
    } catch (error) {
      await this.eventBus.publish(EVENTS.SEND_FAILED, {
        botName,
        chatId,
        reason: error.message
      });
      return { success: false, error: error.message };
    }
  }

  async handleToolSendPhoto(args) {
    const { botName, chatId, photo, caption } = args;

    try {
      const client = this.getBot(botName);
      const result = await client.sendPhoto(chatId, photo, { caption });

      await this.eventBus.publish(EVENTS.MESSAGE_SENT, {
        botName,
        chatId,
        messageId: result.message_id,
        type: 'photo'
      });

      this.metrics?.increment('telegram.messages.sent.total');

      return {
        success: true,
        messageId: result.message_id,
        message: `Foto enviada a chat ${chatId}`
      };
    } catch (error) {
      await this.eventBus.publish(EVENTS.SEND_FAILED, {
        botName,
        chatId,
        reason: error.message
      });
      return { success: false, error: error.message };
    }
  }

  async handleToolSendDocument(args) {
    const { botName, chatId, document, caption } = args;

    try {
      const client = this.getBot(botName);
      const result = await client.sendDocument(chatId, document, { caption });

      await this.eventBus.publish(EVENTS.MESSAGE_SENT, {
        botName,
        chatId,
        messageId: result.message_id,
        type: 'document'
      });

      this.metrics?.increment('telegram.messages.sent.total');

      return {
        success: true,
        messageId: result.message_id,
        message: `Documento enviado a chat ${chatId}`
      };
    } catch (error) {
      await this.eventBus.publish(EVENTS.SEND_FAILED, {
        botName,
        chatId,
        reason: error.message
      });
      return { success: false, error: error.message };
    }
  }

  async handleToolSendVideo(args) {
    const { botName, chatId, video, caption } = args;

    try {
      const client = this.getBot(botName);
      const result = await client.sendVideo(chatId, video, { caption });

      await this.eventBus.publish(EVENTS.MESSAGE_SENT, {
        botName,
        chatId,
        messageId: result.message_id,
        type: 'video'
      });

      this.metrics?.increment('telegram.messages.sent.total');

      return {
        success: true,
        messageId: result.message_id,
        message: `Video enviado a chat ${chatId}`
      };
    } catch (error) {
      await this.eventBus.publish(EVENTS.SEND_FAILED, {
        botName,
        chatId,
        reason: error.message
      });
      return { success: false, error: error.message };
    }
  }

  async handleToolSendLocation(args) {
    const { botName, chatId, latitude, longitude } = args;

    try {
      const client = this.getBot(botName);
      const result = await client.sendLocation(chatId, latitude, longitude);

      await this.eventBus.publish(EVENTS.MESSAGE_SENT, {
        botName,
        chatId,
        messageId: result.message_id,
        type: 'location'
      });

      this.metrics?.increment('telegram.messages.sent.total');

      return {
        success: true,
        messageId: result.message_id,
        message: `Ubicación enviada a chat ${chatId}`
      };
    } catch (error) {
      await this.eventBus.publish(EVENTS.SEND_FAILED, {
        botName,
        chatId,
        reason: error.message
      });
      return { success: false, error: error.message };
    }
  }

  async handleToolEditMessage(args) {
    const { botName, chatId, messageId, text } = args;

    try {
      const client = this.getBot(botName);
      await client.editMessageText(chatId, messageId, text);

      return {
        success: true,
        message: `Mensaje ${messageId} editado`
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async handleToolDeleteMessage(args) {
    const { botName, chatId, messageId } = args;

    try {
      const client = this.getBot(botName);
      await client.deleteMessage(chatId, messageId);

      return {
        success: true,
        message: `Mensaje ${messageId} eliminado`
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async handleToolAnswerCallback(args) {
    const { botName, callbackId, text, showAlert } = args;

    try {
      const client = this.getBot(botName);
      await client.answerCallbackQuery(callbackId, { text, showAlert });

      return {
        success: true,
        message: 'Callback respondido'
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async handleToolGetFile(args) {
    const { botName, fileId, download, destPath: requestedPath } = args;

    try {
      const client = this.getBot(botName);
      const file = await client.getFile(fileId);

      const result = {
        success: true,
        fileId: file.file_id,
        filePath: file.file_path,
        fileSize: file.file_size,
        downloadUrl: client.getFileUrl(file.file_path)
      };

      if (download) {
        // Use requested destPath if provided, otherwise generate default
        const destPath = requestedPath || path.join(
          this.config.storagePath || './data/bots',
          botName,
          'received',
          path.basename(file.file_path)
        );
        // Ensure directory exists
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await client.downloadFile(fileId, destPath);
        result.localPath = destPath;
      }

      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async handleToolGetChat(args) {
    const { botName, chatId } = args;

    try {
      const client = this.getBot(botName);
      const chat = await client.getChat(chatId);

      return {
        success: true,
        chat: {
          id: chat.id,
          type: chat.type,
          title: chat.title,
          username: chat.username,
          firstName: chat.first_name,
          lastName: chat.last_name
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async handleToolSetCommands(args) {
    const { botName, commands } = args;

    try {
      const client = this.getBot(botName);
      await client.setMyCommands(commands);

      return {
        success: true,
        message: `${commands.length} comandos configurados`
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async handleToolListBots(args) {
    const bots = [];

    for (const [botName, client] of this.bots) {
      bots.push({
        botName,
        username: client.botInfo?.username,
        polling: client.isPolling(),
        queueSize: client.getQueueSize()
      });
    }

    return {
      success: true,
      bots,
      total: bots.length
    };
  }
}

module.exports = TelegramServiceModule;
