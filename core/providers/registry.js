/**
 * Provider Registry - Registro de providers y funciones
 *
 * Mantiene un registro de:
 * - Providers cargados (externos y locales)
 * - Funciones disponibles por provider
 * - Estado de disponibilidad (credenciales)
 *
 * @example
 * const registry = new ProviderRegistry({ logger });
 *
 * registry.register('google', {
 *   credential: 'GOOGLE_API_KEY',
 *   available: true,
 *   base_url: 'https://vision.googleapis.com/v1',
 *   functions: {
 *     'vision.extract': { event: 'google.vision.extract.request', ... }
 *   }
 * });
 *
 * const fn = registry.getFunction('google', 'vision.extract');
 */

class ProviderRegistry {
  /**
   * @param {Object} options - Opciones
   * @param {Object} options.logger - Logger instance
   */
  constructor(options = {}) {
    this.logger = options.logger || null;

    /**
     * Registro de providers
     * Map: providerName -> { credential, available, base_url, auth, functions, type }
     */
    this.providers = new Map();

    /**
     * Índice de eventos a funciones
     * Map: eventName -> { provider, functionName, functionDef }
     */
    this.eventIndex = new Map();
  }

  /**
   * Registra un provider
   *
   * @param {string} providerName - Nombre del provider
   * @param {Object} data - Datos del provider
   * @param {string} data.credential - Variable de entorno con credencial
   * @param {boolean} data.available - Si las credenciales están disponibles
   * @param {string} data.base_url - URL base para HTTP
   * @param {Object} data.auth - Configuración de autenticación
   * @param {Object} data.functions - Funciones disponibles
   * @param {string} data.type - 'external' | 'local'
   */
  register(providerName, data) {
    this.providers.set(providerName, {
      credential: data.credential || null,
      available: data.available !== false,
      base_url: data.base_url || null,
      auth: data.auth || null,
      functions: data.functions || {},
      type: data.type || 'external',
      registeredAt: Date.now()
    });

    // Indexar eventos
    for (const [fnName, fnDef] of Object.entries(data.functions || {})) {
      if (fnDef.event) {
        this.eventIndex.set(fnDef.event, {
          provider: providerName,
          functionName: fnName,
          functionDef: fnDef
        });
      }
    }

    if (this.logger) {
      this.logger.info('provider.registered', {
        provider: providerName,
        type: data.type || 'external',
        available: data.available !== false,
        functions: Object.keys(data.functions || {}).length
      });
    }
  }

  /**
   * Desregistra un provider
   *
   * @param {string} providerName - Nombre del provider
   */
  unregister(providerName) {
    const provider = this.providers.get(providerName);
    if (!provider) return;

    // Remover eventos del índice
    for (const fnDef of Object.values(provider.functions || {})) {
      if (fnDef.event) {
        this.eventIndex.delete(fnDef.event);
      }
    }

    this.providers.delete(providerName);

    if (this.logger) {
      this.logger.info('provider.unregistered', {
        provider: providerName
      });
    }
  }

  /**
   * Obtiene un provider por nombre
   *
   * @param {string} providerName - Nombre del provider
   * @returns {Object|null}
   */
  get(providerName) {
    return this.providers.get(providerName) || null;
  }

  /**
   * Obtiene una función de un provider
   *
   * @param {string} providerName - Nombre del provider
   * @param {string} functionName - Nombre de la función
   * @returns {Object|null}
   */
  getFunction(providerName, functionName) {
    const provider = this.providers.get(providerName);
    if (!provider) return null;
    return provider.functions[functionName] || null;
  }

  /**
   * Busca función por evento
   *
   * @param {string} eventName - Nombre del evento request
   * @returns {Object|null} { provider, functionName, functionDef }
   */
  findByEvent(eventName) {
    return this.eventIndex.get(eventName) || null;
  }

  /**
   * Verifica si un provider está disponible
   *
   * @param {string} providerName - Nombre del provider
   * @returns {boolean}
   */
  isAvailable(providerName) {
    const provider = this.providers.get(providerName);
    return provider?.available || false;
  }

  /**
   * Obtiene todos los providers
   *
   * @returns {Array<Object>}
   */
  getAll() {
    return Array.from(this.providers.entries()).map(([name, data]) => ({
      name,
      type: data.type,
      available: data.available,
      functions: Object.keys(data.functions),
      registeredAt: data.registeredAt
    }));
  }

  /**
   * Obtiene providers disponibles
   *
   * @returns {Array<Object>}
   */
  getAvailable() {
    return this.getAll().filter(p => p.available);
  }

  /**
   * Obtiene todos los eventos registrados
   *
   * @returns {Array<string>}
   */
  getAllEvents() {
    return Array.from(this.eventIndex.keys());
  }

  /**
   * Estadísticas del registry
   *
   * @returns {Object}
   */
  getStats() {
    const providers = this.getAll();
    return {
      total_providers: providers.length,
      available_providers: providers.filter(p => p.available).length,
      total_functions: providers.reduce((acc, p) => acc + p.functions.length, 0),
      total_events: this.eventIndex.size,
      by_type: {
        external: providers.filter(p => p.type === 'external').length,
        local: providers.filter(p => p.type === 'local').length
      }
    };
  }
}

module.exports = ProviderRegistry;
