/**
 * Log Collector
 *
 * Recolecta logs de múltiples fuentes y los envía al SessionLogger:
 * - MQTT: Suscribe a core/+/logs/# para capturar todos los logs del backend
 * - HTTP: Recibe logs del frontend vía POST /api/logs
 * - EventBus: Captura eventos activity.logged, activity.batch
 *
 * Normaliza todos los logs a un formato unificado antes de pasarlos al storage.
 */

class LogCollector {
  /**
   * @param {Object} options
   * @param {Object} options.storage - Instancia de LogStorage (consolidado)
   * @param {Object} options.session - Instancia de SessionLogger (por sesión)
   * @param {Object} options.eventBus - Event bus del core
   * @param {Object} options.logger - Logger del core
   * @param {string} options.coreId - ID del core
   */
  constructor(options = {}) {
    this.storage = options.storage;
    this.session = options.session;
    this.eventBus = options.eventBus;
    this.logger = options.logger;
    this.coreId = options.coreId || 'unknown';

    this.stats = {
      collected: 0,
      fromMqtt: 0,
      fromHttp: 0,
      fromActivity: 0,
      toSession: 0,
      errors: 0
    };

    this.subscriptions = [];
  }

  /**
   * Inicia la recolección de logs
   */
  start() {
    this.subscribeMqtt();
    this.logger?.info('log-collector.started', { coreId: this.coreId });
  }

  /**
   * Suscribe a topics de logs via MQTT/EventBus
   */
  subscribeMqtt() {
    // Suscribir a todos los logs de todos los cores
    const patterns = [
      'core/+/logs/debug',
      'core/+/logs/info',
      'core/+/logs/warn',
      'core/+/logs/error'
    ];

    for (const pattern of patterns) {
      if (this.eventBus?.on) {
        const handler = (topic, message) => {
          if (this.matchesTopic(topic, pattern)) {
            this.handleMqttLog(topic, message);
          }
        };

        this.eventBus.on('mqtt:message', handler);
        this.subscriptions.push({ event: 'mqtt:message', handler });
      }
    }

    // Suscribir directamente al MQTT para capturar logs de interacciones
    if (this.eventBus?.mqtt) {
      this.eventBus.mqtt.subscribe('log/#');
      this.eventBus.mqtt.on('message', (topic, message) => {
        if (topic.startsWith('log/')) {
          this.handleInteractionLog(topic, message);
        }
      });
    }

    // Escuchar eventos internos del sistema
    if (this.eventBus?.on) {
      const eventsToTrack = [
        'module.loaded',
        'module.unloaded',
        'module.error',
        'api.request',
        'api.response',
        'api.error'
      ];

      for (const event of eventsToTrack) {
        this.eventBus.on(event, (data) => {
          this.collectInternalEvent(event, data);
        });
      }

      // Suscribir a eventos de ActivityLogger
      this.eventBus.on('activity.logged', (envelope) => {
        const activity = envelope.data || envelope;
        this.collectActivityLog(activity);
      });

      this.eventBus.on('activity.batch', (envelope) => {
        const data = envelope.data || envelope;
        if (data.entries && Array.isArray(data.entries)) {
          for (const entry of data.entries) {
            this.collectActivityLog(entry);
          }
        }
      });
    }
  }

  /**
   * Recolecta un log de actividad del ActivityLogger
   */
  collectActivityLog(activity) {
    const entry = {
      ts: activity.ts || new Date().toISOString(),
      level: activity.level || 'info',
      source: 'activity',
      module: activity.module,
      msg: `${activity.type}:${activity.action}`,
      ctx: {
        activityId: activity.id,
        type: activity.type,
        action: activity.action,
        outcome: activity.outcome,
        ...(activity.duration_ms && { duration_ms: activity.duration_ms }),
        ...(activity.traceId && { traceId: activity.traceId }),
        ...activity.ctx
      },
      ...(activity.error && { error: activity.error })
    };

    // Escribir al storage consolidado
    this.storage?.write(entry);

    // Escribir al SessionLogger (por módulo)
    if (this.session && entry.module) {
      this.session.write(entry.module, entry);
      this.stats.toSession++;
    }

    this.stats.collected++;
    this.stats.fromActivity++;
  }

