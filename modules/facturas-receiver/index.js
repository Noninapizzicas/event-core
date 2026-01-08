/**
 * Facturas Receiver Module v1.0.0
 *
 * Escucha archivos del bot Telegram 'facturas' y los guarda en storage.
 *
 * Flujo:
 * 1. telegram.document.received / telegram.photo.received (filtrado por botName)
 * 2. telegram.get_file.request → obtener archivo
 * 3. fs.write.request → guardar en /facturas-nonina/recibidas
 * 4. telegram.send_message.request → confirmar al usuario
 */

const path = require('path');

class FacturasReceiverModule {
  constructor() {
    this.name = 'facturas-receiver';
    this.version = '1.0.0';

    // Dependencies
    this.logger = null;
    this.eventBus = null;
    this.metrics = null;

    // Config (loaded from module.json)
    this.config = {
      botName: 'facturas',
      storagePath: '/facturas-nonina/recibidas',
      sendConfirmation: true
    };

    // Pending requests tracking
    this.pendingRequests = new Map();

    // Unsubscribe functions
    this.unsubscribes = [];
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(context) {
    this.logger = context.logger;
    this.eventBus = context.eventBus;
    this.metrics = context.metrics;

    // Load config from module.json if available
    try {
      const fs = require('fs').promises;
      const moduleJson = JSON.parse(
        await fs.readFile(path.join(__dirname, 'module.json'), 'utf-8')
      );
      this.config = { ...this.config, ...moduleJson.config };
    } catch (e) {
      // Use defaults
    }

    this.logger.info('facturas-receiver.loading', {
      botName: this.config.botName,
      storagePath: this.config.storagePath
    });

    // Subscribe to Telegram file events
    const unsubDoc = await this.eventBus.subscribe(
      'telegram.document.received',
      this.onFileReceived.bind(this)
    );
    this.unsubscribes.push(unsubDoc);

    const unsubPhoto = await this.eventBus.subscribe(
      'telegram.photo.received',
      this.onFileReceived.bind(this)
    );
    this.unsubscribes.push(unsubPhoto);

    // Subscribe to responses
    const unsubFileResp = await this.eventBus.subscribe(
      'telegram.get_file.response',
      this.onGetFileResponse.bind(this)
    );
    this.unsubscribes.push(unsubFileResp);

    const unsubWriteResp = await this.eventBus.subscribe(
      'fs.write.response',
      this.onWriteResponse.bind(this)
    );
    this.unsubscribes.push(unsubWriteResp);

    const unsubSendResp = await this.eventBus.subscribe(
      'telegram.send_message.response',
      this.onSendMessageResponse.bind(this)
    );
    this.unsubscribes.push(unsubSendResp);

    this.logger.info('facturas-receiver.loaded', {
      subscriptions: [
        'telegram.document.received',
        'telegram.photo.received',
        'telegram.get_file.response',
        'fs.write.response',
        'telegram.send_message.response'
      ]
    });
  }

  async onUnload() {
    // Clear pending requests
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
    }
    this.pendingRequests.clear();

    // Unsubscribe all
    for (const unsub of this.unsubscribes) {
      if (typeof unsub === 'function') await unsub();
    }
    this.unsubscribes = [];

    this.logger.info('facturas-receiver.unloaded');
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  /**
   * Handle incoming file from Telegram
   */
  async onFileReceived(event) {
    const data = event?.data || event?.payload || event;
    const { botName, chatId, fileId, fileName, mimeType, caption, from } = data;

    // Filter: only process files from configured bot
    if (botName !== this.config.botName) {
      return;
    }

    this.logger.info('facturas-receiver.file.received', {
      botName,
      chatId,
      fileId,
      fileName: fileName || 'photo',
      from: from?.username || from?.firstName
    });

    this.metrics?.increment('facturas.received.total');

    // Emit internal event
    await this.eventBus.publish('facturas.file.received', {
      botName,
      chatId,
      fileId,
      fileName,
      mimeType,
      from,
      timestamp: new Date().toISOString()
    });

    // Step 1: Request file download from Telegram
    const requestId = `facturas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Store context for the chain of operations
    this.pendingRequests.set(requestId, {
      step: 'get_file',
      chatId,
      fileId,
      fileName: fileName || `photo_${Date.now()}.jpg`,
      mimeType,
      from,
      timeout: setTimeout(() => {
        this.handleTimeout(requestId);
      }, 30000) // 30s timeout
    });

    await this.eventBus.publish('telegram.get_file.request', {
      request_id: requestId,
      botName: this.config.botName,
      fileId,
      download: false // Get URL, we'll download content
    });
  }

  /**
   * Handle file info response from Telegram
   */
  async onGetFileResponse(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, success, downloadUrl, filePath, error } = data;

    const pending = this.pendingRequests.get(request_id);
    if (!pending || pending.step !== 'get_file') return;

    if (!success) {
      this.handleError(request_id, `Failed to get file: ${error}`);
      return;
    }

    this.logger.info('facturas-receiver.file.info', {
      request_id,
      downloadUrl,
      filePath
    });

    // Step 2: Download file content and save
    try {
      const fileContent = await this.downloadFile(downloadUrl);

      // Determine filename
      const ext = path.extname(pending.fileName) || this.getExtFromPath(filePath) || '.bin';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safeFileName = `${timestamp}_${pending.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const destPath = path.posix.join(this.config.storagePath, safeFileName);

      // Update pending state
      pending.step = 'write_file';
      pending.destPath = destPath;
      pending.fileSize = fileContent.length;

      // Request file write
      await this.eventBus.publish('fs.write.request', {
        request_id,
        path: destPath,
        content: fileContent.toString('base64'),
        encoding: 'base64'
      });

    } catch (err) {
      this.handleError(request_id, `Failed to download file: ${err.message}`);
    }
  }

  /**
   * Handle file write response
   */
  async onWriteResponse(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, success, path: savedPath, error } = data;

    const pending = this.pendingRequests.get(request_id);
    if (!pending || pending.step !== 'write_file') return;

    if (!success) {
      this.handleError(request_id, `Failed to save file: ${error}`);
      return;
    }

    this.logger.info('facturas-receiver.file.saved', {
      request_id,
      path: savedPath || pending.destPath,
      size: pending.fileSize
    });

    this.metrics?.increment('facturas.saved.total');

    // Emit success event
    await this.eventBus.publish('facturas.file.saved', {
      path: savedPath || pending.destPath,
      originalName: pending.fileName,
      size: pending.fileSize,
      from: pending.from,
      chatId: pending.chatId,
      timestamp: new Date().toISOString()
    });

    // Step 3: Send confirmation message
    if (this.config.sendConfirmation) {
      pending.step = 'send_confirmation';

      const message = `✅ Archivo recibido y guardado:\n📄 ${pending.fileName}\n📁 ${pending.destPath}`;

      await this.eventBus.publish('telegram.send_message.request', {
        request_id,
        botName: this.config.botName,
        chatId: pending.chatId,
        text: message
      });
    } else {
      // Done
      this.cleanup(request_id);
    }
  }

