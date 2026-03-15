/**
 * Service Definitions
 *
 * Define all services that can be managed by the orchestrator.
 *
 * Each service definition includes:
 * - type: Service type (EVENT_CORE, MQTT, POSTGRES, etc.)
 * - command: Executable command
 * - args: Command arguments (use {PORT} placeholder for auto-assigned port)
 * - env: Environment variables (use {PORT} placeholder)
 * - dependsOn: Array of service IDs this service depends on
 * - healthCheck: Optional async function to verify service health
 * - startDelay: Optional delay in ms after dependencies start (default: 2000)
 * - autoRestart: Enable/disable auto-restart on failure (default: true)
 *
 * @example
 * const ServiceManager = require('../core/orchestrator').ServiceManager;
 * const serviceDefinitions = require('./config/services');
 * const manager = new ServiceManager();
 *
 * for (const [id, definition] of Object.entries(serviceDefinitions)) {
 *   manager.define(id, definition);
 * }
 *
 * await manager.startAll();
 */

const path = require('path');

/**
 * Health check helper for HTTP services
 */
async function httpHealthCheck(port, endpoint = '/health') {
  try {
    const http = require('http');
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${port}${endpoint}`, { timeout: 2000 }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  } catch (error) {
    return false;
  }
}

/**
 * Health check helper for TCP services (like MQTT)
 */
async function tcpHealthCheck(port) {
  try {
    const net = require('net');
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(2000);

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });

      socket.on('error', () => {
        resolve(false);
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.connect(port, 'localhost');
    });
  } catch (error) {
    return false;
  }
}

/**
 * Service Definitions
 */
module.exports = {
  /**
   * MQTT Broker (Aedes)
   *
   * Lightweight MQTT broker for inter-core communication.
   * No dependencies - this is typically the first service to start.
   */
  'mqtt-broker': {
    type: 'MQTT',
    command: 'node',
    args: [
      path.join(__dirname, '..', 'mqtt-broker', 'broker.js'),
      '--port', '{PORT}'
    ],
    env: {
      MQTT_PORT: '{PORT}',
      MQTT_WS_PORT: '', // WebSocket disabled by default
      LOG_LEVEL: 'info'
    },
    dependsOn: [],
    healthCheck: async (port) => {
      return await tcpHealthCheck(port);
    },
    startDelay: 3000, // Extra time for MQTT to fully initialize
    autoRestart: true
  },

  /**
   * Event Core A
   *
   * Primary Event Core instance.
   * Depends on MQTT broker for pub/sub communication.
   */
  'core-a': {
    type: 'EVENT_CORE',
    command: 'node',
    args: [path.join(__dirname, '..', 'index.js')],
    env: {
      CORE_ID: 'core-a',
      HTTP_PORT: '{PORT}',
      MQTT_URL: 'mqtt://localhost:1883', // Connect to mqtt-broker
      LOG_LEVEL: 'info',
      MODULES: 'echo,security-p2p' // Load these modules
    },
    dependsOn: ['mqtt-broker'],
    healthCheck: async (port) => {
      return await httpHealthCheck(port, '/health');
    },
    startDelay: 2000,
    autoRestart: true
  },

  /**
   * Event Core B
   *
   * Secondary Event Core instance for multi-core scenarios.
   * Depends on MQTT broker.
   */
  'core-b': {
    type: 'EVENT_CORE',
    command: 'node',
    args: [path.join(__dirname, '..', 'index.js')],
    env: {
      CORE_ID: 'core-b',
      HTTP_PORT: '{PORT}',
      MQTT_URL: 'mqtt://localhost:1883',
      LOG_LEVEL: 'info',
      MODULES: 'echo,security-p2p'
    },
    dependsOn: ['mqtt-broker'],
    healthCheck: async (port) => {
      return await httpHealthCheck(port, '/health');
    },
    startDelay: 2000,
    autoRestart: true
  },

  /**
   * Event Core C
   *
   * Tertiary Event Core instance for multi-core scenarios.
   * Depends on MQTT broker.
   */
  'core-c': {
    type: 'EVENT_CORE',
    command: 'node',
    args: [path.join(__dirname, '..', 'index.js')],
    env: {
      CORE_ID: 'core-c',
      HTTP_PORT: '{PORT}',
      MQTT_URL: 'mqtt://localhost:1883',
      LOG_LEVEL: 'info',
      MODULES: 'echo,security-p2p'
    },
    dependsOn: ['mqtt-broker'],
    healthCheck: async (port) => {
      return await httpHealthCheck(port, '/health');
    },
    startDelay: 2000,
    autoRestart: true
  }

  /**
   * FUTURE SERVICES:
   *
   * Uncomment and configure as needed:
   *
   * 'postgres': {
   *   type: 'POSTGRES',
   *   command: 'postgres',
   *   args: ['-p', '{PORT}', '-D', '/path/to/data'],
   *   dependsOn: [],
   *   healthCheck: async (port) => { ... },
   *   autoRestart: true
   * },
   *
   * 'redis': {
   *   type: 'REDIS',
   *   command: 'redis-server',
   *   args: ['--port', '{PORT}'],
   *   dependsOn: [],
   *   healthCheck: async (port) => { ... },
   *   autoRestart: true
   * },
   *
   * 'caddy': {
   *   type: 'CADDY',
   *   command: 'caddy',
   *   args: ['run', '--config', 'Caddyfile', '--adapter', 'caddyfile'],
   *   env: { HTTP_PORT: '{PORT}' },
   *   dependsOn: ['core-a', 'core-b', 'core-c'],
   *   healthCheck: async (port) => { ... },
   *   autoRestart: true
   * }
   */
};
