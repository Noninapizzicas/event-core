/**
 * Module Loader - Autodescubrimiento y carga de módulos
 *
 * Escanea el directorio ./modules/ y carga módulos automáticamente.
 * Cada módulo debe tener:
 * - module.json: Manifest con metadata y configuración
 * - index.js: Entry point que exporta clase con métodos onLoad() y onUnload()
 *
 * @example
 * const ModuleLoader = require('./modules/loader');
 *
 * const loader = new ModuleLoader({
 *   modulesPath: './modules',
 *   core,
 *   logger
 * });
 *
 * await loader.loadAll();
 * console.log('Loaded modules:', loader.getLoadedModules());
 */

const fs = require('fs');
const path = require('path');

class ModuleLoader {
  /**
   * @param {Object} options - Opciones
   * @param {string} options.modulesPath - Path al directorio de módulos
   * @param {Object} options.core - Core instance (se pasa a módulos en onLoad)
   * @param {Object} options.registry - ModuleRegistry instance
   * @param {Object} options.logger - Logger instance
   * @param {Object} options.metrics - Metrics instance
   */
  constructor(options = {}) {
    this.modulesPath = options.modulesPath || './modules';
    this.core = options.core || null;
    this.registry = options.registry || null;
    this.logger = options.logger || null;
    this.metrics = options.metrics || null;
    this.config = options.config || {};

    /**
     * Módulos cargados
     * Map: moduleName -> { manifest, instance, path }
     */
    this.loadedModules = new Map();

    /**
     * Watchers para hot-reload
     * Map: moduleName -> FSWatcher
     */
    this.watchers = new Map();

    /**
     * Tools registry for AI
     * Map: toolName -> { name, description, parameters, handler, module, confirmation }
     */
    this.toolsRegistry = new Map();
  }

  /**
   * Descubre todos los módulos en el directorio
   *
   * @returns {Array<Object>} Array de { name, path, manifest }
   *
   * @example
   * const discovered = loader.discover();
   * console.log('Found modules:', discovered.length);
   */
  discover() {
    const modules = [];

    try {
      // Verificar que el directorio existe
      if (!fs.existsSync(this.modulesPath)) {
        if (this.logger) {
          this.logger.warn('modules.path.not.found', {
            path: this.modulesPath
          });
        }
        return modules;
      }

      // Leer contenido del directorio
      const entries = fs.readdirSync(this.modulesPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const moduleName = entry.name;
        const modulePath = path.join(this.modulesPath, moduleName);
        const manifestPath = path.join(modulePath, 'module.json');

        // Verificar que existe module.json
        if (fs.existsSync(manifestPath)) {
          try {
            // Leer y parsear manifest
            const manifestContent = fs.readFileSync(manifestPath, 'utf8');
            const manifest = JSON.parse(manifestContent);

            modules.push({
              name: moduleName,
              path: modulePath,
              manifest
            });

          } catch (error) {
            if (this.logger) {
              this.logger.error('module.manifest.invalid', {
                module: moduleName,
                error: error.message
              }, error);
            }
          }
        } else {
          // Sin module.json → escanear subdirectorios (soporta agrupación por vertical, ej: modules/pizzepos/*)
          const subEntries = fs.readdirSync(modulePath, { withFileTypes: true });

          for (const subEntry of subEntries) {
            if (!subEntry.isDirectory()) {
              continue;
            }

            const subModuleName = subEntry.name;
            const subModulePath = path.join(modulePath, subModuleName);
            const subManifestPath = path.join(subModulePath, 'module.json');

            if (!fs.existsSync(subManifestPath)) {
              continue;
            }

            try {
              const subManifestContent = fs.readFileSync(subManifestPath, 'utf8');
              const subManifest = JSON.parse(subManifestContent);

              modules.push({
                name: subModuleName,
                path: subModulePath,
                manifest: subManifest,
                group: moduleName
              });

            } catch (error) {
              if (this.logger) {
                this.logger.error('module.manifest.invalid', {
                  module: `${moduleName}/${subModuleName}`,
                  error: error.message
                }, error);
              }
            }
          }
        }
      }

      if (this.logger) {
        this.logger.info('modules.discovered', {
          count: modules.length,
          modules: modules.map(m => m.name)
        });
      }

    } catch (error) {
      if (this.logger) {
        this.logger.error('modules.discover.failed', {
          error: error.message
        }, error);
      }
    }

    return modules;
  }