  /**
   * Handle send message response
   */
  async onSendMessageResponse(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, success, error } = data;

    const pending = this.pendingRequests.get(request_id);
    if (!pending || pending.step !== 'send_confirmation') return;

    if (!success) {
      this.logger.warn('facturas-receiver.confirmation.failed', {
        request_id,
        error
      });
    } else {
      this.logger.info('facturas-receiver.confirmation.sent', {
        request_id,
        chatId: pending.chatId
      });
    }

    // Done
    this.cleanup(request_id);
  }

  // ==========================================
  // Helpers
  // ==========================================

  /**
   * Download file from URL
   */
  async downloadFile(url) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const http = require('http');
      const client = url.startsWith('https') ? https : http;

      client.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          // Follow redirect
          this.downloadFile(res.headers.location).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  /**
   * Get extension from Telegram file path
   */
  getExtFromPath(filePath) {
    if (!filePath) return null;
    const ext = path.extname(filePath);
    return ext || null;
  }

  /**
   * Handle timeout
   */
  handleTimeout(requestId) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    this.logger.error('facturas-receiver.timeout', {
      request_id: requestId,
      step: pending.step
    });

    this.metrics?.increment('facturas.errors.total');

    this.eventBus.publish('facturas.file.error', {
      request_id: requestId,
      error: 'Operation timed out',
      step: pending.step,
      chatId: pending.chatId
    });

    this.pendingRequests.delete(requestId);
  }

  /**
   * Handle error
   */
  async handleError(requestId, errorMessage) {
    const pending = this.pendingRequests.get(requestId);

    this.logger.error('facturas-receiver.error', {
      request_id: requestId,
      error: errorMessage,
      step: pending?.step
    });

    this.metrics?.increment('facturas.errors.total');

    await this.eventBus.publish('facturas.file.error', {
      request_id: requestId,
      error: errorMessage,
      step: pending?.step,
      chatId: pending?.chatId,
      timestamp: new Date().toISOString()
    });

    // Send error message to user
    if (pending?.chatId && this.config.sendConfirmation) {
      await this.eventBus.publish('telegram.send_message.request', {
        request_id: `error-${requestId}`,
        botName: this.config.botName,
        chatId: pending.chatId,
        text: `❌ Error al procesar archivo: ${errorMessage}`
      });
    }

    this.cleanup(requestId);
  }

  /**
   * Cleanup pending request
   */
  cleanup(requestId) {
    const pending = this.pendingRequests.get(requestId);
    if (pending?.timeout) {
      clearTimeout(pending.timeout);
    }
    this.pendingRequests.delete(requestId);
  }
}

module.exports = FacturasReceiverModule;
