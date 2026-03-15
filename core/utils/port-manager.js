/**
 * Port Manager - Gestión automática de puertos
 *
 * Detecta puertos disponibles automáticamente para evitar conflictos
 * al arrancar múltiples servicios o cores.
 *
 * Features:
 * - Detección de puertos disponibles
 * - Búsqueda automática de puertos libres
 * - Reserva temporal de puertos
 * - Zero dependencias externas (solo Node.js built-ins)
 *
 * @example
 * const PortManager = require('./core/utils/port-manager');
 * const pm = new PortManager();
 *
 * // Encontrar puerto libre desde 3000
 * const port = await pm.findFreePort(3000);
 * console.log(`Using port: ${port}`);
 *
 * // Verificar si puerto específico está disponible
 * const available = await pm.isPortAvailable(3000);
 * if (available) {
 *   console.log('Port 3000 is free');
 * }
 */

const net = require('net');

class PortManager {
  /**
   * @param {Object} options - Opciones
   * @param {number} options.basePort - Puerto inicial por defecto (default: 3000)
   * @param {number} options.maxAttempts - Máximo número de intentos (default: 100)
   * @param {number} options.timeout - Timeout para verificación en ms (default: 1000)
   */
  constructor(options = {}) {
    this.basePort = options.basePort || 3000;
    this.maxAttempts = options.maxAttempts || 100;
    this.timeout = options.timeout || 1000;

    /**
     * Set de puertos reservados temporalmente
     * Útil para evitar race conditions al asignar múltiples puertos
     */
    this.reservedPorts = new Set();
  }

  /**
   * Verifica si un puerto está disponible
   *
   * Intenta crear un servidor TCP en el puerto. Si tiene éxito,
   * el puerto está libre. Si falla con EADDRINUSE, está ocupado.
   *
   * @param {number} port - Puerto a verificar
   * @returns {Promise<boolean>} true si está disponible
   *
   * @example
   * const available = await pm.isPortAvailable(3000);
   * if (available) {
   *   console.log('Port 3000 is free!');
   * }
   */
  async isPortAvailable(port) {
    // Si está reservado, no está disponible
    if (this.reservedPorts.has(port)) {
      return false;
    }

    return new Promise((resolve) => {
      const server = net.createServer();

      // Timeout de seguridad
      const timeoutId = setTimeout(() => {
        server.close();
        resolve(false);
      }, this.timeout);

      server.once('error', (err) => {
        clearTimeout(timeoutId);
        if (err.code === 'EADDRINUSE') {
          resolve(false); // Puerto ocupado
        } else {
          resolve(false); // Otro error, asumir no disponible
        }
      });

      server.once('listening', () => {
        clearTimeout(timeoutId);
        server.close(() => {
          resolve(true); // Puerto libre
        });
      });

      server.listen(port, '0.0.0.0');
    });
  }

  /**
   * Encuentra un puerto libre desde basePort
   *
   * Busca secuencialmente desde basePort hasta encontrar uno libre
   * o hasta maxAttempts intentos.
   *
   * @param {number} basePort - Puerto inicial (default: this.basePort)
   * @returns {Promise<number>} Puerto libre encontrado
   * @throws {Error} Si no encuentra puerto libre después de maxAttempts
   *
   * @example
   * // Buscar desde puerto 3000
   * const port = await pm.findFreePort(3000);
   * console.log(`Found free port: ${port}`);
   *
   * // Buscar desde puerto por defecto
   * const port2 = await pm.findFreePort();
   */
  async findFreePort(basePort = null) {
    const startPort = basePort || this.basePort;

    for (let i = 0; i < this.maxAttempts; i++) {
      const port = startPort + i;

      const available = await this.isPortAvailable(port);

      if (available) {
        return port;
      }
    }

    throw new Error(
      `No free port found after ${this.maxAttempts} attempts starting from ${startPort}`
    );
  }

