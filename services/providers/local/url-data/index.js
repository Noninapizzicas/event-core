/**
 * Local URL Data Service
 *
 * Estación de datos de URL — extrae contenido, metadata y datos
 * estructurados de páginas web. Usa cheerio para parsing HTML.
 * No requiere credenciales externas.
 *
 * Eventos:
 * - local.url-data.extract.request -> local.url-data.extract.response
 * - local.url-data.metadata.request -> local.url-data.metadata.response
 * - local.url-data.search.request -> local.url-data.search.response
 *
 * @version 1.0.0
 * @created 2026-02-05
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

// Lazy load cheerio (npm)
let _cheerio = null;
function getCheerio() {
  if (!_cheerio) {
    try {
      _cheerio = require('cheerio');
    } catch (e) {
      throw new Error('cheerio no instalado. Ejecutar: npm install cheerio');
    }
  }
  return _cheerio;
}

/**
 * Fetch URL content with redirects, timeout and size limit
 */
function fetchUrl(url, options = {}) {
  const { timeout = 15000, maxSize = 5 * 1024 * 1024, maxRedirects = 5 } = options;

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.get(url, {
      timeout,
      headers: {
        'User-Agent': 'EventCore-URLData/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es,en;q=0.5'
      }
    }, (res) => {
      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (maxRedirects <= 0) {
          return reject(new Error('Demasiados redirects'));
        }
        const redirectUrl = new URL(res.headers.location, url).href;
        return fetchUrl(redirectUrl, { ...options, maxRedirects: maxRedirects - 1 })
          .then(resolve)
          .catch(reject);
      }

      if (res.statusCode < 200 || res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
      }

      const chunks = [];
      let totalSize = 0;

      res.on('data', (chunk) => {
        totalSize += chunk.length;
        if (totalSize > maxSize) {
          req.destroy();
          return reject(new Error(`Respuesta excede ${maxSize / 1024 / 1024}MB`));
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({
          body,
          statusCode: res.statusCode,
          headers: res.headers,
          contentType: res.headers['content-type'] || '',
          size: totalSize,
          finalUrl: url
        });
      });

      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout después de ${timeout}ms`));
    });

    req.on('error', reject);
  });
}

module.exports = {
  name: 'local.url-data',
  description: 'Estación de datos de URL — extrae contenido, metadata y datos estructurados de páginas web',

  functions: {
    extract: {
      event: 'local.url-data.extract.request',
      description: 'Descarga y extrae contenido de una URL (texto limpio o HTML)',
      input: {
        url: { type: 'string', description: 'URL a extraer', required: true },
        format: { type: 'string', description: 'Formato de salida: text | html | raw (default: text)', required: false }
      },
      output: {
        content: { type: 'string', description: 'Contenido extraído' },
        format: { type: 'string', description: 'Formato del contenido' },
        size: { type: 'number', description: 'Tamaño en bytes' },
        url: { type: 'string', description: 'URL final (después de redirects)' }
      }
    },
    metadata: {
      event: 'local.url-data.metadata.request',
      description: 'Extrae metadata de la página (title, description, Open Graph, links, headings)',
      input: {
        url: { type: 'string', description: 'URL a analizar', required: true }
      },
      output: {
        title: { type: 'string', description: 'Título de la página' },
        description: { type: 'string', description: 'Meta description' },
        og: { type: 'object', description: 'Open Graph tags' },
        headings: { type: 'array', description: 'Estructura de headings (h1-h3)' },
        links: { type: 'object', description: 'Links internos y externos contados' },
        images: { type: 'number', description: 'Número de imágenes' },
        language: { type: 'string', description: 'Idioma detectado' }
      }
    },
    search: {
      event: 'local.url-data.search.request',
      description: 'Busca texto o extrae datos con selectores CSS dentro del contenido de una URL',
      input: {
        url: { type: 'string', description: 'URL donde buscar', required: true },
        query: { type: 'string', description: 'Texto a buscar (case-insensitive)', required: false },
        selector: { type: 'string', description: 'Selector CSS para extraer elementos (ej: "table", ".price", "h2")', required: false }
      },
      output: {
        matches: { type: 'array', description: 'Resultados encontrados' },
        count: { type: 'number', description: 'Total de coincidencias' }
      }
    }
  },

  /**
   * extract — Descarga y extrae contenido de una URL
   */
  async extract({ url, format = 'text' }) {
    if (!url) {
      return { success: false, error: 'url es requerida' };
    }

    try {
      // Validar URL
      new URL(url);
    } catch (e) {
      return { success: false, error: `URL inválida: ${url}` };
    }

    try {
      const response = await fetchUrl(url);

      let content;
      if (format === 'raw' || format === 'html') {
        content = response.body;
      } else {
        // text: extraer texto limpio del HTML
        const cheerio = getCheerio();
        const $ = cheerio.load(response.body);

        // Eliminar scripts, styles, nav, footer
        $('script, style, nav, footer, header, noscript, iframe').remove();

        // Extraer texto limpio
        content = $('body').text()
          .replace(/\s+/g, ' ')
          .replace(/\n\s*\n/g, '\n')
          .trim();
      }

      return {
        success: true,
        data: {
          content,
          format,
          size: Buffer.byteLength(response.body, 'utf-8'),
          contentType: response.contentType,
          statusCode: response.statusCode,
          url: response.finalUrl
        }
      };
    } catch (error) {
      return { success: false, error: `Error extrayendo ${url}: ${error.message}` };
    }
  },

  /**
   * metadata — Extrae metadata de la página
   */
  async metadata({ url }) {
    if (!url) {
      return { success: false, error: 'url es requerida' };
    }

    try {
      new URL(url);
    } catch (e) {
      return { success: false, error: `URL inválida: ${url}` };
    }

    try {
      const response = await fetchUrl(url);
      const cheerio = getCheerio();
      const $ = cheerio.load(response.body);

      // Title
      const title = $('title').first().text().trim() || '';

      // Meta description
      const description = $('meta[name="description"]').attr('content')
        || $('meta[property="og:description"]').attr('content')
        || '';

      // Open Graph
      const og = {};
      $('meta[property^="og:"]').each((_, el) => {
        const prop = $(el).attr('property').replace('og:', '');
        og[prop] = $(el).attr('content') || '';
      });

      // Headings structure
      const headings = [];
      $('h1, h2, h3').each((_, el) => {
        headings.push({
          level: parseInt(el.tagName.replace('h', ''), 10),
          text: $(el).text().trim().substring(0, 200)
        });
      });

      // Links
      const internalLinks = new Set();
      const externalLinks = new Set();
      const parsedBase = new URL(url);

      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
        try {
          const linkUrl = new URL(href, url);
          if (linkUrl.hostname === parsedBase.hostname) {
            internalLinks.add(linkUrl.pathname);
          } else {
            externalLinks.add(linkUrl.hostname);
          }
        } catch (e) { /* skip invalid */ }
      });

      // Images count
      const images = $('img').length;

      // Language
      const language = $('html').attr('lang') || $('meta[http-equiv="content-language"]').attr('content') || '';

      // Canonical
      const canonical = $('link[rel="canonical"]').attr('href') || '';

      return {
        success: true,
        data: {
          title,
          description,
          og,
          canonical,
          language,
          headings: headings.slice(0, 50),
          links: {
            internal: internalLinks.size,
            external: externalLinks.size,
            externalDomains: [...externalLinks].slice(0, 20)
          },
          images,
          url: response.finalUrl
        }
      };
    } catch (error) {
      return { success: false, error: `Error extrayendo metadata de ${url}: ${error.message}` };
    }
  },

  /**
   * search — Busca texto o extrae con selectores CSS
   */
  async search({ url, query, selector }) {
    if (!url) {
      return { success: false, error: 'url es requerida' };
    }
    if (!query && !selector) {
      return { success: false, error: 'Se requiere query o selector (o ambos)' };
    }

    try {
      new URL(url);
    } catch (e) {
      return { success: false, error: `URL inválida: ${url}` };
    }

    try {
      const response = await fetchUrl(url);
      const cheerio = getCheerio();
      const $ = cheerio.load(response.body);

      const matches = [];

      if (selector) {
        // Extraer elementos por selector CSS
        $(selector).each((i, el) => {
          const text = $(el).text().trim();
          const html = $(el).html();
          if (text) {
            matches.push({
              index: i,
              text: text.substring(0, 1000),
              tag: el.tagName || el.name,
              html: html ? html.substring(0, 2000) : ''
            });
          }
        });

        // Si también hay query, filtrar los resultados del selector
        if (query) {
          const lowerQuery = query.toLowerCase();
          const filtered = matches.filter(m => m.text.toLowerCase().includes(lowerQuery));
          return {
            success: true,
            data: {
              matches: filtered.slice(0, 100),
              count: filtered.length,
              selector,
              query,
              url: response.finalUrl
            }
          };
        }
      } else {
        // Buscar texto en el body
        $('script, style, noscript').remove();
        const lowerQuery = query.toLowerCase();

        // Buscar en todos los elementos de texto
        $('p, li, td, th, span, div, h1, h2, h3, h4, h5, h6, a, blockquote, pre, code').each((i, el) => {
          const text = $(el).clone().children().remove().end().text().trim();
          if (text && text.toLowerCase().includes(lowerQuery)) {
            matches.push({
              index: i,
              text: text.substring(0, 1000),
              tag: el.tagName || el.name,
              context: $(el).parent().text().trim().substring(0, 500)
            });
          }
        });
      }

      return {
        success: true,
        data: {
          matches: matches.slice(0, 100),
          count: matches.length,
          ...(selector && { selector }),
          ...(query && { query }),
          url: response.finalUrl
        }
      };
    } catch (error) {
      return { success: false, error: `Error buscando en ${url}: ${error.message}` };
    }
  }
};
