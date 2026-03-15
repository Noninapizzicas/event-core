/**
 * Bot Registry
 * Gestiona la configuración de bots registrados
 * Estructura simple: ./data/bots/<botName>/
 */

const fs = require('fs').promises;
const path = require('path');

class BotRegistry {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.bots = new Map(); // botName -> botConfig
    this.storagePath = config.storagePath || './data/bots';
  }

  async initialize() {
    // Crear directorio base si no existe
    await fs.mkdir(this.storagePath, { recursive: true });

    this.logger.info('bot-registry.initialized', {
      storagePath: this.storagePath
    });
  }

  /**
   * Registra un bot (crea directorio si no existe)
   */
  async register(botName, config = {}) {
    const botPath = path.join(this.storagePath, botName);

    // Crear directorio del bot
    await fs.mkdir(botPath, { recursive: true });

    // Respuestas por defecto
    const defaultAutoResponses = {
      onFileReceived: 'Archivo recibido'
    };

    const botConfig = {
      botName,
      platform: config.platform || 'telegram',
      enabled: config.enabled !== false,
      storagePath: botPath,
      autoResponses: { ...defaultAutoResponses, ...config.autoResponses }
    };

    this.bots.set(botName, botConfig);

    this.logger.info('bot-registry.registered', {
      botName,
      path: botPath
    });

    return botConfig;
  }

  /**
   * Obtiene la ruta donde guardar archivos recibidos
   */
  getStoragePath(botName) {
    return path.join(this.storagePath, botName, 'received');
  }

  get(botName) {
    return this.bots.get(botName);
  }

  has(botName) {
    return this.bots.has(botName);
  }

  isEnabled(botName) {
    const bot = this.bots.get(botName);
    return bot ? bot.enabled : true; // Por defecto habilitado
  }

  /**
   * Actualiza config de un bot
   */
  async update(botName, updates) {
    let botConfig = this.bots.get(botName);

    if (!botConfig) {
      botConfig = await this.register(botName);
    }

    if (updates.enabled !== undefined) botConfig.enabled = updates.enabled;
    if (updates.autoResponses) {
      botConfig.autoResponses = { ...botConfig.autoResponses, ...updates.autoResponses };
    }

    this.bots.set(botName, botConfig);
    return botConfig;
  }

  getAutoResponse(botName, key) {
    const bot = this.bots.get(botName);
    return bot?.autoResponses?.[key] || null;
  }

  /**
   * Obtiene todos los bots registrados
   */
  getAll() {
    return Array.from(this.bots.values());
  }
}

module.exports = BotRegistry;
