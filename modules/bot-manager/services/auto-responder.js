/**
 * Auto Responder
 * Envía respuestas automáticas sin AI (comandos /start, /help, etc.)
 */

class AutoResponder {
  constructor(config, logger, eventBus) {
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
  }

  /**
   * Envía una respuesta automática a un chat
   */
  async sendResponse(botName, chatId, message, options = {}) {
    const requestId = `auto_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    this.logger.info('auto-responder.sending', {
      botName,
      chatId,
      messageLength: message.length
    });

    // Publicar request a telegram-service
    await this.eventBus.publish('telegram.send_message.request', {
      request_id: requestId,
      botName,
      chatId,
      text: message,
      parseMode: options.parseMode || 'HTML'
    });

    return { success: true, requestId };
  }

  /**
   * Procesa un comando y envía respuesta si está configurada
   * @returns {boolean} true si se envió respuesta, false si no hay respuesta configurada
   */
  async handleCommand(botName, chatId, command, autoResponses) {
    if (!autoResponses) {
      return false;
    }

    // Buscar respuesta para el comando
    const response = autoResponses[command];

    if (!response) {
      return false;
    }

    this.logger.info('auto-responder.command-matched', {
      botName,
      command
    });

    await this.sendResponse(botName, chatId, response);
    return true;
  }

  /**
   * Envía mensaje de confirmación de archivo recibido
   * @param {object} autoResponses - Configuración de respuestas automáticas del bot
   */
  async handleFileReceived(botName, chatId, fileName, autoResponses) {
    const message = autoResponses?.onFileReceived;

    if (!message) {
      return false;
    }

    this.logger.info('auto-responder.file-received', {
      botName,
      fileName
    });

    await this.sendResponse(botName, chatId, message);
    return true;
  }
}

module.exports = AutoResponder;
