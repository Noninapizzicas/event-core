/**
 * UI Request Handler - Request/Response pattern over MQTT
 *
 * Procesa requests del frontend y envía respuestas estructuradas.
 * Implementa semántica REST sobre MQTT con status codes y timeouts.
 *
 * Topics:
 *   Request:  ui/request/{domain}/{action}
 *   Response: ui/response/{request_id}
 *
 * @see docs/architecture/mqtt-request-response.md
 *
 * @example
 * const handler = new UIRequestHandler({ mqttClient, logger });
 * await handler.start();
 *
 * // Registrar handlers desde módulos
 * handler.register('project', 'list', async (data) => {
 *   return { projects: [...], count: 10 };
 * });
 *
 * handler.register('project', 'create', async (data) => {
 *   if (!data.name) {
 *     throw { status: 400, code: 'VALIDATION_ERROR', message: 'Name is required' };
 *   }
 *   return { project: {...}, created: true };
 * });
 */

// =============================================================================
// STATUS CODES
// =============================================================================

const STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500
};

// =============================================================================
// ERROR CLASSES
// =============================================================================

class UIRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'UIRequestError';
    this.status = status;
    this.code = code;
  }
}

class ValidationError extends UIRequestError {
  constructor(message) {
    super(STATUS.BAD_REQUEST, 'VALIDATION_ERROR', message);
  }
}

class NotFoundError extends UIRequestError {
  constructor(message = 'Resource not found') {
    super(STATUS.NOT_FOUND, 'NOT_FOUND', message);
  }
}

class ConflictError extends UIRequestError {
  constructor(message = 'Resource already exists') {
    super(STATUS.CONFLICT, 'CONFLICT', message);
  }
}

// =============================================================================
// HANDLER CLASS
// =============================================================================

class UIRequestHandler {
  /**
   * @param {Object} options - Configuration
   * @param {Object} options.mqttClient - MQTT client instance
   * @param {Object} options.logger - Logger instance
   * @param {Object} options.metrics - Metrics instance (optional)
   */
  constructor(options = {}) {
    this.mqtt = options.mqttClient;
    this.logger = options.logger;
    this.metrics = options.metrics;

    // Handler registry: Map<'domain.action', handler>
    this.handlers = new Map();

    // Bound message handler
    this._onMessage = this._onMessage.bind(this);
  }

  /**
   * Start listening for UI requests
   * Subscribes to ui/request/# topic
   */
  async start() {
    if (!this.mqtt || !this.mqtt.isConnected) {
      throw new Error('MQTT client not connected');
    }

    // Subscribe to all UI requests
    await this.mqtt.subscribe('ui/request/#', { qos: 1 });

    // Listen for messages
    this.mqtt.on('message', this._onMessage);

    if (this.logger) {
      this.logger.info('ui.request.handler.started', {
        topic: 'ui/request/#'
      });
    }
  }

  /**
   * Stop listening for UI requests
   */
  async stop() {
    if (this.mqtt) {
      this.mqtt.off('message', this._onMessage);
      await this.mqtt.unsubscribe('ui/request/#');
    }

    if (this.logger) {
      this.logger.info('ui.request.handler.stopped');
    }
  }

  /**
   * Register a handler for a domain/action pair
   *
   * @param {string} domain - Domain (e.g., 'project', 'credential')
   * @param {string} action - Action (e.g., 'list', 'create', 'update', 'delete')
   * @param {Function} handler - Async handler function (data, request) => result
   *
   * @example
   * handler.register('project', 'list', async (data, request) => {
   *   const projects = await db.getProjects();
   *   return { projects, count: projects.length };
   * });
   */
  register(domain, action, handler) {
    const key = `${domain}.${action}`;

    if (this.handlers.has(key)) {
      if (this.logger) {
        this.logger.warn('ui.request.handler.overwrite', { domain, action });
      }
    }

    this.handlers.set(key, handler);

    if (this.logger) {
      this.logger.debug('ui.request.handler.registered', { domain, action });
    }
  }

  /**
   * Unregister a handler
   *
   * @param {string} domain - Domain
   * @param {string} action - Action
   */
  unregister(domain, action) {
    const key = `${domain}.${action}`;
    this.handlers.delete(key);

    if (this.logger) {
      this.logger.debug('ui.request.handler.unregistered', { domain, action });
    }
  }

  /**
   * Internal module-to-module call (no MQTT, no request_id needed).
   * Calls the registered handler directly and returns its result.
   *
   * @param {string} domain - Handler domain (e.g. 'ingredientes')
   * @param {string} action - Handler action (e.g. 'list')
   * @param {Object} data - Request data
   * @returns {Promise<Object>} Handler result
   *
   * @example
   * const result = await this.uiHandler.handle('ingredientes', 'list', { grupo: 'pizzas' });
   * // result = { status: 200, data: { ingredientes: [...] } }
   */
  async handle(domain, action, data = {}) {
    const key = `${domain}.${action}`;
    const handler = this.handlers.get(key);

    if (!handler) {
      return { status: 404, error: `No handler registered for ${domain}/${action}` };
    }

    return await handler(data);
  }

