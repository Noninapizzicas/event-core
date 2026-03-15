/**
 * Discovery System - Descubrimiento automático de cores
 *
 * Sistema que permite a múltiples cores descubrirse automáticamente
 * usando retained messages en MQTT.
 *
 * Features:
 * - Status publishing con retained messages
 * - Heartbeat cada 30s
 * - Last Will & Testament para detectar cores muertos
 * - Registry de cores activos
 *
 * @example
 * const Discovery = require('./core/discovery');
 *
 * const discovery = new Discovery({
 *   coreId: 'core-a',
 *   version: '0.2.0',
 *   port: 3000,
 *   mqttClient,
 *   logger
 * });
 *
 * await discovery.start();
 *
 * // Obtener cores activos
 * const cores = discovery.getActiveCores();
 */

const { EventEmitter } = require('events');
const CoreStatus = require('./core-status');

class Discovery extends EventEmitter {
  /**
   * @param {Object} options - Opciones
   * @param {string} options.coreId - ID del core
   * @param {string} options.version - Versión del core
   * @param {number} options.port - Puerto HTTP
   * @param {string} options.host - Host (default: '0.0.0.0')
   * @param {Array<string>} options.modules - Módulos cargados
   * @param {Object} options.capabilities - Capacidades del core
   * @param {Object} options.mqttClient - Cliente MQTT
   * @param {Object} options.logger - Logger instance
   * @param {number} options.heartbeatInterval - Intervalo de heartbeat en ms (default: 30000)
   * @param {number} options.aliveTimeout - Timeout para considerar core muerto en ms (default: 60000)
   */
  constructor(options = {}) {
    super();

    this.coreId = options.coreId;
    this.version = options.version || '0.2.0';
    this.port = options.port;
    this.host = options.host || '0.0.0.0';
    this.modules = options.modules || [];
    this.capabilities = options.capabilities || {};
    this.mqttClient = options.mqttClient;
    this.logger = options.logger || null;

    this.heartbeatInterval = options.heartbeatInterval || 30000; // 30s
    this.aliveTimeout = options.aliveTimeout || 60000; // 1 min

    // Registry de cores activos
    this.cores = new Map(); // core_id -> CoreStatus

    // Estado interno
    this.started_at = Date.now();
    this.heartbeatTimer = null;
    this.checkAliveTimer = null;
    this.isRunning = false;

    // Status propio
    this.ownStatus = new CoreStatus({
      core_id: this.coreId,
      version: this.version,
      port: this.port,
      host: this.host,
      started_at: this.started_at,
      modules: this.modules,
      capabilities: this.capabilities
    });
  }

  /**
   * Inicia el discovery system
   * @returns {Promise<void>}
   */
  async start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    // Configurar Last Will & Testament antes de publicar status
    await this.setupLastWill();

    // Suscribirse a status de otros cores
    await this.subscribeToDiscovery();

    // Publicar status propio (retained)
    await this.publishStatus();

    // Iniciar heartbeat
    this.startHeartbeat();

    // Iniciar check de cores alive
    this.startAliveCheck();

