/**
 * Local Scribe OCR Service
 *
 * OCR avanzado usando scribe.js-ocr (basado en Tesseract WASM).
 * Soporta imágenes y PDFs directamente. No requiere Tesseract instalado.
 *
 * Eventos:
 * - local.scribe-ocr.extract.request -> local.scribe-ocr.extract.response
 *
 * LECCIONES APLICADAS (de contexto/lecciones-aprendidas-flow-engine.json):
 * - Bug #7: Validar parametros al inicio (no undefined.method())
 * - Bug #12: Detectar base64 por magic bytes ANTES de verificar si es path
 * - Bug #14: Documentar estructura exacta de respuesta
 *
 * @example
 * // Desde flow-engine:
 * {
 *   "type": "service",
 *   "service": "local.scribe-ocr",
 *   "action": "extract",
 *   "input": "{{ globalPath(trigger.file.path) }}",
 *   "lang": "spa"
 * }
 *
 * // Acceso al resultado:
 * {{ steps.mi-step.data.text }}
 *
 * @version 1.0.0
 * @created 2026-01-13
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Lazy load scribe.js-ocr (ES module con default export)
let scribe = null;
let scribeLoadPromise = null;

const loadScribe = async () => {
  if (scribe) return scribe;

  if (!scribeLoadPromise) {
    scribeLoadPromise = import('scribe.js-ocr')
      .then(module => {
        // scribe.js-ocr usa default export
        scribe = module.default;
        return scribe;
      })
      .catch(e => {
        scribeLoadPromise = null;
        throw new Error(`scribe.js-ocr not installed. Run: npm install scribe.js-ocr`);
      });
  }

  return scribeLoadPromise;
};

module.exports = {
  name: 'local.scribe-ocr',
  description: 'OCR avanzado con scribe.js-ocr (Tesseract WASM)',

  functions: {
    extract: {
      event: 'local.scribe-ocr.extract.request',
      description: 'Extraer texto de imagen o PDF usando OCR',
      input: {
        input: {
          type: 'string',
          description: 'Imagen/PDF en base64 o path al archivo',
          required: true
        },
        lang: {
          type: 'string',
          description: 'Código de idioma: spa, eng, fra, deu, ita, etc.',
          default: 'eng'
        },
        oem: {
          type: 'number',
          description: 'OCR Engine Mode: 0=Legacy, 1=LSTM, 2=Legacy+LSTM, 3=Default',
          default: 1
        },
        psm: {
          type: 'number',
          description: 'Page Segmentation Mode: 3=Auto, 6=Block, 11=Sparse, 13=Raw line',
          default: 6
        }
      },
      output: {
        success: { type: 'boolean', description: 'Si la operacion fue exitosa' },
        data: {
          type: 'object',
          description: 'Datos extraidos (NOTA: acceder via steps.ID.data.text)',
          properties: {
            text: { type: 'string', description: 'Texto extraido' },
            confidence: { type: 'number', description: 'Confianza promedio 0-100' },
            pages: { type: 'number', description: 'Páginas procesadas' },
            lang: { type: 'string', description: 'Idioma usado' }
          }
        },
        error: { type: 'string', description: 'Mensaje de error si success=false' }
      }
    }
  },

  /**
   * Detectar tipo de archivo por magic bytes en base64
   *
   * LECCION #12: Detectar magic bytes ANTES de verificar si es path
   */
  detectType(str) {
    if (!str || typeof str !== 'string') return null;

    // Magic bytes en base64
    if (str.startsWith('/9j/')) return { type: 'image', mime: 'image/jpeg', ext: '.jpg' };
    if (str.startsWith('iVBORw')) return { type: 'image', mime: 'image/png', ext: '.png' };
    if (str.startsWith('R0lGOD')) return { type: 'image', mime: 'image/gif', ext: '.gif' };
    if (str.startsWith('UklGR')) return { type: 'image', mime: 'image/webp', ext: '.webp' };
    if (str.startsWith('Qk')) return { type: 'image', mime: 'image/bmp', ext: '.bmp' };
    if (str.startsWith('SUkq') || str.startsWith('TU0A')) return { type: 'image', mime: 'image/tiff', ext: '.tiff' };
    if (str.startsWith('JVBERi')) return { type: 'pdf', mime: 'application/pdf', ext: '.pdf' };

    return null;
  },

  /**
   * Resolver input y preparar archivo temporal si es base64
   * scribe.js-ocr necesita un path de archivo, no base64 directo
   *
   * @returns {Promise<{filePath: string, tempFile: boolean, error: string|null}>}
   */
  async resolveInput(input) {
    // Data URI - extraer base64
    if (input.startsWith('data:')) {
      const matches = input.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        return { filePath: null, tempFile: false, error: 'Invalid data URI format' };
      }
      const mimeType = matches[1];
      const base64Data = matches[2];

      // Determinar extensión
      let ext = '.tmp';
      if (mimeType.includes('jpeg') || mimeType.includes('jpg')) ext = '.jpg';
      else if (mimeType.includes('png')) ext = '.png';
      else if (mimeType.includes('pdf')) ext = '.pdf';
      else if (mimeType.includes('gif')) ext = '.gif';
      else if (mimeType.includes('webp')) ext = '.webp';
      else if (mimeType.includes('tiff')) ext = '.tiff';

      // Escribir archivo temporal
      const tempPath = path.join(os.tmpdir(), `scribe-ocr-${Date.now()}${ext}`);
      fs.writeFileSync(tempPath, Buffer.from(base64Data, 'base64'));
      return { filePath: tempPath, tempFile: true, error: null };
    }

    // Detectar base64 por magic bytes
    const detected = this.detectType(input);
    if (detected) {
      const tempPath = path.join(os.tmpdir(), `scribe-ocr-${Date.now()}${detected.ext}`);
      fs.writeFileSync(tempPath, Buffer.from(input, 'base64'));
      return { filePath: tempPath, tempFile: true, error: null };
    }

    // Es un path de archivo
    if (input.startsWith('/') || input.startsWith('./') || input.startsWith('@/')) {
      let filePath = input;

      // Convertir @/ a ruta real (data/)
      if (input.startsWith('@/')) {
        filePath = input.replace('@/', './data/');
      }

      if (!fs.existsSync(filePath)) {
        return { filePath: null, tempFile: false, error: `File not found: ${filePath}` };
      }

      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        return { filePath: null, tempFile: false, error: `Path is not a file: ${filePath}` };
      }

      return { filePath, tempFile: false, error: null };
    }

    // Intentar como base64 genérico
    try {
      const buffer = Buffer.from(input, 'base64');
      // Detectar por magic bytes del buffer
      const magic = buffer.slice(0, 8).toString('hex');

      let ext = '.tmp';
      if (magic.startsWith('ffd8ff')) ext = '.jpg';
      else if (magic.startsWith('89504e47')) ext = '.png';
      else if (magic.startsWith('25504446')) ext = '.pdf';
      else if (magic.startsWith('47494638')) ext = '.gif';

      const tempPath = path.join(os.tmpdir(), `scribe-ocr-${Date.now()}${ext}`);
      fs.writeFileSync(tempPath, buffer);
      return { filePath: tempPath, tempFile: true, error: null };
    } catch (e) {
      return { filePath: null, tempFile: false, error: 'Invalid input: not a valid file path or base64' };
    }
  },

  /**
   * Limpiar archivo temporal
   */
  cleanupTemp(filePath, isTemp) {
    if (isTemp && filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        // Ignorar errores de limpieza
      }
    }
  },

  /**
   * Extraer texto de imagen o PDF usando OCR
   *
   * LECCION #7: Validar TODOS los parametros al inicio
   * LECCION #14: Devolver estructura consistente
   */
  async extract({ input, lang = 'eng', oem = 1, psm = 6 } = {}) {
    // === VALIDACION DE ENTRADA (Leccion #7) ===
    if (!input) {
      return {
        success: false,
        error: 'Parameter "input" is required',
        data: { text: '', confidence: 0, pages: 0, lang: '' }
      };
    }

    if (typeof input !== 'string') {
      return {
        success: false,
        error: `Invalid input parameter: expected string, got ${typeof input}`,
        data: { text: '', confidence: 0, pages: 0, lang: '' }
      };
    }

    if (input.trim() === '') {
      return {
        success: false,
        error: 'Parameter "input" cannot be empty',
        data: { text: '', confidence: 0, pages: 0, lang: '' }
      };
    }

    let filePath = null;
    let isTemp = false;

    try {
      const scribeLib = await loadScribe();

      // Resolver input
      const resolved = await this.resolveInput(input);
      if (resolved.error) {
        return {
          success: false,
          error: resolved.error,
          data: { text: '', confidence: 0, pages: 0, lang: '' }
        };
      }

      filePath = resolved.filePath;
      isTemp = resolved.tempFile;

      // Configurar opciones de scribe antes de OCR
      if (scribeLib.setOptions) {
        await scribeLib.setOptions({ lang, oem, psm });
      }

      // Ejecutar OCR con extractText (acepta array de paths)
      const result = await scribeLib.extractText([filePath]);

      // Extraer datos del resultado
      // extractText devuelve string o array dependiendo de la versión
      let text = '';
      let confidence = 0;
      let pages = 1;

      if (typeof result === 'string') {
        text = result;
      } else if (Array.isArray(result)) {
        text = result.join('\n\n');
        pages = result.length;
      } else if (result && typeof result === 'object') {
        text = result.text || result.data || '';
        confidence = result.confidence || 0;
        pages = result.pages || 1;
      }

      // Limpiar archivo temporal
      this.cleanupTemp(filePath, isTemp);

      return {
        success: true,
        data: {
          text: typeof text === 'string' ? text.trim() : String(text),
          confidence: typeof confidence === 'number' ? Math.round(confidence) : 0,
          pages,
          lang,
          textLength: String(text).length
        }
      };

    } catch (error) {
      // Limpiar archivo temporal en caso de error
      this.cleanupTemp(filePath, isTemp);

      return {
        success: false,
        error: `OCR failed: ${error.message}`,
        data: { text: '', confidence: 0, pages: 0, lang: '' }
      };
    }
  },

  /**
   * Cleanup
   */
  async cleanup() {
    // No hay estado global que limpiar
  }
};
