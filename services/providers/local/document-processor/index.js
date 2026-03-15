/**
 * Local Document Processor Service
 *
 * Procesador unificado de documentos/facturas con MÚLTIPLES backends.
 * Ordena los backends de mayor a menor calidad y permite seleccionar
 * cuál usar o usar fallback automático.
 *
 * TIERS DE CALIDAD (de mejor a peor):
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ Tier 1: GOOGLE_DOCUMENT_AI                                      │
 * │   - Mejor para facturas, extrae campos estructurados           │
 * │   - Reconoce: vendor, total, fecha, líneas, impuestos          │
 * │   - Requiere: GOOGLE_PROJECT_ID, GOOGLE_DOCUMENTAI_PROCESSOR_* │
 * │   - Costo: ~$1.50 por 1000 páginas                             │
 * ├─────────────────────────────────────────────────────────────────┤
 * │ Tier 2: GOOGLE_VISION + AI_EXTRACTION                          │
 * │   - OCR de Google Vision + extracción con AI                   │
 * │   - Requiere: GOOGLE_API_KEY + (ANTHROPIC/OPENAI)_API_KEY      │
 * │   - Costo: ~$0.50 + $0.01-0.05 por página                      │
 * ├─────────────────────────────────────────────────────────────────┤
 * │ Tier 3: ANTHROPIC_VISION                                        │
 * │   - Claude analiza imagen directamente                         │
 * │   - Requiere: ANTHROPIC_API_KEY                                │
 * │   - Costo: ~$0.01-0.05 por página                              │
 * ├─────────────────────────────────────────────────────────────────┤
 * │ Tier 4: OPENAI_VISION                                           │
 * │   - GPT-4V/GPT-4o analiza imagen directamente                  │
 * │   - Requiere: OPENAI_API_KEY                                   │
 * │   - Costo: ~$0.01-0.05 por página                              │
 * ├─────────────────────────────────────────────────────────────────┤
 * │ Tier 5: TESSERACT                                               │
 * │   - OCR local gratuito con Tesseract.js                        │
 * │   - Solo extrae texto, NO campos estructurados                 │
 * │   - Costo: GRATIS (local)                                      │
 * ├─────────────────────────────────────────────────────────────────┤
 * │ Tier 6: SCRIBE_OCR                                              │
 * │   - OCR local con scribe.js-ocr (Tesseract WASM)               │
 * │   - Soporta PDFs directamente                                  │
 * │   - Costo: GRATIS (local)                                      │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Eventos:
 * - local.document-processor.process.request -> local.document-processor.process.response
 * - local.document-processor.extract-invoice.request -> local.document-processor.extract-invoice.response
 * - local.document-processor.list-backends.request -> local.document-processor.list-backends.response
 *
 * @example
 * // Procesar factura con el mejor backend disponible
 * eventBus.publish('local.document-processor.extract-invoice.request', {
 *   document: '/path/to/invoice.pdf',
 *   backend: 'auto',  // usa el mejor disponible
 *   language: 'es'
 * });
 *
 * // Usar backend específico
 * eventBus.publish('local.document-processor.extract-invoice.request', {
 *   document: '@/temp/factura.pdf',
 *   backend: 'google_document_ai',
 *   processor: 'invoice',
 *   account: 'empresa'
 * });
 *
 * @version 1.0.0
 * @created 2026-01-27
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

// ============================================================================
// CONSTANTS
// ============================================================================

const BACKENDS = {
  GOOGLE_DOCUMENT_AI: {
    id: 'google_document_ai',
    name: 'Google Document AI',
    tier: 1,
    quality: 100,
    description: 'Mejor para facturas - extrae campos estructurados automáticamente',
    capabilities: ['ocr', 'invoice_fields', 'tables', 'forms'],
    cost: 'paid',
    costPerPage: 0.0015,
    requiresCredentials: ['GOOGLE_PROJECT_ID', 'GOOGLE_DOCUMENTAI_PROCESSOR_*']
  },
  GOOGLE_VISION_AI: {
    id: 'google_vision_ai',
    name: 'Google Vision + AI Extraction',
    tier: 2,
    quality: 85,
    description: 'OCR de Google Vision + extracción de campos con AI',
    capabilities: ['ocr', 'invoice_fields'],
    cost: 'paid',
    costPerPage: 0.005,
    requiresCredentials: ['GOOGLE_API_KEY', 'ANTHROPIC_API_KEY|OPENAI_API_KEY']
  },
  ANTHROPIC_VISION: {
    id: 'anthropic_vision',
    name: 'Anthropic Claude Vision',
    tier: 3,
    quality: 80,
    description: 'Claude analiza imagen de factura directamente',
    capabilities: ['ocr', 'invoice_fields'],
    cost: 'paid',
    costPerPage: 0.03,
    requiresCredentials: ['ANTHROPIC_API_KEY']
  },
  OPENAI_VISION: {
    id: 'openai_vision',
    name: 'OpenAI GPT-4 Vision',
    tier: 4,
    quality: 75,
    description: 'GPT-4V/GPT-4o analiza imagen de factura',
    capabilities: ['ocr', 'invoice_fields'],
    cost: 'paid',
    costPerPage: 0.03,
    requiresCredentials: ['OPENAI_API_KEY']
  },
  TESSERACT: {
    id: 'tesseract',
    name: 'Tesseract OCR (Local)',
    tier: 5,
    quality: 50,
    description: 'OCR local gratuito - solo texto, sin campos estructurados',
    capabilities: ['ocr'],
    cost: 'free',
    costPerPage: 0,
    requiresCredentials: []
  },
  SCRIBE_OCR: {
    id: 'scribe_ocr',
    name: 'Scribe OCR (Local)',
    tier: 6,
    quality: 45,
    description: 'OCR local con scribe.js-ocr - soporta PDFs directamente',
    capabilities: ['ocr', 'pdf_direct'],
    cost: 'free',
    costPerPage: 0,
    requiresCredentials: []
  }
};

// Campos estándar de factura
const INVOICE_FIELDS = [
  'vendor_name',
  'vendor_address',
  'vendor_tax_id',
  'invoice_number',
  'invoice_date',
  'due_date',
  'subtotal',
  'tax_amount',
  'tax_rate',
  'total_amount',
  'currency',
  'payment_terms',
  'line_items'
];

// Prompt para extracción de campos con AI
const INVOICE_EXTRACTION_PROMPT = `Analiza esta imagen de factura y extrae los siguientes campos en formato JSON.
Si un campo no está presente o no es legible, usa null.

Campos a extraer:
- vendor_name: Nombre del proveedor/empresa que emite la factura
- vendor_address: Dirección completa del proveedor
- vendor_tax_id: NIF/CIF/VAT del proveedor
- invoice_number: Número de factura
- invoice_date: Fecha de emisión (formato YYYY-MM-DD)
- due_date: Fecha de vencimiento (formato YYYY-MM-DD)
- subtotal: Subtotal sin impuestos (solo número)
- tax_amount: Importe de impuestos (solo número)
- tax_rate: Porcentaje de impuesto (solo número, ej: 21)
- total_amount: Total con impuestos (solo número)
- currency: Moneda (EUR, USD, etc.)
- payment_terms: Condiciones de pago
- line_items: Array de líneas con { description, quantity, unit_price, amount }

IMPORTANTE: Responde SOLO con el JSON, sin texto adicional ni markdown.`;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Detecta tipo MIME por magic bytes en base64
 */
