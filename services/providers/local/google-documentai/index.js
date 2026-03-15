/**
 * Google Document AI Service - Extracción estructurada de documentos
 *
 * Usa las mismas credenciales OAuth que Gmail (con scope cloud-platform).
 *
 * Credenciales (mismo patrón que Gmail):
 * - GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (global)
 * - GMAIL_CLIENT_ID_{account}, etc. (por cuenta)
 * - GMAIL_OAUTH_CUSTOM_{account} = JSON (credential-manager)
 *
 * Requiere configurar en .env:
 * - GOOGLE_PROJECT_ID: ID del proyecto en Google Cloud
 * - GOOGLE_DOCUMENTAI_LOCATION: Región (us o eu, default: us)
 * - GOOGLE_DOCUMENTAI_PROCESSOR_{type}: ID del procesador por tipo
 *   Ejemplo: GOOGLE_DOCUMENTAI_PROCESSOR_INVOICE=abc123def456
 *
 * @example
 * eventBus.publish('local.google-documentai.parse.request', {
 *   document: '/path/to/invoice.pdf',  // o base64
 *   processor: 'invoice',               // tipo de procesador
 *   account: 'empresa'                  // cuenta OAuth (opcional)
 * });
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Cache de access tokens (compartido con gmail si mismo proceso)
const accessTokenCache = new Map();

// ============================================================================
// CREDENTIAL RESOLUTION (mismo patrón que Gmail)
// ============================================================================

/**
 * Resuelve credenciales OAuth2 para una cuenta
 */
function resolveCredentials(account) {
  const env = process.env;

  // 1. JSON agrupado
  if (account) {
    const jsonKey = `GMAIL_OAUTH_CUSTOM_${account}`;
    const jsonValue = env[jsonKey];
    if (jsonValue) {
      try {
        const parsed = JSON.parse(jsonValue);
        if (parsed.client_id && parsed.client_secret && parsed.refresh_token) {
          return {
            clientId: parsed.client_id,
            clientSecret: parsed.client_secret,
            refreshToken: parsed.refresh_token,
            source: jsonKey
          };
        }
      } catch (e) { /* continuar */ }
    }

    // 2. Individuales por cuenta
    const clientId = env[`GMAIL_CLIENT_ID_${account}`];
    const clientSecret = env[`GMAIL_CLIENT_SECRET_${account}`];
    // Soporta ambos patrones: GMAIL_REFRESH_TOKEN_* y GMAIL_API_KEY_CUSTOM_* (credential-manager)
    const refreshToken = env[`GMAIL_REFRESH_TOKEN_${account}`] || env[`GMAIL_API_KEY_CUSTOM_${account}`];

    if (clientId && clientSecret && refreshToken) {
      return { clientId, clientSecret, refreshToken, source: `GMAIL_*_${account}` };
    }
  }

  // 3. Fallback global
  const clientId = env.GMAIL_CLIENT_ID;
  const clientSecret = env.GMAIL_CLIENT_SECRET;
  const refreshToken = env.GMAIL_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    return { clientId, clientSecret, refreshToken, source: 'GMAIL_* (global)' };
  }

  throw new Error(
    'OAuth credentials not found. Configure GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN ' +
    'with cloud-platform scope.'
  );
}

/**
 * Obtiene access token válido (con cache y refresh)
 */
async function getAccessToken(account = null) {
  const cacheKey = `documentai_${account || '_default_'}`;
  const now = Date.now();

  const cached = accessTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now + 300000) {
    return cached.token;
  }

  const { clientId, clientSecret, refreshToken } = resolveCredentials(account);

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

// ============================================================================
// HTTP UTILITIES
// ============================================================================

function httpRequest(options) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: options.hostname,
      port: 443,
      path: options.path,
      method: options.method || 'GET',
      headers: options.headers || {}
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

// ============================================================================
// DOCUMENT AI UTILITIES
// ============================================================================

/**
 * Resuelve configuración de Document AI
 */
function resolveConfig() {
  const projectId = process.env.GOOGLE_PROJECT_ID;
  if (!projectId) {
    throw new Error('GOOGLE_PROJECT_ID not configured');
  }

  const location = process.env.GOOGLE_DOCUMENTAI_LOCATION || 'us';

  return { projectId, location };
}

/**
 * Resuelve processor ID por tipo
 */
function resolveProcessor(type) {
  const key = `GOOGLE_DOCUMENTAI_PROCESSOR_${type.toUpperCase()}`;
  const processorId = process.env[key];

  if (!processorId) {
    throw new Error(`Processor not configured: ${key}`);
  }

  return processorId;
}

/**
 * Detecta si es base64 por magic bytes
 */
