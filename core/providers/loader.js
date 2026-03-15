/**
 * Provider Loader - Autodescubrimiento y carga de providers
 *
 * Escanea services/providers/ y carga:
 * - Providers externos: {provider}/provider.json + functions/*.json
 * - Providers locales: local/{service}/index.js
 *
 * @example
 * const ProviderLoader = require('./providers/loader');
 *
 * const loader = new ProviderLoader({
 *   providersPath: './services/providers',
 *   registry,
 *   executor,
 *   eventBus,
 *   logger
 * });
 *
 * await loader.loadAll();
 * console.log('Loaded providers:', loader.getLoadedProviders());
 */

const fs = require('fs');
const path = require('path');

class ProviderLoader {
  /**
   * @param {Object} options - Opciones
   * @param {string} options.providersPath - Path al directorio de providers
   * @param {Object} options.registry - ProviderRegistry instance
   * @param {Object} options.executor - ProviderExecutor instance
   * @param {Object} options.eventBus - EventBus instance
   * @param {Object} options.logger - Logger instance
   */
  constructor(options = {}) {
    this.providersPath = options.providersPath || './services/providers';
    this.registry = options.registry;
    this.executor = options.executor;
    this.eventBus = options.eventBus;
    this.logger = options.logger || null;

    /**
     * Providers cargados
     * Map: providerName -> { type, path, loadedAt }
     */
    this.loadedProviders = new Map();

    /**
     * Suscripciones activas
     * Map: eventName -> unsubscribe function
     */
    this.subscriptions = new Map();
  }

  /**
   * Descubre todos los providers en el directorio
   *
   * @returns {Array<Object>} Array de { name, type, path }
   */
  discover() {
    const providers = [];

    try {
      if (!fs.existsSync(this.providersPath)) {
        if (this.logger) {
          this.logger.warn('providers.path.not.found', {
            path: this.providersPath
          });
        }
        return providers;
      }

      const entries = fs.readdirSync(this.providersPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const providerName = entry.name;
        const providerPath = path.join(this.providersPath, providerName);

        if (providerName === 'local') {
          // Escanear servicios locales
          const localServices = this.discoverLocalServices(providerPath);
          providers.push(...localServices);
        } else {
          // Provider externo
          const manifestPath = path.join(providerPath, 'provider.json');
          if (fs.existsSync(manifestPath)) {
            providers.push({
              name: providerName,
              type: 'external',
              path: providerPath
            });
          }
        }
      }

      if (this.logger) {
        this.logger.info('providers.discovered', {
          count: providers.length,
          external: providers.filter(p => p.type === 'external').length,
          local: providers.filter(p => p.type === 'local').length
        });
      }

    } catch (error) {
      if (this.logger) {
        this.logger.error('providers.discover.failed', {
          error: error.message
        }, error);
      }
    }

    return providers;
  }

  /**
   * Descubre servicios locales en local/
   *
   * @param {string} localPath - Path a local/
   * @returns {Array<Object>}
   */
  discoverLocalServices(localPath) {
    const services = [];

    try {
      const entries = fs.readdirSync(localPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const serviceName = entry.name;
        const servicePath = path.join(localPath, serviceName);
        const indexPath = path.join(servicePath, 'index.js');

        if (fs.existsSync(indexPath)) {
          services.push({
            name: `local.${serviceName}`,
            type: 'local',
            path: servicePath
          });
        }
      }
    } catch (error) {
      if (this.logger) {
        this.logger.error('providers.local.discover.failed', {
          error: error.message
        }, error);
      }
    }

    return services;
  }

