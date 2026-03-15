/**
 * Embedded MQTT Broker using Aedes
 *
 * Provee un broker MQTT embebido que arranca automáticamente si no hay broker externo.
 * Usa Aedes (lightweight MQTT broker) sobre net.createServer.
 *
 * @example
 * const EmbeddedBroker = require('./broker/embedded');
 *
 * const broker = new EmbeddedBroker({ port: 1883, logger });
 * await broker.start();
 * console.log('Broker running on port 1883');
 *
 * // Más tarde...
 * await broker.stop();
 */

const net = require('net');
const http = require('http');
const { EventEmitter } = require('events');

class EmbeddedBroker extends EventEmitter {
  /**
   * @param {Object} options - Opciones de configuración
   * @param {number} options.port - Puerto del broker TCP (default: 1883)
   * @param {number} options.wsPort - Puerto WebSocket (default: 9001)
   * @param {string} options.host - Host del broker (default: '0.0.0.0')
   * @param {Object} options.logger - Logger instance (opcional)
   * @param {Object} options.metrics - Metrics instance (opcional)
   */
  constructor(options = {}) {
    super();

    this.port = options.port || 1883;
    this.wsPort = options.wsPort || 9001;
    this.host = options.host || '0.0.0.0';
    this.logger = options.logger || null;
    this.metrics = options.metrics || null;

    this.aedes = null;
    this.server = null;
    this.wsServer = null;
    this.httpServer = null;
    this.isRunning = false;

    // Estadísticas
    this.stats = {
      clients: 0,
      published: 0,
      subscribed: 0,
      unsubscribed: 0
    };
  }