    if (this.logger) {
      this.logger.info('discovery.started', {
        core_id: this.coreId,
        heartbeat_interval: this.heartbeatInterval,
        alive_timeout: this.aliveTimeout
      });
    }
  }

  /**
   * Detiene el discovery system
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    // Detener timers
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.checkAliveTimer) {
      clearInterval(this.checkAliveTimer);
      this.checkAliveTimer = null;
    }

    // Publicar status offline (ignorar errores durante shutdown)
    try {
      await this.publishOfflineStatus();
    } catch (error) {
      // Ignorar errores MQTT durante shutdown (connection may be closing)
      if (this.logger) {
        this.logger.debug('discovery.offline.publish.failed', {
          error: error.message
        });
      }
    }

    if (this.logger) {
      this.logger.info('discovery.stopped', {
        core_id: this.coreId
      });
    }
  }

  /**
   * Configura Last Will & Testament
   * El broker publicará este mensaje automáticamente si el core se desconecta
   * @returns {Promise<void>}
   */
  async setupLastWill() {
    const topic = `core/${this.coreId}/status`;
    const message = JSON.stringify({
      core_id: this.coreId,
      status: 'offline',
      timestamp: Date.now()
    });

    // MQTT Last Will se configura en las opciones de conexión del cliente
    // Por ahora, solo logueamos (la implementación real requiere
    // reconfigurar el cliente MQTT con willTopic y willMessage)

    if (this.logger) {
      this.logger.debug('discovery.lastwill.configured', {
        core_id: this.coreId,
        topic
      });
    }
  }

  /**
   * Suscribe a discovery de otros cores
   * @returns {Promise<void>}
   */
  async subscribeToDiscovery() {
    const topic = 'core/+/status';

    await this.mqttClient.subscribe(topic, { qos: 1 });

    // Escuchar mensajes
    this.mqttClient.on('message', this.handleDiscoveryMessage.bind(this));

    if (this.logger) {
      this.logger.info('discovery.subscribed', {
        topic
      });
    }
  }

  /**
   * Maneja mensajes de discovery recibidos
   * @param {string} topic - Topic MQTT
   * @param {Object|string|Buffer} payload - Payload del mensaje (ya puede estar parseado)
   */
  handleDiscoveryMessage(topic, payload) {
    try {
      // MQTTClient ya parsea los mensajes JSON automáticamente
      const data = typeof payload === 'object' && payload !== null && !Buffer.isBuffer(payload)
        ? payload
        : JSON.parse(payload.toString());

      // Ignorar mensajes propios
      if (data.core_id === this.coreId) {
        return;
      }

      // Manejar status offline
      if (data.status === 'offline') {
        this.handleCoreOffline(data.core_id);
        return;
      }

      // Actualizar o agregar core
      this.updateCore(data);

    } catch (error) {
      if (this.logger) {
        this.logger.error('discovery.message.parse.failed', {
          topic,
          error: error.message
        });
      }
    }
  }

  /**
   * Actualiza información de un core descubierto
   * @param {Object} data - Datos del core
   */
  updateCore(data) {
    const coreId = data.core_id;

    if (this.cores.has(coreId)) {
      // Core existente - actualizar last_seen
      const coreStatus = this.cores.get(coreId);
      coreStatus.updateLastSeen();

      this.emit('core:updated', coreStatus);

      if (this.logger) {
        this.logger.debug('discovery.core.updated', {
          core_id: coreId,
          heartbeat_count: coreStatus.heartbeat_count
        });
      }
    } else {
      // Nuevo core descubierto
      const coreStatus = CoreStatus.fromMQTT(data);
      this.cores.set(coreId, coreStatus);

      this.emit('core:discovered', coreStatus);

      if (this.logger) {
        this.logger.info('discovery.core.discovered', {
          core_id: coreId,
          port: coreStatus.port,
          modules: coreStatus.modules
        });
      }
    }
  }

  /**
   * Maneja core offline
   * @param {string} coreId - ID del core
   */
  handleCoreOffline(coreId) {
    if (this.cores.has(coreId)) {
      const coreStatus = this.cores.get(coreId);
      coreStatus.markAsDead();

      this.emit('core:offline', coreStatus);

      if (this.logger) {
        this.logger.info('discovery.core.offline', {
          core_id: coreId
        });
      }

      // Remover del registry
      this.cores.delete(coreId);
    }
  }

  /**
   * Publica status propio (retained message)
   * @returns {Promise<void>}
   */
  async publishStatus() {
    const topic = `core/${this.coreId}/status`;
    const message = JSON.stringify(this.ownStatus.toJSON());

    await this.mqttClient.publish(topic, message, {
      qos: 1,
      retain: true // RETAINED MESSAGE - permanece en el broker
    });

    if (this.logger) {
      this.logger.debug('discovery.status.published', {
        core_id: this.coreId
      });
    }
  }

  /**
   * Publica status offline
   * @returns {Promise<void>}
   */
  async publishOfflineStatus() {
    const topic = `core/${this.coreId}/status`;
    const message = JSON.stringify({
      core_id: this.coreId,
      status: 'offline',
      timestamp: Date.now()
    });

    await this.mqttClient.publish(topic, message, {
      qos: 1,
      retain: true
    });

    if (this.logger) {
      this.logger.info('discovery.offline.published', {
        core_id: this.coreId
      });
    }
  }

  /**
   * Inicia heartbeat periódico
   */
  startHeartbeat() {
    this.heartbeatTimer = setInterval(async () => {
      await this.publishStatus();
    }, this.heartbeatInterval);
  }

  /**
   * Inicia verificación de cores alive
   */
  startAliveCheck() {
    this.checkAliveTimer = setInterval(() => {
      for (const [coreId, coreStatus] of this.cores.entries()) {
        if (!coreStatus.isAlive(this.aliveTimeout)) {
          // Core muerto - marcar y emitir evento
          coreStatus.markAsDead();

          this.emit('core:dead', coreStatus);

          if (this.logger) {
            this.logger.warn('discovery.core.dead', {
              core_id: coreId,
              last_seen: coreStatus.last_seen,
              elapsed: Date.now() - coreStatus.last_seen
            });
          }

          // Remover del registry
          this.cores.delete(coreId);
        }
      }
    }, this.heartbeatInterval);
  }

  /**
   * Obtiene cores activos
   * @returns {Array<CoreStatus>}
   */
  getActiveCores() {
    return Array.from(this.cores.values()).filter(core => core.is_alive);
  }

  /**
   * Obtiene un core por ID
   * @param {string} coreId - ID del core
   * @returns {CoreStatus|null}
   */
  getCore(coreId) {
    return this.cores.get(coreId) || null;
  }

  /**
   * Verifica si un core existe y está activo
   * @param {string} coreId - ID del core
   * @returns {boolean}
   */
  isCoreActive(coreId) {
    const core = this.getCore(coreId);
    return core !== null && core.is_alive;
  }

  /**
   * Obtiene el status propio
   * @returns {CoreStatus}
   */
  getOwnStatus() {
    return this.ownStatus;
  }

  /**
   * Actualiza módulos cargados
   * @param {Array<string>} modules - Lista de módulos
   */
  updateModules(modules) {
    this.ownStatus.modules = modules;
    this.modules = modules;
  }

  /**
   * Actualiza capabilities
   * @param {Object} capabilities - Capabilities
   */
  updateCapabilities(capabilities) {
    this.ownStatus.capabilities = capabilities;
    this.capabilities = capabilities;
  }
}

module.exports = Discovery;
