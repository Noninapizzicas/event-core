/**
 * Download Manager
 * Descarga archivos y gestiona su ciclo de vida via nombres de archivo.
 *
 * CONVENCIÓN DE NOMBRES:
 * {YYYYMMDD}_{HHmmss}_{nombreOriginal}_{STATUS}.{ext}
 *
 * Ejemplo: 20260109_143052_factura_R.pdf
 *
 * CÓDIGOS DE ESTADO (se acumulan en orden):
 * R = Received    - Archivo recibido y guardado
 * P = Processed   - Procesado por un agente
 * V = Validated   - Validado/revisado
 * A = Archived    - Archivado (procesamiento completo)
 * X = Exported    - Exportado a otro sistema
 * E = Error       - Error en algún procesamiento
 * D = Discarded   - Marcado para eliminar
 *
 * EVOLUCIÓN DE UN ARCHIVO:
 * factura.pdf (original de Telegram)
 *   → 20260109_143052_factura_R.pdf (recibido)
 *   → 20260109_143052_factura_RP.pdf (procesado por agente)
 *   → 20260109_143052_factura_RPV.pdf (validado)
 *   → 20260109_143052_factura_RPVA.pdf (archivado)
 */

const fs = require('fs').promises;
const path = require('path');

// Estados válidos y su significado
const FILE_STATES = {
  R: 'received',    // Recibido
  P: 'processed',   // Procesado por agente
  V: 'validated',   // Validado/revisado
  A: 'archived',    // Archivado
  X: 'exported',    // Exportado
  E: 'error',       // Error
  D: 'discarded'    // Descartado
};

// Mapa de MIME types a extensiones
const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'application/pdf': 'pdf',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4a',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'text/plain': 'txt',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx'
};

// Regex para parsear nombres de archivo
// Captura: date, time, name, status, extension
const FILENAME_REGEX = /^(\d{8})_(\d{6})_(.+)_([RPVAXED]+)\.(.+)$/;

class DownloadManager {
  constructor(config, logger, eventBus) {
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
  }

  /**
   * Genera timestamp en formato YYYYMMDD_HHmmss
   */
  getTimestamp() {
    const now = new Date();
    const date = now.toISOString().split('T')[0].replace(/-/g, '');
    const time = now.toTimeString().split(' ')[0].replace(/:/g, '');
    return { date, time };
  }

  /**
   * Construye nombre de archivo con metadata
   * @param {string} originalName - Nombre original del archivo
   * @param {string} status - Estado inicial (default: 'R')
   * @param {string} mimeType - MIME type para inferir extensión si falta
   */
  buildFileName(originalName, status = 'R', mimeType = null) {
    const { date, time } = this.getTimestamp();
    const safeName = this.sanitizeFileName(originalName);

    // Separar nombre y extensión
    const lastDot = safeName.lastIndexOf('.');
    const name = lastDot > 0 ? safeName.substring(0, lastDot) : safeName;
    let ext = lastDot > 0 ? safeName.substring(lastDot + 1) : null;

    // Si no hay extensión, inferir del MIME type
    if (!ext && mimeType) {
      ext = MIME_TO_EXT[mimeType] || 'bin';
    } else if (!ext) {
      ext = 'bin';
    }

    return `${date}_${time}_${name}_${status}.${ext}`;
  }

  /**
   * Parsea un nombre de archivo y extrae metadata
   * @returns {object|null} { date, time, name, status, extension, states[] }
   */
  parseFileName(fileName) {
    const match = fileName.match(FILENAME_REGEX);
    if (!match) return null;

    const [, date, time, name, status, extension] = match;

    return {
      date,           // "20260109"
      time,           // "143052"
      name,           // "factura"
      status,         // "RP"
      extension,      // "pdf"
      states: status.split('').map(s => FILE_STATES[s] || 'unknown'),
      receivedAt: `${date.substring(0,4)}-${date.substring(4,6)}-${date.substring(6,8)}T${time.substring(0,2)}:${time.substring(2,4)}:${time.substring(4,6)}`,
      hasState: (state) => status.includes(state)
    };
  }

