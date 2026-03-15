/**
 * Provider Executor - Ejecuta funciones de providers (HTTP y local)
 *
 * Responsabilidades:
 * - Ejecutar llamadas HTTP para providers externos
 * - Ejecutar funciones locales directamente
 * - Manejo de errores y timeouts
 * - Construcción de requests desde templates
 *
 * @example
 * const executor = new ProviderExecutor({ registry, logger });
 *
 * // Ejecutar función externa
 * const result = await executor.execute('google', 'vision.extract', {
 *   image: base64Image
 * });
 *
 * // Ejecutar función local
 * const pdf = await executor.execute('local.pdf', 'create', {
 *   type: 'from_text',
 *   content: 'Hello PDF'
 * });
 */

const https = require('https');
const http = require('http');

class ProviderExecutor {
  /**
   * @param {Object} options - Opciones
   * @param {Object} options.registry - ProviderRegistry instance
   * @param {Object} options.logger - Logger instance
   * @param {Object} options.credentialResolver - Función para resolver credenciales
   * @param {number} options.timeout - Timeout por defecto en ms
   */
  constructor(options = {}) {
    this.registry = options.registry;
    this.logger = options.logger || null;
    this.credentialResolver = options.credentialResolver || this.defaultCredentialResolver;
    this.timeout = options.timeout || 30000;

    /**
     * Cache de handlers locales
     * Map: providerName -> module instance
     */
    this.localHandlers = new Map();
  }

  /**
   * Resolver de credenciales por defecto (process.env)
   *
   * @param {string} key - Nombre de la variable de entorno
   * @returns {string|null}
   */
  defaultCredentialResolver(key) {
    return process.env[key] || null;
  }

  /**
   * Registra un handler local
   *
   * @param {string} providerName - Nombre del provider local
   * @param {Object} handler - Módulo con funciones
   */
  registerLocalHandler(providerName, handler) {
    this.localHandlers.set(providerName, handler);

    if (this.logger) {
      this.logger.debug('executor.local.registered', {
        provider: providerName,
        functions: Object.keys(handler.functions || handler).filter(k => typeof (handler[k] || handler.functions?.[k]) === 'function')
      });
    }
  }

  /**
   * Ejecuta una función de un provider
   *
   * @param {string} providerName - Nombre del provider
   * @param {string} functionName - Nombre de la función
   * @param {Object} input - Parámetros de entrada
   * @param {Object} options - Opciones adicionales
   * @returns {Promise<Object>} Resultado de la ejecución
   */
  async execute(providerName, functionName, input, options = {}) {
    const startTime = Date.now();

    try {
      const provider = this.registry.get(providerName);
      if (!provider) {
        throw new Error(`Provider not found: ${providerName}`);
      }

      if (!provider.available) {
        throw new Error(`Provider not available: ${providerName}`);
      }

      const functionDef = provider.functions[functionName];
      if (!functionDef) {
        throw new Error(`Function not found: ${providerName}.${functionName}`);
      }

      let result;
      if (provider.type === 'local') {
        result = await this.executeLocal(providerName, functionName, input, options);
      } else {
        result = await this.executeHTTP(provider, functionDef, input, options);
      }

      if (this.logger) {
        this.logger.debug('executor.success', {
          provider: providerName,
          function: functionName,
          duration_ms: Date.now() - startTime
        });
      }

      return {
        success: true,
        data: result,
        duration_ms: Date.now() - startTime
      };

    } catch (error) {
      if (this.logger) {
        this.logger.error('executor.failed', {
          provider: providerName,
          function: functionName,
          error: error.message,
          duration_ms: Date.now() - startTime
        });
      }

      return {
        success: false,
        error: error.message,
        duration_ms: Date.now() - startTime
      };
    }
  }

