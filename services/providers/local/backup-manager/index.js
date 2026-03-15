/**
 * Local Backup Manager Service
 *
 * Gestión de backups del sistema Event-Core.
 * Respalda providers, handlers, contexto, datos y configuración.
 * No requiere credenciales externas.
 *
 * Eventos:
 * - local.backup-manager.create.request -> local.backup-manager.create.response
 * - local.backup-manager.list.request -> local.backup-manager.list.response
 * - local.backup-manager.restore.request -> local.backup-manager.restore.response
 * - local.backup-manager.cleanup.request -> local.backup-manager.cleanup.response
 * - local.backup-manager.status.request -> local.backup-manager.status.response
 *
 * @version 1.0.0
 * @created 2026-02-05
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE_DIR = path.resolve('.');
const BACKUP_DIR = path.resolve('./data/backups');

// Qué se respalda según el scope
const SCOPES = {
  providers: {
    descripcion: 'Providers locales (services/providers/local/)',
    paths: ['services/providers/local']
  },
  handlers: {
    descripcion: 'Handlers globales (handlers/)',
    paths: ['handlers']
  },
  contexto: {
    descripcion: 'Fuente de verdad (contexto/)',
    paths: ['contexto']
  },
  config: {
    descripcion: 'Configuración global (.env, config/)',
    paths: ['config'],
    files: ['.env']
  },
  project: {
    descripcion: 'Datos de un proyecto específico (data/projects/{id}/)',
    dynamic: true
  },
  full: {
    descripcion: 'Backup completo (providers + handlers + contexto + config + projects)',
    paths: ['services/providers/local', 'handlers', 'contexto', 'config', 'data/projects'],
    files: ['.env']
  }
};

/**
 * Genera ID de backup: scope_YYYYMMDD_HHmmss
 */
function generateBackupId(scope) {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').replace(/\..+/, '').substring(0, 15);
  return `${scope}_${ts}`;
}

/**
 * Copia un directorio recursivamente
 */
function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      // Saltar node_modules y .git
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      count += copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

/**
 * Calcula tamaño de directorio recursivamente
 */
