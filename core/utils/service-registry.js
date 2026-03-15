/**
 * Service Registry - Registro central de servicios
 *
 * Mantiene registro de todos los servicios activos en el sistema,
 * sus puertos, PIDs, y estado de salud.
 *
 * Features:
 * - Registro/desregistro de servicios
 * - Asignación automática de puertos por tipo
 * - Health checks y heartbeats
 * - Cleanup automático de servicios muertos
 * - Persistencia en archivo .services.json
 *
 * @example
 * const ServiceRegistry = require('./core/utils/service-registry');
 * const registry = new ServiceRegistry();
 *
 * // Registrar servicio
 * registry.register('core-a', 'EVENT_CORE', 3333, {
 *   version: '0.1.0',
 *   modules: ['echo', 'security-p2p']
 * });
 *
 * // Heartbeat periódico
 * setInterval(() => registry.heartbeat('core-a'), 10000);
 *
 * // Listar servicios activos
 * const services = registry.getActiveServices();
 */

const fs = require('fs');
const path = require('path');
const PortManager = require('./port-manager');
const portRanges = require('../../config/port-ranges');

class ServiceRegistry {
  /**
   * @param {Object} options - Opciones
   * @param {string} options.registryFile - Archivo de persistencia (default: .services.json)
   * @param {number} options.heartbeatTimeout - Timeout para considerar servicio muerto en ms (default: 60000)
   * @param {boolean} options.autocleanup - Habilitar cleanup automático (default: true)
   * @param {number} options.cleanupInterval - Intervalo de cleanup en ms (default: 30000)
   */
  constructor(options = {}) {
    this.registryFile = options.registryFile || path.join(process.cwd(), '.services.json');
    this.heartbeatTimeout = options.heartbeatTimeout || 60000; // 60s
    this.autocleanup = options.autocleanup !== false;
    this.cleanupInterval = options.cleanupInterval || 30000; // 30s

    /**
     * Servicios registrados
     * Map: serviceId -> serviceData
     */
    this.services = new Map();

    /**
     * Port Manager para asignación de puertos
     */
    this.portManager = new PortManager();

    // Cargar servicios del archivo si existe
    this.load();

    // Iniciar cleanup automático si está habilitado
    if (this.autocleanup) {
      this.startAutocleanup();
    }
  }

  /**
   * Registra un nuevo servicio
   *
   * @param {string} serviceId - ID único del servicio
   * @param {string} serviceType - Tipo de servicio (EVENT_CORE, MQTT, POSTGRES, etc.)
   * @param {number} port - Puerto asignado al servicio
   * @param {Object} metadata - Metadata adicional del servicio
   *
   * @example
   * registry.register('core-a', 'EVENT_CORE', 3333, {
   *   version: '0.1.0',
   *   modules: ['echo', 'security-p2p']
   * });
   */
  register(serviceId, serviceType, port, metadata = {}) {
    const now = Date.now();

    const serviceData = {
      id: serviceId,
      type: serviceType,
      port: port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      startedAtTimestamp: now,
      lastHeartbeat: new Date().toISOString(),
      lastHeartbeatTimestamp: now,
      status: 'running',
      metadata: metadata
    };

    this.services.set(serviceId, serviceData);

    // Persistir cambios
    this.save();

    return serviceData;
  }

  /**
   * Desregistra un servicio
   *
   * @param {string} serviceId - ID del servicio a desregistrar
   * @returns {boolean} true si se desregistró, false si no existía
   *
   * @example
   * registry.unregister('core-a');
   */
  unregister(serviceId) {
    const existed = this.services.delete(serviceId);

    if (existed) {
      this.save();
    }

    return existed;
  }

  /**
   * Actualiza heartbeat de un servicio
   *
   * @param {string} serviceId - ID del servicio
   * @returns {boolean} true si se actualizó, false si no existe
   *
   * @example
   * // Llamar cada 10s en el servicio
   * setInterval(() => registry.heartbeat('core-a'), 10000);
   */
  heartbeat(serviceId) {
    const service = this.services.get(serviceId);

    if (!service) {
      return false;
    }

    const now = Date.now();
    service.lastHeartbeat = new Date().toISOString();
    service.lastHeartbeatTimestamp = now;
    service.status = 'running';

    this.save();

    return true;
  }

  /**
   * Obtiene un servicio específico
   *
   * @param {string} serviceId - ID del servicio
   * @returns {Object|null} Datos del servicio o null si no existe
   */
  getService(serviceId) {
    return this.services.get(serviceId) || null;
  }

  /**
   * Obtiene todos los servicios activos
   *
   * @returns {Object} Mapa de servicios { serviceId: serviceData }
   *
   * @example
   * const services = registry.getActiveServices();
   * console.log('Active services:', Object.keys(services));
   */
  getActiveServices() {
    const result = {};

    for (const [id, data] of this.services.entries()) {
      result[id] = { ...data };
    }

    return result;
  }

