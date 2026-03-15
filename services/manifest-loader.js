/**
 * Manifest Loader
 *
 * Carga y cachea todos los manifest.json de providers del sistema.
 * Permite autodescubrimiento de servicios y sus contratos.
 *
 * Uso:
 *   const loader = require('./services/manifest-loader');
 *   await loader.load();
 *
 *   // Obtener todos los eventos de respuesta
 *   const events = loader.getServiceEvents();
 *
 *   // Validar un step contra el contrato
 *   const validation = loader.validateStep(step);
 *
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

class ManifestLoader {
  constructor() {
    this.manifests = new Map();
    this.loaded = false;
    this.logger = null;

    // Rutas donde buscar providers
    this.providerPaths = [
      './services/providers/local',
      './services/providers/google',
      './services/providers/anthropic',
      './services/providers/elevenlabs'
    ];
  }

  /**
   * Configura el logger
   */
  setLogger(logger) {
    this.logger = logger;
  }

  /**
   * Carga todos los manifests de providers
   */
  async load() {
    this.manifests.clear();

    for (const basePath of this.providerPaths) {
      await this.loadFromPath(basePath);
    }

    this.loaded = true;
    this.log('info', `Loaded ${this.manifests.size} provider manifests`);

    return this.manifests;
  }

  /**
   * Carga manifests de un directorio de providers
   */
  async loadFromPath(basePath) {
    if (!fs.existsSync(basePath)) {
      this.log('debug', `Path not found: ${basePath}`);
      return;
    }

    const entries = fs.readdirSync(basePath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const providerPath = path.join(basePath, entry.name);

      // Intentar cargar manifest.json (providers locales)
      const manifestPath = path.join(providerPath, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        await this.loadManifest(manifestPath, entry.name);
        continue;
      }

      // Intentar cargar provider.json + functions/*.json (providers cloud)
      const providerJsonPath = path.join(providerPath, 'provider.json');
      if (fs.existsSync(providerJsonPath)) {
        await this.loadCloudProvider(providerPath, entry.name);
      }
    }
  }

  /**
   * Carga un manifest.json de provider local
   */
  async loadManifest(manifestPath, providerName) {
    try {
      const content = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(content);

      // Normalizar estructura
      const normalized = {
        name: manifest.name,
        version: manifest.version || '1.0.0',
        description: manifest.description || '',
        type: 'local',
        requires: manifest.requires || {},
        functions: manifest.functions || {},
        source: manifestPath
      };

      this.manifests.set(manifest.name, normalized);
      this.log('debug', `Loaded manifest: ${manifest.name}`);

    } catch (e) {
      this.log('error', `Failed to load ${manifestPath}: ${e.message}`);
    }
  }

  /**
   * Carga un provider cloud (provider.json + functions/*.json)
   */
  async loadCloudProvider(providerPath, providerName) {
    try {
      const providerJsonPath = path.join(providerPath, 'provider.json');
      const providerContent = fs.readFileSync(providerJsonPath, 'utf8');
      const provider = JSON.parse(providerContent);

      const normalized = {
        name: provider.name || providerName,
        version: provider.version || '1.0.0',
        description: provider.description || '',
        type: 'cloud',
        requires: {
          credentials: provider.requires?.credentials || [],
          npm: []
        },
        functions: {},
        source: providerJsonPath
      };

      // Cargar funciones desde functions/*.json
      const functionsPath = path.join(providerPath, 'functions');
      if (fs.existsSync(functionsPath)) {
        const functionFiles = fs.readdirSync(functionsPath)
          .filter(f => f.endsWith('.json'));

        for (const file of functionFiles) {
          const fnPath = path.join(functionsPath, file);
          const fnContent = fs.readFileSync(fnPath, 'utf8');
          const fn = JSON.parse(fnContent);

          const fnName = fn.name || file.replace('.json', '');
          normalized.functions[fnName] = {
            event: fn.event,
            description: fn.description || '',
            input: fn.input || {},
            output: fn.output || {}
          };
        }
      }

      this.manifests.set(normalized.name, normalized);
      this.log('debug', `Loaded cloud provider: ${normalized.name}`);

    } catch (e) {
      this.log('error', `Failed to load cloud provider ${providerPath}: ${e.message}`);
    }
  }

  /**
   * Obtiene todos los eventos de respuesta de servicios
   * @returns {Array<{event: string, type: 'response'|'failed'}>}
   */
  getServiceEvents() {
    const events = [];

    for (const [name, manifest] of this.manifests) {
      for (const [fnName, fn] of Object.entries(manifest.functions)) {
        if (!fn.event) continue;

        // Generar eventos response y failed
        const baseEvent = fn.event.replace('.request', '');
        events.push({
          provider: name,
          function: fnName,
          event: `${baseEvent}.response`,
          type: 'response'
        });
        events.push({
          provider: name,
          function: fnName,
          event: `${baseEvent}.failed`,
          type: 'failed'
        });
      }
    }

    return events;
  }

  /**
   * Obtiene solo los nombres de eventos para suscripción
   * @returns {Array<string>}
   */
  getServiceEventNames() {
    return this.getServiceEvents().map(e => e.event);
  }

  /**
   * Obtiene eventos agrupados por tipo
   * @returns {{response: string[], failed: string[]}}
   */
  getServiceEventsByType() {
    const events = this.getServiceEvents();
    return {
      response: events.filter(e => e.type === 'response').map(e => e.event),
      failed: events.filter(e => e.type === 'failed').map(e => e.event)
    };
  }

  /**
   * Obtiene un manifest por nombre
   */
  getManifest(name) {
    return this.manifests.get(name);
  }

  /**
   * Obtiene todos los manifests
   */
  getAllManifests() {
    return Array.from(this.manifests.values());
  }

  /**
   * Busca el manifest que contiene una función específica
   */
  findByEvent(eventName) {
    for (const [name, manifest] of this.manifests) {
      for (const [fnName, fn] of Object.entries(manifest.functions)) {
        if (fn.event === eventName) {
          return { manifest, function: fnName, functionDef: fn };
        }
      }
    }
    return null;
  }

  /**
   * Valida un step de flujo contra el contrato del servicio
   */
  validateStep(step) {
    if (step.type !== 'service') {
      return { valid: true, errors: [] };
    }

    const errors = [];
    const serviceName = step.service;
    const action = step.action;

    // Buscar manifest del servicio
    const manifest = this.manifests.get(serviceName);
    if (!manifest) {
      errors.push(`Unknown service: ${serviceName}`);
      return { valid: false, errors };
    }

    // Buscar función
    const fn = manifest.functions[action];
    if (!fn) {
      const available = Object.keys(manifest.functions).join(', ');
      errors.push(`Unknown action '${action}' for service '${serviceName}'. Available: ${available}`);
      return { valid: false, errors };
    }

    // Validar parámetros requeridos
    if (fn.input) {
      for (const [paramName, paramDef] of Object.entries(fn.input)) {
        if (paramDef.required && step[paramName] === undefined) {
          errors.push(`Missing required parameter '${paramName}' for ${serviceName}.${action}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      manifest,
      function: fn
    };
  }

  /**
   * Genera documentación de todos los servicios disponibles
   */
  generateDocs() {
    const docs = {
      generated: new Date().toISOString(),
      providers: {}
    };

    for (const [name, manifest] of this.manifests) {
      docs.providers[name] = {
        description: manifest.description,
        version: manifest.version,
        type: manifest.type,
        requires: manifest.requires,
        functions: Object.entries(manifest.functions).map(([fnName, fn]) => ({
          name: fnName,
          event: fn.event,
          description: fn.description,
          input: fn.input,
          output: fn.output
        }))
      };
    }

    return docs;
  }

  /**
   * Helper para logging
   */
  log(level, message) {
    if (this.logger) {
      this.logger[level]?.(`manifest-loader.${level}`, { message });
    }
  }
}

// Singleton
const loader = new ManifestLoader();

module.exports = loader;