  /**
   * Valida el manifest de un módulo
   *
   * @param {Object} manifest - Module manifest
   * @returns {boolean} true si es válido
   */
  validateManifest(manifest) {
    // Campos requeridos
    const required = ['name', 'version', 'description'];
    for (const field of required) {
      if (!manifest[field]) {
        return false;
      }
    }

    // Validar formato de version (semver básico)
    const versionRegex = /^\d+\.\d+\.\d+$/;
    if (!versionRegex.test(manifest.version)) {
      return false;
    }

    return true;
  }

  /**
   * Construye APIs desde manifest y módulo instance
   *
   * @param {Object} manifest - Module manifest
   * @param {Object} instance - Module instance
   * @returns {Array<Object>} Array de API definitions
   */
  buildAPIsFromManifest(manifest, instance) {
    const apis = [];

    // Support both manifest.apis and manifest.provides.apis formats
    const apiDefinitions = manifest.apis || manifest.provides?.apis;

    if (!apiDefinitions || apiDefinitions.length === 0) {
      return apis;
    }

    for (const apiDef of apiDefinitions) {
      // Support two formats:
      // 1. { name: "ping", ... } - auto-detect handler as handlePing
      // 2. { handler: "handleListTodos", ... } - use handler directly

      let handlerName;
      let apiName;

      if (apiDef.handler) {
        // Format: { handler: "handleListTodos", path: "/todos", method: "GET" }
        handlerName = apiDef.handler;
        // Extract API name from path (e.g., "/todos" -> "todos")
        apiName = apiDef.path.split('/').filter(p => p && !p.startsWith(':')).pop() || apiDef.handler;
      } else if (apiDef.name) {
        // Format: { name: "ping", ... }
        apiName = apiDef.name;
        handlerName = `handle${apiName.charAt(0).toUpperCase()}${apiName.slice(1)}`;
      } else {
        if (this.logger) {
          this.logger.warn('module.api.invalid', {
            module: manifest.name,
            reason: 'API definition must have either "name" or "handler"'
          });
        }
        continue;
      }

      const handler = instance[handlerName];

      if (typeof handler !== 'function') {
        if (this.logger) {
          this.logger.warn('module.api.handler.missing', {
            module: manifest.name,
            api: apiName,
            expected_handler: handlerName
          });
        }
        continue;
      }

      apis.push({
        name: apiName,
        method: apiDef.method,
        path: apiDef.path,
        description: apiDef.description,
        handler: handler.bind(instance) // Bind para mantener contexto
      });
    }

    return apis;
  }

