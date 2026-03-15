/**
 * Event Bus - EventEmitter wrapper con integración MQTT
 *
 * Provee un event bus híbrido:
 * - Local: EventEmitter para eventos en el mismo core
 * - Distribuido: MQTT para eventos entre cores
 *
 * @example
 * const EventBus = require('./events/bus');
 *
 * const bus = new EventBus({
 *   coreId: 'core-a',
 *   mqtt: mqttClient,
 *   hooks: hookManager,
 *   logger
 * });
 *
 * // Emitir localmente
 * bus.emit('user.created', { id: 123 });
 *
 * // Emitir a core remoto
 * bus.emitTo('core-b', 'user.created', { id: 123 });
 *
 * // Escuchar eventos
 * bus.on('user.created', (event) => {
 *   console.log('User created:', event.data);
 * });
 */

const { EventEmitter } = require('events');
const EventEnvelope = require('./envelope');
const { topics } = require('../mqtt');

// Cargar constantes para validación (opcional)
let HELPERS = null;
try {
  const constants = require('../constants');
  HELPERS = constants.HELPERS;
} catch (e) {
  // constants.js no existe aún o error de carga - validación deshabilitada
}

class EventBus extends EventEmitter {
  /**
   * @param {Object} options - Opciones
   * @param {string} options.coreId - ID del core
   * @param {Object} options.mqtt - Cliente MQTT
   * @param {Object} options.hooks - Hook manager
   * @param {Object} options.logger - Logger instance
   * @param {Object} options.metrics - Metrics instance
   * @param {Object} options.tracer - Tracer instance
   * @param {boolean} options.validateEvents - Validar eventos contra constants.js (default: false)
   * @param {boolean} options.strictValidation - Lanzar error si evento inválido (default: false)
   */
  constructor(options = {}) {
    super();

    this.coreId = options.coreId || 'unknown';
    this.mqtt = options.mqtt || null;
    this.hooks = options.hooks || null;
    this.logger = options.logger || null;
    this.metrics = options.metrics || null;
    this.tracer = options.tracer || null;
    this.activity = options.activity || null;  // ActivityLogger for event flow monitoring

    // Validación de eventos
    this.validateEvents = options.validateEvents || false;
    this.strictValidation = options.strictValidation || false;
    this.unknownEvents = new Set(); // Track eventos no registrados

    // Log collector - captura eventos para log-manager
    this.logCollectorEnabled = true;

    // Suscribirse a eventos de otros cores si MQTT está disponible
    if (this.mqtt) {
      this.setupMQTTSubscriptions();
    }
  }

  /**
   * Envía log de evento al log-manager via MQTT y ActivityLogger
   * @private
   */
  _logEvent(eventType, envelope, direction = 'publish') {
    // No loguear eventos de log (evitar loop infinito)
    if (eventType.startsWith('log/') || eventType.startsWith('log.')) return;
    if (eventType.startsWith('activity.')) return;  // Avoid infinite loop

    // Log to ActivityLogger if available
    if (this.activity) {
      this.activity.logEventFlow(direction, eventType, {
        event_id: envelope?.event_id,
        source_module: envelope?.source?.module_id,
        source_core: envelope?.source?.core_id
      }, { module: envelope?.source?.module_id || 'eventbus' });
    }

    // Legacy MQTT logging - solo si está conectado
    if (!this.logCollectorEnabled || !this.isConnected()) return;

    try {
      this.mqtt.publish('log/eventbus', JSON.stringify({
        ts: new Date().toISOString(),
        level: 'debug',
        source: 'backend',
        module: 'eventbus',
        msg: `event.${direction}`,
        ctx: {
          event_type: eventType,
          event_id: envelope?.event_id,
          source_module: envelope?.source?.module_id,
          direction
        }
      }), { qos: 0 });
    } catch (e) {
      // Silenciar errores de logging
    }
  }