function detectMimeType(str) {
  if (!str || typeof str !== 'string') return null;

  if (str.startsWith('/9j/')) return 'image/jpeg';
  if (str.startsWith('iVBORw')) return 'image/png';
  if (str.startsWith('R0lGOD')) return 'image/gif';
  if (str.startsWith('UklGR')) return 'image/webp';
  if (str.startsWith('Qk')) return 'image/bmp';
  if (str.startsWith('SUkq') || str.startsWith('TU0A')) return 'image/tiff';
  if (str.startsWith('JVBERi')) return 'application/pdf';

  return null;
}

/**
 * Resuelve documento a { base64, mimeType, filePath }
 */
function resolveDocument(document) {
  if (!document) {
    throw new Error('document is required');
  }

  // Data URI - detectar primero para evitar tratar como path
  if (typeof document === 'string' && document.startsWith('data:')) {
    // Buscar el separador base64, de forma más eficiente que regex en strings largos
    const base64Marker = ';base64,';
    const markerIndex = document.indexOf(base64Marker);

    if (markerIndex !== -1) {
      const mimeType = document.substring(5, markerIndex); // después de 'data:'
      const base64 = document.substring(markerIndex + base64Marker.length);
      return { base64, mimeType, filePath: null };
    }

    // Fallback: data URI sin base64 marker (raro pero posible)
    throw new Error('Invalid data URI format. Expected: data:<mimeType>;base64,<content>');
  }

  // Magic bytes (base64 puro sin data: prefix)
  const mimeType = detectMimeType(document);
  if (mimeType) {
    return { base64: document, mimeType, filePath: null };
  }

  // A partir de aquí, asumir que es un file path
  // Verificar que no sea un string demasiado largo para ser un path (evitar ENAMETOOLONG)
  if (document.length > 4096) {
    throw new Error('Document appears to be base64 content but could not detect MIME type. Prefix with data:<mimeType>;base64, or pass a file path.');
  }

  // File path
  let filePath = document;
  if (document.startsWith('@/')) {
    filePath = path.join(process.cwd(), 'data', document.slice(2));
  } else if (!path.isAbsolute(document)) {
    filePath = path.join(process.cwd(), document);
  }

  // Limpiar dobles //
  filePath = filePath.replace(/\/+/g, '/');

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath);
  const base64 = content.toString('base64');
  const ext = path.extname(filePath).toLowerCase();

  const mimeTypes = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp'
  };

  return {
    base64,
    mimeType: mimeTypes[ext] || 'application/pdf',
    filePath
  };
}

