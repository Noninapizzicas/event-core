/**
 * Local Handler-Generator Service
 *
 * Genera handlers JavaScript siguiendo los patrones reales del sistema.
 * Soporta handlers globales (handlers/) y por proyecto (data/projects/{id}/handlers/).
 *
 * Convenciones aplicadas (de contexto/handlers.json y handlers reales):
 * - SIEMPRE: const data = event.data || event; (envelope pattern)
 * - Context destructuring: { services, logger, emit, config, store, projectId }
 * - Helpers fuera de module.exports
 * - Nombres kebab-case
 * - _extraTriggers para múltiples eventos
 *
 * Eventos:
 * - local.handler-generator.generate.request -> local.handler-generator.generate.response
 * - local.handler-generator.list.request -> local.handler-generator.list.response
 * - local.handler-generator.archive.request -> local.handler-generator.archive.response
 * - local.handler-generator.restore.request -> local.handler-generator.restore.response
 *
 * @version 1.0.0
 * @created 2026-02-05
 */

const fs = require('fs');
const path = require('path');

const BASE_DIR = path.resolve('.');
const GLOBAL_HANDLERS_DIR = path.join(BASE_DIR, 'handlers');
const PROJECTS_DIR = path.join(BASE_DIR, 'data/projects');

module.exports = {
  name: 'local.handler-generator',
  description: 'Generador de handlers JavaScript con patrones del sistema',

  functions: {
    'generate': {
      event: 'local.handler-generator.generate.request',
      description: 'Genera un handler JavaScript completo en el directorio correcto',
      input: {
        name: {
          type: 'string',
          description: 'Nombre del handler en kebab-case (ej: procesar-pedido, enviar-reporte)',
          required: true
        },
        description: {
          type: 'string',
          description: 'Descripción del handler',
          required: true
        },
        trigger: {
          type: 'string',
          description: 'Evento que dispara el handler (ej: bot.command.received, chat.send.request)',
          required: true
        },
        projectId: {
          type: 'string',
          description: 'ID del proyecto (si omitido, se crea como handler global en handlers/)'
        },
        filter: {
          type: 'object',
          description: 'Condición de filtro: { field, operator, value } (ej: { field: "command", operator: "equals", value: "start" })'
        },
        extraTriggers: {
          type: 'array',
          description: 'Eventos adicionales que también disparan este handler'
        },
        services: {
          type: 'array',
          description: 'Servicios que usará: [{ service, action, description }] — genera llamadas de ejemplo'
        },
        emits: {
          type: 'array',
          description: 'Eventos que emitirá: [{ event, description }]'
        },
        usesConfig: {
          type: 'boolean',
          description: 'Si usa config del proyecto',
          default: false
        },
        usesStore: {
          type: 'boolean',
          description: 'Si usa store persistente',
          default: false
        },
        enabled: {
          type: 'boolean',
          description: 'Si el handler empieza habilitado',
          default: true
        }
      },
      output: {
        created: { type: 'boolean', description: 'Si se creó correctamente' },
        path: { type: 'string', description: 'Ruta del handler creado' },
        trigger: { type: 'string', description: 'Evento trigger' }
      }
    },
    'list': {
      event: 'local.handler-generator.list.request',
      description: 'Lista handlers por proyecto o globales, con estado activo/archivado',
      input: {
        projectId: {
          type: 'string',
          description: 'ID del proyecto (omitir para handlers globales)'
        }
      },
      output: {
        handlers: { type: 'array', description: 'Lista de handlers' },
        count: { type: 'number', description: 'Total' }
      }
    },
    'archive': {
      event: 'local.handler-generator.archive.request',
      description: 'Mueve un handler a la carpeta archived/',
      input: {
        name: { type: 'string', description: 'Nombre del handler (sin .js)', required: true },
        projectId: { type: 'string', description: 'ID del proyecto (omitir para global)' }
      },
      output: {
        archived: { type: 'boolean', description: 'Si se archivó' },
        from: { type: 'string', description: 'Ruta original' },
        to: { type: 'string', description: 'Ruta en archived/' }
      }
    },
    'restore': {
      event: 'local.handler-generator.restore.request',
      description: 'Restaura un handler desde archived/ al directorio activo',
      input: {
        name: { type: 'string', description: 'Nombre del handler (sin .js)', required: true },
        projectId: { type: 'string', description: 'ID del proyecto (omitir para global)' }
      },
      output: {
        restored: { type: 'boolean', description: 'Si se restauró' },
        from: { type: 'string', description: 'Ruta en archived/' },
        to: { type: 'string', description: 'Ruta restaurada' }
      }
    }
  },

  // ============================================================
  // GENERATE
  // ============================================================
  async 'generate'({ name, description, trigger, projectId, filter, extraTriggers, services: svcCalls, emits, usesConfig = false, usesStore = false, enabled = true } = {}) {
    // Validación
    if (!name) return { success: false, error: 'Parámetro "name" es requerido', data: { created: false } };
    if (!trigger) return { success: false, error: 'Parámetro "trigger" es requerido', data: { created: false } };
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return { success: false, error: 'name debe ser kebab-case', data: { created: false } };

    const handlersDir = this._resolveHandlersDir(projectId);
    if (!fs.existsSync(handlersDir)) {
      await fs.promises.mkdir(handlersDir, { recursive: true });
    }

    const filePath = path.join(handlersDir, `${name}.js`);
    if (fs.existsSync(filePath)) {
      return { success: false, error: `Handler '${name}.js' ya existe en ${handlersDir}`, data: { created: false } };
    }

    try {
      const code = this._generateCode({
        name, description: description || `Handler ${name}`, trigger, filter,
        extraTriggers, svcCalls, emits, usesConfig, usesStore, enabled, projectId
      });

      await fs.promises.writeFile(filePath, code, 'utf8');

      return {
        success: true,
        data: {
          created: true,
          path: filePath,
          trigger,
          extraTriggers: extraTriggers || [],
          scope: projectId ? `project:${projectId}` : 'global'
        }
      };
    } catch (error) {
      return { success: false, error: `Error generando handler: ${error.message}`, data: { created: false } };
    }
  },

  // ============================================================
  // LIST
  // ============================================================
  async 'list'({ projectId } = {}) {
    try {
      const handlersDir = this._resolveHandlersDir(projectId);
      if (!fs.existsSync(handlersDir)) {
        return { success: true, data: { handlers: [], count: 0 } };
      }

      const handlers = [];

      // Activos
      const entries = await fs.promises.readdir(handlersDir);
      for (const file of entries) {
        if (!file.endsWith('.js') || file.startsWith('_')) continue;
        const filePath = path.join(handlersDir, file);
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) continue;

        const info = await this._extractHandlerInfo(filePath);
        handlers.push({
          ...info,
          file,
          status: 'active',
          size: stat.size,
          modified: stat.mtime.toISOString()
        });
      }

      // Archivados
      const archivedDir = path.join(handlersDir, 'archived');
      if (fs.existsSync(archivedDir)) {
        const archivedEntries = await fs.promises.readdir(archivedDir);
        for (const file of archivedEntries) {
          if (!file.endsWith('.js')) continue;
          const filePath = path.join(archivedDir, file);
          const stat = await fs.promises.stat(filePath);
          if (!stat.isFile()) continue;

          const info = await this._extractHandlerInfo(filePath);
          handlers.push({
            ...info,
            file,
            status: 'archived',
            size: stat.size,
            modified: stat.mtime.toISOString()
          });
        }
      }

      return {
        success: true,
        data: {
          handlers,
          count: handlers.length,
          active: handlers.filter(h => h.status === 'active').length,
          archived: handlers.filter(h => h.status === 'archived').length,
          scope: projectId ? `project:${projectId}` : 'global'
        }
      };
    } catch (error) {
      return { success: false, error: `Error listando handlers: ${error.message}`, data: { handlers: [], count: 0 } };
    }
  },

  // ============================================================
  // ARCHIVE
  // ============================================================
  async 'archive'({ name, projectId } = {}) {
    if (!name) return { success: false, error: 'Parámetro "name" es requerido', data: { archived: false } };

    const handlersDir = this._resolveHandlersDir(projectId);
    const fileName = name.endsWith('.js') ? name : `${name}.js`;
    const fromPath = path.join(handlersDir, fileName);

    if (!fs.existsSync(fromPath)) {
      return { success: false, error: `Handler '${fileName}' no encontrado en ${handlersDir}`, data: { archived: false } };
    }

    try {
      const archivedDir = path.join(handlersDir, 'archived');
      await fs.promises.mkdir(archivedDir, { recursive: true });

      const toPath = path.join(archivedDir, fileName);
      await fs.promises.rename(fromPath, toPath);

      return {
        success: true,
        data: { archived: true, from: fromPath, to: toPath }
      };
    } catch (error) {
      return { success: false, error: `Error archivando: ${error.message}`, data: { archived: false } };
    }
  },

  // ============================================================
  // RESTORE
  // ============================================================
  async 'restore'({ name, projectId } = {}) {
    if (!name) return { success: false, error: 'Parámetro "name" es requerido', data: { restored: false } };

    const handlersDir = this._resolveHandlersDir(projectId);
    const fileName = name.endsWith('.js') ? name : `${name}.js`;
    const archivedDir = path.join(handlersDir, 'archived');
    const fromPath = path.join(archivedDir, fileName);

    if (!fs.existsSync(fromPath)) {
      return { success: false, error: `Handler '${fileName}' no encontrado en archived/`, data: { restored: false } };
    }

    try {
      const toPath = path.join(handlersDir, fileName);
      if (fs.existsSync(toPath)) {
        return { success: false, error: `Handler '${fileName}' ya existe como activo — archivar o eliminar primero`, data: { restored: false } };
      }

      await fs.promises.rename(fromPath, toPath);

      return {
        success: true,
        data: { restored: true, from: fromPath, to: toPath }
      };
    } catch (error) {
      return { success: false, error: `Error restaurando: ${error.message}`, data: { restored: false } };
    }
  },

  // ============================================================
  // CODE GENERATION
  // ============================================================
  _generateCode({ name, description, trigger, filter, extraTriggers, svcCalls, emits, usesConfig, usesStore, enabled, projectId }) {
    const lines = [];
    const timestamp = new Date().toISOString().split('T')[0];

    // Context params que se usarán
    const ctxParams = ['services', 'logger', 'emit'];
    if (usesConfig) ctxParams.push('config');
    if (usesStore) ctxParams.push('store');
    ctxParams.push('projectId');

    // --- Header ---
    lines.push('/**');
    lines.push(` * ${description}`);
    lines.push(' *');
    lines.push(` * Trigger: ${trigger}`);
    if (extraTriggers?.length) {
      lines.push(` * Extra triggers: ${extraTriggers.join(', ')}`);
    }
    if (emits?.length) {
      lines.push(' * Emite:');
      for (const e of emits) {
        lines.push(` *   - ${e.event}${e.description ? ` — ${e.description}` : ''}`);
      }
    }
    lines.push(` * Scope: ${projectId ? `project:${projectId}` : 'global'}`);
    lines.push(` * Generado por local.handler-generator el ${timestamp}`);
    lines.push(' */');
    lines.push('');

    // --- Module exports ---
    lines.push('module.exports = {');
    lines.push(`  name: '${name}',`);
    lines.push(`  description: '${this._escapeQuotes(description)}',`);
    lines.push(`  trigger: '${trigger}',`);
    lines.push(`  enabled: ${enabled},`);

    // --- Filter ---
    lines.push('');
    if (filter && filter.field) {
      const { field, operator, value } = filter;
      lines.push('  filter(event) {');
      lines.push('    const data = event.data || event;');
      switch (operator) {
        case 'equals':
          lines.push(`    return data.${field} === ${JSON.stringify(value)};`);
          break;
        case 'startsWith':
          lines.push(`    return (data.${field} || '').startsWith(${JSON.stringify(value)});`);
          break;
        case 'includes':
          lines.push(`    return (data.${field} || '').includes(${JSON.stringify(value)});`);
          break;
        case 'exists':
          lines.push(`    return !!data.${field};`);
          break;
        default:
          lines.push(`    return data.${field} === ${JSON.stringify(value)};`);
      }
      lines.push('  },');
    } else {
      lines.push('  // Sin filtro — se ejecuta para todo evento del trigger');
      lines.push('  // filter(event) {');
      lines.push('  //   const data = event.data || event;');
      lines.push('  //   return data.someField === "value";');
      lines.push('  // },');
    }

    // --- Handle ---
    lines.push('');
    lines.push(`  async handle(event, { ${ctxParams.join(', ')} }) {`);
    lines.push('    const data = event.data || event;');
    lines.push('');
    lines.push(`    logger.info('${name}: procesando', { trigger: '${trigger}' });`);
    lines.push('');

    // Config access
    if (usesConfig) {
      lines.push('    // Acceder a config del proyecto (data/projects/{id}/config/*.json)');
      lines.push('    // const cfg = config?.config || {};');
      lines.push('');
    }

    // Store access
    if (usesStore) {
      lines.push('    // Store persistente — operaciones: get, set, delete, increment, has, keys, getAll, clear');
      lines.push(`    // await store.set('${name}:lastRun', new Date().toISOString());`);
      lines.push(`    // const lastRun = await store.get('${name}:lastRun');`);
      lines.push('');
    }

    // Service calls
    if (svcCalls?.length) {
      lines.push('    try {');
      for (let i = 0; i < svcCalls.length; i++) {
        const svc = svcCalls[i];
        const varName = `result${svcCalls.length > 1 ? i + 1 : ''}`;
        lines.push(`      // ${svc.description || `Llamar ${svc.service}.${svc.action}`}`);
        lines.push(`      const ${varName} = await services.call('${svc.service}', '${svc.action}', {`);
        lines.push('        // TODO: parámetros');
        lines.push('      });');
        lines.push(`      const d${svcCalls.length > 1 ? i + 1 : ''} = ${varName}.data || ${varName};`);
        lines.push('');
      }
    } else {
      lines.push('    try {');
      lines.push('      // TODO: implementar lógica');
      lines.push('');
    }

    // Emit events
    if (emits?.length) {
      for (const e of emits) {
        lines.push(`      // ${e.description || `Emitir ${e.event}`}`);
        lines.push(`      emit('${e.event}', {`);
        lines.push('        // TODO: datos del evento');
        lines.push('      });');
        lines.push('');
      }
    }

    lines.push(`      logger.info('${name}: completado');`);
    lines.push('');
    lines.push('    } catch (error) {');
    lines.push(`      logger.error('${name}: error', { error: error.message });`);

    // Emit error event if handler emits lifecycle events
    if (emits?.length) {
      lines.push(`      emit('${name.replace(/-/g, '.')}.error', { error: error.message });`);
    }

    lines.push('    }');
    lines.push('  }');
    lines.push('};');

    // --- Extra triggers ---
    if (extraTriggers?.length) {
      lines.push('');
      lines.push(`module.exports._extraTriggers = ${JSON.stringify(extraTriggers)};`);
    }

    return lines.join('\n');
  },

  // ============================================================
  // HELPERS
  // ============================================================

  _resolveHandlersDir(projectId) {
    if (projectId) {
      return path.join(PROJECTS_DIR, projectId, 'handlers');
    }
    return GLOBAL_HANDLERS_DIR;
  },

  async _extractHandlerInfo(filePath) {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      const info = {
        name: '',
        description: '',
        trigger: '',
        enabled: true,
        hasFilter: false,
        extraTriggers: []
      };

      const nameMatch = content.match(/name:\s*['"]([^'"]+)['"]/);
      if (nameMatch) info.name = nameMatch[1];

      const descMatch = content.match(/description:\s*['"]([^'"]+)['"]/);
      if (descMatch) info.description = descMatch[1];

      const triggerMatch = content.match(/trigger:\s*['"]([^'"]+)['"]/);
      if (triggerMatch) info.trigger = triggerMatch[1];

      const enabledMatch = content.match(/enabled:\s*(true|false)/);
      if (enabledMatch) info.enabled = enabledMatch[1] === 'true';

      info.hasFilter = /filter\s*[:(]/.test(content);

      const extraMatch = content.match(/_extraTriggers\s*=\s*(\[.+?\])/s);
      if (extraMatch) {
        try { info.extraTriggers = JSON.parse(extraMatch[1]); } catch (_) {}
      }

      return info;
    } catch (e) {
      return { name: path.basename(filePath, '.js'), error: e.message };
    }
  },

  _escapeQuotes(str) {
    return (str || '').replace(/'/g, "\\'");
  }
};