  /**
   * Configura las suscripciones MQTT para recibir eventos de otros cores
   */
  async setupMQTTSubscriptions() {
    try {
      // Suscribirse a eventos dirigidos a este core
      await this.mqtt.subscribe(`core/${this.coreId}/events/#`);

      // Suscribirse a broadcasts (eventos a todos los cores)
      await this.mqtt.subscribe('core/*/events/#');

      // Handler de mensajes MQTT
      this.mqtt.on('message', async (topic, message) => {
        // Solo procesar eventos, no otros tipos de mensajes
        if (!topic.includes('/events/')) {
          return;
        }

        try {
          // Deserializar envelope
          const envelope = typeof message === 'string'
            ? EventEnvelope.deserialize(message)
            : message;

          // Validar envelope
          if (!EventEnvelope.validate(envelope)) {
            if (this.logger) {
              this.logger.warn('event.invalid', {
                topic,
                reason: 'invalid_envelope'
              });
            }
            return;
          }

          // Ignorar eventos emitidos por este mismo core (para evitar loops)
          if (envelope.source.core_id === this.coreId) {
            return;
          }

          // Ejecutar hooks afterEventReceive
          if (this.hooks) {
            const context = await this.hooks.execute('afterEventReceive', {
              event: envelope,
              topic
            });

            // Si hook bloqueó el evento, no emitir
            if (context === null) {
              if (this.logger) {
                this.logger.debug('event.blocked', {
                  event_type: envelope.event_type,
                  reason: 'hook'
                });
              }

              if (this.metrics) {
                // REMOVED: this.metrics.increment('events.blocked');
              }

              return;
            }

            // Usar envelope modificado por hooks si cambió
            if (context.event) {
              this.emitLocal(context.event.event_type, context.event);
            } else {
              this.emitLocal(envelope.event_type, envelope);
            }
          } else {
            this.emitLocal(envelope.event_type, envelope);
          }

          // Log received event to log-manager
          this._logEvent(envelope.event_type, envelope, 'receive');

          if (this.metrics) {
            // REMOVED: this.metrics.increment('events.received');
          }

        } catch (error) {
          if (this.logger) {
            this.logger.error('event.receive.failed', {
              topic,
              error: error.message
            }, error);
          }

          if (this.metrics) {
            // REMOVED: this.metrics.increment('events.receive.failed');
          }
        }
      });

      if (this.logger) {
        this.logger.info('eventbus.mqtt.subscribed', {
          core_id: this.coreId
        });
      }

    } catch (error) {
      if (this.logger) {
        this.logger.error('eventbus.mqtt.setup.failed', {
          error: error.message
        }, error);
      }
    }
  }

  /**
   * Emite un evento localmente (solo EventEmitter)
   *
   * @param {string} eventType - Tipo de evento
   * @param {Object} envelope - Event envelope
   */
  emitLocal(eventType, envelope) {
    super.emit(eventType, envelope);

    if (this.logger) {
      this.logger.debug('event.emitted.local', {
        event_type: eventType,
        event_id: envelope.event_id
      });
    }
  }

  /**
   * Valida que un evento esté registrado en constants.js
   *
   * @param {string} eventType - Nombre del evento
   * @returns {boolean} true si es válido o validación deshabilitada
   */
  validateEvent(eventType) {
    // Si validación deshabilitada o HELPERS no cargado, permitir todo
    if (!this.validateEvents || !HELPERS) {
      return true;
    }

    const isValid = HELPERS.isValidEvent(eventType);

    if (!isValid) {
      // Registrar evento desconocido (solo una vez)
      if (!this.unknownEvents.has(eventType)) {
        this.unknownEvents.add(eventType);

        if (this.logger) {
          this.logger.warn('event.unknown', {
            event_type: eventType,
            hint: 'Agregar a module.json y ejecutar npm run generate:constants'
          });
        }
      }

      // En modo estricto, lanzar error
      if (this.strictValidation) {
        throw new Error(`Evento no registrado: ${eventType}. Agregar a module.json y ejecutar npm run generate:constants`);
      }
    }

    return isValid;
  }

  /**
   * Obtiene eventos no registrados detectados
   *
   * @returns {string[]} Lista de eventos desconocidos
   */
  getUnknownEvents() {
    return Array.from(this.unknownEvents);
  }

