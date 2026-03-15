/**
 * Structured Logger for Event Core
 *
 * Provee logging estructurado con niveles, contexto, y trace IDs.
 * Los logs se pueden publicar a MQTT para observabilidad distribuida.
 *
 * @example
 * const logger = new Logger({ level: 'info', coreId: 'core-a' });
 *
 * logger.info('module.loaded', { module: 'echo', version: '1.0.0' });
 * logger.error('event.failed', { error: err.message }, err);
 * logger.debug('cache.hit', { key: 'user:123', ttl: 3600 });
 */

class Logger {
  /**
   * Log levels en orden de severidad
   */
  static LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
  };

  /**
   * @param {Object} options - Opciones de configuración
   * @param {string} options.level - Nivel mínimo de log ('debug', 'info', 'warn', 'error')
   * @param {string} options.coreId - ID del core (para logs distribuidos)
   * @param {Object} options.mqtt - Cliente MQTT para publicar logs (opcional)
   * @param {Function} options.output - Función custom de output (default: console.log)
   */
  constructor(options = {}) {
    this.level = options.level || 'info';
    this.coreId = options.coreId || 'unknown';
    this.mqtt = options.mqtt || null;
    this.output = options.output || console.log;
    this.traceContext = null; // Se setea desde Tracer
  }

  /**
   * Setea el trace context actual (inyectado por Tracer)
   *
   * @param {Object} traceContext - Contexto de tracing
   */
  setTraceContext(traceContext) {
    this.traceContext = traceContext;
  }

  /**
   * Verifica si un nivel debe ser loggeado
   *
   * @param {string} level - Nivel a verificar
   * @returns {boolean}
   */
  shouldLog(level) {
    return Logger.LEVELS[level] >= Logger.LEVELS[this.level];
  }

  /**
   * Crea una entrada de log estructurada
   *
   * @param {string} level - Nivel de log
   * @param {string} message - Mensaje (ej: 'module.loaded', 'event.published')
   * @param {Object} context - Contexto adicional
   * @param {Error} error - Error object (opcional)
   * @returns {Object} Log entry
   */
  createLogEntry(level, message, context = {}, error = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      core_id: this.coreId,
      message,
      context: { ...context }
    };

    // Agregar trace context si está disponible
    if (this.traceContext) {
      entry.trace_id = this.traceContext.traceId;
      entry.span_id = this.traceContext.spanId;
    }

    // Agregar información de error si existe
    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack
      };

      // Agregar propiedades custom del error
      Object.keys(error).forEach(key => {
        if (!['name', 'message', 'stack'].includes(key)) {
          entry.error[key] = error[key];
        }
      });
    }

    return entry;
  }

  /**
   * Formatea un log entry para output
   *
   * @param {Object} entry - Log entry
   * @returns {string} Formatted string
   */
  formatEntry(entry) {
    const levelEmoji = {
      debug: '🔍',
      info: 'ℹ️',
      warn: '⚠️',
      error: '❌'
    };

    const emoji = levelEmoji[entry.level] || '';
    const traceInfo = entry.trace_id ? ` [${entry.trace_id.substring(0, 8)}]` : '';

    // Formato: 2025-10-06T12:34:56Z ℹ️  [core-a] [trace123] module.loaded {"module":"echo"}
    let output = `${entry.timestamp} ${emoji}  [${entry.core_id}]${traceInfo} ${entry.message}`;

    // Agregar context si no está vacío
    if (Object.keys(entry.context).length > 0) {
      output += ` ${JSON.stringify(entry.context)}`;
    }

    // Agregar error si existe
    if (entry.error) {
      output += `\n  Error: ${entry.error.message}`;
      if (entry.error.stack) {
        output += `\n${entry.error.stack.split('\n').map(line => `  ${line}`).join('\n')}`;
      }
    }

    return output;
  }

  /**
   * Publica log a MQTT si está configurado
   *
   * @param {Object} entry - Log entry
   */
  async publishToMQTT(entry) {
    if (!this.mqtt) return;

    try {
      const topic = `core/${this.coreId}/logs/${entry.level}`;
      await this.mqtt.publish(topic, JSON.stringify(entry), { qos: 0 });
    } catch (error) {
      // No fallar si MQTT falla, solo output a console
      console.error('Failed to publish log to MQTT:', error.message);
    }
  }

  /**
   * Log a nivel debug
   *
   * @param {string} message - Mensaje
   * @param {Object} context - Contexto
   *
   * @example
   * logger.debug('cache.hit', { key: 'user:123', ttl: 3600 });
   */
  debug(message, context = {}) {
    if (!this.shouldLog('debug')) return;

    const entry = this.createLogEntry('debug', message, context);
    this.output(this.formatEntry(entry));
    this.publishToMQTT(entry);
  }

  /**
   * Log a nivel info
   *
   * @param {string} message - Mensaje
   * @param {Object} context - Contexto
   *
   * @example
   * logger.info('module.loaded', { module: 'echo', version: '1.0.0' });
   */
  info(message, context = {}) {
    if (!this.shouldLog('info')) return;

    const entry = this.createLogEntry('info', message, context);
    this.output(this.formatEntry(entry));
    this.publishToMQTT(entry);
  }

  /**
   * Log a nivel warn
   *
   * @param {string} message - Mensaje
   * @param {Object} context - Contexto
   *
   * @example
   * logger.warn('event.blocked', { eventType: 'forbidden', reason: 'hook' });
   */
  warn(message, context = {}) {
    if (!this.shouldLog('warn')) return;

    const entry = this.createLogEntry('warn', message, context);
    this.output(this.formatEntry(entry));
    this.publishToMQTT(entry);
  }

  /**
   * Log a nivel error
   *
   * @param {string} message - Mensaje
   * @param {Object} context - Contexto
   * @param {Error} error - Error object
   *
   * @example
   * logger.error('event.failed', { eventType: 'user.created' }, err);
   */
  error(message, context = {}, error = null) {
    if (!this.shouldLog('error')) return;

    const entry = this.createLogEntry('error', message, context, error);
    this.output(this.formatEntry(entry));
    this.publishToMQTT(entry);
  }

  /**
   * Crea un child logger con contexto adicional
   *
   * @param {Object} context - Contexto adicional para todos los logs
   * @returns {Logger} Child logger
   *
   * @example
   * const moduleLogger = logger.child({ module: 'security-p2p' });
   * moduleLogger.info('handshake.started'); // Incluirá module en context
   */
  child(context) {
    const childLogger = new Logger({
      level: this.level,
      coreId: this.coreId,
      mqtt: this.mqtt,
      output: this.output
    });

    // Wrapper para agregar context automáticamente
    const originalCreateLogEntry = childLogger.createLogEntry.bind(childLogger);
    childLogger.createLogEntry = (level, message, ctx, error) => {
      return originalCreateLogEntry(level, message, { ...context, ...ctx }, error);
    };

    return childLogger;
  }
}

module.exports = Logger;