/**
 * HTTP request helper
 */
function httpRequest(options) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: options.hostname,
      port: 443,
      path: options.path,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 120000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${parsed.error?.message || JSON.stringify(parsed)}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            resolve(data);
          }
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Escribe archivo temporal y devuelve path
 */
function writeTempFile(base64, ext) {
  const tempPath = path.join(os.tmpdir(), `doc-processor-${Date.now()}${ext}`);
  fs.writeFileSync(tempPath, Buffer.from(base64, 'base64'));
  return tempPath;
}

/**
 * Limpia archivo temporal
 */
function cleanupTemp(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (e) { /* ignore */ }
  }
}

// ============================================================================
// BACKEND: GOOGLE DOCUMENT AI
// ============================================================================

// Cache de access tokens para OAuth
const accessTokenCache = new Map();

async function getGoogleAccessToken(account = null) {
  const cacheKey = `documentai_${account || '_default_'}`;
  const now = Date.now();

  const cached = accessTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now + 300000) {
    return cached.token;
  }

  // Buscar credenciales OAuth
  const env = process.env;
  let clientId, clientSecret, refreshToken;

  if (account) {
    const jsonKey = `GMAIL_OAUTH_CUSTOM_${account}`;
    const jsonValue = env[jsonKey];
    if (jsonValue) {
      try {
        const parsed = JSON.parse(jsonValue);
        clientId = parsed.client_id;
        clientSecret = parsed.client_secret;
        refreshToken = parsed.refresh_token;
      } catch (e) { /* continue */ }
    }

    if (!clientId) {
      clientId = env[`GMAIL_CLIENT_ID_${account}`];
      clientSecret = env[`GMAIL_CLIENT_SECRET_${account}`];
      // Soporta ambos patrones: GMAIL_REFRESH_TOKEN_* y GMAIL_API_KEY_CUSTOM_* (credential-manager)
      refreshToken = env[`GMAIL_REFRESH_TOKEN_${account}`] || env[`GMAIL_API_KEY_CUSTOM_${account}`];
    }
  }

  if (!clientId) {
    clientId = env.GMAIL_CLIENT_ID;
    clientSecret = env.GMAIL_CLIENT_SECRET;
    refreshToken = env.GMAIL_REFRESH_TOKEN;
  }

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('OAuth credentials not found for Document AI');
  }

  const response = await httpRequest({
    method: 'POST',
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString()
  });

  if (response.error) {
    throw new Error(`OAuth2 error: ${response.error_description || response.error}`);
  }

  accessTokenCache.set(cacheKey, {
    token: response.access_token,
    expiresAt: now + (response.expires_in * 1000)
  });

  return response.access_token;
}