  /**
   * Carga un provider externo
   *
   * @param {string} providerName - Nombre del provider
   * @param {string} providerPath - Path al provider
   * @returns {Promise<Object>}
   */
  async loadExternal(providerName, providerPath) {
    const manifestPath = path.join(providerPath, 'provider.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    // Verificar credenciales
    const credential = manifest.credential;
    const available = !credential || !!process.env[credential];

    // Cargar funciones
    const functionsPath = path.join(providerPath, 'functions');
    const functions = {};

    if (fs.existsSync(functionsPath)) {
      const fnFiles = fs.readdirSync(functionsPath).filter(f => f.endsWith('.json'));

      for (const fnFile of fnFiles) {
        const fnPath = path.join(functionsPath, fnFile);
        const fnDef = JSON.parse(fs.readFileSync(fnPath, 'utf8'));
        const fnName = fnDef.name || fnFile.replace('.json', '');
        functions[fnName] = fnDef;
      }
    }

    // Registrar en registry
    this.registry.register(providerName, {
      credential,
      available,
      base_url: manifest.base_url,
      auth: manifest.auth,
      functions,
      type: 'external'
    });

    // Guardar referencia
    this.loadedProviders.set(providerName, {
      type: 'external',
      path: providerPath,
      loadedAt: Date.now()
    });

    if (this.logger) {
      this.logger.info('provider.loaded', {
        provider: providerName,
        type: 'external',
        available,
        functions: Object.keys(functions).length
      });
    }

    return { providerName, functions: Object.keys(functions), available };
  }

  /**
   * Carga un servicio local
   *
   * @param {string} serviceName - Nombre del servicio (ej: local.pdf)
   * @param {string} servicePath - Path al servicio
   * @returns {Promise<Object>}
   */
  async loadLocal(serviceName, servicePath) {
    const indexPath = path.join(servicePath, 'index.js');

    // Clear cache para hot-reload
    delete require.cache[require.resolve(path.resolve(indexPath))];

    const handler = require(path.resolve(indexPath));

    // Construir funciones desde el handler
    const functions = {};
    for (const [fnName, fnDef] of Object.entries(handler.functions || {})) {
      functions[fnName] = {
        ...fnDef,
        event: fnDef.event || `${serviceName}.${fnName}.request`
      };
    }

    // Registrar en registry
    this.registry.register(serviceName, {
      credential: null,
      available: true,
      base_url: null,
      auth: null,
      functions,
      type: 'local'
    });

    // Registrar handler en executor
    this.executor.registerLocalHandler(serviceName, handler);

    // Guardar referencia
    this.loadedProviders.set(serviceName, {
      type: 'local',
      path: servicePath,
      loadedAt: Date.now()
    });

    if (this.logger) {
      this.logger.info('provider.loaded', {
        provider: serviceName,
        type: 'local',
        functions: Object.keys(functions).length
      });
    }

    return { providerName: serviceName, functions: Object.keys(functions), available: true };
  }

  /**
   * Registra event handlers para todos los providers
   *
   * @returns {Promise<void>}
   */
  async registerEventHandlers() {
    if (!this.eventBus) {
      if (this.logger) {
        this.logger.warn('providers.eventbus.missing');
      }
      return;
    }

    const events = this.registry.getAllEvents();

    for (const eventName of events) {
      // Solo suscribirse a eventos .request
      if (!eventName.endsWith('.request')) continue;

      const responseEvent = eventName.replace('.request', '.response');

      const unsubscribe = this.eventBus.subscribe(eventName, async (event) => {
        const requestId = event.data?.request_id || event.request_id || this.generateRequestId();
        let input = { ...(event.data || event) };
        const correlationId = input._correlationId;

        // Buscar función por evento
        const fnInfo = this.registry.findByEvent(eventName);
        if (!fnInfo) {
          await this.eventBus.publish(responseEvent, {
            request_id: requestId,
            _correlationId: correlationId,
            success: false,
            error: `Handler not found for event: ${eventName}`
          });
          return;
        }

        // Resolver credenciales OAuth para providers que lo requieren
        if (this.isOAuthProvider(fnInfo.provider)) {
          try {
            const credentials = await this.resolveOAuthCredentials(fnInfo.provider, input.account);
            input._credentials = credentials;
          } catch (credError) {
            await this.eventBus.publish(responseEvent, {
              request_id: requestId,
              _correlationId: correlationId,
              success: false,
              error: `Credential resolution failed: ${credError.message}`
            });
            return;
          }
        }

        // Ejecutar
        const result = await this.executor.execute(
          fnInfo.provider,
          fnInfo.functionName,
          input
        );

        // Publicar respuesta
        await this.eventBus.publish(responseEvent, {
          request_id: requestId,
          _correlationId: correlationId,
          ...result
        });
      });

      this.subscriptions.set(eventName, unsubscribe);

      if (this.logger) {
        this.logger.debug('provider.event.subscribed', {
          event: eventName,
          response: responseEvent
        });
      }
    }

    if (this.logger) {
      this.logger.info('providers.events.registered', {
        count: this.subscriptions.size
      });
    }
  }

  /**
   * Carga todos los providers descubiertos
   *
   * @returns {Promise<Array>}
   */
  async loadAll() {
    const discovered = this.discover();
    const results = [];

    for (const { name, type, path: providerPath } of discovered) {
      try {
        if (type === 'local') {
          const result = await this.loadLocal(name, providerPath);
          results.push({ ...result, success: true });
        } else {
          const result = await this.loadExternal(name, providerPath);
          results.push({ ...result, success: true });
        }
      } catch (error) {
        if (this.logger) {
          this.logger.error('provider.load.failed', {
            provider: name,
            error: error.message
          }, error);
        }
        results.push({ providerName: name, success: false, error: error.message });
      }
    }

    // Registrar event handlers
    await this.registerEventHandlers();

    // Publicar evento de providers cargados
    if (this.eventBus) {
      await this.eventBus.publish('providers.loaded', {
        providers: results.filter(r => r.success).map(r => r.providerName),
        stats: this.registry.getStats()
      });
    }

    return results;
  }

  /**
   * Descarga un provider
   *
   * @param {string} providerName - Nombre del provider
   */
  async unload(providerName) {
    // Remover suscripciones
    const provider = this.registry.get(providerName);
    if (provider) {
      for (const fnDef of Object.values(provider.functions)) {
        if (fnDef.event && this.subscriptions.has(fnDef.event)) {
          this.subscriptions.get(fnDef.event)(); // Llamar unsubscribe
          this.subscriptions.delete(fnDef.event);
        }
      }
    }

    // Desregistrar
    this.registry.unregister(providerName);
    this.loadedProviders.delete(providerName);

    if (this.logger) {
      this.logger.info('provider.unloaded', {
        provider: providerName
      });
    }
  }

  /**
   * Descarga todos los providers
   */
  async unloadAll() {
    for (const providerName of this.loadedProviders.keys()) {
      await this.unload(providerName);
    }
  }

  /**
   * Genera un request ID único
   *
   * @returns {string}
   */
  generateRequestId() {
    return 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Obtiene los providers cargados
   *
   * @returns {Array<Object>}
   */
  getLoadedProviders() {
    return Array.from(this.loadedProviders.entries()).map(([name, data]) => ({
      name,
      ...data
    }));
  }

  /**
   * Verifica si un provider requiere credenciales OAuth
   *
   * @param {string} providerName - Nombre del provider
   * @returns {boolean}
   */
  isOAuthProvider(providerName) {
    // Lista de providers que requieren OAuth2
    const oauthProviders = ['local.gmail'];
    return oauthProviders.includes(providerName);
  }

  /**
   * Resuelve credenciales OAuth via credential-manager
   *
   * @param {string} providerName - Nombre del provider
   * @param {string} account - Identificador de cuenta
   * @returns {Promise<Object>} { clientId, clientSecret, refreshToken }
   */
  async resolveOAuthCredentials(providerName, account) {
    return new Promise((resolve, reject) => {
      const requestId = this.generateRequestId();
      const timeout = 5000;
      let timer;
      let unsubscribe;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (unsubscribe) unsubscribe();
      };

      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`OAuth credential resolution timeout for ${providerName}`));
      }, timeout);

      unsubscribe = this.eventBus.subscribe('credential.oauth.resolve.response', (event) => {
        const data = event.data || event;
        if (data.request_id !== requestId) return;

        cleanup();

        if (data.success && data.credentials) {
          resolve(data.credentials);
        } else {
          reject(new Error(data.error || 'OAuth credential resolution failed'));
        }
      });

      // Extraer provider base (local.gmail -> GMAIL)
      const provider = providerName.replace('local.', '').toUpperCase();

      this.eventBus.publish('credential.oauth.resolve.request', {
        request_id: requestId,
        provider,
        account: account || null
      });
    });
  }
}

module.exports = ProviderLoader;