  /**
   * Actualiza el estado de un archivo (renombra)
   * @param {string} filePath - Ruta completa del archivo
   * @param {string} newState - Estado a añadir (R, P, V, A, X, E, D)
   * @returns {object} { success, oldPath, newPath }
   */
  async updateFileStatus(filePath, newState) {
    const dir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const parsed = this.parseFileName(fileName);

    if (!parsed) {
      this.logger.error('download-manager.invalid-filename', { filePath });
      return { success: false, error: 'Invalid filename format' };
    }

    // No duplicar estado
    if (parsed.status.includes(newState)) {
      return { success: true, oldPath: filePath, newPath: filePath, noChange: true };
    }

    // Construir nuevo nombre con estado añadido
    const newStatus = parsed.status + newState;
    const newFileName = `${parsed.date}_${parsed.time}_${parsed.name}_${newStatus}.${parsed.extension}`;
    const newPath = path.join(dir, newFileName);

    try {
      await fs.rename(filePath, newPath);

      this.logger.info('download-manager.status-updated', {
        oldStatus: parsed.status,
        newStatus,
        newState,
        newPath
      });

      return { success: true, oldPath: filePath, newPath, oldStatus: parsed.status, newStatus };
    } catch (error) {
      this.logger.error('download-manager.rename-failed', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Descarga un archivo de Telegram y lo guarda con estado R (Received)
   */
  async downloadAndStore(botName, fileId, originalName, mimeType, storagePath) {
    await fs.mkdir(storagePath, { recursive: true });

    const fileName = this.buildFileName(originalName || `file_${Date.now()}`, 'R', mimeType);
    const destPath = path.join(storagePath, fileName);

    this.logger.info('download-manager.downloading', {
      botName,
      fileId,
      destPath
    });

    try {
      const result = await this.requestDownload(botName, fileId, destPath);

      if (!result.success) {
        throw new Error(result.error || 'Download failed');
      }

      const stats = await fs.stat(destPath);
      const parsed = this.parseFileName(fileName);

      this.logger.info('download-manager.downloaded', {
        botName,
        fileId,
        path: destPath,
        size: stats.size,
        status: 'R'
      });

      return {
        success: true,
        path: destPath,
        fileName,
        originalName: parsed.name,
        mimeType,
        size: stats.size,
        status: 'R',
        metadata: parsed
      };

    } catch (error) {
      this.logger.error('download-manager.failed', {
        botName,
        fileId,
        error: error.message
      });

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Solicita descarga a telegram-service via evento request/response
   */
  async requestDownload(botName, fileId, destPath) {
    return new Promise(async (resolve, reject) => {
      const requestId = `download_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      let unsubscribe = null;

      const timeout = setTimeout(() => {
        if (unsubscribe) unsubscribe();
        reject(new Error('Download timeout'));
      }, 30000);

      const responseHandler = (event) => {
        const data = event?.data || event?.payload || event;
        if (data.request_id === requestId) {
          clearTimeout(timeout);
          if (unsubscribe) unsubscribe();
          resolve(data);
        }
      };

      // subscribe() retorna función de unsubscribe
      unsubscribe = await this.eventBus.subscribe('telegram.get_file.response', responseHandler);

      await this.eventBus.publish('telegram.get_file.request', {
        request_id: requestId,
        botName,
        fileId,
        download: true,
        destPath
      });
    });
  }

  /**
   * Guarda texto como archivo JSON con estado R
   */
  async storeText(botName, text, metadata, storagePath) {
    await fs.mkdir(storagePath, { recursive: true });

    const fileName = this.buildFileName('message.json', 'R');
    const destPath = path.join(storagePath, fileName);

    const content = {
      text,
      ...metadata,
      storedAt: new Date().toISOString()
    };

    await fs.writeFile(destPath, JSON.stringify(content, null, 2), 'utf8');

    this.logger.info('download-manager.text-stored', {
      botName,
      path: destPath,
      status: 'R'
    });

    return {
      success: true,
      path: destPath,
      fileName,
      originalName: 'message.json',
      mimeType: 'application/json',
      size: Buffer.byteLength(JSON.stringify(content)),
      status: 'R'
    };
  }

  /**
   * Lista archivos en un directorio con su metadata parseada
   */
  async listFiles(dirPath, filterStatus = null) {
    try {
      const files = await fs.readdir(dirPath);
      const results = [];

      for (const file of files) {
        const parsed = this.parseFileName(file);
        if (parsed) {
          if (!filterStatus || parsed.status.includes(filterStatus)) {
            results.push({
              fileName: file,
              path: path.join(dirPath, file),
              ...parsed
            });
          }
        }
      }

      // Ordenar por fecha/hora descendente
      results.sort((a, b) => {
        const dateA = a.date + a.time;
        const dateB = b.date + b.time;
        return dateB.localeCompare(dateA);
      });

      return results;
    } catch (error) {
      return [];
    }
  }

  /**
   * Obtiene archivos pendientes (solo R, sin procesar)
   */
  async getPendingFiles(dirPath) {
    return this.listFiles(dirPath, 'R').then(files =>
      files.filter(f => f.status === 'R')
    );
  }

  /**
   * Sanitiza nombre de archivo
   */
  sanitizeFileName(name) {
    return name
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/__+/g, '_')
      .substring(0, 200);
  }
}

// Exportar también las constantes para uso externo
DownloadManager.FILE_STATES = FILE_STATES;
DownloadManager.FILENAME_REGEX = FILENAME_REGEX;
DownloadManager.MIME_TO_EXT = MIME_TO_EXT;

module.exports = DownloadManager;
