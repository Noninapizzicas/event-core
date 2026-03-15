/**
 * Storage JSONL para logs
 *
 * Almacena logs en formato JSON Lines (un JSON por línea).
 * Fácil de leer por IA, grep-friendly, streameable.
 *
 * Estructura:
 *   data/logs/
 *   ├── modules/              # Logs organizados por módulo
 *   │   ├── file-browser.jsonl
 *   │   ├── ai-gateway.jsonl
 *   │   ├── http-gateway.jsonl
 *   │   └── core.jsonl
 *   ├── current.jsonl         # Logs del día actual (todos)
 *   ├── 2025-01-14.jsonl      # Histórico por día
 *   └── index.json            # Índice con metadata
 */

const fs = require('fs');
const path = require('path');

class LogStorage {
  /**
   * @param {Object} options
   * @param {string} options.logsPath - Directorio de logs
   * @param {number} options.maxFileSize - Tamaño máximo por archivo (bytes)
   * @param {number} options.retentionDays - Días a retener logs
   * @param {boolean} options.rotateDaily - Rotar por día
   * @param {boolean} options.organizeByModule - Organizar logs por módulo (default: true)
   */
  constructor(options = {}) {
    this.logsPath = options.logsPath || './data/logs';
    this.maxFileSize = options.maxFileSize || 10 * 1024 * 1024; // 10MB
    this.retentionDays = options.retentionDays || 30;
    this.rotateDaily = options.rotateDaily !== false;
    this.organizeByModule = options.organizeByModule !== false;

    this.currentDate = this.getDateString();
    this.writeStream = null;
    this.index = { files: {}, modules: {}, stats: { total: 0, byLevel: {}, byModule: {} } };

    this.ensureDirectory();
    this.loadIndex();
  }

  /**
   * Obtiene fecha en formato YYYY-MM-DD
   */
  getDateString(date = new Date()) {
    return date.toISOString().split('T')[0];
  }

  /**
   * Asegura que el directorio de logs existe
   */
  ensureDirectory() {
    if (!fs.existsSync(this.logsPath)) {
      fs.mkdirSync(this.logsPath, { recursive: true });
    }
    // Crear directorio de módulos
    const modulesPath = path.join(this.logsPath, 'modules');
    if (!fs.existsSync(modulesPath)) {
      fs.mkdirSync(modulesPath, { recursive: true });
    }
  }

  /**
   * Sanitiza nombre de módulo para usar como nombre de archivo
   */
  sanitizeModuleName(moduleName) {
    return moduleName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
  }

  /**
   * Obtiene la ruta del archivo de un módulo específico
   */
  getModuleFilePath(moduleName) {
    const safeName = this.sanitizeModuleName(moduleName);
    return path.join(this.logsPath, 'modules', `${safeName}.jsonl`);
  }

  /**
   * Carga el índice de logs
   */
  loadIndex() {
    const indexPath = path.join(this.logsPath, 'index.json');
    try {
      if (fs.existsSync(indexPath)) {
        this.index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      }
    } catch (err) {
      console.error('[log-manager] Error loading index:', err.message);
    }
  }

  /**
   * Guarda el índice
   */
  saveIndex() {
    const indexPath = path.join(this.logsPath, 'index.json');
    try {
      fs.writeFileSync(indexPath, JSON.stringify(this.index, null, 2));
    } catch (err) {
      console.error('[log-manager] Error saving index:', err.message);
    }
  }

  /**
   * Obtiene la ruta del archivo actual
   */
  getCurrentFilePath() {
    const today = this.getDateString();

    // Si cambió el día, rotar
    if (this.rotateDaily && today !== this.currentDate) {
      this.rotate();
      this.currentDate = today;
    }

    return path.join(this.logsPath, 'current.jsonl');
  }

  /**
   * Rota el archivo actual al histórico
   */
  rotate() {
    const currentPath = path.join(this.logsPath, 'current.jsonl');

    if (fs.existsSync(currentPath)) {
      const archivePath = path.join(this.logsPath, `${this.currentDate}.jsonl`);

      try {
        // Cerrar stream si está abierto
        if (this.writeStream) {
          this.writeStream.end();
          this.writeStream = null;
        }

        fs.renameSync(currentPath, archivePath);

        // Actualizar índice
        const stats = fs.statSync(archivePath);
        this.index.files[this.currentDate] = {
          path: archivePath,
          size: stats.size,
          rotatedAt: new Date().toISOString()
        };
        this.saveIndex();

        console.log(`[log-manager] Rotated logs to ${archivePath}`);
      } catch (err) {
        console.error('[log-manager] Error rotating logs:', err.message);
      }
    }
  }

