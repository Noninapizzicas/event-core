/**
 * Error Interceptor
 *
 * Captura errores y logs del sistema.
 * Similar a la consola de DevTools para errores JS.
 *
 * Captura:
 * - Errores no capturados (uncaughtException)
 * - Promesas rechazadas (unhandledRejection)
 * - Logs de error/warn del logger
 * - Stack traces completos
 */

class ErrorInterceptor {
  /**
   * @param {ConsoleBuffer} buffer - Buffer donde almacenar entradas
   * @param {Object} core - Core instance
   * @param {Object} options
   * @param {boolean} options.captureErrors - Capturar errores (default: true)
   * @param {boolean} options.captureLogs - Capturar logs (default: true)
   */
  constructor(buffer, core, options = {}) {
    this.buffer = buffer;
    this.core = core;
    this.logger = core.logger;

    this.captureErrors = options.captureErrors !== false;
    this.captureLogs = options.captureLogs !== false;

    // Bound handlers
    this._boundUncaughtException = this._onUncaughtException.bind(this);
    this._boundUnhandledRejection = this._onUnhandledRejection.bind(this);

    // Original logger methods (para wrapping)
    this._originalLoggerError = null;
    this._originalLoggerWarn = null;
    this._originalLoggerInfo = null;
    this._originalLoggerDebug = null;

    this.started = false;
  }

  /**
   * Inicia la interceptación
   */
  async start() {
    if (this.started) return;

    // Capturar errores globales
    if (this.captureErrors) {
      process.on('uncaughtException', this._boundUncaughtException);
      process.on('unhandledRejection', this._boundUnhandledRejection);
    }

    // Wrappear logger
    if (this.captureLogs && this.logger) {
      this._wrapLogger();
    }

    this.started = true;
  }

  /**
   * Detiene la interceptación
   */
  stop() {
    if (!this.started) return;

    // Remover listeners de errores globales
    if (this.captureErrors) {
      process.removeListener('uncaughtException', this._boundUncaughtException);
      process.removeListener('unhandledRejection', this._boundUnhandledRejection);
    }

    // Restaurar logger original
    if (this._originalLoggerError) {
      this._unwrapLogger();
    }

    this.started = false;
  }

  /**
   * Handler: Error no capturado
   */
  _onUncaughtException(error) {
    this.buffer.error(
      'process',
      `Uncaught Exception: ${error.message}`,
      {
        type: 'uncaughtException',
        name: error.name,
        code: error.code
      },
      error.stack
    );

    // Nota: No hacemos process.exit() aquí, dejamos que el handler original lo maneje
  }

  /**
   * Handler: Promesa rechazada no manejada
   */
  _onUnhandledRejection(reason, promise) {
    const message = reason instanceof Error
      ? reason.message
      : String(reason);

    const stack = reason instanceof Error
      ? reason.stack
      : null;

    this.buffer.error(
      'process',
      `Unhandled Rejection: ${message}`,
      {
        type: 'unhandledRejection',
        reason: message
      },
      stack
    );
  }

  /**
   * Wrappea el logger para capturar logs
   */
  _wrapLogger() {
    // Guardar métodos originales
    this._originalLoggerError = this.logger.error?.bind(this.logger);
    this._originalLoggerWarn = this.logger.warn?.bind(this.logger);
    this._originalLoggerInfo = this.logger.info?.bind(this.logger);
    this._originalLoggerDebug = this.logger.debug?.bind(this.logger);

    // Wrapper para error
    if (this._originalLoggerError) {
      this.logger.error = (msg, data) => {
        this._captureLog('error', msg, data);
        this._originalLoggerError(msg, data);
      };
    }

    // Wrapper para warn
    if (this._originalLoggerWarn) {
      this.logger.warn = (msg, data) => {
        this._captureLog('warn', msg, data);
        this._originalLoggerWarn(msg, data);
      };
    }

    // Wrapper para info (solo si es relevante)
    if (this._originalLoggerInfo) {
      this.logger.info = (msg, data) => {
        // Solo capturar info si parece importante
        if (this._isImportantInfo(msg, data)) {
          this._captureLog('info', msg, data);
        }
        this._originalLoggerInfo(msg, data);
      };
    }

    // Debug no lo capturamos por defecto (demasiado verbose)
  }

  /**
   * Restaura el logger original
   */
  _unwrapLogger() {
    if (this._originalLoggerError) {
      this.logger.error = this._originalLoggerError;
    }
    if (this._originalLoggerWarn) {
      this.logger.warn = this._originalLoggerWarn;
    }
    if (this._originalLoggerInfo) {
      this.logger.info = this._originalLoggerInfo;
    }
    if (this._originalLoggerDebug) {
      this.logger.debug = this._originalLoggerDebug;
    }
  }

  /**
   * Captura un log en el buffer
   */
  _captureLog(level, msg, data) {
    // Extraer source del mensaje (formato: "module.action")
    const source = this._extractSource(msg, data);

    // Extraer stack si hay error en data
    const stack = data?.error?.stack || data?.stack || null;

    // Evitar logs del propio system-inspector (loop infinito)
    if (source === 'system-inspector') return;

    this.buffer.add({
      type: level,
      source,
      message: msg,
      data: this._cleanData(data),
      stack
    });
  }

  /**
   * Extrae el módulo/source del mensaje o data
   */
  _extractSource(msg, data) {
    // Si data tiene module, usarlo
    if (data?.module) return data.module;

    // Intentar extraer de formato "module.action"
    if (typeof msg === 'string' && msg.includes('.')) {
      const parts = msg.split('.');
      if (parts.length >= 2) {
        return parts[0];
      }
    }

    return 'core';
  }

  /**
   * Limpia data para evitar circular references y datos sensibles
   */
  _cleanData(data) {
    if (!data) return null;

    try {
      // Clonar y limpiar
      const clean = { ...data };

      // Remover campos sensibles
      delete clean.password;
      delete clean.token;
      delete clean.secret;
      delete clean.apiKey;
      delete clean.api_key;

      // Remover referencias circulares
      return JSON.parse(JSON.stringify(clean));
    } catch (e) {
      return { _note: 'Data not serializable' };
    }
  }

  /**
   * Determina si un log info es importante para capturar
   */
  _isImportantInfo(msg, data) {
    // Capturar eventos de lifecycle
    if (typeof msg === 'string') {
      const important = [
        '.loaded',
        '.unloaded',
        '.started',
        '.stopped',
        '.connected',
        '.disconnected',
        '.created',
        '.deleted',
        '.failed',
        '.error'
      ];

      return important.some(keyword => msg.includes(keyword));
    }

    return false;
  }
}

module.exports = ErrorInterceptor;
