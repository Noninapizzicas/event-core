/**
 * MQTT Interceptor
 *
 * Captura mensajes MQTT que fluyen por el sistema.
 * Similar al panel Network de DevTools pero para MQTT.
 *
 * Captura:
 * - Eventos publicados
 * - Eventos recibidos
 * - Topics
 * - Payloads (truncados)
 */

class MqttInterceptor {
  /**
   * @param {ConsoleBuffer} buffer - Buffer donde almacenar entradas
   * @param {Object} core - Core instance
   */
  constructor(buffer, core) {
    this.buffer = buffer;
    this.core = core;
    this.eventBus = core.eventBus;
    this.logger = core.logger;

    // Bound handlers
    this._boundOnMessage = this._onMessage.bind(this);

    // Original publish method
    this._originalPublish = null;

    this.started = false;

    // Topics a ignorar (muy ruidosos)
    this.ignoredTopics = [
      /heartbeat/i,
      /ping/i,
      /pong/i,
      /system-inspector/i  // Evitar loop
    ];
  }

  /**
   * Inicia la interceptación
   */
  async start() {
    if (this.started) return;

    if (this.eventBus) {
      // Suscribirse a todos los mensajes
      this._subscribeToEvents();

      // Wrappear publish para capturar mensajes salientes
      this._wrapPublish();

      this.logger?.debug('mqtt-interceptor.started');
    } else {
      this.logger?.warn('mqtt-interceptor.no-eventbus');
    }

    this.started = true;
  }

  /**
   * Detiene la interceptación
   */
  stop() {
    if (!this.started) return;

    // Restaurar publish original
    if (this._originalPublish) {
      this.eventBus.publish = this._originalPublish;
    }

    this.started = false;
  }

  /**
   * Suscribe a eventos del sistema
   */
  _subscribeToEvents() {
    // Usar el listener general si está disponible
    if (typeof this.eventBus.on === 'function') {
      this.eventBus.on('message', this._boundOnMessage);
    }

    // Suscribirse a topics específicos de interés
    const topics = [
      'core/+/events/#',
      'core/+/errors/#',
      'core/+/status',
      'modules/+/events/#'
    ];

    for (const topic of topics) {
      if (typeof this.eventBus.subscribe === 'function') {
        try {
          const result = this.eventBus.subscribe(topic, (data, info) => {
            this._captureIncoming(info?.topic || topic, data);
          });
          // Handle promise if returned
          if (result && typeof result.catch === 'function') {
            result.catch(() => {});
          }
        } catch (e) {
          // Ignore subscription errors
        }
      }
    }
  }

  /**
   * Wrappea el método publish
   */
  _wrapPublish() {
    if (!this.eventBus.publish) return;

    this._originalPublish = this.eventBus.publish.bind(this.eventBus);

    this.eventBus.publish = async (topic, payload, options) => {
      // Capturar mensaje saliente
      this._captureOutgoing(topic, payload);

      // Llamar al original
      return this._originalPublish(topic, payload, options);
    };
  }

  /**
   * Handler: Mensaje genérico
   */
  _onMessage(topic, message) {
    if (this._shouldIgnore(topic)) return;

    this.buffer.mqtt('in', topic, message);
  }

  /**
   * Captura mensaje entrante
   */
  _captureIncoming(topic, payload) {
    if (this._shouldIgnore(topic)) return;

    this.buffer.mqtt('in', topic, payload);
  }

  /**
   * Captura mensaje saliente
   */
  _captureOutgoing(topic, payload) {
    if (this._shouldIgnore(topic)) return;

    this.buffer.mqtt('out', topic, payload);
  }

  /**
   * Determina si un topic debe ignorarse
   */
  _shouldIgnore(topic) {
    if (!topic) return true;

    return this.ignoredTopics.some(pattern => {
      if (pattern instanceof RegExp) {
        return pattern.test(topic);
      }
      return topic.includes(pattern);
    });
  }
}

module.exports = MqttInterceptor;