async function processWithGoogleDocumentAI({ base64, mimeType, processor = 'invoice', account }) {
  const projectId = process.env.GOOGLE_PROJECT_ID;
  if (!projectId) {
    throw new Error('GOOGLE_PROJECT_ID not configured');
  }

  const processorKey = `GOOGLE_DOCUMENTAI_PROCESSOR_${processor.toUpperCase()}`;
  const processorId = process.env[processorKey];
  if (!processorId) {
    throw new Error(`Processor not configured: ${processorKey}`);
  }

  const location = process.env.GOOGLE_DOCUMENTAI_LOCATION || 'us';
  const token = await getGoogleAccessToken(account);

  const requestBody = JSON.stringify({
    rawDocument: {
      content: base64,
      mimeType: mimeType
    }
  });

  const response = await httpRequest({
    method: 'POST',
    hostname: `${location}-documentai.googleapis.com`,
    path: `/v1/projects/${projectId}/locations/${location}/processors/${processorId}:process`,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody)
    },
    body: requestBody,
    timeout: 180000
  });

  const doc = response.document;

  // Extraer texto
  const text = doc.text || '';

  // Extraer entidades (campos de factura)
  const entities = {};
  for (const entity of (doc.entities || [])) {
    const key = entity.type.replace(/_/g, ' ').toLowerCase();
    const value = entity.mentionText || entity.normalizedValue?.text || '';

    if (entities[key]) {
      if (!Array.isArray(entities[key])) {
        entities[key] = [entities[key]];
      }
      entities[key].push(value);
    } else {
      entities[key] = value;
    }
  }

  // Extraer tablas
  const tables = [];
  for (const page of (doc.pages || [])) {
    for (const table of (page.tables || [])) {
      const rows = [];
      for (const row of (table.bodyRows || [])) {
        const cells = row.cells.map(cell => {
          const textSegs = cell.layout?.textAnchor?.textSegments || [];
          return textSegs.map(seg =>
            doc.text.substring(parseInt(seg.startIndex || 0), parseInt(seg.endIndex || 0))
          ).join('').trim();
        });
        rows.push(cells);
      }
      tables.push({ rows });
    }
  }

  // Normalizar a formato estándar de factura
  const invoiceData = normalizeInvoiceEntities(entities);

  return {
    backend: 'google_document_ai',
    text,
    invoice: invoiceData,
    entities,
    tables,
    pages: (doc.pages || []).length,
    confidence: 95
  };
}

// ============================================================================
// BACKEND: GOOGLE VISION + AI
// ============================================================================

async function processWithGoogleVisionAI({ base64, mimeType, language = 'es', aiProvider = 'anthropic' }) {
  // Paso 1: OCR con Google Vision
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY_GLOBAL;
  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY not configured');
  }

  const requestBody = JSON.stringify({
    requests: [{
      image: { content: base64 },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 50 }],
      imageContext: { languageHints: [language] }
    }]
  });

  const visionResponse = await httpRequest({
    method: 'POST',
    hostname: 'vision.googleapis.com',
    path: `/v1/images:annotate?key=${apiKey}`,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody)
    },
    body: requestBody
  });

  const annotation = visionResponse.responses?.[0];
  if (annotation?.error) {
    throw new Error(annotation.error.message);
  }

  const text = annotation?.fullTextAnnotation?.text || annotation?.textAnnotations?.[0]?.description || '';

  // Paso 2: Extraer campos con AI
  const invoiceData = await extractInvoiceFieldsWithAI(text, aiProvider);

  return {
    backend: 'google_vision_ai',
    text,
    invoice: invoiceData,
    entities: {},
    tables: [],
    pages: 1,
    confidence: 85
  };
}

// ============================================================================
// BACKEND: ANTHROPIC VISION
// ============================================================================

