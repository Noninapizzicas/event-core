/**
 * Local PDFjs Service
 *
 * Servicio avanzado de PDF con pdfjs-dist.
 * Extrae texto con posicionamiento, renderiza páginas, obtiene metadata.
 * No requiere credenciales externas.
 *
 * Eventos:
 * - local.pdfjs.extract.request -> local.pdfjs.extract.response
 * - local.pdfjs.render.request -> local.pdfjs.render.response
 * - local.pdfjs.info.request -> local.pdfjs.info.response
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
 *   "service": "local.pdfjs",
 *   "action": "extract",
 *   "pdf": "{{ globalPath(trigger.file.path) }}"
 * }
 *
 * // Acceso al resultado:
 * {{ steps.mi-step.data.text }}
 * {{ steps.mi-step.data.pages }}
 *
 * @version 1.0.0
 * @created 2026-01-13
 */

const fs = require('fs');
const path = require('path');

// Lazy load pdfjs-dist (v5+ usa ES modules)
let pdfjsLib = null;
let pdfjsLoadPromise = null;

const loadPdfjs = async () => {
  if (pdfjsLib) return pdfjsLib;

  if (!pdfjsLoadPromise) {
    pdfjsLoadPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
      .then(module => {
        pdfjsLib = module;
        return pdfjsLib;
      })
      .catch(e => {
        pdfjsLoadPromise = null;
        throw new Error(`pdfjs-dist not installed or incompatible: ${e.message}`);
      });
  }

  return pdfjsLoadPromise;
};

