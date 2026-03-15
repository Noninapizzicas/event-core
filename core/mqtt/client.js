/**
 * MQTT Client Wrapper con fallback automático a broker embebido
 *
 * Intenta conectarse a un broker externo, y si falla, arranca el broker embebido.
 *
 * @example
 * const MQTTClient = require('./mqtt/client');
 *
 * const client = new MQTTClient({
 *   brokerUrl: 'mqtt://localhost:1883',
 *   coreId: 'core-a',
 *   logger
 * });
 *
 * await client.connect();
 * await client.publish('test/topic', { message: 'hello' });
 * await client.subscribe('test/#');
 * client.on('message', (topic, message) => {
 *   console.log('Received:', topic, message);
 * });
 */

const { EventEmitter } = require('events');
const EmbeddedBroker = require('../broker/embedded');
const ConnectionPool = require('./pool');

class MQTTClient extends EventEmitter {
  /**
   * @param {Object} options - Opciones de configuración
   * @param {string} options.brokerUrl - URL del broker externo (ej: 'mqtt://localhost:1883')
   * @param {string} options.coreId - ID del core (usado como client ID)
   * @param {number} options.connectTimeout - Timeout de conexión en ms (default: 2000)
   * @param {number} options.brokerPort - Puerto del broker embebido (default: 1883)
   * @param {Object} options.logger - Logger instance (opcional)
   * @param {Object} options.metrics - Metrics instance (opcional)
   * @param {boolean} options.usePool - Enable connection pooling for publish operations (default: false)
   * @param {Object} options.poolConfig - Connection pool configuration (optional)
   */
  constructor(options = {}) {
    super();

    this.brokerUrl = options.brokerUrl || 'mqtt://localhost:1883';
    this.coreId = options.coreId || `core-${Date.now()}`;
    this.connectTimeout = options.connectTimeout || 2000;
    this.brokerPort = options.brokerPort || 1883;
    this.logger = options.logger || null;
    this.metrics = options.metrics || null;

    this.mqtt = null;
    this.embeddedBroker = null;
    this.isConnected = false;
    this.usingEmbedded = false;

    // Connection pooling
    this.usePool = options.usePool || false;
    this.pool = null;
    this.poolConfig = options.poolConfig || {};

    // Suscripciones activas
    this.subscriptions = new Map(); // topic -> qos
  }

  /**
   * Conecta al broker MQTT con fallback automático
   *
   * 1. Intenta conectarse al broker externo
   * 2. Si falla, arranca broker embebido y conecta a él
   *
   * @returns {Promise<void>}
   *
   * @example
   * await client.connect();
   * console.log('Connected to MQTT broker');
   */
  async connect() {
    if (this.isConnected) {
      return;
    }

    try {
      // Intentar conexión a broker externo
      await this.connectToExternalBroker();

      if (this.logger) {
        this.logger.info('mqtt.connected', {
          broker: 'external',
          url: this.brokerUrl
        });
      }

    } catch (externalError) {
      // Fallback a broker embebido
      if (this.logger) {
        this.logger.warn('mqtt.external.failed', {
          error: externalError.message,
          fallback: 'embedded'
        });
      }

      await this.startEmbeddedBrokerAndConnect();

      if (this.logger) {
        this.logger.info('mqtt.connected', {
          broker: 'embedded',
          port: this.brokerPort
        });
      }
    }

    this.isConnected = true;

    // Initialize connection pool if enabled
    if (this.usePool) {
      await this._initializePool();
    }

    this.emit('connected', { usingEmbedded: this.usingEmbedded });
  }

  /**
   * Initialize connection pool for publish operations
   *
   * @returns {Promise<void>}
   * @private
   */
  async _initializePool() {
    if (this.pool) {
      return; // Already initialized
    }

    const poolOptions = {
      brokerUrl: this.brokerUrl,
      mqttOptions: {
        clientId: `${this.coreId}-pool`,
        clean: true,
        reconnectPeriod: 5000
      },
      logger: this.logger,
      metrics: this.metrics,
      ...this.poolConfig
    };

    this.pool = new ConnectionPool(poolOptions);

    try {
      await this.pool.initialize();

      if (this.logger) {
        this.logger.info('mqtt.pool.initialized', {
          min: this.pool.minConnections,
          max: this.pool.maxConnections
        });
      }

      if (this.metrics) {
        this.metrics.increment('mqtt.pool.enabled');
      }

    } catch (error) {
      if (this.logger) {
        this.logger.error('mqtt.pool.init.failed', {
          error: error.message
        }, error);
      }

      // Continue without pool
      this.pool = null;
      this.usePool = false;
    }
  }