function dirSize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(fullPath);
    } else {
      total += fs.statSync(fullPath).size;
    }
  }
  return total;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = {
  name: 'local.backup-manager',
  description: 'Gestión de backups — respalda providers, handlers, contexto y datos del sistema',

  functions: {
    create: {
      event: 'local.backup-manager.create.request',
      description: 'Crea un backup completo o selectivo del sistema',
      input: {
        scope: {
          type: 'string',
          description: 'Alcance: full | providers | handlers | contexto | config | project (default: full)',
          required: false
        },
        projectId: {
          type: 'string',
          description: 'ID del proyecto (solo si scope=project)',
          required: false
        },
        nota: {
          type: 'string',
          description: 'Nota descriptiva del backup',
          required: false
        }
      },
      output: {
        backupId: { type: 'string', description: 'ID del backup creado' },
        path: { type: 'string', description: 'Ruta del backup' },
        files: { type: 'number', description: 'Archivos respaldados' },
        size: { type: 'string', description: 'Tamaño total' }
      }
    },
    list: {
      event: 'local.backup-manager.list.request',
      description: 'Lista backups disponibles con tamaño y fecha',
      input: {
        scope: {
          type: 'string',
          description: 'Filtrar por scope (opcional)',
          required: false
        }
      },
      output: {
        backups: { type: 'array', description: 'Lista de backups' },
        total: { type: 'number', description: 'Total de backups' },
        totalSize: { type: 'string', description: 'Tamaño total' }
      }
    },
    restore: {
      event: 'local.backup-manager.restore.request',
      description: 'Restaura un backup específico',
      input: {
        backupId: {
          type: 'string',
          description: 'ID del backup a restaurar',
          required: true
        },
        dryRun: {
          type: 'boolean',
          description: 'Solo simular, no restaurar (default: true)',
          required: false
        }
      },
      output: {
        restored: { type: 'boolean', description: 'Si se restauró' },
        files: { type: 'number', description: 'Archivos restaurados' },
        warnings: { type: 'array', description: 'Advertencias' }
      }
    },
    cleanup: {
      event: 'local.backup-manager.cleanup.request',
      description: 'Elimina backups antiguos según política de retención',
      input: {
        keepDays: {
          type: 'number',
          description: 'Mantener backups de los últimos N días (default: 30)',
          required: false
        },
        keepMin: {
          type: 'number',
          description: 'Mínimo de backups a mantener siempre (default: 3)',
          required: false
        }
      },
      output: {
        removed: { type: 'number', description: 'Backups eliminados' },
        kept: { type: 'number', description: 'Backups conservados' },
        freedSize: { type: 'string', description: 'Espacio liberado' }
      }
    },
    status: {
      event: 'local.backup-manager.status.request',
      description: 'Estado del sistema de backups — resumen, último backup, espacio',
      input: {},
      output: {
        totalBackups: { type: 'number', description: 'Total de backups' },
        totalSize: { type: 'string', description: 'Espacio usado' },
        lastBackup: { type: 'object', description: 'Último backup' },
        scopes: { type: 'object', description: 'Backups por scope' }
      }
    }
  },

  /**
   * create — Crea un backup
   */
  async create({ scope = 'full', projectId, nota }) {
    // Validar scope
    if (scope === 'project' && !projectId) {
      return { success: false, error: 'projectId es requerido cuando scope=project' };
    }
    if (!SCOPES[scope]) {
      return { success: false, error: `Scope inválido: ${scope}. Válidos: ${Object.keys(SCOPES).join(', ')}` };
    }

    // Validar que el proyecto existe
    if (scope === 'project') {
      const projectDir = path.join(BASE_DIR, 'data', 'projects', projectId);
      if (!fs.existsSync(projectDir)) {
        return { success: false, error: `Proyecto '${projectId}' no encontrado` };
      }
    }

    try {
      const backupId = generateBackupId(scope === 'project' ? `project-${projectId}` : scope);
      const backupPath = path.join(BACKUP_DIR, backupId);
      fs.mkdirSync(backupPath, { recursive: true });

      let totalFiles = 0;

      if (scope === 'project') {
        // Backup de un proyecto específico
        const srcDir = path.join(BASE_DIR, 'data', 'projects', projectId);
        const destDir = path.join(backupPath, 'data', 'projects', projectId);
        totalFiles += copyDirSync(srcDir, destDir);
      } else {
        const scopeDef = SCOPES[scope];

        // Copiar directorios
        if (scopeDef.paths) {
          for (const relPath of scopeDef.paths) {
            const srcDir = path.join(BASE_DIR, relPath);
            const destDir = path.join(backupPath, relPath);
            totalFiles += copyDirSync(srcDir, destDir);
          }
        }

        // Copiar archivos individuales
        if (scopeDef.files) {
          for (const file of scopeDef.files) {
            const srcFile = path.join(BASE_DIR, file);
            if (fs.existsSync(srcFile)) {
              const destFile = path.join(backupPath, file);
              fs.mkdirSync(path.dirname(destFile), { recursive: true });
              fs.copyFileSync(srcFile, destFile);
              totalFiles++;
            }
          }
        }
      }

      // Escribir metadata del backup
      const metadata = {
        backupId,
        scope,
        projectId: projectId || null,
        nota: nota || null,
        created: new Date().toISOString(),
        files: totalFiles,
        system: 'event-core',
        version: '1.0.0'
      };
      fs.writeFileSync(
        path.join(backupPath, '_backup.json'),
        JSON.stringify(metadata, null, 2)
      );

      const size = dirSize(backupPath);

      return {
        success: true,
        data: {
          backupId,
          path: backupPath,
          scope,
          files: totalFiles,
          size: formatSize(size),
          nota: nota || null,
          created: metadata.created
        }
      };
    } catch (error) {
      return { success: false, error: `Error creando backup: ${error.message}` };
    }
  },

  /**
   * list — Lista backups disponibles
   */
  async list({ scope } = {}) {
    try {
      if (!fs.existsSync(BACKUP_DIR)) {
        return { success: true, data: { backups: [], total: 0, totalSize: '0 B' } };
      }

      const entries = fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory());

      let backups = [];
      let totalBytes = 0;

      for (const entry of entries) {
        const backupPath = path.join(BACKUP_DIR, entry.name);
        const metaPath = path.join(backupPath, '_backup.json');

        let meta = { backupId: entry.name, scope: 'unknown', created: null };
        if (fs.existsSync(metaPath)) {
          try {
            meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          } catch (e) { /* fallback a valores default */ }
        }

        // Filtrar por scope si se especificó
        if (scope && meta.scope !== scope) continue;

        const size = dirSize(backupPath);
        totalBytes += size;

        backups.push({
          backupId: meta.backupId,
          scope: meta.scope,
          projectId: meta.projectId || null,
          nota: meta.nota || null,
          created: meta.created || fs.statSync(backupPath).birthtime.toISOString(),
          files: meta.files || 0,
          size: formatSize(size)
        });
      }

      // Ordenar por fecha descendente
      backups.sort((a, b) => (b.created || '').localeCompare(a.created || ''));

      return {
        success: true,
        data: {
          backups,
          total: backups.length,
          totalSize: formatSize(totalBytes)
        }
      };
    } catch (error) {
      return { success: false, error: `Error listando backups: ${error.message}` };
    }
  },

  /**
   * restore — Restaura un backup
   */
  async restore({ backupId, dryRun = true }) {
    if (!backupId) {
      return { success: false, error: 'backupId es requerido' };
    }

    const backupPath = path.join(BACKUP_DIR, backupId);
    if (!fs.existsSync(backupPath)) {
      return { success: false, error: `Backup '${backupId}' no encontrado` };
    }

    try {
      const metaPath = path.join(backupPath, '_backup.json');
      let meta = {};
      if (fs.existsSync(metaPath)) {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      }

      // Inventariar archivos a restaurar
      const filesToRestore = [];
      const warnings = [];

      function scanDir(dir, relBase = '') {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === '_backup.json') continue;
          const fullPath = path.join(dir, entry.name);
          const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            scanDir(fullPath, relPath);
          } else {
            const destPath = path.join(BASE_DIR, relPath);
            const exists = fs.existsSync(destPath);
            filesToRestore.push({
              source: fullPath,
              dest: destPath,
              relativePath: relPath,
              overwrite: exists
            });
            if (exists) {
              warnings.push(`Sobrescribirá: ${relPath}`);
            }
          }
        }
      }

      scanDir(backupPath);

      if (dryRun) {
        return {
          success: true,
          data: {
            restored: false,
            dryRun: true,
            backupId,
            scope: meta.scope || 'unknown',
            files: filesToRestore.length,
            overwrites: warnings.length,
            warnings: warnings.slice(0, 50),
            mensaje: `Dry run: ${filesToRestore.length} archivos se restaurarían (${warnings.length} sobrescrituras). Usar dryRun: false para ejecutar.`
          }
        };
      }

      // Restaurar de verdad
      let restored = 0;
      for (const file of filesToRestore) {
        fs.mkdirSync(path.dirname(file.dest), { recursive: true });
        fs.copyFileSync(file.source, file.dest);
        restored++;
      }

      return {
        success: true,
        data: {
          restored: true,
          dryRun: false,
          backupId,
          scope: meta.scope || 'unknown',
          files: restored,
          overwrites: warnings.length,
          warnings: warnings.slice(0, 20)
        }
      };
    } catch (error) {
      return { success: false, error: `Error restaurando backup: ${error.message}` };
    }
  },

  /**
   * cleanup — Elimina backups antiguos
   */
  async cleanup({ keepDays = 30, keepMin = 3 } = {}) {
    try {
      if (!fs.existsSync(BACKUP_DIR)) {
        return { success: true, data: { removed: 0, kept: 0, freedSize: '0 B' } };
      }

      const entries = fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory());

      // Leer metadata de todos los backups
      const backups = [];
      for (const entry of entries) {
        const backupPath = path.join(BACKUP_DIR, entry.name);
        const metaPath = path.join(backupPath, '_backup.json');

        let created = null;
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            created = meta.created;
          } catch (e) { /* skip */ }
        }
        if (!created) {
          created = fs.statSync(backupPath).birthtime.toISOString();
        }

        backups.push({
          name: entry.name,
          path: backupPath,
          created,
          size: dirSize(backupPath)
        });
      }

      // Ordenar por fecha descendente (más recientes primero)
      backups.sort((a, b) => b.created.localeCompare(a.created));

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - keepDays);
      const cutoffStr = cutoffDate.toISOString();

      let removed = 0;
      let freedBytes = 0;

      for (let i = 0; i < backups.length; i++) {
        const backup = backups[i];
        const remaining = backups.length - removed;

        // Mantener mínimo
        if (remaining <= keepMin) break;

        // Solo eliminar si es anterior al cutoff
        if (backup.created < cutoffStr && i >= keepMin) {
          freedBytes += backup.size;
          fs.rmSync(backup.path, { recursive: true, force: true });
          removed++;
        }
      }

      return {
        success: true,
        data: {
          removed,
          kept: backups.length - removed,
          freedSize: formatSize(freedBytes),
          policy: { keepDays, keepMin }
        }
      };
    } catch (error) {
      return { success: false, error: `Error en cleanup: ${error.message}` };
    }
  },

  /**
   * status — Estado del sistema de backups
   */
  async status() {
    try {
      if (!fs.existsSync(BACKUP_DIR)) {
        return {
          success: true,
          data: {
            totalBackups: 0,
            totalSize: '0 B',
            lastBackup: null,
            scopes: {},
            backupDir: BACKUP_DIR
          }
        };
      }

      const entries = fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory());

      const scopes = {};
      let totalBytes = 0;
      let lastBackup = null;
      let lastDate = '';

      for (const entry of entries) {
        const backupPath = path.join(BACKUP_DIR, entry.name);
        const metaPath = path.join(backupPath, '_backup.json');

        let meta = { scope: 'unknown', created: null };
        if (fs.existsSync(metaPath)) {
          try {
            meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          } catch (e) { /* fallback */ }
        }

        const size = dirSize(backupPath);
        totalBytes += size;

        const scope = meta.scope || 'unknown';
        if (!scopes[scope]) scopes[scope] = { count: 0, size: 0 };
        scopes[scope].count++;
        scopes[scope].size += size;

        const created = meta.created || '';
        if (created > lastDate) {
          lastDate = created;
          lastBackup = {
            backupId: meta.backupId || entry.name,
            scope,
            created,
            files: meta.files || 0,
            size: formatSize(size)
          };
        }
      }

      // Formatear tamaños de scopes
      for (const key of Object.keys(scopes)) {
        scopes[key].size = formatSize(scopes[key].size);
      }

      return {
        success: true,
        data: {
          totalBackups: entries.length,
          totalSize: formatSize(totalBytes),
          lastBackup,
          scopes,
          backupDir: BACKUP_DIR
        }
      };
    } catch (error) {
      return { success: false, error: `Error obteniendo status: ${error.message}` };
    }
  }
};
