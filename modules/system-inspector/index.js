/**
 * System Inspector Module
 *
 * Captura todo lo que ocurre en el sistema (como la consola de DevTools)
 * en formato JSON para que Claude pueda consultarlo directamente.
 *
 * Captura:
 * - Requests/Responses HTTP con status, duration, bodies
 * - Errores con stack traces completos
 * - Warnings del sistema
 * - Mensajes MQTT
 * - Errores de validación
 * - Logs de todos los módulos
 *
 * Salida:
 * - GET /modules/system-inspector/status → JSON completo
 * - Archivo /data/system-console.json (actualizado cada 2s)
 */

const ConsoleBuffer = require('./lib/console-buffer');
const HttpInterceptor = require('./lib/http-interceptor');
const ErrorInterceptor = require('./lib/error-interceptor');
const MqttInterceptor = require('./lib/mqtt-interceptor');
const FileWriter = require('./lib/file-writer');

class SystemInspectorModule {
  constructor() {
    this.core = null;
    this.logger = null;
    this.config = null;
    this.startTime = null;

    // Componentes
    this.buffer = null;
    this.httpInterceptor = null;
    this.errorInterceptor = null;
    this.mqttInterceptor = null;
    this.fileWriter = null;
  }

  /**
   * Lifecycle: onLoad
   */
  async onLoad(core) {
    this.core = core;
    this.logger = core.logger;
    this.startTime = Date.now();

    // Cargar configuración
    this.config = this._loadConfig();

    // Solo cargar en desarrollo
    if (process.env.NODE_ENV === 'production' && !this.config.force_in_production) {
      this.logger?.warn('system-inspector.skipped', {
        reason: 'production environment',
        hint: 'Set force_in_production: true to override'
      });
      return;
    }

    // Inicializar buffer
    this.buffer = new ConsoleBuffer({
      maxSize: this.config.buffer_size,
      truncateAt: this.config.truncate_bodies
    });

    // Inicializar interceptores
    await this._initializeInterceptors();

    // Inicializar file writer
    this._initializeFileWriter();

    this.logger?.info('system-inspector.loaded', {
      buffer_size: this.config.buffer_size,
      output_file: this.config.output_file,
      capture: this.config.capture
    });

    // Log inicial
    this.buffer.info('system-inspector', 'System Inspector initialized', {
      config: this.config
    });
  }

  /**
   * Lifecycle: onUnload
   */
  async onUnload() {
    // Detener interceptores
    if (this.httpInterceptor) {
      this.httpInterceptor.stop();
    }
    if (this.errorInterceptor) {
      this.errorInterceptor.stop();
    }
    if (this.mqttInterceptor) {
      this.mqttInterceptor.stop();
    }
    if (this.fileWriter) {
      this.fileWriter.stop();
    }

    this.logger?.info('system-inspector.unloaded');
  }

  /**
   * Carga configuración del módulo
   */
  _loadConfig() {
    const moduleConfig = this.core.moduleConfig || {};

    return {
      buffer_size: moduleConfig.buffer_size || 500,
      write_interval_ms: moduleConfig.write_interval_ms || 2000,
      output_file: moduleConfig.output_file || './data/system-console.json',
      truncate_bodies: moduleConfig.truncate_bodies || 1000,
      force_in_production: moduleConfig.force_in_production || false,
      capture: {
        http: moduleConfig.capture?.http !== false,
        mqtt: moduleConfig.capture?.mqtt !== false,
        errors: moduleConfig.capture?.errors !== false,
        logs: moduleConfig.capture?.logs !== false,
        validation: moduleConfig.capture?.validation !== false
      }
    };
  }

  /**
   * Inicializa los interceptores
   */
  async _initializeInterceptors() {
    // HTTP Interceptor
    if (this.config.capture.http) {
      this.httpInterceptor = new HttpInterceptor(this.buffer, this.core);
      await this.httpInterceptor.start();
    }

    // Error Interceptor
    if (this.config.capture.errors || this.config.capture.logs) {
      this.errorInterceptor = new ErrorInterceptor(this.buffer, this.core, {
        captureErrors: this.config.capture.errors,
        captureLogs: this.config.capture.logs
      });
      await this.errorInterceptor.start();
    }

    // MQTT Interceptor
    if (this.config.capture.mqtt) {
      this.mqttInterceptor = new MqttInterceptor(this.buffer, this.core);
      await this.mqttInterceptor.start();
    }
  }

  /**
   * Inicializa el file writer
   */
  _initializeFileWriter() {
    this.fileWriter = new FileWriter({
      buffer: this.buffer,
      filePath: this.config.output_file,
      intervalMs: this.config.write_interval_ms,
      coreId: this.core.id,
      startTime: this.startTime
    });
    this.fileWriter.start();
  }

  // ===========================================================================
  // API Handlers
  // ===========================================================================

  /**
   * GET /status - Estado completo del sistema
   */
  handleGetStatus(req, res) {
    if (!this.buffer) {
      return {
        error: 'System Inspector not initialized',
        reason: process.env.NODE_ENV === 'production'
          ? 'Disabled in production'
          : 'Module not loaded'
      };
    }

    return this.buffer.getFullState(this.core.id, this.startTime);
  }

  /**
   * GET /errors - Solo errores recientes
   */
  handleGetErrors(req, res) {
    if (!this.buffer) {
      return { error: 'System Inspector not initialized' };
    }

    return {
      generated_at: new Date().toISOString(),
      count: this.buffer.getErrors().length,
      errors: this.buffer.getErrors()
    };
  }

  /**
   * GET /network - Solo requests HTTP
   */
  handleGetNetwork(req, res) {
    if (!this.buffer) {
      return { error: 'System Inspector not initialized' };
    }

    return {
      generated_at: new Date().toISOString(),
      count: this.buffer.getNetwork().length,
      requests: this.buffer.getNetwork()
    };
  }

  /**
   * DELETE /clear - Limpia el buffer
   */
  handleClear(req, res) {
    if (!this.buffer) {
      return { error: 'System Inspector not initialized' };
    }

    this.buffer.clear();

    return {
      success: true,
      message: 'Console buffer cleared'
    };
  }
}

module.exports = SystemInspectorModule;
