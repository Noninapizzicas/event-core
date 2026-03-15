/**
 * ConsoleBuffer - Buffer circular para almacenar entradas de consola
 *
 * Similar a la consola de DevTools del navegador:
 * - Almacena últimas N entradas
 * - Soporta tipos: error, warn, info, debug, network, mqtt, validation
 * - Cada entrada tiene timestamp, source, message, data, stack
 */

class ConsoleBuffer {
  /**
   * @param {Object} options
   * @param {number} options.maxSize - Máximo de entradas (default: 500)
   * @param {number} options.truncateAt - Truncar strings largos (default: 1000)
   */
  constructor(options = {}) {
    this.maxSize = options.maxSize || 500;
    this.truncateAt = options.truncateAt || 1000;
    this.entries = [];
    this.stats = {
      total: 0,
      errors: 0,
      warnings: 0,
      network_requests: 0,
      network_failures: 0,
      mqtt_messages: 0
    };
  }

  /**
   * Añade una entrada al buffer
   * @param {Object} entry
   * @param {string} entry.type - error|warn|info|debug|network|mqtt|validation
   * @param {string} entry.source - Módulo/componente origen
   * @param {string} entry.message - Mensaje descriptivo
   * @param {Object} entry.data - Datos adicionales
   * @param {string} entry.stack - Stack trace (para errores)
   */
  add(entry) {
    const normalizedEntry = {
      type: entry.type || 'info',
      ts: entry.ts || new Date().toISOString(),
      source: entry.source || 'unknown',
      message: this._truncate(entry.message || ''),
      ...(entry.data && { data: this._truncateObject(entry.data) }),
      ...(entry.stack && { stack: entry.stack }),
      // Campos específicos de network
      ...(entry.method && { method: entry.method }),
      ...(entry.path && { path: entry.path }),
      ...(entry.status && { status: entry.status }),
      ...(entry.duration_ms !== undefined && { duration_ms: entry.duration_ms }),
      ...(entry.request_body && { request_body: this._truncateObject(entry.request_body) }),
      ...(entry.response_body && { response_body: this._truncateObject(entry.response_body) }),
      ...(entry.error && { error: this._truncate(entry.error) }),
      // Campos específicos de MQTT
      ...(entry.topic && { topic: entry.topic }),
      ...(entry.direction && { direction: entry.direction }),
      ...(entry.payload && { payload: this._truncateObject(entry.payload) }),
      // Campos específicos de validation
      ...(entry.errors && { errors: entry.errors })
    };

    // Añadir al inicio (más reciente primero)
    this.entries.unshift(normalizedEntry);

    // Mantener tamaño máximo
    if (this.entries.length > this.maxSize) {
      this.entries.pop();
    }

    // Actualizar stats
    this._updateStats(normalizedEntry);

    return normalizedEntry;
  }

  /**
   * Métodos de conveniencia para cada tipo
   */
  error(source, message, data = {}, stack = null) {
    return this.add({ type: 'error', source, message, data, stack });
  }

  warn(source, message, data = {}) {
    return this.add({ type: 'warn', source, message, data });
  }

  info(source, message, data = {}) {
    return this.add({ type: 'info', source, message, data });
  }

  debug(source, message, data = {}) {
    return this.add({ type: 'debug', source, message, data });
  }

  network(method, path, status, duration_ms, extra = {}) {
    return this.add({
      type: 'network',
      source: 'http-gateway',
      message: `${method} ${path} → ${status}`,
      method,
      path,
      status,
      duration_ms,
      ...extra
    });
  }

  mqtt(direction, topic, payload) {
    return this.add({
      type: 'mqtt',
      source: 'mqtt',
      message: `${direction}: ${topic}`,
      direction,
      topic,
      payload
    });
  }

  validation(path, method, errors) {
    return this.add({
      type: 'validation',
      source: 'validation',
      message: `Validation failed: ${path}`,
      path,
      method,
      errors
    });
  }

  /**
   * Obtiene todas las entradas
   */
  getAll() {
    return [...this.entries];
  }

  /**
   * Obtiene entradas por tipo
   */
  getByType(type) {
    return this.entries.filter(e => e.type === type);
  }

  /**
   * Obtiene solo errores recientes
   */
  getErrors() {
    return this.entries.filter(e => e.type === 'error');
  }

  /**
   * Obtiene solo requests de red
   */
  getNetwork() {
    return this.entries.filter(e => e.type === 'network');
  }

  /**
   * Obtiene resumen de stats
   */
  getSummary() {
    return { ...this.stats };
  }

  /**
   * Obtiene el estado completo formateado para Claude
   */
  getFullState(coreId = 'unknown', startTime = null) {
    const recentErrors = this.entries
      .filter(e => e.type === 'error')
      .slice(0, 10);

    return {
      _meta: {
        generated_at: new Date().toISOString(),
        core_id: coreId,
        uptime_seconds: startTime ? Math.floor((Date.now() - startTime) / 1000) : null,
        buffer_size: this.maxSize,
        entries_count: this.entries.length
      },
      summary: this.getSummary(),
      recent_errors: recentErrors,
      console: this.entries
    };
  }

  /**
   * Limpia el buffer
   */
  clear() {
    this.entries = [];
    this.stats = {
      total: 0,
      errors: 0,
      warnings: 0,
      network_requests: 0,
      network_failures: 0,
      mqtt_messages: 0
    };
  }

  /**
   * Actualiza estadísticas
   */
  _updateStats(entry) {
    this.stats.total++;

    switch (entry.type) {
      case 'error':
        this.stats.errors++;
        break;
      case 'warn':
        this.stats.warnings++;
        break;
      case 'network':
        this.stats.network_requests++;
        if (entry.status >= 400) {
          this.stats.network_failures++;
        }
        break;
      case 'mqtt':
        this.stats.mqtt_messages++;
        break;
    }
  }

  /**
   * Trunca un string si excede el límite
   */
  _truncate(str) {
    if (typeof str !== 'string') return str;
    if (str.length <= this.truncateAt) return str;
    return str.substring(0, this.truncateAt) + '... [truncated]';
  }

  /**
   * Trunca valores de objeto recursivamente
   */
  _truncateObject(obj, depth = 0) {
    if (depth > 5) return '[max depth]';
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'string') {
      return this._truncate(obj);
    }

    if (Array.isArray(obj)) {
      if (obj.length > 20) {
        return [...obj.slice(0, 20).map(v => this._truncateObject(v, depth + 1)), `... +${obj.length - 20} more`];
      }
      return obj.map(v => this._truncateObject(v, depth + 1));
    }

    if (typeof obj === 'object') {
      const result = {};
      const keys = Object.keys(obj);
      for (const key of keys.slice(0, 50)) {
        result[key] = this._truncateObject(obj[key], depth + 1);
      }
      if (keys.length > 50) {
        result['...'] = `+${keys.length - 50} more keys`;
      }
      return result;
    }

    return obj;
  }
}

module.exports = ConsoleBuffer;