  /**
   * Obtiene servicios por tipo
   *
   * @param {string} serviceType - Tipo de servicio (EVENT_CORE, MQTT, etc.)
   * @returns {Array<Object>} Array de servicios del tipo especificado
   *
   * @example
   * const cores = registry.getServicesByType('EVENT_CORE');
   * console.log(`${cores.length} Event Cores running`);
   */
  getServicesByType(serviceType) {
    const result = [];

    for (const service of this.services.values()) {
      if (service.type === serviceType) {
        result.push({ ...service });
      }
    }

    return result;
  }

  /**
   * Encuentra un puerto libre para un tipo de servicio
   *
   * Usa los port ranges configurados para asignar puertos
   * dentro del rango apropiado según el tipo.
   *
   * @param {string} serviceType - Tipo de servicio
   * @returns {Promise<number>} Puerto libre en el rango del tipo
   * @throws {Error} Si el tipo no existe o no hay puertos libres
   *
   * @example
   * const port = await registry.findFreePort('EVENT_CORE');
   * console.log(`Assigned port ${port} for Event Core`);
   */
  async findFreePort(serviceType) {
    const range = portRanges[serviceType];

    if (!range) {
      throw new Error(`Unknown service type: ${serviceType}. Check config/port-ranges.js`);
    }

    try {
      const port = await this.portManager.findFreePortInRange(range.start, range.end);
      return port;
    } catch (error) {
      throw new Error(
        `No free port available for ${serviceType} in range ${range.start}-${range.end}: ${error.message}`
      );
    }
  }

  /**
   * Limpia servicios muertos
   *
   * Detecta servicios que:
   * 1. No han enviado heartbeat en heartbeatTimeout ms
   * 2. Su PID ya no existe en el sistema
   *
   * @returns {Array<string>} IDs de servicios removidos
   *
   * @example
   * const removed = registry.cleanup();
   * console.log(`Cleaned up ${removed.length} dead services`);
   */
  cleanup() {
    const now = Date.now();
    const removed = [];

    for (const [id, service] of this.services.entries()) {
      const timeSinceHeartbeat = now - service.lastHeartbeatTimestamp;

      // Verificar timeout de heartbeat
      if (timeSinceHeartbeat > this.heartbeatTimeout) {
        // Verificar si el proceso existe
        if (!this.isProcessAlive(service.pid)) {
          this.services.delete(id);
          removed.push(id);
        } else {
          // Proceso vivo pero sin heartbeat -> marcar como unhealthy
          service.status = 'unhealthy';
        }
      }
    }

    if (removed.length > 0) {
      this.save();
    }

    return removed;
  }

  /**
   * Verifica si un proceso está vivo
   *
   * @param {number} pid - Process ID
   * @returns {boolean} true si el proceso existe
   * @private
   */
  isProcessAlive(pid) {
    try {
      // process.kill con señal 0 no mata el proceso, solo verifica si existe
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Inicia cleanup automático periódico
   *
   * @private
   */
  startAutocleanup() {
    this.cleanupTimer = setInterval(() => {
      const removed = this.cleanup();
      if (removed.length > 0) {
        console.log(`[ServiceRegistry] Cleaned up ${removed.length} dead services: ${removed.join(', ')}`);
      }
    }, this.cleanupInterval);

    // Permitir que el proceso termine aunque el timer esté activo
    this.cleanupTimer.unref();
  }

  /**
   * Detiene cleanup automático
   */
  stopAutocleanup() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Guarda el registro en archivo
   *
   * @private
   */
  save() {
    try {
      const data = {
        lastUpdated: new Date().toISOString(),
        services: this.getActiveServices()
      };

      fs.writeFileSync(this.registryFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      console.error('[ServiceRegistry] Failed to save registry:', error.message);
    }
  }

  /**
   * Carga el registro desde archivo
   *
   * @private
   */
  load() {
    try {
      if (fs.existsSync(this.registryFile)) {
        const content = fs.readFileSync(this.registryFile, 'utf8');
        const data = JSON.parse(content);

        if (data.services) {
          for (const [id, serviceData] of Object.entries(data.services)) {
            this.services.set(id, serviceData);
          }

          // Cleanup inmediato al cargar para remover servicios muertos
          this.cleanup();
        }
      }
    } catch (error) {
      console.error('[ServiceRegistry] Failed to load registry:', error.message);
    }
  }

  /**
   * Obtiene estadísticas del registro
   *
   * @returns {Object} Estadísticas
   *
   * @example
   * const stats = registry.getStats();
   * console.log('Total services:', stats.totalServices);
   * console.log('By type:', stats.byType);
   */
  getStats() {
    const byType = {};
    const byStatus = {};

    for (const service of this.services.values()) {
      // Por tipo
      byType[service.type] = (byType[service.type] || 0) + 1;

      // Por status
      byStatus[service.status] = (byStatus[service.status] || 0) + 1;
    }

    return {
      totalServices: this.services.size,
      byType,
      byStatus,
      registryFile: this.registryFile,
      heartbeatTimeout: this.heartbeatTimeout
    };
  }

  /**
   * Limpia todos los servicios y el archivo de registro
   *
   * @example
   * registry.clear();
   */
  clear() {
    this.services.clear();
    this.save();
  }

  /**
   * Destruye el registry y limpia recursos
   */
  destroy() {
    this.stopAutocleanup();
    this.clear();
  }
}

module.exports = ServiceRegistry;
