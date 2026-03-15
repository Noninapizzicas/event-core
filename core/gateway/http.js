/**
 * HTTP API Gateway - Expone APIs de módulos via HTTP
 *
 * Características:
 * - Servidor HTTP con Node.js built-in http module
 * - Enrutamiento automático desde ModuleRegistry
 * - Formato: /modules/{moduleName}/{path}
 * - JSON request/response
 * - Hook integration (beforeRequest, afterResponse)
 * - CORS support
 * - Request logging y metrics
 *
 * @example
 * const gateway = new HTTPGateway({
 *   port: 3000,
 *   registry,
 *   logger,
 *   metrics,
 *   hooks
 * });
 *
 * await gateway.start();
 */

const http = require('http');
const url = require('url');
const { ValidationError, createValidationMiddleware, createResponseValidationMiddleware, formatValidationErrorResponse } = require('../validation');
const CompressionMiddleware = require('./compression');
const { CacheManager } = require('./cache');

class HTTPGateway {
  /**
   * @param {Object} options - Opciones
   * @param {number} options.port - Puerto HTTP (default: 3000)
   * @param {string} options.host - Host (default: '0.0.0.0')
   * @param {Object} options.registry - ModuleRegistry instance
   * @param {Object} options.logger - Logger instance
   * @param {Object} options.metrics - Metrics instance
   * @param {Object} options.hooks - HookManager instance
   * @param {boolean} options.cors - Enable CORS (default: true)
   * @param {string} options.coreId - Core ID para logs
   * @param {Object} options.core - Core instance (for UI Gateway)
   * @param {Object} options.validationManager - ValidationManager instance (optional)
   * @param {Object} options.validation - Validation config (optional)
   * @param {Object} options.compression - Compression config (optional)
   * @param {Object} options.cache - Cache config (optional)
   * @param {number} options.maxBodySize - Max request body size in bytes (default: 1MB)
   */
  constructor(options = {}) {
    this.port = options.port || 3000;
    this.host = options.host || '0.0.0.0';
    this.registry = options.registry || null;
    this.logger = options.logger || null;
    this.metrics = options.metrics || null;
    this.hooks = options.hooks || null;
    this.cors = options.cors !== false;
    this.coreId = options.coreId || 'unknown';
    this.moduleLoader = options.moduleLoader || null;
    this.eventBus = options.eventBus || null;
    this.activity = options.activity || null;  // ActivityLogger for centralized monitoring
    this.maxBodySize = options.maxBodySize || 1024 * 1024; // 1MB default
    this.requestTimeout = options.requestTimeout || 30000; // 30s default

    this.server = null;
    this.isRunning = false;

    // Validation setup
    this.validationManager = options.validationManager || null;
    this.validationConfig = options.validation || {
      enabled: true,
      requireSchemas: false,
      validateResponses: false,
      strict: true
    };

    // Create validation middleware if ValidationManager is provided
    this.validateRequest = null;
    this.validateResponse = null;

    if (this.validationManager && this.validationConfig.enabled) {
      this.validateRequest = createValidationMiddleware(this.validationManager, {
        requireSchemas: this.validationConfig.requireSchemas,
        strict: this.validationConfig.strict,
        logger: this.logger
      });

      if (this.validationConfig.validateResponses) {
        this.validateResponse = createResponseValidationMiddleware(this.validationManager, {
          strict: false,  // Responses solo warning, nunca strict
          logger: this.logger
        });
      }
    }

    // Compression setup
    this.compressionConfig = options.compression || {
      enabled: true,
      minSize: 1024,
      level: 6
    };

    this.compression = new CompressionMiddleware({
      enabled: this.compressionConfig.enabled,
      minSize: this.compressionConfig.minSize,
      level: this.compressionConfig.level,
      logger: this.logger,
      metrics: this.metrics
    });

    // Cache setup
    this.cacheConfig = options.cache || {
      enabled: false,
      maxSize: 100,
      defaultTTL: 60000
    };

    this.cache = new CacheManager({
      enabled: this.cacheConfig.enabled,
      maxSize: this.cacheConfig.maxSize,
      defaultTTL: this.cacheConfig.defaultTTL,
      logger: this.logger,
      metrics: this.metrics
    });

    // UI Gateway integration
    this.uiGateway = null;
    if (options.core) {
      const UIGateway = require('./ui');
      this.uiGateway = new UIGateway(options.core);
    }

    /**
     * Estadísticas del gateway
     */
    this.stats = {
      requests: 0,
      errors: 0,
      by_method: {},
      by_status: {},
      started_at: null
    };

    /**
     * Log collector - publica interacciones HTTP a log-manager via MQTT
     */
    this.logCollectorEnabled = true;
  }

