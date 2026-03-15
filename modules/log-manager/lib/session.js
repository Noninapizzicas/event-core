/**
 * Session Logger - Logging por sesión de arranque
 *
 * Cada vez que el core arranca, se crea una nueva sesión.
 * Los logs se organizan por módulo dentro de cada sesión.
 *
 * Estructura:
 *   data/logs/sessions/
 *   └── 2025-01-14_10-30-00_abc123/
 *       ├── session.json          # Metadata de la sesión
 *       └── modules/
 *           ├── conversation-manager.jsonl
 *           ├── ai-gateway.jsonl
 *           ├── project-manager.jsonl
 *           └── ...
 *
 * Configuración:
 *   - trackedModules: ['*'] para todos, o lista específica
 *   - excludedModules: módulos a excluir
 *
 * @module log-manager/session
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class SessionLogger {
  /**
   * @param {Object} options
   * @param {string} options.sessionsPath - Path base para sesiones
   * @param {Array<string>} options.trackedModules - Módulos a trackear ('*' = todos)
   * @param {Array<string>} options.excludedModules - Módulos a excluir
   * @param {string} options.coreId - ID del core
   */
  constructor(options = {}) {
    this.sessionsPath = options.sessionsPath || './data/logs/sessions';
    this.trackedModules = options.trackedModules || ['*'];
    this.excludedModules = options.excludedModules || ['log-manager'];
    this.coreId = options.coreId || 'unknown';

    // Generar ID de sesión único
    this.sessionId = this._generateSessionId();
    this.sessionPath = path.join(this.sessionsPath, this.sessionId);
    this.modulesPath = path.join(this.sessionPath, 'modules');

    // Writers por módulo (lazy init)
    this.moduleWriters = new Map();

    // Metadata de sesión
    this.metadata = {
      id: this.sessionId,
      coreId: this.coreId,
      startedAt: new Date().toISOString(),
      trackedModules: this.trackedModules,
      excludedModules: this.excludedModules,
      stats: {
        totalEntries: 0,
        byModule: {},
        byLevel: {}
      }
    };

    // Estado
    this.initialized = false;
  }

  /**
   * Genera un ID de sesión único
   * Formato: YYYY-MM-DD_HH-mm-ss_randomhex
   */
  _generateSessionId() {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    const random = crypto.randomBytes(3).toString('hex');
    return `${date}_${time}_${random}`;
  }

  /**
   * Inicializa la sesión (crea directorios)
   */
  async init() {
    if (this.initialized) return;

    try {
      // Crear estructura de directorios
      if (!fs.existsSync(this.sessionsPath)) {
        fs.mkdirSync(this.sessionsPath, { recursive: true });
      }

      fs.mkdirSync(this.sessionPath, { recursive: true });
      fs.mkdirSync(this.modulesPath, { recursive: true });

      // Guardar metadata inicial
      this._saveMetadata();

      this.initialized = true;
      console.log(`[session-logger] Session started: ${this.sessionId}`);

    } catch (error) {
      console.error('[session-logger] Failed to initialize:', error.message);
      throw error;
    }
  }

  /**
   * Verifica si un módulo debe ser trackeado
   * @param {string} moduleName - Nombre del módulo
   * @returns {boolean}
   */
  shouldTrack(moduleName) {
    // Si está en excluidos, no trackear
    if (this.excludedModules.includes(moduleName)) {
      return false;
    }

    // Si trackedModules es '*' o incluye '*', trackear todo
    if (this.trackedModules.includes('*')) {
      return true;
    }

    // Verificar si está en la lista de tracked
    return this.trackedModules.includes(moduleName);
  }

  /**
   * Obtiene o crea el path del archivo para un módulo
   * @param {string} moduleName - Nombre del módulo
   * @returns {string} Path al archivo JSONL
   */
  _getModuleFilePath(moduleName) {
    const safeName = moduleName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
    return path.join(this.modulesPath, `${safeName}.jsonl`);
  }

  /**
   * Escribe una entrada de log para un módulo
   * @param {string} moduleName - Nombre del módulo
   * @param {Object} entry - Entrada de log
   */
  write(moduleName, entry) {
    if (!this.initialized) {
      // Auto-init si no está inicializado
      this.init().catch(() => {});
      if (!this.initialized) return;
    }

    // Verificar si debemos trackear este módulo
    if (!this.shouldTrack(moduleName)) {
      return;
    }

    try {
      const filePath = this._getModuleFilePath(moduleName);
      const line = JSON.stringify({
        ...entry,
        _session: this.sessionId
      }) + '\n';

      // Escribir al archivo del módulo
      fs.appendFileSync(filePath, line);

      // Actualizar stats
      this.metadata.stats.totalEntries++;
      this.metadata.stats.byModule[moduleName] =
        (this.metadata.stats.byModule[moduleName] || 0) + 1;
      this.metadata.stats.byLevel[entry.level] =
        (this.metadata.stats.byLevel[entry.level] || 0) + 1;

      // Guardar metadata cada 100 entradas
      if (this.metadata.stats.totalEntries % 100 === 0) {
        this._saveMetadata();
      }

    } catch (error) {
      // Silenciar errores de escritura (no crítico)
      console.error(`[session-logger] Write error for ${moduleName}:`, error.message);
    }
  }

  /**
   * Guarda la metadata de la sesión
   */
  _saveMetadata() {
    try {
      const metadataPath = path.join(this.sessionPath, 'session.json');
      fs.writeFileSync(metadataPath, JSON.stringify(this.metadata, null, 2));
    } catch (error) {
      // Ignorar
    }
  }

  /**
   * Lee logs de un módulo específico en esta sesión
   * @param {string} moduleName - Nombre del módulo
   * @param {Object} filters - Filtros opcionales
   * @returns {Array} Logs del módulo
   */
  readModule(moduleName, filters = {}) {
    const filePath = this._getModuleFilePath(moduleName);
    const results = [];

    if (!fs.existsSync(filePath)) {
      return results;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          // Aplicar filtros
          if (filters.level && entry.level !== filters.level) continue;
          if (filters.search && !JSON.stringify(entry).includes(filters.search)) continue;

          results.push(entry);
        } catch (e) {
          // Línea inválida
        }
      }
    } catch (error) {
      console.error(`[session-logger] Read error for ${moduleName}:`, error.message);
    }

    return results;
  }

  /**
   * Lista todos los módulos con logs en esta sesión
   * @returns {Array} Lista de módulos
   */
  listModules() {
    const modules = [];

    try {
      if (!fs.existsSync(this.modulesPath)) return modules;

      const files = fs.readdirSync(this.modulesPath);

      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          const moduleName = file.replace('.jsonl', '');
          const filePath = path.join(this.modulesPath, file);
          const stats = fs.statSync(filePath);

          modules.push({
            name: moduleName,
            entries: this.metadata.stats.byModule[moduleName] || 0,
            size: stats.size,
            lastModified: stats.mtime.toISOString()
          });
        }
      }

      // Ordenar por número de entradas
      modules.sort((a, b) => b.entries - a.entries);

    } catch (error) {
      console.error('[session-logger] List modules error:', error.message);
    }

    return modules;
  }

  /**
   * Obtiene información de la sesión actual
   * @returns {Object} Metadata de la sesión
   */
  getSessionInfo() {
    return {
      ...this.metadata,
      path: this.sessionPath,
      uptime: Date.now() - new Date(this.metadata.startedAt).getTime()
    };
  }

  /**
   * Configura dinámicamente los módulos a trackear
   * @param {Array<string>} modules - Lista de módulos ('*' para todos)
   */
  setTrackedModules(modules) {
    this.trackedModules = modules;
    this.metadata.trackedModules = modules;
    this._saveMetadata();
  }

  /**
   * Añade módulos a la lista de tracked
   * @param {Array<string>} modules - Módulos a añadir
   */
  addTrackedModules(modules) {
    for (const mod of modules) {
      if (!this.trackedModules.includes(mod)) {
        this.trackedModules.push(mod);
      }
    }
    this.metadata.trackedModules = this.trackedModules;
    this._saveMetadata();
  }

  /**
   * Excluye módulos del tracking
   * @param {Array<string>} modules - Módulos a excluir
   */
  addExcludedModules(modules) {
    for (const mod of modules) {
      if (!this.excludedModules.includes(mod)) {
        this.excludedModules.push(mod);
      }
    }
    this.metadata.excludedModules = this.excludedModules;
    this._saveMetadata();
  }

  /**
   * Cierra la sesión (guarda metadata final)
   */
  close() {
    this.metadata.endedAt = new Date().toISOString();
    this.metadata.duration = Date.now() - new Date(this.metadata.startedAt).getTime();
    this._saveMetadata();

    console.log(`[session-logger] Session closed: ${this.sessionId} (${this.metadata.stats.totalEntries} entries)`);
  }
}