async function processWithAnthropicVision({ base64, mimeType }) {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_GLOBAL;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  // Preparar imagen para Claude
  const mediaType = mimeType.includes('pdf') ? 'image/png' : mimeType;

  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64
          }
        },
        {
          type: 'text',
          text: INVOICE_EXTRACTION_PROMPT
        }
      ]
    }]
  });

  const response = await httpRequest({
    method: 'POST',
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(requestBody)
    },
    body: requestBody,
    timeout: 120000
  });

  // Extraer texto de la respuesta
  const content = response.content?.[0]?.text || '';

  // Parsear JSON de la respuesta
  let invoiceData = {};
  try {
    // Intentar encontrar JSON en la respuesta
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      invoiceData = JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    // Si falla, devolver campos vacíos
  }

  return {
    backend: 'anthropic_vision',
    text: content,
    invoice: normalizeInvoiceData(invoiceData),
    entities: invoiceData,
    tables: invoiceData.line_items || [],
    pages: 1,
    confidence: 80
  };
}

// ============================================================================
// BACKEND: OPENAI VISION
// ============================================================================

async function processWithOpenAIVision({ base64, mimeType }) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_GLOBAL;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const imageUrl = `data:${mimeType};base64,${base64}`;

  const requestBody = JSON.stringify({
    model: 'gpt-4o',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: imageUrl, detail: 'high' }
        },
        {
          type: 'text',
          text: INVOICE_EXTRACTION_PROMPT
        }
      ]
    }]
  });

  const response = await httpRequest({
    method: 'POST',
    hostname: 'api.openai.com',
    path: '/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': Buffer.byteLength(requestBody)
    },
    body: requestBody,
    timeout: 120000
  });

  const content = response.choices?.[0]?.message?.content || '';

  let invoiceData = {};
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      invoiceData = JSON.parse(jsonMatch[0]);
    }
  } catch (e) { /* ignore */ }

  return {
    backend: 'openai_vision',
    text: content,
    invoice: normalizeInvoiceData(invoiceData),
    entities: invoiceData,
    tables: invoiceData.line_items || [],
    pages: 1,
    confidence: 75
  };
}

// ============================================================================
// BACKEND: TESSERACT
// ============================================================================

async function processWithTesseract({ base64, mimeType, language = 'eng' }) {
  let Tesseract;
  try {
    Tesseract = require('tesseract.js');
  } catch (e) {
    throw new Error('tesseract.js not installed. Run: npm install tesseract.js');
  }

  // Crear worker
  const worker = await Tesseract.createWorker(language, 1, {
    logger: () => {}
  });

  try {
    const imageInput = `data:${mimeType};base64,${base64}`;
    const { data } = await worker.recognize(imageInput);

    return {
      backend: 'tesseract',
      text: data.text.trim(),
      invoice: null, // Tesseract no extrae campos
      entities: {},
      tables: [],
      pages: 1,
      confidence: data.confidence || 50
    };
  } finally {
    await worker.terminate();
  }
}

// ============================================================================
// BACKEND: SCRIBE OCR
// ============================================================================

async function processWithScribeOCR({ base64, mimeType, language = 'eng', filePath }) {
  let scribe;
  try {
    const module = await import('scribe.js-ocr');
    scribe = module.default;
  } catch (e) {
    throw new Error('scribe.js-ocr not installed. Run: npm install scribe.js-ocr');
  }

  // Scribe necesita un archivo, no base64
  let tempFile = null;
  let inputPath = filePath;

  if (!inputPath) {
    const ext = mimeType.includes('pdf') ? '.pdf' : '.png';
    tempFile = writeTempFile(base64, ext);
    inputPath = tempFile;
  }

  try {
    if (scribe.setOptions) {
      await scribe.setOptions({ lang: language });
    }

    const result = await scribe.extractText([inputPath]);

    let text = '';
    if (typeof result === 'string') {
      text = result;
    } else if (Array.isArray(result)) {
      text = result.join('\n\n');
    }

    return {
      backend: 'scribe_ocr',
      text: text.trim(),
      invoice: null,
      entities: {},
      tables: [],
      pages: 1,
      confidence: 45
    };
  } finally {
    if (tempFile) {
      cleanupTemp(tempFile);
    }
  }
}

// ============================================================================
// AI EXTRACTION HELPER
// ============================================================================

