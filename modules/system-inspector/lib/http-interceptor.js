/**
 * HTTP Interceptor
 *
 * Captura todas las requests/responses HTTP que pasan por el gateway.
 * Similar al panel Network de DevTools.
 *
 * Captura:
 * - Method, path, query params
 * - Status code
 * - Duration (ms)
 * - Request body (truncado)
 * - Response body (truncado)
 * - Headers relevantes
 * - Errores
 */

class HttpInterceptor {
  /**
   * @param {ConsoleBuffer} buffer - Buffer donde almacenar entradas
   * @param {Object} core - Core instance
   */
  constructor(buffer, core) {
    this.buffer = buffer;
    this.core = core;
    this.hooks = core.hooks;
    this.logger = core.logger;

    // Tracking de requests en progreso
    this.pendingRequests = new Map();

    // Bound handlers para poder removerlos después
    this._boundBeforeRequest = this._onBeforeRequest.bind(this);
    this._boundAfterResponse = this._onAfterResponse.bind(this);

    this.started = false;
  }

  /**
   * Inicia la interceptación
   */
  async start() {
    if (this.started) return;

    if (this.hooks) {
      // Registrar hooks en el HTTP Gateway
      this.hooks.register('beforeRequest', this._boundBeforeRequest);
      this.hooks.register('afterResponse', this._boundAfterResponse);

      this.logger?.debug('http-interceptor.started', {
        hooks: ['beforeRequest', 'afterResponse']
      });
    } else {
      this.logger?.warn('http-interceptor.no-hooks', {
        message: 'Hook system not available, using fallback'
      });
    }

    this.started = true;
  }

  /**
   * Detiene la interceptación
   */
  stop() {
    if (!this.started) return;

    if (this.hooks) {
      this.hooks.unregister('beforeRequest', this._boundBeforeRequest);
      this.hooks.unregister('afterResponse', this._boundAfterResponse);
    }

    this.pendingRequests.clear();
    this.started = false;
  }

  /**
   * Hook: Antes de procesar request
   *
   * Contexto recibido del HTTP Gateway:
   * { request_id, method, path, query, body, headers }
   */
  _onBeforeRequest(context) {
    const { request_id, method, path, body, headers } = context;

    // Guardar info del request para calcular duración después
    const key = request_id || `${method}:${path}`;
    this.pendingRequests.set(key, {
      startTime: Date.now(),
      method: method,
      path: path,
      body: body,
      headers: this._extractRelevantHeaders(headers)
    });

    return context; // No modificar, solo observar
  }

  /**
   * Hook: Después de enviar response
   *
   * Contexto recibido del HTTP Gateway:
   * { request_id, status, data, body, headers }
   */
  _onAfterResponse(context) {
    const { request_id, status, data, body } = context;

    // Buscar el request pendiente
    let pending = null;
    let key = null;

    // Primero intentar por request_id
    if (request_id && this.pendingRequests.has(request_id)) {
      key = request_id;
      pending = this.pendingRequests.get(key);
    } else {
      // Fallback: buscar el request más antiguo (FIFO)
      for (const [k, v] of this.pendingRequests.entries()) {
        if (!pending || v.startTime < pending.startTime) {
          key = k;
          pending = v;
        }
      }
    }

    if (pending) {
      const duration_ms = Date.now() - pending.startTime;
      const statusCode = status || 200;

      // Registrar en buffer
      this.buffer.network(
        pending.method,
        pending.path,
        statusCode,
        duration_ms,
        {
          request_body: pending.body,
          response_body: data || body,
          error: statusCode >= 400 ? `HTTP ${statusCode}` : null,
          headers: pending.headers
        }
      );

      this.pendingRequests.delete(key);
    } else {
      // Request no tracked, crear entrada con info limitada
      this.buffer.network(
        'UNKNOWN',
        'unknown',
        status || 200,
        0,
        {
          response_body: data || body,
          note: 'request start not captured'
        }
      );
    }

    return context;
  }

  /**
   * Captura manual de request (para casos donde hooks no funcionan)
   */
  captureRequest(method, path, status, duration_ms, extra = {}) {
    this.buffer.network(method, path, status, duration_ms, extra);
  }

  /**
   * Extrae headers relevantes (no todos, solo útiles para debug)
   */
  _extractRelevantHeaders(headers) {
    if (!headers) return null;

    const relevant = {};
    const keepHeaders = [
      'content-type',
      'content-length',
      'authorization', // Solo indica presencia, no el valor
      'user-agent',
      'x-request-id',
      'x-trace-id'
    ];

    for (const key of keepHeaders) {
      if (headers[key]) {
        if (key === 'authorization') {
          // No exponer token, solo indicar que existe
          relevant[key] = '[present]';
        } else {
          relevant[key] = headers[key];
        }
      }
    }

    return Object.keys(relevant).length > 0 ? relevant : null;
  }
}

module.exports = HttpInterceptor;