  /**
   * Escribe un log entry
   * @param {Object} entry - Log entry
   */
  write(entry) {
    const filePath = this.getCurrentFilePath();
    const line = JSON.stringify(entry) + '\n';

    try {
      // Escribir al archivo general (current.jsonl)
      fs.appendFileSync(filePath, line);

      // También escribir al archivo específico del módulo
      if (this.organizeByModule && entry.module && entry.module !== 'unknown') {
        this.writeToModule(entry.module, line);
      }

      // Actualizar stats
      this.index.stats.total++;
      this.index.stats.byLevel[entry.level] = (this.index.stats.byLevel[entry.level] || 0) + 1;
      this.index.stats.byModule[entry.module] = (this.index.stats.byModule[entry.module] || 0) + 1;

      // Guardar índice cada 100 logs
      if (this.index.stats.total % 100 === 0) {
        this.saveIndex();
      }
    } catch (err) {
      console.error('[log-manager] Error writing log:', err.message);
    }
  }

  /**
   * Escribe un log al archivo específico del módulo
   * @param {string} moduleName - Nombre del módulo
   * @param {string} line - Línea JSON a escribir
   */
  writeToModule(moduleName, line) {
    try {
      const moduleFilePath = this.getModuleFilePath(moduleName);
      fs.appendFileSync(moduleFilePath, line);

      // Actualizar índice de módulos
      const safeName = this.sanitizeModuleName(moduleName);
      if (!this.index.modules[safeName]) {
        this.index.modules[safeName] = {
          name: moduleName,
          path: moduleFilePath,
          entries: 0,
          firstEntry: new Date().toISOString()
        };
      }
      this.index.modules[safeName].entries++;
      this.index.modules[safeName].lastEntry = new Date().toISOString();
    } catch (err) {
      // Silenciar errores de escritura a módulo (no crítico)
    }
  }

  /**
   * Lee logs de un módulo específico
   * @param {string} moduleName - Nombre del módulo
   * @param {Object} filters - Filtros adicionales
   * @returns {Array} Logs del módulo
   */
  readByModule(moduleName, filters = {}) {
    const moduleFilePath = this.getModuleFilePath(moduleName);
    const results = [];

    if (!fs.existsSync(moduleFilePath)) {
      return results;
    }

    const {
      level,
      source,
      search,
      limit = 100,
      offset = 0
    } = filters;

    const levels = level ? level.split(',') : null;

    try {
      const content = fs.readFileSync(moduleFilePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          // Aplicar filtros
          if (levels && !levels.includes(entry.level)) continue;
          if (source && entry.source !== source) continue;
          if (search && !entry.msg.includes(search) && !JSON.stringify(entry.ctx).includes(search)) continue;

          results.push(entry);
        } catch (parseErr) {
          // Línea inválida, ignorar
        }
      }
    } catch (err) {
      console.error(`[log-manager] Error reading module logs ${moduleName}:`, err.message);
    }

    // Ordenar por timestamp descendente
    results.sort((a, b) => new Date(b.ts) - new Date(a.ts));

