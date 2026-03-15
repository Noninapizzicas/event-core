/**
 * Local Skills Service
 *
 * Generador automatizado de servicios locales (providers).
 * Crea providers completos con index.js, manifest.json y documentación en contexto.
 * No requiere credenciales externas.
 *
 * Eventos:
 * - local.skills.generate.request -> local.skills.generate.response
 * - local.skills.list.request -> local.skills.list.response
 * - local.skills.get.request -> local.skills.get.response
 * - local.skills.remove.request -> local.skills.remove.response
 * - local.skills.validate.request -> local.skills.validate.response
 *
 * @version 1.0.0
 * @created 2026-02-04
 */

const fs = require('fs');
const path = require('path');

const PROVIDERS_DIR = path.resolve('./services/providers/local');
const CONTEXTO_DIR = path.resolve('./contexto');
const CATALOGO_PATH = path.join(CONTEXTO_DIR, 'catalogo-servicios.json');

module.exports = {
  name: 'local.skills',
  description: 'Generador automatizado de servicios locales con documentación',

  functions: {
    generate: {
      event: 'local.skills.generate.request',
      description: 'Genera un nuevo servicio local completo (index.js + manifest.json + contexto)',
      input: {
        name: {
          type: 'string',
          description: 'Nombre del servicio en kebab-case (ej: text-analyzer, url-scraper)',
          required: true
        },
        description: {
          type: 'string',
          description: 'Descripción del servicio',
          required: true
        },
        functions: {
          type: 'array',
          description: 'Array de funciones: [{ name, description, params: [{ name, type, required, default, description }], output: [{ name, type, description }] }]',
          required: true
        },
        npmDependency: {
          type: 'string',
          description: 'Dependencia npm si requiere (ej: cheerio, marked)'
        },
        hasFileInput: {
          type: 'boolean',
          description: 'Si alguna función acepta archivos/base64 como input',
          default: false
        }
      },
      output: {
        created: { type: 'boolean', description: 'Si se creó correctamente' },
        path: { type: 'string', description: 'Ruta del provider creado' },
        files: { type: 'array', description: 'Archivos generados' },
        events: { type: 'array', description: 'Eventos registrados' },
        catalogUpdated: { type: 'boolean', description: 'Si se actualizó el catálogo' }
      }
    },
    list: {
      event: 'local.skills.list.request',
      description: 'Lista todos los servicios locales disponibles con sus funciones',
      input: {},
      output: {
        skills: { type: 'array', description: 'Array de servicios con name, description, functions' },
        count: { type: 'number', description: 'Total de servicios' }
      }
    },
    get: {
      event: 'local.skills.get.request',
      description: 'Obtiene detalles completos de un servicio local',
      input: {
        name: {
          type: 'string',
          description: 'Nombre del servicio (sin prefijo local.)',
          required: true
        }
      },
      output: {
        skill: { type: 'object', description: 'Definición completa del servicio' },
        files: { type: 'array', description: 'Archivos del servicio' },
        hasManifest: { type: 'boolean', description: 'Si tiene manifest.json' }
      }
    },
    remove: {
      event: 'local.skills.remove.request',
      description: 'Elimina un servicio local y su documentación',
      input: {
        name: {
          type: 'string',
          description: 'Nombre del servicio a eliminar',
          required: true
        }
      },
      output: {
        removed: { type: 'boolean', description: 'Si se eliminó correctamente' },
        filesRemoved: { type: 'array', description: 'Archivos eliminados' },
        catalogUpdated: { type: 'boolean', description: 'Si se actualizó el catálogo' }
      }
    },
    validate: {
      event: 'local.skills.validate.request',
      description: 'Valida una definición de skill antes de generarlo',
      input: {
        name: {
          type: 'string',
          description: 'Nombre del servicio',
          required: true
        },
        functions: {
          type: 'array',
          description: 'Array de funciones a validar',
          required: true
        }
      },
      output: {
        valid: { type: 'boolean', description: 'Si la definición es válida' },
        errors: { type: 'array', description: 'Errores encontrados' },
        warnings: { type: 'array', description: 'Advertencias' }
      }
    }
  },

  // ============================================================
  // GENERATE - Crear nuevo servicio local completo
  // ============================================================
  async generate({ name, description, functions: fnDefs, npmDependency, hasFileInput = false } = {}) {
    // --- Validación ---
    const validation = this._validateDefinition(name, fnDefs);
    if (!validation.valid) {
      return { success: false, error: `Definición inválida: ${validation.errors.join(', ')}`, data: { created: false } };
    }

    const providerDir = path.join(PROVIDERS_DIR, name);

    if (fs.existsSync(providerDir)) {
      return { success: false, error: `El servicio '${name}' ya existe en ${providerDir}`, data: { created: false } };
    }

    try {
      // 1. Crear directorio
      await fs.promises.mkdir(providerDir, { recursive: true });

      // 2. Generar index.js
      const indexContent = this._generateIndexJs(name, description, fnDefs, npmDependency, hasFileInput);
      const indexPath = path.join(providerDir, 'index.js');
      await fs.promises.writeFile(indexPath, indexContent, 'utf8');

      // 3. Generar manifest.json
      const manifestContent = this._generateManifest(name, description, fnDefs, npmDependency);
      const manifestPath = path.join(providerDir, 'manifest.json');
      await fs.promises.writeFile(manifestPath, JSON.stringify(manifestContent, null, 2), 'utf8');

      // 4. Actualizar catálogo de servicios
      const catalogUpdated = this._updateCatalog(name, description, fnDefs);

      // 5. Construir lista de eventos
      const events = fnDefs.map(fn => ({
        request: `local.${name}.${fn.name}.request`,
        response: `local.${name}.${fn.name}.response`
      }));

      return {
        success: true,
        data: {
          created: true,
          path: providerDir,
          files: [indexPath, manifestPath],
          events,
          catalogUpdated,
          nextSteps: [
            npmDependency ? `npm install ${npmDependency}` : null,
            'Reiniciar Event-Core para auto-discovery',
            'El servicio estará disponible como AI tool automáticamente'
          ].filter(Boolean)
        }
      };
    } catch (error) {
      // Limpiar si falló a medias
      try { await fs.promises.rm(providerDir, { recursive: true, force: true }); } catch (_) {}
      return { success: false, error: `Error generando servicio: ${error.message}`, data: { created: false } };
    }
  },

  // ============================================================
  // LIST - Listar todos los servicios locales
  // ============================================================
  async list() {
    try {
      const entries = await fs.promises.readdir(PROVIDERS_DIR, { withFileTypes: true });
      const skills = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const serviceName = entry.name;
        const indexPath = path.join(PROVIDERS_DIR, serviceName, 'index.js');

        if (!fs.existsSync(indexPath)) continue;

        try {
          // Leer sin require para no cachear
          const content = await fs.promises.readFile(indexPath, 'utf8');
          const info = this._extractInfoFromSource(content, serviceName);
          skills.push(info);
        } catch (e) {
          skills.push({
            name: `local.${serviceName}`,
            description: '(error leyendo)',
            functions: [],
            error: e.message
          });
        }
      }

      return {
        success: true,
        data: {
          skills,
          count: skills.length
        }
      };
    } catch (error) {
      return { success: false, error: `Error listando servicios: ${error.message}`, data: { skills: [], count: 0 } };
    }
  },

  // ============================================================
  // GET - Obtener detalles de un servicio
  // ============================================================
  async get({ name } = {}) {
    if (!name) {
      return { success: false, error: 'Parámetro "name" es requerido', data: { skill: null } };
    }

    // Normalizar: quitar prefijo 'local.' si lo trae
    const cleanName = name.replace(/^local\./, '');
    const providerDir = path.join(PROVIDERS_DIR, cleanName);

    if (!fs.existsSync(providerDir)) {
      return { success: false, error: `Servicio '${cleanName}' no encontrado`, data: { skill: null } };
    }

    try {
      const indexPath = path.join(providerDir, 'index.js');
      const manifestPath = path.join(providerDir, 'manifest.json');

      const files = [];
      const dirEntries = await fs.promises.readdir(providerDir);
      for (const f of dirEntries) {
        const stat = await fs.promises.stat(path.join(providerDir, f));
        files.push({ name: f, size: stat.size });
      }

      // Leer index.js
      const indexContent = await fs.promises.readFile(indexPath, 'utf8');
      const info = this._extractInfoFromSource(indexContent, cleanName);

      // Leer manifest si existe
      let manifest = null;
      const hasManifest = fs.existsSync(manifestPath);
      if (hasManifest) {
        manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      }

      return {
        success: true,
        data: {
          skill: {
            ...info,
            manifest,
            path: providerDir
          },
          files,
          hasManifest
        }
      };
    } catch (error) {
      return { success: false, error: `Error leyendo servicio: ${error.message}`, data: { skill: null } };
    }
  },

  // ============================================================
  // REMOVE - Eliminar un servicio
  // ============================================================
  async remove({ name } = {}) {
    if (!name) {
      return { success: false, error: 'Parámetro "name" es requerido', data: { removed: false } };
    }

    const cleanName = name.replace(/^local\./, '');

    // Proteger servicios del sistema
    const protectedServices = ['skills', 'context-sync', 'handler-generator', 'backup-manager', 'learning', 'sharp', 'tesseract', 'csv', 'pdf', 'gmail'];
    if (protectedServices.includes(cleanName)) {
      return { success: false, error: `El servicio '${cleanName}' está protegido y no puede eliminarse`, data: { removed: false } };
    }

    const providerDir = path.join(PROVIDERS_DIR, cleanName);

    if (!fs.existsSync(providerDir)) {
      return { success: false, error: `Servicio '${cleanName}' no encontrado`, data: { removed: false } };
    }

    try {
      // Listar archivos antes de eliminar
      const dirEntries = await fs.promises.readdir(providerDir);
      const filesRemoved = dirEntries.map(f => path.join(providerDir, f));

      // Eliminar directorio
      await fs.promises.rm(providerDir, { recursive: true, force: true });

      // Actualizar catálogo
      const catalogUpdated = this._removefromCatalog(cleanName);

      return {
        success: true,
        data: {
          removed: true,
          filesRemoved,
          catalogUpdated
        }
      };
    } catch (error) {
      return { success: false, error: `Error eliminando servicio: ${error.message}`, data: { removed: false } };
    }
  },

  // ============================================================
  // VALIDATE - Validar definición antes de generar
  // ============================================================
  async validate({ name, functions: fnDefs } = {}) {
    const validation = this._validateDefinition(name, fnDefs);
    return {
      success: true,
      data: validation
    };
  },

  // ============================================================
  // FUNCIONES INTERNAS
  // ============================================================

  /**
   * Validar definición de skill
   */
  _validateDefinition(name, fnDefs) {
    const errors = [];
    const warnings = [];

    // Validar nombre
    if (!name) {
      errors.push('name es requerido');
    } else if (typeof name !== 'string') {
      errors.push('name debe ser string');
    } else {
      if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        errors.push('name debe ser kebab-case (ej: text-analyzer, url-scraper)');
      }
      if (name.length < 2) {
        errors.push('name debe tener al menos 2 caracteres');
      }
      if (name.length > 40) {
        errors.push('name no puede superar 40 caracteres');
      }
    }

    // Validar funciones
    if (!fnDefs) {
      errors.push('functions es requerido');
    } else if (!Array.isArray(fnDefs)) {
      errors.push('functions debe ser un array');
    } else if (fnDefs.length === 0) {
      errors.push('functions debe tener al menos una función');
    } else {
      const fnNames = new Set();
      for (let i = 0; i < fnDefs.length; i++) {
        const fn = fnDefs[i];
        const prefix = `functions[${i}]`;

        if (!fn.name) {
          errors.push(`${prefix}.name es requerido`);
        } else {
          if (!/^[a-z][a-z0-9-]*$/.test(fn.name)) {
            errors.push(`${prefix}.name '${fn.name}' debe ser kebab-case`);
          }
          if (fnNames.has(fn.name)) {
            errors.push(`${prefix}.name '${fn.name}' está duplicado`);
          }
          fnNames.add(fn.name);
        }

        if (!fn.description) {
          warnings.push(`${prefix}.description no definida — se generará automáticamente`);
        }

        // Validar params
        if (fn.params && Array.isArray(fn.params)) {
          for (let j = 0; j < fn.params.length; j++) {
            const p = fn.params[j];
            if (!p.name) errors.push(`${prefix}.params[${j}].name es requerido`);
            if (!p.type) warnings.push(`${prefix}.params[${j}].type no definido — se usará 'string'`);
          }
        }

        // Validar output
        if (fn.output && Array.isArray(fn.output)) {
          for (let j = 0; j < fn.output.length; j++) {
            const o = fn.output[j];
            if (!o.name) errors.push(`${prefix}.output[${j}].name es requerido`);
          }
        } else {
          warnings.push(`${prefix}.output no definido — se generará 'result: string'`);
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  },

  /**
   * Generar código index.js del provider
   */
  _generateIndexJs(name, description, fnDefs, npmDependency, hasFileInput) {
    const lines = [];
    const timestamp = new Date().toISOString().split('T')[0];

    // --- Header ---
    lines.push('/**');
    lines.push(` * Local ${this._pascalCase(name)} Service`);
    lines.push(' *');
    lines.push(` * ${description}`);
    lines.push(' * No requiere credenciales externas.');
    lines.push(' *');
    lines.push(' * Eventos:');
    for (const fn of fnDefs) {
      lines.push(` * - local.${name}.${fn.name}.request -> local.${name}.${fn.name}.response`);
    }
    lines.push(' *');
    lines.push(` * Generado automáticamente por local.skills el ${timestamp}`);
    lines.push(' *');
    lines.push(' * @version 1.0.0');
    lines.push(` * @created ${timestamp}`);
    lines.push(' */');
    lines.push('');
    lines.push("const fs = require('fs');");
    lines.push("const path = require('path');");
    lines.push('');

    // --- Lazy load npm dependency ---
    if (npmDependency) {
      const camelDep = this._camelCase(npmDependency);
      lines.push(`// Lazy load ${npmDependency}`);
      lines.push(`let ${camelDep} = null;`);
      lines.push('');
      lines.push(`const load${this._pascalCase(npmDependency)} = () => {`);
      lines.push(`  if (!${camelDep}) {`);
      lines.push('    try {');
      lines.push(`      ${camelDep} = require('${npmDependency}');`);
      lines.push('    } catch (e) {');
      lines.push(`      throw new Error('${npmDependency} not installed. Run: npm install ${npmDependency}');`);
      lines.push('    }');
      lines.push('  }');
      lines.push(`  return ${camelDep};`);
      lines.push('};');
      lines.push('');
    }

    // --- Module exports ---
    lines.push('module.exports = {');
    lines.push(`  name: 'local.${name}',`);
    lines.push(`  description: '${this._escapeQuotes(description)}',`);
    lines.push('');

    // --- Functions definition ---
    lines.push('  functions: {');
    for (let i = 0; i < fnDefs.length; i++) {
      const fn = fnDefs[i];
      const params = fn.params || [{ name: 'input', type: 'string', required: true, description: 'Entrada principal' }];
      const output = fn.output || [{ name: 'result', type: 'string', description: 'Resultado' }];
      const fnDesc = fn.description || `Ejecutar ${fn.name}`;

      lines.push(`    '${fn.name}': {`);
      lines.push(`      event: 'local.${name}.${fn.name}.request',`);
      lines.push(`      description: '${this._escapeQuotes(fnDesc)}',`);
      lines.push('      input: {');
      for (let j = 0; j < params.length; j++) {
        const p = params[j];
        const pType = p.type || 'string';
        const pDesc = p.description || p.name;
        lines.push(`        ${p.name}: {`);
        lines.push(`          type: '${pType}',`);
        lines.push(`          description: '${this._escapeQuotes(pDesc)}'`);
        if (p.required) lines[lines.length - 1] = lines[lines.length - 1].replace('}', ", required: true }");
        if (p.default !== undefined) lines[lines.length - 1] = lines[lines.length - 1].replace('}', `, default: ${JSON.stringify(p.default)} }`);
        lines.push(`        }${j < params.length - 1 ? ',' : ''}`);
      }
      lines.push('      },');
      lines.push('      output: {');
      for (let j = 0; j < output.length; j++) {
        const o = output[j];
        const oType = o.type || 'string';
        const oDesc = o.description || o.name;
        lines.push(`        ${o.name}: { type: '${oType}', description: '${this._escapeQuotes(oDesc)}' }${j < output.length - 1 ? ',' : ''}`);
      }
      lines.push('      }');
      lines.push(`    }${i < fnDefs.length - 1 ? ',' : ''}`);
    }
    lines.push('  },');
    lines.push('');

    // --- File input helpers ---
    if (hasFileInput) {
      lines.push('  /**');
      lines.push('   * Detectar si el string es base64 por magic bytes');
      lines.push('   */');
      lines.push('  isBase64(str) {');
      lines.push("    if (!str || typeof str !== 'string') return false;");
      lines.push('    const magicPrefixes = [');
      lines.push("      '/9j/',     // JPEG");
      lines.push("      'iVBORw',   // PNG");
      lines.push("      'R0lGOD',   // GIF");
      lines.push("      'UklGR',    // WebP");
      lines.push("      'JVBERi'    // PDF");
      lines.push('    ];');
      lines.push('    return magicPrefixes.some(p => str.startsWith(p));');
      lines.push('  },');
      lines.push('');
      lines.push('  /**');
      lines.push('   * Resolver input: base64, path, o @/ path');
      lines.push('   */');
      lines.push('  async resolveInput(input) {');
      lines.push("    if (input.startsWith('data:')) {");
      lines.push("      const base64Data = input.replace(/^data:[^;]+;base64,/, '');");
      lines.push("      return { buffer: Buffer.from(base64Data, 'base64'), error: null };");
      lines.push('    }');
      lines.push('    if (this.isBase64(input)) {');
      lines.push("      return { buffer: Buffer.from(input, 'base64'), error: null };");
      lines.push('    }');
      lines.push("    if (input.startsWith('/') || input.startsWith('./') || input.startsWith('@/')) {");
      lines.push("      let filePath = input.startsWith('@/') ? input.replace('@/', './data/') : input;");
      lines.push('      if (!fs.existsSync(filePath)) {');
      lines.push('        return { buffer: null, error: `File not found: ${filePath}` };');
      lines.push('      }');
      lines.push('      return { buffer: fs.readFileSync(filePath), error: null };');
      lines.push('    }');
      lines.push("    return { buffer: null, error: 'Invalid input: not a valid file path or base64' };");
      lines.push('  },');
      lines.push('');
    }

    // --- Function implementations ---
    for (let i = 0; i < fnDefs.length; i++) {
      const fn = fnDefs[i];
      const params = fn.params || [{ name: 'input', type: 'string', required: true }];
      const output = fn.output || [{ name: 'result', type: 'string' }];
      const fnDesc = fn.description || `Ejecutar ${fn.name}`;

      // Destructure params
      const paramNames = params.map(p => {
        if (p.default !== undefined) return `${p.name} = ${JSON.stringify(p.default)}`;
        return p.name;
      });
      const requiredParams = params.filter(p => p.required);

      // Empty values for error responses
      const emptyOutputObj = output.map(o => {
        const empty = this._emptyValueForType(o.type || 'string');
        return `${o.name}: ${empty}`;
      }).join(', ');

      lines.push('  /**');
      lines.push(`   * ${fnDesc}`);
      lines.push('   */');
      lines.push(`  async '${fn.name}'({ ${paramNames.join(', ')} } = {}) {`);

      // Validation for required params
      for (const rp of requiredParams) {
        lines.push(`    if (${rp.name} === undefined || ${rp.name} === null) {`);
        lines.push(`      return { success: false, error: 'Parámetro "${rp.name}" es requerido', data: { ${emptyOutputObj} } };`);
        lines.push('    }');
      }

      if (requiredParams.length > 0) lines.push('');

      // Load npm dependency if needed
      if (npmDependency) {
        lines.push(`    const lib = load${this._pascalCase(npmDependency)}();`);
        lines.push('');
      }

      lines.push('    try {');
      lines.push(`      // TODO: Implementar lógica de '${fn.name}'`);
      lines.push('      // Ejemplo:');
      if (npmDependency) {
        lines.push(`      // const result = await lib.someMethod(${requiredParams[0]?.name || 'input'});`);
      } else {
        lines.push(`      // const result = ${requiredParams[0]?.name || 'input'};`);
      }
      lines.push('');
      lines.push('      return {');
      lines.push('        success: true,');
      lines.push('        data: {');
      for (let j = 0; j < output.length; j++) {
        lines.push(`          ${output[j].name}: null // TODO: asignar valor real${j < output.length - 1 ? ',' : ''}`);
      }
      lines.push('        }');
      lines.push('      };');
      lines.push('    } catch (error) {');
      lines.push(`      return { success: false, error: \`${this._pascalCase(name)} ${fn.name} failed: \${error.message}\`, data: { ${emptyOutputObj} } };`);
      lines.push('    }');
      lines.push(`  }${i < fnDefs.length - 1 ? ',' : ''}`);
      lines.push('');
    }

    lines.push('};');

    return lines.join('\n');
  },

  /**
   * Generar manifest.json del provider
   */
  _generateManifest(name, description, fnDefs, npmDependency) {
    const manifest = {
      $schema: '../../../schemas/provider-manifest.schema.json',
      name: `local.${name}`,
      version: '1.0.0',
      description,
      type: 'provider',
      generatedBy: 'local.skills',
      generatedAt: new Date().toISOString(),
      requires: {
        credentials: [],
        npm: npmDependency ? [npmDependency] : []
      },
      functions: {}
    };

    for (const fn of fnDefs) {
      const params = fn.params || [{ name: 'input', type: 'string', required: true, description: 'Entrada principal' }];
      const output = fn.output || [{ name: 'result', type: 'string', description: 'Resultado' }];

      const inputSchema = {};
      for (const p of params) {
        inputSchema[p.name] = {
          type: p.type || 'string',
          description: p.description || p.name
        };
        if (p.required) inputSchema[p.name].required = true;
        if (p.default !== undefined) inputSchema[p.name].default = p.default;
      }

      const outputSchema = {};
      for (const o of output) {
        outputSchema[o.name] = {
          type: o.type || 'string',
          description: o.description || o.name
        };
      }

      manifest.functions[fn.name] = {
        event: `local.${name}.${fn.name}.request`,
        description: fn.description || `Ejecutar ${fn.name}`,
        input: inputSchema,
        output: outputSchema
      };
    }

    return manifest;
  },

  /**
   * Actualizar catálogo de servicios con nuevo provider
   */
  _updateCatalog(name, description, fnDefs) {
    try {
      if (!fs.existsSync(CATALOGO_PATH)) return false;

      const catalog = JSON.parse(fs.readFileSync(CATALOGO_PATH, 'utf8'));

      if (!catalog.service_providers) catalog.service_providers = {};
      if (!catalog.service_providers.local) catalog.service_providers.local = {};

      catalog.service_providers.local[`local.${name}`] = {
        descripcion: description,
        funciones: fnDefs.map(fn => fn.name),
        credenciales: 'No requiere',
        generado_por: 'local.skills'
      };

      fs.writeFileSync(CATALOGO_PATH, JSON.stringify(catalog, null, 2), 'utf8');
      return true;
    } catch (e) {
      return false;
    }
  },

  /**
   * Eliminar servicio del catálogo
   */
  _removefromCatalog(name) {
    try {
      if (!fs.existsSync(CATALOGO_PATH)) return false;

      const catalog = JSON.parse(fs.readFileSync(CATALOGO_PATH, 'utf8'));

      if (catalog.service_providers?.local?.[`local.${name}`]) {
        delete catalog.service_providers.local[`local.${name}`];
        fs.writeFileSync(CATALOGO_PATH, JSON.stringify(catalog, null, 2), 'utf8');
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  },

  /**
   * Extraer info de un provider leyendo su source code
   */
  _extractInfoFromSource(content, serviceName) {
    const info = {
      name: `local.${serviceName}`,
      description: '',
      functions: [],
      path: path.join(PROVIDERS_DIR, serviceName)
    };

    // Extraer description
    const descMatch = content.match(/description:\s*['"`]([^'"`]+)['"`]/);
    if (descMatch) info.description = descMatch[1];

    // Extraer funciones del bloque functions: { ... }
    const fnBlockMatch = content.match(/functions:\s*\{([\s\S]*?)\n\s*\}/);
    if (fnBlockMatch) {
      const fnBlock = fnBlockMatch[1];
      // Buscar cada función: 'name': { o name: {
      const fnPattern = /['"]?([a-z][a-z0-9-]*)['"]?\s*:\s*\{[^}]*?event:\s*['"]([^'"]+)['"]/g;
      let fnMatch;
      while ((fnMatch = fnPattern.exec(fnBlock)) !== null) {
        const fnName = fnMatch[1];
        const event = fnMatch[2];
        // Extraer description de la función
        const fnDescPattern = new RegExp(`['"]?${fnName.replace(/-/g, '\\-')}['"]?\\s*:\\s*\\{[^}]*?description:\\s*['"]([^'"]+)['"]`);
        const fnDescMatch = fnBlock.match(fnDescPattern);
        info.functions.push({
          name: fnName,
          event,
          description: fnDescMatch ? fnDescMatch[1] : ''
        });
      }
    }

    return info;
  },

  // ============================================================
  // HELPERS
  // ============================================================

  _pascalCase(str) {
    return str.replace(/(^|[-])([a-z])/g, (_, __, c) => c.toUpperCase());
  },

  _camelCase(str) {
    return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  },

  _escapeQuotes(str) {
    return (str || '').replace(/'/g, "\\'");
  },

  _emptyValueForType(type) {
    switch (type) {
      case 'number': return '0';
      case 'boolean': return 'false';
      case 'array': return '[]';
      case 'object': return '{}';
      default: return "''";
    }
  }
};
