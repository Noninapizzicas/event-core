/**
 * Handler Loader
 *
 * Carga y gestiona handlers de eventos (acciones).
 * Soporta carga centralizada y legacy.
 *
 * Estructura centralizada (preferida):
 * - handlers/global/         → Acciones del sistema
 * - handlers/projects/X/     → Acciones del proyecto X
 *
 * Estructura legacy (compatible):
 * - handlers/                → Handlers globales (raíz)
 * - data/projects/X/handlers/ → Handlers del proyecto X
 *
 * Principio: un handler es una ACCIÓN independiente.
 * No pertenece a ningún módulo. El módulo DICE (contrato),
 * el handler HACE (acción).
 *
 * Context del handler:
 * - services: Llamar servicios (project_id inyectado automáticamente)
 * - logger: Logging estructurado
 * - projectId: ID del proyecto (null si global)
 * - emit: Emitir eventos para encadenar handlers
 * - config: Configuración del proyecto (de config/*.json)
 * - store: Key-value persistente
 *
 * @example
 * const loader = new HandlerLoader(eventBus, serviceExecutor, logger);
 * // Carga centralizada (un solo sitio)
 * loader.loadCentralized('./handlers');
 * // O carga legacy
 * loader.loadGlobal();
 * loader.loadProject('mi-proyecto');
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const HandlerStore = require('./handler-store');

class HandlerLoader {
  constructor(eventBus, serviceExecutor, logger) {
    this.eventBus = eventBus;
    this.executor = serviceExecutor;
    this.logger = logger;

    // Map: "scope:handlerName" -> { handler, unsubscribe, projectId, store }
    this.handlers = new Map();

    // Cache de config por proyecto
    this.configCache = new Map();
  }

  /**
   * Carga configuración de un proyecto
   * Lee todos los JSON de data/projects/{id}/config/
   *
   * @param {string} projectId
   * @returns {Object} Config merged { project: {...}, facturas: {...}, ... }
   */
  loadProjectConfig(projectId) {
    // Check cache
    if (this.configCache.has(projectId)) {
      return this.configCache.get(projectId);
    }

    const config = {};
    const configDir = path.join('./data/projects', projectId, 'config');

    try {
      if (fs.existsSync(configDir)) {
        const files = fs.readdirSync(configDir).filter(f => f.endsWith('.json'));

        for (const file of files) {
          try {
            const filePath = path.join(configDir, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            const name = file.replace('.json', '');
            config[name] = JSON.parse(content);
          } catch (error) {
            this.logger?.warn('handlers.config.file.error', {
              projectId,
              file,
              error: error.message
            });
          }
        }
      }
    } catch (error) {
      this.logger?.warn('handlers.config.error', {
        projectId,
        error: error.message
      });
    }

    this.configCache.set(projectId, config);
    return config;
  }

  /**
   * Carga configuración global
   * @returns {Object}
   */
  loadGlobalConfig() {
    if (this.configCache.has('__global__')) {
      return this.configCache.get('__global__');
    }

    let config = {};
    try {
      if (fs.existsSync('./config.json')) {
        config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
      }
    } catch (error) {
      this.logger?.warn('handlers.config.global.error', { error: error.message });
    }

    this.configCache.set('__global__', config);
    return config;
  }

  /**
   * Invalida cache de config (para hot-reload)
   * @param {string} projectId - null para global
   */
  invalidateConfigCache(projectId = null) {
    if (projectId) {
      this.configCache.delete(projectId);
    } else {
      this.configCache.clear();
    }
  }

  /**
   * Crea función emit para un handler
   *
   * @param {string} handlerName
   * @param {string|null} projectId
   * @returns {Function}
   */
  createEmit(handlerName, projectId) {
    return (evento, data = {}) => {
      // Validar evento
      if (typeof evento !== 'string' || !evento.trim()) {
        this.logger?.error('handler.emit.invalid', {
          handler: handlerName,
          reason: 'Event name must be non-empty string'
        });
        return;
      }

      // Construir payload con metadata (preservar _meta del handler)
      const payload = {
        ...data,
        _meta: {
          ...(data._meta || {}),
          source: handlerName,
          projectId: projectId || null,
          correlationId: data._meta?.correlationId || crypto.randomUUID(),
          timestamp: Date.now(),
          emittedAt: new Date().toISOString()
        }
      };

      // Propagar correlationId del evento original si existe
      if (data._sourceEvent?._meta?.correlationId) {
        payload._meta.correlationId = data._sourceEvent._meta.correlationId;
      }

      this.eventBus.publish(evento, payload);

      this.logger?.debug('handler.emit', {
        handler: handlerName,
        event: evento,
        correlationId: payload._meta.correlationId
      });
    };
  }

  /**
   * Carga centralizada: un solo árbol con todo
   *
   * Estructura esperada:
   *   basePath/
   *   ├── global/           → Acciones del sistema (projectId = null)
   *   └── projects/         → Acciones por proyecto
   *       ├── pizzepos/
   *       └── facturas-nonina/
   *
   * También carga handlers sueltos en la raíz de basePath (compatibilidad).
   *
   * @param {string} basePath - Path base (default: './handlers')
   * @param {string} dataPath - Path a data/projects para config/store (default: './data/projects')
   */
  loadCentralized(basePath = './handlers', dataPath = './data/projects') {
    if (!fs.existsSync(basePath)) {
      this.logger?.warn('handlers.centralized.path-not-found', { basePath });
      return;
    }

    // 1. Cargar handlers globales desde basePath/global/
    const globalPath = path.join(basePath, 'global');
    if (fs.existsSync(globalPath)) {
      this.loadFrom(globalPath, null);
    }

    // 2. Cargar handlers sueltos en la raíz (compatibilidad con estructura anterior)
    const rootFiles = this._getHandlerFiles(basePath);
    if (rootFiles.length > 0) {
      this.loadFrom(basePath, null);
    }

    // 3. Cargar handlers por proyecto desde basePath/projects/{projectId}/
    const projectsPath = path.join(basePath, 'projects');
    if (fs.existsSync(projectsPath)) {
      const projectDirs = fs.readdirSync(projectsPath).filter(f => {
        const fullPath = path.join(projectsPath, f);
        return fs.statSync(fullPath).isDirectory() && !f.startsWith('.');
      });

      for (const projectId of projectDirs) {
        const projectHandlersPath = path.join(projectsPath, projectId);
        this.loadFrom(projectHandlersPath, projectId);
      }
    }

    // 4. Cargar handlers legacy desde data/projects/{id}/handlers/ (compatibilidad)
    if (fs.existsSync(dataPath)) {
      const legacyProjects = fs.readdirSync(dataPath).filter(f => {
        const fullPath = path.join(dataPath, f);
        const handlersDir = path.join(fullPath, 'handlers');
        return fs.statSync(fullPath).isDirectory() && fs.existsSync(handlersDir);
      });

      for (const projectId of legacyProjects) {
        const legacyHandlersPath = path.join(dataPath, projectId, 'handlers');
        this.loadFrom(legacyHandlersPath, projectId);
      }
    }

    const stats = this.getStats();
    this.logger?.info('handlers.centralized.loaded', {
      total: stats.total,
      global: stats.global,
      projects: Object.keys(stats.byProject),
      basePath
    });
  }

  /**
   * Obtiene archivos de handler válidos en un directorio (sin recursión)
   *
   * @param {string} dir
   * @returns {string[]}
   * @private
   */
  _getHandlerFiles(dir) {
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir).filter(f =>
      f.endsWith('.js') &&
      !f.startsWith('_') &&
      f !== 'index.js' &&
      fs.statSync(path.join(dir, f)).isFile()
    );
  }

  /**
   * Carga handlers globales desde handlers/
   *
   * @param {string} handlersPath - Path al directorio de handlers globales
   */
  loadGlobal(handlersPath = './handlers') {
    this.loadFrom(handlersPath, null);
  }

  /**
   * Carga handlers de un proyecto
   *
   * @param {string} projectId - ID del proyecto
   * @param {string} basePath - Path base de proyectos
   */
  loadProject(projectId, basePath = './data/projects') {
    const handlersPath = path.join(basePath, projectId, 'handlers');

    if (!fs.existsSync(handlersPath)) {
      this.logger?.debug('handlers.project.no-handlers', { projectId });
      return;
    }

    this.loadFrom(handlersPath, projectId);
  }

  /**
   * Descarga handlers de un proyecto
   *
   * @param {string} projectId - ID del proyecto
   */
  unloadProject(projectId) {
    const toRemove = [];

    for (const [key, data] of this.handlers) {
      if (data.projectId === projectId) {
        data.unsubscribe();
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      this.handlers.delete(key);
    }

    // Invalidar cache de config
    this.invalidateConfigCache(projectId);

    this.logger?.info('handlers.project.unloaded', {
      projectId,
      count: toRemove.length
    });
  }

  /**
   * Carga handlers desde un directorio
   *
   * @param {string} dir - Directorio con handlers .js
   * @param {string|null} projectId - ID del proyecto (null = global)
   */
  loadFrom(dir, projectId) {
    if (!fs.existsSync(dir)) {
      this.logger?.warn('handlers.dir.not-found', { dir });
      return;
    }

    const files = fs.readdirSync(dir).filter(f =>
      f.endsWith('.js') &&
      !f.startsWith('_') &&  // Ignorar archivos que empiezan con _
      f !== 'index.js'
    );

    let loaded = 0;

    for (const file of files) {
      try {
        const filePath = path.resolve(dir, file);

        // Clear cache para hot-reload
        delete require.cache[filePath];

        const exported = require(filePath);

        // Soportar export de array de handlers o handler único
        const handlers = Array.isArray(exported) ? exported : [exported];

        for (const handler of handlers) {
          if (handler && handler.name && handler.trigger && handler.handle) {
            this.register(handler, projectId);
            loaded++;
          }
        }
      } catch (error) {
        this.logger?.error('handlers.load.failed', {
          file,
          error: error.message,
          stack: error.stack
        });
      }
    }

    this.logger?.info('handlers.loaded', {
      scope: projectId || 'global',
      count: loaded,
      dir
    });
  }

  /**
   * Registra un handler
   *
   * @param {Object} handler - Definición del handler
   * @param {string|null} projectId - ID del proyecto
   */
  register(handler, projectId) {
    const { name, trigger, filter, handle, enabled = true } = handler;

    if (!name || !trigger || !handle) {
      this.logger?.warn('handlers.invalid', {
        name,
        reason: 'Missing name, trigger or handle'
      });
      return;
    }

    if (!enabled) {
      this.logger?.debug('handlers.disabled', { name, projectId });
      return;
    }

    // Evitar duplicados (mismo nombre + mismo scope)
    const key = `${projectId || 'global'}:${name}`;
    if (this.handlers.has(key)) {
      this.logger?.debug('handlers.duplicate.skipped', {
        name,
        projectId,
        reason: 'Already registered in this scope'
      });
      return;
    }

    // Verificar que handle es función
    if (typeof handle !== 'function') {
      this.logger?.warn('handlers.invalid', {
        name,
        reason: 'handle must be a function'
      });
      return;
    }

    // Crear services con scope del proyecto
    const services = projectId
      ? this.executor.scoped(projectId)
      : { call: (s, a, p, o) => this.executor.call(s, a, p, o) };

    // Crear emit
    const emit = this.createEmit(name, projectId);

    // Cargar config
    const config = projectId
      ? this.loadProjectConfig(projectId)
      : this.loadGlobalConfig();

    // Crear store
    const store = new HandlerStore(projectId, name);

    // Suscribirse al evento
    const unsubscribe = this.eventBus.subscribe(trigger, async (event) => {
      // Aplicar filtro si existe
      if (filter) {
        try {
          if (!filter(event)) return;
        } catch (filterError) {
          this.logger?.error('handler.filter.error', {
            name,
            error: filterError.message
          });
          return;
        }
      }

      const startTime = Date.now();
      const correlationId = event._meta?.correlationId || crypto.randomUUID();

      try {
        const result = await handle(event, {
          services,
          logger: this.logger,
          projectId,
          emit,
          config,
          store
        });

        this.logger?.info('handler.completed', {
          name,
          projectId,
          trigger,
          correlationId,
          duration: Date.now() - startTime
        });

        return result;
      } catch (error) {
        this.logger?.error('handler.failed', {
          name,
          projectId,
          trigger,
          correlationId,
          error: error.message,
          stack: error.stack,
          duration: Date.now() - startTime
        });

        // Emitir evento de error para posible handling
        emit(`${name}.error`, {
          error: error.message,
          trigger,
          event,
          _sourceEvent: event
        });
      }
    });

    this.handlers.set(key, { handler, unsubscribe, projectId, store });

    this.logger?.debug('handler.registered', {
      name,
      trigger,
      projectId,
      hasFilter: !!filter
    });
  }

  /**
   * Lista handlers cargados
   *
   * @param {string} scope - Filtrar por scope ('global', projectId, o null para todos)
   * @returns {Array}
   */
  list(scope = null) {
    const result = [];

    for (const [key, data] of this.handlers) {
      if (scope === null || data.projectId === scope || (scope === 'global' && !data.projectId)) {
        result.push({
          name: data.handler.name,
          trigger: data.handler.trigger,
          projectId: data.projectId,
          description: data.handler.description,
          enabled: data.handler.enabled !== false
        });
      }
    }

    return result;
  }

  /**
   * Obtiene un handler por nombre
   *
   * @param {string} name
   * @param {string|null} projectId
   * @returns {Object|null}
   */
  get(name, projectId = null) {
    const key = `${projectId || 'global'}:${name}`;
    return this.handlers.get(key)?.handler || null;
  }

  /**
   * Descarga todos los handlers
   */
  unloadAll() {
    for (const [key, data] of this.handlers) {
      data.unsubscribe();
    }
    this.handlers.clear();
    this.configCache.clear();
  }

  /**
   * Recarga handlers de un proyecto
   *
   * @param {string} projectId - ID del proyecto
   */
  reloadProject(projectId) {
    this.unloadProject(projectId);
    this.loadProject(projectId);
  }

  /**
   * Recarga handlers globales
   */
  reloadGlobal() {
    // Descargar globales
    const toRemove = [];
    for (const [key, data] of this.handlers) {
      if (!data.projectId) {
        data.unsubscribe();
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      this.handlers.delete(key);
    }
    this.invalidateConfigCache(null);

    // Recargar
    this.loadGlobal();
  }

  /**
   * Estadísticas
   */
  getStats() {
    const stats = { total: 0, global: 0, byProject: {} };

    for (const [key, data] of this.handlers) {
      stats.total++;
      if (data.projectId) {
        stats.byProject[data.projectId] = (stats.byProject[data.projectId] || 0) + 1;
      } else {
        stats.global++;
      }
    }

    return stats;
  }
}

module.exports = HandlerLoader;
