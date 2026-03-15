/**
 * Bot Manager Module
 *
 * Gestiona bots y almacenamiento. NO sabe de agentes.
 *
 * Escucha: telegram.* (archivos, mensajes, comandos)
 * Publica: bot.file.stored, bot.message.received, bot.command.received
 */

const BotRegistry = require('./services/bot-registry');
const DownloadManager = require('./services/download-manager');
const AutoResponder = require('./services/auto-responder');

class BotManagerModule {
  constructor() {
    this.name = 'bot-manager';
    this.version = '1.0.0';

    // Dependencies
    this.logger = null;
    this.eventBus = null;
    this.config = null;

    // Services
    this.registry = null;
    this.downloadManager = null;
    this.autoResponder = null;
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(context) {
    this.logger = context.logger;
    this.eventBus = context.eventBus;

    // Load config from loader-injected moduleConfig
    this.config = context.moduleConfig || {};

    this.logger.info('bot-manager.loading', {
      version: this.version
    });

    // Initialize services
    this.registry = new BotRegistry(this.config, this.logger);
    await this.registry.initialize();

    this.downloadManager = new DownloadManager(this.config, this.logger, this.eventBus);
    this.autoResponder = new AutoResponder(this.config, this.logger, this.eventBus);

    this.logger.info('bot-manager.loaded', {
      version: this.version,
      bots_count: this.registry.getAll().length
    });
  }

  async onUnload() {
    this.logger.info('bot-manager.unloading');

    this.logger.info('bot-manager.unloaded');
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  /**
   * Maneja archivos recibidos (document, photo, video, audio, voice)
   */
  async onFileReceived(event) {
    const data = event?.data || event?.payload || event;
    const { botName, chatId, fileId, fileName, mimeType, caption } = data;
    const from = data.from || {};

    // Verificar si el bot está registrado y habilitado
    if (!this.registry.has(botName)) {
      // Auto-registrar bot si no existe
      await this.registry.register(botName);
      this.logger.info('bot-manager.auto-registered', { botName });
    }

    if (!this.registry.isEnabled(botName)) {
      this.logger.debug('bot-manager.bot-disabled', { botName });
      return;
    }

    // Obtener ruta de storage
    const storagePath = this.registry.getStoragePath(botName);

    // Descargar y guardar archivo
    const result = await this.downloadManager.downloadAndStore(
      botName,
      fileId,
      fileName || `file_${Date.now()}`,
      mimeType,
      storagePath
    );

    if (!result.success) {
      this.logger.error('bot-manager.file-storage.failed', {
        botName,
        fileId,
        error: result.error
      });
      return;
    }

    // Publicar evento bot.file.stored
    await this.eventBus.publish('bot.file.stored', {
      botName,
      chatId,
      userId: from.id,
      userName: from.username || null,
      userFirstName: from.first_name || null,
      userLastName: from.last_name || null,
      file: {
        path: result.path,
        originalName: result.originalName,
        mimeType: result.mimeType || mimeType,
        size: result.size
      },
      caption,
      timestamp: new Date().toISOString()
    });

    this.logger.info('bot-manager.file.stored', {
      botName,
      path: result.path,
      mimeType: result.mimeType
    });

    // Enviar confirmación si está configurada
    const botConfig = this.registry.get(botName);
    await this.autoResponder.handleFileReceived(
      botName,
      chatId,
      result.originalName,
      botConfig?.autoResponses
    );
  }

  /**
   * Maneja mensajes de texto
   */
  async onTextReceived(event) {
    const data = event?.data || event?.payload || event;
    const { botName, chatId, text } = data;
    const from = data.from || {};

    // Verificar bot
    if (!this.registry.has(botName)) {
      await this.registry.register(botName);
    }

    if (!this.registry.isEnabled(botName)) {
      return;
    }

    // Publicar evento bot.message.received
    await this.eventBus.publish('bot.message.received', {
      botName,
      chatId,
      userId: from.id,
      userName: from.username,
      text,
      timestamp: new Date().toISOString()
    });

    this.logger.info('bot-manager.message.received', {
      botName,
      chatId,
      textLength: text?.length
    });
  }

  /**
   * Maneja comandos (pueden tener respuestas automáticas)
   */
  async onCommandReceived(event) {
    const data = event?.data || event?.payload || event;
    const { botName, chatId, command, args } = data;
    const from = data.from || {};

    // Verificar bot
    if (!this.registry.has(botName)) {
      await this.registry.register(botName);
    }

    if (!this.registry.isEnabled(botName)) {
      return;
    }

    const botConfig = this.registry.get(botName);

    // Intentar respuesta automática
    const handled = await this.autoResponder.handleCommand(
      botName,
      chatId,
      `/${command}`,
      botConfig.autoResponses
    );

    // Publicar evento bot.command.received (siempre, aunque se haya respondido)
    await this.eventBus.publish('bot.command.received', {
      botName,
      chatId,
      userId: from.id,
      userName: from.username,
      command,
      args,
      autoResponded: handled,
      timestamp: new Date().toISOString()
    });

    this.logger.info('bot-manager.command.received', {
      botName,
      command,
      autoResponded: handled
    });
  }

  /**
   * Auto-registra bot cuando se guarda credencial de Telegram
   */
  async onCredentialSaved(event) {
    const data = event?.data || event?.payload || event;
    const { key, provider, level } = data;

    // Solo procesar credenciales de Telegram BOT
    if (provider !== 'TELEGRAM' || level !== 'BOT') return;

    // Extraer nombre del bot del key
    const match = key?.match(/^TELEGRAM_API_KEY_(?:BOT|CUSTOM)_(.+)$/);
    if (!match) return;

    const botName = match[1];

    // Registrar si no existe
    if (!this.registry.has(botName)) {
      await this.registry.register(botName);

      await this.eventBus.publish('bot.registered', {
        botName,
        platform: 'telegram',
        timestamp: new Date().toISOString()
      });

      this.logger.info('bot-manager.bot.auto-registered', { botName });
    }
  }

  // ==========================================
  // API Methods (para uso via eventos)
  // ==========================================

  /**
   * Registra un bot manualmente
   */
  async registerBot(botName, config = {}) {
    const botConfig = await this.registry.register(botName, config);

    await this.eventBus.publish('bot.registered', {
      botName,
      platform: config.platform || 'telegram',
      timestamp: new Date().toISOString()
    });

    return botConfig;
  }

  /**
   * Desregistra un bot
   */
  async unregisterBot(botName) {
    const success = await this.registry.unregister(botName);

    if (success) {
      await this.eventBus.publish('bot.unregistered', {
        botName,
        timestamp: new Date().toISOString()
      });
    }

    return success;
  }

  /**
   * Habilita/deshabilita un bot
   */
  async setEnabled(botName, enabled) {
    const botConfig = await this.registry.update(botName, { enabled });

    if (botConfig) {
      await this.eventBus.publish(enabled ? 'bot.enabled' : 'bot.disabled', {
        botName,
        timestamp: new Date().toISOString()
      });
    }

    return botConfig;
  }

  /**
   * Configura respuestas automáticas
   */
  async setAutoResponses(botName, autoResponses) {
    return await this.registry.update(botName, { autoResponses });
  }

  /**
   * Obtiene config de un bot
   */
  getBot(botName) {
    return this.registry.get(botName);
  }

  /**
   * Lista todos los bots
   */
  listBots() {
    return this.registry.getAll();
  }
}

module.exports = BotManagerModule;