  /**
   * Ejecuta una función local
   *
   * @param {string} providerName - Nombre del provider
   * @param {string} functionName - Nombre de la función
   * @param {Object} input - Parámetros
   * @param {Object} options - Opciones
   * @returns {Promise<*>}
   */
  async executeLocal(providerName, functionName, input, options = {}) {
    const handler = this.localHandlers.get(providerName);
    if (!handler) {
      throw new Error(`Local handler not registered: ${providerName}`);
    }

    // Buscar la función en el handler
    const fn = handler[functionName];
    if (typeof fn !== 'function') {
      throw new Error(`Function not implemented: ${providerName}.${functionName}`);
    }

    // Ejecutar con timeout
    const timeout = options.timeout || this.timeout;
    return Promise.race([
      fn.call(handler, input),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Execution timeout')), timeout)
      )
    ]);
  }

  /**
   * Ejecuta una llamada HTTP externa
   *
   * @param {Object} provider - Configuración del provider
   * @param {Object} functionDef - Definición de la función
   * @param {Object} input - Parámetros
   * @param {Object} options - Opciones
   * @returns {Promise<*>}
   */
  async executeHTTP(provider, functionDef, input, options = {}) {
    // Resolver credencial
    const credential = provider.credential
      ? this.credentialResolver(provider.credential)
      : null;

    if (provider.credential && !credential) {
      throw new Error(`Credential not found: ${provider.credential}`);
    }

    // Construir URL
    const baseUrl = functionDef.base_url || provider.base_url;
    const endpoint = this.replaceTemplateVars(functionDef.endpoint || '', input);
    const url = new URL(endpoint, baseUrl);

    // Aplicar autenticación
    const auth = functionDef.auth || provider.auth;
    const headers = { ...functionDef.headers };

    if (auth && credential) {
      switch (auth.type) {
        case 'bearer':
          headers['Authorization'] = `Bearer ${credential}`;
          break;
        case 'query_param':
          url.searchParams.set(auth.param || 'key', credential);
          break;
        case 'header':
          headers[auth.header_name || 'X-API-Key'] = credential;
          break;
        case 'basic':
          headers['Authorization'] = `Basic ${Buffer.from(credential).toString('base64')}`;
          break;
      }
    }

    // Construir body desde template
    let body = null;
    if (functionDef.request_template && functionDef.method !== 'GET') {
      body = JSON.stringify(this.replaceTemplateVarsDeep(functionDef.request_template, input));
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }

    // Ejecutar request
    const response = await this.httpRequest({
      method: functionDef.method || 'POST',
      url: url.toString(),
      headers,
      body,
      timeout: options.timeout || this.timeout
    });

    // Extraer resultado según response_path
    let result = response;
    if (functionDef.response_path) {
      result = this.extractByPath(response, functionDef.response_path);
    }

    return result;
  }

  /**
   * Reemplaza variables de template {{var}} en un string
   *
   * @param {string} template - String con placeholders
   * @param {Object} vars - Valores a reemplazar
   * @returns {string}
   */
  replaceTemplateVars(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return vars[key] !== undefined ? vars[key] : match;
    });
  }

  /**
   * Reemplaza variables de template recursivamente en un objeto
   *
   * @param {*} obj - Objeto/array/string
   * @param {Object} vars - Valores a reemplazar
   * @returns {*}
   */
  replaceTemplateVarsDeep(obj, vars) {
    if (typeof obj === 'string') {
      // Si es exactamente "{{var}}", devolver el valor directamente (preserva tipo)
      const exactMatch = obj.match(/^\{\{(\w+)\}\}$/);
      if (exactMatch) {
        return vars[exactMatch[1]] !== undefined ? vars[exactMatch[1]] : obj;
      }
      return this.replaceTemplateVars(obj, vars);
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.replaceTemplateVarsDeep(item, vars));
    }

    if (obj && typeof obj === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.replaceTemplateVarsDeep(value, vars);
      }
      return result;
    }

    return obj;
  }

  /**
   * Extrae valor de objeto por path (dot notation)
   *
   * @param {Object} obj - Objeto fuente
   * @param {string} path - Path (ej: 'responses[0].text')
   * @returns {*}
   */
  extractByPath(obj, path) {
    // Soporta: 'foo.bar', 'foo[0].bar', 'foo[0][1].bar'
    const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let current = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[part];
    }

    return current;
  }

  /**
   * Ejecuta un HTTP request
   *
   * @param {Object} options - Opciones del request
   * @returns {Promise<Object>}
   */
  httpRequest(options) {
    return new Promise((resolve, reject) => {
      const url = new URL(options.url);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const reqOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || this.timeout
      };

      const req = lib.request(reqOptions, (res) => {
        let data = '';

        res.on('data', chunk => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            // Intentar parsear como JSON
            const parsed = JSON.parse(data);

            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${parsed.error?.message || data}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            // Si no es JSON, devolver como string
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
}

module.exports = ProviderExecutor;
