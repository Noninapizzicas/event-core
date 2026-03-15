/**
 * W3C Trace Context Tracer for Event Core
 *
 * Implementa el estándar W3C Trace Context para distributed tracing.
 * https://www.w3.org/TR/trace-context/
 *
 * @example
 * const tracer = new Tracer({ coreId: 'core-a' });
 *
 * // Iniciar un trace
 * const trace = tracer.start('process.file');
 * // ... operaciones
 * trace.end();
 *
 * // Trace con span anidado
 * const rootTrace = tracer.start('http.request');
 * const childTrace = tracer.start('db.query', rootTrace.context);
 * childTrace.end();
 * rootTrace.end();
 */

const crypto = require('crypto');

class Tracer {
  /**
   * @param {Object} options - Opciones de configuración
   * @param {string} options.coreId - ID del core
   * @param {Object} options.logger - Logger instance (opcional)
   */
  constructor(options = {}) {
    this.coreId = options.coreId || 'unknown';
    this.logger = options.logger || null;
    this.currentContext = null; // Contexto activo
  }

  /**
   * Genera un trace ID (32 caracteres hex)
   *
   * @returns {string} Trace ID
   */
  generateTraceId() {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Genera un span ID (16 caracteres hex)
   *
   * @returns {string} Span ID
   */
  generateSpanId() {
    return crypto.randomBytes(8).toString('hex');
  }

  /**
   * Inicia un nuevo trace o span
   *
   * @param {string} operationName - Nombre de la operación (ej: 'event.publish', 'http.request')
   * @param {Object} parentContext - Contexto del trace parent (opcional)
   * @returns {Object} Trace object con métodos end(), addTag(), addLog()
   *
   * @example
   * const trace = tracer.start('process.file');
   * trace.addTag('filename', 'data.json');
   * trace.addLog('Processing started');
   * // ... operaciones
   * trace.end();
   */
  start(operationName, parentContext = null) {
    const traceId = parentContext?.traceId || this.generateTraceId();
    const spanId = this.generateSpanId();
    const parentSpanId = parentContext?.spanId || null;

    const context = {
      traceId,
      spanId,
      parentSpanId,
      operationName,
      startTime: Date.now(),
      tags: {},
      logs: []
    };

    // Setear como contexto actual
    this.currentContext = context;

    // Inyectar trace context en logger si existe
    if (this.logger) {
      this.logger.setTraceContext({ traceId, spanId });
    }

    // Retornar objeto trace con métodos
    return {
      context,

      /**
       * Agrega un tag al trace
       *
       * @param {string} key - Nombre del tag
       * @param {*} value - Valor del tag
       */
      addTag(key, value) {
        context.tags[key] = value;
        return this;
      },

      /**
       * Agrega un log al trace
       *
       * @param {string} message - Mensaje
       * @param {Object} fields - Campos adicionales
       */
      addLog(message, fields = {}) {
        context.logs.push({
          timestamp: Date.now(),
          message,
          fields
        });
        return this;
      },

      /**
       * Marca el trace como error
       *
       * @param {Error} error - Error object
       */
      setError(error) {
        context.tags.error = true;
        context.tags.error_message = error.message;
        context.tags.error_stack = error.stack;
        return this;
      },

      /**
       * Finaliza el trace
       *
       * @returns {Object} Trace data completo
       */
      end() {
        const endTime = Date.now();
        const duration = endTime - context.startTime;

        const traceData = {
          trace_id: context.traceId,
          span_id: context.spanId,
          parent_span_id: context.parentSpanId,
          operation_name: context.operationName,
          start_time: context.startTime,
          end_time: endTime,
          duration_ms: duration,
          tags: context.tags,
          logs: context.logs,
          core_id: this.coreId
        };

        // Log trace completion si hay logger
        if (this.logger) {
          const level = context.tags.error ? 'error' : 'debug';
          this.logger[level]('trace.completed', {
            operation: context.operationName,
            duration_ms: duration,
            ...context.tags
          });
        }

        return traceData;
      }
    };
  }

  /**
   * Obtiene el contexto de trace actual
   *
   * @returns {Object|null} Current trace context
   */
  getCurrentContext() {
    return this.currentContext;
  }

  /**
   * Extrae trace context de un evento MQTT
   *
   * Compatible con W3C Trace Context headers.
   *
   * @param {Object} event - Event envelope
   * @returns {Object|null} Trace context extraído
   *
   * @example
   * const context = tracer.extract(incomingEvent);
   * const trace = tracer.start('handle.event', context);
   */
  extract(event) {
    if (!event.trace) return null;

    return {
      traceId: event.trace.trace_id,
      spanId: event.trace.span_id,
      parentSpanId: event.trace.parent_span_id
    };
  }

  /**
   * Inyecta trace context en un evento MQTT
   *
   * Compatible con W3C Trace Context headers.
   *
   * @param {Object} event - Event envelope
   * @param {Object} context - Trace context a inyectar
   * @returns {Object} Event con trace context inyectado
   *
   * @example
   * const eventWithTrace = tracer.inject(event, trace.context);
   * await mqtt.publish(topic, eventWithTrace);
   */
  inject(event, context = null) {
    const ctx = context || this.currentContext;

    if (!ctx) return event;

    return {
      ...event,
      trace: {
        trace_id: ctx.traceId,
        span_id: ctx.spanId,
        parent_span_id: ctx.parentSpanId
      }
    };
  }

  /**
   * Crea un trace context desde W3C traceparent header
   *
   * Format: 00-{trace-id}-{parent-id}-{flags}
   *
   * @param {string} traceparent - W3C traceparent header
   * @returns {Object|null} Trace context
   *
   * @example
   * const context = tracer.fromW3C('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
   */
  fromW3C(traceparent) {
    if (!traceparent) return null;

    const parts = traceparent.split('-');
    if (parts.length !== 4) return null;

    const [version, traceId, parentId, flags] = parts;

    if (version !== '00') return null; // Solo version 00 soportada

    return {
      traceId,
      spanId: this.generateSpanId(), // Nuevo span ID para este servicio
      parentSpanId: parentId
    };
  }

  /**
   * Convierte trace context a W3C traceparent header
   *
   * @param {Object} context - Trace context
   * @returns {string} W3C traceparent header
   *
   * @example
   * const header = tracer.toW3C(trace.context);
   * // '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
   */
  toW3C(context) {
    const ctx = context || this.currentContext;
    if (!ctx) return null;

    // Format: version-trace_id-span_id-flags
    // flags: 01 = sampled, 00 = not sampled
    return `00-${ctx.traceId}-${ctx.spanId}-01`;
  }
}

module.exports = Tracer;