    return results.slice(offset, offset + limit);
  }

  /**
   * Lista todos los módulos con logs
   * @returns {Array} Lista de módulos
   */
  listModules() {
    const modules = [];
    const modulesPath = path.join(this.logsPath, 'modules');

    try {
      if (!fs.existsSync(modulesPath)) return modules;

      const files = fs.readdirSync(modulesPath);

      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          const moduleName = file.replace('.jsonl', '');
          const filePath = path.join(modulesPath, file);
          const stats = fs.statSync(filePath);

          // Contar líneas (entradas)
          let entries = 0;
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            entries = content.trim().split('\n').filter(Boolean).length;
          } catch (e) { /* ignore */ }

          modules.push({
            name: moduleName,
            file: file,
            path: filePath,
            size: stats.size,
            entries,
            modified: stats.mtime.toISOString()
          });
        }
      }

      // Ordenar por número de entradas
      modules.sort((a, b) => b.entries - a.entries);
    } catch (err) {
      console.error('[log-manager] Error listing modules:', err.message);
    }

    return modules;
  }

  /**
   * Lee logs con filtros
   * @param {Object} filters
   * @param {string} filters.level - Filtrar por nivel (comma-separated)
   * @param {string} filters.module - Filtrar por módulo (comma-separated)
   * @param {string} filters.source - Filtrar por source (backend/frontend)
   * @param {string} filters.search - Búsqueda en mensaje
   * @param {string} filters.from - Fecha desde (YYYY-MM-DD)
   * @param {string} filters.to - Fecha hasta (YYYY-MM-DD)
   * @param {number} filters.limit - Límite de resultados
   * @param {number} filters.offset - Offset para paginación
   * @returns {Array} Logs filtrados
   */
  read(filters = {}) {
    const {
      level,
      module,
      source,
      search,
      from,
      to,
      limit = 100,
      offset = 0
    } = filters;

    const levels = level ? level.split(',') : null;
    const modules = module ? module.split(',') : null;

    const results = [];
    const files = this.getFilesToRead(from, to);

    for (const file of files) {
      if (!fs.existsSync(file)) continue;

      try {
        const content = fs.readFileSync(file, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);

            // Aplicar filtros
            if (levels && !levels.includes(entry.level)) continue;
            if (modules && !modules.includes(entry.module)) continue;
            if (source && entry.source !== source) continue;
            if (search && !entry.msg.includes(search) && !JSON.stringify(entry.ctx).includes(search)) continue;

            results.push(entry);
          } catch (parseErr) {
            // Línea inválida, ignorar
          }
        }
      } catch (err) {
        console.error(`[log-manager] Error reading ${file}:`, err.message);
      }
    }

    // Ordenar por timestamp descendente (más reciente primero)
    results.sort((a, b) => new Date(b.ts) - new Date(a.ts));

    // Aplicar paginación
    return results.slice(offset, offset + limit);
  }

  /**
   * Obtiene los archivos a leer según rango de fechas
   */
  getFilesToRead(from, to) {
    const files = [];
    const currentPath = path.join(this.logsPath, 'current.jsonl');

    // Siempre incluir current
    files.push(currentPath);

    // Si hay filtro de fechas, buscar archivos históricos
    if (from || to) {
      const fromDate = from ? new Date(from) : new Date('2020-01-01');
      const toDate = to ? new Date(to) : new Date();

      try {
        const allFiles = fs.readdirSync(this.logsPath);

        for (const file of allFiles) {
          if (file.match(/^\d{4}-\d{2}-\d{2}\.jsonl$/)) {
            const fileDate = new Date(file.replace('.jsonl', ''));
            if (fileDate >= fromDate && fileDate <= toDate) {
              files.push(path.join(this.logsPath, file));
            }
          }
        }
      } catch (err) {
        console.error('[log-manager] Error listing files:', err.message);
      }
    }

    return files;
  }

  /**
   * Obtiene estadísticas de logs
   */
  getStats() {
    // Recargar índice para tener datos actualizados
    this.loadIndex();

    const currentPath = path.join(this.logsPath, 'current.jsonl');
    let currentSize = 0;
    let currentLines = 0;

    if (fs.existsSync(currentPath)) {
      const stats = fs.statSync(currentPath);
      currentSize = stats.size;

      try {
        const content = fs.readFileSync(currentPath, 'utf-8');
        currentLines = content.trim().split('\n').filter(Boolean).length;
      } catch (err) {
        // Ignorar
      }
    }

    return {
      total: this.index.stats.total,
      currentFile: {
        path: currentPath,
        size: currentSize,
        lines: currentLines
      },
      byLevel: this.index.stats.byLevel,
      byModule: this.index.stats.byModule,
      archivedFiles: Object.keys(this.index.files).length,
      retentionDays: this.retentionDays
    };
  }

  /**
   * Lista archivos de logs disponibles
   */
  listFiles() {
    const files = [];

    try {
      const allFiles = fs.readdirSync(this.logsPath);

      for (const file of allFiles) {
        if (file.endsWith('.jsonl')) {
          const filePath = path.join(this.logsPath, file);
          const stats = fs.statSync(filePath);

          files.push({
            name: file,
            path: filePath,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            isCurrentn: file === 'current.jsonl'
          });
        }
      }

      // Ordenar por fecha de modificación
      files.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    } catch (err) {
      console.error('[log-manager] Error listing files:', err.message);
    }

    return files;
  }

  /**
   * Limpia logs antiguos según retención
   */
  cleanup() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

    let deleted = 0;

    try {
      const allFiles = fs.readdirSync(this.logsPath);

      for (const file of allFiles) {
        if (file.match(/^\d{4}-\d{2}-\d{2}\.jsonl$/)) {
          const fileDate = new Date(file.replace('.jsonl', ''));

          if (fileDate < cutoffDate) {
            const filePath = path.join(this.logsPath, file);
            fs.unlinkSync(filePath);
            delete this.index.files[file.replace('.jsonl', '')];
            deleted++;
          }
        }
      }

      if (deleted > 0) {
        this.saveIndex();
        console.log(`[log-manager] Cleaned up ${deleted} old log files`);
      }
    } catch (err) {
      console.error('[log-manager] Error cleaning up:', err.message);
    }

    return deleted;
  }

  /**
   * Cierra el storage
   */
  close() {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
    this.saveIndex();
  }
}

module.exports = LogStorage;
