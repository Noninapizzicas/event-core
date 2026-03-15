/**
 * Local Context-Sync Service
 *
 * Auditor del sistema: compara contexto/ (fuente de verdad) contra código real.
 * Si el código no se ajusta al contexto, el código es el problema.
 *
 * Filosofía:
 *   contexto/ = lo que el sistema DEBE ser
 *   código    = lo que el sistema ES
 *   delta     = lo que hay que corregir en el CÓDIGO
 *
 * Eventos:
 * - local.context-sync.audit.request -> local.context-sync.audit.response
 * - local.context-sync.audit-providers.request -> local.context-sync.audit-providers.response
 * - local.context-sync.audit-modules.request -> local.context-sync.audit-modules.response
 * - local.context-sync.fix-manifests.request -> local.context-sync.fix-manifests.response
 * - local.context-sync.report.request -> local.context-sync.report.response
 *
 * @version 1.0.0
 * @created 2026-02-05
 */

const fs = require('fs');
const path = require('path');

const BASE_DIR = path.resolve('.');
const CONTEXTO_DIR = path.join(BASE_DIR, 'contexto');
const PROVIDERS_LOCAL_DIR = path.join(BASE_DIR, 'services/providers/local');
const PROVIDERS_CLOUD_DIR = path.join(BASE_DIR, 'services/providers');
const MODULES_DIR = path.join(BASE_DIR, 'modules');
const CATALOGO_PATH = path.join(CONTEXTO_DIR, 'catalogo-servicios.json');
const MODULES_CTX_PATH = path.join(CONTEXTO_DIR, 'modules.json');
const SERVICES_CTX_PATH = path.join(CONTEXTO_DIR, 'services.json');

