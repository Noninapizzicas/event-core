const http = require('http');

/**
 * Tool Manager (Unified)
 *
 * Gestiona tools que los agentes pueden llamar.
 *
 * MODO UNIFICADO (con moduleLoader):
 *   - Importa TODOS los tools del ModuleLoader.toolsRegistry (módulos + providers)
 *   - Registra solo los builtins ÚNICOS del agente (13 tools)
 *   - Crea aliases backward-compatible para nombres legacy
 *   → Resultado: un solo registro compartido con chat/ai-gateway
 *
 * MODO STANDALONE (sin moduleLoader, fallback):
 *   - Comportamiento original: builtins + providers independientes
 *
 * @version 2.0.0 - Unified tools
 */
class ToolManager {
  constructor(config, logger, coreConfig, eventBus = null) {
    this.config = config;
    this.logger = logger;
    this.coreConfig = coreConfig;
    this.eventBus = eventBus;

    // Available tools: Map<toolName, toolSpec>
    this.tools = new Map();

    // Provider registry reference (injected)
    this.providerRegistry = null;

    // Module loader reference for unified mode (injected)
    this.moduleLoader = null;
  }

  /**
   * Initialize tool manager
   *
   * Unified mode: import from moduleLoader + agent builtins
   * Standalone mode: builtins + provider tools (original behavior)
   */
  async initialize() {
    if (this.moduleLoader) {
      // === UNIFIED MODE ===
      // 1. Import ALL tools from moduleLoader (modules + providers)
      this.importModuleLoaderTools();

      // 2. Register agent-specific builtin tools (unique to agents)
      this.registerAgentBuiltinTools();

      // 3. Register backward-compatible aliases for legacy tool names
      this.registerBackwardAliases();

      this.logger.info('tool-manager.initialized.unified', {
        tools_count: this.tools.size,
        source: 'moduleLoader + agent-builtins'
      });
    } else {
      // === STANDALONE MODE (fallback) ===
      this.registerBuiltinTools();

      if (this.providerRegistry) {
        this.registerProviderTools();
      }

      this.logger.info('tool-manager.initialized.standalone', {
        tools_count: this.tools.size,
        plugin_tools_enabled: !!this.eventBus
      });
    }
  }

  /**
   * Set module loader for unified tool access
   * When set, tools are imported from moduleLoader instead of duplicated
   */
  setModuleLoader(moduleLoader) {
    this.moduleLoader = moduleLoader;
  }

  /**
   * Set provider registry for auto-discovery
   */
  setProviderRegistry(registry) {
    this.providerRegistry = registry;
  }

  // ============================================================
  // UNIFIED MODE: Import from ModuleLoader
  // ============================================================

  /**
   * Import all tools from ModuleLoader.toolsRegistry
   * This gives agents access to ALL module tools + provider tools
   * in a single unified registry (same tools chat/ai-gateway uses)
   */
  importModuleLoaderTools() {
    const registry = this.moduleLoader.toolsRegistry;

    if (!registry || registry.size === 0) {
      this.logger.warn('tool-manager.moduleLoader.no-tools');
      return;
    }

    let imported = 0;

    for (const [toolName, toolDef] of registry) {
      this.tools.set(toolName, {
        name: toolName,
        description: toolDef.description,
        parameters: toolDef.parameters,
        handler: toolDef.handler,
        source: 'moduleLoader',
        module: toolDef.module,
        confirmation: toolDef.confirmation || false
      });
      imported++;
    }

    this.logger.info('tool-manager.imported-from-module-loader', {
      count: imported,
      sample: Array.from(registry.keys()).slice(0, 5)
    });
  }