  /**
   * Intenta conectarse a un broker MQTT externo
   *
   * @returns {Promise<void>}
   */
  async connectToExternalBroker() {
    // Lazy load mqtt library
    const mqtt = require('mqtt');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('External broker connection timeout'));
      }, this.connectTimeout);

      try {
        this.mqtt = mqtt.connect(this.brokerUrl, {
          clientId: this.coreId,
          clean: true,
          connectTimeout: this.connectTimeout,
          keepalive: 30, // 30s keepalive para evitar timeouts en conexiones inestables
          reconnectPeriod: 0 // Disable auto-reconnect for initial attempt
        });

        this.mqtt.on('connect', () => {
          clearTimeout(timeout);
          this.setupMQTTHandlers();
          this.usingEmbedded = false;
          resolve();
        });

        this.mqtt.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });

      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * Arranca el broker embebido y conecta a él
   *
   * @returns {Promise<void>}
   */
  async startEmbeddedBrokerAndConnect() {
    // Crear broker embebido
    this.embeddedBroker = new EmbeddedBroker({
      port: this.brokerPort,
      logger: this.logger,
      metrics: this.metrics
    });

    // Arrancar broker
    await this.embeddedBroker.start();

    // Esperar un momento para que el broker esté listo
    await new Promise(resolve => setTimeout(resolve, 100));

    // Conectar al broker embebido
    const mqtt = require('mqtt');
    this.mqtt = mqtt.connect(`mqtt://localhost:${this.brokerPort}`, {
      clientId: this.coreId,
      clean: true,
      keepalive: 30 // 30s keepalive para evitar timeouts
    });

    await new Promise((resolve, reject) => {
      this.mqtt.on('connect', () => {
        this.setupMQTTHandlers();
        this.usingEmbedded = true;
        resolve();
      });

      this.mqtt.on('error', reject);
    });
  }

  /**
   * Configura los handlers de eventos del cliente MQTT
   */
  setupMQTTHandlers() {
    // Mensaje recibido
    this.mqtt.on('message', (topic, message) => {
      if (this.metrics) {
        this.metrics.increment('mqtt.messages.received');
        this.metrics.observe('mqtt.message_size', message.length);
      }

      // Emitir evento con mensaje parseado si es JSON
      let parsed = message;
      try {
        parsed = JSON.parse(message.toString());
      } catch {
        // No es JSON, usar como string
        parsed = message.toString();
      }

      this.emit('message', topic, parsed, message);
    });

    // Error
    this.mqtt.on('error', (error) => {
      if (this.logger) {
        this.logger.error('mqtt.error', {
          error: error.message
        }, error);
      }

      if (this.metrics) {
        this.metrics.increment('mqtt.errors');
      }

      this.emit('error', error);
    });

    // Reconexión
    this.mqtt.on('reconnect', () => {
      if (this.logger) {
        this.logger.warn('mqtt.reconnecting');
      }

      this.emit('reconnecting');
    });

    // Desconexión
    this.mqtt.on('close', () => {
      this.isConnected = false;

      if (this.logger) {
        this.logger.warn('mqtt.disconnected');
      }

      this.emit('disconnected');
    });
  }

  /**
   * Publica un mensaje a un topic
   *
   * @param {string} topic - Topic
   * @param {*} message - Mensaje (se serializa a JSON automáticamente)
   * @param {Object} options - Opciones MQTT
   * @param {number} options.qos - QoS level (0, 1, 2)
   * @param {boolean} options.retain - Retain flag
   * @returns {Promise<void>}
   *
   * @example
   * await client.publish('core/core-a/events/test', { data: 'hello' });
   * await client.publish('core/core-a/status', { status: 'alive' }, { retain: true });
   */
  async publish(topic, message, options = {}) {
    if (!this.isConnected) {
      throw new Error('MQTT client not connected');
    }

    // Use connection pool if enabled
    if (this.usePool && this.pool) {
      return this._publishPooled(topic, message, options);
    }

    // Use primary connection
    return this._publishDirect(topic, message, options);
  }

  /**
   * Publish using the connection pool
   *
   * @param {string} topic - Topic
   * @param {*} message - Message
   * @param {Object} options - MQTT options
   * @returns {Promise<void>}
   * @private
   */
  async _publishPooled(topic, message, options = {}) {
    const payload = typeof message === 'string'
      ? message
      : JSON.stringify(message);

    let conn;
    try {
      // Acquire connection from pool
      conn = await this.pool.acquire();

      // Publish using pooled connection
      await new Promise((resolve, reject) => {
        conn.publish(topic, payload, {
          qos: options.qos || 0,
          retain: options.retain || false
        }, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      if (this.metrics) {
        this.metrics.increment('mqtt.messages.published');
        this.metrics.increment('mqtt.pool.publishes');
      }

    } catch (error) {
      if (this.logger) {
        this.logger.error('mqtt.publish.pooled.failed', {
          topic,
          error: error.message
        }, error);
      }

      if (this.metrics) {
        this.metrics.increment('mqtt.publish.failed');
      }

      throw error;

    } finally {
      // Always release connection back to pool
      if (conn) {
        this.pool.release(conn);
      }
    }
  }

  /**
   * Publish using the primary connection (non-pooled)
   *
   * @param {string} topic - Topic
   * @param {*} message - Message
   * @param {Object} options - MQTT options
   * @returns {Promise<void>}
   * @private
   */
  async _publishDirect(topic, message, options = {}) {
    const payload = typeof message === 'string'
      ? message
      : JSON.stringify(message);

    return new Promise((resolve, reject) => {
      this.mqtt.publish(topic, payload, {
        qos: options.qos || 0,
        retain: options.retain || false
      }, (err) => {
        if (err) {
          if (this.logger) {
            this.logger.error('mqtt.publish.failed', {
              topic,
              error: err.message
            }, err);
          }

          if (this.metrics) {
            this.metrics.increment('mqtt.publish.failed');
          }

          reject(err);
        } else {
          if (this.metrics) {
            this.metrics.increment('mqtt.messages.published');
          }

          resolve();
        }
      });
    });
  }

  /**
   * Suscribe a un topic o array de topics
   *
   * @param {string|string[]} topics - Topic o array de topics
   * @param {Object} options - Opciones MQTT
   * @param {number} options.qos - QoS level (0, 1, 2)
   * @returns {Promise<void>}
   *
   * @example
   * await client.subscribe('core/+/events/#');
   * await client.subscribe(['core/+/status', 'core/+/heartbeat']);
   */
  async subscribe(topics, options = {}) {
    if (!this.isConnected) {
      throw new Error('MQTT client not connected');
    }

    const topicArray = Array.isArray(topics) ? topics : [topics];
    const qos = options.qos || 0;

    return new Promise((resolve, reject) => {
      this.mqtt.subscribe(topicArray, { qos }, (err, granted) => {
        if (err) {
          if (this.logger) {
            this.logger.error('mqtt.subscribe.failed', {
              topics: topicArray,
              error: err.message
            }, err);
          }

          if (this.metrics) {
            this.metrics.increment('mqtt.subscribe.failed');
          }

          reject(err);
        } else {
          // Guardar suscripciones
          topicArray.forEach(topic => {
            this.subscriptions.set(topic, qos);
          });

          if (this.logger) {
            this.logger.debug('mqtt.subscribed', {
              topics: topicArray,
              qos
            });
          }

          if (this.metrics) {
            this.metrics.increment('mqtt.subscriptions', topicArray.length);
          }

          resolve(granted);
        }
      });
    });
  }

  /**
   * Desuscribe de un topic o array de topics
   *
   * @param {string|string[]} topics - Topic o array de topics
   * @returns {Promise<void>}
   *
   * @example
   * await client.unsubscribe('core/+/events/#');
   */
  async unsubscribe(topics) {
    if (!this.isConnected) {
      throw new Error('MQTT client not connected');
    }

    const topicArray = Array.isArray(topics) ? topics : [topics];

    return new Promise((resolve, reject) => {
      this.mqtt.unsubscribe(topicArray, (err) => {
        if (err) {
          reject(err);
        } else {
          // Remover suscripciones
          topicArray.forEach(topic => {
            this.subscriptions.delete(topic);
          });

          if (this.logger) {
            this.logger.debug('mqtt.unsubscribed', {
              topics: topicArray
            });
          }

          resolve();
        }
      });
    });
  }

  /**
   * Desconecta del broker MQTT y detiene broker embebido si existe
   *
   * @returns {Promise<void>}
   *
   * @example
   * await client.disconnect();
   */
  async disconnect() {
    if (!this.isConnected) {
      return;
    }

    // Shutdown connection pool first
    if (this.pool) {
      try {
        await this.pool.shutdown();
        this.pool = null;

        if (this.logger) {
          this.logger.info('mqtt.pool.shutdown');
        }
      } catch (error) {
        if (this.logger) {
          this.logger.error('mqtt.pool.shutdown.failed', {
            error: error.message
          }, error);
        }
      }
    }

    // Desconectar cliente MQTT
    if (this.mqtt) {
      await new Promise((resolve) => {
        this.mqtt.end(false, {}, () => {
          resolve();
        });
      });
      this.mqtt = null;
    }

    // Detener broker embebido si existe
    if (this.embeddedBroker) {
      await this.embeddedBroker.stop();
      this.embeddedBroker = null;
    }

    this.isConnected = false;
    this.usingEmbedded = false;
    this.subscriptions.clear();

    if (this.logger) {
      this.logger.info('mqtt.disconnected');
    }
  }

  /**
   * Obtiene estadísticas del cliente MQTT
   *
   * @returns {Object} Estadísticas
   */
  getStats() {
    const stats = {
      isConnected: this.isConnected,
      usingEmbedded: this.usingEmbedded,
      subscriptions: Array.from(this.subscriptions.keys()),
      broker: this.embeddedBroker ? this.embeddedBroker.getStats() : null,
      pooling: {
        enabled: this.usePool,
        active: !!this.pool
      }
    };

    // Add pool statistics if available
    if (this.pool) {
      stats.pooling.stats = this.pool.getStats();
    }

    return stats;
  }
}

module.exports = MQTTClient;
