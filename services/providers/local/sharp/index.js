/**
 * Local Sharp Image Processing Service
 *
 * Servicio local para procesamiento de imágenes usando Sharp.
 * No requiere credenciales externas.
 *
 * Eventos:
 * - local.sharp.prepare-ocr.request -> local.sharp.prepare-ocr.response
 * - local.sharp.resize.request -> local.sharp.resize.response
 * - local.sharp.convert.request -> local.sharp.convert.response
 * - local.sharp.info.request -> local.sharp.info.response
 * - local.sharp.crop.request -> local.sharp.crop.response
 * - local.sharp.trim.request -> local.sharp.trim.response
 */

const fs = require('fs');
const path = require('path');

// Lazy load Sharp
let sharp = null;

const loadSharp = () => {
  if (!sharp) {
    try {
      sharp = require('sharp');
    } catch (e) {
      throw new Error('sharp not installed. Run: npm install sharp');
    }
  }
  return sharp;
};

module.exports = {
  name: 'local.sharp',
  description: 'Servicio local de procesamiento de imágenes usando Sharp',

  functions: {
    'prepare-ocr': {
      event: 'local.sharp.prepare-ocr.request',
      description: 'Prepara imagen para OCR: grayscale, contraste, nitidez',
      input: {
        image: {
          type: 'string',
          description: 'Imagen en base64 o path al archivo',
          required: true
        },
        options: {
          type: 'object',
          description: 'Opciones de procesamiento',
          properties: {
            trim: { type: 'boolean', default: true, description: 'Recortar bordes/fondo uniforme' },
            trimThreshold: { type: 'number', default: 10, description: 'Tolerancia de color para trim (0-255)' },
            maxWidth: { type: 'number', default: 2400, description: 'Ancho máximo (sin agrandar)' },
            maxHeight: { type: 'number', default: 3200, description: 'Alto máximo (sin agrandar)' },
            grayscale: { type: 'boolean', default: true },
            normalize: { type: 'boolean', default: true },
            sharpen: { type: 'boolean', default: true },
            threshold: { type: 'number', description: 'Umbral binarización (0-255), null para no aplicar' },
            denoise: { type: 'boolean', default: false }
          }
        },
        output: {
          type: 'string',
          description: 'Path donde guardar resultado (opcional, si no se especifica devuelve base64)'
        }
      },
      output: {
        image: { type: 'string', description: 'Imagen procesada en base64 o path' },
        width: { type: 'number' },
        height: { type: 'number' }
      }
    },
    resize: {
      event: 'local.sharp.resize.request',
      description: 'Redimensionar imagen',
      input: {
        image: { type: 'string', required: true },
        width: { type: 'number', description: 'Ancho en pixels' },
        height: { type: 'number', description: 'Alto en pixels' },
        fit: { type: 'string', description: 'cover, contain, fill, inside, outside', default: 'inside' },
        output: { type: 'string', description: 'Path donde guardar (opcional)' }
      },
      output: {
        image: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' }
      }
    },
    convert: {
      event: 'local.sharp.convert.request',
      description: 'Convertir formato de imagen',
      input: {
        image: { type: 'string', required: true },
        format: { type: 'string', description: 'jpeg, png, webp, tiff, avif', required: true },
        quality: { type: 'number', description: 'Calidad 1-100', default: 80 },
        output: { type: 'string', description: 'Path donde guardar (opcional)' }
      },
      output: {
        image: { type: 'string' },
        format: { type: 'string' },
        size: { type: 'number', description: 'Tamaño en bytes' }
      }
    },
    info: {
      event: 'local.sharp.info.request',
      description: 'Obtener información de imagen',
      input: {
        image: { type: 'string', required: true }
      },
      output: {
        width: { type: 'number' },
        height: { type: 'number' },
        format: { type: 'string' },
        channels: { type: 'number' },
        size: { type: 'number' }
      }
    },
    crop: {
      event: 'local.sharp.crop.request',
      description: 'Recortar imagen con coordenadas específicas',
      input: {
        image: { type: 'string', required: true },
        left: { type: 'number', description: 'Posición X desde la izquierda', required: true },
        top: { type: 'number', description: 'Posición Y desde arriba', required: true },
        width: { type: 'number', description: 'Ancho del recorte', required: true },
        height: { type: 'number', description: 'Alto del recorte', required: true },
        output: { type: 'string', description: 'Path donde guardar (opcional)' }
      },
      output: {
        image: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' }
      }
    },
    trim: {
      event: 'local.sharp.trim.request',
      description: 'Recortar bordes automáticamente (elimina fondo uniforme)',
      input: {
        image: { type: 'string', required: true },
        threshold: { type: 'number', description: 'Tolerancia de color 0-255 (default: 10)', default: 10 },
        output: { type: 'string', description: 'Path donde guardar (opcional)' }
      },
      output: {
        image: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        trimmed: { type: 'object', description: 'Información del recorte aplicado' }
      }
    }
  },

  /**
   * Obtener buffer de imagen desde base64 o path
   */
  async getImageBuffer(image) {
    if (!image || typeof image !== 'string') {
      throw new Error(`Invalid image parameter: expected string, got ${typeof image}`);
    }

    // Si es data URI, extraer base64
    if (image.startsWith('data:')) {
      const base64Data = image.split(',')[1];
      return Buffer.from(base64Data, 'base64');
    }

    // Detectar base64 por magic bytes
    const base64Prefixes = ['/9j/', 'iVBORw', 'R0lGOD', 'UklGR', 'Qk', 'SUkq', 'TU0A'];
    const looksLikeBase64 = base64Prefixes.some(p => image.startsWith(p));

    if (looksLikeBase64) {
      return Buffer.from(image, 'base64');
    }

    // Es un path de archivo
    if (!fs.existsSync(image)) {
      throw new Error(`Image file not found: ${image}`);
    }

    return fs.readFileSync(image);
  },

  /**
   * Preparar imagen para OCR
   */
  async 'prepare-ocr'({ image, options = {}, output } = {}) {
    const sharpLib = loadSharp();
    const buffer = await this.getImageBuffer(image);

    const {
      trim: doTrim = true,
      trimThreshold = 10,
      maxWidth = 2400,
      maxHeight = 3200,
      grayscale = true,
      normalize = true,
      sharpen = true,
      threshold = null,
      denoise = false
    } = options;

    // Metadata original
    const metadata = await sharpLib(buffer).metadata();

    let pipeline = sharpLib(buffer);

    // 1. Recortar bordes (elimina fondo uniforme alrededor del documento)
    if (doTrim) {
      pipeline = pipeline.trim({ threshold: trimThreshold });
    }

    // 2. Ajustar tamaño (sin agrandar, mantiene proporción)
    if (maxWidth || maxHeight) {
      pipeline = pipeline.resize({
        width: maxWidth,
        height: maxHeight,
        fit: 'inside',
        withoutEnlargement: true
      });
    }

    // 3. Escala de grises
    if (grayscale) {
      pipeline = pipeline.grayscale();
    }

    // 4. Normalizar contraste
    if (normalize) {
      pipeline = pipeline.normalize();
    }

    // 5. Reducir ruido
    if (denoise) {
      pipeline = pipeline.median(3);
    }

    // 6. Enfocar
    if (sharpen) {
      pipeline = pipeline.sharpen({
        sigma: 1,
        m1: 1,
        m2: 2
      });
    }

    // 7. Binarización (blanco/negro puro)
    if (threshold !== null && typeof threshold === 'number') {
      pipeline = pipeline.threshold(threshold);
    }

    // Procesar
    const processedBuffer = await pipeline.png().toBuffer();

    // Guardar o devolver base64
    if (output) {
      const outputDir = path.dirname(output);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      fs.writeFileSync(output, processedBuffer);

      return {
        success: true,
        image: output,
        width: metadata.width,
        height: metadata.height,
        originalSize: buffer.length,
        processedSize: processedBuffer.length
      };
    }

    return {
      success: true,
      image: processedBuffer.toString('base64'),
      width: metadata.width,
      height: metadata.height,
      originalSize: buffer.length,
      processedSize: processedBuffer.length
    };
  },

  /**
   * Redimensionar imagen
   */
  async resize({ image, width, height, fit = 'inside', output } = {}) {
    const sharpLib = loadSharp();
    const buffer = await this.getImageBuffer(image);

    if (!width && !height) {
      throw new Error('At least width or height must be specified');
    }

    const pipeline = sharpLib(buffer).resize({
      width: width || null,
      height: height || null,
      fit: fit,
      withoutEnlargement: true
    });

    const processedBuffer = await pipeline.toBuffer();
    const info = await sharpLib(processedBuffer).metadata();

    if (output) {
      const outputDir = path.dirname(output);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      fs.writeFileSync(output, processedBuffer);

      return {
        success: true,
        image: output,
        width: info.width,
        height: info.height,
        size: processedBuffer.length
      };
    }

    return {
      success: true,
      image: processedBuffer.toString('base64'),
      width: info.width,
      height: info.height,
      size: processedBuffer.length
    };
  },

  /**
   * Convertir formato
   */
  async convert({ image, format, quality = 80, output } = {}) {
    const sharpLib = loadSharp();
    const buffer = await this.getImageBuffer(image);

    const validFormats = ['jpeg', 'jpg', 'png', 'webp', 'tiff', 'avif'];
    const normalizedFormat = format.toLowerCase();

    if (!validFormats.includes(normalizedFormat)) {
      throw new Error(`Invalid format: ${format}. Valid: ${validFormats.join(', ')}`);
    }

    const formatMethod = normalizedFormat === 'jpg' ? 'jpeg' : normalizedFormat;

    let pipeline = sharpLib(buffer);

    // Aplicar formato con calidad
    if (['jpeg', 'jpg', 'webp', 'avif'].includes(normalizedFormat)) {
      pipeline = pipeline[formatMethod]({ quality });
    } else {
      pipeline = pipeline[formatMethod]();
    }

    const processedBuffer = await pipeline.toBuffer();

    if (output) {
      const outputDir = path.dirname(output);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      fs.writeFileSync(output, processedBuffer);

      return {
        success: true,
        image: output,
        format: formatMethod,
        size: processedBuffer.length
      };
    }

    return {
      success: true,
      image: processedBuffer.toString('base64'),
      format: formatMethod,
      size: processedBuffer.length
    };
  },

  /**
   * Obtener información de imagen
   */
  async info({ image } = {}) {
    const sharpLib = loadSharp();
    const buffer = await this.getImageBuffer(image);

    const metadata = await sharpLib(buffer).metadata();

    return {
      success: true,
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      channels: metadata.channels,
      space: metadata.space,
      depth: metadata.depth,
      density: metadata.density,
      hasAlpha: metadata.hasAlpha,
      size: buffer.length
    };
  },

  /**
   * Recortar imagen con coordenadas específicas
   */
  async crop({ image, left, top, width, height, output } = {}) {
    const sharpLib = loadSharp();
    const buffer = await this.getImageBuffer(image);

    // Validar parámetros
    if (left === undefined || top === undefined || !width || !height) {
      throw new Error('crop requires left, top, width, and height');
    }

    // Obtener dimensiones originales
    const metadata = await sharpLib(buffer).metadata();

    // Validar que el recorte esté dentro de los límites
    if (left < 0 || top < 0) {
      throw new Error('left and top must be >= 0');
    }
    if (left + width > metadata.width || top + height > metadata.height) {
      throw new Error(`Crop area (${left},${top} ${width}x${height}) exceeds image bounds (${metadata.width}x${metadata.height})`);
    }

    const pipeline = sharpLib(buffer).extract({
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(width),
      height: Math.round(height)
    });

    const processedBuffer = await pipeline.toBuffer();
    const info = await sharpLib(processedBuffer).metadata();

    if (output) {
      const outputDir = path.dirname(output);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      fs.writeFileSync(output, processedBuffer);

      return {
        success: true,
        image: output,
        width: info.width,
        height: info.height,
        originalWidth: metadata.width,
        originalHeight: metadata.height
      };
    }

    return {
      success: true,
      image: processedBuffer.toString('base64'),
      width: info.width,
      height: info.height,
      originalWidth: metadata.width,
      originalHeight: metadata.height
    };
  },

  /**
   * Recortar bordes automáticamente (elimina fondo uniforme)
   */
  async trim({ image, threshold = 10, output } = {}) {
    const sharpLib = loadSharp();
    const buffer = await this.getImageBuffer(image);

    const metadata = await sharpLib(buffer).metadata();

    // Sharp's trim() elimina píxeles similares al borde
    const pipeline = sharpLib(buffer).trim({
      threshold: threshold,
      background: undefined // Auto-detectar color del borde
    });

    const processedBuffer = await pipeline.toBuffer();
    const trimInfo = await sharpLib(processedBuffer).metadata();

    // Calcular cuánto se recortó
    const trimmed = {
      top: 0, // Sharp no expone esta info directamente
      left: 0,
      widthRemoved: metadata.width - trimInfo.width,
      heightRemoved: metadata.height - trimInfo.height
    };

    if (output) {
      const outputDir = path.dirname(output);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      fs.writeFileSync(output, processedBuffer);

      return {
        success: true,
        image: output,
        width: trimInfo.width,
        height: trimInfo.height,
        originalWidth: metadata.width,
        originalHeight: metadata.height,
        trimmed
      };
    }

    return {
      success: true,
      image: processedBuffer.toString('base64'),
      width: trimInfo.width,
      height: trimInfo.height,
      originalWidth: metadata.width,
      originalHeight: metadata.height,
      trimmed
    };
  }
};
