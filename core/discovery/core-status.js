/**
 * Core Status - Gestión de estado de un core
 *
 * Representa el estado de un core individual en el sistema.
 */

class CoreStatus {
  /**
   * @param {Object} data - Datos del core
   * @param {string} data.core_id - ID único del core
   * @param {string} data.version - Versión del core
   * @param {number} data.port - Puerto HTTP del core
   * @param {string} data.host - Host del core
   * @param {number} data.started_at - Timestamp de inicio
   * @param {Array<string>} data.modules - Módulos cargados
   * @param {Object} data.capabilities - Capacidades del core
   */
  constructor(data) {
    this.core_id = data.core_id;
    this.version = data.version;
    this.port = data.port;
    this.host = data.host;
    this.started_at = data.started_at;
    this.modules = data.modules || [];
    this.capabilities = data.capabilities || {};

    // Metadata para discovery
    this.last_seen = Date.now();
    this.heartbeat_count = 0;
    this.is_alive = true;
  }

  /**
   * Actualiza el timestamp de última vez visto
   */
  updateLastSeen() {
    this.last_seen = Date.now();
    this.heartbeat_count++;
    this.is_alive = true;
  }

  /**
   * Verifica si el core está vivo
   * @param {number} timeoutMs - Timeout en ms (default: 60000 = 1 min)
   * @returns {boolean}
   */
  isAlive(timeoutMs = 60000) {
    const elapsed = Date.now() - this.last_seen;
    return elapsed < timeoutMs;
  }

  /**
   * Marca el core como muerto
   */
  markAsDead() {
    this.is_alive = false;
  }

  /**
   * Serializa a JSON para publicar en MQTT
   * @returns {Object}
   */
  toJSON() {
    return {
      core_id: this.core_id,
      version: this.version,
      port: this.port,
      host: this.host,
      started_at: this.started_at,
      modules: this.modules,
      capabilities: this.capabilities,
      timestamp: Date.now()
    };
  }

  /**
   * Crea un CoreStatus desde datos MQTT
   * @param {Object} data - Datos recibidos
   * @returns {CoreStatus}
   */
  static fromMQTT(data) {
    return new CoreStatus(data);
  }
}

module.exports = CoreStatus;
