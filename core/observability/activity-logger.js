/**
 * ActivityLogger - Centralized Activity Monitoring for Event Core
 *
 * Sistema de logging unificado para monitorear todas las acciones, eventos,
 * comunicaciones y respuestas del sistema organizadas por módulo.
 *
 * Tipos de actividad soportados:
 * - MODULE_ACTION: Acciones ejecutadas por módulos
 * - EVENT_FLOW: Flujo de eventos (publicación/suscripción)
 * - API_OPERATION: Operaciones HTTP entrantes/salientes
 * - COMMUNICATION: Comunicaciones entre módulos/cores
 * - PERFORMANCE: Métricas de rendimiento
 *
 * @example
 * const activity = new ActivityLogger({ coreId: 'core-a', eventBus });
 *
 * // Loggear acción de módulo
 * activity.logModuleAction('file-browser', 'file.created', { path: '/docs/new.md' });
 *
 * // Loggear flujo de evento
 * activity.logEventFlow('publish', 'user.created', { userId: '123' });
 *
 * // Loggear operación API
 * activity.logApiOperation('request', 'GET', '/api/files', { status: 200, duration: 45 });
 */

const crypto = require('crypto');

// Activity types
const ACTIVITY_TYPES = {
  MODULE_ACTION: 'module_action',
  EVENT_FLOW: 'event_flow',
  API_OPERATION: 'api_operation',
  COMMUNICATION: 'communication',
  PERFORMANCE: 'performance',
  SYSTEM: 'system'
};

// Operation outcomes
const OUTCOMES = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  PENDING: 'pending',
  TIMEOUT: 'timeout'
};

class ActivityLogger {
  /**
   * @param {Object} options - Opciones de configuración
   * @param {string} options.coreId - ID del core
   * @param {Object} options.eventBus - Event bus para publicar logs
   * @param {Object} options.logger - Logger base (opcional)
   * @param {boolean} options.enabled - Habilitar logging (default: true)
   * @param {string} options.minLevel - Nivel mínimo (debug, info, warn, error)
   */
  constructor(options = {}) {
    this.coreId = options.coreId || 'unknown';
    this.eventBus = options.eventBus || null;
    this.logger = options.logger || null;
    this.enabled = options.enabled !== false;
    this.minLevel = options.minLevel || 'info';

    // Buffer para batch processing
    this.buffer = [];
    this.bufferSize = options.bufferSize || 50;
    this.flushInterval = options.flushInterval || 5000;

    // Stats
    this.stats = {
      total: 0,
      byType: {},
      byModule: {},
      byOutcome: {}
    };

    // Start flush timer
    if (this.enabled) {
      this._flushTimer = setInterval(() => this._flush(), this.flushInterval);
    }
  }