  /**
   * Envía log de interacción HTTP al log-manager via MQTT y ActivityLogger
   * @private
   */
  _logInteraction(data) {
    // No loguear requests al propio log-manager (evitar loop infinito)
    if (data.path && data.path.includes('/log-manager/')) return;

    // Log to ActivityLogger if available
    if (this.activity) {
      const phase = data.error ? 'error' : 'response';
      const targetModule = data.module || 'http-gateway';
      this.activity.logApiOperation(phase, data.method, data.path, {
        status: data.status,
        duration_ms: data.duration_ms,
        ...(data.error && { error: data.error })
      }, { module: targetModule });
    }

    // Legacy MQTT logging
    if (!this.logCollectorEnabled || !this.eventBus || !this.eventBus.mqtt?.isConnected) return;

    this.eventBus.mqtt.publish('log/http-gateway', JSON.stringify({
      ts: new Date().toISOString(),
      level: data.error ? 'error' : 'info',
      source: 'backend',
      module: 'http-gateway',
      msg: data.error ? 'request.error' : 'request.completed',
      ctx: data
    }), { qos: 0 }).catch(() => {
      // Silenciar errores de logging MQTT
    });
  }

  /**
   * Inicia el servidor HTTP
   *
   * @returns {Promise<void>}
   *
   * @example
   * await gateway.start();
   * console.log('Gateway running on port 3000');
   */
  async start() {
    if (this.isRunning) {
      throw new Error('Gateway already running');
    }

    this.server = http.createServer(async (req, res) => {
      await this.handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, (err) => {
        if (err) {
          if (this.logger) {
            this.logger.error('gateway.start.failed', {
              port: this.port,
              host: this.host,
              error: err.message
            }, err);
          }
          reject(err);
        } else {
          this.isRunning = true;
          this.stats.started_at = Date.now();

          if (this.logger) {
            this.logger.info('gateway.started', {
              port: this.port,
              host: this.host,
              cors: this.cors
            });
          }

          if (this.metrics) {
            this.metrics.increment('gateway.started');
          }

          resolve();
        }
      });
    });
  }

  /**
   * Detiene el servidor HTTP
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          this.isRunning = false;

          if (this.logger) {
            this.logger.info('gateway.stopped', {
              uptime: Date.now() - this.stats.started_at,
              total_requests: this.stats.requests
            });
          }

          resolve();
        }
      });
    });
  }

  /**
   * Maneja un request HTTP
   *
   * @param {http.IncomingMessage} req - HTTP request
   * @param {http.ServerResponse} res - HTTP response
   * @returns {Promise<void>}
   */
  async handleRequest(req, res) {
    const startTime = Date.now();
    const requestId = this.generateRequestId();

    // Request timeout handler
    let timeoutId = null;
    let timedOut = false;

    if (this.requestTimeout > 0) {
      timeoutId = setTimeout(() => {
        if (!res.writableEnded) {
          timedOut = true;
          this.stats.by_status[408] = (this.stats.by_status[408] || 0) + 1;
          res.writeHead(408, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 408, message: 'Request Timeout' } }));
          if (this.logger) {
            this.logger.warn('gateway.request.timeout', { request_id: requestId, timeout_ms: this.requestTimeout });
          }
        }
      }, this.requestTimeout);
    }

    try {
      // Actualizar estadísticas
      this.stats.requests++;
      this.stats.by_method[req.method] = (this.stats.by_method[req.method] || 0) + 1;

      // Parse URL
      const parsedUrl = url.parse(req.url, true);
      const pathname = parsedUrl.pathname;
      const query = parsedUrl.query;

      // Log request
      if (this.logger) {
        this.logger.debug('gateway.request', {
          request_id: requestId,
          method: req.method,
          path: pathname,
          query
        });
      }

      // CORS preflight
      if (this.cors && req.method === 'OPTIONS') {
        this.handleCORS(req, res);
        await this.sendResponse(res, 204, null, req);
        return;
      }

      // Health check endpoint
      if (pathname === '/health') {
        await this.handleHealth(req, res);
        return;
      }

      // Readiness check endpoint
      if (pathname === '/ready') {
        await this.handleReady(req, res);
        return;
      }

      // Stats endpoint
      if (pathname === '/stats') {
        await this.handleStats(req, res);
        return;
      }

      // Cache stats endpoint
      if (pathname === '/cache/stats') {
        await this.handleCacheStats(req, res);
        return;
      }

      // Cache clear endpoint
      if (pathname === '/cache/clear' && req.method === 'POST') {
        await this.handleCacheClear(req, res);
        return;
      }

      // UI routes - delegate to UI Gateway
      if (this.uiGateway && pathname.startsWith('/ui')) {
        await this.handleUIRoute(req, res, pathname, query);
        return;
      }

      // Shortcut route /1 -> log-test module
      if (pathname === '/1' || pathname === '/1/') {
        res.writeHead(302, { 'Location': '/modules/log-test/' });
        res.end();
        return;
      }

      // Blueprints API
      if (pathname === '/blueprints' && req.method === 'GET') {
        await this.handleListBlueprints(req, res);
        return;
      }

      if (pathname.startsWith('/blueprints/') && req.method === 'GET') {
        const blueprintName = pathname.replace('/blueprints/', '');
        await this.handleGetBlueprint(req, res, blueprintName);
        return;
      }

      // Parse body si es POST/PUT/PATCH
      let body = null;
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        body = await this.parseBody(req);
      }

      // Ejecutar hook beforeRequest
      let context = {
        request_id: requestId,
        method: req.method,
        path: pathname,
        query,
        body,
        headers: req.headers
      };

      if (this.hooks) {
        context = await this.hooks.execute('beforeRequest', context);
        if (context === null) {
          // Request bloqueado por hook
          await this.sendError(res, 403, 'Request blocked by hook');
          return;
        }
      }

      // Check cache first
      const cached = this.cache.get(req);
      if (cached) {
        if (cached.notModified) {
          // 304 Not Modified
          res.setHeader('ETag', cached.etag);
          await this.sendResponse(res, 304, null, req);
          return;
        }

        // Cache hit - return cached data
        if (cached.etag) {
          res.setHeader('ETag', cached.etag);
          res.setHeader('X-Cache', 'HIT');
          res.setHeader('Age', Math.floor(cached.age / 1000).toString());
        }

        await this.sendResponse(res, 200, cached.data, req);

        if (this.metrics) {
          this.metrics.observe('gateway.request.duration', Date.now() - startTime);
        }
        return;
      }

      // Cache miss - add header
      if (this.cache.shouldCache(req)) {
        res.setHeader('X-Cache', 'MISS');
      }

      // Buscar handler en registry
      if (!this.registry) {
        await this.sendError(res, 500, 'Module registry not configured');
        return;
      }

      const apiData = this.registry.findAPI(pathname, req.method);

      if (!apiData) {
        await this.sendError(res, 404, 'API endpoint not found');
        return;
      }

      // Validar request si está habilitado
      if (this.validateRequest) {
        try {
          await this.validateRequest(
            {
              method: req.method,
              path: pathname,
              query,
              body: context.body,
              headers: req.headers
            },
            {
              moduleAPI: apiData,
              method: req.method,
              path: pathname
            }
          );

          if (this.metrics) {
            this.metrics.increment('gateway.validation.success');
          }

        } catch (validationError) {
          if (validationError instanceof ValidationError) {
            if (this.logger) {
              this.logger.warn('gateway.validation.failed', {
                request_id: requestId,
                module: apiData.moduleName,
                api: apiData.apiName,
                error_count: validationError.errors?.length || 0
              });
            }

            if (this.metrics) {
              this.metrics.increment('gateway.validation.failed');
            }

            const errorResponse = formatValidationErrorResponse(validationError, {
              includeDetails: true
            });

            await this.sendError(res, 400, errorResponse.error, {
              validation_errors: errorResponse.validation_errors
            });
            return;
          }
          // Re-throw si no es ValidationError
          throw validationError;
        }
      }

      // Ejecutar handler del módulo
      let result;
      try {
        // Construir objeto de contexto para el handler
        const handlerContext = {
          correlationId: requestId,
          request_id: requestId,
          timestamp: new Date().toISOString()
        };

        result = await apiData.handler({
          method: req.method,
          path: pathname,
          query,
          body: context.body,
          headers: req.headers,
          request_id: requestId,
          params: apiData.params || {} // Include route params (e.g., :id extracted from path)
        }, handlerContext);
      } catch (handlerError) {
        if (this.logger) {
          this.logger.error('gateway.handler.error', {
            request_id: requestId,
            module: apiData.moduleName,
            api: apiData.apiName,
            error: handlerError.message
          }, handlerError);
        }

        await this.sendError(res, 500, 'Handler execution failed', {
          error: handlerError.message
        });
        return;
      }

      // Validar response si está habilitado (modo warning)
      if (this.validateResponse) {
        try {
          await this.validateResponse(result, {
            moduleAPI: apiData,
            method: req.method,
            path: pathname
          });
        } catch (validationError) {
          // Response validation solo hace warning, no falla
          if (this.logger) {
            this.logger.warn('gateway.response.validation.warning', {
              request_id: requestId,
              module: apiData.moduleName,
              api: apiData.apiName,
              error: validationError.message
            });
          }
        }
      }

      // Ejecutar hook afterResponse
      // Si el result tiene status/headers/body, usarlos directamente
      let responseContext;
      if (result && typeof result === 'object' && result.status !== undefined) {
        responseContext = {
          request_id: requestId,
          status: result.status,
          data: result.data,
          body: result.body,
          headers: result.headers
        };
      } else if (result && typeof result === 'object' && result._html !== undefined) {
        // Convención _html para respuestas HTML desde módulos
        responseContext = {
          request_id: requestId,
          status: 200,
          body: result._html,
          headers: { 'Content-Type': result._contentType || 'text/html; charset=utf-8' }
        };
      } else {
        responseContext = {
          request_id: requestId,
          status: 200,
          data: result
        };
      }

      if (this.hooks) {
        responseContext = await this.hooks.execute('afterResponse', responseContext);
        if (responseContext === null) {
          // Response bloqueado por hook
          await this.sendError(res, 500, 'Response blocked by hook');
          return;
        }
      }

      // Cache successful responses
      if (responseContext.status >= 200 && responseContext.status < 300) {
        this.cache.set(req, responseContext.data, {
          status: responseContext.status,
          ttl: this.cacheConfig.defaultTTL
        });
      }

      // Enviar respuesta
      // Si hay body + headers, es una respuesta HTML/custom
      if (responseContext.body !== undefined && responseContext.headers) {
        // Aplicar headers custom
        for (const [key, value] of Object.entries(responseContext.headers)) {
          res.setHeader(key, value);
        }

        // Enviar body directamente
        const contentType = responseContext.headers['Content-Type'] || 'text/html';
        await this._sendCompressedResponse(res, responseContext.status, responseContext.body, contentType, req);
      } else {
        // Respuesta JSON normal
        await this.sendResponse(res, responseContext.status, responseContext.data, req);
      }

      // Metrics
      if (this.metrics) {
        this.metrics.observe('gateway.request.duration', Date.now() - startTime);
        this.metrics.increment('gateway.request.success');
      }

      // Log interaction to log-manager
      this._logInteraction({
        request_id: requestId,
        method: req.method,
        path: pathname,
        module: apiData?.moduleName,
        status: responseContext.status,
        duration: Date.now() - startTime
      });

    } catch (error) {
      this.stats.errors++;

      if (this.logger) {
        this.logger.error('gateway.request.error', {
          request_id: requestId,
          error: error.message
        }, error);
      }

      if (this.metrics) {
        this.metrics.increment('gateway.request.errors');
      }

      // Log error interaction
      this._logInteraction({
        request_id: requestId,
        method: req.method,
        path: req.url?.split('?')[0] || req.url,  // parsedUrl may not be defined yet
        status: 500,
        duration: Date.now() - startTime,
        error: error.message
      });

      if (!timedOut) {
        await this.sendError(res, 500, 'Internal server error', {
          error: error.message
        });
      }
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Maneja CORS headers
   *
   * @param {http.IncomingMessage} req - HTTP request
   * @param {http.ServerResponse} res - HTTP response
   */
  handleCORS(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-ID');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  /**
   * Maneja /health endpoint
   *
   * @param {http.IncomingMessage} req - HTTP request
   * @param {http.ServerResponse} res - HTTP response
   */
  async handleHealth(req, res) {
    const health = {
      status: 'healthy',
      core_id: this.coreId,
      uptime: Date.now() - this.stats.started_at,
      timestamp: new Date().toISOString()
    };

    await this.sendResponse(res, 200, health, req);
  }

  /**
   * Maneja /ready endpoint - Kubernetes readiness probe
   *
   * @param {http.IncomingMessage} req - HTTP request
   * @param {http.ServerResponse} res - HTTP response
   */
  async handleReady(req, res) {
    // Check if all components are ready
    const checks = {
      gateway: this.isRunning,
      event_bus: this.eventBus !== null,
      module_loader: this.moduleLoader !== null,
      registry: this.registry !== null
    };

    // Check if modules are loaded (if module loader exists)
    if (this.moduleLoader) {
      const loadedModules = this.moduleLoader.getLoadedModules();
      checks.modules_loaded = loadedModules.length > 0;
      checks.module_count = loadedModules.length;
    }

    const isReady = Object.values(checks).every(v => v === true || typeof v === 'number');

    const readiness = {
      ready: isReady,
      core_id: this.coreId,
      checks,
      timestamp: new Date().toISOString()
    };

    const statusCode = isReady ? 200 : 503;
    await this.sendResponse(res, statusCode, readiness, req);
  }

  /**
   * Maneja /stats endpoint
   *
   * @param {http.IncomingMessage} req - HTTP request
   * @param {http.ServerResponse} res - HTTP response
   */
  async handleStats(req, res) {
    const stats = {
      ...this.stats,
      uptime: Date.now() - this.stats.started_at,
      timestamp: new Date().toISOString()
    };

    // Agregar APIs registradas
    if (this.registry) {
      stats.apis = this.registry.getAllAPIs();
      stats.total_apis = stats.apis.length;
    }

    // Include compression statistics
    if (this.compression) {
      stats.compression = this.compression.getStats();
    }

    await this.sendResponse(res, 200, stats, req);
  }

  /**
   * Maneja /cache/stats endpoint
   *
   * @param {http.IncomingMessage} req - HTTP request
   * @param {http.ServerResponse} res - HTTP response
   */
  async handleCacheStats(req, res) {
    const stats = this.cache.getStats();

    await this.sendResponse(res, 200, {
      cache: stats,
      compression: this.compression.getStats(),
      timestamp: new Date().toISOString()
    }, req);
  }

  /**
   * Maneja /cache/clear endpoint
   *
   * @param {http.IncomingMessage} req - HTTP request
   * @param {http.ServerResponse} res - HTTP response
   */
  async handleCacheClear(req, res) {
    const sizeBefore = this.cache.cache.size();
    this.cache.clear();

    if (this.logger) {
      this.logger.info('gateway.cache.cleared', {
        entries_cleared: sizeBefore
      });
    }

    await this.sendResponse(res, 200, {
      success: true,
      entries_cleared: sizeBefore,
      timestamp: new Date().toISOString()
    }, req);
  }

  /**
   * Maneja /blueprints endpoint - Lista todos los blueprints
   *
   * @param {http.IncomingMessage} req - HTTP request
   * @param {http.ServerResponse} res - HTTP response
   */
  async handleListBlueprints(req, res) {
    const fs = require('fs');
    const path = require('path');
    const yaml = require('js-yaml');

    const blueprintsPath = path.join(process.cwd(), 'blueprints');
    const blueprints = [];

    try {
      if (fs.existsSync(blueprintsPath)) {
        const files = fs.readdirSync(blueprintsPath);

        for (const file of files) {
          if (file.endsWith('.yaml') && !file.startsWith('_')) {
            const filePath = path.join(blueprintsPath, file);
            const content = fs.readFileSync(filePath, 'utf8');
            const data = yaml.load(content);

            blueprints.push({
              name: file.replace('.yaml', ''),
              filename: file,
              metadata: {
                name: data.name,
                description: data.description,
                version: data.version,
                author: data.author,
                icon: data.icon
              },
              entity: data.entity,
              fieldsCount: data.fields?.length || 0,
              eventsCount: (data.events?.publish?.length || 0) + (data.events?.subscribe?.length || 0),
              apisCount: data.apis?.length || 0,
              ui: data.ui
            });
          }
        }
      }

      await this.sendResponse(res, 200, {
        blueprints,
        total: blueprints.length,
        path: blueprintsPath,
        timestamp: new Date().toISOString()
      }, req);

    } catch (error) {
      await this.sendError(res, 500, 'Error reading blueprints', {
        error: error.message
      });
    }
  }

  /**
   * Maneja /blueprints/:name endpoint - Obtiene un blueprint específico
   *
   * @param {http.IncomingMessage} req - HTTP request
   * @param {http.ServerResponse} res - HTTP response
   * @param {string} blueprintName - Nombre del blueprint
   */
  async handleGetBlueprint(req, res, blueprintName) {
    const fs = require('fs');
    const path = require('path');
    const yaml = require('js-yaml');

    const blueprintsPath = path.join(process.cwd(), 'blueprints');
    const filePath = path.join(blueprintsPath, `${blueprintName}.yaml`);

    try {
      if (!fs.existsSync(filePath)) {
        await this.sendError(res, 404, 'Blueprint not found', {
          name: blueprintName
        });
        return;
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const data = yaml.load(content);

      await this.sendResponse(res, 200, {
        name: blueprintName,
        filename: `${blueprintName}.yaml`,
        content: data,
        raw: content,
        timestamp: new Date().toISOString()
      }, req);

    } catch (error) {
      await this.sendError(res, 500, 'Error reading blueprint', {
        error: error.message
      });
    }
  }

  /**
   * Parse request body
   *
   * @param {http.IncomingMessage} req - HTTP request
   * @returns {Promise<Object|null>} Parsed body
   */
  async parseBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      let bodySize = 0;

      req.on('data', chunk => {
        bodySize += chunk.length;
        if (bodySize > this.maxBodySize) {
          req.destroy();
          reject(new Error(`Request body too large. Max size: ${this.maxBodySize} bytes`));
          return;
        }
        body += chunk.toString();
      });

      req.on('end', () => {
        try {
          if (body.length === 0) {
            resolve(null);
          } else {
            const parsed = JSON.parse(body);
            resolve(parsed);
          }
        } catch (error) {
          reject(new Error('Invalid JSON body'));
        }
      });

      req.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Envía respuesta JSON
   *
   * @param {http.ServerResponse} res - HTTP response
   * @param {number} statusCode - HTTP status code
   * @param {Object|null} data - Response data
   * @param {Object} req - HTTP request (optional, for compression headers)
   */
  async sendResponse(res, statusCode, data, req = null) {
    // Actualizar estadísticas
    this.stats.by_status[statusCode] = (this.stats.by_status[statusCode] || 0) + 1;

    // CORS headers
    if (this.cors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    // Check for special response types (HTML, SSE, etc.)
    if (data && typeof data === 'object' && data._responseType) {
      const type = data._responseType;

      if (type === 'html') {
        await this._sendCompressedResponse(res, statusCode, data.content || '', 'text/html', req);
        return;
      }

      if (type === 'css') {
        await this._sendCompressedResponse(res, statusCode, data.content || '', 'text/css', req);
        return;
      }

      if (type === 'javascript') {
        await this._sendCompressedResponse(res, statusCode, data.content || '', 'application/javascript', req);
        return;
      }

      if (type === 'sse') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.statusCode = 200;

        // Keep connection open and let handler manage it
        // Handler should store res and write to it
        if (data.onConnect && typeof data.onConnect === 'function') {
          data.onConnect(res);
        }
        return;
      }
    }

    // Default: JSON response
    const jsonData = data !== null ? JSON.stringify(data) : '';
    await this._sendCompressedResponse(res, statusCode, jsonData, 'application/json', req);
  }

  /**
   * Send response with optional compression
   *
   * @param {http.ServerResponse} res - HTTP response
   * @param {number} statusCode - HTTP status code
   * @param {string|Buffer} data - Response data
   * @param {string} contentType - Content-Type
   * @param {Object} req - HTTP request (for headers)
   * @private
   */
  async _sendCompressedResponse(res, statusCode, data, contentType, req) {
    res.setHeader('Content-Type', contentType);
    res.statusCode = statusCode;

    // Try compression if request headers available
    if (req && req.headers && data) {
      try {
        const result = await this.compression.compress(data, req.headers, contentType);

        if (result.compressed) {
          // Set compression headers
          res.setHeader('Content-Encoding', result.encoding);
          res.setHeader('Vary', 'Accept-Encoding');
          res.setHeader('Content-Length', result.compressedSize);

          if (this.logger) {
            this.logger.debug('gateway.response.compressed', {
              encoding: result.encoding,
              ratio: `${result.ratio}%`,
              bytes_saved: result.bytesSaved
            });
          }

          res.end(result.data);
          return;
        }
      } catch (error) {
        if (this.logger) {
          this.logger.error('gateway.compression.error', {
            error: error.message
          }, error);
        }
        // Fall through to uncompressed
      }
    }

    // Send uncompressed
    if (data) {
      res.end(data);
    } else {
      res.end();
    }
  }

  /**
   * Envía error JSON
   *
   * @param {http.ServerResponse} res - HTTP response
   * @param {number} statusCode - HTTP status code
   * @param {string} message - Error message
   * @param {Object} details - Error details (opcional)
   */
  async sendError(res, statusCode, message, details = {}) {
    await this.sendResponse(res, statusCode, {
      error: {
        code: statusCode,
        message,
        ...details
      }
    });
  }

  /**
   * Genera un request ID único
   *
   * @returns {string} Request ID
   */
  generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Maneja rutas de UI - delega al UI Gateway
   *
   * @param {http.IncomingMessage} req - HTTP request
   * @param {http.ServerResponse} res - HTTP response
   * @param {string} pathname - Request pathname
   * @param {Object} query - Query parameters
   */
  async handleUIRoute(req, res, pathname, query) {
    try {
      // Create a simplified request/response object
      const request = {
        method: req.method,
        url: pathname,
        headers: req.headers,
        query,
        params: {}
      };

      const response = {
        writeHead: (statusCode, headers) => {
          res.writeHead(statusCode, headers);
        },
        end: (data) => {
          res.end(data);
        }
      };

      // Route to appropriate UI Gateway handler
      if (pathname === '/ui' || pathname === '/ui/') {
        await this.uiGateway.serveAdminPanel(request, response);
      } else if (pathname === '/ui/modules') {
        await this.uiGateway.listModulesWithUI(request, response);
      } else if (pathname.startsWith('/ui/modules/')) {
        // Extract module name from path: /ui/modules/:name
        const moduleName = pathname.replace('/ui/modules/', '');
        request.params.name = moduleName;
        await this.uiGateway.getModuleUI(request, response);
      } else if (pathname.match(/^\/ui\/[a-z0-9-]+$/i)) {
        // Dynamic module view: /ui/:moduleName
        const moduleName = pathname.replace('/ui/', '');
        await this.uiGateway.renderModuleView(request, response, moduleName);
      } else {
        // Serve static file
        await this.uiGateway.serveStaticFile(request, response);
      }
    } catch (error) {
      if (this.logger) {
        this.logger.error('gateway.ui.error', {
          path: pathname,
          error: error.message
        }, error);
      }

      await this.sendError(res, 500, 'UI Gateway error', {
        error: error.message
      });
    }
  }

  /**
   * Obtiene estadísticas del gateway
   *
   * @returns {Object} Estadísticas
   */
  getStats() {
    return {
      ...this.stats,
      uptime: this.stats.started_at ? Date.now() - this.stats.started_at : 0,
      is_running: this.isRunning
    };
  }
}

module.exports = HTTPGateway;