async function extractInvoiceFieldsWithAI(text, provider = 'anthropic') {
  const prompt = `Dado el siguiente texto extraído de una factura, extrae los campos en formato JSON.
Si un campo no está presente, usa null.

TEXTO:
${text}

Campos a extraer:
- vendor_name, vendor_address, vendor_tax_id
- invoice_number, invoice_date (YYYY-MM-DD), due_date (YYYY-MM-DD)
- subtotal, tax_amount, tax_rate, total_amount (solo números)
- currency, payment_terms
- line_items: array de { description, quantity, unit_price, amount }

Responde SOLO con JSON:`;

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_GLOBAL;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

    const response = await httpRequest({
      method: 'POST',
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const content = response.content?.[0]?.text || '{}';
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      return normalizeInvoiceData(jsonMatch ? JSON.parse(jsonMatch[0]) : {});
    } catch (e) {
      return {};
    }
  } else {
    const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_GLOBAL;
    if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

    const response = await httpRequest({
      method: 'POST',
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const content = response.choices?.[0]?.message?.content || '{}';
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      return normalizeInvoiceData(jsonMatch ? JSON.parse(jsonMatch[0]) : {});
    } catch (e) {
      return {};
    }
  }
}

// ============================================================================
// NORMALIZATION HELPERS
// ============================================================================

function normalizeInvoiceEntities(entities) {
  // Mapear nombres de entidades de Google Document AI a nombres estándar
  const mapping = {
    'supplier name': 'vendor_name',
    'vendor name': 'vendor_name',
    'supplier address': 'vendor_address',
    'vendor address': 'vendor_address',
    'supplier tax id': 'vendor_tax_id',
    'invoice id': 'invoice_number',
    'invoice number': 'invoice_number',
    'invoice date': 'invoice_date',
    'due date': 'due_date',
    'net amount': 'subtotal',
    'subtotal': 'subtotal',
    'tax amount': 'tax_amount',
    'total amount': 'total_amount',
    'total': 'total_amount',
    'currency': 'currency',
    'payment terms': 'payment_terms'
  };

  const result = {};
  for (const [key, value] of Object.entries(entities)) {
    const normalizedKey = mapping[key] || key.replace(/\s+/g, '_');
    result[normalizedKey] = value;
  }

  return result;
}

function normalizeInvoiceData(data) {
  if (!data || typeof data !== 'object') return {};

  // Asegurar que los campos numéricos sean números
  const numericFields = ['subtotal', 'tax_amount', 'tax_rate', 'total_amount'];
  for (const field of numericFields) {
    if (data[field] !== null && data[field] !== undefined) {
      const num = parseFloat(String(data[field]).replace(/[^0-9.-]/g, ''));
      data[field] = isNaN(num) ? null : num;
    }
  }

  // Normalizar line_items
  if (data.line_items && Array.isArray(data.line_items)) {
    data.line_items = data.line_items.map(item => ({
      description: item.description || null,
      quantity: parseFloat(item.quantity) || null,
      unit_price: parseFloat(item.unit_price) || null,
      amount: parseFloat(item.amount) || null
    }));
  }

  return data;
}

// ============================================================================
// BACKEND AVAILABILITY CHECK
// ============================================================================

function checkBackendAvailability() {
  const available = [];
  const unavailable = [];

  // Google Document AI
  if (process.env.GOOGLE_PROJECT_ID &&
      (process.env.GOOGLE_DOCUMENTAI_PROCESSOR_INVOICE ||
       process.env.GOOGLE_DOCUMENTAI_PROCESSOR_OCR)) {
    available.push(BACKENDS.GOOGLE_DOCUMENT_AI);
  } else {
    unavailable.push({ ...BACKENDS.GOOGLE_DOCUMENT_AI, reason: 'Missing GOOGLE_PROJECT_ID or GOOGLE_DOCUMENTAI_PROCESSOR_*' });
  }

  // Google Vision + AI
  const hasGoogleVision = process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY_GLOBAL;
  const hasAI = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY ||
                process.env.ANTHROPIC_API_KEY_GLOBAL || process.env.OPENAI_API_KEY_GLOBAL;
  if (hasGoogleVision && hasAI) {
    available.push(BACKENDS.GOOGLE_VISION_AI);
  } else {
    unavailable.push({ ...BACKENDS.GOOGLE_VISION_AI, reason: 'Missing GOOGLE_API_KEY or AI provider key' });
  }

  // Anthropic Vision
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_GLOBAL) {
    available.push(BACKENDS.ANTHROPIC_VISION);
  } else {
    unavailable.push({ ...BACKENDS.ANTHROPIC_VISION, reason: 'Missing ANTHROPIC_API_KEY' });
  }

  // OpenAI Vision
  if (process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_GLOBAL) {
    available.push(BACKENDS.OPENAI_VISION);
  } else {
    unavailable.push({ ...BACKENDS.OPENAI_VISION, reason: 'Missing OPENAI_API_KEY' });
  }

  // Tesseract (siempre disponible si está instalado)
  try {
    require.resolve('tesseract.js');
    available.push(BACKENDS.TESSERACT);
  } catch (e) {
    unavailable.push({ ...BACKENDS.TESSERACT, reason: 'tesseract.js not installed' });
  }

  // Scribe OCR
  try {
    require.resolve('scribe.js-ocr');
    available.push(BACKENDS.SCRIBE_OCR);
  } catch (e) {
    unavailable.push({ ...BACKENDS.SCRIBE_OCR, reason: 'scribe.js-ocr not installed' });
  }

  // Ordenar por tier (calidad)
  available.sort((a, b) => a.tier - b.tier);
  unavailable.sort((a, b) => a.tier - b.tier);

  return { available, unavailable };
}