  /**
   * Genera un ID único para la actividad
   */
  _generateActivityId() {
    return `act_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * Crea una entrada de actividad normalizada
   */
  _createEntry(type, data) {
    const entry = {
      id: this._generateActivityId(),
      ts: new Date().toISOString(),
      type,
      coreId: this.coreId,
      module: data.module || 'unknown',
      action: data.action || 'unknown',
      outcome: data.outcome || OUTCOMES.SUCCESS,
      duration_ms: data.duration_ms || null,
      level: data.level || 'info',
      ctx: data.ctx || {},
      // Trace context if available
      ...(data.traceId && { traceId: data.traceId }),
      ...(data.spanId && { spanId: data.spanId }),
      // Error info if present
      ...(data.error && {
        error: {
          message: data.error.message || String(data.error),
          code: data.error.code,
          stack: data.error.stack
        }
      })
    };

    return entry;
  }

  /**
   * Registra una entrada de actividad
   */
  _log(entry) {
    if (!this.enabled) return;

    // Update stats
    this.stats.total++;
    this.stats.byType[entry.type] = (this.stats.byType[entry.type] || 0) + 1;
    this.stats.byModule[entry.module] = (this.stats.byModule[entry.module] || 0) + 1;
    this.stats.byOutcome[entry.outcome] = (this.stats.byOutcome[entry.outcome] || 0) + 1;

    // Add to buffer
    this.buffer.push(entry);

    // Flush if buffer full
    if (this.buffer.length >= this.bufferSize) {
      this._flush();
    }

    // Also log to base logger if configured
    if (this.logger) {
      const logMethod = entry.level === 'error' ? 'error' :
                        entry.level === 'warn' ? 'warn' :
                        entry.level === 'debug' ? 'debug' : 'info';
      this.logger[logMethod](`activity.${entry.type}`, {
        module: entry.module,
        action: entry.action,
        outcome: entry.outcome,
        ...(entry.duration_ms && { duration_ms: entry.duration_ms }),
        ...entry.ctx
      });
    }

    return entry;
  }

  /**
   * Flush buffer to event bus / storage
   */
  _flush() {
    if (this.buffer.length === 0) return;

    const entries = [...this.buffer];
    this.buffer = [];

    // Publish to event bus for log-manager to capture
    if (this.eventBus?.publish) {
      for (const entry of entries) {
        this.eventBus.publish('activity.logged', entry).catch(() => {});
      }
    }

    // Also publish batch for efficiency
    if (this.eventBus?.publish && entries.length > 1) {
      this.eventBus.publish('activity.batch', {
        count: entries.length,
        entries
      }).catch(() => {});
    }
  }

  // ===========================================================================
  // PUBLIC API - Logging Methods
  // ===========================================================================

  /**
   * Log a module action
   *
   * @param {string} module - Module name
   * @param {string} action - Action name (e.g., 'file.created', 'user.deleted')
   * @param {Object} ctx - Additional context
   * @param {Object} options - Options (outcome, duration_ms, error)
   *
   * @example
   * activity.logModuleAction('file-browser', 'file.created', {
   *   path: '/docs/new.md',
   *   size: 1024
   * });
   */
  logModuleAction(module, action, ctx = {}, options = {}) {
    return this._log(this._createEntry(ACTIVITY_TYPES.MODULE_ACTION, {
      module,
      action,
      ctx,
      ...options
    }));
  }

  /**
   * Log an event flow (publish/subscribe)
   *
   * @param {string} direction - 'publish', 'subscribe', 'receive'
   * @param {string} eventType - Event type
   * @param {Object} ctx - Event data/context
   * @param {Object} options - Options (module, outcome, duration_ms)
   *
   * @example
   * activity.logEventFlow('publish', 'user.created', { userId: '123' }, { module: 'auth' });
   */
  logEventFlow(direction, eventType, ctx = {}, options = {}) {
    return this._log(this._createEntry(ACTIVITY_TYPES.EVENT_FLOW, {
      module: options.module || 'eventbus',
      action: `${direction}:${eventType}`,
      ctx: {
        direction,
        eventType,
        ...ctx
      },
      ...options
    }));
  }

  /**
   * Log an API operation (request/response)
   *
   * @param {string} phase - 'request', 'response'
   * @param {string} method - HTTP method
   * @param {string} path - Request path
   * @param {Object} ctx - Context (status, duration_ms, body, etc.)
   * @param {Object} options - Options (module, outcome)
   *
   * @example
   * activity.logApiOperation('response', 'GET', '/api/files', {
   *   status: 200,
   *   duration_ms: 45
   * });
   */
  logApiOperation(phase, method, path, ctx = {}, options = {}) {
    const outcome = ctx.status >= 400 ? OUTCOMES.FAILURE : OUTCOMES.SUCCESS;

    return this._log(this._createEntry(ACTIVITY_TYPES.API_OPERATION, {
      module: options.module || 'http-gateway',
      action: `${phase}:${method}:${path}`,
      ctx: {
        phase,
        method,
        path,
        ...ctx
      },
      outcome: options.outcome || outcome,
      duration_ms: ctx.duration_ms,
      ...options
    }));
  }

  /**
   * Log inter-module or inter-core communication
   *
   * @param {string} direction - 'send', 'receive'
   * @param {string} from - Source module/core
   * @param {string} to - Target module/core
   * @param {string} messageType - Message type
   * @param {Object} ctx - Message context
   * @param {Object} options - Options
   *
   * @example
   * activity.logCommunication('send', 'ai-gateway', 'chat-provider', 'chat.request', { model: 'gpt-4' });
   */
  logCommunication(direction, from, to, messageType, ctx = {}, options = {}) {
    return this._log(this._createEntry(ACTIVITY_TYPES.COMMUNICATION, {
      module: from,
      action: `${direction}:${messageType}`,
      ctx: {
        direction,
        from,
        to,
        messageType,
        ...ctx
      },
      ...options
    }));
  }

  /**
   * Log a performance measurement
   *
   * @param {string} module - Module name
   * @param {string} operation - Operation name
   * @param {number} duration_ms - Duration in milliseconds
   * @param {Object} ctx - Additional context (memory, cpu, etc.)
   *
   * @example
   * activity.logPerformance('database', 'query.users', 123.45, { rows: 100 });
   */
  logPerformance(module, operation, duration_ms, ctx = {}) {
    return this._log(this._createEntry(ACTIVITY_TYPES.PERFORMANCE, {
      module,
      action: operation,
      duration_ms,
      level: 'debug',
      ctx: {
        operation,
        duration_ms,
        ...ctx
      }
    }));
  }

  /**
   * Log a system event (startup, shutdown, config change, etc.)
   *
   * @param {string} action - System action
   * @param {Object} ctx - Context
   * @param {Object} options - Options
   *
   * @example
   * activity.logSystem('core.started', { modules: 23, uptime: 0 });
   */
  logSystem(action, ctx = {}, options = {}) {
    return this._log(this._createEntry(ACTIVITY_TYPES.SYSTEM, {
      module: 'core',
      action,
      ctx,
      ...options
    }));
  }

  /**
   * Log an error in any context
   *
   * @param {string} module - Module name
   * @param {string} action - Action that failed
   * @param {Error} error - Error object
   * @param {Object} ctx - Additional context
   *
   * @example
   * activity.logError('file-browser', 'file.read', error, { path: '/invalid/path' });
   */
  logError(module, action, error, ctx = {}) {
    return this._log(this._createEntry(ACTIVITY_TYPES.MODULE_ACTION, {
      module,
      action,
      error,
      outcome: OUTCOMES.FAILURE,
      level: 'error',
      ctx
    }));
  }

  // ===========================================================================
  // UTILITY METHODS
  // ===========================================================================

  /**
   * Start a timed operation (returns function to end and log)
   *
   * @param {string} module - Module name
   * @param {string} operation - Operation name
   * @returns {Function} Function to call when operation ends
   *
   * @example
   * const end = activity.startTimer('database', 'query.complex');
   * // ... operation ...
   * end({ rows: 100 }); // Logs with duration
   */
  startTimer(module, operation) {
    const startTime = Date.now();

    return (ctx = {}, options = {}) => {
      const duration_ms = Date.now() - startTime;
      return this.logPerformance(module, operation, duration_ms, { ...ctx, ...options });
    };
  }

  /**
   * Create a child logger scoped to a module
   *
   * @param {string} module - Module name
   * @returns {Object} Scoped activity logger
   *
   * @example
   * const moduleActivity = activity.forModule('file-browser');
   * moduleActivity.action('file.created', { path: '/docs/new.md' });
   */
  forModule(module) {
    const self = this;

    return {
      action: (action, ctx, options) =>
        self.logModuleAction(module, action, ctx, options),

      error: (action, error, ctx) =>
        self.logError(module, action, error, ctx),

      event: (direction, eventType, ctx, options) =>
        self.logEventFlow(direction, eventType, ctx, { ...options, module }),

      api: (phase, method, path, ctx, options) =>
        self.logApiOperation(phase, method, path, ctx, { ...options, module }),

      perf: (operation, duration_ms, ctx) =>
        self.logPerformance(module, operation, duration_ms, ctx),

      timer: (operation) =>
        self.startTimer(module, operation),

      comm: (direction, to, messageType, ctx, options) =>
        self.logCommunication(direction, module, to, messageType, ctx, options)
    };
  }

  /**
   * Get current stats
   */
  getStats() {
    return {
      ...this.stats,
      bufferSize: this.buffer.length
    };
  }

  /**
   * Force flush and cleanup
   */
  close() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    this._flush();
  }
}

// Export class and constants
module.exports = ActivityLogger;
module.exports.ACTIVITY_TYPES = ACTIVITY_TYPES;
module.exports.OUTCOMES = OUTCOMES;
