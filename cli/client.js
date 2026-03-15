/**
 * CLI HTTP Client - Cliente para interactuar con Event Core via HTTP
 *
 * El CLI es un cliente HTTP puro, no embebe lógica del core.
 * Se conecta al gateway HTTP y consume las APIs de los módulos.
 *
 * Características:
 * - HTTP requests (GET, POST, PUT, DELETE)
 * - Output formateado (JSON, tabla, raw)
 * - Error handling con códigos de salida
 * - Support para stdin/stdout pipes
 *
 * @example
 * const client = new CLIClient({ baseUrl: 'http://localhost:3000' });
 *
 * // GET request
 * const result = await client.get('/modules/echo/ping');
 * console.log(result);
 *
 * // POST request
 * const result = await client.post('/modules/echo/echo', { message: 'hello' });
 * console.log(result);
 */

const http = require('http');
const https = require('https');
const url = require('url');

class CLIClient {
  /**
   * @param {Object} options - Opciones
   * @param {string} options.baseUrl - URL base del gateway (default: http://localhost:3000)
   * @param {number} options.timeout - Timeout en ms (default: 10000)
   * @param {boolean} options.verbose - Modo verbose (default: false)
   */
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'http://localhost:3000';
    this.timeout = options.timeout || 10000;
    this.verbose = options.verbose || false;
  }

  /**
   * Realiza un HTTP request
   *
   * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
   * @param {string} path - Path relativo (ej: /modules/echo/ping)
   * @param {Object} data - Request body (opcional)
   * @param {Object} headers - Headers adicionales (opcional)
   * @returns {Promise<Object>} Response data
   */
  async request(method, path, data = null, headers = {}) {
    const fullUrl = `${this.baseUrl}${path}`;
    const parsedUrl = url.parse(fullUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'event-core-cli/0.1.0',
        ...headers
      },
      timeout: this.timeout
    };

    if (this.verbose) {
      console.error(`→ ${method} ${fullUrl}`);
      if (data) {
        console.error(`  Body: ${JSON.stringify(data)}`);
      }
    }

    return new Promise((resolve, reject) => {
      const req = lib.request(options, (res) => {
        let body = '';

        res.on('data', chunk => {
          body += chunk.toString();
        });

        res.on('end', () => {
          if (this.verbose) {
            console.error(`← ${res.statusCode} ${res.statusMessage}`);
          }

          try {
            const parsed = body.length > 0 ? JSON.parse(body) : null;

            // Si es error HTTP (4xx, 5xx), rechazar
            if (res.statusCode >= 400) {
              const error = new Error(parsed?.error?.message || `HTTP ${res.statusCode}`);
              error.statusCode = res.statusCode;
              error.response = parsed;
              reject(error);
            } else {
              resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                data: parsed
              });
            }
          } catch (error) {
            // Si no es JSON, devolver raw body
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              data: body
            });
          }
        });
      });

      req.on('error', (error) => {
        if (this.verbose) {
          console.error(`✗ Error: ${error.message}`);
        }
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        const error = new Error(`Request timeout after ${this.timeout}ms`);
        error.code = 'TIMEOUT';
        reject(error);
      });

      // Enviar body si existe
      if (data) {
        req.write(JSON.stringify(data));
      }

      req.end();
    });
  }

  /**
   * GET request
   *
   * @param {string} path - Path relativo
   * @param {Object} headers - Headers adicionales (opcional)
   * @returns {Promise<Object>} Response data
   */
  async get(path, headers = {}) {
    const response = await this.request('GET', path, null, headers);
    return response.data;
  }

  /**
   * POST request
   *
   * @param {string} path - Path relativo
   * @param {Object} data - Request body
   * @param {Object} headers - Headers adicionales (opcional)
   * @returns {Promise<Object>} Response data
   */
  async post(path, data, headers = {}) {
    const response = await this.request('POST', path, data, headers);
    return response.data;
  }

  /**
   * PUT request
   *
   * @param {string} path - Path relativo
   * @param {Object} data - Request body
   * @param {Object} headers - Headers adicionales (opcional)
   * @returns {Promise<Object>} Response data
   */
  async put(path, data, headers = {}) {
    const response = await this.request('PUT', path, data, headers);
    return response.data;
  }

  /**
   * DELETE request
   *
   * @param {string} path - Path relativo
   * @param {Object} headers - Headers adicionales (opcional)
   * @returns {Promise<Object>} Response data
   */
  async delete(path, headers = {}) {
    const response = await this.request('DELETE', path, null, headers);
    return response.data;
  }

  /**
   * Health check del gateway
   *
   * @returns {Promise<Object>} Health status
   */
  async health() {
    return await this.get('/health');
  }

  /**
   * Gateway stats
   *
   * @returns {Promise<Object>} Gateway statistics
   */
  async stats() {
    return await this.get('/stats');
  }
}

module.exports = CLIClient;