module.exports = {
  name: 'local.pdfjs',
  description: 'Servicio avanzado de PDF con pdfjs-dist',

  functions: {
    extract: {
      event: 'local.pdfjs.extract.request',
      description: 'Extraer texto de PDF con posicionamiento opcional',
      input: {
        pdf: {
          type: 'string',
          description: 'PDF en base64 o path al archivo',
          required: true
        },
        pages: {
          type: 'string',
          description: 'Páginas a extraer: "all", "1-5", "1,3,5" (default: all)',
          default: 'all'
        },
        includePositions: {
          type: 'boolean',
          description: 'Incluir posiciones x,y de cada texto',
          default: false
        }
      },
      output: {
        success: { type: 'boolean', description: 'Si la operacion fue exitosa' },
        data: {
          type: 'object',
          description: 'Datos extraidos (NOTA: acceder via steps.ID.data.text)',
          properties: {
            text: { type: 'string', description: 'Texto completo extraido' },
            pages: { type: 'number', description: 'Numero de paginas' },
            pageTexts: { type: 'array', description: 'Texto por pagina' },
            metadata: { type: 'object', description: 'Metadata del PDF' }
          }
        },
        error: { type: 'string', description: 'Mensaje de error si success=false' }
      }
    },

    render: {
      event: 'local.pdfjs.render.request',
      description: 'Renderizar página de PDF a imagen',
      input: {
        pdf: {
          type: 'string',
          description: 'PDF en base64 o path al archivo',
          required: true
        },
        page: {
          type: 'number',
          description: 'Número de página a renderizar (1-based)',
          default: 1
        },
        scale: {
          type: 'number',
          description: 'Escala de renderizado (1.0 = 100%)',
          default: 1.5
        }
      },
      output: {
        success: { type: 'boolean' },
        data: {
          type: 'object',
          properties: {
            image: { type: 'string', description: 'Imagen PNG en base64' },
            width: { type: 'number', description: 'Ancho en pixels' },
            height: { type: 'number', description: 'Alto en pixels' }
          }
        },
        error: { type: 'string' }
      }
    },

    info: {
      event: 'local.pdfjs.info.request',
      description: 'Obtener información y metadata del PDF',
      input: {
        pdf: {
          type: 'string',
          description: 'PDF en base64 o path al archivo',
          required: true
        }
      },
      output: {
        success: { type: 'boolean' },
        data: {
          type: 'object',
          properties: {
            pages: { type: 'number', description: 'Número de páginas' },
            metadata: { type: 'object', description: 'Metadata del documento' },
            outline: { type: 'array', description: 'Índice/bookmarks del PDF' }
          }
        },
        error: { type: 'string' }
      }
    }
  },

  /**
   * Detectar si el string es base64 de PDF por magic bytes
   * PDF en base64 empieza con "JVBERi" (que es "%PDF-" en base64)
   *
   * LECCION #12: Detectar magic bytes ANTES de verificar si es path
   */
  isPdfBase64(str) {
    if (!str || typeof str !== 'string') return false;
    return str.startsWith('JVBERi');
  },

  /**
   * Convertir base64 a Uint8Array (formato que pdfjs necesita)
   */
  base64ToUint8Array(base64) {
    const base64Data = base64.replace(/^data:application\/pdf;base64,/, '');
    const binaryString = Buffer.from(base64Data, 'base64');
    return new Uint8Array(binaryString);
  },

  /**
   * Resolver input: base64, path, o @/ path
   * @returns {Promise<{data: Uint8Array, error: string|null}>}
   */
  async resolveInput(input) {
    // Data URI completo
    if (input.startsWith('data:application/pdf;base64,')) {
      return { data: this.base64ToUint8Array(input), error: null };
    }

    // Base64 puro (detectado por magic bytes)
    if (this.isPdfBase64(input)) {
      return { data: this.base64ToUint8Array(input), error: null };
    }

    // Path de archivo
    if (input.startsWith('/') || input.startsWith('./') || input.startsWith('@/')) {
      let filePath = input;

      // Convertir @/ a ruta real (data/)
      if (input.startsWith('@/')) {
        filePath = input.replace('@/', './data/');
      }

      if (!fs.existsSync(filePath)) {
        return { data: null, error: `PDF file not found: ${filePath}` };
      }

      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        return { data: null, error: `Path is not a file: ${filePath}` };
      }

      const buffer = fs.readFileSync(filePath);
      return { data: new Uint8Array(buffer), error: null };
    }

    // Intentar como base64
    try {
      const buffer = Buffer.from(input, 'base64');
      // Verificar magic bytes de PDF
      if (buffer.slice(0, 5).toString() !== '%PDF-') {
        return { data: null, error: 'Invalid input: not a valid PDF' };
      }
      return { data: new Uint8Array(buffer), error: null };
    } catch (e) {
      return { data: null, error: 'Invalid input: not a valid file path or base64' };
    }
  },

  /**
   * Parsear rango de páginas
   * @param {string} pagesStr - "all", "1-5", "1,3,5"
   * @param {number} totalPages
   * @returns {number[]}
   */
  parsePageRange(pagesStr, totalPages) {
    if (!pagesStr || pagesStr === 'all') {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }

    const pages = new Set();

    pagesStr.split(',').forEach(part => {
      part = part.trim();
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(n => parseInt(n.trim()));
        for (let i = start; i <= Math.min(end, totalPages); i++) {
          if (i >= 1) pages.add(i);
        }
      } else {
        const num = parseInt(part);
        if (num >= 1 && num <= totalPages) pages.add(num);
      }
    });

    return Array.from(pages).sort((a, b) => a - b);
  },

  /**
   * Extraer texto de PDF
   *
   * LECCION #7: Validar TODOS los parametros al inicio
   * LECCION #14: Devolver estructura consistente
   */
  async extract({ pdf, pages = 'all', includePositions = false } = {}) {
    // === VALIDACION DE ENTRADA (Leccion #7) ===
    if (!pdf) {
      return {
        success: false,
        error: 'Parameter "pdf" is required',
        data: { text: '', pages: 0, pageTexts: [], metadata: {} }
      };
    }

    if (typeof pdf !== 'string') {
      return {
        success: false,
        error: `Invalid pdf parameter: expected string, got ${typeof pdf}`,
        data: { text: '', pages: 0, pageTexts: [], metadata: {} }
      };
    }

    if (pdf.trim() === '') {
      return {
        success: false,
        error: 'Parameter "pdf" cannot be empty',
        data: { text: '', pages: 0, pageTexts: [], metadata: {} }
      };
    }

    try {
      const pdfjs = await loadPdfjs();

      // Resolver input
      const { data, error: resolveError } = await this.resolveInput(pdf);
      if (resolveError) {
        return {
          success: false,
          error: resolveError,
          data: { text: '', pages: 0, pageTexts: [], metadata: {} }
        };
      }

      // Cargar documento
      const loadingTask = pdfjs.getDocument({ data });
      const pdfDoc = await loadingTask.promise;

      // Obtener metadata
      const metadata = await pdfDoc.getMetadata().catch(() => ({}));

      // Determinar páginas a procesar
      const pageNumbers = this.parsePageRange(pages, pdfDoc.numPages);

      // Extraer texto de cada página
      const pageTexts = [];
      const allText = [];

      for (const pageNum of pageNumbers) {
        const page = await pdfDoc.getPage(pageNum);
        const textContent = await page.getTextContent();

        if (includePositions) {
          // Con posiciones
          const items = textContent.items.map(item => ({
            text: item.str,
            x: item.transform[4],
            y: item.transform[5],
            width: item.width,
            height: item.height
          }));
          pageTexts.push({ page: pageNum, items });
          allText.push(items.map(i => i.text).join(' '));
        } else {
          // Solo texto
          const text = textContent.items.map(item => item.str).join(' ');
          pageTexts.push({ page: pageNum, text });
          allText.push(text);
        }
      }

      return {
        success: true,
        data: {
          text: allText.join('\n\n'),
          pages: pdfDoc.numPages,
          pagesExtracted: pageNumbers.length,
          pageTexts,
          metadata: {
            title: metadata.info?.Title || '',
            author: metadata.info?.Author || '',
            subject: metadata.info?.Subject || '',
            creator: metadata.info?.Creator || '',
            producer: metadata.info?.Producer || '',
            creationDate: metadata.info?.CreationDate || '',
            modDate: metadata.info?.ModDate || ''
          },
          textLength: allText.join('').length
        }
      };

    } catch (error) {
      return {
        success: false,
        error: `PDF extraction failed: ${error.message}`,
        data: { text: '', pages: 0, pageTexts: [], metadata: {} }
      };
    }
  },

  /**
   * Obtener información del PDF sin extraer texto
   */
  async info({ pdf } = {}) {
    // === VALIDACION ===
    if (!pdf || typeof pdf !== 'string' || pdf.trim() === '') {
      return {
        success: false,
        error: 'Parameter "pdf" is required and must be a non-empty string',
        data: { pages: 0, metadata: {}, outline: [] }
      };
    }

    try {
      const pdfjs = await loadPdfjs();

      const { data, error: resolveError } = await this.resolveInput(pdf);
      if (resolveError) {
        return {
          success: false,
          error: resolveError,
          data: { pages: 0, metadata: {}, outline: [] }
        };
      }

      const loadingTask = pdfjs.getDocument({ data });
      const pdfDoc = await loadingTask.promise;

      const metadata = await pdfDoc.getMetadata().catch(() => ({}));
      const outline = await pdfDoc.getOutline().catch(() => []);

      return {
        success: true,
        data: {
          pages: pdfDoc.numPages,
          metadata: {
            title: metadata.info?.Title || '',
            author: metadata.info?.Author || '',
            subject: metadata.info?.Subject || '',
            creator: metadata.info?.Creator || '',
            producer: metadata.info?.Producer || '',
            creationDate: metadata.info?.CreationDate || '',
            modDate: metadata.info?.ModDate || '',
            keywords: metadata.info?.Keywords || '',
            pdfVersion: metadata.info?.PDFFormatVersion || ''
          },
          outline: outline ? outline.map(item => ({
            title: item.title,
            dest: item.dest
          })) : []
        }
      };

    } catch (error) {
      return {
        success: false,
        error: `PDF info failed: ${error.message}`,
        data: { pages: 0, metadata: {}, outline: [] }
      };
    }
  },

  /**
   * Renderizar página a imagen (requiere canvas en Node.js)
   * NOTA: Esta función requiere node-canvas instalado
   */
  async render({ pdf, page = 1, scale = 1.5 } = {}) {
    // === VALIDACION ===
    if (!pdf || typeof pdf !== 'string' || pdf.trim() === '') {
      return {
        success: false,
        error: 'Parameter "pdf" is required',
        data: { image: '', width: 0, height: 0 }
      };
    }

    try {
      const pdfjs = await loadPdfjs();

      // Verificar canvas
      let createCanvas;
      try {
        const canvas = require('canvas');
        createCanvas = canvas.createCanvas;
      } catch (e) {
        return {
          success: false,
          error: 'canvas not installed. Run: npm install canvas',
          data: { image: '', width: 0, height: 0 }
        };
      }

      const { data, error: resolveError } = await this.resolveInput(pdf);
      if (resolveError) {
        return {
          success: false,
          error: resolveError,
          data: { image: '', width: 0, height: 0 }
        };
      }

      const loadingTask = pdfjs.getDocument({ data });
      const pdfDoc = await loadingTask.promise;

      if (page < 1 || page > pdfDoc.numPages) {
        return {
          success: false,
          error: `Invalid page number: ${page}. PDF has ${pdfDoc.numPages} pages.`,
          data: { image: '', width: 0, height: 0 }
        };
      }

      const pdfPage = await pdfDoc.getPage(page);
      const viewport = pdfPage.getViewport({ scale });

      const canvas = createCanvas(viewport.width, viewport.height);
      const context = canvas.getContext('2d');

      await pdfPage.render({
        canvasContext: context,
        viewport
      }).promise;

      const imageBase64 = canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');

      return {
        success: true,
        data: {
          image: imageBase64,
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
          page,
          scale
        }
      };

    } catch (error) {
      return {
        success: false,
        error: `PDF render failed: ${error.message}`,
        data: { image: '', width: 0, height: 0 }
      };
    }
  },

  /**
   * Cleanup
   */
  async cleanup() {
    // pdfjs no mantiene estado global que limpiar
  }
};
