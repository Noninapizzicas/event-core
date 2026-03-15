/**
 * Metrics System for Event Core
 *
 * Provee métricas básicas: Counter y Histogram.
 * Las métricas se pueden publicar a MQTT para observabilidad distribuida.
 *
 * @example
 * const metrics = new Metrics({ coreId: 'core-a' });
 *
 * // Counter
 * metrics.increment('events.published');
 * metrics.increment('events.published', 5);
 *
 * // Histogram
 * metrics.observe('event.duration_ms', 123.45);
 * metrics.observe('http.request_duration_ms', 45.2);
 *
 * // Get stats
 * const stats = metrics.getStats();
 */

class Metrics {
  /**
   * @param {Object} options - Opciones de configuración
   * @param {string} options.coreId - ID del core
   * @param {Object} options.mqtt - Cliente MQTT (opcional)
   * @param {number} options.publishInterval - Intervalo de publicación en ms (default: 60000)
   */
  constructor(options = {}) {
    this.coreId = options.coreId || 'unknown';
    this.mqtt = options.mqtt || null;
    this.publishInterval = options.publishInterval || 60000; // 1 minuto

    /**
     * Counters: { metric_name: count }
     */
    this.counters = {};

    /**
     * Histograms: { metric_name: { count, sum, min, max, values } }
     */
    this.histograms = {};

    // Auto-publicar métricas si MQTT está configurado
    if (this.mqtt && this.publishInterval > 0) {
      this.publishTimer = setInterval(() => {
        this.publishMetrics();
      }, this.publishInterval);
    }
  }

  /**
   * Incrementa un counter
   *
   * @param {string} name - Nombre del counter
   * @param {number} value - Valor a incrementar (default: 1)
   *
   * @example
   * metrics.increment('events.published');
   * metrics.increment('events.published', 5);
   */
  increment(name, value = 1) {
    if (!this.counters[name]) {
      this.counters[name] = 0;
    }
    this.counters[name] += value;
  }

  /**
   * Decrementa un counter
   *
   * @param {string} name - Nombre del counter
   * @param {number} value - Valor a decrementar (default: 1)
   *
   * @example
   * metrics.decrement('active.connections');
   */
  decrement(name, value = 1) {
    this.increment(name, -value);
  }

  /**
   * Obtiene el valor de un counter
   *
   * @param {string} name - Nombre del counter
   * @returns {number} Valor actual
   */
  getCounter(name) {
    return this.counters[name] || 0;
  }

  /**
   * Sets a gauge value (point-in-time measurement)
   *
   * @param {string} name - Gauge name
   * @param {number} value - Current value
   *
   * @example
   * metrics.gauge('active.connections', 42);
   * metrics.gauge('producto.activos.count', products.size);
   */
  gauge(name, value) {
    this.counters[name] = value;
  }

  /**
   * Records a timing observation (alias for observe)
   *
   * @param {string} name - Timing name
   * @param {number} durationMs - Duration in milliseconds
   *
   * @example
   * metrics.timing('catalogo.sync.duration', Date.now() - start);
   */
  timing(name, durationMs) {
    this.observe(name, durationMs);
  }

  /**
   * Resetea un counter a 0
   *
   * @param {string} name - Nombre del counter
   */
  resetCounter(name) {
    this.counters[name] = 0;
  }

  /**
   * Observa un valor en un histogram
   *
   * @param {string} name - Nombre del histogram
   * @param {number} value - Valor observado
   *
   * @example
   * metrics.observe('event.duration_ms', 123.45);
   * metrics.observe('http.request_duration_ms', 45.2);
   */
  observe(name, value) {
    if (!this.histograms[name]) {
      this.histograms[name] = {
        count: 0,
        sum: 0,
        min: Infinity,
        max: -Infinity,
        values: [] // Mantener últimos 1000 valores para percentiles
      };
    }

    const hist = this.histograms[name];
    hist.count++;
    hist.sum += value;
    hist.min = Math.min(hist.min, value);
    hist.max = Math.max(hist.max, value);

    // Mantener solo últimos 1000 valores
    hist.values.push(value);
    if (hist.values.length > 1000) {
      hist.values.shift();
    }
  }