  /**
   * Carga un módulo específico
   *
   * @param {string} moduleName - Nombre del módulo
   * @param {string} modulePath - Path al módulo
   * @param {Object} manifest - Module manifest
   * @returns {Promise<Object>} Module instance
   *
   * @example
   * await loader.load('echo', './modules/echo', manifest);
   */
  async load(moduleName, modulePath, manifest) {
    try {
      // Validar manifest
      if (!this.validateManifest(manifest)) {
        throw new Error('Invalid manifest');
      }

      // Verificar que no esté ya cargado
      if (this.loadedModules.has(moduleName)) {
        throw new Error(`Module ${moduleName} already loaded`);
      }

      // Cargar el módulo
      const indexPath = path.join(modulePath, 'index.js');
      if (!fs.existsSync(indexPath)) {
        throw new Error('index.js not found');
      }

      // Clear require cache para hot-reload
      delete require.cache[require.resolve(path.resolve(indexPath))];

      const ModuleClass = require(path.resolve(indexPath));

      // Verificar que exporta una clase o función
      if (typeof ModuleClass !== 'function') {
        throw new Error('Module must export a class or constructor function');
      }

      // Instanciar módulo
      const instance = new ModuleClass();

      // Verificar que tiene método onLoad
      if (typeof instance.onLoad !== 'function') {
        throw new Error('Module must implement onLoad() method');
      }

      // Auto-wire event subscriptions BEFORE onLoad so modules can
      // publish request events and receive responses during initialization
      const eventUnsubs = this.wireEventSubscriptions(manifest, instance);

      // Ejecutar onLoad - pasamos el core context + moduleConfig + moduleLoader
      const moduleContext = {
        ...this.core,
        moduleConfig: manifest.config || {},  // Config específica del module.json
        moduleLoader: this  // Referencia al loader para acceso a tools
      };

      try {
        await instance.onLoad(moduleContext);
      } catch (loadError) {
        // Clean up event subscriptions if onLoad fails
        for (const unsub of eventUnsubs) {
          if (typeof unsub === 'function') unsub();
        }
        throw loadError;
      }

      // Guardar módulo cargado
      this.loadedModules.set(moduleName, {
        manifest,
        instance,
        path: modulePath,
        loadedAt: Date.now(),
        _eventUnsubs: eventUnsubs
      });

      // Registrar en ModuleRegistry si está disponible
      if (this.registry) {
        const apis = this.buildAPIsFromManifest(manifest, instance);
        const hooks = manifest.provides?.hooks || [];
        const subscribes = manifest.subscribes || [];

        this.registry.register(moduleName, {
          manifest,
          instance,
          apis,
          hooks,
          subscribes
        });
      }

      // Register tools for AI if defined in manifest
      if (manifest.tools && Array.isArray(manifest.tools)) {
        this.registerToolsForAI(moduleName, manifest.tools, instance);
      }

      // Auto-wire UI handlers from manifest
      const uiRegistrations = this.wireUIHandlers(manifest, instance);

      // Store UI wiring data for automatic cleanup on unload
      const moduleData = this.loadedModules.get(moduleName);
      if (moduleData) {
        moduleData._uiRegistrations = uiRegistrations;
      }

      if (this.logger) {
        this.logger.info('module.loaded', {
          module: moduleName,
          version: manifest.version
        });
      }

      if (this.metrics) {
        this.metrics.increment('modules.loaded');
      }

      return instance;

    } catch (error) {
      if (this.logger) {
        this.logger.error('module.load.failed', {
          module: moduleName,
          error: error.message
        }, error);
      }

      if (this.metrics) {
        this.metrics.increment('modules.load.failed');
      }

      throw error;
    }
  }

  /**
   * Descarga un módulo
   *
   * @param {string} moduleName - Nombre del módulo
   * @returns {Promise<void>}
   *
   * @example
   * await loader.unload('echo');
   */
  async unload(moduleName) {
    const moduleData = this.loadedModules.get(moduleName);
    if (!moduleData) {
      throw new Error(`Module ${moduleName} not loaded`);
    }

    try {
      // Auto-cleanup: unsubscribe all events wired from manifest
      if (moduleData._eventUnsubs) {
        for (const unsub of moduleData._eventUnsubs) {
          try { unsub(); } catch (e) { /* already cleaned */ }
        }
        if (this.logger) {
          this.logger.debug('module.events.unwired', {
            module: moduleName,
            count: moduleData._eventUnsubs.length
          });
        }
      }

      // Auto-cleanup: unregister all UI handlers wired from manifest
      if (moduleData._uiRegistrations && this.core?.uiHandler) {
        for (const { domain, action } of moduleData._uiRegistrations) {
          try { this.core.uiHandler.unregister(domain, action); } catch (e) { /* already cleaned */ }
        }
        if (this.logger) {
          this.logger.debug('module.ui_handlers.unwired', {
            module: moduleName,
            count: moduleData._uiRegistrations.length
          });
        }
      }

      // Ejecutar onUnload si existe (solo para cleanup propio del módulo)
      if (typeof moduleData.instance.onUnload === 'function') {
        await moduleData.instance.onUnload();
      }

      // Desregistrar del ModuleRegistry
      if (this.registry) {
        this.registry.unregister(moduleName);
      }

      // Unregister tools for AI
      this.unregisterToolsForAI(moduleName);

      // Detener watcher si existe
      if (this.watchers.has(moduleName)) {
        this.watchers.get(moduleName).close();
        this.watchers.delete(moduleName);
      }

      // Remover del mapa
      this.loadedModules.delete(moduleName);

      if (this.logger) {
        this.logger.info('module.unloaded', {
          module: moduleName
        });
      }

      if (this.metrics) {
        this.metrics.increment('modules.unloaded');
      }

    } catch (error) {
      if (this.logger) {
        this.logger.error('module.unload.failed', {
          module: moduleName,
          error: error.message
        }, error);
      }

      throw error;
    }
  }

