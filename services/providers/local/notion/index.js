/**
 * Local Notion Service
 *
 * Integración con Notion API — páginas, bases de datos, búsqueda.
 * Requiere Notion API key (Internal Integration Token).
 *
 * Eventos:
 * - local.notion.query.request -> local.notion.query.response
 * - local.notion.create-page.request -> local.notion.create-page.response
 * - local.notion.update-page.request -> local.notion.update-page.response
 * - local.notion.create-db.request -> local.notion.create-db.response
 * - local.notion.search.request -> local.notion.search.response
 *
 * @version 1.0.0
 * @created 2026-02-05
 */

const https = require('https');

const NOTION_VERSION = '2022-06-28';

function notionRequest(method, path, apiKey, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.notion.com',
      path: `/v1${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        'User-Agent': 'EventCore/1.0'
      },
      timeout: 15000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            return reject(new Error(`Notion ${res.statusCode}: ${parsed.message || data.substring(0, 200)}`));
          }
          resolve(parsed);
        } catch (e) { reject(new Error('JSON parse error')); }
      });
      res.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function getApiKey(credentials) {
  return credentials?.NOTION_API_KEY || credentials?.apiKey || process.env.NOTION_API_KEY;
}

module.exports = {
  name: 'local.notion',
  description: 'Integración con Notion API — páginas, bases de datos, búsqueda',

  functions: {
    query: {
      event: 'local.notion.query.request',
      description: 'Consulta una base de datos de Notion con filtros y sorts',
      input: {
        database_id: { type: 'string', description: 'ID de la base de datos', required: true },
        filter: { type: 'object', description: 'Filtro Notion (opcional)', required: false },
        sorts: { type: 'array', description: 'Array de sorts (opcional)', required: false },
        page_size: { type: 'number', description: 'Resultados por página (max 100)', required: false }
      },
      output: {
        results: { type: 'array', description: 'Páginas encontradas' },
        has_more: { type: 'boolean', description: 'Si hay más resultados' }
      }
    },
    'create-page': {
      event: 'local.notion.create-page.request',
      description: 'Crea una página en Notion (en una DB o como subpágina)',
      input: {
        parent_id: { type: 'string', description: 'ID de la DB o página padre', required: true },
        parent_type: { type: 'string', description: 'database_id | page_id (default: database_id)', required: false },
        properties: { type: 'object', description: 'Propiedades de la página', required: true },
        children: { type: 'array', description: 'Bloques de contenido (opcional)', required: false }
      },
      output: {
        id: { type: 'string', description: 'ID de la página creada' },
        url: { type: 'string', description: 'URL de la página' }
      }
    },
    'update-page': {
      event: 'local.notion.update-page.request',
      description: 'Actualiza propiedades de una página existente',
      input: {
        page_id: { type: 'string', description: 'ID de la página', required: true },
        properties: { type: 'object', description: 'Propiedades a actualizar', required: true }
      },
      output: {
        id: { type: 'string', description: 'ID de la página' },
        url: { type: 'string', description: 'URL actualizada' }
      }
    },
    'create-db': {
      event: 'local.notion.create-db.request',
      description: 'Crea una base de datos en Notion',
      input: {
        parent_id: { type: 'string', description: 'ID de la página padre', required: true },
        title: { type: 'string', description: 'Título de la DB', required: true },
        properties: { type: 'object', description: 'Schema de propiedades', required: true }
      },
      output: {
        id: { type: 'string', description: 'ID de la DB creada' },
        url: { type: 'string', description: 'URL de la DB' }
      }
    },
    search: {
      event: 'local.notion.search.request',
      description: 'Busca páginas y bases de datos en Notion',
      input: {
        query: { type: 'string', description: 'Texto a buscar', required: false },
        filter_type: { type: 'string', description: 'page | database (opcional)', required: false },
        page_size: { type: 'number', description: 'Máximo resultados (default: 20)', required: false }
      },
      output: {
        results: { type: 'array', description: 'Resultados encontrados' },
        total: { type: 'number', description: 'Total de resultados' }
      }
    }
  },

  async query({ database_id, filter, sorts, page_size = 100, _credentials }) {
    if (!database_id) return { success: false, error: 'database_id es requerido' };
    const apiKey = getApiKey(_credentials);
    if (!apiKey) return { success: false, error: 'NOTION_API_KEY no configurada' };

    try {
      const body = { page_size: Math.min(page_size, 100) };
      if (filter) body.filter = filter;
      if (sorts) body.sorts = sorts;

      const data = await notionRequest('POST', `/databases/${database_id}/query`, apiKey, body);
      return {
        success: true,
        data: {
          results: data.results.map(p => ({
            id: p.id,
            url: p.url,
            created: p.created_time,
            updated: p.last_edited_time,
            properties: p.properties
          })),
          has_more: data.has_more,
          next_cursor: data.next_cursor
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async 'create-page'({ parent_id, parent_type = 'database_id', properties, children, _credentials }) {
    if (!parent_id || !properties) return { success: false, error: 'parent_id y properties son requeridos' };
    const apiKey = getApiKey(_credentials);
    if (!apiKey) return { success: false, error: 'NOTION_API_KEY no configurada' };

    try {
      const body = {
        parent: { [parent_type]: parent_id },
        properties
      };
      if (children) body.children = children;

      const data = await notionRequest('POST', '/pages', apiKey, body);
      return { success: true, data: { id: data.id, url: data.url, created: data.created_time } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async 'update-page'({ page_id, properties, _credentials }) {
    if (!page_id || !properties) return { success: false, error: 'page_id y properties son requeridos' };
    const apiKey = getApiKey(_credentials);
    if (!apiKey) return { success: false, error: 'NOTION_API_KEY no configurada' };

    try {
      const data = await notionRequest('PATCH', `/pages/${page_id}`, apiKey, { properties });
      return { success: true, data: { id: data.id, url: data.url, updated: data.last_edited_time } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async 'create-db'({ parent_id, title, properties, _credentials }) {
    if (!parent_id || !title || !properties) return { success: false, error: 'parent_id, title y properties son requeridos' };
    const apiKey = getApiKey(_credentials);
    if (!apiKey) return { success: false, error: 'NOTION_API_KEY no configurada' };

    try {
      const body = {
        parent: { page_id: parent_id },
        title: [{ type: 'text', text: { content: title } }],
        properties
      };
      const data = await notionRequest('POST', '/databases', apiKey, body);
      return { success: true, data: { id: data.id, url: data.url, title } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async search({ query, filter_type, page_size = 20, _credentials } = {}) {
    const apiKey = getApiKey(_credentials);
    if (!apiKey) return { success: false, error: 'NOTION_API_KEY no configurada' };

    try {
      const body = { page_size: Math.min(page_size, 100) };
      if (query) body.query = query;
      if (filter_type) body.filter = { value: filter_type, property: 'object' };

      const data = await notionRequest('POST', '/search', apiKey, body);
      return {
        success: true,
        data: {
          results: data.results.map(r => ({
            id: r.id,
            type: r.object,
            url: r.url,
            title: r.properties?.title?.title?.[0]?.plain_text || r.title?.[0]?.plain_text || '',
            updated: r.last_edited_time
          })),
          total: data.results.length,
          has_more: data.has_more
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};
