/**
 * Flow Registry
 *
 * Mapea capacidades abstractas a providers concretos.
 * Permite cambiar de provider sin tocar los flows.
 *
 * Una capability es un nombre genérico (ej: "image.prepare")
 * que se resuelve a un provider + action concreto (ej: "local.sharp" + "prepare-ocr").
 *
 * Uso:
 *   const registry = new Registry();
 *   registry.load('./config/capabilities.json');
 *   const { provider, action } = registry.resolve('image.prepare');
 *   // → { provider: 'local.sharp', action: 'prepare-ocr' }
 *
 *   registry.switch('image.prepare', 'local.jimp');
 *   // Ahora image.prepare usa jimp en vez de sharp
 *
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

class Registry {
  constructor() {
    this.capabilities = new Map();
  }

  /**
   * Carga capabilities desde archivo JSON o objeto
   * @param {string|object} source - Ruta a JSON o objeto directo
   */
  load(source) {
    let data;
    if (typeof source === 'string') {
      const abs = path.isAbsolute(source) ? source : path.join(process.cwd(), source);
      data = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    } else {
      data = source;
    }

    for (const [name, def] of Object.entries(data)) {
      if (name.startsWith('_')) continue;
      this.register(name, def);
    }
  }

  /**
   * Registra una capability
   * @param {string} name - Nombre abstracto (ej: "image.prepare")
   * @param {object} def - Definición
   * @param {string} def.provider - Provider por defecto (ej: "local.sharp")
   * @param {string} def.action - Acción del provider (ej: "prepare-ocr")
   * @param {object} [def.defaults] - Parámetros por defecto
   * @param {string[]} [def.alternatives] - Providers alternativos
   */
  register(name, def) {
    this.capabilities.set(name, {
      provider: def.provider,
      action: def.action,
      defaults: def.defaults || {},
      alternatives: def.alternatives || [],
      original: def.provider
    });
  }

  /**
   * Resuelve capability a provider concreto
   * @param {string} name - Nombre de la capability
   * @returns {{ provider: string, action: string, defaults: object }}
   * @throws {Error} si la capability no existe
   */
  resolve(name) {
    const cap = this.capabilities.get(name);
    if (!cap) {
      throw new Error(`Capability no registrada: ${name}`);
    }
    return {
      provider: cap.provider,
      action: cap.action,
      defaults: { ...cap.defaults }
    };
  }

  /**
   * Cambia el provider activo de una capability
   * @param {string} name - Nombre de la capability
   * @param {string} newProvider - Nuevo provider
   */
  switch(name, newProvider) {
    const cap = this.capabilities.get(name);
    if (!cap) {
      throw new Error(`Capability no registrada: ${name}`);
    }
    cap.provider = newProvider;
  }

  /**
   * Restaura el provider original de una capability
   * @param {string} name
   */
  reset(name) {
    const cap = this.capabilities.get(name);
    if (cap) {
      cap.provider = cap.original;
    }
  }

  /**
   * Devuelve las alternativas disponibles para una capability
   * @param {string} name
   * @returns {string[]}
   */
  alternatives(name) {
    const cap = this.capabilities.get(name);
    return cap ? cap.alternatives : [];
  }

  /**
   * Lista todas las capabilities registradas
   * @returns {object[]}
   */
  list() {
    const result = [];
    for (const [name, cap] of this.capabilities) {
      result.push({
        name,
        provider: cap.provider,
        action: cap.action,
        alternatives: cap.alternatives
      });
    }
    return result;
  }

  /**
   * Comprueba si una capability existe
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.capabilities.has(name);
  }
}

module.exports = Registry;
