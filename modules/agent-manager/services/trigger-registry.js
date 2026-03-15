/**
 * Trigger Registry
 * Gestiona qué evento activa qué agente
 */

const fs = require('fs').promises;
const path = require('path');

class TriggerRegistry {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.triggers = []; // Array de trigger configs
    this.storagePath = config.triggersPath || './data/agent-manager/triggers';
    this.configFile = path.join(this.storagePath, 'triggers.json');
  }

  async initialize() {
    await fs.mkdir(this.storagePath, { recursive: true });
    await this.loadTriggers();

    this.logger.info('trigger-registry.initialized', {
      triggers_count: this.triggers.length
    });
  }

  async loadTriggers() {
    try {
      const content = await fs.readFile(this.configFile, 'utf8');
      this.triggers = JSON.parse(content);
    } catch (error) {
      // No existe archivo, empezar vacío
      this.triggers = [];
      this.logger.debug('trigger-registry.no-existing-triggers');
    }
  }

  async saveTriggers() {
    await fs.writeFile(this.configFile, JSON.stringify(this.triggers, null, 2), 'utf8');
  }

  /**
   * Añade un nuevo trigger
   * @param {Object} triggerConfig
   * @param {string} triggerConfig.event - Evento que activa (ej: "bot.file.stored")
   * @param {Object} triggerConfig.filter - Filtros opcionales (botName, mimeType, etc.)
   * @param {string} triggerConfig.agent - Agente a ejecutar (si es uno solo)
   * @param {string[]} triggerConfig.pipeline - Array de agentes si es secuencia
   * @param {Object} triggerConfig.contextTemplate - Template para construir contexto
   */
  async add(triggerConfig) {
    const trigger = {
      id: `trigger_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      event: triggerConfig.event,
      filter: triggerConfig.filter || {},
      agent: triggerConfig.agent || null,
      pipeline: triggerConfig.pipeline || null,
      contextTemplate: triggerConfig.contextTemplate || {},
      enabled: triggerConfig.enabled !== false,
      createdAt: new Date().toISOString()
    };

    this.triggers.push(trigger);
    await this.saveTriggers();

    this.logger.info('trigger-registry.added', {
      id: trigger.id,
      event: trigger.event,
      agent: trigger.agent,
      pipeline: trigger.pipeline
    });

    return trigger;
  }

  /**
   * Elimina un trigger
   */
  async remove(triggerId) {
    const index = this.triggers.findIndex(t => t.id === triggerId);
    if (index === -1) return false;

    this.triggers.splice(index, 1);
    await this.saveTriggers();

    this.logger.info('trigger-registry.removed', { id: triggerId });
    return true;
  }

  /**
   * Actualiza un trigger
   */
  async update(triggerId, updates) {
    const trigger = this.triggers.find(t => t.id === triggerId);
    if (!trigger) return null;

    if (updates.filter) trigger.filter = { ...trigger.filter, ...updates.filter };
    if (updates.agent !== undefined) trigger.agent = updates.agent;
    if (updates.pipeline !== undefined) trigger.pipeline = updates.pipeline;
    if (updates.contextTemplate) trigger.contextTemplate = { ...trigger.contextTemplate, ...updates.contextTemplate };
    if (updates.enabled !== undefined) trigger.enabled = updates.enabled;

    await this.saveTriggers();
    return trigger;
  }

  /**
   * Busca triggers que coincidan con un evento
   */
  findMatching(eventType, eventData) {
    return this.triggers.filter(trigger => {
      // Debe estar habilitado
      if (!trigger.enabled) return false;

      // Debe coincidir el evento
      if (trigger.event !== eventType) return false;

      // Verificar filtros
      if (!this.matchesFilter(trigger.filter, eventData)) return false;

      return true;
    });
  }

  /**
   * Verifica si los datos del evento coinciden con el filtro
   */
  matchesFilter(filter, data) {
    if (!filter || Object.keys(filter).length === 0) return true;

    for (const [key, value] of Object.entries(filter)) {
      const dataValue = this.getNestedValue(data, key);

      if (Array.isArray(value)) {
        // Si el filtro es array, el valor debe estar en el array
        // Soporta wildcards: "*" matchea todo, "image/*" matchea "image/png", etc.
        const matches = value.some(v => this.matchesPattern(dataValue, v));
        if (!matches) return false;
      } else {
        // Comparación directa o patrón
        if (!this.matchesPattern(dataValue, value)) return false;
      }
    }

    return true;
  }

  /**
   * Obtiene valor anidado de un objeto (ej: "file.mimeType" → data.file.mimeType)
   */
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  /**
   * Compara valor con patrón (soporta wildcards)
   */
  matchesPattern(value, pattern) {
    if (pattern === '*') return true;
    if (typeof pattern === 'string' && pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(value);
    }
    return value === pattern;
  }

  /**
   * Obtiene todos los triggers
   */
  getAll() {
    return this.triggers;
  }

  /**
   * Obtiene un trigger por ID
   */
  get(triggerId) {
    return this.triggers.find(t => t.id === triggerId);
  }
}

module.exports = TriggerRegistry;
