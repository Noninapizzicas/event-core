/**
 * Event Envelope - Estructura estándar para eventos
 *
 * Define el formato estándar de eventos en Event Core:
 * - event_id: UUID único
 * - event_type: Tipo de evento (ej: 'user.created')
 * - timestamp: Timestamp ISO 8601
 * - source: Información del emisor { core_id, module_id? }
 * - data: Payload del evento
 * - trace: Trace context (W3C)
 * - metadata: Metadata adicional
 *
 * @example
 * const envelope = EventEnvelope.create('user.created', { id: 123 }, {
 *   coreId: 'core-a',
 *   tracer
 * });
 */

const crypto = require('crypto');

class EventEnvelope {
  /**
   * Crea un event envelope estándar
   *
   * @param {string} eventType - Tipo de evento (ej: 'user.created')
   * @param {*} data - Payload del evento
   * @param {Object} options - Opciones
   * @param {string} options.coreId - ID del core emisor
   * @param {string} options.moduleId - ID del módulo emisor (opcional)
   * @param {Object} options.tracer - Tracer instance para trace context
   * @param {Object} options.metadata - Metadata adicional
   * @returns {Object} Event envelope
   *
   * @example
   * const event = EventEnvelope.create('user.created', { id: 123 }, {
   *   coreId: 'core-a',
   *   moduleId: 'user-service',
   *   tracer,
   *   metadata: { version: '1.0' }
   * });
   */
  static create(eventType, data, options = {}) {
    const envelope = {
      event_id: this.generateEventId(),
      event_type: eventType,
      timestamp: new Date().toISOString(),
      source: {
        core_id: options.coreId || 'unknown'
      },
      data: data,
      metadata: options.metadata || {}
    };

    // Agregar module_id si está presente
    if (options.moduleId) {
      envelope.source.module_id = options.moduleId;
    }

    // Agregar trace context si hay tracer
    if (options.tracer) {
      const traceContext = options.tracer.getCurrentContext();
      if (traceContext) {
        envelope.trace = {
          trace_id: traceContext.traceId,
          span_id: traceContext.spanId,
          parent_span_id: traceContext.parentSpanId
        };
      }
    }

    return envelope;
  }

  /**
   * Genera un event ID único (UUID v4)
   *
   * @returns {string} Event ID
   */
  static generateEventId() {
    return crypto.randomUUID();
  }

  /**
   * Valida que un objeto sea un event envelope válido
   *
   * @param {Object} envelope - Objeto a validar
   * @returns {boolean} true si es válido
   *
   * @example
   * const isValid = EventEnvelope.validate(event);
   */
  static validate(envelope) {
    if (!envelope || typeof envelope !== 'object') {
      return false;
    }

    // Campos requeridos
    const required = ['event_id', 'event_type', 'timestamp', 'source', 'data'];
    for (const field of required) {
      if (!envelope[field]) {
        return false;
      }
    }

    // Source debe tener core_id
    if (!envelope.source.core_id) {
      return false;
    }

    return true;
  }

  /**
   * Extrae el tipo de evento de un envelope
   *
   * @param {Object} envelope - Event envelope
   * @returns {string|null} Event type o null si no es válido
   */
  static extractType(envelope) {
    return envelope && envelope.event_type ? envelope.event_type : null;
  }

  /**
   * Extrae el core ID del emisor
   *
   * @param {Object} envelope - Event envelope
   * @returns {string|null} Core ID o null si no es válido
   */
  static extractCoreId(envelope) {
    return envelope && envelope.source && envelope.source.core_id
      ? envelope.source.core_id
      : null;
  }

  /**
   * Extrae el module ID del emisor (si existe)
   *
   * @param {Object} envelope - Event envelope
   * @returns {string|null} Module ID o null si no existe
   */
  static extractModuleId(envelope) {
    return envelope && envelope.source && envelope.source.module_id
      ? envelope.source.module_id
      : null;
  }

  /**
   * Clona un event envelope
   *
   * @param {Object} envelope - Event envelope original
   * @param {Object} overrides - Campos a sobrescribir
   * @returns {Object} Nuevo envelope
   *
   * @example
   * const cloned = EventEnvelope.clone(originalEvent, {
   *   data: { ...originalEvent.data, modified: true }
   * });
   */
  static clone(envelope, overrides = {}) {
    return {
      ...envelope,
      ...overrides,
      source: {
        ...envelope.source,
        ...(overrides.source || {})
      },
      metadata: {
        ...envelope.metadata,
        ...(overrides.metadata || {})
      }
    };
  }

  /**
   * Serializa un event envelope a JSON string
   *
   * @param {Object} envelope - Event envelope
   * @returns {string} JSON string
   */
  static serialize(envelope) {
    return JSON.stringify(envelope);
  }

  /**
   * Deserializa un JSON string a event envelope
   *
   * @param {string} json - JSON string
   * @returns {Object} Event envelope
   * @throws {Error} Si el JSON es inválido
   */
  static deserialize(json) {
    const envelope = JSON.parse(json);

    if (!this.validate(envelope)) {
      throw new Error('Invalid event envelope');
    }

    return envelope;
  }

  /**
   * Enriquece un event envelope con información adicional
   *
   * @param {Object} envelope - Event envelope
   * @param {Object} enrichment - Información adicional
   * @returns {Object} Envelope enriquecido
   *
   * @example
   * const enriched = EventEnvelope.enrich(event, {
   *   metadata: { enriched_by: 'core-b', enriched_at: Date.now() }
   * });
   */
  static enrich(envelope, enrichment) {
    return {
      ...envelope,
      metadata: {
        ...envelope.metadata,
        ...enrichment.metadata
      }
    };
  }

  /**
   * Extrae el dominio del event type
   *
   * @param {string} eventType - Event type (ej: 'user.created')
   * @returns {string} Dominio (ej: 'user')
   *
   * @example
   * EventEnvelope.getDomain('user.created');
   * // 'user'
   */
  static getDomain(eventType) {
    const parts = eventType.split('.');
    return parts[0];
  }

  /**
   * Extrae la acción del event type
   *
   * @param {string} eventType - Event type (ej: 'user.created')
   * @returns {string} Acción (ej: 'created')
   *
   * @example
   * EventEnvelope.getAction('user.created');
   * // 'created'
   */
  static getAction(eventType) {
    const parts = eventType.split('.');
    return parts.slice(1).join('.');
  }
}

module.exports = EventEnvelope;
