/**
 * Handler Store
 *
 * Key-value persistente para handlers. Almacena en JSON.
 * Cada handler tiene su propio archivo de store.
 *
 * Ubicación:
 * - Proyecto: data/projects/{projectId}/handler-store/{handlerName}.json
 * - Global: data/handler-store/{handlerName}.json
 *
 * @example
 * const store = new HandlerStore('mi-proyecto', 'procesar-factura');
 * await store.set('contador', 1);
 * const valor = await store.get('contador');
 */

const fs = require('fs');
const path = require('path');

class HandlerStore {
  /**
   * @param {string|null} projectId - ID del proyecto (null para global)
   * @param {string} handlerName - Nombre del handler
   * @param {string} basePath - Path base
   */
  constructor(projectId, handlerName, basePath = './data') {
    // Sanitizar handlerName para evitar path traversal
    const safeName = handlerName.replace(/[^a-zA-Z0-9_-]/g, '_');

    if (projectId) {
      this.filePath = path.join(basePath, 'projects', projectId, 'handler-store', `${safeName}.json`);
    } else {
      this.filePath = path.join(basePath, 'handler-store', `${safeName}.json`);
    }

    this.data = this._load();
  }

  /**
   * Carga datos del archivo
   * @private
   */
  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        // Manejar archivo vacío
        if (!content.trim()) return {};
        return JSON.parse(content);
      }
    } catch (error) {
      // Archivo corrupto - empezar de cero pero guardar backup
      if (error instanceof SyntaxError) {
        const backupPath = `${this.filePath}.corrupted.${Date.now()}`;
        try {
          fs.renameSync(this.filePath, backupPath);
        } catch (e) {
          // Ignorar si no se puede hacer backup
        }
      }
    }
    return {};
  }

  /**
   * Guarda datos al archivo
   * @private
   */
  _save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Escribir con formato para debugging
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      // Log pero no fallar - el handler debe continuar
      console.error(`[handler-store] Error saving: ${error.message}`);
    }
  }

  /**
   * Valida que la key sea válida
   * @private
   */
  _validateKey(key) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error('Store key must be a non-empty string');
    }
    // Limitar longitud de key
    if (key.length > 256) {
      throw new Error('Store key too long (max 256 chars)');
    }
  }

  /**
   * Obtiene un valor
   * @param {string} key
   * @param {*} defaultValue - Valor por defecto si no existe
   * @returns {Promise<*>}
   */
  async get(key, defaultValue = null) {
    this._validateKey(key);
    const value = this.data[key];
    return value !== undefined ? value : defaultValue;
  }

  /**
   * Guarda un valor
   * @param {string} key
   * @param {*} value - Debe ser serializable a JSON
   * @returns {Promise<*>} El valor guardado
   */
  async set(key, value) {
    this._validateKey(key);
    // undefined no es válido en JSON, convertir a null
    this.data[key] = value === undefined ? null : value;
    this._save();
    return this.data[key];
  }

  /**
   * Elimina un valor
   * @param {string} key
   * @returns {Promise<boolean>} true si existía
   */
  async delete(key) {
    this._validateKey(key);
    const existed = key in this.data;
    delete this.data[key];
    if (existed) this._save();
    return existed;
  }

  /**
   * Incrementa un contador
   * @param {string} key
   * @param {number} amount - Cantidad a incrementar (default: 1)
   * @returns {Promise<number>} Nuevo valor
   */
  async increment(key, amount = 1) {
    this._validateKey(key);
    const current = typeof this.data[key] === 'number' ? this.data[key] : 0;
    this.data[key] = current + amount;
    this._save();
    return this.data[key];
  }

  /**
   * Verifica si existe una key
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async has(key) {
    this._validateKey(key);
    return key in this.data;
  }

  /**
   * Obtiene todas las keys
   * @returns {Promise<string[]>}
   */
  async keys() {
    return Object.keys(this.data);
  }

  /**
   * Obtiene todos los datos (copia)
   * @returns {Promise<Object>}
   */
  async getAll() {
    return { ...this.data };
  }

  /**
   * Limpia todo el store
   * @returns {Promise<void>}
   */
  async clear() {
    this.data = {};
    this._save();
  }
}

module.exports = HandlerStore;