  /**
   * Inicia el broker MQTT embebido
   *
   * @returns {Promise<void>}
   *
   * @example
   * await broker.start();
   * console.log('Broker started');
   */
  async start() {
    if (this.isRunning) {
      throw new Error('Broker already running');
    }

    try {
      // Lazy load Aedes (solo si se necesita)
      const Aedes = require('aedes');
      this.aedes = new Aedes({
        heartbeatInterval: 30000, // 30s heartbeat para detectar clientes inactivos
        connectTimeout: 60000    // 60s timeout de conexión
      });

      // Configurar event handlers de Aedes
      this.setupAedesHandlers();

      // Crear servidor TCP
      this.server = net.createServer(this.aedes.handle);

      // Iniciar servidor
      await new Promise((resolve, reject) => {
        this.server.listen(this.port, this.host, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });

        this.server.on('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            reject(new Error(`Port ${this.port} already in use`));
          } else {
            reject(err);
          }
        });
      });

      // Crear servidor WebSocket para navegadores
      await this.startWebSocketServer();

      this.isRunning = true;

      if (this.logger) {
        this.logger.info('broker.started', {
          port: this.port,
          wsPort: this.wsPort,
          host: this.host
        });
      }

      this.emit('started', { port: this.port, wsPort: this.wsPort, host: this.host });

    } catch (error) {
      if (this.logger) {
        this.logger.error('broker.start.failed', {
          port: this.port,
          error: error.message
        }, error);
      }
      throw error;
    }
  }

  /**
   * Configura los handlers de eventos de Aedes
   */
  setupAedesHandlers() {
    // Cliente conectado
    this.aedes.on('client', (client) => {
      this.stats.clients++;

      if (this.logger) {
        this.logger.debug('broker.client.connected', {
          client_id: client.id,
          total_clients: this.stats.clients
        });
      }

      if (this.metrics) {
        this.metrics.increment('mqtt.clients.connected');
        this.metrics.increment('mqtt.clients.active');
      }

      this.emit('clientConnected', { clientId: client.id });
    });

    // Cliente desconectado
    this.aedes.on('clientDisconnect', (client) => {
      this.stats.clients--;

      if (this.logger) {
        this.logger.debug('broker.client.disconnected', {
          client_id: client.id,
          total_clients: this.stats.clients
        });
      }

      if (this.metrics) {
        this.metrics.increment('mqtt.clients.disconnected');
        this.metrics.decrement('mqtt.clients.active');
      }

      this.emit('clientDisconnected', { clientId: client.id });
    });

    // Mensaje publicado
    this.aedes.on('publish', (packet, client) => {
      // Ignorar mensajes del sistema ($SYS)
      if (packet.topic.startsWith('$SYS/')) {
        return;
      }

      this.stats.published++;

      if (this.logger) {
        this.logger.debug('broker.message.published', {
          topic: packet.topic,
          client_id: client ? client.id : 'broker',
          qos: packet.qos,
          retain: packet.retain,
          payload_size: packet.payload.length
        });
      }

      if (this.metrics) {
        this.metrics.increment('mqtt.messages.published');
        this.metrics.observe('mqtt.payload_size', packet.payload.length);
      }

      this.emit('publish', {
        topic: packet.topic,
        clientId: client ? client.id : 'broker',
        qos: packet.qos,
        retain: packet.retain,
        payload: packet.payload
      });
    });

    // Suscripción
    this.aedes.on('subscribe', (subscriptions, client) => {
      this.stats.subscribed += subscriptions.length;

      if (this.logger) {
        this.logger.debug('broker.client.subscribed', {
          client_id: client.id,
          topics: subscriptions.map(s => s.topic)
        });
      }

      if (this.metrics) {
        this.metrics.increment('mqtt.subscriptions', subscriptions.length);
      }

      this.emit('subscribe', {
        clientId: client.id,
        topics: subscriptions.map(s => s.topic)
      });
    });

    // Desuscripción
    this.aedes.on('unsubscribe', (unsubscriptions, client) => {
      this.stats.unsubscribed += unsubscriptions.length;

      if (this.logger) {
        this.logger.debug('broker.client.unsubscribed', {
          client_id: client.id,
          topics: unsubscriptions
        });
      }

      if (this.metrics) {
        this.metrics.increment('mqtt.unsubscriptions', unsubscriptions.length);
      }

      this.emit('unsubscribe', {
        clientId: client.id,
        topics: unsubscriptions
      });
    });

    // Error
    this.aedes.on('clientError', (client, err) => {
      if (this.logger) {
        this.logger.error('broker.client.error', {
          client_id: client.id,
          error: err.message
        }, err);
      }

      if (this.metrics) {
        this.metrics.increment('mqtt.errors');
      }

      this.emit('clientError', { clientId: client.id, error: err });
    });
  }

  /**
   * Inicia servidor WebSocket para conexiones desde navegadores
   */
  async startWebSocketServer() {
    try {
      const ws = require('ws');

      this.httpServer = http.createServer();
      this.wsServer = new ws.Server({ server: this.httpServer });

      this.wsServer.on('connection', (socket) => {
        const stream = ws.createWebSocketStream(socket);
        this.aedes.handle(stream);

        // WebSocket-level ping/pong para mantener viva la conexión a través de proxies (Vite, nginx, etc.)
        const pingInterval = setInterval(() => {
          if (socket.readyState === ws.OPEN) {
            socket.ping();
          }
        }, 25000); // Cada 25s — menor que el keepalive MQTT (60s)

        socket.on('close', () => clearInterval(pingInterval));
        socket.on('error', () => clearInterval(pingInterval));
      });

      await new Promise((resolve, reject) => {
        this.httpServer.listen(this.wsPort, this.host, (err) => {
          if (err) reject(err);
          else resolve();
        });

        this.httpServer.on('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            reject(new Error(`WebSocket port ${this.wsPort} already in use`));
          } else {
            reject(err);
          }
        });
      });

      if (this.logger) {
        this.logger.info('broker.websocket.started', {
          port: this.wsPort,
          host: this.host
        });
      }
    } catch (error) {
      if (this.logger) {
        this.logger.warn('broker.websocket.failed', {
          port: this.wsPort,
          error: error.message
        });
      }
      // No fallar si WebSocket no arranca, TCP sigue funcionando
    }
  }

  /**
   * Detiene el broker MQTT
   *
   * @returns {Promise<void>}
   *
   * @example
   * await broker.stop();
   * console.log('Broker stopped');
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    try {
      // Cerrar Aedes
      await new Promise((resolve, reject) => {
        this.aedes.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Cerrar servidor TCP
      await new Promise((resolve, reject) => {
        this.server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Cerrar servidor WebSocket si existe
      if (this.httpServer) {
        await new Promise((resolve) => {
          this.httpServer.close(() => resolve());
        });
      }

      this.isRunning = false;

      if (this.logger) {
        this.logger.info('broker.stopped', {
          port: this.port
        });
      }

      this.emit('stopped');

    } catch (error) {
      if (this.logger) {
        this.logger.error('broker.stop.failed', {
          error: error.message
        }, error);
      }
      throw error;
    }
  }

  /**
   * Obtiene estadísticas del broker
   *
   * @returns {Object} Estadísticas
   *
   * @example
   * const stats = broker.getStats();
   * console.log('Connected clients:', stats.clients);
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      port: this.port,
      host: this.host
    };
  }

  /**
   * Publica un mensaje directamente desde el broker
   *
   * @param {Object} packet - Paquete MQTT
   * @param {string} packet.topic - Topic
   * @param {string|Buffer} packet.payload - Payload
   * @param {number} packet.qos - QoS level (0, 1, 2)
   * @param {boolean} packet.retain - Retain flag
   *
   * @example
   * broker.publish({
   *   topic: 'core/core-a/status',
   *   payload: JSON.stringify({ status: 'alive' }),
   *   qos: 0,
   *   retain: true
   * });
   */
  publish(packet) {
    if (!this.isRunning) {
      throw new Error('Broker not running');
    }

    this.aedes.publish(
      {
        topic: packet.topic,
        payload: typeof packet.payload === 'string'
          ? Buffer.from(packet.payload)
          : packet.payload,
        qos: packet.qos || 0,
        retain: packet.retain || false
      },
      (err) => {
        if (err && this.logger) {
          this.logger.error('broker.publish.failed', {
            topic: packet.topic,
            error: err.message
          }, err);
        }
      }
    );
  }

  /**
   * Obtiene lista de clientes conectados
   *
   * @returns {Array<Object>} Lista de clientes
   *
   * @example
   * const clients = broker.getClients();
   * console.log('Connected:', clients.length);
   */
  getClients() {
    if (!this.isRunning || !this.aedes) {
      return [];
    }

    const clients = [];
    for (const [clientId, client] of this.aedes.clients) {
      clients.push({
        id: clientId,
        connected: client.connected,
        clean: client.clean
      });
    }

    return clients;
  }
}

module.exports = EmbeddedBroker;
