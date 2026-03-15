/**
 * MQTT Topic Helpers
 *
 * Helpers para construir y parsear topics MQTT según la convención:
 * core/{core-id}/{type}/{domain}/{action}
 *
 * @example
 * const topics = require('./mqtt/topics');
 *
 * const topic = topics.build('core-a', 'events', 'user', 'created');
 * // 'core/core-a/events/user/created'
 *
 * const parsed = topics.parse('core/core-a/events/user/created');
 * // { coreId: 'core-a', type: 'events', domain: 'user', action: 'created' }
 */

class TopicHelper {
  /**
   * Construye un topic según la convención
   *
   * @param {string} coreId - ID del core
   * @param {string} type - Tipo (events, api, status, logs, metrics, heartbeat)
   * @param {string} domain - Dominio (opcional)
   * @param {string} action - Acción (opcional)
   * @returns {string} Topic construido
   *
   * @example
   * topics.build('core-a', 'events', 'user', 'created');
   * // 'core/core-a/events/user/created'
   *
   * topics.build('core-a', 'status');
   * // 'core/core-a/status'
   */
  static build(coreId, type, domain = null, action = null) {
    let topic = `core/${coreId}/${type}`;

    if (domain) {
      topic += `/${domain}`;
    }

    if (action) {
      topic += `/${action}`;
    }

    return topic;
  }

  /**
   * Parsea un topic según la convención
   *
   * @param {string} topic - Topic a parsear
   * @returns {Object|null} Objeto parseado o null si no cumple convención
   *
   * @example
   * topics.parse('core/core-a/events/user/created');
   * // { coreId: 'core-a', type: 'events', domain: 'user', action: 'created' }
   */
  static parse(topic) {
    const parts = topic.split('/');

    if (parts.length < 3 || parts[0] !== 'core') {
      return null;
    }

    return {
      coreId: parts[1],
      type: parts[2],
      domain: parts[3] || null,
      action: parts[4] || null,
      extra: parts.slice(5) // Partes adicionales si existen
    };
  }

  /**
   * Construye un topic de eventos
   *
   * @param {string} coreId - ID del core
   * @param {string} eventType - Tipo de evento (ej: 'user.created')
   * @returns {string} Topic
   *
   * @example
   * topics.event('core-a', 'user.created');
   * // 'core/core-a/events/user/created'
   */
  static event(coreId, eventType) {
    const parts = eventType.split('.');
    const domain = parts[0];
    const action = parts.slice(1).join('/');

    return this.build(coreId, 'events', domain, action);
  }

  /**
   * Construye un topic de status
   *
   * @param {string} coreId - ID del core
   * @returns {string} Topic
   *
   * @example
   * topics.status('core-a');
   * // 'core/core-a/status'
   */
  static status(coreId) {
    return this.build(coreId, 'status');
  }

  /**
   * Construye un topic de heartbeat
   *
   * @param {string} coreId - ID del core
   * @returns {string} Topic
   *
   * @example
   * topics.heartbeat('core-a');
   * // 'core/core-a/heartbeat'
   */
  static heartbeat(coreId) {
    return this.build(coreId, 'heartbeat');
  }

  /**
   * Construye un topic de logs
   *
   * @param {string} coreId - ID del core
   * @param {string} level - Nivel de log (debug, info, warn, error)
   * @returns {string} Topic
   *
   * @example
   * topics.logs('core-a', 'error');
   * // 'core/core-a/logs/error'
   */
  static logs(coreId, level) {
    return this.build(coreId, 'logs', level);
  }

  /**
   * Construye un topic de métricas
   *
   * @param {string} coreId - ID del core
   * @returns {string} Topic
   *
   * @example
   * topics.metrics('core-a');
   * // 'core/core-a/metrics'
   */
  static metrics(coreId) {
    return this.build(coreId, 'metrics');
  }

  /**
   * Construye un topic de API (request-reply pattern)
   *
   * @param {string} coreId - ID del core
   * @param {string} endpoint - Endpoint API
   * @param {string} requestId - ID de request único
   * @returns {string} Topic
   *
   * @example
   * topics.api('core-a', 'modules/echo/ping', 'req-123');
   * // 'core/core-a/api/modules/echo/ping/req-123'
   */
  static api(coreId, endpoint, requestId) {
    return `core/${coreId}/api/${endpoint}/${requestId}`;
  }

  /**
   * Construye un patrón wildcard para suscribirse
   *
   * @param {string} coreId - ID del core (usar '+' para todos)
   * @param {string} type - Tipo (usar '+' para todos)
   * @param {string} pattern - Patrón adicional (usar '#' para multi-level)
   * @returns {string} Topic pattern
   *
   * @example
   * topics.pattern('+', 'events', '#');
   * // 'core/+/events/#'  (todos los eventos de todos los cores)
   *
   * topics.pattern('core-a', 'events', 'user/#');
   * // 'core/core-a/events/user/#'  (eventos de user de core-a)
   */
  static pattern(coreId, type, pattern = '#') {
    return `core/${coreId}/${type}/${pattern}`;
  }

  /**
   * Verifica si un topic cumple con la convención
   *
   * @param {string} topic - Topic a verificar
   * @returns {boolean} true si es válido
   *
   * @example
   * topics.isValid('core/core-a/events/user/created');
   * // true
   *
   * topics.isValid('invalid/topic');
   * // false
   */
  static isValid(topic) {
    return this.parse(topic) !== null;
  }

  /**
   * Extrae el core ID de un topic
   *
   * @param {string} topic - Topic
   * @returns {string|null} Core ID o null si no es válido
   *
   * @example
   * topics.extractCoreId('core/core-a/events/user/created');
   * // 'core-a'
   */
  static extractCoreId(topic) {
    const parsed = this.parse(topic);
    return parsed ? parsed.coreId : null;
  }

  /**
   * Extrae el tipo de un topic
   *
   * @param {string} topic - Topic
   * @returns {string|null} Tipo o null si no es válido
   *
   * @example
   * topics.extractType('core/core-a/events/user/created');
   * // 'events'
   */
  static extractType(topic) {
    const parsed = this.parse(topic);
    return parsed ? parsed.type : null;
  }
}

module.exports = TopicHelper;