// ============================================================================
// EXPORTED MODULE
// ============================================================================

module.exports = {
  name: 'local.document-processor',
  description: 'Procesador unificado de documentos/facturas con múltiples backends',

  functions: {
    process: {
      event: 'local.document-processor.process.request',
      description: 'Procesar documento con OCR',
      input: {
        document: { type: 'string', description: 'Documento (path, base64, data URI)', required: true },
        backend: { type: 'string', description: 'Backend a usar (auto, google_document_ai, google_vision_ai, anthropic_vision, openai_vision, tesseract, scribe_ocr)', default: 'auto' },
        language: { type: 'string', description: 'Código de idioma (es, en, etc.)', default: 'es' },
        processor: { type: 'string', description: 'Tipo de procesador para Document AI (invoice, form, ocr)', default: 'ocr' },
        account: { type: 'string', description: 'Cuenta OAuth (para Document AI)' }
      },
      output: {
        backend: { type: 'string', description: 'Backend usado' },
        text: { type: 'string', description: 'Texto extraído' },
        confidence: { type: 'number', description: 'Confianza del OCR' },
        pages: { type: 'number', description: 'Número de páginas' }
      }
    },

    'extract-invoice': {
      event: 'local.document-processor.extract-invoice.request',
      description: 'Extraer campos estructurados de factura',
      input: {
        document: { type: 'string', description: 'Factura (path, base64, data URI)', required: true },
        backend: { type: 'string', description: 'Backend a usar (auto selecciona el mejor disponible)', default: 'auto' },
        language: { type: 'string', description: 'Código de idioma', default: 'es' },
        account: { type: 'string', description: 'Cuenta OAuth (para Document AI)' }
      },
      output: {
        backend: { type: 'string', description: 'Backend usado' },
        invoice: { type: 'object', description: 'Campos extraídos de la factura' },
        text: { type: 'string', description: 'Texto completo' },
        confidence: { type: 'number', description: 'Confianza' }
      }
    },

    'list-backends': {
      event: 'local.document-processor.list-backends.request',
      description: 'Listar backends disponibles y sus características',
      input: {},
      output: {
        available: { type: 'array', description: 'Backends disponibles ordenados por calidad' },
        unavailable: { type: 'array', description: 'Backends no disponibles y razón' }
      }
    }
  },

  /**
   * Listar backends
   */
  async 'list-backends'() {
    const { available, unavailable } = checkBackendAvailability();

    return {
      success: true,
      data: {
        available: available.map(b => ({
          id: b.id,
          name: b.name,
          tier: b.tier,
          quality: b.quality,
          description: b.description,
          capabilities: b.capabilities,
          cost: b.cost
        })),
        unavailable: unavailable.map(b => ({
          id: b.id,
          name: b.name,
          tier: b.tier,
          reason: b.reason
        })),
        recommended: available[0]?.id || null
      }
    };
  },

  /**
   * Procesar documento (OCR básico)
   */
  async process({ document, backend = 'auto', language = 'es', processor = 'ocr', account }) {
    if (!document) {
      return { success: false, error: 'document is required' };
    }

    try {
      const { base64, mimeType, filePath } = resolveDocument(document);
      const { available } = checkBackendAvailability();

      if (available.length === 0) {
        return { success: false, error: 'No backends available. Install tesseract.js or configure API keys.' };
      }

      // Seleccionar backend
      let selectedBackend;
      if (backend === 'auto') {
        selectedBackend = available[0].id;
      } else {
        if (!available.find(b => b.id === backend)) {
          return { success: false, error: `Backend '${backend}' not available. Available: ${available.map(b => b.id).join(', ')}` };
        }
        selectedBackend = backend;
      }

      // Procesar según backend
      let result;
      switch (selectedBackend) {
        case 'google_document_ai':
          result = await processWithGoogleDocumentAI({ base64, mimeType, processor, account });
          break;
        case 'google_vision_ai':
          result = await processWithGoogleVisionAI({ base64, mimeType, language });
          break;
        case 'anthropic_vision':
          result = await processWithAnthropicVision({ base64, mimeType });
          break;
        case 'openai_vision':
          result = await processWithOpenAIVision({ base64, mimeType });
          break;
        case 'tesseract':
          result = await processWithTesseract({ base64, mimeType, language: language === 'es' ? 'spa' : language });
          break;
        case 'scribe_ocr':
          result = await processWithScribeOCR({ base64, mimeType, language: language === 'es' ? 'spa' : language, filePath });
          break;
        default:
          return { success: false, error: `Unknown backend: ${selectedBackend}` };
      }

      return {
        success: true,
        data: result
      };

    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  },

  /**
   * Extraer campos de factura
   */
  async 'extract-invoice'({ document, backend = 'auto', language = 'es', account }) {
    if (!document) {
      return { success: false, error: 'document is required' };
    }

    try {
      const { base64, mimeType, filePath } = resolveDocument(document);
      const { available } = checkBackendAvailability();

      // Para facturas, filtrar backends que soporten invoice_fields
      const invoiceBackends = available.filter(b =>
        b.capabilities.includes('invoice_fields')
      );

      if (invoiceBackends.length === 0) {
        // Fallback a OCR + texto
        const ocrBackends = available.filter(b => b.capabilities.includes('ocr'));
        if (ocrBackends.length === 0) {
          return { success: false, error: 'No backends available for invoice extraction' };
        }
        // Usar OCR y devolver solo texto
        const selectedBackend = ocrBackends[0].id;
        let result;

        if (selectedBackend === 'tesseract') {
          result = await processWithTesseract({ base64, mimeType, language: language === 'es' ? 'spa' : language });
        } else if (selectedBackend === 'scribe_ocr') {
          result = await processWithScribeOCR({ base64, mimeType, language: language === 'es' ? 'spa' : language, filePath });
        }

        return {
          success: true,
          data: {
            ...result,
            warning: 'No invoice extraction backend available. Only OCR text returned.'
          }
        };
      }

      // Seleccionar backend
      let selectedBackend;
      if (backend === 'auto') {
        selectedBackend = invoiceBackends[0].id;
      } else {
        if (!invoiceBackends.find(b => b.id === backend)) {
          // Si pide uno específico que no soporta facturas, intentar si está disponible
          if (available.find(b => b.id === backend)) {
            selectedBackend = backend;
          } else {
            return { success: false, error: `Backend '${backend}' not available for invoice extraction` };
          }
        } else {
          selectedBackend = backend;
        }
      }

      // Procesar según backend
      let result;
      switch (selectedBackend) {
        case 'google_document_ai':
          result = await processWithGoogleDocumentAI({ base64, mimeType, processor: 'invoice', account });
          break;
        case 'google_vision_ai':
          result = await processWithGoogleVisionAI({ base64, mimeType, language });
          break;
        case 'anthropic_vision':
          result = await processWithAnthropicVision({ base64, mimeType });
          break;
        case 'openai_vision':
          result = await processWithOpenAIVision({ base64, mimeType });
          break;
        default:
          return { success: false, error: `Backend '${selectedBackend}' does not support invoice extraction` };
      }

      return {
        success: true,
        data: result
      };

    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
};
