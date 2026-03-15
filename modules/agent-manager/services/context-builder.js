/**
 * Context Builder
 * Construye el contexto que se pasa al agente
 */

class ContextBuilder {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Construye contexto a partir de template y datos del evento
   * @param {Object} template - Template de contexto del trigger
   * @param {Object} eventData - Datos del evento original
   * @param {Object} extra - Datos adicionales (pipeline info, etc.)
   */
  build(template, eventData, extra = {}) {
    const context = {};

    // Aplicar template si existe
    if (template && Object.keys(template).length > 0) {
      for (const [key, value] of Object.entries(template)) {
        context[key] = this.resolveValue(value, eventData);
      }
    }

    // Añadir datos esenciales que siempre deben estar
    context.source = {
      event: extra.eventType,
      botName: eventData.botName,
      chatId: eventData.chatId,
      userId: eventData.userId,
      userName: eventData.userName,
      timestamp: eventData.timestamp || new Date().toISOString()
    };

    // Si hay archivo, añadirlo
    if (eventData.file) {
      context.file = {
        path: eventData.file.path,
        originalName: eventData.file.originalName,
        mimeType: eventData.file.mimeType,
        size: eventData.file.size
      };
    }

    // Si hay texto/mensaje, añadirlo
    if (eventData.text) {
      context.message = {
        text: eventData.text
      };
    }

    // Si hay comando, añadirlo
    if (eventData.command) {
      context.command = {
        name: eventData.command,
        args: eventData.args
      };
    }

    // Info de respuesta (cómo responder al usuario)
    context.reply = {
      via: 'telegram',
      botName: eventData.botName,
      chatId: eventData.chatId
    };

    // Info de pipeline si existe
    if (extra.pipeline) {
      context.pipeline = extra.pipeline;
    }

    // Datos compartidos de pasos anteriores del pipeline
    if (extra.sharedData) {
      context.previousResults = extra.sharedData;
    }

    this.logger.debug('context-builder.built', {
      keys: Object.keys(context)
    });

    return context;
  }

  /**
   * Resuelve un valor del template, sustituyendo {{variables}}
   */
  resolveValue(value, data) {
    if (typeof value !== 'string') return value;

    // Buscar {{variable}} y sustituir
    return value.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
      const resolved = this.getNestedValue(data, path.trim());
      return resolved !== undefined ? resolved : match;
    });
  }

  /**
   * Obtiene valor anidado de un objeto
   */
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  /**
   * Construye la descripción de la tarea para el agente
   */
  buildTask(trigger, eventData, context) {
    // Si el trigger tiene task definida, usarla
    if (trigger.task) {
      return this.resolveValue(trigger.task, { ...eventData, ...context });
    }

    // Generar tarea automática según el tipo de evento
    const eventType = trigger.event;

    if (eventType === 'bot.file.stored') {
      const fileName = context.file?.originalName || 'archivo';
      const mimeType = context.file?.mimeType || 'desconocido';
      return `Procesa el archivo "${fileName}" (${mimeType}) recibido del bot "${context.source.botName}"`;
    }

    if (eventType === 'bot.message.received') {
      return `Responde al mensaje del usuario en el bot "${context.source.botName}": "${context.message?.text}"`;
    }

    if (eventType === 'bot.command.received') {
      return `Ejecuta el comando /${context.command?.name} del bot "${context.source.botName}"`;
    }

    return `Procesa evento ${eventType} del bot "${context.source.botName}"`;
  }
}

module.exports = ContextBuilder;