/**
 * Listar todas las sesiones disponibles
 * @param {string} sessionsPath - Path al directorio de sesiones
 * @returns {Array} Lista de sesiones
 */
function listSessions(sessionsPath = './data/logs/sessions') {
  const sessions = [];

  try {
    if (!fs.existsSync(sessionsPath)) return sessions;

    const dirs = fs.readdirSync(sessionsPath, { withFileTypes: true });

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;

      const sessionPath = path.join(sessionsPath, dir.name);
      const metadataPath = path.join(sessionPath, 'session.json');

      if (fs.existsSync(metadataPath)) {
        try {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
          sessions.push({
            id: dir.name,
            ...metadata,
            path: sessionPath
          });
        } catch (e) {
          // Metadata inválida, añadir info básica
          sessions.push({
            id: dir.name,
            path: sessionPath,
            error: 'Invalid metadata'
          });
        }
      }
    }

    // Ordenar por fecha de inicio (más reciente primero)
    sessions.sort((a, b) =>
      new Date(b.startedAt || 0) - new Date(a.startedAt || 0)
    );

  } catch (error) {
    console.error('[session-logger] List sessions error:', error.message);
  }

  return sessions;
}

/**
 * Leer logs de una sesión específica
 * @param {string} sessionId - ID de la sesión
 * @param {string} moduleName - Nombre del módulo (opcional)
 * @param {string} sessionsPath - Path base
 * @returns {Array} Logs
 */
function readSessionLogs(sessionId, moduleName = null, sessionsPath = './data/logs/sessions') {
  const sessionPath = path.join(sessionsPath, sessionId);
  const modulesPath = path.join(sessionPath, 'modules');
  const results = [];

  if (!fs.existsSync(modulesPath)) return results;

  try {
    const files = moduleName
      ? [`${moduleName}.jsonl`]
      : fs.readdirSync(modulesPath).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = path.join(modulesPath, file);
      if (!fs.existsSync(filePath)) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          results.push(JSON.parse(line));
        } catch (e) {
          // Ignorar líneas inválidas
        }
      }
    }

    // Ordenar por timestamp
    results.sort((a, b) => new Date(a.ts) - new Date(b.ts));

  } catch (error) {
    console.error('[session-logger] Read session logs error:', error.message);
  }

  return results;
}

module.exports = SessionLogger;
module.exports.listSessions = listSessions;
module.exports.readSessionLogs = readSessionLogs;