  /**
   * Maneja logs de interacciones (HTTP Gateway, Event Bus, etc.)
   */
  handleInteractionLog(topic, message) {
    try {
      const logData = typeof message === 'string' ? JSON.parse(message) : message;

      if (logData.ts && logData.level && logData.source) {
        this.storage?.write(logData);

        // Escribir al SessionLogger
        if (this.session && logData.module) {
          this.session.write(logData.module, logData);
          this.stats.toSession++;
        }

        this.stats.collected++;
        this.stats.fromMqtt++;
      }
    } catch (err) {
      this.stats.errors++;
    }
  }

  /**
   * Verifica si un topic coincide con un patrón
   */
  matchesTopic(topic, pattern) {
    const topicParts = topic.split('/');
    const patternParts = pattern.split('/');

    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i] === '+') continue;
      if (patternParts[i] === '#') return true;
      if (patternParts[i] !== topicParts[i]) return false;
    }

    return topicParts.length === patternParts.length;
  }

  /**
   * Maneja un log recibido via MQTT
   */
  handleMqttLog(topic, message) {
    try {
      const logData = typeof message === 'string' ? JSON.parse(message) : message;

      // Extraer nivel del topic: core/core-a/logs/info -> info
      const parts = topic.split('/');
      const level = parts[parts.length - 1];
      const sourceCore = parts[1];

      // Normalizar al formato unificado
      const entry = this.normalize({
        ...logData,
        level: logData.level || level,
        source: 'backend',
        sourceCore: sourceCore,
        _topic: topic
      });

      this.storage?.write(entry);

      // Escribir al SessionLogger
      if (this.session && entry.module) {
        this.session.write(entry.module, entry);
        this.stats.toSession++;
      }

      this.stats.collected++;
      this.stats.fromMqtt++;

    } catch (err) {
      this.stats.errors++;
      console.error('[log-collector] Error handling MQTT log:', err.message);
    }
  }

  /**
   * Recolecta un evento interno del sistema
   */
  collectInternalEvent(eventType, data) {
    const entry = this.normalize({
      level: 'info',
      source: 'backend',
      module: 'core',
      msg: eventType,
      ctx: data
    });

    this.storage?.write(entry);

    // Escribir al SessionLogger
    if (this.session) {
      this.session.write('core', entry);
      this.stats.toSession++;
    }

    this.stats.collected++;
    this.stats.fromMqtt++;
  }

  /**
   * Agrega un log recibido via HTTP (frontend)
   * @param {Object} logData - Datos del log
   */
  addFromHttp(logData) {
    try {
      const entry = this.normalize({
        ...logData,
        source: logData.source || 'frontend'
      });

      this.storage?.write(entry);

      // Escribir al SessionLogger
      if (this.session && entry.module) {
        this.session.write(entry.module, entry);
        this.stats.toSession++;
      }

      this.stats.collected++;
      this.stats.fromHttp++;

      return { success: true, entry };
    } catch (err) {
      this.stats.errors++;
      return { success: false, error: err.message };
    }
  }

  /**
   * Normaliza un log al formato unificado
   * @param {Object} data - Datos del log
   * @returns {Object} Log normalizado
   */
  normalize(data) {
    return {
      ts: data.ts || data.timestamp || new Date().toISOString(),
      level: data.level || 'info',
      source: data.source || 'unknown',
      module: data.module || data.core_id || 'unknown',
      msg: data.msg || data.message || 'unknown',
      ctx: data.ctx || data.context || {},
      // Metadata adicional
      ...(data.trace_id && { traceId: data.trace_id }),
      ...(data.span_id && { spanId: data.span_id }),
      ...(data.sourceCore && { sourceCore: data.sourceCore }),
      ...(data.error && { error: data.error })
    };
  }

  /**
   * Obtiene estadísticas del collector
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Detiene la recolección
   */
  stop() {
    for (const sub of this.subscriptions) {
      if (this.eventBus?.off) {
        this.eventBus.off(sub.event, sub.handler);
      }
    }
    this.subscriptions = [];

    this.logger?.info('log-collector.stopped', { stats: this.stats });
  }
}

module.exports = LogCollector;