  /**
   * Emite un evento (local + MQTT si está configurado)
   *
   * @param {string} eventType - Tipo de evento (ej: 'user.created')
   * @param {*} data - Payload del evento
   * @param {Object} options - Opciones
   * @param {string} options.targetCoreId - Core destino (opcional, si no se pone es broadcast)
   * @param {string} options.moduleId - ID del módulo emisor
   * @param {number} options.qos - QoS MQTT (0, 1, 2)
   * @param {boolean} options.retain - Retain flag MQTT
   * @returns {Promise<void>}
   *
   * @example
   * // Emitir localmente y a todos los cores
   * await bus.emit('user.created', { id: 123 });
   *
   * // Emitir solo a un core específico
   * await bus.emit('user.created', { id: 123 }, { targetCoreId: 'core-b' });
   */
  async emit(eventType, data, options = {}) {
    // Validar evento si está habilitado
    this.validateEvent(eventType);
    // Crear envelope
    const envelope = EventEnvelope.create(eventType, data, {
      coreId: this.coreId,
      moduleId: options.moduleId,
      tracer: this.tracer,
      metadata: options.metadata
    });

    // Ejecutar hooks beforeEventPublish
    let finalEnvelope = envelope;
    if (this.hooks) {
      const context = await this.hooks.execute('beforeEventPublish', {
        eventType,
        data: envelope.data,
        options,
        envelope
      });

      // Si hook bloqueó el evento, no publicar
      if (context === null) {
        if (this.logger) {
          this.logger.debug('event.blocked', {
            event_type: eventType,
            reason: 'hook'
          });
        }

        if (this.metrics) {
          // REMOVED: this.metrics.increment('events.blocked');
        }

        return;
      }

      // Usar envelope modificado por hooks
      if (context.envelope) {
        finalEnvelope = context.envelope;
      }
    }

    // 1. Emitir localmente
    this.emitLocal(eventType, finalEnvelope);

    // 2. Publicar a MQTT si está configurado
    if (this.mqtt && this.mqtt.isConnected) {
      try {
        const topic = options.targetCoreId
          ? topics.event(options.targetCoreId, eventType)
          : topics.event('*', eventType); // Broadcast

        await this.mqtt.publish(topic, finalEnvelope, {
          qos: options.qos || 1,
          retain: options.retain || false
        });

        if (this.logger) {
          this.logger.debug('event.published', {
            event_type: eventType,
            event_id: finalEnvelope.event_id,
            target: options.targetCoreId || 'broadcast'
          });
        }

        // Log to log-manager
        this._logEvent(eventType, finalEnvelope, 'publish');

        if (this.metrics) {
          // REMOVED: this.metrics.increment('events.published');
        }

      } catch (error) {
        if (this.logger) {
          this.logger.error('event.publish.failed', {
            event_type: eventType,
            error: error.message
          }, error);
        }

        if (this.metrics) {
          // REMOVED: this.metrics.increment('events.publish.failed');
        }

        throw error;
      }
    }
  }

  /**
   * Emite un evento a un core específico
   *
   * @param {string} targetCoreId - Core destino
   * @param {string} eventType - Tipo de evento
   * @param {*} data - Payload
   * @param {Object} options - Opciones adicionales
   * @returns {Promise<void>}
   *
   * @example
   * await bus.emitTo('core-b', 'user.created', { id: 123 });
   */
  async emitTo(targetCoreId, eventType, data, options = {}) {
    return this.emit(eventType, data, {
      ...options,
      targetCoreId
    });
  }

  /**
   * Suscribe a un tipo de evento (alias de on)
   * Nomenclatura Pub/Sub para MQTT
   *
   * @param {string} eventType - Tipo de evento
   * @param {Function} handler - Manejador del evento
   * @returns {Function} Función de desuscripción
   */
  subscribe(eventType, handler) {
    this.on(eventType, handler);
    return () => this.off(eventType, handler);
  }

  /**
   * Publica un evento (alias de emit)
   * Nomenclatura Pub/Sub para MQTT
   *
   * @param {string} eventType - Tipo de evento
   * @param {*} data - Datos del evento
   * @param {Object} options - Opciones adicionales
   * @returns {Promise<void>}
   */
  async publish(eventType, data, options = {}) {
    return this.emit(eventType, data, options);
  }

  /**
   * Escucha un tipo de evento
   *
   * @param {string} eventType - Tipo de evento
   * @param {Function} handler - Handler function
   * @returns {Function} Unsubscribe function
   *
   * @example
   * const unsubscribe = bus.on('user.created', (event) => {
   *   console.log('User created:', event.data);
   * });
   *
   * // Más tarde...
   * unsubscribe();
   */
  on(eventType, handler) {
    super.on(eventType, handler);

    // Retornar función de unsubscribe
    return () => {
      this.off(eventType, handler);
    };
  }

  /**
   * Escucha un tipo de evento una sola vez
   *
   * @param {string} eventType - Tipo de evento
   * @param {Function} handler - Handler function
   * @returns {Promise} Promise que se resuelve con el evento
   *
   * @example
   * const event = await bus.once('user.created');
   * console.log('User created:', event.data);
   */
  once(eventType, handler) {
    if (handler) {
      super.once(eventType, handler);
    } else {
      // Si no hay handler, retornar Promise
      return new Promise((resolve) => {
        super.once(eventType, resolve);
      });
    }
  }

  /**
   * Verifica si el EventBus está conectado a MQTT
   *
   * @returns {boolean} true si está conectado
   */
  isConnected() {
    return !!(this.mqtt && this.mqtt.isConnected);
  }

  /**
   * Obtiene estadísticas del event bus
   *
   * @returns {Object} Estadísticas
   */
  getStats() {
    return {
      core_id: this.coreId,
      listeners: this.eventNames().reduce((acc, eventType) => {
        acc[eventType] = this.listenerCount(eventType);
        return acc;
      }, {}),
      mqtt_connected: this.isConnected(),
      validation: {
        enabled: this.validateEvents,
        strict: this.strictValidation,
        unknown_events: this.getUnknownEvents()
      }
    };
  }
}

module.exports = EventBus;