  /**
   * Recarga un módulo (unload + load)
   *
   * @param {string} moduleName - Nombre del módulo
   * @returns {Promise<void>}
   *
   * @example
   * await loader.reload('echo');
   */
  async reload(moduleName) {
    const moduleData = this.loadedModules.get(moduleName);
    if (!moduleData) {
      throw new Error(`Module ${moduleName} not loaded`);
    }

    const modulePath = moduleData.path;
    const manifestPath = path.join(modulePath, 'module.json');

    // Leer manifest actualizado
    const manifestContent = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestContent);

    // Unload
    await this.unload(moduleName);

    // Load
    await this.load(moduleName, modulePath, manifest);

    if (this.logger) {
      this.logger.info('module.reloaded', {
        module: moduleName,
        version: manifest.version
      });
    }

    if (this.metrics) {
      this.metrics.increment('modules.reloaded');
    }
  }

  /**
   * Carga todos los módulos descubiertos
   *
   * @returns {Promise<void>}
   *
   * @example
   * await loader.loadAll();
   * console.log('Loaded:', loader.getLoadedModules().length);
   */
  async loadAll() {
    const discovered = this.discover();
    const disabled = this.config.disabled || [];

    // Filter out disabled modules
    const toLoad = disabled.length > 0
      ? discovered.filter(m => {
          if (disabled.includes(m.name)) {
            if (this.logger) {
              this.logger.info('module.skipped.disabled', { module: m.name });
            }
            return false;
          }
          return true;
        })
      : discovered;

    // Sort by config.enabled order (if specified)
    const enabledOrder = this.config.enabled || [];
    if (enabledOrder.length > 0) {
      toLoad.sort((a, b) => {
        const indexA = enabledOrder.indexOf(a.name);
        const indexB = enabledOrder.indexOf(b.name);
        const orderA = indexA >= 0 ? indexA : enabledOrder.length;
        const orderB = indexB >= 0 ? indexB : enabledOrder.length;
        return orderA - orderB;
      });
    }

    if (this.logger) {
      this.logger.info('modules.loading.all', {
        count: toLoad.length,
        disabled: disabled.length > 0 ? disabled.length : undefined
      });
    }

    const results = [];

    for (const { name, path, manifest } of toLoad) {
      try {
        await this.load(name, path, manifest);
        results.push({ name, success: true });
      } catch (error) {
        results.push({ name, success: false, error: error.message });
      }
    }

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    if (this.logger) {
      this.logger.info('modules.loaded.all', {
        total: discovered.length,
        successful,
        failed
      });
    }

    return results;
  }

  /**
   * Descarga todos los módulos
   *
   * @returns {Promise<void>}
   */
  async unloadAll() {
    const moduleNames = Array.from(this.loadedModules.keys());

    for (const name of moduleNames) {
      try {
        await this.unload(name);
      } catch (error) {
        if (this.logger) {
          this.logger.error('module.unload.error', {
            module: name,
            error: error.message
          }, error);
        }
      }
    }
  }

  /**
   * Habilita hot-reload para un módulo
   *
   * @param {string} moduleName - Nombre del módulo
   *
   * @example
   * loader.watch('echo');
   */
  watch(moduleName) {
    const moduleData = this.loadedModules.get(moduleName);
    if (!moduleData) {
      throw new Error(`Module ${moduleName} not loaded`);
    }

    // Si ya está siendo observado, no hacer nada
    if (this.watchers.has(moduleName)) {
      return;
    }

    const modulePath = moduleData.path;

    // Crear watcher
    const watcher = fs.watch(modulePath, { recursive: true }, async (eventType, filename) => {
      if (filename === 'module.json' || filename === 'index.js') {
        if (this.logger) {
          this.logger.info('module.changed', {
            module: moduleName,
            file: filename
          });
        }

        // Debounce: esperar 500ms antes de recargar
        clearTimeout(this.reloadTimeout);
        this.reloadTimeout = setTimeout(async () => {
          try {
            await this.reload(moduleName);
          } catch (error) {
            if (this.logger) {
              this.logger.error('module.reload.failed', {
                module: moduleName,
                error: error.message
              }, error);
            }
          }
        }, 500);
      }
    });

    this.watchers.set(moduleName, watcher);

    if (this.logger) {
      this.logger.debug('module.watch.enabled', {
        module: moduleName
      });
    }
  }

  /**
   * Habilita hot-reload para todos los módulos cargados
   */
  watchAll() {
    for (const moduleName of this.loadedModules.keys()) {
      try {
        this.watch(moduleName);
      } catch (error) {
        if (this.logger) {
          this.logger.error('module.watch.failed', {
            module: moduleName,
            error: error.message
          }, error);
        }
      }
    }
  }

  /**
   * Obtiene la lista de módulos cargados
   *
   * @returns {Array<Object>} Array de módulos cargados
   */
  getLoadedModules() {
    return Array.from(this.loadedModules.entries()).map(([name, data]) => ({
      name,
      version: data.manifest.version,
      description: data.manifest.description,
      loadedAt: data.loadedAt
    }));
  }

  /**
   * Obtiene un módulo cargado por nombre
   *
   * @param {string} moduleName - Nombre del módulo
   * @returns {Object|null} Module data o null si no está cargado
   */
  getModule(moduleName) {
    return this.loadedModules.get(moduleName) || null;
  }

  /**
   * Verifica si un módulo está cargado
   *
   * @param {string} moduleName - Nombre del módulo
   * @returns {boolean}
   */
  isLoaded(moduleName) {
    return this.loadedModules.has(moduleName);
  }

  // ==========================================
  // Declarative Wiring from module.json
  // ==========================================

  /**
   * Normalizes subscribes from module.json into a consistent format.
   * Accepts all legacy formats:
   *   - root "subscribes": ["event.name", ...]
   *   - root "subscribes": [{ event, handler }, ...]
   *   - nested "events.subscribes": ["event.name", ...]
   *   - nested "events.subscribes": [{ event, handler }, ...]
   *
   * @param {Object} manifest - Module manifest
   * @returns {Array<{event: string, handler: string|null}>}
   */
  normalizeSubscriptions(manifest) {
    // Merge both sources (root and nested), root takes priority
    const raw = manifest.subscribes || manifest.events?.subscribes || [];

    return raw.map(entry => {
      if (typeof entry === 'string') {
        return { event: entry, handler: null };
      }
      return {
        event: entry.event || entry.topic || entry,
        handler: entry.handler || null
      };
    });
  }

  /**
   * Auto-wires event subscriptions declared in module.json.
   * Resolves handler strings to bound methods on the instance.
   * Returns array of unsubscribe functions for automatic cleanup.
   *
   * @param {Object} manifest - Module manifest
   * @param {Object} instance - Module instance
   * @returns {Array<Function>} Unsubscribe functions
   */
  wireEventSubscriptions(manifest, instance) {
    const unsubs = [];
    const eventBus = this.core?.eventBus;

    if (!eventBus) return unsubs;

    const subscriptions = this.normalizeSubscriptions(manifest);

    for (const sub of subscriptions) {
      if (!sub.handler) continue;

      const handlerFn = instance[sub.handler];
      if (typeof handlerFn !== 'function') {
        if (this.logger) {
          this.logger.warn('module.event.handler.missing', {
            module: manifest.name,
            event: sub.event,
            expected: sub.handler
          });
        }
        continue;
      }

      const unsub = eventBus.subscribe(sub.event, handlerFn.bind(instance));
      unsubs.push(unsub);

      if (this.logger) {
        this.logger.debug('module.event.wired', {
          module: manifest.name,
          event: sub.event,
          handler: sub.handler
        });
      }
    }

    if (unsubs.length > 0 && this.logger) {
      this.logger.info('module.events.wired', {
        module: manifest.name,
        count: unsubs.length
      });
    }

    return unsubs;
  }

  /**
   * Normalizes UI handler declarations from module.json.
   * Accepts legacy formats:
   *   - "handlers": [{ domain, action, method }]   (filesystem)
   *   - "uiActions": [{ domain, action, handler }]  (scheduler)
   *   - "ui_handlers": [{ domain, action, handler }] (standard)
   *
   * @param {Object} manifest - Module manifest
   * @returns {Array<{domain: string, action: string, handler: string}>}
   */
  normalizeUIHandlers(manifest) {
    const raw = manifest.ui_handlers || manifest.uiActions || manifest.handlers || [];

    return raw.map(entry => ({
      domain: entry.domain,
      action: entry.action,
      handler: entry.handler || entry.method || null
    }));
  }

  /**
   * Auto-wires UI request handlers declared in module.json.
   * Resolves handler strings to bound methods on the instance.
   * Returns registration records for automatic cleanup.
   *
   * @param {Object} manifest - Module manifest
   * @param {Object} instance - Module instance
   * @returns {Array<{domain: string, action: string}>} Registrations for cleanup
   */
  wireUIHandlers(manifest, instance) {
    const registrations = [];
    const uiHandler = this.core?.uiHandler;

    if (!uiHandler) return registrations;

    const handlers = this.normalizeUIHandlers(manifest);

    for (const h of handlers) {
      if (!h.handler || !h.domain || !h.action) continue;

      const handlerFn = instance[h.handler];
      if (typeof handlerFn !== 'function') {
        if (this.logger) {
          this.logger.warn('module.ui_handler.missing', {
            module: manifest.name,
            domain: h.domain,
            action: h.action,
            expected: h.handler
          });
        }
        continue;
      }

      uiHandler.register(h.domain, h.action, handlerFn.bind(instance));
      registrations.push({ domain: h.domain, action: h.action });

      if (this.logger) {
        this.logger.debug('module.ui_handler.wired', {
          module: manifest.name,
          domain: h.domain,
          action: h.action,
          handler: h.handler
        });
      }
    }

    if (registrations.length > 0 && this.logger) {
      this.logger.info('module.ui_handlers.wired', {
        module: manifest.name,
        count: registrations.length
      });
    }

    return registrations;
  }

  // ==========================================
  // Tools Registry for AI
  // ==========================================

  /**
   * Register tools from a module for AI use
   *
   * @param {string} moduleName - Module name
   * @param {Array} tools - Tools definitions from module.json
   * @param {Object} instance - Module instance
   */
  registerToolsForAI(moduleName, tools, instance) {
    for (const tool of tools) {
      const handlerName = tool.handler || tool.name.split('.')[1];
      const handler = instance[handlerName];

      if (typeof handler !== 'function') {
        if (this.logger) {
          this.logger.warn('module.tool.handler.missing', {
            module: moduleName,
            tool: tool.name,
            expected_handler: handlerName
          });
        }
        continue;
      }

      this.toolsRegistry.set(tool.name, {
        name: tool.name,
        description: tool.description || `${moduleName} ${tool.name}`,
        parameters: tool.parameters || {},
        handler: handler.bind(instance),
        module: moduleName,
        confirmation: tool.confirmation || false
      });

      if (this.logger) {
        this.logger.debug('module.tool.registered', {
          module: moduleName,
          tool: tool.name,
          confirmation: tool.confirmation || false
        });
      }
    }

    if (this.logger) {
      this.logger.info('module.tools.registered', {
        module: moduleName,
        count: tools.length
      });
    }
  }

  /**
   * Unregister tools from a module
   *
   * @param {string} moduleName - Module name
   */
  unregisterToolsForAI(moduleName) {
    const toDelete = [];

    for (const [toolName, tool] of this.toolsRegistry) {
      if (tool.module === moduleName) {
        toDelete.push(toolName);
      }
    }

    for (const toolName of toDelete) {
      this.toolsRegistry.delete(toolName);
    }

    if (this.logger && toDelete.length > 0) {
      this.logger.info('module.tools.unregistered', {
        module: moduleName,
        count: toDelete.length
      });
    }
  }

  /**
   * Register provider tools for AI use
   *
   * This method unifies the two tool systems by registering service providers
   * (from services/providers/) into the toolsRegistry alongside module tools.
   *
   * @param {Object} providerRegistry - ProviderRegistry instance
   */
  registerProviderTools(providerRegistry) {
    if (!providerRegistry) {
      if (this.logger) {
        this.logger.warn('module-loader.provider-registry.not-available');
      }
      return;
    }

    const stats = providerRegistry.getStats();
    if (this.logger) {
      this.logger.info('module-loader.registering-provider-tools', {
        providers: stats.total_providers,
        functions: stats.total_functions
      });
    }

    // Get all providers info from registry (returns an Array)
    const providersInfo = providerRegistry.getAll();
    let registeredCount = 0;

    for (const providerInfo of providersInfo) {
      if (!providerInfo.available) {
        if (this.logger) {
          this.logger.debug('module-loader.provider.skipped', {
            provider: providerInfo.name,
            reason: 'not available'
          });
        }
        continue;
      }

      // Get full provider data with function definitions
      const provider = providerRegistry.get(providerInfo.name);
      if (!provider || !provider.functions) {
        if (this.logger) {
          this.logger.debug('module-loader.provider.skipped', {
            provider: providerInfo.name,
            reason: 'no functions defined'
          });
        }
        continue;
      }

      // Register each function as a tool
      for (const [fnName, fnDef] of Object.entries(provider.functions)) {
        const toolName = this.buildProviderToolName(providerInfo.name, fnName);
        const eventName = fnDef.event || `${providerInfo.name}.${fnName}.request`;

        // Build parameters schema for AI
        const parameters = this.buildProviderParametersSchema(fnDef.input);

        this.toolsRegistry.set(toolName, {
          name: toolName,
          description: fnDef.description || `${providerInfo.name} ${fnName}`,
          parameters,
          handler: this.createProviderToolHandler(eventName, providerInfo.name, fnName),
          module: `provider:${providerInfo.name}`,
          confirmation: fnDef.confirmation || false
        });

        registeredCount++;

        if (this.logger) {
          this.logger.debug('module-loader.provider-tool.registered', {
            provider: providerInfo.name,
            function: fnName,
            tool: toolName,
            event: eventName
          });
        }
      }
    }

    if (this.logger) {
      this.logger.info('module-loader.provider-tools.registered', {
        total: registeredCount
      });
    }
  }

  /**
   * Build tool name for provider function
   * Uses underscore format: provider_function
   *
   * @param {string} providerName - Provider name (e.g., 'local.gmail')
   * @param {string} fnName - Function name (e.g., 'send')
   * @returns {string} Tool name (e.g., 'gmail_send')
   */
  buildProviderToolName(providerName, fnName) {
    // Remove 'local.' prefix if present
    const cleanProvider = providerName.replace(/^local\./, '');
    // Replace dots and dashes with underscores
    const normalizedProvider = cleanProvider.replace(/[.-]/g, '_');
    return `${normalizedProvider}_${fnName}`;
  }

  /**
   * Build parameters schema from provider input definition
   *
   * @param {Object} input - Provider function input schema
   * @returns {Object} Parameters schema for AI tools
   */
  buildProviderParametersSchema(input) {
    if (!input) {
      return {
        type: 'object',
        properties: {},
        required: []
      };
    }

    // If input is already in the right format, return it
    if (input.type === 'object' && input.properties) {
      return input;
    }

    // Convert provider format to JSON Schema
    const properties = {};
    const required = [];

    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string') {
        // Simple type string
        properties[key] = { type: this.normalizeSchemaType(value) };
      } else if (typeof value === 'object') {
        // Object with type, description, etc.
        const prop = {};

        // Normalize type (convert "string|array" to ["string", "array"])
        if (value.type) {
          prop.type = this.normalizeSchemaType(value.type);
        }

        // Copy valid JSON Schema properties
        if (value.description) prop.description = value.description;
        if (value.enum) prop.enum = value.enum;
        if (value.default !== undefined) prop.default = value.default;
        if (value.items) prop.items = value.items;
        if (value.minLength !== undefined) prop.minLength = value.minLength;
        if (value.maxLength !== undefined) prop.maxLength = value.maxLength;
        if (value.minimum !== undefined) prop.minimum = value.minimum;
        if (value.maximum !== undefined) prop.maximum = value.maximum;
        if (value.pattern) prop.pattern = value.pattern;

        properties[key] = prop;

        // Check if required (explicitly true or not set to false)
        if (value.required === true) {
          required.push(key);
        }
      }
    }

    return {
      type: 'object',
      properties,
      required
    };
  }

  /**
   * Normalize type notation to valid JSON Schema
   * Converts "string|array" to ["string", "array"]
   *
   * @param {string} type - Type notation
   * @returns {string|Array} JSON Schema type
   */
  normalizeSchemaType(type) {
    if (typeof type !== 'string') return type;

    // Handle pipe notation: "string|array" -> ["string", "array"]
    if (type.includes('|')) {
      return type.split('|').map(t => t.trim());
    }

    return type;
  }

  /**
   * Create handler function for provider tool
   * Uses event bus to communicate with provider
   *
   * @param {string} eventName - Request event name
   * @param {string} providerName - Provider name
   * @param {string} fnName - Function name
   * @returns {Function} Handler function
   */
  createProviderToolHandler(eventName, providerName, fnName) {
    const self = this;

    return async function(args) {
      if (!self.core?.eventBus) {
        throw new Error('EventBus not available');
      }

      const correlationId = `${fnName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const responseEvent = eventName.replace(/\.request$/, '.response');

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          reject(new Error(`Timeout waiting for ${responseEvent}`));
        }, 30000);

        const unsubscribe = self.core.eventBus.subscribe(responseEvent, (response) => {
          // Skip responses from other concurrent calls
          if (response._correlationId && response._correlationId !== correlationId) {
            return;
          }
          clearTimeout(timeout);
          unsubscribe();

          if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        });

        self.core.eventBus.publish(eventName, { ...args, _correlationId: correlationId });
      });
    };
  }

  /**
   * Get all tools for AI providers
   * Returns tools in a format suitable for function calling
   *
   * @returns {Array} Array of tool definitions
   */
  getToolsForAI() {
    return Array.from(this.toolsRegistry.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      confirmation: tool.confirmation
    }));
  }

  /**
   * Get a specific tool by name
   *
   * @param {string} toolName - Tool name (e.g., 'fs.read')
   * @returns {Object|null} Tool definition or null
   */
  getTool(toolName) {
    return this.toolsRegistry.get(toolName) || null;
  }

  /**
   * Execute a tool by name
   *
   * @param {string} toolName - Tool name (e.g., 'fs.read')
   * @param {Object} args - Tool arguments
   * @returns {Promise<Object>} Tool execution result
   */
  async executeTool(toolName, args) {
    const tool = this.toolsRegistry.get(toolName);

    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    // Validate required parameters against schema
    const params = tool.parameters;
    if (params?.required && Array.isArray(params.required)) {
      const missing = params.required.filter(p => args[p] === undefined);
      if (missing.length > 0) {
        throw new Error(`Tool '${toolName}' missing required params: ${missing.join(', ')}`);
      }
    }

    if (this.logger) {
      this.logger.info('tool.executing', {
        tool: toolName,
        module: tool.module
      });
    }

    try {
      const result = await tool.handler(args);

      if (this.logger) {
        this.logger.info('tool.executed', {
          tool: toolName,
          status: result?.status || 200
        });
      }

      return result;

    } catch (error) {
      if (this.logger) {
        this.logger.error('tool.execution.error', {
          tool: toolName,
          error: error.message
        });
      }
      throw error;
    }
  }

  /**
   * Check if a tool requires confirmation
   *
   * @param {string} toolName - Tool name
   * @returns {boolean}
   */
  toolRequiresConfirmation(toolName) {
    const tool = this.toolsRegistry.get(toolName);
    return tool?.confirmation || false;
  }
}

module.exports = ModuleLoader;
