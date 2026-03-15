/**
 * Local Tesseract OCR Service
 *
 * Servicio local para OCR usando Tesseract.js.
 * No requiere credenciales externas.
 *
 * Eventos:
 * - local.tesseract.extract.request -> local.tesseract.extract.response
 */

const fs = require('fs');
const path = require('path');

// Lazy load Tesseract.js
let Tesseract = null;

const loadTesseract = () => {
  if (!Tesseract) {
    try {
      Tesseract = require('tesseract.js');
    } catch (e) {
      throw new Error('tesseract.js not installed. Run: npm install tesseract.js');
    }
  }
  return Tesseract;
};

module.exports = {
  name: 'local.tesseract',
  description: 'Servicio local de OCR usando Tesseract.js',

  functions: {
    extract: {
      event: 'local.tesseract.extract.request',
      description: 'Extraer texto de imagen usando Tesseract OCR',
      input: {
        image: {
          type: 'string',
          description: 'Imagen en base64 o path al archivo',
          required: true
        },
        mimeType: {
          type: 'string',
          description: 'Tipo MIME de la imagen (image/jpeg, image/png, etc.)',
          default: 'auto'
        },
        language: {
          type: 'string',
          description: 'Codigo de idioma (eng, spa, deu, fra, etc.)',
          default: 'eng'
        }
      },
      output: {
        text: { type: 'string', description: 'Texto extraido' },
        confidence: { type: 'number', description: 'Confianza 0-100' }
      }
    }
  },

  // Worker compartido para mejor rendimiento
  _worker: null,
  _workerLanguage: null,

  /**
   * Obtener o crear worker
   */
  async getWorker(language) {
    const T = loadTesseract();

    // Si el worker existe y el idioma coincide, reutilizar
    if (this._worker && this._workerLanguage === language) {
      return this._worker;
    }

    // Si hay worker con otro idioma, terminarlo
    if (this._worker) {
      await this._worker.terminate();
    }

    // Crear nuevo worker
    this._worker = await T.createWorker(language, 1, {
      logger: () => {} // Silenciar logs
    });

    this._workerLanguage = language;
    return this._worker;
  },

  /**
   * Detectar tipo MIME desde magic bytes del base64
   * Soporta imágenes y documentos comunes
   */
  detectMimeType(base64) {
    // Magic bytes en base64 - imágenes
    if (base64.startsWith('/9j/')) return 'image/jpeg';
    if (base64.startsWith('iVBORw')) return 'image/png';
    if (base64.startsWith('R0lGOD')) return 'image/gif';
    if (base64.startsWith('UklGR')) return 'image/webp';
    if (base64.startsWith('Qk')) return 'image/bmp';
    if (base64.startsWith('SUkq') || base64.startsWith('TU0A')) return 'image/tiff';

    // Documentos
    if (base64.startsWith('JVBERi')) return 'application/pdf';

    // Default a PNG si no se detecta (Tesseract lo manejará)
    return 'image/png';
  },

  /**
   * Extraer texto de imagen
   */
  async extract({ image, mimeType = 'auto', language = 'eng' } = {}) {
    // Validar parámetro image
    if (!image || typeof image !== 'string') {
      return {
        success: false,
        error: `Invalid image parameter: expected string, got ${typeof image}`,
        text: '',
        confidence: 0,
        words: 0,
        lines: 0
      };
    }

    const worker = await this.getWorker(language);

    // Determinar si es base64 o path
    let imageInput = image;

    // Primero detectar base64 por magic bytes (JPEG empieza con /9j/ que parece path)
    const base64Prefixes = ['/9j/', 'iVBORw', 'R0lGOD', 'UklGR', 'Qk', 'SUkq', 'TU0A', 'JVBERi'];
    const looksLikeBase64 = base64Prefixes.some(p => image.startsWith(p));

    if (image.startsWith('data:')) {
      // Ya tiene prefijo data URI
      imageInput = image;
    } else if (looksLikeBase64) {
      // Es base64 sin prefijo - detectar tipo y agregar header
      const detectedType = mimeType === 'auto' ? this.detectMimeType(image) : mimeType;
      imageInput = `data:${detectedType};base64,${image}`;
    } else if (image.startsWith('/') || image.startsWith('./')) {
      // Es un path de archivo - verificar que existe
      if (!fs.existsSync(image)) {
        return {
          success: false,
          error: `Image file not found: ${image}`
        };
      }
    }

    try {
      const { data } = await worker.recognize(imageInput);

      return {
        success: true,
        text: data.text.trim(),
        confidence: data.confidence,
        words: data.words?.length || 0,
        lines: data.lines?.length || 0
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  },

  /**
   * Cleanup al descargar el servicio
   */
  async cleanup() {
    if (this._worker) {
      await this._worker.terminate();
      this._worker = null;
    }
  }
};
