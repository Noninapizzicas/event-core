/**
 * Local Google Vision OCR Service
 *
 * OCR usando Google Cloud Vision API.
 * Requiere GOOGLE_API_KEY configurada en .env o via credential-manager.
 *
 * Eventos:
 * - local.google-vision.extract.request -> local.google-vision.extract.response
 *
 * LECCIONES APLICADAS (de contexto/lecciones-aprendidas-flow-engine.json):
 * - Bug #7: Validar parámetros al inicio
 * - Bug #12: Detectar base64 por magic bytes ANTES de verificar si es path
 * - Bug #14: Estructura de respuesta consistente con data.*
 *
 * @example
 * // Desde flow-engine:
 * {
 *   "type": "service",
 *   "service": "local.google-vision",
 *   "action": "extract",
 *   "image": "{{ globalPath(trigger.file.path) }}",
 *   "hint": "DOCUMENT_TEXT_DETECTION"
 * }
 *
 * // Acceso al resultado:
 * {{ steps.mi-step.data.text }}
 * {{ steps.mi-step.data.confidence }}
 *
 * @version 1.0.0
 * @created 2026-01-14
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

module.exports = {
  name: 'local.google-vision',
  description: 'OCR usando Google Cloud Vision API',

  functions: {
    extract: {
      event: 'local.google-vision.extract.request',
      description: 'Extraer texto de imagen usando Google Vision OCR',
      input: {
        image: {
          type: 'string',
          description: 'Imagen en base64 o path al archivo',
          required: true
        },
        hint: {
          type: 'string',
          description: 'Tipo de detección OCR',
          enum: ['TEXT_DETECTION', 'DOCUMENT_TEXT_DETECTION', 'HANDWRITING'],
          default: 'TEXT_DETECTION'
        },
        languageHints: {
          type: 'array',
          description: 'Códigos de idioma para mejorar detección (es, en, etc.)',
          default: []
        },
        account: {
          type: 'string',
          description: 'Cuenta de Google a usar (para multi-cuenta)',
          default: null
        }
      },
      output: {
        success: { type: 'boolean', description: 'Si la operación fue exitosa' },
        data: {
          type: 'object',
          description: 'Datos extraídos (acceder via steps.ID.data.text)',
          properties: {
            text: { type: 'string', description: 'Texto extraído completo' },
            confidence: { type: 'number', description: 'Confianza promedio 0-100' },
            blocks: { type: 'number', description: 'Número de bloques de texto' },
            pages: { type: 'number', description: 'Número de páginas' },
            locale: { type: 'string', description: 'Idioma detectado' }
          }
        },
        error: { type: 'string', description: 'Mensaje de error si success=false' }
      }
    }
  },

  /**
   * Detectar tipo de archivo por magic bytes en base64
   * LECCION #12: Detectar magic bytes ANTES de verificar si es path
   */
  detectMimeType(str) {
    if (!str || typeof str !== 'string') return null;

    // Magic bytes en base64 - imágenes
    if (str.startsWith('/9j/')) return 'image/jpeg';
    if (str.startsWith('iVBORw')) return 'image/png';
    if (str.startsWith('R0lGOD')) return 'image/gif';
    if (str.startsWith('UklGR')) return 'image/webp';
    if (str.startsWith('Qk')) return 'image/bmp';
    if (str.startsWith('SUkq') || str.startsWith('TU0A')) return 'image/tiff';

    // PDFs
    if (str.startsWith('JVBERi')) return 'application/pdf';

    return null;
  },

  /**
   * Resolver credencial de Google
   * Soporta multi-cuenta via credential-manager
   */
  resolveApiKey(account) {
    // 1. Si hay account específica, buscar GOOGLE_API_KEY_{account}
    if (account) {
      const accountKey = process.env[`GOOGLE_API_KEY_${account}`];
      if (accountKey) return accountKey;
    }

    // 2. Buscar GOOGLE_API_KEY global
    const globalKey = process.env.GOOGLE_API_KEY;
    if (globalKey) return globalKey;

    // 3. Fallback a GOOGLE_API_KEY_GLOBAL (formato credential-manager)
    const globalLevel = process.env.GOOGLE_API_KEY_GLOBAL;
    if (globalLevel) return globalLevel;

    return null;
  },

  /**
   * Resolver input: base64 o path a archivo
   * @returns {Promise<{base64: string, error: string|null}>}
   */
  async resolveImage(image) {
    // Data URI - extraer base64
    if (image.startsWith('data:')) {
      const matches = image.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        return { base64: null, error: 'Invalid data URI format' };
      }
      return { base64: matches[2], error: null };
    }

    // Detectar base64 por magic bytes (LECCION #12)
    const mimeType = this.detectMimeType(image);
    if (mimeType) {
      // Es base64 directo
      return { base64: image, error: null };
    }

    // Es un path de archivo
    let filePath = image;

    // Limpiar dobles // en la ruta
    filePath = filePath.replace(/\/+/g, '/');

    // Convertir @/ a ruta real (data/)
    if (filePath.startsWith('@/')) {
      filePath = filePath.replace('@/', './data/');
    }

    // Verificar que existe
    if (!fs.existsSync(filePath)) {
      return { base64: null, error: `File not found: ${filePath}` };
    }

    // Leer y convertir a base64
    try {
      const buffer = fs.readFileSync(filePath);
      const base64 = buffer.toString('base64');
      return { base64, error: null };
    } catch (e) {
      return { base64: null, error: `Failed to read file: ${e.message}` };
    }
  },

  /**
   * Hacer request HTTP a Google Vision API
   */
  async makeRequest(apiKey, requestBody) {
    return new Promise((resolve, reject) => {
      const url = new URL('https://vision.googleapis.com/v1/images:annotate');
      url.searchParams.set('key', apiKey);

      const postData = JSON.stringify(requestBody);

      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 60000
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', chunk => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);

            if (res.statusCode >= 400) {
              const errorMsg = parsed.error?.message || `HTTP ${res.statusCode}`;
              reject(new Error(errorMsg));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(postData);
      req.end();
    });
  },

  /**
   * Calcular confianza promedio de los bloques de texto
   */
  calculateConfidence(fullTextAnnotation) {
    if (!fullTextAnnotation?.pages?.length) return 0;

    let totalConfidence = 0;
    let blockCount = 0;

    for (const page of fullTextAnnotation.pages) {
      for (const block of page.blocks || []) {
        if (block.confidence !== undefined) {
          totalConfidence += block.confidence;
          blockCount++;
        }
      }
    }

    if (blockCount === 0) return 0;
    return Math.round((totalConfidence / blockCount) * 100);
  },

  /**
   * Contar bloques de texto
   */
  countBlocks(fullTextAnnotation) {
    if (!fullTextAnnotation?.pages?.length) return 0;

    let count = 0;
    for (const page of fullTextAnnotation.pages) {
      count += (page.blocks || []).length;
    }
    return count;
  },

  /**
   * Extraer texto de imagen usando Google Vision OCR
   *
   * LECCION #7: Validar TODOS los parámetros al inicio
   * LECCION #14: Devolver estructura consistente con data.*
   */
  async extract({ image, hint = 'TEXT_DETECTION', languageHints = [], account = null } = {}) {
    // === VALIDACIÓN DE ENTRADA (Lección #7) ===
    if (!image) {
      throw new Error('Parameter "image" is required');
    }

    if (typeof image !== 'string') {
      throw new Error(`Invalid image parameter: expected string, got ${typeof image}`);
    }

    if (image.trim() === '') {
      throw new Error('Parameter "image" cannot be empty');
    }

    // Validar hint
    const validHints = ['TEXT_DETECTION', 'DOCUMENT_TEXT_DETECTION', 'HANDWRITING'];
    if (!validHints.includes(hint)) {
      hint = 'TEXT_DETECTION';
    }

    try {
      // Resolver API key
      const apiKey = this.resolveApiKey(account);
      if (!apiKey) {
        throw new Error('Google API key not configured. Set GOOGLE_API_KEY in .env or use credential-manager');
      }

      // Resolver imagen
      const resolved = await this.resolveImage(image);
      if (resolved.error) {
        throw new Error(resolved.error);
      }

      // Construir request
      const requestBody = {
        requests: [
          {
            image: {
              content: resolved.base64
            },
            features: [
              {
                type: hint,
                maxResults: 50
              }
            ]
          }
        ]
      };

      // Agregar language hints si se proporcionaron
      if (languageHints.length > 0) {
        requestBody.requests[0].imageContext = {
          languageHints: languageHints
        };
      }

      // Hacer request a Google Vision
      const response = await this.makeRequest(apiKey, requestBody);

      // Verificar errores en la respuesta
      if (response.responses?.[0]?.error) {
        const errorMsg = response.responses[0].error.message || 'Google Vision API error';
        throw new Error(errorMsg);
      }

      // Extraer datos de la respuesta
      const annotation = response.responses?.[0];
      const fullTextAnnotation = annotation?.fullTextAnnotation;
      const textAnnotations = annotation?.textAnnotations || [];

      // El texto completo está en fullTextAnnotation.text o en textAnnotations[0].description
      const text = fullTextAnnotation?.text || textAnnotations[0]?.description || '';

      // Calcular confianza
      const confidence = this.calculateConfidence(fullTextAnnotation);

      // Contar bloques
      const blocks = this.countBlocks(fullTextAnnotation);

      // Número de páginas
      const pages = fullTextAnnotation?.pages?.length || (text ? 1 : 0);

      // Idioma detectado
      const locale = textAnnotations[0]?.locale ||
                     fullTextAnnotation?.pages?.[0]?.property?.detectedLanguages?.[0]?.languageCode ||
                     '';

      // Devolver datos directamente - el executor los envuelve en {success, data}
      // Incluye raw response completo para archivo maestro
      return {
        text: text.trim(),
        confidence,
        blocks,
        pages,
        locale,
        textLength: text.length,
        hint,
        // Raw response de Google Vision (completo)
        raw: {
          fullTextAnnotation: fullTextAnnotation || null,
          textAnnotations: textAnnotations || []
        }
      };

    } catch (error) {
      // Lanzar error para que el executor lo maneje
      throw new Error(`Google Vision API error: ${error.message}`);
    }
  },

  /**
   * Cleanup
   */
  async cleanup() {
    // No hay estado que limpiar
  }
};
