/**
 * Módulo Calling Generator
 * Generates executable JavaScript functions from plugin definitions with HTTP and event-based execution
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');

class CallingGenerator {
  constructor() {
    this.name = 'calling-generator';
    this.version = '2.0.0';

    // Estado
    this.generatedFunctions = new Map(); // full_name -> { func, metadata }
    this.pluginsByName = new Map(); // plugin_name -> plugin_count
    this.pendingRequests = new Map(); // request_id -> { resolve, reject, timeout }

    // Dependencias (inyectadas)
    this.logger = null;
    this.metrics = null;
    this.eventBus = null;
    this.config = null;
    this.moduleManager = null;
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(core) {
    this.logger = core.logger;
    this.metrics = core.metrics;
    this.eventBus = core.eventBus;
    this.config = core.moduleConfig || {};
    this.moduleManager = core.moduleManager;
    this.moduleLoader = core.moduleLoader; // Para registrar tools
    this.activity = core.activity?.forModule('calling-generator');

    this.activity?.action('module.loading', {});
    this.logger.info('modulo.loading', { module: this.name });

    // Event subscriptions are auto-wired by the loader from module.json

    this.logger.info('modulo.loaded', { module: this.name });
  }

  async onUnload() {
    this.logger.info('modulo.unloading', { module: this.name });

    // Desregistrar funciones del Module Loader
    this.unregisterAllToolsFromModuleLoader();

    this.generatedFunctions.clear();
    this.pluginsByName.clear();
  }

  // ==========================================
  // Event Handlers (wired by loader from module.json)
  // ==========================================

  async onPluginLoaded(event) {
    const data = event.data || event.payload || event;
    const { name, definition } = data;

    this.logger.info('plugin.loaded.received', {
      plugin_name: name,
      correlation_id: event.correlation_id
    });

    if (!definition || !definition.functions) {
      this.logger.warn('plugin.invalid.no_functions', { plugin_name: name });
      return;
    }

    await this.generatePluginFunctions(definition, event.correlation_id);
  }

  async onGetFunctionRequest(event) {
    const { request_id, name } = event.payload;
    const correlationId = event.correlation_id;

    this.logger.info('function.get.request.received', {
      request_id,
      name,
      correlation_id: correlationId
    });

    const funcData = this.generatedFunctions.get(name);

    await this.eventBus.publish('function.get.response', {
      request_id,
      success: !!funcData,
      function: funcData ? funcData.metadata : undefined,
      error: funcData ? undefined : `Function not found: ${name}`
    }, { correlationId });
  }

  async onListFunctionsRequest(event) {
    const { request_id } = event.payload;
    const correlationId = event.correlation_id;

    this.logger.info('function.list.request.received', {
      request_id,
      correlation_id: correlationId
    });

    const functions = Array.from(this.generatedFunctions.values()).map(f => f.metadata);

    await this.eventBus.publish('function.list.response', {
      request_id,
      success: true,
      functions,
      count: functions.length
    }, { correlationId });
  }

  async onExecuteFunctionRequest(event) {
    const { request_id, name, args } = event.payload;
    const correlationId = event.correlation_id;

    this.logger.info('function.execute.request.received', {
      request_id,
      name,
      correlation_id: correlationId
    });

    try {
      const result = await this.executeFunction(name, args, correlationId);

      await this.eventBus.publish('function.execute.response', {
        request_id,
        success: true,
        result: result.result,
        duration: result.duration
      }, { correlationId });

    } catch (error) {
      this.logger.error('function.execute.request.error', {
        request_id,
        name,
        error: error.message,
        correlation_id: correlationId
      });

      await this.eventBus.publish('function.execute.response', {
        request_id,
        success: false,
        error: error.message
      }, { correlationId });
    }
  }

  // ==========================================
  // Core Function Generation
  // ==========================================

  async generatePluginFunctions(pluginData, correlationId) {
    const startTime = Date.now();

    try {
      if (!pluginData.metadata || !pluginData.metadata.name) {
        throw new Error('Invalid plugin: missing metadata.name');
      }

      const pluginName = pluginData.metadata.name;
      const baseUrl = pluginData.metadata.base_url;
      const authType = pluginData.metadata.auth_type || 'none';

      let generatedCount = 0;

      this.logger.info('plugin.functions.generating', {
        plugin_name: pluginName,
        functions_count: Object.keys(pluginData.functions).length,
        correlation_id: correlationId
      });

      for (const funcName in pluginData.functions) {
        const funcDef = pluginData.functions[funcName];
        const fullName = `${pluginName}.${funcName}`;

        try {
          const { func, metadata } = this.createCallingFunction(
            pluginName,
            funcName,
            funcDef,
            baseUrl,
            authType,
            pluginData
          );

          this.generatedFunctions.set(fullName, { func, metadata });
          generatedCount++;

          // Registrar como tool para AI en Module Loader
          this.registerToolForAI(fullName, func, metadata, correlationId);

          // REMOVED (migrate-to-event-metrics): this.metrics.increment('function.generated.total');
    // → Counter extracted from events

          await this.eventBus.publish('function.generated', {
            full_name: fullName,
            plugin_name: pluginName,
            function_name: funcName,
            type: metadata.type,
            generated_at: new Date().toISOString()
          }, { correlationId });

          this.logger.debug('function.generated', {
            full_name: fullName,
            type: metadata.type,
            correlation_id: correlationId
          });

        } catch (error) {
          this.logger.error('function.generation.error', {
            plugin_name: pluginName,
            function_name: funcName,
            error: error.message,
            correlation_id: correlationId
          });

          await this.eventBus.publish('function.generation.error', {
            plugin_name: pluginName,
            function_name: funcName,
            error: error.message
          }, { correlationId });
        }
      }

      this.pluginsByName.set(pluginName, generatedCount);

      const duration = Date.now() - startTime;

      // REMOVED: this.metrics.gauge('function.count', this.generatedFunctions.size);
      // REMOVED: this.metrics.gauge('function.plugins.count', this.pluginsByName.size);
      // REMOVED: this.metrics.timing('function.generation.duration', duration);

      this.logger.info('plugin.functions.generated', {
        plugin_name: pluginName,
        generated: generatedCount,
        total: Object.keys(pluginData.functions).length,
        duration,
        correlation_id: correlationId
      });

    } catch (error) {
      this.logger.error('plugin.generation.error', {
        error: error.message,
        correlation_id: correlationId
      });
    }
  }

  createCallingFunction(pluginName, funcName, funcDef, baseUrl, authType, pluginData) {
    const method = funcDef.method;
    const description = funcDef.description || `${pluginName} ${funcName}`;
    const parameters = funcDef.parameters || {};

    const metadata = {
      full_name: `${pluginName}.${funcName}`,
      plugin_name: pluginName,
      function_name: funcName,
      description,
      parameters,
      method,
      type: 'unknown'
    };

    // HTTP Function
    if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase())) {
      metadata.type = 'http';
      metadata.endpoint = funcDef.endpoint;

      const func = async (args, correlationId) => {
        return this.executeHttpFunction(
          pluginName,
          funcName,
          method,
          baseUrl,
          funcDef.endpoint,
          parameters,
          authType,
          pluginData,
          args,
          correlationId
        );
      };

      return { func, metadata };
    }

    // Local Function (Event-based)
    if (method === 'local_function') {
      metadata.type = 'local_event';
      const eventTopic = funcDef.event_topic || `${pluginName}.local.${funcName}.request`;
      metadata.event_topic = eventTopic;

      const func = async (args, correlationId) => {
        return this.executeLocalFunction(
          pluginName,
          funcName,
          eventTopic,
          args,
          correlationId
        );
      };

      return { func, metadata };
    }

    // Unsupported method
    this.logger.warn('function.unsupported.method', {
      plugin_name: pluginName,
      function_name: funcName,
      method
    });

    metadata.type = 'unsupported';

    const func = async (args, correlationId) => {
      throw new Error(`Function ${pluginName}.${funcName} uses unsupported method: ${method}`);
    };

    return { func, metadata };
  }

  // ==========================================
  // Function Execution
  // ==========================================

  async executeFunction(fullName, args, correlationId) {
    const startTime = Date.now();

    const funcData = this.generatedFunctions.get(fullName);

    if (!funcData) {
      throw new Error(`Function not found: ${fullName}`);
    }

    this.logger.info('function.executing', {
      full_name: fullName,
      correlation_id: correlationId
    });

    try {
      const result = await funcData.func(args, correlationId);

      const duration = Date.now() - startTime;

      // REMOVED (migrate-to-event-metrics): this.metrics.increment('function.executed.total');
    // → Counter extracted from events
      // REMOVED: this.metrics.timing('function.execution.duration', duration);

      await this.eventBus.publish('function.executed', {
        full_name: fullName,
        duration,
        has_result: !!result,
        executed_at: new Date().toISOString()
      }, { correlationId });

      this.logger.info('function.executed', {
        full_name: fullName,
        duration,
        correlation_id: correlationId
      });

      return { result, duration };

    } catch (error) {
      const duration = Date.now() - startTime;

      // REMOVED (migrate-to-event-metrics): this.metrics.increment('function.failed.total');
    // → Counter extracted from events

      await this.eventBus.publish('function.failed', {
        full_name: fullName,
        error: error.message,
        reason: this.categorizeError(error),
        failed_at: new Date().toISOString()
      }, { correlationId });

      this.logger.error('function.failed', {
        full_name: fullName,
        error: error.message,
        duration,
        correlation_id: correlationId
      });

      throw error;
    }
  }

  async executeHttpFunction(pluginName, funcName, method, baseUrl, endpoint, parameters, authType, pluginData, args, correlationId) {
    const startTime = Date.now();
    const fullName = `${pluginName}.${funcName}`;

    this.logger.debug('http.function.executing', {
      full_name: fullName,
      method,
      correlation_id: correlationId
    });

    // REMOVED (migrate-to-event-metrics): this.metrics.increment('function.http_call.total');
    // → Counter extracted from events

    let fullUrl = baseUrl + endpoint;
    const queryParams = new URLSearchParams();
    let requestBody = {};
    const headers = {
      'User-Agent': 'Aichat/2.0.0',
      'Content-Type': 'application/json'
    };

    // Procesar parámetros
    for (const paramName in (parameters.properties || {})) {
      const argValue = args[paramName];

      if (argValue === undefined) {
        if (parameters.required && parameters.required.includes(paramName)) {
          throw new Error(`Missing required argument: ${paramName}`);
        }
        continue;
      }

      // Path parameters
      if (fullUrl.includes(`{${paramName}}`)) {
        fullUrl = fullUrl.replace(`{${paramName}}`, encodeURIComponent(argValue));
      } else if (method.toUpperCase() === 'GET') {
        queryParams.append(paramName, argValue);
      } else {
        requestBody[paramName] = argValue;
      }
    }

    if (queryParams.toString()) {
      fullUrl += `?${queryParams.toString()}`;
    }

    // Autenticación
    this.addAuthentication(headers, queryParams, authType, pluginName, pluginData);

    try {
      const result = await this.makeHttpRequest(fullUrl, method, headers, requestBody, pluginName, funcName);

      const duration = Date.now() - startTime;

      // REMOVED (migrate-to-event-metrics): this.metrics.increment('function.http_call.success');
    // → Counter extracted from events
      // REMOVED: this.metrics.timing('function.http_call.duration', duration);

      this.logger.info('http.function.success', {
        full_name: fullName,
        status_code: result.status_code,
        duration,
        correlation_id: correlationId
      });

      return result;

    } catch (error) {
      // REMOVED (migrate-to-event-metrics): this.metrics.increment('function.http_call.error');
    // → Counter extracted from events

      this.logger.error('http.function.error', {
        full_name: fullName,
        error: error.message,
        correlation_id: correlationId
      });

      throw error;
    }
  }

  addAuthentication(headers, queryParams, authType, pluginName, pluginData) {
    const apiKey = process.env[`${pluginName.toUpperCase()}_API_KEY`];
    const authUser = process.env[`${pluginName.toUpperCase()}_AUTH_USER`];
    const authPass = process.env[`${pluginName.toUpperCase()}_AUTH_PASS`];

    switch (authType) {
      case 'bearer':
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
        break;

      case 'api_key_header':
        if (apiKey) {
          const headerName = pluginData.metadata.auth_header_name || 'X-API-Key';
          headers[headerName] = apiKey;
        }
        break;

      case 'api_key_query':
        if (apiKey) {
          const queryParamName = pluginData.metadata.auth_query_param_name || 'apiKey';
          queryParams.append(queryParamName, apiKey);
        }
        break;

      case 'basic_auth':
        if (authUser && authPass) {
          const encoded = Buffer.from(`${authUser}:${authPass}`).toString('base64');
          headers['Authorization'] = `Basic ${encoded}`;
        }
        break;

      case 'none':
      default:
        break;
    }
  }

  async makeHttpRequest(url, method, headers, body, pluginName, funcName) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'https:' ? https : http;

      const options = {
        method: method.toUpperCase(),
        headers: headers,
        timeout: this.config.httpTimeout || 30000
      };

      const req = client.request(url, options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const responseData = data ? JSON.parse(data) : {};
              resolve({
                success: true,
                data: responseData,
                status_code: res.statusCode
              });
            } catch (jsonError) {
              resolve({
                success: true,
                data: { raw: data },
                status_code: res.statusCode,
                message: 'Non-JSON response'
              });
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('HTTP request timeout'));
      });

      if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) && Object.keys(body).length > 0) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  async executeLocalFunction(pluginName, funcName, eventTopic, args, correlationId) {
    const fullName = `${pluginName}.${funcName}`;

    this.logger.debug('local.function.executing', {
      full_name: fullName,
      event_topic: eventTopic,
      correlation_id: correlationId
    });

    // REMOVED (migrate-to-event-metrics): this.metrics.increment('function.local_call.total');
    // → Counter extracted from events

    const requestId = crypto.randomUUID();
    const responseTopic = `${eventTopic}.response.${requestId}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.eventBus.unsubscribe(responseTopic);
        // REMOVED (migrate-to-event-metrics): this.metrics.increment('function.local_call.error');
    // → Counter extracted from events
        reject(new Error(`Local function call to ${fullName} timed out`));
      }, this.config.localFunctionTimeout || 5000);

      this.eventBus.subscribe(responseTopic, (responseEvent) => {
        clearTimeout(timeout);
        this.eventBus.unsubscribe(responseTopic);

        if (responseEvent.success) {
          // REMOVED (migrate-to-event-metrics): this.metrics.increment('function.local_call.success');
    // → Counter extracted from events
          resolve(responseEvent);
        } else {
          // REMOVED (migrate-to-event-metrics): this.metrics.increment('function.local_call.error');
    // → Counter extracted from events
          reject(new Error(responseEvent.error || `Local function ${fullName} failed`));
        }
      });

      this.eventBus.publish(eventTopic, {
        requestId,
        args,
        respondTo: responseTopic
      });
    });
  }

  // ==========================================
  // Module Loader Tools Integration
  // ==========================================

  /**
   * Registra una función generada como tool en el Module Loader
   * para que esté disponible para AI Gateway
   */
  registerToolForAI(fullName, func, metadata, correlationId) {
    if (!this.moduleLoader || !this.moduleLoader.toolsRegistry) {
      this.logger.warn('function.register.no_module_loader', {
        full_name: fullName,
        correlation_id: correlationId
      });
      return;
    }

    this.moduleLoader.toolsRegistry.set(fullName, {
      name: fullName,
      description: metadata.description,
      parameters: metadata.parameters || {},
      handler: func,
      module: metadata.plugin_name,
      confirmation: false, // Plugins HTTP no requieren confirmación por defecto
      type: metadata.type // 'http' o 'local_event'
    });

    this.logger.debug('function.registered.module_loader', {
      full_name: fullName,
      type: metadata.type,
      correlation_id: correlationId
    });
  }

  /**
   * Desregistra todas las funciones del Module Loader
   */
  unregisterAllToolsFromModuleLoader() {
    if (!this.moduleLoader || !this.moduleLoader.toolsRegistry) {
      return;
    }

    for (const fullName of this.generatedFunctions.keys()) {
      this.moduleLoader.toolsRegistry.delete(fullName);
    }

    this.logger.info('functions.unregistered.module_loader', {
      count: this.generatedFunctions.size
    });
  }

  // ==========================================
  // Utilities
  // ==========================================

  categorizeError(error) {
    const message = error.message.toLowerCase();

    if (message.includes('timeout')) return 'timeout';
    if (message.includes('http')) return 'http_error';
    if (message.includes('network')) return 'network_error';
    if (message.includes('missing required')) return 'validation_error';

    return 'module_error';
  }

  // ==========================================
  // HTTP API Handlers
  // ==========================================

  async handleListFunctions(req, context) {
    const functions = Array.from(this.generatedFunctions.values()).map(f => f.metadata);

    return {
      status: 200,
      data: {
        success: true,
        functions,
        count: functions.length
      }
    };
  }

  async handleGetFunction(req, context) {
    const name = context.params.name;

    this.logger.info('function.get.start', {
      name,
      correlation_id: context.correlationId
    });

    const funcData = this.generatedFunctions.get(name);

    if (!funcData) {
      return {
        status: 404,
        data: {
          success: false,
          error: `Function not found: ${name}`
        }
      };
    }

    return {
      status: 200,
      data: {
        success: true,
        function: funcData.metadata
      }
    };
  }

  async handleExecuteFunction(req, context) {
    const startTime = Date.now();
    const name = context.params.name;
    const { args } = context.body;

    this.logger.info('function.execute.start', {
      name,
      correlation_id: context.correlationId
    });

    try {
      const result = await this.executeFunction(name, args, context.correlationId);

      this.logger.info('function.executed.http', {
        name,
        duration: Date.now() - startTime,
        correlation_id: context.correlationId
      });

      return {
        status: 200,
        data: {
          success: true,
          result: result.result,
          duration: result.duration
        }
      };

    } catch (error) {
      this.logger.error('function.execute.error', {
        name,
        error: error.message,
        correlation_id: context.correlationId
      });

      return {
        status: 400,
        data: {
          success: false,
          error: error.message
        }
      };
    }
  }

  async handleHealthCheck(req, context) {
    return {
      status: 200,
      data: {
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        version: this.version,
        functions_count: this.generatedFunctions.size,
        plugins_count: this.pluginsByName.size
      }
    };
  }

  async handleGetMetrics(req, context) {
    return {
      status: 200,
      data: {
        counters: {
          'function.generated.total': this.metrics.getCounter('function.generated.total') || 0,
          'function.executed.total': this.metrics.getCounter('function.executed.total') || 0,
          'function.failed.total': this.metrics.getCounter('function.failed.total') || 0,
          'function.http_call.total': this.metrics.getCounter('function.http_call.total') || 0,
          'function.http_call.success': this.metrics.getCounter('function.http_call.success') || 0,
          'function.local_call.total': this.metrics.getCounter('function.local_call.total') || 0
        },
        gauges: {
          'function.count': this.generatedFunctions.size,
          'function.plugins.count': this.pluginsByName.size
        }
      }
    };
  }
}

module.exports = CallingGenerator;
