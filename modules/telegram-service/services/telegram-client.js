/**
 * Telegram Bot API Client v3.0
 * Multi-bot support with polling and rate limiting
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class TelegramClient extends EventEmitter {
  constructor(botToken, botName, options = {}) {
    super();

    this.botToken = botToken;
    this.botName = botName;
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${botToken}`;

    // Polling state
    this.polling = false;
    this.pollingInterval = options.pollingInterval || 1000;
    this.lastUpdateId = 0;
    this.pollingTimeout = null;

    // Rate limiting
    this.rateLimitPerSecond = options.rateLimitPerSecond || 25;
    this.maxQueueSize = options.maxQueueSize || 100;
    this.sendQueue = [];
    this.sending = false;
    this.lastSendTime = 0;
    this.sendInterval = 1000 / this.rateLimitPerSecond;

    // Bot info
    this.botInfo = null;
  }

  // ==========================================
  // Polling
  // ==========================================

  async startPolling() {
    if (this.polling) return;

    try {
      // Get bot info first
      this.botInfo = await this.getMe();
      this.polling = true;
      this.emit('started', { botName: this.botName, username: this.botInfo.username });
      this.poll();
    } catch (error) {
      this.emit('error', { botName: this.botName, error: error.message, reason: 'start_failed' });
      throw error;
    }
  }

  stopPolling() {
    this.polling = false;
    if (this.pollingTimeout) {
      clearTimeout(this.pollingTimeout);
      this.pollingTimeout = null;
    }
    this.emit('stopped', { botName: this.botName });
  }

  async poll() {
    if (!this.polling) return;

    try {
      const updates = await this.getUpdates(this.lastUpdateId + 1);

      for (const update of updates) {
        this.lastUpdateId = update.update_id;
        this.processUpdate(update);
      }
    } catch (error) {
      // Don't emit error for network timeouts during polling
      if (!error.message.includes('ETIMEDOUT')) {
        this.emit('error', { botName: this.botName, error: error.message, reason: 'polling_error' });
      }
    }

    // Schedule next poll
    if (this.polling) {
      this.pollingTimeout = setTimeout(() => this.poll(), this.pollingInterval);
    }
  }

  async getUpdates(offset = 0, timeout = 30) {
    return this.request('getUpdates', {
      offset,
      timeout,
      allowed_updates: ['message', 'callback_query', 'edited_message']
    });
  }

  processUpdate(update) {
    const baseData = {
      botName: this.botName,
      timestamp: new Date().toISOString()
    };

    // Callback query (button press)
    if (update.callback_query) {
      const cb = update.callback_query;
      this.emit('callback', {
        ...baseData,
        chatId: cb.message?.chat?.id,
        messageId: cb.message?.message_id,
        callbackId: cb.id,
        data: cb.data,
        from: this.extractFrom(cb.from)
      });
      return;
    }

    // Message
    const message = update.message || update.edited_message;
    if (!message) return;

    const msgBase = {
      ...baseData,
      chatId: message.chat.id,
      messageId: message.message_id,
      from: this.extractFrom(message.from)
    };

    // Command
    if (message.text && message.text.startsWith('/')) {
      const parts = message.text.split(' ');
      const command = parts[0].substring(1).split('@')[0]; // Remove / and @botname
      const args = parts.slice(1);
      this.emit('command', { ...msgBase, command, args, text: message.text });
      return;
    }

    // Text
    if (message.text) {
      this.emit('text', { ...msgBase, text: message.text });
      return;
    }

    // Photo (Telegram always compresses to JPEG)
    if (message.photo) {
      const bestPhoto = message.photo[message.photo.length - 1];
      this.emit('photo', {
        ...msgBase,
        fileId: bestPhoto.file_id,
        fileSize: bestPhoto.file_size,
        width: bestPhoto.width,
        height: bestPhoto.height,
        mimeType: 'image/jpeg',  // Telegram photos are always JPEG
        caption: message.caption || null,
        sizes: message.photo.map(p => ({ fileId: p.file_id, width: p.width, height: p.height }))
      });
      return;
    }

    // Document
    if (message.document) {
      this.emit('document', {
        ...msgBase,
        fileId: message.document.file_id,
        fileName: message.document.file_name,
        mimeType: message.document.mime_type,
        fileSize: message.document.file_size,
        caption: message.caption || null
      });
      return;
    }

    // Video
    if (message.video) {
      this.emit('video', {
        ...msgBase,
        fileId: message.video.file_id,
        mimeType: message.video.mime_type || 'video/mp4',
        duration: message.video.duration,
        width: message.video.width,
        height: message.video.height,
        caption: message.caption || null
      });
      return;
    }

    // Audio
    if (message.audio) {
      this.emit('audio', {
        ...msgBase,
        fileId: message.audio.file_id,
        mimeType: message.audio.mime_type || 'audio/mpeg',
        duration: message.audio.duration,
        title: message.audio.title,
        performer: message.audio.performer
      });
      return;
    }

    // Voice (Telegram voice messages are always OGG OPUS)
    if (message.voice) {
      this.emit('voice', {
        ...msgBase,
        fileId: message.voice.file_id,
        mimeType: 'audio/ogg',  // Voice messages are always OGG
        duration: message.voice.duration
      });
      return;
    }

    // Location
    if (message.location) {
      this.emit('location', {
        ...msgBase,
        latitude: message.location.latitude,
        longitude: message.location.longitude
      });
      return;
    }

    // Contact
    if (message.contact) {
      this.emit('contact', {
        ...msgBase,
        phoneNumber: message.contact.phone_number,
        firstName: message.contact.first_name,
        lastName: message.contact.last_name
      });
      return;
    }
  }

  extractFrom(from) {
    if (!from) return null;
    return {
      id: from.id,
      username: from.username,
      firstName: from.first_name,
      lastName: from.last_name
    };
  }

  // ==========================================
  // Rate Limited Send Queue
  // ==========================================

  async queueSend(method, params) {
    return new Promise((resolve, reject) => {
      if (this.sendQueue.length >= this.maxQueueSize) {
        this.emit('queue_overflow', { botName: this.botName, queueSize: this.sendQueue.length });
        reject(new Error('Send queue overflow'));
        return;
      }

      this.sendQueue.push({ method, params, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.sending || this.sendQueue.length === 0) return;

    const now = Date.now();
    const timeSinceLastSend = now - this.lastSendTime;

    if (timeSinceLastSend < this.sendInterval) {
      setTimeout(() => this.processQueue(), this.sendInterval - timeSinceLastSend);
      return;
    }

    this.sending = true;
    const { method, params, resolve, reject } = this.sendQueue.shift();

    try {
      const result = await this.request(method, params);
      this.lastSendTime = Date.now();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.sending = false;
      if (this.sendQueue.length > 0) {
        setTimeout(() => this.processQueue(), this.sendInterval);
      }
    }
  }

  // ==========================================
  // Core Request
  // ==========================================

  async request(method, params = {}) {
    const url = `${this.baseUrl}/${method}`;

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(params);

      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: method === 'getUpdates' ? 35000 : 10000
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.ok) {
              resolve(json.result);
            } else {
              reject(new Error(json.description || 'Telegram API error'));
            }
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  // ==========================================
  // Bot Info
  // ==========================================

  async getMe() {
    return this.request('getMe');
  }

  // ==========================================
  // Sending Messages (rate limited)
  // ==========================================

  async sendMessage(chatId, text, options = {}) {
    const params = {
      chat_id: chatId,
      text: text
    };

    if (options.parseMode) params.parse_mode = options.parseMode;
    if (options.replyToMessageId) params.reply_to_message_id = options.replyToMessageId;
    if (options.disableNotification) params.disable_notification = true;
    if (options.replyMarkup) params.reply_markup = options.replyMarkup;

    return this.queueSend('sendMessage', params);
  }

  async sendPhoto(chatId, photo, options = {}) {
    const params = {
      chat_id: chatId,
      photo: photo
    };

    if (options.caption) params.caption = options.caption;
    if (options.parseMode) params.parse_mode = options.parseMode;
    if (options.replyToMessageId) params.reply_to_message_id = options.replyToMessageId;

    return this.queueSend('sendPhoto', params);
  }

  async sendDocument(chatId, document, options = {}) {
    const params = {
      chat_id: chatId,
      document: document
    };

    if (options.caption) params.caption = options.caption;
    if (options.parseMode) params.parse_mode = options.parseMode;
    if (options.replyToMessageId) params.reply_to_message_id = options.replyToMessageId;

    return this.queueSend('sendDocument', params);
  }

  async sendAudio(chatId, audio, options = {}) {
    const params = {
      chat_id: chatId,
      audio: audio
    };

    if (options.caption) params.caption = options.caption;
    if (options.duration) params.duration = options.duration;
    if (options.performer) params.performer = options.performer;
    if (options.title) params.title = options.title;

    return this.queueSend('sendAudio', params);
  }

  async sendVideo(chatId, video, options = {}) {
    const params = {
      chat_id: chatId,
      video: video
    };

    if (options.caption) params.caption = options.caption;
    if (options.duration) params.duration = options.duration;
    if (options.width) params.width = options.width;
    if (options.height) params.height = options.height;

    return this.queueSend('sendVideo', params);
  }

  async sendVoice(chatId, voice, options = {}) {
    const params = {
      chat_id: chatId,
      voice: voice
    };

    if (options.caption) params.caption = options.caption;
    if (options.duration) params.duration = options.duration;

    return this.queueSend('sendVoice', params);
  }

  async sendLocation(chatId, latitude, longitude, options = {}) {
    const params = {
      chat_id: chatId,
      latitude: latitude,
      longitude: longitude
    };

    if (options.replyToMessageId) params.reply_to_message_id = options.replyToMessageId;

    return this.queueSend('sendLocation', params);
  }

  async sendContact(chatId, phoneNumber, firstName, options = {}) {
    const params = {
      chat_id: chatId,
      phone_number: phoneNumber,
      first_name: firstName
    };

    if (options.lastName) params.last_name = options.lastName;

    return this.queueSend('sendContact', params);
  }

  // ==========================================
  // Keyboards
  // ==========================================

  async sendKeyboard(chatId, text, buttons, options = {}) {
    const params = {
      chat_id: chatId,
      text: text,
      reply_markup: {
        inline_keyboard: buttons
      }
    };

    if (options.parseMode) params.parse_mode = options.parseMode;
    if (options.replyToMessageId) params.reply_to_message_id = options.replyToMessageId;

    return this.queueSend('sendMessage', params);
  }

  async sendReplyKeyboard(chatId, text, keyboard, options = {}) {
    const params = {
      chat_id: chatId,
      text: text,
      reply_markup: {
        keyboard: keyboard,
        resize_keyboard: options.resize !== false,
        one_time_keyboard: options.oneTime || false
      }
    };

    return this.queueSend('sendMessage', params);
  }

  async removeKeyboard(chatId, text) {
    return this.queueSend('sendMessage', {
      chat_id: chatId,
      text: text,
      reply_markup: { remove_keyboard: true }
    });
  }

  // ==========================================
  // Edit/Delete Messages
  // ==========================================

  async editMessageText(chatId, messageId, text, options = {}) {
    const params = {
      chat_id: chatId,
      message_id: messageId,
      text: text
    };

    if (options.parseMode) params.parse_mode = options.parseMode;
    if (options.replyMarkup) params.reply_markup = options.replyMarkup;

    return this.queueSend('editMessageText', params);
  }

  async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    return this.queueSend('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup
    });
  }

  async deleteMessage(chatId, messageId) {
    return this.queueSend('deleteMessage', {
      chat_id: chatId,
      message_id: messageId
    });
  }

  // ==========================================
  // Callbacks
  // ==========================================

  async answerCallbackQuery(callbackId, options = {}) {
    const params = {
      callback_query_id: callbackId
    };

    if (options.text) params.text = options.text;
    if (options.showAlert) params.show_alert = options.showAlert;
    if (options.url) params.url = options.url;

    return this.queueSend('answerCallbackQuery', params);
  }

  // ==========================================
  // Chat Actions
  // ==========================================

  async sendChatAction(chatId, action = 'typing') {
    return this.queueSend('sendChatAction', {
      chat_id: chatId,
      action: action
    });
  }

  // ==========================================
  // Chat Info
  // ==========================================

  async getChat(chatId) {
    return this.request('getChat', { chat_id: chatId });
  }

  async getChatMember(chatId, userId) {
    return this.request('getChatMember', {
      chat_id: chatId,
      user_id: userId
    });
  }

  async getChatMembersCount(chatId) {
    return this.request('getChatMembersCount', { chat_id: chatId });
  }

  // ==========================================
  // Bot Commands
  // ==========================================

  async setMyCommands(commands, options = {}) {
    const params = {
      commands: commands.map(cmd => ({
        command: cmd.command,
        description: cmd.description
      }))
    };

    if (options.scope) params.scope = options.scope;
    if (options.languageCode) params.language_code = options.languageCode;

    return this.request('setMyCommands', params);
  }

  async getMyCommands(options = {}) {
    return this.request('getMyCommands', options);
  }

  async deleteMyCommands(options = {}) {
    return this.request('deleteMyCommands', options);
  }

  // ==========================================
  // Files
  // ==========================================

  async getFile(fileId) {
    return this.request('getFile', { file_id: fileId });
  }

  getFileUrl(filePath) {
    return `${this.fileBaseUrl}/${filePath}`;
  }

  async downloadFile(fileId, destPath) {
    const file = await this.getFile(fileId);
    const fileUrl = this.getFileUrl(file.file_path);

    return new Promise((resolve, reject) => {
      const dir = path.dirname(destPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const fileStream = fs.createWriteStream(destPath);

      https.get(fileUrl, (res) => {
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve({
            path: destPath,
            size: file.file_size,
            originalPath: file.file_path
          });
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });
  }

  async downloadFileAsBuffer(fileId) {
    const file = await this.getFile(fileId);
    const fileUrl = this.getFileUrl(file.file_path);

    return new Promise((resolve, reject) => {
      https.get(fileUrl, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            buffer,
            size: file.file_size,
            mimeType: this.getMimeType(file.file_path),
            filePath: file.file_path
          });
        });
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  // ==========================================
  // Forward/Copy
  // ==========================================

  async forwardMessage(chatId, fromChatId, messageId) {
    return this.queueSend('forwardMessage', {
      chat_id: chatId,
      from_chat_id: fromChatId,
      message_id: messageId
    });
  }

  async copyMessage(chatId, fromChatId, messageId, options = {}) {
    const params = {
      chat_id: chatId,
      from_chat_id: fromChatId,
      message_id: messageId
    };

    if (options.caption) params.caption = options.caption;

    return this.queueSend('copyMessage', params);
  }

  // ==========================================
  // Helpers
  // ==========================================

  getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg',
      '.mp4': 'video/mp4',
      '.avi': 'video/x-msvideo',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.zip': 'application/zip',
      '.txt': 'text/plain'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  getQueueSize() {
    return this.sendQueue.length;
  }

  isPolling() {
    return this.polling;
  }
}

module.exports = TelegramClient;