  /**
   * Internal message handler
   * @private
   */
  async _onMessage(topic, message) {
    // Only handle ui/request/* topics
    if (!topic.startsWith('ui/request/')) {
      return;
    }

    // Parse topic: ui/request/{domain}/{action}
    const parts = topic.split('/');
    if (parts.length < 4) {
      if (this.logger) {
        this.logger.warn('ui.request.invalid.topic', { topic });
      }
      return;
    }

    const domain = parts[2];
    const action = parts[3];
    const key = `${domain}.${action}`;

    // Parse request
    let request;
    try {
      request = typeof message === 'string' ? JSON.parse(message) : message;
    } catch (error) {
      if (this.logger) {
        this.logger.error('ui.request.parse.failed', { topic, error: error.message });
      }
      return;
    }

    const { request_id, data } = request;

    if (!request_id) {
      if (this.logger) {
        this.logger.warn('ui.request.missing.request_id', { topic });
      }
      return;
    }

    // Metrics
    if (this.metrics) {
      this.metrics.increment('ui.request.received');
      this.metrics.increment(`ui.request.${domain}.${action}`);
    }

    // Log request
    if (this.logger) {
      this.logger.debug('ui.request.received', {
        request_id,
        domain,
        action,
        data_keys: data ? Object.keys(data) : []
      });
    }

    // Find handler
    const handler = this.handlers.get(key);

    if (!handler) {
      await this._sendError(request_id, STATUS.NOT_FOUND, 'HANDLER_NOT_FOUND',
        `No handler registered for ${domain}/${action}`);
      return;
    }

    // Execute handler
    try {
      const startTime = Date.now();
      const result = await handler(data || {}, request);
      const duration = Date.now() - startTime;

      // Unwrap handler results that use { status, data/error } format
      // Many handlers return { status: 201, data: ... } or { status: 404, error: '...' }
      // We need to unwrap these to avoid double-wrapping in the response
      let responseStatus = STATUS.OK;
      let responseData = result;

      if (result && typeof result === 'object' && typeof result.status === 'number') {
        responseStatus = result.status;

        // Handler returned error via { status: 4xx/5xx, error: '...' }
        if (result.error && responseStatus >= 400) {
          const errMsg = typeof result.error === 'string' ? result.error : (result.error.message || 'Unknown error');
          const errCode = typeof result.error === 'string' ? 'HANDLER_ERROR' : (result.error.code || 'HANDLER_ERROR');
          await this._sendError(request_id, responseStatus, errCode, errMsg);

          if (this.logger) {
            this.logger.debug('ui.request.handler_error', {
              request_id, domain, action, status: responseStatus, duration_ms: duration
            });
          }
          return;
        }

        // Handler returned { status, data } — unwrap the data
        if ('data' in result) {
          responseData = result.data;
        }
      }

      // Send success response
      await this._sendSuccess(request_id, responseStatus, responseData);

      // Metrics
      if (this.metrics) {
        this.metrics.increment('ui.request.success');
        this.metrics.observe('ui.request.duration', duration);
      }

      if (this.logger) {
        this.logger.debug('ui.request.completed', {
          request_id,
          domain,
          action,
          duration_ms: duration
        });
      }

    } catch (error) {
      // Determine status and code from error
      const status = error.status || STATUS.INTERNAL_ERROR;
      const code = error.code || 'INTERNAL_ERROR';
      const message = error.message || 'An unexpected error occurred';

      await this._sendError(request_id, status, code, message);

      // Log error (only unexpected errors at error level)
      if (status >= 500) {
        if (this.logger) {
          this.logger.error('ui.request.failed', {
            request_id,
            domain,
            action,
            status,
            code,
            error: message
          }, error);
        }
      } else {
        if (this.logger) {
          this.logger.debug('ui.request.client_error', {
            request_id,
            domain,
            action,
            status,
            code,
            message
          });
        }
      }

      // Metrics
      if (this.metrics) {
        this.metrics.increment('ui.request.error');
        this.metrics.increment(`ui.request.error.${status}`);
      }
    }
  }

  /**
   * Send success response
   * @private
   */
  async _sendSuccess(requestId, status, data) {
    const response = {
      request_id: requestId,
      status,
      success: true,
      data,
      timestamp: new Date().toISOString()
    };

    const topic = `ui/response/${requestId}`;
    await this.mqtt.publish(topic, response, { qos: 1 });

    if (this.logger) {
      this.logger.debug('ui.response.sent', {
        request_id: requestId,
        status,
        success: true
      });
    }
  }

  /**
   * Send error response
   * @private
   */
  async _sendError(requestId, status, code, message) {
    const response = {
      request_id: requestId,
      status,
      success: false,
      error: { code, message },
      timestamp: new Date().toISOString()
    };

    const topic = `ui/response/${requestId}`;
    await this.mqtt.publish(topic, response, { qos: 1 });

    if (this.logger) {
      this.logger.debug('ui.response.sent', {
        request_id: requestId,
        status,
        success: false,
        error_code: code
      });
    }
  }

  /**
   * Get registered handlers info
   */
  getRegisteredHandlers() {
    const handlers = [];
    for (const key of this.handlers.keys()) {
      const [domain, action] = key.split('.');
      handlers.push({ domain, action });
    }
    return handlers;
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = UIRequestHandler;
module.exports.STATUS = STATUS;
module.exports.UIRequestError = UIRequestError;
module.exports.ValidationError = ValidationError;
module.exports.NotFoundError = NotFoundError;
module.exports.ConflictError = ConflictError;