  /**
   * Register agent-specific builtin tools
   * These are tools UNIQUE to the agent framework (not in moduleLoader)
   */
  registerAgentBuiltinTools() {
    // --- CORE AGENT TOOLS ---

    this.registerTool({
      name: 'http_request',
      description: 'Make HTTP request to any API',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'HTTP method (GET, POST, PUT, DELETE)' },
          url: { type: 'string', description: 'Full URL to request' },
          body: { type: 'object', description: 'Request body (optional)' },
          headers: { type: 'object', description: 'Request headers (optional)' }
        },
        required: ['method', 'url']
      },
      handler: this.httpRequestTool.bind(this)
    });

    this.registerTool({
      name: 'publish_event',
      description: 'Publish event to MQTT bus',
      parameters: {
        type: 'object',
        properties: {
          event_type: { type: 'string', description: 'Event topic name' },
          payload: { type: 'object', description: 'Event payload data' }
        },
        required: ['event_type', 'payload']
      },
      handler: this.publishEventTool.bind(this)
    });

    // --- AGENT ARCHITECT TOOLS ---

    this.registerTool({
      name: 'create_prompt',
      description: 'Create a new prompt in prompt-manager for agent configuration',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Prompt name' },
          content: { type: 'string', description: 'Prompt content' },
          slot_type: { type: 'string', description: 'Slot type (default: system)' },
          description: { type: 'string', description: 'Prompt description' },
          tags: { type: 'array', description: 'Tags for categorization' }
        },
        required: ['name', 'content']
      },
      handler: this.createPromptTool.bind(this)
    });

    this.registerTool({
      name: 'create_agent',
      description: 'Create a new AI agent in the agent framework',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Agent name' },
          description: { type: 'string', description: 'Agent description' },
          prompt_id: { type: 'string', description: 'Prompt ID to use' },
          subscribes: { type: 'array', description: 'Events to listen to' },
          tools: { type: 'array', description: 'Allowed tool names' },
          provider: { type: 'string', description: 'AI provider (default: deepseek)' },
          model: { type: 'string', description: 'Model name' },
          temperature: { type: 'number', description: 'Temperature (0-1)' },
          enabled: { type: 'boolean', description: 'Enable on creation' }
        },
        required: ['name', 'prompt_id', 'subscribes']
      },
      handler: this.createAgentTool.bind(this)
    });

    this.registerTool({
      name: 'list_agents',
      description: 'List all registered agents in the framework',
      parameters: {
        type: 'object',
        properties: {
          enabled_only: { type: 'boolean', description: 'Only show enabled agents' }
        },
        required: []
      },
      handler: this.listAgentsTool.bind(this)
    });

    // --- FLOW ENGINE TOOLS ---

    this.registerTool({
      name: 'flow_list',
      description: 'List all available flows, optionally filtered by project',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Filter by project ID (optional)' }
        },
        required: []
      },
      handler: this.flowListTool.bind(this)
    });

    this.registerTool({
      name: 'flow_trigger',
      description: 'Trigger/execute a flow manually with optional input data',
      parameters: {
        type: 'object',
        properties: {
          flow_id: { type: 'string', description: 'Flow ID to trigger (e.g., "mi-proyecto:procesar-factura")' },
          data: { type: 'object', description: 'Input data for the flow trigger' }
        },
        required: ['flow_id']
      },
      handler: this.flowTriggerTool.bind(this)
    });

    this.registerTool({
      name: 'flow_status',
      description: 'Get status of flow executions',
      parameters: {
        type: 'object',
        properties: {
          execution_id: { type: 'string', description: 'Specific execution ID (optional)' },
          flow_id: { type: 'string', description: 'Filter by flow ID (optional)' }
        },
        required: []
      },
      handler: this.flowStatusTool.bind(this)
    });

    // --- PROJECT CONFIG TOOLS ---

    this.registerTool({
      name: 'project_config_get',
      description: 'Get project configuration',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID' },
          config_file: { type: 'string', description: 'Config file name (default: main config)' }
        },
        required: ['project_id']
      },
      handler: this.projectConfigGetTool.bind(this)
    });

    this.registerTool({
      name: 'project_config_update',
      description: 'Update project configuration (e.g., change schedule, enable/disable features)',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID' },
          config_file: { type: 'string', description: 'Config file name' },
          updates: { type: 'object', description: 'Key-value pairs to update (supports dot notation like "schedule.gmail")' }
        },
        required: ['project_id', 'updates']
      },
      handler: this.projectConfigUpdateTool.bind(this)
    });

    // --- FACTURAS TOOLS ---

    this.registerTool({
      name: 'facturas_list',
      description: 'List invoices/facturas from a project database',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID (e.g., "mi-proyecto")' },
          status: { type: 'string', description: 'Filter by status: pendiente, procesada, exportada, error' },
          limit: { type: 'number', description: 'Max results (default: 50)' }
        },
        required: ['project_id']
      },
      handler: this.facturasListTool.bind(this)
    });

    this.registerTool({
      name: 'facturas_process',
      description: 'Process pending invoices with OCR',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID' },
          factura_id: { type: 'number', description: 'Specific invoice ID (optional, processes all pending if omitted)' }
        },
        required: ['project_id']
      },
      handler: this.facturasProcessTool.bind(this)
    });

    this.registerTool({
      name: 'facturas_export',
      description: 'Export processed invoices to Excel',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID' },
          format: { type: 'string', description: 'Export format: libro-registro, resumen (default: libro-registro)' }
        },
        required: ['project_id']
      },
      handler: this.facturasExportTool.bind(this)
    });
  }

  /**
   * Register backward-compatible aliases for legacy tool names
   * Maps old underscore names → moduleLoader dot-notation tools
   * So existing agent configs keep working
   */
  registerBackwardAliases() {
    if (!this.moduleLoader) return;

    const aliases = {
      // old_name → { target: moduleLoader tool name, mapArgs: param adapter }
      'read_file': {
        target: 'fs.read',
        mapArgs: (args) => args // same params: {path}
      },
      'write_file': {
        target: 'fs.write',
        mapArgs: (args) => args // same params: {path, content}
      },
      'fs_copy': {
        target: 'fs.copy',
        mapArgs: (args) => ({ from: args.source, to: args.destination })
      },
      'fs_write': {
        target: 'fs.write',
        mapArgs: (args) => args // same params: {path, content}
      },
      'telegram_send_message': {
        target: 'telegram.send_message',
        mapArgs: (args) => args // same params: {botName, chatId, text, parseMode}
      },
      'telegram_get_file': {
        target: 'telegram.get_file',
        mapArgs: (args) => args // same params: {botName, fileId, download}
      },
      'db_execute': {
        target: 'db.query',
        mapArgs: (args) => ({
          projectId: args.project_id,
          query: args.query,
          params: args.params
        })
      }
    };

    let aliasCount = 0;

    for (const [aliasName, aliasDef] of Object.entries(aliases)) {
      // Skip if alias name is already registered (e.g., by agent builtins)
      if (this.tools.has(aliasName)) continue;

      // Skip if target doesn't exist in moduleLoader
      const targetTool = this.tools.get(aliasDef.target);
      if (!targetTool) {
        this.logger.debug('tool-manager.alias.target-missing', {
          alias: aliasName,
          target: aliasDef.target
        });
        continue;
      }

      // Create alias with param mapping
      const mapArgs = aliasDef.mapArgs;
      this.tools.set(aliasName, {
        name: aliasName,
        description: targetTool.description,
        parameters: targetTool.parameters,
        handler: async (args) => {
          const mappedArgs = mapArgs(args);
          return targetTool.handler(mappedArgs);
        },
        source: 'alias',
        _aliasOf: aliasDef.target,
        module: targetTool.module
      });

      aliasCount++;
    }

    if (aliasCount > 0) {
      this.logger.info('tool-manager.backward-aliases.registered', {
        count: aliasCount
      });
    }
  }

  // ============================================================
  // STANDALONE MODE: Original behavior (fallback)
  // ============================================================

  /**
   * Auto-register providers as AI tools (standalone mode only)
   * In unified mode, providers are already in moduleLoader
   */
  registerProviderTools() {
    if (!this.providerRegistry) {
      this.logger.warn('tool-manager.provider-registry.not-available');
      return;
    }

    const stats = this.providerRegistry.getStats();
    this.logger.info('tool-manager.registering-provider-tools', {
      providers: stats.total_providers,
      functions: stats.total_functions
    });

    const providersInfo = this.providerRegistry.getAll();

    for (const providerInfo of providersInfo) {
      if (!providerInfo.available) {
        this.logger.debug('tool-manager.provider.skipped', {
          provider: providerInfo.name,
          reason: 'not available'
        });
        continue;
      }

      const provider = this.providerRegistry.get(providerInfo.name);
      if (!provider || !provider.functions) {
        this.logger.debug('tool-manager.provider.skipped', {
          provider: providerInfo.name,
          reason: 'no functions defined'
        });
        continue;
      }

      for (const [fnName, fnDef] of Object.entries(provider.functions)) {
        const toolName = this.buildToolName(providerInfo.name, fnName);
        const eventName = fnDef.event || `${providerInfo.name}.${fnName}.request`;

        const parameters = this.buildParametersSchema(fnDef.input);

        this.registerTool({
          name: toolName,
          description: fnDef.description || `${providerInfo.name} ${fnName}`,
          parameters,
          handler: this.createProviderToolHandler(eventName, providerInfo.name, fnName)
        });

        this.logger.debug('tool-manager.provider-tool.registered', {
          tool: toolName,
          event: eventName
        });
      }
    }

    this.logger.info('tool-manager.provider-tools.registered', {
      count: this.tools.size
    });
  }

  /**
   * Register ALL built-in tools (standalone mode only)
   * In unified mode, use registerAgentBuiltinTools() instead
   */
  registerBuiltinTools() {
    // --- Tools that exist in moduleLoader (kept for standalone mode) ---

    this.registerTool({
      name: 'http_request',
      description: 'Make HTTP request to any API',
      parameters: {
        method: { type: 'string', required: true },
        url: { type: 'string', required: true },
        body: { type: 'object', required: false },
        headers: { type: 'object', required: false }
      },
      handler: this.httpRequestTool.bind(this)
    });

    this.registerTool({
      name: 'publish_event',
      description: 'Publish event to MQTT bus',
      parameters: {
        event_type: { type: 'string', required: true },
        payload: { type: 'object', required: true }
      },
      handler: this.publishEventTool.bind(this)
    });

    this.registerTool({
      name: 'read_file',
      description: 'Read file contents',
      parameters: {
        path: { type: 'string', required: true }
      },
      handler: this.readFileTool.bind(this)
    });

    this.registerTool({
      name: 'write_file',
      description: 'Write file contents',
      parameters: {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true }
      },
      handler: this.writeFileTool.bind(this)
    });

    this.registerTool({
      name: 'create_prompt',
      description: 'Create a new prompt in prompt-manager for agent configuration',
      parameters: {
        name: { type: 'string', required: true },
        content: { type: 'string', required: true },
        slot_type: { type: 'string', required: false },
        description: { type: 'string', required: false },
        tags: { type: 'array', required: false }
      },
      handler: this.createPromptTool.bind(this)
    });

    this.registerTool({
      name: 'create_agent',
      description: 'Create a new AI agent in the agent framework',
      parameters: {
        name: { type: 'string', required: true },
        description: { type: 'string', required: false },
        prompt_id: { type: 'string', required: true },
        subscribes: { type: 'array', required: true },
        tools: { type: 'array', required: false },
        provider: { type: 'string', required: false },
        model: { type: 'string', required: false },
        temperature: { type: 'number', required: false },
        enabled: { type: 'boolean', required: false }
      },
      handler: this.createAgentTool.bind(this)
    });

    this.registerTool({
      name: 'list_agents',
      description: 'List all registered agents in the framework',
      parameters: {
        enabled_only: { type: 'boolean', required: false }
      },
      handler: this.listAgentsTool.bind(this)
    });

    this.registerTool({
      name: 'telegram_send_message',
      description: 'Send text message to Telegram chat',
      parameters: {
        type: 'object',
        properties: {
          botName: { type: 'string', description: 'Bot name (e.g., facturas_asesoria_bot)' },
          chatId: { type: 'number', description: 'Telegram chat ID' },
          text: { type: 'string', description: 'Message text' },
          parseMode: { type: 'string', description: 'Parse mode: HTML or Markdown' }
        },
        required: ['botName', 'chatId', 'text']
      },
      handler: this.telegramSendMessageTool.bind(this)
    });

    this.registerTool({
      name: 'telegram_get_file',
      description: 'Get file info and optionally download from Telegram',
      parameters: {
        type: 'object',
        properties: {
          botName: { type: 'string', description: 'Bot name' },
          fileId: { type: 'string', description: 'Telegram file ID' },
          download: { type: 'boolean', description: 'Download file to storage' }
        },
        required: ['botName', 'fileId']
      },
      handler: this.telegramGetFileTool.bind(this)
    });

    this.registerTool({
      name: 'fs_copy',
      description: 'Copy file from source to destination',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source file path' },
          destination: { type: 'string', description: 'Destination file path' }
        },
        required: ['source', 'destination']
      },
      handler: this.fsCopyTool.bind(this)
    });

    this.registerTool({
      name: 'fs_write',
      description: 'Write content to file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'File content' }
        },
        required: ['path', 'content']
      },
      handler: this.writeFileTool.bind(this)
    });

    this.registerTool({
      name: 'db_execute',
      description: 'Execute SQL query on project database',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID (or "system")' },
          query: { type: 'string', description: 'SQL query to execute' },
          params: { type: 'array', description: 'Query parameters' }
        },
        required: ['project_id', 'query']
      },
      handler: this.dbExecuteTool.bind(this)
    });

    this.registerTool({
      name: 'flow_list',
      description: 'List all available flows, optionally filtered by project',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Filter by project ID (optional)' }
        },
        required: []
      },
      handler: this.flowListTool.bind(this)
    });

    this.registerTool({
      name: 'flow_trigger',
      description: 'Trigger/execute a flow manually with optional input data',
      parameters: {
        type: 'object',
        properties: {
          flow_id: { type: 'string', description: 'Flow ID to trigger' },
          data: { type: 'object', description: 'Input data for the flow trigger' }
        },
        required: ['flow_id']
      },
      handler: this.flowTriggerTool.bind(this)
    });

    this.registerTool({
      name: 'flow_status',
      description: 'Get status of flow executions',
      parameters: {
        type: 'object',
        properties: {
          execution_id: { type: 'string', description: 'Specific execution ID (optional)' },
          flow_id: { type: 'string', description: 'Filter by flow ID (optional)' }
        },
        required: []
      },
      handler: this.flowStatusTool.bind(this)
    });

    this.registerTool({
      name: 'project_config_get',
      description: 'Get project configuration',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID' },
          config_file: { type: 'string', description: 'Config file name (default: main config)' }
        },
        required: ['project_id']
      },
      handler: this.projectConfigGetTool.bind(this)
    });

    this.registerTool({
      name: 'project_config_update',
      description: 'Update project configuration',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID' },
          config_file: { type: 'string', description: 'Config file name' },
          updates: { type: 'object', description: 'Key-value pairs to update' }
        },
        required: ['project_id', 'updates']
      },
      handler: this.projectConfigUpdateTool.bind(this)
    });

    this.registerTool({
      name: 'facturas_list',
      description: 'List invoices/facturas from a project database',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID' },
          status: { type: 'string', description: 'Filter by status' },
          limit: { type: 'number', description: 'Max results (default: 50)' }
        },
        required: ['project_id']
      },
      handler: this.facturasListTool.bind(this)
    });

    this.registerTool({
      name: 'facturas_process',
      description: 'Process pending invoices with OCR',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID' },
          factura_id: { type: 'number', description: 'Specific invoice ID (optional)' }
        },
        required: ['project_id']
      },
      handler: this.facturasProcessTool.bind(this)
    });

    this.registerTool({
      name: 'facturas_export',
      description: 'Export processed invoices to Excel',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID' },
          format: { type: 'string', description: 'Export format: libro-registro, resumen' }
        },
        required: ['project_id']
      },
      handler: this.facturasExportTool.bind(this)
    });
  }

  // ============================================================
  // TOOL REGISTRATION & EXECUTION
  // ============================================================

  /**
   * Register a new tool
   */
  registerTool(toolSpec) {
    if (!toolSpec.name || !toolSpec.handler) {
      throw new Error('Tool must have name and handler');
    }

    this.tools.set(toolSpec.name, toolSpec);

    this.logger.debug('tool-manager.tool.registered', {
      tool: toolSpec.name
    });
  }

  /**
   * Unregister a tool
   */
  unregisterTool(toolName) {
    this.tools.delete(toolName);
  }

  /**
   * Get tool spec
   */
  getTool(toolName) {
    return this.tools.get(toolName);
  }

  /**
   * List all tools
   */
  listTools() {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }));
  }

  /**
   * Execute tool
   * Supports built-in tools, moduleLoader tools, and plugin tools
   */
  async executeTool(toolName, args, allowedTools = []) {
    // Check if agent is allowed to use this tool
    if (allowedTools.length > 0 && !allowedTools.includes(toolName)) {
      throw new Error(`Tool '${toolName}' not allowed for this agent`);
    }

    // Check local registry (includes moduleLoader imports + builtins + aliases)
    const tool = this.tools.get(toolName);

    if (tool) {
      this.logger.debug('tool-manager.executing', {
        tool: toolName,
        source: tool.source || 'builtin'
      });

      // Validate parameters (skip for moduleLoader tools - they validate internally)
      if (!tool.source || tool.source !== 'moduleLoader') {
        this.validateParameters(tool, args);
      }

      // Execute with timeout
      const timeout = this.config.timeout_ms || 10000;

      const result = await Promise.race([
        tool.handler(args),
        this.timeoutPromise(timeout)
      ]);

      this.logger.info('tool-manager.tool.executed', {
        tool: toolName,
        source: tool.source || 'builtin'
      });

      return result;
    }

    // If not in registry, try calling via Tool Orchestrator (plugin tool)
    if (this.eventBus) {
      this.logger.debug('tool-manager.executing.plugin', { tool: toolName });
      return this.executePluginTool(toolName, args);
    }

    // Tool not found
    throw new Error(`Tool '${toolName}' not found (neither registered nor plugin)`);
  }

  /**
   * Execute a plugin tool via Tool Orchestrator
   */
  async executePluginTool(toolName, args) {
    const crypto = require('crypto');
    const requestId = crypto.randomUUID();
    const responseTopic = `tool.call.response.${requestId}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.eventBus.unsubscribe(responseTopic);
        reject(new Error(`Plugin tool '${toolName}' execution timeout`));
      }, this.config.timeout_ms || 30000);

      this.eventBus.subscribe(responseTopic, (response) => {
        clearTimeout(timeout);
        this.eventBus.unsubscribe(responseTopic);

        if (response.success) {
          this.logger.info('tool-manager.tool.executed', {
            tool: toolName,
            type: 'plugin',
            duration: response.duration
          });
          resolve(response.result);
        } else {
          this.logger.error('tool-manager.tool.failed', {
            tool: toolName,
            error: response.error
          });
          reject(new Error(response.error || `Plugin tool '${toolName}' failed`));
        }
      });

      this.eventBus.publish('tool.call.request', {
        toolName,
        args,
        requesterRespondToTopic: responseTopic,
        requestId
      });
    });
  }

  /**
   * Validate tool parameters
   */
  validateParameters(tool, args) {
    const params = tool.parameters || {};

    // Handle JSON Schema format (type: object, properties: {...})
    if (params.type === 'object' && params.properties) {
      const required = params.required || [];
      for (const reqParam of required) {
        if (!(reqParam in (args || {}))) {
          throw new Error(`Missing required parameter '${reqParam}' for tool '${tool.name}'`);
        }
      }
      return;
    }

    // Handle flat format ({paramName: {type, required}})
    for (const [paramName, paramSpec] of Object.entries(params)) {
      if (paramSpec.required && !(paramName in (args || {}))) {
        throw new Error(`Missing required parameter '${paramName}' for tool '${tool.name}'`);
      }
    }
  }

  /**
   * Timeout promise
   */
  timeoutPromise(ms) {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Tool execution timeout')), ms);
    });
  }

  // ============================================================
  // HELPER METHODS
  // ============================================================

  /**
   * Build tool name from provider and function (standalone mode)
   */
  buildToolName(providerName, fnName) {
    const cleanProvider = providerName
      .replace('local.', '')
      .replace(/-/g, '_');
    return `${cleanProvider}_${fnName}`;
  }

  /**
   * Build OpenAI-compatible parameters schema (standalone mode)
   */
  buildParametersSchema(input) {
    if (!input) {
      return { type: 'object', properties: {}, required: [] };
    }

    const properties = {};
    const required = [];

    for (const [paramName, paramDef] of Object.entries(input)) {
      if (typeof paramDef === 'object') {
        properties[paramName] = {
          type: paramDef.type || 'string',
          description: paramDef.description || paramName
        };
        if (paramDef.required) {
          required.push(paramName);
        }
      } else {
        properties[paramName] = {
          type: 'string',
          description: String(paramDef)
        };
      }
    }

    return { type: 'object', properties, required };
  }

  /**
   * Create event-driven handler for provider tool (standalone mode)
   */
  createProviderToolHandler(eventName, providerName, fnName) {
    return async (args) => {
      if (!this.eventBus) {
        return { success: false, error: 'EventBus not available' };
      }

      const crypto = require('crypto');
      const request_id = crypto.randomUUID();
      const responseEvent = eventName.replace('.request', '.response');

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this.eventBus.off(responseEvent, handler);
          resolve({
            success: false,
            error: `${providerName}.${fnName} timeout`
          });
        }, this.config.timeout_ms || 30000);

        const handler = (event) => {
          const data = event?.data || event;
          if (data.request_id === request_id) {
            clearTimeout(timeout);
            this.eventBus.off(responseEvent, handler);
            resolve(data);
          }
        };

        this.eventBus.on(responseEvent, handler);

        this.eventBus.publish(eventName, {
          request_id,
          ...args
        });
      });
    };
  }

  // ============================================================
  // TOOL HANDLERS - Core agent tools
  // ============================================================

  /**
   * Tool: HTTP Request
   */
  async httpRequestTool(args) {
    const { method, url, body, headers } = args;

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);

      const options = {
        method,
        hostname: urlObj.hostname,
        port: urlObj.port || 80,
        path: urlObj.pathname + urlObj.search,
        headers: headers || {}
      };

      const req = http.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseBody));
          } catch {
            resolve(responseBody);
          }
        });
      });

      req.on('error', reject);
      if (body) { req.write(JSON.stringify(body)); }
      req.end();
    });
  }

  /**
   * Tool: Publish Event
   */
  async publishEventTool(args) {
    const { event_type, payload } = args;

    if (!this.eventBus) {
      throw new Error('EventBus not available');
    }

    await this.eventBus.publish(event_type, payload);
    return { success: true, event_type };
  }

  // ============================================================
  // TOOL HANDLERS - Agent architect tools
  // ============================================================

  async createPromptTool(args) {
    const { name, content, slot_type = 'system', description = '', tags = [] } = args;

    const port = this.coreConfig?.http?.port || 3000;
    const url = `http://localhost:${port}/modules/prompt-manager/prompts`;

    try {
      const response = await this.httpRequestTool({
        method: 'POST',
        url,
        body: {
          name, content, slot_type,
          description: description || `Prompt for agent: ${name}`,
          tags: Array.isArray(tags) ? tags : []
        },
        headers: { 'Content-Type': 'application/json' }
      });

      return {
        success: true,
        prompt_id: response?.prompt?.id || response?.id,
        prompt_name: name,
        message: `Prompt '${name}' created successfully`
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async createAgentTool(args) {
    const {
      name, description = '', prompt_id, subscribes,
      tools = ['http_request'], provider = 'deepseek',
      model = 'deepseek-chat', temperature = 0.3, enabled = true
    } = args;

    const port = this.coreConfig?.http?.port || 3000;
    const url = `http://localhost:${port}/modules/ai-agent-framework/agents`;

    try {
      const response = await this.httpRequestTool({
        method: 'POST',
        url,
        body: {
          name, description: description || `Agent: ${name}`,
          prompt_id,
          subscribes: Array.isArray(subscribes) ? subscribes : [subscribes],
          tools: Array.isArray(tools) ? tools : [tools],
          provider, model, temperature,
          max_tokens: 2000, context_enabled: true, context_window: 10, enabled
        },
        headers: { 'Content-Type': 'application/json' }
      });

      return {
        success: true,
        agent_id: response?.agent?.id || response?.id,
        agent_name: name,
        subscribes,
        message: `Agent '${name}' created, listening to: ${(Array.isArray(subscribes) ? subscribes : [subscribes]).join(', ')}`
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async listAgentsTool(args) {
    const { enabled_only = false } = args || {};

    const port = this.coreConfig?.http?.port || 3000;
    const url = `http://localhost:${port}/modules/ai-agent-framework/agents`;

    try {
      const response = await this.httpRequestTool({
        method: 'GET', url,
        headers: { 'Content-Type': 'application/json' }
      });

      let agents = response?.agents || [];
      if (enabled_only) {
        agents = agents.filter(a => a.enabled);
      }

      return {
        success: true,
        count: agents.length,
        agents: agents.map(a => ({
          id: a.id, name: a.name, description: a.description,
          enabled: a.enabled, subscribes: a.subscribes, provider: a.provider
        }))
      };
    } catch (error) {
      return { success: false, error: error.message, agents: [] };
    }
  }

  // ============================================================
  // TOOL HANDLERS - Event-driven (used by standalone mode + internal)
  // ============================================================

  async readFileTool(args) {
    const { path } = args;
    if (!this.eventBus) return { success: false, error: 'EventBus not available' };

    const crypto = require('crypto');
    const request_id = crypto.randomUUID();

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: 'Filesystem read timeout' });
      }, 10000);

      const handler = (event) => {
        const data = event?.data || event;
        if (data.request_id === request_id) {
          clearTimeout(timeout);
          this.eventBus.off('fs.read.response', handler);
          resolve(data);
        }
      };

      this.eventBus.on('fs.read.response', handler);
      this.eventBus.publish('fs.read.request', { request_id, path });
    });
  }

  async writeFileTool(args) {
    const { path, content, encoding } = args;
    if (!this.eventBus) return { success: false, error: 'EventBus not available' };

    const crypto = require('crypto');
    const request_id = crypto.randomUUID();

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: 'Filesystem write timeout' });
      }, 10000);

      const handler = (event) => {
        const data = event?.data || event;
        if (data.request_id === request_id) {
          clearTimeout(timeout);
          this.eventBus.off('fs.write.response', handler);
          resolve(data);
        }
      };

      this.eventBus.on('fs.write.response', handler);
      this.eventBus.publish('fs.write.request', { request_id, path, content, encoding });
    });
  }

  async telegramSendMessageTool(args) {
    const { botName, chatId, text, parseMode } = args;
    if (!this.eventBus) return { success: false, error: 'EventBus not available' };

    const crypto = require('crypto');
    const request_id = crypto.randomUUID();

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: 'Telegram send message timeout' });
      }, 10000);

      const handler = (event) => {
        const data = event?.data || event;
        if (data.request_id === request_id) {
          clearTimeout(timeout);
          this.eventBus.off('telegram.send_message.response', handler);
          resolve({
            success: data.success,
            message_id: data.messageId,
            chat_id: chatId,
            error: data.error
          });
        }
      };

      this.eventBus.on('telegram.send_message.response', handler);
      this.eventBus.publish('telegram.send_message.request', {
        request_id, botName, chatId, text, parseMode
      });
    });
  }

  async telegramGetFileTool(args) {
    const { botName, fileId, download = true } = args;
    if (!this.eventBus) return { success: false, error: 'EventBus not available' };

    const crypto = require('crypto');
    const request_id = crypto.randomUUID();

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: 'Telegram get file timeout' });
      }, 30000);

      const handler = (event) => {
        const data = event?.data || event;
        if (data.request_id === request_id) {
          clearTimeout(timeout);
          this.eventBus.off('telegram.get_file.response', handler);
          resolve({
            success: data.success,
            file_path: data.localPath || data.filePath,
            file_size: data.fileSize,
            file_id: fileId,
            download_url: data.downloadUrl,
            error: data.error
          });
        }
      };

      this.eventBus.on('telegram.get_file.response', handler);
      this.eventBus.publish('telegram.get_file.request', {
        request_id, botName, fileId, download
      });
    });
  }

  async fsCopyTool(args) {
    const { source, destination } = args;
    if (!this.eventBus) return { success: false, error: 'EventBus not available' };

    const crypto = require('crypto');
    const request_id = crypto.randomUUID();

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: 'Filesystem copy timeout' });
      }, 10000);

      const handler = (event) => {
        const data = event?.data || event;
        if (data.request_id === request_id) {
          clearTimeout(timeout);
          this.eventBus.off('fs.copy.response', handler);
          resolve(data);
        }
      };

      this.eventBus.on('fs.copy.response', handler);
      this.eventBus.publish('fs.copy.request', { request_id, source, destination });
    });
  }

  async dbExecuteTool(args) {
    const { project_id, query, params = [] } = args;
    if (!this.eventBus) return { success: false, error: 'EventBus not available' };

    const crypto = require('crypto');
    const requestId = crypto.randomUUID();

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: 'Database query timeout' });
      }, 10000);

      const handler = (event) => {
        const data = event.data || event;
        if (data.request_id === requestId) {
          clearTimeout(timeout);
          this.eventBus.off('db.query.response', handler);

          if (data.success) {
            resolve({ success: true, data: data.data, changes: data.changes });
          } else {
            resolve({ success: false, error: data.error });
          }
        }
      };

      this.eventBus.on('db.query.response', handler);
      this.eventBus.publish('db.query.request', {
        project_id, query, params, request_id: requestId
      });
    });
  }

  // ============================================================
  // TOOL HANDLERS - Flow engine tools
  // ============================================================

  async flowListTool(args) {
    const { project_id } = args || {};
    const port = this.coreConfig?.http?.port || 3000;
    let url = `http://localhost:${port}/api/flow-engine/flows`;
    if (project_id) url += `?project=${project_id}`;

    try {
      const response = await this.httpRequestTool({
        method: 'GET', url,
        headers: { 'Content-Type': 'application/json' }
      });

      const flows = response?.flows || [];
      return {
        success: true,
        count: flows.length,
        flows: flows.map(f => ({
          id: f.id, name: f.name, project: f.projectId,
          enabled: f.enabled, trigger: f.trigger?.event || f.trigger?.type
        }))
      };
    } catch (error) {
      return { success: false, error: error.message, flows: [] };
    }
  }

  async flowTriggerTool(args) {
    const { flow_id, data = {} } = args;
    if (!this.eventBus) return { success: false, error: 'EventBus not available' };

    const crypto = require('crypto');
    const requestId = crypto.randomUUID();

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({
          success: true,
          message: `Flow ${flow_id} triggered (async)`,
          execution_id: requestId
        });
      }, 5000);

      const handler = (event) => {
        const eventData = event?.data || event;
        if (eventData.triggerId === requestId || eventData.flowId === flow_id) {
          clearTimeout(timeout);
          this.eventBus.off('flow.started', handler);
          resolve({
            success: true, flow_id,
            execution_id: eventData.executionId,
            message: `Flow ${flow_id} started`
          });
        }
      };

      this.eventBus.on('flow.started', handler);
      this.eventBus.publish('flow.trigger', {
        flowId: flow_id, triggerId: requestId, data
      });
    });
  }

  async flowStatusTool(args) {
    const { execution_id, flow_id } = args || {};
    const port = this.coreConfig?.http?.port || 3000;
    let url = `http://localhost:${port}/api/flow-engine/executions`;
    if (execution_id) {
      url = `http://localhost:${port}/api/flow-engine/executions/${execution_id}`;
    }

    try {
      const response = await this.httpRequestTool({
        method: 'GET', url,
        headers: { 'Content-Type': 'application/json' }
      });

      let executions = response?.executions || (response?.execution ? [response.execution] : []);
      if (flow_id && !execution_id) {
        executions = executions.filter(e => e.flowId === flow_id);
      }

      return {
        success: true,
        count: executions.length,
        executions: executions.map(e => ({
          id: e.id, flow_id: e.flowId, status: e.status,
          started: e.startedAt, completed: e.completedAt, current_step: e.currentStep
        }))
      };
    } catch (error) {
      return { success: false, error: error.message, executions: [] };
    }
  }

  // ============================================================
  // TOOL HANDLERS - Project config tools
  // ============================================================

  async projectConfigGetTool(args) {
    const { project_id, config_file } = args;
    const fs = require('fs').promises;
    const path = require('path');

    const configDir = path.join(process.cwd(), 'data', 'projects', project_id, 'config');
    const configFileName = config_file || `${project_id.split('-').pop()}.json`;
    const configPath = path.join(configDir, configFileName);

    try {
      let content;
      try {
        content = await fs.readFile(configPath, 'utf-8');
      } catch {
        const files = await fs.readdir(configDir);
        const jsonFile = files.find(f => f.endsWith('.json'));
        if (jsonFile) {
          content = await fs.readFile(path.join(configDir, jsonFile), 'utf-8');
        } else {
          return { success: false, error: 'No config file found' };
        }
      }

      return { success: true, project_id, config: JSON.parse(content) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async projectConfigUpdateTool(args) {
    const { project_id, config_file, updates } = args;
    const fs = require('fs').promises;
    const path = require('path');

    const configDir = path.join(process.cwd(), 'data', 'projects', project_id, 'config');

    try {
      const files = await fs.readdir(configDir);
      const jsonFile = config_file || files.find(f => f.endsWith('.json'));
      if (!jsonFile) return { success: false, error: 'No config file found' };

      const configPath = path.join(configDir, jsonFile);
      const content = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(content);

      for (const [key, value] of Object.entries(updates)) {
        const parts = key.split('.');
        let target = config;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!target[parts[i]]) target[parts[i]] = {};
          target = target[parts[i]];
        }
        target[parts[parts.length - 1]] = value;
      }

      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

      return {
        success: true, project_id,
        updated_keys: Object.keys(updates),
        message: `Config updated: ${Object.keys(updates).join(', ')}`
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ============================================================
  // TOOL HANDLERS - Facturas tools
  // ============================================================

  async facturasListTool(args) {
    const { project_id, status, limit = 50 } = args;

    let query = 'SELECT * FROM facturas';
    const params = [];

    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const result = await this.dbExecuteTool({ project_id, query, params });

    if (result.success) {
      return {
        success: true, project_id,
        count: result.data?.length || 0,
        facturas: result.data || []
      };
    }

    return result;
  }

  async facturasProcessTool(args) {
    const { project_id, factura_id } = args;

    const flowId = factura_id
      ? `${project_id}:procesar-factura`
      : `${project_id}:procesar-lote`;

    return this.flowTriggerTool({
      flow_id: flowId,
      data: factura_id ? { factura_id } : {}
    });
  }

  async facturasExportTool(args) {
    const { project_id, format = 'libro-registro' } = args;

    return this.flowTriggerTool({
      flow_id: `${project_id}:consolidar-excel`,
      data: { format }
    });
  }

  /**
   * Inject eventBus
   */
  setEventBus(eventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Inject core config for API calls
   */
  setCoreConfig(coreConfig) {
    this.coreConfig = coreConfig;
  }
}

module.exports = ToolManager;
