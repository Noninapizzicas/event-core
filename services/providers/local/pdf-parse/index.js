/**
 * Local PDF Parse Service
 *
 * Servicio local para extraer texto de archivos PDF.
 * No requiere credenciales externas.
 *
 * Eventos:
 * - local.pdf-parse.extract.request -> local.pdf-parse.extract.response
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
 *   "service": "local.pdf-parse",
 *   "action": "extract",
 *   "pdf": "{{ globalPath(trigger.file.path) }}"
 * }
 *
 * // Acceso al resultado:
 * {{ steps.mi-step.data.text }}
 * {{ steps.mi-step.data.pages }}
 */

const fs = require('fs');
const path = require('path');

// Lazy load pdf-parse para evitar errores si no esta instalado
let pdfParse = null;

const loadPdfParse = () => {
  if (!pdfParse) {
    try {
      pdfParse = require('pdf-parse');
    } catch (e) {
      throw new Error('pdf-parse not installed. Run: npm install pdf-parse');
    }
  }
  return pdfParse;
};

module.exports = {
  name: 'local.pdf-parse',
  description: 'Servicio local para extraer texto de PDFs usando pdf-parse',

  functions: {
    extract: {
      event: 'local.pdf-parse.extract.request',
      description: 'Extraer texto de un archivo PDF',
      input: {
        pdf: {
          type: 'string',
          description: 'PDF en base64 o path al archivo',
          required: true
        },
        maxPages: {
          type: 'number',
          description: 'Maximo de paginas a procesar (0 = todas)',
          default: 0
        }
      },
      output: {
        success: { type: 'boolean', description: 'Si la extraccion fue exitosa' },
        data: {
          type: 'object',
          description: 'Datos extraidos (NOTA: acceder via steps.ID.data.text)',
          properties: {
            text: { type: 'string', description: 'Texto completo extraido' },
            pages: { type: 'number', description: 'Numero de paginas' },
            info: { type: 'object', description: 'Metadata del PDF (titulo, autor, etc.)' }
          }
        },
        error: { type: 'string', description: 'Mensaje de error si success=false' }
      }
    }
  },

  /**
   * Detectar si el string es base64 de PDF por magic bytes
   * PDF en base64 empieza con "JVBERi" (que es "%PDF-" en base64)
   *
   * LECCION #12: Detectar magic bytes ANTES de verificar si es path
   * porque algunos base64 pueden parecer paths
   */
  isPdfBase64(str) {
    if (!str || typeof str !== 'string') return false;
    // PDF magic bytes en base64
    return str.startsWith('JVBERi');
  },

  /**
   * Convertir base64 a Buffer
   */
  base64ToBuffer(base64) {
    // Remover data URI prefix si existe
    const base64Data = base64.replace(/^data:application\/pdf;base64,/, '');
    return Buffer.from(base64Data, 'base64');
  },

  /**
   * Extraer texto de PDF
   *
   * LECCION #7: Validar TODOS los parametros al inicio
   * LECCION #14: Devolver estructura consistente para evitar confusion
   *              El resultado se accede como: steps.ID.data.text (NO steps.ID.text)
   */
  async extract({ pdf, maxPages = 0 } = {}) {
    // === VALIDACION DE ENTRADA (Leccion #7) ===
    if (!pdf) {
      return {
        success: false,
        error: 'Parameter "pdf" is required',
        data: { text: '', pages: 0, info: {} }
      };
    }

    if (typeof pdf !== 'string') {
      return {
        success: false,
        error: `Invalid pdf parameter: expected string, got ${typeof pdf}`,
        data: { text: '', pages: 0, info: {} }
      };
    }

    if (pdf.trim() === '') {
      return {
        success: false,
        error: 'Parameter "pdf" cannot be empty',
        data: { text: '', pages: 0, info: {} }
      };
    }

    // Cargar libreria
    const parser = loadPdfParse();

    // === DETERMINAR FUENTE DEL PDF ===
    let pdfBuffer;

    try {
      // LECCION #12: Verificar base64 por magic bytes PRIMERO
      if (pdf.startsWith('data:application/pdf;base64,')) {
        // Data URI completo
        pdfBuffer = this.base64ToBuffer(pdf);
      } else if (this.isPdfBase64(pdf)) {
        // Base64 puro (empieza con JVBERi)
        pdfBuffer = this.base64ToBuffer(pdf);
      } else if (pdf.startsWith('/') || pdf.startsWith('./') || pdf.startsWith('@/')) {
        // Es un path de archivo
        let filePath = pdf;

        // Convertir @/ a ruta real (data/)
        if (pdf.startsWith('@/')) {
          filePath = pdf.replace('@/', './data/');
        }

        // Verificar que el archivo existe
        if (!fs.existsSync(filePath)) {
          return {
            success: false,
            error: `PDF file not found: ${filePath}`,
            data: { text: '', pages: 0, info: {} }
          };
        }

        // Verificar que es un archivo, no directorio
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) {
          return {
            success: false,
            error: `Path is not a file: ${filePath}`,
            data: { text: '', pages: 0, info: {} }
          };
        }

        // Leer archivo
        pdfBuffer = fs.readFileSync(filePath);
      } else {
        // Intentar como base64 de todas formas
        try {
          pdfBuffer = Buffer.from(pdf, 'base64');
          // Verificar que parece un PDF (magic bytes: %PDF-)
          if (pdfBuffer.slice(0, 5).toString() !== '%PDF-') {
            return {
              success: false,
              error: 'Invalid input: not a valid PDF file path or base64 content',
              data: { text: '', pages: 0, info: {} }
            };
          }
        } catch (e) {
          return {
            success: false,
            error: 'Invalid input: could not parse as file path or base64',
            data: { text: '', pages: 0, info: {} }
          };
        }
      }

      // Verificar que el buffer no esta vacio
      if (!pdfBuffer || pdfBuffer.length === 0) {
        return {
          success: false,
          error: 'PDF buffer is empty',
          data: { text: '', pages: 0, info: {} }
        };
      }

      // === PARSEAR PDF ===
      const options = {};
      if (maxPages > 0) {
        options.max = maxPages;
      }

      const result = await parser(pdfBuffer, options);

      // === RESPUESTA EXITOSA ===
      // LECCION #14: Estructura clara y documentada
      // Acceso: steps.ID.data.text, steps.ID.data.pages, etc.
      return {
        success: true,
        data: {
          text: result.text || '',
          pages: result.numpages || 0,
          info: {
            title: result.info?.Title || '',
            author: result.info?.Author || '',
            subject: result.info?.Subject || '',
            creator: result.info?.Creator || '',
            producer: result.info?.Producer || '',
            creationDate: result.info?.CreationDate || '',
            modDate: result.info?.ModDate || ''
          },
          version: result.version || '',
          textLength: (result.text || '').length
        }
      };

    } catch (error) {
      // === MANEJO DE ERRORES ===
      // Devolver error descriptivo, NUNCA crashear
      return {
        success: false,
        error: `PDF parsing failed: ${error.message}`,
        data: { text: '', pages: 0, info: {} }
      };
    }
  },

  /**
   * Cleanup - no hay recursos que liberar en este servicio
   */
  async cleanup() {
    // pdf-parse no mantiene estado, nada que limpiar
  }
};