function detectMimeType(str) {
  if (str.startsWith('JVBERi')) return 'application/pdf';
  if (str.startsWith('/9j/')) return 'image/jpeg';
  if (str.startsWith('iVBORw')) return 'image/png';
  if (str.startsWith('R0lGOD')) return 'image/gif';
  if (str.startsWith('UklGR')) return 'image/webp';
  return null;
}

/**
 * Resuelve documento a base64
 */
function resolveDocument(document) {
  if (!document) {
    throw new Error('document is required');
  }

  // Data URI
  if (document.startsWith('data:')) {
    const match = document.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return { content: match[2], mimeType: match[1] };
    }
  }

  // Magic bytes (base64)
  const mimeType = detectMimeType(document);
  if (mimeType) {
    return { content: document, mimeType };
  }

  // File path
  let filePath = document;
  if (document.startsWith('@/')) {
    filePath = path.join(process.cwd(), 'data', document.slice(2));
  } else if (!path.isAbsolute(document)) {
    filePath = path.join(process.cwd(), document);
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath).toString('base64');
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff'
  };

  return {
    content,
    mimeType: mimeTypes[ext] || 'application/pdf'
  };
}

/**
 * Llama a Document AI API
 */
async function callDocumentAI(processorId, documentContent, mimeType, account) {
  const { projectId, location } = resolveConfig();
  const token = await getAccessToken(account);

  const endpoint = `/${projectId}/locations/${location}/processors/${processorId}:process`;

  const requestBody = JSON.stringify({
    rawDocument: {
      content: documentContent,
      mimeType: mimeType
    }
  });

  const response = await httpRequest({
    method: 'POST',
    hostname: `${location}-documentai.googleapis.com`,
    path: `/v1/projects${endpoint}`,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody)
    },
    body: requestBody
  });

  return response;
}

/**
 * Extrae entidades del documento procesado
 */
function extractEntities(document) {
  const entities = {};

  for (const entity of (document.entities || [])) {
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

  return entities;
}

/**
 * Extrae texto completo
 */
function extractText(document) {
  return document.text || '';
}

/**
 * Extrae tablas
 */
function extractTables(document) {
  const tables = [];

  for (const page of (document.pages || [])) {
    for (const table of (page.tables || [])) {
      const rows = [];

      for (const row of (table.bodyRows || [])) {
        const cells = row.cells.map(cell => {
          const text = cell.layout?.textAnchor?.textSegments
            ?.map(seg => document.text.substring(
              parseInt(seg.startIndex || 0),
              parseInt(seg.endIndex || 0)
            ))
            .join('') || '';
          return text.trim();
        });
        rows.push(cells);
      }

      // Headers
      const headers = (table.headerRows || []).flatMap(row =>
        row.cells.map(cell => {
          const text = cell.layout?.textAnchor?.textSegments
            ?.map(seg => document.text.substring(
              parseInt(seg.startIndex || 0),
              parseInt(seg.endIndex || 0)
            ))
            .join('') || '';
          return text.trim();
        })
      );

      tables.push({ headers, rows });
    }
  }

  return tables;
}

// ============================================================================
// EXPORTED MODULE
// ============================================================================

module.exports = {
  name: 'local.google-documentai',
  description: 'Google Document AI - Extracción estructurada de documentos (facturas, formularios, etc.)',

  functions: {
    parse: {
      event: 'local.google-documentai.parse.request',
      description: 'Procesar documento con Document AI',
      input: {
        document: { type: 'string', description: 'Documento (path, base64, data URI)', required: true },
        processor: { type: 'string', description: 'Tipo de procesador (invoice, form, ocr)', required: true },
        account: { type: 'string', description: 'Cuenta OAuth (opcional)' }
      },
      output: {
        text: { type: 'string', description: 'Texto completo extraído' },
        entities: { type: 'object', description: 'Entidades extraídas (vendor, total, etc.)' },
        tables: { type: 'array', description: 'Tablas detectadas' },
        pages: { type: 'number', description: 'Número de páginas' }
      }
    }
  },

  /**
   * Procesar documento
   */
  async parse({ document, processor, account }) {
    // Validar parámetros
    if (!document) {
      return { success: false, error: 'document is required' };
    }
    if (!processor) {
      return { success: false, error: 'processor type is required (invoice, form, ocr)' };
    }

    try {
      // Resolver documento
      const { content, mimeType } = resolveDocument(document);

      // Resolver processor
      const processorId = resolveProcessor(processor);

      // Llamar API
      const response = await callDocumentAI(processorId, content, mimeType, account);
      const doc = response.document;

      return {
        success: true,
        data: {
          text: extractText(doc),
          entities: extractEntities(doc),
          tables: extractTables(doc),
          pages: (doc.pages || []).length,
          mimeType: doc.mimeType
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
};
