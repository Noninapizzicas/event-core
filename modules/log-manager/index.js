/**
 * Log Manager Module
 *
 * Sistema centralizado de logs para Event Core.
 * Gestiona logs por sesión de arranque y por módulo.
 *
 * Características:
 * - Logging por sesión: cada arranque crea una nueva sesión
 * - Filtrado por módulos: configura qué módulos trackear
 * - Formato JSONL: un JSON por línea, fácil de leer/grep
 * - APIs para consulta y estadísticas
 *
 * Estructura:
 *   data/logs/
 *   ├── sessions/                          # Logs por sesión
 *   │   └── 2025-01-14_10-30-00_abc123/
 *   │       ├── session.json               # Metadata de sesión
 *   │       └── modules/
 *   │           ├── conversation-manager.jsonl
 *   │           ├── ai-gateway.jsonl
 *   │           └── ...
 *   └── current.jsonl                      # Logs consolidados (opcional)
 *
 * Configuración en module.json:
 *   - trackedModules: ['*'] para todos, o lista específica
 *   - excludedModules: módulos a excluir del tracking
 *
 * @module log-manager
 * @version 2.0.0
 */

const path = require('path');
const LogStorage = require('./lib/storage');
const LogCollector = require('./lib/collector');
const SessionLogger = require('./lib/session');
const { listSessions, readSessionLogs } = require('./lib/session');

class LogManagerModule {
  constructor() {
    this.name = 'log-manager';
    this.storage = null;
    this.collector = null;
    this.session = null;
    this.logger = null;
    this.cleanupInterval = null;
  }

  /**
   * Inicializa el módulo
   * @param {Object} core - Contexto del core
   */
  async onLoad(core) {
    this.core = core;
    this.logger = core.logger?.child({ module: this.name });
    this.config = core.moduleConfig || {};

    // Resolver paths
    const logsPath = path.resolve(
      process.cwd(),
      this.config.logsPath || './data/logs'
    );
    const sessionsPath = path.join(logsPath, 'sessions');

    // =========================================================================
    // 1. Inicializar Session Logger (NUEVO - por sesión de arranque)
    // =========================================================================
    this.session = new SessionLogger({
      sessionsPath,
      coreId: core.config?.core?.id || core.id || 'unknown',
      trackedModules: this.config.trackedModules || ['*'],
      excludedModules: this.config.excludedModules || ['log-manager']
    });

    await this.session.init();

    // =========================================================================
    // 2. Inicializar Storage (para logs consolidados)
    // =========================================================================
    this.storage = new LogStorage({
      logsPath,
      maxFileSize: this.config.maxFileSize || 10 * 1024 * 1024,
      retentionDays: this.config.retentionDays || 30,
      rotateDaily: this.config.rotateDaily !== false,
      organizeByModule: false // Desactivar, ahora usamos SessionLogger
    });

    // =========================================================================
    // 3. Inicializar Collector con Session Logger
    // =========================================================================
    this.collector = new LogCollector({
      storage: this.storage,
      session: this.session,
      eventBus: core.eventBus,
      logger: this.logger,
      coreId: core.config?.core?.id || core.id || 'unknown'
    });

    this.collector.start();

    // =========================================================================
    // 4. Programar limpieza de sesiones antiguas
    // =========================================================================
    this.cleanupInterval = setInterval(() => {
      this.storage.cleanup();
      this._cleanupOldSessions();
    }, 24 * 60 * 60 * 1000); // Cada 24 horas

    // Log inicial
    this.logger?.info('log-manager.loaded', {
      sessionId: this.session.sessionId,
      trackedModules: this.session.trackedModules,
      excludedModules: this.session.excludedModules
    });

    // Escribir log de inicio de sesión
    this.session.write('log-manager', {
      ts: new Date().toISOString(),
      level: 'info',
      source: 'backend',
      module: 'log-manager',
      msg: 'session.started',
      ctx: {
        sessionId: this.session.sessionId,
        trackedModules: this.session.trackedModules,
        version: '2.0.0'
      }
    });
  }

