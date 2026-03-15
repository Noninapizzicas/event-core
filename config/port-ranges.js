/**
 * Port Ranges Configuration
 *
 * Define rangos de puertos por tipo de servicio para organización
 * y evitar conflictos.
 *
 * Convención:
 * - Cada tipo de servicio tiene un rango reservado
 * - Los rangos no se solapan
 * - Permiten múltiples instancias del mismo tipo
 *
 * @example
 * const portRanges = require('./config/port-ranges');
 * console.log(portRanges.EVENT_CORE);
 * // { start: 3000, end: 3999, description: 'Event Core HTTP Gateways' }
 */

module.exports = {
  /**
   * Event Core instances
   * Rango amplio para permitir muchos cores simultáneos
   */
  EVENT_CORE: {
    start: 3000,
    end: 3999,
    description: 'Event Core HTTP Gateways'
  },

  /**
   * MQTT Brokers
   * Puerto estándar MQTT: 1883
   */
  MQTT: {
    start: 1883,
    end: 1893,
    description: 'MQTT Brokers (Mosquitto/Aedes)'
  },

  /**
   * MQTT over WebSocket
   * Para clientes web
   */
  MQTT_WS: {
    start: 9001,
    end: 9011,
    description: 'MQTT over WebSocket'
  },

  /**
   * PostgreSQL instances
   * Puerto estándar: 5432
   */
  POSTGRES: {
    start: 5432,
    end: 5442,
    description: 'PostgreSQL database instances'
  },

  /**
   * Redis instances
   * Puerto estándar: 6379
   */
  REDIS: {
    start: 6379,
    end: 6389,
    description: 'Redis cache/store instances'
  },

  /**
   * MongoDB instances
   * Puerto estándar: 27017
   */
  MONGODB: {
    start: 27017,
    end: 27027,
    description: 'MongoDB database instances'
  },

  /**
   * Caddy HTTP/HTTPS server
   * Reverse proxy y load balancer
   */
  CADDY: {
    start: 8080,
    end: 8090,
    description: 'Caddy HTTP/HTTPS reverse proxy'
  },

  /**
   * Nginx instances
   */
  NGINX: {
    start: 8000,
    end: 8010,
    description: 'Nginx web server instances'
  },

  /**
   * Custom microservices
   * Rango amplio para servicios custom
   */
  MICROSERVICES: {
    start: 7000,
    end: 7999,
    description: 'Custom microservices'
  },

  /**
   * Prometheus monitoring
   * Puerto estándar: 9090
   */
  PROMETHEUS: {
    start: 9090,
    end: 9100,
    description: 'Prometheus metrics collector'
  },

  /**
   * Grafana dashboards
   * Puerto estándar: 3000 (pero usamos 3100 para evitar conflicto con Event Core)
   */
  GRAFANA: {
    start: 3100,
    end: 3110,
    description: 'Grafana dashboards'
  },

  /**
   * Development/Testing services
   * Rango para servicios temporales
   */
  DEV: {
    start: 4000,
    end: 4999,
    description: 'Development and testing services'
  }
};
