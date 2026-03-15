/**
 * Local PDF to PNG Service
 *
 * Convierte páginas de PDF a imágenes PNG usando pdftoppm (Poppler).
 * Requiere poppler-utils instalado: apt-get install poppler-utils
 *
 * Eventos:
 * - local.pdf-to-png.convert.request -> local.pdf-to-png.convert.response
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
 *   "service": "local.pdf-to-png",
 *   "action": "convert",
 *   "pdf": "{{ globalPath(trigger.file.path) }}",
 *   "pages": [1, 2, 3]
 * }
 *
 * // Acceso al resultado:
 * {{ steps.mi-step.data.images }}
 * {{ steps.mi-step.data.images[0].content }}
 *
 * @version 2.0.0
 * @created 2026-01-13
 * @updated 2026-01-25 - Cambio a pdftoppm (Poppler) para mejor soporte de fuentes
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

module.exports = {
  name: 'local.pdf-to-png',
  description: 'Convertir páginas de PDF a imágenes PNG',

  functions: {
    convert: {
      event: 'local.pdf-to-png.convert.request',
      description: 'Convertir páginas de PDF a PNG',
      input: {
        pdf: {
          type: 'string',
          description: 'PDF en base64 o path al archivo',
          required: true
        },
        pages: {
          type: 'array',
          description: 'Páginas a convertir [1,2,3] (1-based). Vacío = todas',
          default: []
        },
        dpi: {
          type: 'number',
          description: 'DPI para la conversión (300 recomendado para OCR)',
          default: 300
        },
        outputFolder: {
          type: 'string',
          description: 'Carpeta para guardar PNGs (opcional)',
          default: ''
        },
        password: {
          type: 'string',
          description: 'Contraseña para PDFs encriptados',
          default: ''
        }
      },
      output: {
        success: { type: 'boolean', description: 'Si la operacion fue exitosa' },
        data: {
          type: 'object',
          description: 'Datos de las imágenes (NOTA: acceder via steps.ID.data.images)',
          properties: {
            images: { type: 'array', description: 'Array de imágenes PNG' },
            totalPages: { type: 'number', description: 'Total de páginas convertidas' }
          }
        },
        error: { type: 'string', description: 'Mensaje de error si success=false' }
      }
    }
  },

  /**
   * Detectar si el string es base64 de PDF por magic bytes
   * PDF en base64 empieza con "JVBERi" (que es "%PDF-" en base64)
   */
  isPdfBase64(str) {
    if (!str || typeof str !== 'string') return false;
    return str.startsWith('JVBERi');
  },

  /**
   * Resolver input: base64, path, o @/ path
   * @returns {Promise<{filePath: string, tempFile: string|null, error: string|null}>}
   */
  async resolveInput(pdf) {
    // Data URI completo
    if (pdf.startsWith('data:application/pdf;base64,')) {
      const base64Data = pdf.replace('data:application/pdf;base64,', '');
      const buffer = Buffer.from(base64Data, 'base64');
      const tempFile = path.join(os.tmpdir(), `pdf-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
      fs.writeFileSync(tempFile, buffer);
      return { filePath: tempFile, tempFile, error: null };
    }

    // Base64 puro (detectado por magic bytes)
    if (this.isPdfBase64(pdf)) {
      const buffer = Buffer.from(pdf, 'base64');
      const tempFile = path.join(os.tmpdir(), `pdf-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
      fs.writeFileSync(tempFile, buffer);
      return { filePath: tempFile, tempFile, error: null };
    }

    // Path de archivo (absoluto, relativo con ./, relativo sin ./, o @/)
    const isPath = pdf.startsWith('/') ||
                   pdf.startsWith('./') ||
                   pdf.startsWith('@/') ||
                   pdf.startsWith('data/') ||
                   fs.existsSync(pdf);

    if (isPath) {
      let filePath = pdf;

      // Convertir @/ a ruta real (data/)
      if (pdf.startsWith('@/')) {
        filePath = pdf.replace('@/', './data/');
      }

      if (!fs.existsSync(filePath)) {
        return { filePath: null, tempFile: null, error: `PDF file not found: ${filePath}` };
      }

      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        return { filePath: null, tempFile: null, error: `Path is not a file: ${filePath}` };
      }

      return { filePath, tempFile: null, error: null };
    }

    // Intentar como base64
    try {
      const buffer = Buffer.from(pdf, 'base64');
      if (buffer.slice(0, 5).toString() !== '%PDF-') {
        return { filePath: null, tempFile: null, error: 'Invalid input: not a valid PDF' };
      }
      const tempFile = path.join(os.tmpdir(), `pdf-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
      fs.writeFileSync(tempFile, buffer);
      return { filePath: tempFile, tempFile, error: null };
    } catch (e) {
      return { filePath: null, tempFile: null, error: 'Invalid input: not a valid file path or base64' };
    }
  },

  /**
   * Convertir PDF a PNG usando pdftoppm (Poppler)
   */
  async convert({ pdf, pages = [], dpi = 300, scale, outputFolder = '', password = '' } = {}) {
    // Compatibilidad: si se usa scale en lugar de dpi, convertir
    if (scale && !dpi) {
      dpi = Math.round(72 * scale); // 72 DPI base * scale
    }

    // === VALIDACION DE ENTRADA ===
    if (!pdf) {
      throw new Error('Parameter "pdf" is required');
    }

    if (typeof pdf !== 'string') {
      throw new Error(`Invalid pdf parameter: expected string, got ${typeof pdf}`);
    }

    if (pdf.trim() === '') {
      throw new Error('Parameter "pdf" cannot be empty');
    }

    let tempFile = null;
    let tempOutputDir = null;

    try {
      // Verificar que pdftoppm está disponible
      try {
        await execAsync('which pdftoppm');
      } catch (e) {
        throw new Error('pdftoppm not found. Install poppler-utils: apt-get install poppler-utils');
      }

      // Resolver input
      const resolved = await this.resolveInput(pdf);
      if (resolved.error) {
        throw new Error(resolved.error);
      }
      tempFile = resolved.tempFile;

      // Determinar carpeta de salida
      let resolvedOutputFolder = outputFolder;
      if (outputFolder && outputFolder.trim() !== '') {
        if (outputFolder.startsWith('@/')) {
          resolvedOutputFolder = outputFolder.replace('@/', './data/');
        }
        if (!fs.existsSync(resolvedOutputFolder)) {
          fs.mkdirSync(resolvedOutputFolder, { recursive: true });
        }
      } else {
        // Usar carpeta temporal si no se especifica output
        tempOutputDir = path.join(os.tmpdir(), `pdfpng-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        fs.mkdirSync(tempOutputDir, { recursive: true });
        resolvedOutputFolder = tempOutputDir;
      }

      // Nombre base para los archivos de salida
      const pdfBasename = path.basename(resolved.filePath, '.pdf');
      const outputPrefix = path.join(resolvedOutputFolder, pdfBasename);

      // Construir comando pdftoppm
      let cmd = `pdftoppm -png -r ${dpi}`;

      // Añadir contraseña si se especifica
      if (password && password.trim() !== '') {
        cmd += ` -upw "${password}"`;
      }

      // Añadir páginas específicas
      if (Array.isArray(pages) && pages.length > 0) {
        const firstPage = Math.min(...pages);
        const lastPage = Math.max(...pages);
        cmd += ` -f ${firstPage} -l ${lastPage}`;
      }

      // Archivo de entrada y prefijo de salida
      cmd += ` "${resolved.filePath}" "${outputPrefix}"`;

      // Ejecutar conversión
      await execAsync(cmd);

      // Leer archivos generados
      const files = fs.readdirSync(resolvedOutputFolder)
        .filter(f => f.startsWith(pdfBasename) && f.endsWith('.png'))
        .sort();

      const images = [];
      for (const file of files) {
        const filePath = path.join(resolvedOutputFolder, file);
        const content = fs.readFileSync(filePath);

        // Extraer número de página del nombre (formato: basename-1.png, basename-01.png, etc)
        const match = file.match(/-(\d+)\.png$/);
        const pageNumber = match ? parseInt(match[1], 10) : images.length + 1;

        // Si se especificaron páginas específicas, filtrar
        if (Array.isArray(pages) && pages.length > 0 && !pages.includes(pageNumber)) {
          // Si estamos en carpeta temporal, eliminar archivo no deseado
          if (tempOutputDir) {
            fs.unlinkSync(filePath);
          }
          continue;
        }

        images.push({
          pageNumber,
          name: file,
          content: content.toString('base64'),
          path: outputFolder ? filePath : '', // Solo incluir path si se especificó outputFolder
          width: null,  // pdftoppm no proporciona dimensiones directamente
          height: null
        });

        // Si estamos en carpeta temporal, eliminar después de leer
        if (tempOutputDir) {
          fs.unlinkSync(filePath);
        }
      }

      // Limpiar archivos temporales
      if (tempFile) {
        fs.unlinkSync(tempFile);
      }
      if (tempOutputDir) {
        fs.rmdirSync(tempOutputDir);
      }

      return {
        images,
        totalPages: images.length,
        dpi,
        outputFolder: outputFolder || null
      };

    } catch (error) {
      // Limpiar archivos temporales en caso de error
      if (tempFile && fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
      if (tempOutputDir && fs.existsSync(tempOutputDir)) {
        const files = fs.readdirSync(tempOutputDir);
        for (const f of files) {
          fs.unlinkSync(path.join(tempOutputDir, f));
        }
        fs.rmdirSync(tempOutputDir);
      }
      throw new Error(`PDF to PNG conversion failed: ${error.message}`);
    }
  },

  async cleanup() {
    // No hay estado global que limpiar
  }
};