module.exports = {
  name: 'local.context-sync',
  description: 'Auditor del sistema — compara contexto (fuente de verdad) contra código real',

  functions: {
    'audit': {
      event: 'local.context-sync.audit.request',
      description: 'Auditoría completa: providers + módulos + handlers + contexto',
      input: {},
      output: {
        providers: { type: 'object', description: 'Resultado audit de providers' },
        modules: { type: 'object', description: 'Resultado audit de módulos' },
        summary: { type: 'object', description: 'Resumen de issues' }
      }
    },
    'audit-providers': {
      event: 'local.context-sync.audit-providers.request',
      description: 'Audita providers: contexto vs código real',
      input: {},
      output: {
        documented: { type: 'array', description: 'Providers en contexto' },
        existing: { type: 'array', description: 'Providers en código' },
        issues: { type: 'array', description: 'Discrepancias encontradas' }
      }
    },
    'audit-modules': {
      event: 'local.context-sync.audit-modules.request',
      description: 'Audita módulos: contexto vs código real',
      input: {},
      output: {
        documented: { type: 'array', description: 'Módulos en contexto' },
        existing: { type: 'array', description: 'Módulos en código' },
        issues: { type: 'array', description: 'Discrepancias encontradas' }
      }
    },
    'fix-manifests': {
      event: 'local.context-sync.fix-manifests.request',
      description: 'Genera manifest.json faltantes para providers documentados en contexto',
      input: {
        dryRun: {
          type: 'boolean',
          description: 'Si true, solo reporta sin crear archivos',
          default: false
        }
      },
      output: {
        fixed: { type: 'array', description: 'Manifests generados' },
        skipped: { type: 'array', description: 'Providers que no se pudieron corregir' }
      }
    },
    'report': {
      event: 'local.context-sync.report.request',
      description: 'Genera reporte legible del estado de sincronización',
      input: {},
      output: {
        report: { type: 'string', description: 'Reporte en texto plano' },
        score: { type: 'number', description: 'Puntuación de sincronización 0-100' },
        issues: { type: 'number', description: 'Total de issues' }
      }
    }
  },

  // ============================================================
  // AUDIT - Auditoría completa
  // ============================================================
  async 'audit'() {
    try {
      const providers = await this['audit-providers']();
      const modules = await this['audit-modules']();

      const providerIssues = providers.success ? providers.data.issues.length : 0;
      const moduleIssues = modules.success ? modules.data.issues.length : 0;
      const totalIssues = providerIssues + moduleIssues;

      return {
        success: true,
        data: {
          providers: providers.data,
          modules: modules.data,
          summary: {
            totalIssues,
            providerIssues,
            moduleIssues,
            status: totalIssues === 0 ? 'SYNC' : totalIssues <= 5 ? 'MINOR_DRIFT' : 'NEEDS_ATTENTION'
          }
        }
      };
    } catch (error) {
      return { success: false, error: `Audit failed: ${error.message}`, data: {} };
    }
  },

  // ============================================================
  // AUDIT-PROVIDERS - Contexto vs providers reales
  // ============================================================
  async 'audit-providers'() {
    try {
      const issues = [];

      // 1. Leer fuente de verdad: catalogo-servicios.json
      const catalog = this._readJson(CATALOGO_PATH);
      if (!catalog) {
        return { success: false, error: 'No se pudo leer catalogo-servicios.json', data: { issues: [] } };
      }

      const docLocal = catalog.service_providers?.local || {};
      const docCloud = catalog.service_providers?.cloud || {};

      // 2. Escanear providers reales
      const existingLocal = this._scanLocalProviders();
      const existingCloud = this._scanCloudProviders();

      const documented = [];
      const existing = [];

      // --- LOCAL PROVIDERS ---
      // a) Documentados en contexto → deben existir en código
      for (const [provName, provInfo] of Object.entries(docLocal)) {
        const cleanName = provName.replace(/^local\./, '');
        documented.push({ name: provName, type: 'local', functions: provInfo.funciones || [] });

        const real = existingLocal.find(p => p.name === cleanName);
        if (!real) {
          issues.push({
            severity: 'ERROR',
            type: 'MISSING_CODE',
            provider: provName,
            message: `Provider '${provName}' documentado en contexto pero NO existe en services/providers/local/${cleanName}/`,
            action: `Crear services/providers/local/${cleanName}/ con index.js implementando: ${(provInfo.funciones || []).join(', ')}`
          });
          continue;
        }

        // Existe — verificar manifest.json
        if (!real.hasManifest) {
          issues.push({
            severity: 'WARNING',
            type: 'MISSING_MANIFEST',
            provider: provName,
            message: `Provider '${provName}' existe pero NO tiene manifest.json — loader puede ignorarlo`,
            action: `Generar manifest.json o ejecutar local.context-sync.fix-manifests`
          });
        }

        // Verificar funciones documentadas vs reales
        if (provInfo.funciones && real.functions.length > 0) {
          const docFns = Array.isArray(provInfo.funciones) ? provInfo.funciones : Object.keys(provInfo.funciones);
          for (const fn of docFns) {
            if (!real.functions.includes(fn)) {
              issues.push({
                severity: 'WARNING',
                type: 'MISSING_FUNCTION',
                provider: provName,
                message: `Función '${fn}' documentada en contexto pero NO implementada en código`,
                action: `Implementar función '${fn}' en services/providers/local/${cleanName}/index.js`
              });
            }
          }
        }
      }

      // b) Existentes en código → deben estar documentados en contexto
      for (const real of existingLocal) {
        existing.push({ name: `local.${real.name}`, type: 'local', functions: real.functions, hasManifest: real.hasManifest });

        const docKey = `local.${real.name}`;
        if (!docLocal[docKey]) {
          issues.push({
            severity: 'WARNING',
            type: 'UNDOCUMENTED',
            provider: docKey,
            message: `Provider '${docKey}' existe en código pero NO está documentado en contexto/catalogo-servicios.json`,
            action: `Añadir entrada para '${docKey}' en catalogo-servicios.json → service_providers.local`
          });
        }
      }

      // --- CLOUD PROVIDERS ---
      for (const [provName, provInfo] of Object.entries(docCloud)) {
        documented.push({ name: provName, type: 'cloud' });

        const real = existingCloud.find(p => p.name === provName);
        if (!real) {
          issues.push({
            severity: 'ERROR',
            type: 'MISSING_CODE',
            provider: provName,
            message: `Provider cloud '${provName}' documentado en contexto pero NO existe en services/providers/${provName}/`,
            action: `Crear services/providers/${provName}/ con provider.json y functions/`
          });
        }
      }

      return {
        success: true,
        data: { documented, existing, issues }
      };
    } catch (error) {
      return { success: false, error: `Audit providers failed: ${error.message}`, data: { issues: [] } };
    }
  },

  // ============================================================
  // AUDIT-MODULES - Contexto vs módulos reales
  // ============================================================
  async 'audit-modules'() {
    try {
      const issues = [];

      // 1. Leer fuente de verdad
      const catalog = this._readJson(CATALOGO_PATH);
      if (!catalog) {
        return { success: false, error: 'No se pudo leer catalogo-servicios.json', data: { issues: [] } };
      }

      // Extraer todos los módulos documentados (aplanar categorías)
      const docModules = {};
      const modCategories = catalog.modulos || {};
      for (const [category, modules] of Object.entries(modCategories)) {
        if (category.startsWith('_')) continue;
        for (const [modName, modInfo] of Object.entries(modules)) {
          // Saltar metadata (claves que empiezan con _) y entradas no-módulo
          if (modName.startsWith('_')) continue;
          if (typeof modInfo === 'string') continue; // ej: _nota: "texto"
          // 'handlers' en automatizacion describe el sistema de handlers, no un módulo en modules/
          if (category === 'automatizacion' && modName === 'handlers') continue;
          docModules[modName] = { ...modInfo, category };
        }
      }

      // 2. Escanear módulos reales
      const existingModules = this._scanModules();

      const documented = [];
      const existing = [];

      // a) Documentados → deben existir
      for (const [modName, modInfo] of Object.entries(docModules)) {
        documented.push({
          name: modName,
          category: modInfo.category,
          version: modInfo.version,
          deprecated: modInfo.estado === 'DEPRECADO'
        });

        // Saltar deprecados — no necesitan existir
        if (modInfo.estado === 'DEPRECADO') continue;

        const real = existingModules.find(m => m.name === modName);
        if (!real) {
          issues.push({
            severity: 'ERROR',
            type: 'MISSING_CODE',
            module: modName,
            category: modInfo.category,
            message: `Módulo '${modName}' documentado en contexto (${modInfo.category}) pero NO encontrado en modules/`,
            action: `Crear modules/${modName}/ con module.json + index.js, o actualizar contexto si fue eliminado`
          });
          continue;
        }

        // Verificar module.json
        if (!real.hasModuleJson) {
          issues.push({
            severity: 'WARNING',
            type: 'MISSING_MODULE_JSON',
            module: modName,
            message: `Módulo '${modName}' existe pero NO tiene module.json — loader puede tener problemas`,
            action: `Crear module.json en ${real.path}/`
          });
        }
      }

      // b) Existentes → deben estar documentados
      for (const real of existingModules) {
        existing.push({
          name: real.name,
          path: real.path,
          hasModuleJson: real.hasModuleJson
        });

        if (!docModules[real.name]) {
          issues.push({
            severity: 'WARNING',
            type: 'UNDOCUMENTED',
            module: real.name,
            message: `Módulo '${real.name}' existe en ${real.path} pero NO está documentado en contexto/catalogo-servicios.json`,
            action: `Añadir '${real.name}' a la categoría correspondiente en catalogo-servicios.json → modulos`
          });
        }
      }

      return {
        success: true,
        data: { documented, existing, issues }
      };
    } catch (error) {
      return { success: false, error: `Audit modules failed: ${error.message}`, data: { issues: [] } };
    }
  },

  // ============================================================
  // FIX-MANIFESTS - Generar manifests faltantes
  // ============================================================
  async 'fix-manifests'({ dryRun = false } = {}) {
    try {
      const fixed = [];
      const skipped = [];

      // Leer catálogo como referencia
      const catalog = this._readJson(CATALOGO_PATH);
      const docLocal = catalog?.service_providers?.local || {};

      // Escanear providers existentes sin manifest
      const existingLocal = this._scanLocalProviders();

      for (const provider of existingLocal) {
        if (provider.hasManifest) continue;

        const docKey = `local.${provider.name}`;
        const providerDir = path.join(PROVIDERS_LOCAL_DIR, provider.name);
        const manifestPath = path.join(providerDir, 'manifest.json');

        // Construir manifest desde index.js + contexto
        const indexPath = path.join(providerDir, 'index.js');
        const indexInfo = this._extractProviderInfo(indexPath);

        if (!indexInfo) {
          skipped.push({
            provider: docKey,
            reason: 'No se pudo extraer info de index.js'
          });
          continue;
        }

        const manifest = {
          $schema: '../../../schemas/provider-manifest.schema.json',
          name: docKey,
          version: '1.0.0',
          description: indexInfo.description || (docLocal[docKey]?.descripcion) || `Servicio local ${provider.name}`,
          type: 'provider',
          generatedBy: 'local.context-sync',
          generatedAt: new Date().toISOString(),
          requires: {
            credentials: [],
            npm: []
          },
          functions: {}
        };

        // Extraer funciones del index.js
        for (const fn of indexInfo.functions) {
          manifest.functions[fn.name] = {
            event: fn.event || `local.${provider.name}.${fn.name}.request`,
            description: fn.description || `Ejecutar ${fn.name}`
          };
        }

        if (dryRun) {
          fixed.push({
            provider: docKey,
            path: manifestPath,
            dryRun: true,
            manifest
          });
        } else {
          await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
          fixed.push({
            provider: docKey,
            path: manifestPath,
            created: true
          });
        }
      }

      return {
        success: true,
        data: { fixed, skipped }
      };
    } catch (error) {
      return { success: false, error: `Fix manifests failed: ${error.message}`, data: { fixed: [], skipped: [] } };
    }
  },

  // ============================================================
  // REPORT - Reporte legible
  // ============================================================
  async 'report'() {
    try {
      const audit = await this.audit();
      if (!audit.success) {
        return { success: false, error: audit.error, data: { report: '', score: 0, issues: 0 } };
      }

      const { providers, modules, summary } = audit.data;
      const lines = [];

      lines.push('╔══════════════════════════════════════════════╗');
      lines.push('║       CONTEXT-SYNC: REPORTE DE AUDITORÍA     ║');
      lines.push('╚══════════════════════════════════════════════╝');
      lines.push('');
      lines.push(`Estado: ${summary.status}`);
      lines.push(`Issues totales: ${summary.totalIssues}`);
      lines.push('');

      // --- Providers ---
      lines.push('─── PROVIDERS ───────────────────────────────');
      lines.push(`  Documentados en contexto: ${providers.documented.length}`);
      lines.push(`  Existentes en código:     ${providers.existing.length}`);
      lines.push(`  Issues:                   ${providers.issues.length}`);

      if (providers.issues.length > 0) {
        lines.push('');
        const byType = this._groupBy(providers.issues, 'type');
        for (const [type, items] of Object.entries(byType)) {
          lines.push(`  [${type}]`);
          for (const item of items) {
            const icon = item.severity === 'ERROR' ? 'X' : '!';
            lines.push(`    ${icon} ${item.provider}: ${item.message}`);
            lines.push(`      -> ${item.action}`);
          }
        }
      }

      lines.push('');

      // --- Modules ---
      lines.push('─── MODULES ─────────────────────────────────');
      lines.push(`  Documentados en contexto: ${modules.documented.length}`);
      lines.push(`  Existentes en código:     ${modules.existing.length}`);
      lines.push(`  Issues:                   ${modules.issues.length}`);

      if (modules.issues.length > 0) {
        lines.push('');
        const byType = this._groupBy(modules.issues, 'type');
        for (const [type, items] of Object.entries(byType)) {
          lines.push(`  [${type}]`);
          for (const item of items) {
            const icon = item.severity === 'ERROR' ? 'X' : '!';
            lines.push(`    ${icon} ${item.module}: ${item.message}`);
            lines.push(`      -> ${item.action}`);
          }
        }
      }

      lines.push('');
      lines.push('─── SCORE ───────────────────────────────────');

      // Calcular score: 100 menos penalización por issue
      const totalChecks = providers.documented.length + providers.existing.length +
                          modules.documented.length + modules.existing.length;
      const errorPenalty = 10;
      const warningPenalty = 3;
      const errors = [...providers.issues, ...modules.issues].filter(i => i.severity === 'ERROR').length;
      const warnings = [...providers.issues, ...modules.issues].filter(i => i.severity === 'WARNING').length;
      const penalty = (errors * errorPenalty) + (warnings * warningPenalty);
      const score = Math.max(0, Math.min(100, 100 - penalty));

      lines.push(`  Checks realizados: ${totalChecks}`);
      lines.push(`  Errores:           ${errors} (x${errorPenalty} pts)`);
      lines.push(`  Warnings:          ${warnings} (x${warningPenalty} pts)`);
      lines.push(`  Score:             ${score}/100`);
      lines.push('');

      if (summary.totalIssues === 0) {
        lines.push('  Contexto y código están sincronizados.');
      } else {
        lines.push('  Recuerda: contexto/ es la fuente de verdad.');
        lines.push('  Si el código no se ajusta, el código es el problema.');
      }

      const report = lines.join('\n');

      return {
        success: true,
        data: { report, score, issues: summary.totalIssues }
      };
    } catch (error) {
      return { success: false, error: `Report failed: ${error.message}`, data: { report: '', score: 0, issues: 0 } };
    }
  },

  // ============================================================
  // FUNCIONES INTERNAS
  // ============================================================

  /**
   * Leer JSON con manejo de error
   */
  _readJson(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      return null;
    }
  },

  /**
   * Escanear providers locales reales
   */
  _scanLocalProviders() {
    const providers = [];
    if (!fs.existsSync(PROVIDERS_LOCAL_DIR)) return providers;

    const entries = fs.readdirSync(PROVIDERS_LOCAL_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const name = entry.name;
      const dir = path.join(PROVIDERS_LOCAL_DIR, name);
      const indexPath = path.join(dir, 'index.js');
      const manifestPath = path.join(dir, 'manifest.json');

      if (!fs.existsSync(indexPath)) continue;

      const info = this._extractProviderInfo(indexPath);

      providers.push({
        name,
        hasManifest: fs.existsSync(manifestPath),
        hasIndex: true,
        functions: info ? info.functions.map(f => f.name) : [],
        description: info?.description || ''
      });
    }
    return providers;
  },

  /**
   * Escanear providers cloud reales
   */
  _scanCloudProviders() {
    const providers = [];
    if (!fs.existsSync(PROVIDERS_CLOUD_DIR)) return providers;

    const entries = fs.readdirSync(PROVIDERS_CLOUD_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'local') continue; // Skip local subdir

      const dir = path.join(PROVIDERS_CLOUD_DIR, entry.name);
      const manifestPath = path.join(dir, 'provider.json');

      if (!fs.existsSync(manifestPath)) continue;

      providers.push({
        name: entry.name,
        hasManifest: true
      });
    }
    return providers;
  },

  /**
   * Escanear módulos reales (recursivo para subdirectorios)
   */
  _scanModules() {
    const modules = [];
    if (!fs.existsSync(MODULES_DIR)) return modules;

    const scanDir = (dir, depth = 0) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;

        const modDir = path.join(dir, entry.name);
        const moduleJsonPath = path.join(modDir, 'module.json');
        const indexPath = path.join(modDir, 'index.js');

        if (fs.existsSync(moduleJsonPath) || fs.existsSync(indexPath)) {
          modules.push({
            name: entry.name,
            path: modDir,
            hasModuleJson: fs.existsSync(moduleJsonPath),
            hasIndex: fs.existsSync(indexPath)
          });
        } else if (depth < 2) {
          // Subdirectorio sin module.json — escanear hijos (ej: modules/pizzepos/)
          scanDir(modDir, depth + 1);
        }
      }
    };

    scanDir(MODULES_DIR);
    return modules;
  },

  /**
   * Extraer info de un provider leyendo su index.js
   */
  _extractProviderInfo(indexPath) {
    try {
      const content = fs.readFileSync(indexPath, 'utf8');

      let description = '';
      const descMatch = content.match(/description:\s*['"`]([^'"`]+)['"`]/);
      if (descMatch) description = descMatch[1];

      const functions = [];

      // Estrategia: extraer funciones desde las declaraciones event: 'provider.function.request'
      // Esto es robusto porque sigue el patrón de eventos del sistema
      const eventPattern = /event:\s*['"]([^'"]+\.request)['"]/g;
      const events = {};
      let match;
      while ((match = eventPattern.exec(content)) !== null) {
        const event = match[1];
        // Extraer nombre de función: local.backup-manager.create.request → create
        const parts = event.replace('.request', '').split('.');
        const fnName = parts[parts.length - 1];
        if (fnName && fnName !== 'request') {
          events[fnName] = event;
        }
      }

      // Extraer descriptions de funciones (buscar en bloque functions)
      const fnDescPattern = /['"]?([a-z][a-z0-9-]*)['"]?\s*:\s*\{[^}]*?description:\s*['"]([^'"]+)['"]/g;
      const fnDescs = {};
      while ((match = fnDescPattern.exec(content)) !== null) {
        const name = match[1];
        // Filtrar: solo si es un nombre de función real (no 'functions', 'input', 'output')
        if (name !== 'functions' && name !== 'input' && name !== 'output' && events[name]) {
          fnDescs[name] = match[2];
        }
      }

      // Construir lista de funciones
      for (const [name, event] of Object.entries(events)) {
        functions.push({
          name,
          event,
          description: fnDescs[name] || ''
        });
      }

      return { description, functions };
    } catch (e) {
      return null;
    }
  },

  /**
   * Agrupar array por propiedad
   */
  _groupBy(arr, key) {
    return arr.reduce((acc, item) => {
      const group = item[key];
      if (!acc[group]) acc[group] = [];
      acc[group].push(item);
      return acc;
    }, {});
  }
};