  /**
   * Obtiene estadísticas de un histogram
   *
   * @param {string} name - Nombre del histogram
   * @returns {Object} Estadísticas (count, sum, min, max, avg, p50, p95, p99)
   */
  getHistogram(name) {
    const hist = this.histograms[name];
    if (!hist || hist.count === 0) {
      return {
        count: 0,
        sum: 0,
        min: 0,
        max: 0,
        avg: 0,
        p50: 0,
        p95: 0,
        p99: 0
      };
    }

    const avg = hist.sum / hist.count;

    // Calcular percentiles
    const sorted = [...hist.values].sort((a, b) => a - b);
    const p50 = this.percentile(sorted, 0.50);
    const p95 = this.percentile(sorted, 0.95);
    const p99 = this.percentile(sorted, 0.99);

    return {
      count: hist.count,
      sum: hist.sum,
      min: hist.min,
      max: hist.max,
      avg: parseFloat(avg.toFixed(2)),
      p50: parseFloat(p50.toFixed(2)),
      p95: parseFloat(p95.toFixed(2)),
      p99: parseFloat(p99.toFixed(2))
    };
  }

  /**
   * Calcula percentil de un array ordenado
   *
   * @param {number[]} sorted - Array ordenado
   * @param {number} p - Percentil (0.0 - 1.0)
   * @returns {number} Valor del percentil
   */
  percentile(sorted, p) {
    if (sorted.length === 0) return 0;

    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Resetea un histogram
   *
   * @param {string} name - Nombre del histogram
   */
  resetHistogram(name) {
    delete this.histograms[name];
  }

  /**
   * Obtiene todas las métricas
   *
   * @returns {Object} Todas las métricas (counters + histograms)
   */
  getStats() {
    const stats = {
      timestamp: new Date().toISOString(),
      core_id: this.coreId,
      counters: { ...this.counters },
      histograms: {}
    };

    // Procesar histograms
    Object.keys(this.histograms).forEach(name => {
      stats.histograms[name] = this.getHistogram(name);
    });

    return stats;
  }

  /**
   * Publica métricas a MQTT
   */
  async publishMetrics() {
    if (!this.mqtt) return;

    try {
      const stats = this.getStats();
      const topic = `core/${this.coreId}/metrics`;
      await this.mqtt.publish(topic, JSON.stringify(stats), { qos: 0 });
    } catch (error) {
      console.error('Failed to publish metrics to MQTT:', error.message);
    }
  }

  /**
   * Resetea todas las métricas
   */
  resetAll() {
    this.counters = {};
    this.histograms = {};
  }

  /**
   * Detiene la publicación automática de métricas
   */
  stop() {
    if (this.publishTimer) {
      clearInterval(this.publishTimer);
      this.publishTimer = null;
    }
  }

  /**
   * Helper: Medir duración de una función async
   *
   * @param {string} name - Nombre del histogram
   * @param {Function} fn - Función async a medir
   * @returns {Promise<*>} Resultado de la función
   *
   * @example
   * const result = await metrics.measure('db.query', async () => {
   *   return await db.query('SELECT * FROM users');
   * });
   */
  async measure(name, fn) {
    const start = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - start;
      this.observe(name, duration);
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      this.observe(name, duration);
      this.increment(`${name}.errors`);
      throw error;
    }
  }

  /**
   * Helper: Medir duración de una función sync
   *
   * @param {string} name - Nombre del histogram
   * @param {Function} fn - Función sync a medir
   * @returns {*} Resultado de la función
   *
   * @example
   * const result = metrics.measureSync('json.parse', () => {
   *   return JSON.parse(data);
   * });
   */
  measureSync(name, fn) {
    const start = Date.now();
    try {
      const result = fn();
      const duration = Date.now() - start;
      this.observe(name, duration);
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      this.observe(name, duration);
      this.increment(`${name}.errors`);
      throw error;
    }
  }

  /**
   * Obtiene todas las métricas (alias de getStats para compatibilidad)
   *
   * @returns {Object} Todas las métricas
   */
  getAll() {
    return this.getStats();
  }
}

module.exports = Metrics;
