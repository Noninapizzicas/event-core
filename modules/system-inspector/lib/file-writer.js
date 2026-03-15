/**
 * File Writer
 *
 * Escribe el estado del buffer a disco periódicamente.
 * El archivo resultante es lo que Claude lee para conocer el estado del sistema.
 *
 * Características:
 * - Escribe cada N segundos (configurable)
 * - Formato JSON legible
 * - Maneja errores de escritura sin crashear
 * - No crece infinitamente (sobreescribe)
 */

const fs = require('fs');
const path = require('path');

class FileWriter {
  /**
   * @param {Object} options
   * @param {ConsoleBuffer} options.buffer - Buffer a escribir
   * @param {string} options.filePath - Ruta del archivo
   * @param {number} options.intervalMs - Intervalo de escritura (default: 2000)
   * @param {string} options.coreId - ID del core
   * @param {number} options.startTime - Timestamp de inicio
   */
  constructor(options = {}) {
    this.buffer = options.buffer;
    this.filePath = options.filePath || './data/system-console.json';
    this.intervalMs = options.intervalMs || 2000;
    this.coreId = options.coreId || 'unknown';
    this.startTime = options.startTime || Date.now();

    this.timer = null;
    this.writing = false;
    this.lastError = null;
  }

  /**
   * Inicia la escritura periódica
   */
  start() {
    if (this.timer) return;

    // Asegurar que el directorio existe
    this._ensureDirectory();

    // Escribir inmediatamente
    this._write();

    // Iniciar timer
    this.timer = setInterval(() => this._write(), this.intervalMs);
  }

  /**
   * Detiene la escritura
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Escribir una última vez
    this._write();
  }

  /**
   * Asegura que el directorio de salida existe
   */
  _ensureDirectory() {
    const dir = path.dirname(this.filePath);

    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (error) {
      console.error('[system-inspector] Failed to create directory:', dir, error.message);
    }
  }

  /**
   * Escribe el buffer a disco
   */
  async _write() {
    // Evitar escrituras simultáneas
    if (this.writing) return;

    this.writing = true;

    try {
      // Obtener estado completo del buffer
      const state = this.buffer.getFullState(this.coreId, this.startTime);

      // Convertir a JSON con formato legible
      const json = JSON.stringify(state, null, 2);

      // Escribir a archivo (async para no bloquear)
      await fs.promises.writeFile(this.filePath, json, 'utf8');

      this.lastError = null;
    } catch (error) {
      // No crashear por error de escritura
      if (this.lastError !== error.message) {
        console.error('[system-inspector] Write error:', error.message);
        this.lastError = error.message;
      }
    } finally {
      this.writing = false;
    }
  }

  /**
   * Fuerza una escritura inmediata
   */
  flush() {
    return this._write();
  }
}

module.exports = FileWriter;