  /**
   * Limpia sesiones antiguas
   */
  _cleanupOldSessions() {
    const retentionDays = this.config.sessionRetentionDays || 7;
    const sessionsPath = path.join(
      process.cwd(),
      this.config.logsPath || './data/logs',
      'sessions'
    );

    try {
      const sessions = listSessions(sessionsPath);
      const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
      let deleted = 0;

      for (const session of sessions) {
        const sessionDate = new Date(session.startedAt || 0);
        if (sessionDate.getTime() < cutoff) {
          // Eliminar sesión antigua
          const fs = require('fs');
          fs.rmSync(session.path, { recursive: true, force: true });
          deleted++;
        }
      }

      if (deleted > 0) {
        this.logger?.info('log-manager.sessions.cleaned', { deleted, retentionDays });
      }
    } catch (err) {
      this.logger?.error('log-manager.sessions.cleanup_failed', { error: err.message });
    }
  }

  /**
   * Descarga el módulo
   */
  async onUnload() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    if (this.collector) {
      this.collector.stop();
    }

    if (this.session) {
      this.session.close();
    }

    if (this.storage) {
      this.storage.close();
    }

    this.logger?.info('log-manager.unloaded');
  }

  // ===========================================================================
  // API: SESIÓN ACTUAL
  // ===========================================================================

  /**
   * GET /session - Info de la sesión actual
   */
  async getSession(req) {
    return {
      success: true,
      session: this.session.getSessionInfo()
    };
  }

  /**
   * GET /session/modules - Módulos con logs en la sesión actual
   */
  async getSessionModules(req) {
    const modules = this.session.listModules();
    return {
      success: true,
      sessionId: this.session.sessionId,
      count: modules.length,
      modules
    };
  }

  /**
   * GET /session/modules/:module/logs - Logs de un módulo en la sesión actual
   */
  async getSessionModuleLogs(req) {
    const moduleName = this._extractModuleName(req.path, 'modules', 'logs');

    if (!moduleName) {
      return { success: false, error: 'Module name required' };
    }

    const filters = {
      level: req.query?.level,
      search: req.query?.search
    };

    const logs = this.session.readModule(moduleName, filters);

    return {
      success: true,
      sessionId: this.session.sessionId,
      module: moduleName,
      count: logs.length,
      logs
    };
  }

  /**
   * PUT /session/track - Configurar módulos a trackear
   *
   * Body:
   *   - modules: ['conversation-manager', 'ai-gateway'] o ['*']
   *   - exclude: ['log-manager'] (opcional)
   */
  async setTrackedModules(req) {
    const { modules, exclude } = req.body || {};

    if (modules) {
      this.session.setTrackedModules(modules);
    }

    if (exclude) {
      this.session.addExcludedModules(exclude);
    }

    return {
      success: true,
      trackedModules: this.session.trackedModules,
      excludedModules: this.session.excludedModules
    };
  }

  /**
   * POST /session/track/add - Añadir módulos al tracking
   */
  async addTrackedModules(req) {
    const { modules } = req.body || {};

    if (!modules || !Array.isArray(modules)) {
      return { success: false, error: 'modules array required' };
    }

    this.session.addTrackedModules(modules);

    return {
      success: true,
      trackedModules: this.session.trackedModules
    };
  }

  // ===========================================================================
  // API: HISTORIAL DE SESIONES
  // ===========================================================================

  /**
   * GET /sessions - Listar todas las sesiones
   */
  async getSessions(req) {
    const sessionsPath = path.join(
      process.cwd(),
      this.config.logsPath || './data/logs',
      'sessions'
    );

    const sessions = listSessions(sessionsPath);
    const limit = parseInt(req.query?.limit) || 20;

    return {
      success: true,
      currentSession: this.session.sessionId,
      count: sessions.length,
      sessions: sessions.slice(0, limit)
    };
  }

  /**
   * GET /sessions/:id - Info de una sesión específica
   */
  async getSessionById(req) {
    const sessionId = this._extractParam(req.path, 'sessions');

    if (!sessionId) {
      return { success: false, error: 'Session ID required' };
    }

    const sessionsPath = path.join(
      process.cwd(),
      this.config.logsPath || './data/logs',
      'sessions'
    );

    const sessions = listSessions(sessionsPath);
    const session = sessions.find(s => s.id === sessionId);

    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    return {
      success: true,
      session
    };
  }

  /**
   * GET /sessions/:id/logs - Logs de una sesión específica
   */
  async getSessionLogs(req) {
    const sessionId = this._extractSessionId(req.path);

    if (!sessionId) {
      return { success: false, error: 'Session ID required' };
    }

    const moduleName = req.query?.module || null;
    const sessionsPath = path.join(
      process.cwd(),
      this.config.logsPath || './data/logs',
      'sessions'
    );

    const logs = readSessionLogs(sessionId, moduleName, sessionsPath);
    const limit = parseInt(req.query?.limit) || 500;

    return {
      success: true,
      sessionId,
      module: moduleName || 'all',
      count: logs.length,
      logs: logs.slice(-limit) // Últimos N logs
    };
  }

  // ===========================================================================
  // API: LOGS CONSOLIDADOS (legado)
  // ===========================================================================

  /**
   * GET /logs - Obtener logs consolidados con filtros
   */
  async getLogs(req) {
    const filters = {
      level: req.query?.level,
      module: req.query?.module,
      source: req.query?.source,
      search: req.query?.search,
      from: req.query?.from,
      to: req.query?.to,
      limit: parseInt(req.query?.limit) || 100,
      offset: parseInt(req.query?.offset) || 0
    };

    const logs = this.storage.read(filters);

    return {
      success: true,
      count: logs.length,
      filters,
      logs
    };
  }

  /**
   * POST /logs - Agregar un log (desde frontend)
   */
  async addLog(req) {
    const body = req.body || {};

    const msg = body.msg || body.message;
    if (!body.level || !body.module || !msg) {
      return {
        success: false,
        error: 'Missing required fields: level, module, msg (or message)'
      };
    }

    if (!this.collector) {
      return { success: false, error: 'Log collector not initialized' };
    }

    try {
      const normalized = { ...body, msg };
      const result = this.collector.addFromHttp(normalized);
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * GET /stats - Estadísticas generales
   */
  async getStats(req) {
    const sessionInfo = this.session.getSessionInfo();
    const collectorStats = this.collector.getStats();

    return {
      success: true,
      stats: {
        currentSession: {
          id: sessionInfo.id,
          startedAt: sessionInfo.startedAt,
          uptime: sessionInfo.uptime,
          entries: sessionInfo.stats.totalEntries,
          byModule: sessionInfo.stats.byModule,
          byLevel: sessionInfo.stats.byLevel
        },
        collector: collectorStats,
        trackedModules: this.session.trackedModules,
        excludedModules: this.session.excludedModules
      }
    };
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Extrae nombre de módulo de una URL
   */
  _extractModuleName(urlPath, before, after) {
    const parts = urlPath.split('/');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === before && parts[i + 2] === after) {
        return parts[i + 1];
      }
    }
    return null;
  }

  /**
   * Extrae un parámetro de la URL
   */
  _extractParam(urlPath, after) {
    const parts = urlPath.split('/');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === after && parts[i + 1]) {
        return parts[i + 1];
      }
    }
    return null;
  }

  /**
   * Extrae session ID de URLs como /sessions/:id/logs
   */
  _extractSessionId(urlPath) {
    const parts = urlPath.split('/');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === 'sessions' && parts[i + 1] && parts[i + 1] !== 'logs') {
        return parts[i + 1];
      }
    }
    return null;
  }

  // ===========================================================================
  // UTILIDADES PARA LA IA
  // ===========================================================================

  /**
   * Helper: obtener logs de la sesión actual para un módulo
   */
  queryModule(moduleName, filters = {}) {
    return this.session.readModule(moduleName, filters);
  }

  /**
   * Helper: obtener info de sesión actual
   */
  getCurrentSession() {
    return this.session.getSessionInfo();
  }

  /**
   * Helper: obtener path de la sesión actual
   */
  getSessionPath() {
    return this.session.sessionPath;
  }
}

module.exports = LogManagerModule;