  /**
   * Encuentra un puerto libre en un rango específico
   *
   * @param {number} start - Puerto inicial del rango
   * @param {number} end - Puerto final del rango
   * @returns {Promise<number>} Puerto libre encontrado
   * @throws {Error} Si no encuentra puerto libre en el rango
   *
   * @example
   * // Buscar en rango específico para Event Core (3000-3999)
   * const port = await pm.findFreePortInRange(3000, 3999);
   */
  async findFreePortInRange(start, end) {
    if (start >= end) {
      throw new Error('Start port must be less than end port');
    }

    const rangeSize = end - start + 1;
    const maxAttempts = Math.min(rangeSize, this.maxAttempts);

    for (let i = 0; i < maxAttempts; i++) {
      const port = start + i;

      if (port > end) {
        break;
      }

      const available = await this.isPortAvailable(port);

      if (available) {
        return port;
      }
    }

    throw new Error(
      `No free port found in range ${start}-${end} after ${maxAttempts} attempts`
    );
  }

  /**
   * Reserva un puerto temporalmente
   *
   * Útil para evitar race conditions cuando múltiples servicios
   * se están iniciando simultáneamente.
   *
   * @param {number} port - Puerto a reservar
   *
   * @example
   * const port = await pm.findFreePort();
   * pm.reservePort(port);
   * // ... iniciar servicio ...
   * pm.releasePort(port); // cuando ya no se necesita
   */
  reservePort(port) {
    this.reservedPorts.add(port);
  }

  /**
   * Libera un puerto reservado
   *
   * @param {number} port - Puerto a liberar
   *
   * @example
   * pm.releasePort(3000);
   */
  releasePort(port) {
    this.reservedPorts.delete(port);
  }

  /**
   * Obtiene todos los puertos reservados
   *
   * @returns {Array<number>} Array de puertos reservados
   *
   * @example
   * const reserved = pm.getReservedPorts();
   * console.log('Reserved ports:', reserved);
   */
  getReservedPorts() {
    return Array.from(this.reservedPorts);
  }

  /**
   * Limpia todas las reservas
   *
   * @example
   * pm.clearReservations();
   */
  clearReservations() {
    this.reservedPorts.clear();
  }

  /**
   * Verifica múltiples puertos simultáneamente
   *
   * @param {Array<number>} ports - Array de puertos a verificar
   * @returns {Promise<Object>} Mapa de puerto -> disponibilidad
   *
   * @example
   * const results = await pm.checkMultiplePorts([3000, 3001, 3002]);
   * console.log(results); // { 3000: true, 3001: false, 3002: true }
   */
  async checkMultiplePorts(ports) {
    const results = {};

    await Promise.all(
      ports.map(async (port) => {
        results[port] = await this.isPortAvailable(port);
      })
    );

    return results;
  }

  /**
   * Encuentra N puertos libres consecutivos
   *
   * Útil para servicios que necesitan múltiples puertos consecutivos.
   *
   * @param {number} count - Número de puertos consecutivos necesarios
   * @param {number} basePort - Puerto inicial de búsqueda
   * @returns {Promise<Array<number>>} Array de puertos consecutivos
   * @throws {Error} Si no encuentra suficientes puertos consecutivos
   *
   * @example
   * // Necesito 3 puertos consecutivos
   * const ports = await pm.findConsecutivePorts(3, 3000);
   * console.log(ports); // [3005, 3006, 3007]
   */
  async findConsecutivePorts(count, basePort = null) {
    const startPort = basePort || this.basePort;

    for (let i = 0; i < this.maxAttempts; i++) {
      const firstPort = startPort + i;
      const ports = [];
      let allAvailable = true;

      // Verificar si los siguientes 'count' puertos están libres
      for (let j = 0; j < count; j++) {
        const port = firstPort + j;
        const available = await this.isPortAvailable(port);

        if (!available) {
          allAvailable = false;
          break;
        }

        ports.push(port);
      }

      if (allAvailable) {
        return ports;
      }
    }

    throw new Error(
      `Could not find ${count} consecutive free ports after ${this.maxAttempts} attempts`
    );
  }

  /**
   * Obtiene estadísticas del Port Manager
   *
   * @returns {Object} Estadísticas
   *
   * @example
   * const stats = pm.getStats();
   * console.log(stats);
   * // {
   * //   reservedCount: 2,
   * //   reservedPorts: [3000, 3001],
   * //   basePort: 3000,
   * //   maxAttempts: 100
   * // }
   */
  getStats() {
    return {
      reservedCount: this.reservedPorts.size,
      reservedPorts: this.getReservedPorts(),
      basePort: this.basePort,
      maxAttempts: this.maxAttempts,
      timeout: this.timeout
    };
  }
}

module.exports = PortManager;
