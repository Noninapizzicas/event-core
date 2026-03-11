const crypto = require('crypto');

const { EVENTS } = require('../../core/constants');

/**
 * Prompt Composer Module
 *
 * Composición de system prompts con contexto de proyecto y templates dinámicos.
 * Integración con prompt-manager para cargar prompts persistidos.
 *
 * @module prompt-composer
 * @version 1.1.0
 */
class PromptComposerModule {
  constructor() {
    this.name = 'prompt-composer';
    this.version = '1.1.0';

    // Dependencies (injected in onLoad)
    this.logger = null;
    this.eventBus = null;
    this.uiHandler = null;
    this.config = null;

    // Pending requests tracking
    this.pendingProjectRequests = new Map();
    this.pendingStorageRequests = new Map();
    this.pendingComposeRequests = new Map();
    this.pendingPromptManagerRequests = new Map();
    this.pendingInheritedContextRequests = new Map(); // Phase 5

    // Template cache (local defaults)
    this.templates = new Map();

    // Cached prompts from prompt-manager
    this.managedPromptsCache = new Map();
    this.managedPromptsCacheTime = null;
    this.CACHE_TTL = 60000; // 1 minute cache

    // Project context cache: avoids RPC per turn (keyed by projectId)
    this._projectContextCache = new Map();
    this._inheritedContextCache = new Map();
    this.PROJECT_CACHE_TTL = 300000; // 5 minutes

    // Active project tracking (event-driven invalidation)
    this.activeProjectId = null;

    // Startup time for health check
    this.startTime = Date.now();
  }

  // ==========================================
  // Lifecycle Hooks
  // ==========================================

  async onLoad(context) {
    this.logger = context.logger;
    this.eventBus = context.eventBus;
    this.uiHandler = context.uiHandler;
    this.config = context.config || {};
    this.moduleLoader = context.moduleLoader || null;

    this.logger.info('prompt-composer.loading', {
      module: this.name,
      version: this.version
    });

    // Load default templates
    this.loadDefaultTemplates();

    this.logger.info('prompt-composer.loaded', {
      module: this.name,
      templatesLoaded: this.templates.size,
      promptManagerIntegration: this.config.usePromptManager !== false
    });
  }

  async onUnload() {
    this.logger.info('prompt-composer.unloading', { module: this.name });

    // Clear pending requests
    for (const pending of [this.pendingProjectRequests, this.pendingStorageRequests, this.pendingComposeRequests, this.pendingPromptManagerRequests]) {
      for (const [, req] of pending.entries()) {
        if (req.timeout) clearTimeout(req.timeout);
        if (req.reject) req.reject(new Error('Module unloading'));
      }
      pending.clear();
    }

    // Clear caches
    this.managedPromptsCache.clear();

    this.logger.info('prompt-composer.unloaded', { module: this.name });
  }

  // ==========================================
  // Default Templates
  // ==========================================

  loadDefaultTemplates() {
    // Template: assistant básico (used as fallback)
    this.templates.set('default', {
      id: 'default',
      name: 'Asistente General',
      prompt: 'You are a helpful AI assistant.',
      variables: []
    });

    // Template: con contexto de proyecto
    // NOTE: Project Context section is auto-added by composeSystemPrompt — don't duplicate here
    this.templates.set('project-aware', {
      id: 'project-aware',
      name: 'Asistente con Contexto',
      prompt: `You are a helpful AI assistant working on the project "{{project_name}}".
Current date: {{date}}`,
      variables: ['project_name', 'date']
    });

    // Template: desarrollador
    // NOTE: Project Context auto-added by composeSystemPrompt — only include dev guidelines here
    this.templates.set('developer', {
      id: 'developer',
      name: 'Asistente de Desarrollo',
      prompt: `You are an expert software developer assistant.

## Guidelines
- Write clean, maintainable code
- Follow project conventions
- Explain your reasoning when making technical decisions
- Consider security and performance implications`,
      variables: []
    });

    // Template: administrador del sistema
    this.templates.set('system-admin', {
      id: 'system-admin',
      name: 'Administrador del Sistema',
      prompt: `Eres el asistente de administración del sistema event-core.
Tienes acceso completo a todos los archivos y directorios del sistema.

## Tu Rol
- Gestionar la configuración del sistema (config.json, módulos, etc.)
- Revisar y modificar módulos del sistema
- Analizar logs y diagnosticar problemas
- Gestionar proyectos hijos y sus relaciones
- Mantener la salud general del sistema

## Estructura del Sistema
El sistema event-core es una plataforma basada en eventos con:
- **core/** - Núcleo del sistema (eventBus, módulos, constantes)
- **modules/** - Módulos cargables (ai-gateway, chat-ai-bridge, filesystem, project-manager, etc.)
- **frontend/** - Interfaz SvelteKit
- **data/** - Datos persistentes (proyectos, bases de datos)
- **config.json** - Configuración principal

## Directrices
- Responde siempre en español
- Cuando modifiques archivos de configuración, valida el formato antes de guardar
- Advierte sobre cambios que puedan afectar la estabilidad del sistema
- Usa las herramientas de filesystem para navegar y modificar archivos
- Al listar directorios, muestra la estructura de forma clara

Fecha actual: {{date}}`,
      variables: ['date']
    });

    this.logger.debug('prompt-composer.templates.loaded', {
      count: this.templates.size,
      templates: Array.from(this.templates.keys())
    });
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  async onComposeRequest(event) {
    const data = event.data || event.payload || event;
    const {
      request_id,
      conversation,
      project_id,
      base_prompt,
      prompt_name,
      include_tools,
      include_storage,
      include_inherited_context, // Phase 5: include context from related projects
      page_context, // Page Context: route-aware context from frontend
      tools,
      correlation_id
    } = data;

    try {
      this.logger.debug('prompt-composer.compose.request', {
        request_id,
        project_id: project_id || conversation?.project_id,
        prompt_name,
        include_inherited_context,
        correlation_id
      });

      const projectId = project_id || conversation?.project_id;

      // Load project context
      const projectContext = await this.loadProjectContext(projectId, include_storage, correlation_id);

      // Load inherited context (Phase 5) - from related projects
      let inheritedContext = null;
      if (include_inherited_context !== false && projectId) {
        inheritedContext = await this.loadInheritedContext(projectId, correlation_id);
      }

      // Determine base prompt: from prompt_name (prompt-manager) or base_prompt or conversation
      let effectiveBasePrompt = base_prompt || conversation?.system_prompt;

      // Auto-select system-admin template for system projects
      if (!effectiveBasePrompt && projectContext?.metadata?.is_system === true) {
        const systemTemplate = this.templates.get('system-admin');
        if (systemTemplate) {
          effectiveBasePrompt = systemTemplate.prompt;
          this.logger.debug('prompt-composer.system_project.auto_template', {
            template: 'system-admin',
            project_id: projectId
          });
        }
      }

      // Try to load from prompt-manager if prompt_name provided or usePromptManager enabled
      if (prompt_name || (this.config.usePromptManager !== false && !effectiveBasePrompt)) {
        const managedPrompt = await this.loadPromptFromManager(
          prompt_name || this.config.defaultPromptName,
          projectContext,
          correlation_id
        );
        if (managedPrompt) {
          effectiveBasePrompt = managedPrompt;
        }
      }

      // Load tools info for system prompt (so the AI knows its capabilities)
      let effectiveTools = tools || null;
      if (include_tools && !effectiveTools && this.moduleLoader) {
        effectiveTools = this.moduleLoader.getToolsForAI();
      }

      // Compose the prompt (with inherited context and page context if available)
      const composedPrompt = this.composeSystemPrompt(
        { system_prompt: effectiveBasePrompt },
        projectContext,
        effectiveTools,
        inheritedContext, // Phase 5
        page_context || null // Page Context
      );

      // Publish response
      await this.eventBus.publish('prompt.compose.response', {
        request_id,
        success: true,
        prompt: composedPrompt,
        context: projectContext,
        inherited_context: inheritedContext, // Phase 5
        prompt_source: prompt_name ? 'prompt-manager' : (base_prompt ? 'provided' : 'default'),
        correlation_id
      });

    } catch (error) {
      this.logger.error('prompt-composer.compose.error', {
        request_id,
        error: error.message,
        stack: error.stack
      });

      await this.eventBus.publish('prompt.compose.response', {
        request_id,
        success: false,
        error: error.message,
        correlation_id
      });
    }
  }

  async onProjectGetResponse(event) {
    const eventData = event.data || event;
    const { request_id, success, project } = eventData;

    const pending = this.pendingProjectRequests.get(request_id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingProjectRequests.delete(request_id);

    if (success) {
      pending.resolve(project);
    } else {
      pending.reject(new Error('Failed to get project'));
    }
  }

  async onStorageInfoResponse(event) {
    const eventData = event.data || event;
    const { request_id, success, storage } = eventData;

    const pending = this.pendingStorageRequests.get(request_id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingStorageRequests.delete(request_id);

    if (success) {
      pending.resolve(storage);
    } else {
      pending.resolve(null); // Optional - don't fail
    }
  }

  async onPromptManagerGetResponse(event) {
    const eventData = event.data || event;
    const { request_id, success, prompt, data, error } = eventData;

    const pending = this.pendingPromptManagerRequests.get(request_id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingPromptManagerRequests.delete(request_id);

    if (success) {
      // prompt-manager returns data.prompt or prompt directly
      pending.resolve(data?.prompt || prompt);
    } else {
      pending.resolve(null); // Optional - don't fail, will use defaults
    }
  }

  async onPromptManagerListResponse(event) {
    const eventData = event.data || event;
    const { request_id, success, prompts, data, error } = eventData;

    const pending = this.pendingPromptManagerRequests.get(request_id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingPromptManagerRequests.delete(request_id);

    if (success) {
      pending.resolve(data?.prompts || prompts || []);
    } else {
      pending.resolve([]); // Return empty array on failure
    }
  }

  /**
   * Handle inherited context response from project-manager (Phase 5)
   */
  async onInheritedContextResponse(event) {
    const eventData = event.data || event;
    const { request_id, success, context, error } = eventData;

    const pending = this.pendingInheritedContextRequests.get(request_id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingInheritedContextRequests.delete(request_id);

    if (success && context) {
      pending.resolve(context);
    } else {
      pending.resolve(null); // Return null on failure (optional feature)
    }
  }

  /**
   * Handle project activation — invalidate caches for the activated project
   */
  onProjectActivated(event) {
    const data = event.data || event;
    this.activeProjectId = data.project_id;
    this._projectContextCache.delete(data.project_id);
    this._inheritedContextCache.delete(data.project_id);
  }

  /**
   * Handle project deactivation — clear active project tracking
   */
  onProjectDeactivated() {
    this.activeProjectId = null;
  }

  // ==========================================
  // Prompt Manager Integration
  // ==========================================

  /**
   * Load a prompt from prompt-manager by name
   * Returns the rendered content with variables substituted
   *
   * @param {string} promptName - Name of the prompt in prompt-manager
   * @param {Object} projectContext - Project context for variable substitution
   * @param {string} correlationId - Correlation ID for tracing
   * @returns {string|null} Rendered prompt content or null if not found
   */
  async loadPromptFromManager(promptName, projectContext, correlationId) {
    if (!promptName) return null;

    this.logger.debug('prompt-composer.loadFromManager', {
      promptName,
      correlation_id: correlationId
    });

    const requestId = crypto.randomUUID();
    const timeout = this.config.requestTimeout || 10000;

    const promise = new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingPromptManagerRequests.delete(requestId);
        this.logger.warn('prompt-composer.loadFromManager.timeout', { promptName });
        resolve(null); // Don't fail - use defaults
      }, timeout);

      this.pendingPromptManagerRequests.set(requestId, { resolve, timeout: timeoutId });
    });

    // Request prompt from prompt-manager
    await this.eventBus.publish('prompt.get.request', {
      request_id: requestId,
      name: promptName,
      correlation_id: correlationId
    });

    const prompt = await promise;

    if (!prompt) {
      this.logger.debug('prompt-composer.loadFromManager.not_found', { promptName });
      return null;
    }

    // Substitute variables using project context
    const variables = {
      project_name: projectContext?.project_name || 'Unknown Project',
      project_description: projectContext?.project_description || '',
      file_count: projectContext?.storage_info?.file_count || 0,
      storage_size: this.formatBytes(projectContext?.storage_info?.total_size),
      date: new Date().toLocaleDateString(),
      datetime: new Date().toISOString()
    };

    const renderedContent = this.substituteVariables(prompt.content, variables);

    this.logger.debug('prompt-composer.loadFromManager.success', {
      promptName,
      promptId: prompt.id,
      contentLength: renderedContent.length
    });

    return renderedContent;
  }

  /**
   * List all prompts from prompt-manager
   * @param {string} correlationId - Correlation ID for tracing
   * @returns {Array} List of prompts
   */
  async listPromptsFromManager(correlationId) {
    // Check cache
    const now = Date.now();
    if (this.managedPromptsCacheTime && (now - this.managedPromptsCacheTime) < this.CACHE_TTL) {
      return Array.from(this.managedPromptsCache.values());
    }

    this.logger.debug('prompt-composer.listFromManager', { correlation_id: correlationId });

    const requestId = crypto.randomUUID();
    const timeout = this.config.requestTimeout || 10000;

    const promise = new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingPromptManagerRequests.delete(requestId);
        resolve([]); // Return empty on timeout
      }, timeout);

      this.pendingPromptManagerRequests.set(requestId, { resolve, timeout: timeoutId });
    });

    await this.eventBus.publish('prompt.list.request', {
      request_id: requestId,
      correlation_id: correlationId
    });

    const prompts = await promise;

    // Update cache
    this.managedPromptsCache.clear();
    for (const p of prompts) {
      this.managedPromptsCache.set(p.id, p);
    }
    this.managedPromptsCacheTime = now;

    return prompts;
  }

  // ==========================================
  // Core Logic: Context Loading
  // ==========================================

  /**
   * Load project context for prompt composition
   * @param {string} projectId - Project ID
   * @param {boolean} includeStorage - Include storage info
   * @param {string} correlationId - Correlation ID for tracing
   */
  async loadProjectContext(projectId, includeStorage = false, correlationId) {
    if (!projectId) {
      this.logger.debug('prompt-composer.context.no_project', { correlationId });
      return {
        project_id: null,
        project_name: 'Unknown Project',
        project_description: '',
        storage_info: null,
        metadata: {}
      };
    }

    // Check cache first — project context rarely changes during a conversation
    const cached = this._projectContextCache.get(projectId);
    if (cached && (Date.now() - cached._ts < this.PROJECT_CACHE_TTL)) {
      this.logger.debug('prompt-composer.context.cache_hit', { projectId });
      return cached;
    }

    this.logger.debug('prompt-composer.context.loading', { correlationId, projectId });

    const requestId = crypto.randomUUID();
    const timeout = this.config.requestTimeout || 10000;

    // Request project details
    const projectPromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingProjectRequests.delete(requestId);
        reject(new Error('Project request timeout'));
      }, timeout);

      this.pendingProjectRequests.set(requestId, { resolve, reject, timeout: timeoutId });
    });

    await this.eventBus.publish(EVENTS.PROJECT.GET_REQUEST, {
      request_id: requestId,
      project_id: projectId,
      correlation_id: correlationId
    });

    let projectData = null;
    try {
      projectData = await projectPromise;
    } catch (error) {
      this.logger.warn('prompt-composer.context.project_failed', {
        correlationId,
        projectId,
        error: error.message
      });
    }

    // Optionally load storage info
    let storageInfo = null;
    if (includeStorage || this.config.includeStorageInfo) {
      const storageRequestId = crypto.randomUUID();

      const storagePromise = new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
          this.pendingStorageRequests.delete(storageRequestId);
          resolve(null); // Optional, don't fail
        }, timeout);

        this.pendingStorageRequests.set(storageRequestId, { resolve, timeout: timeoutId });
      });

      await this.eventBus.publish(EVENTS.STORAGE.INFO_REQUEST, {
        request_id: storageRequestId,
        project_id: projectId,
        correlation_id: correlationId
      });

      storageInfo = await storagePromise;
    }

    const context = {
      project_id: projectId,
      project_name: projectData?.name || 'Unknown Project',
      project_description: projectData?.description || '',
      storage_info: storageInfo,
      metadata: projectData?.metadata || {},
      _ts: Date.now()
    };

    // Cache for subsequent turns in the same conversation
    this._projectContextCache.set(projectId, context);

    // Publish context loaded event for interested subscribers
    await this.eventBus.publish('prompt.context.loaded', {
      project_id: projectId,
      context,
      correlation_id: correlationId
    });

    return context;
  }

  /**
   * Load inherited context from project-manager (Phase 5)
   * Gets system info, dependencies, related projects, and shared context
   *
   * @param {string} projectId - Project ID
   * @param {string} correlationId - Correlation ID for tracing
   * @returns {Object|null} Inherited context or null if not available
   */
  async loadInheritedContext(projectId, correlationId) {
    if (!projectId) {
      return null;
    }

    // Check cache first — inherited context changes even less frequently
    const cached = this._inheritedContextCache.get(projectId);
    if (cached !== undefined && (Date.now() - (cached?._ts || 0) < this.PROJECT_CACHE_TTL)) {
      this.logger.debug('prompt-composer.inherited_context.cache_hit', { projectId });
      return cached;
    }

    // Skip if inherited context is disabled in config
    if (this.config.includeInheritedContext === false) {
      return null;
    }

    this.logger.debug('prompt-composer.inherited_context.loading', { correlationId, projectId });

    const requestId = crypto.randomUUID();
    const timeout = this.config.requestTimeout || 10000;

    // Request inherited context from project-manager via event
    const contextPromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingInheritedContextRequests.delete(requestId);
        resolve(null); // Don't fail, just return null
      }, timeout);

      this.pendingInheritedContextRequests.set(requestId, { resolve, reject, timeout: timeoutId });
    });

    await this.eventBus.publish('context.full.request', {
      request_id: requestId,
      project_id: projectId,
      correlation_id: correlationId
    });

    try {
      const inheritedContext = await contextPromise;
      if (inheritedContext) {
        inheritedContext._ts = Date.now();
        this.logger.debug('prompt-composer.inherited_context.loaded', {
          correlationId,
          projectId,
          hasSystem: !!inheritedContext.system,
          dependencyCount: inheritedContext.dependencies?.length || 0,
          relatedCount: inheritedContext.relatedProjects?.length || 0,
          sharedContextCount: inheritedContext.sharedContext?.length || 0
        });
      }
      // Cache (even null — avoids RPC when project has no relations)
      this._inheritedContextCache.set(projectId, inheritedContext);
      return inheritedContext;
    } catch (error) {
      this.logger.warn('prompt-composer.inherited_context.failed', {
        correlationId,
        projectId,
        error: error.message
      });
      return null;
    }
  }

  // ==========================================
  // Core Logic: Prompt Composition
  // ==========================================

  /**
   * Compose a rich system prompt with all available context
   * Supports template variables: {{project_name}}, {{tools_count}}, {{date}}, etc.
   *
   * @param {Object} conversation - Conversation object with system_prompt
   * @param {Object} projectContext - Project context from loadProjectContext
   * @param {Array} tools - Formatted tools array (optional)
   * @param {Object} inheritedContext - Inherited context from related projects (optional, Phase 5)
   * @param {Object} pageContext - Page context from frontend (optional) { route, title, description, instructions, state }
   * @returns {string} Composed system prompt
   */
  composeSystemPrompt(conversation, projectContext, tools, inheritedContext = null, pageContext = null) {
    // Start with conversation's system prompt or default
    let basePrompt = conversation?.system_prompt ||
      this.config.defaultSystemPrompt ||
      'You are a helpful AI assistant.';

    // Template variables available for substitution
    const variables = {
      project_name: projectContext?.project_name || 'Unknown Project',
      project_description: projectContext?.project_description || '',
      tools_count: tools?.length || 0,
      file_count: projectContext?.storage_info?.file_count || 0,
      storage_size: this.formatBytes(projectContext?.storage_info?.total_size),
      date: new Date().toLocaleDateString(),
      datetime: new Date().toISOString(),
      conversation_title: conversation?.title || 'Conversation',
      // Inherited context variables (Phase 5)
      system_name: inheritedContext?.system?.name || '',
      related_projects_count: inheritedContext?.relatedProjects?.length || 0,
      inherited_context_count: inheritedContext?.inheritedContextCount || 0
    };

    // Substitute template variables {{variable_name}}
    basePrompt = this.substituteVariables(basePrompt, variables);

    // Build context sections
    const sections = [];

    // Add base prompt
    if (basePrompt.trim()) {
      sections.push(basePrompt.trim());
    }

    // Add project context if enabled
    if ((this.config.includeProjectContext !== false) && projectContext?.project_name) {
      const projectSection = [];
      projectSection.push('## Project Context');
      projectSection.push(`- **Project**: ${projectContext.project_name}`);

      if (projectContext.project_description) {
        projectSection.push(`- **Description**: ${projectContext.project_description}`);
      }

      if (projectContext.storage_info) {
        projectSection.push(`- **Files**: ${projectContext.storage_info.file_count || 0} files (${this.formatBytes(projectContext.storage_info.total_size)})`);
      }

      sections.push(projectSection.join('\n'));
    }

    // Add inherited context section (Phase 5) - from related projects
    if ((this.config.includeInheritedContext !== false) && inheritedContext) {
      const inheritedSection = this.buildInheritedContextSection(inheritedContext);
      if (inheritedSection) {
        sections.push(inheritedSection);
      }
    }

    // Add page context section if available (route-aware context from frontend)
    if (pageContext && pageContext.route) {
      const pageSection = this.buildPageContextSection(pageContext);
      if (pageSection) {
        sections.push(pageSection);
      }
    }

    // Add tools summary if enabled and tools are available
    // Summarize by category to save tokens (listing 100+ tools individually is wasteful)
    if ((this.config.includeTools !== false) && tools && tools.length > 0) {
      const toolsSection = [];
      toolsSection.push('## Capabilities');
      toolsSection.push(`You have ${tools.length} tools available. Key capabilities:`);

      // Group tools by prefix (fs.*, db.*, telegram.*, etc.)
      const groups = new Map();
      for (const tool of tools) {
        const name = tool.function?.name || tool.name || '';
        const prefix = name.includes('.') ? name.split('.')[0] : name.split('_')[0];
        if (!groups.has(prefix)) groups.set(prefix, []);
        groups.get(prefix).push(name);
      }

      for (const [prefix, names] of groups) {
        if (names.length === 1) {
          toolsSection.push(`- **${names[0]}**`);
        } else {
          toolsSection.push(`- **${prefix}**: ${names.join(', ')}`);
        }
      }

      toolsSection.push('\nCall tools proactively when they help answer the user accurately.');
      sections.push(toolsSection.join('\n'));
    }

    // Combine all sections
    return sections.join('\n\n');
  }

  /**
   * Build the inherited context section for system prompt (Phase 5)
   * Includes: system info, dependencies, related projects, shared context
   *
   * @param {Object} inheritedContext - Context from getFullProjectContext()
   * @returns {string|null} Formatted section or null if empty
   */
  buildInheritedContextSection(inheritedContext) {
    if (!inheritedContext) return null;

    const lines = [];
    let hasContent = false;

    // System membership
    if (inheritedContext.system) {
      hasContent = true;
      lines.push('## System Context');
      lines.push(`This project is part of **${inheritedContext.system.name}**${inheritedContext.system.description ? `: ${inheritedContext.system.description}` : ''}`);

      if (inheritedContext.system.role) {
        lines.push(`- **Role in system**: ${inheritedContext.system.role}`);
      }

      if (inheritedContext.system.siblingProjects?.length > 0) {
        lines.push(`- **Sibling projects**: ${inheritedContext.system.siblingProjects.map(p => p.name).join(', ')}`);
      }
      lines.push('');
    }

    // Dependencies
    if (inheritedContext.dependencies?.length > 0) {
      hasContent = true;
      lines.push('## Dependencies');
      lines.push('This project depends on:');
      for (const dep of inheritedContext.dependencies) {
        const desc = dep.description ? ` - ${dep.description}` : '';
        lines.push(`- **${dep.projectName}** (${dep.type})${desc}`);
      }
      lines.push('');
    }

    // Related projects
    if (inheritedContext.relatedProjects?.length > 0) {
      hasContent = true;
      lines.push('## Related Projects');
      for (const rel of inheritedContext.relatedProjects) {
        const linkInfo = rel.links?.map(l => l.linkType).join(', ') || 'related';
        lines.push(`- **${rel.name}** (${linkInfo})`);
      }
      lines.push('');
    }

    // Shared/imported context (knowledge from other projects)
    if (inheritedContext.sharedContext?.length > 0) {
      hasContent = true;
      lines.push('## Inherited Knowledge');
      lines.push('Context imported from related projects:');
      for (const ctx of inheritedContext.sharedContext) {
        const reason = ctx.reason ? `: ${ctx.reason}` : '';
        lines.push(`- From **${ctx.fromProject}**${reason}`);
      }
      lines.push('');
    }

    if (!hasContent) return null;

    return lines.join('\n').trim();
  }

  /**
   * Build the page context section for system prompt.
   * Renders what the user is doing on the current page so the LLM has awareness.
   *
   * @param {Object} pageContext - { route, title, description, instructions?, state? }
   * @returns {string|null} Formatted section or null if empty
   */
  buildPageContextSection(pageContext) {
    if (!pageContext || !pageContext.route) return null;

    const lines = [];

    lines.push('## Page Context');
    lines.push(`The user is on **${pageContext.title || pageContext.route}** (${pageContext.route}).`);

    if (pageContext.description) {
      lines.push(`${pageContext.description}`);
    }

    // Page-specific instructions for the LLM
    if (pageContext.instructions) {
      lines.push('');
      lines.push(pageContext.instructions);
    }

    // Render state — the live data from panels/components
    if (pageContext.state && Object.keys(pageContext.state).length > 0) {
      lines.push('');
      lines.push('### Current State');

      for (const [key, value] of Object.entries(pageContext.state)) {
        if (value === null || value === undefined) continue;

        // Truncate long values (e.g., OCR text) to avoid blowing up context
        const MAX_VALUE_LENGTH = 4000;
        let display;
        if (typeof value === 'string' && value.length > MAX_VALUE_LENGTH) {
          display = value.substring(0, MAX_VALUE_LENGTH) + `\n... [truncated, ${value.length} chars total]`;
        } else if (typeof value === 'object') {
          const json = JSON.stringify(value, null, 2);
          display = json.length > MAX_VALUE_LENGTH
            ? json.substring(0, MAX_VALUE_LENGTH) + '\n... [truncated]'
            : json;
        } else {
          display = String(value);
        }

        // Multi-line values get a block format
        if (typeof display === 'string' && display.includes('\n')) {
          lines.push(`- **${key}**:`);
          lines.push('```');
          lines.push(display);
          lines.push('```');
        } else {
          lines.push(`- **${key}**: ${display}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Substitute template variables in a string
   * Supports {{variable}} and {{#if variable}}...{{/if}} syntax
   *
   * @param {string} template - Template string
   * @param {Object} variables - Variables to substitute
   * @returns {string} Processed string
   */
  substituteVariables(template, variables) {
    if (!template) return '';

    let result = template;

    // Handle {{#if variable}}content{{/if}} blocks
    const ifRegex = /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g;
    result = result.replace(ifRegex, (match, varName, content) => {
      const value = variables[varName];
      // Include content if value is truthy and not empty string
      if (value && value !== '' && value !== 0) {
        return content;
      }
      return '';
    });

    // Handle simple {{variable}} substitutions
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
      result = result.replace(regex, String(value ?? ''));
    }

    return result;
  }

  // ==========================================
  // Utility Methods
  // ==========================================

  /**
   * Format bytes to human readable string
   * @param {number} bytes - Number of bytes
   * @returns {string} Formatted string (e.g., "1.5 MB")
   */
  formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // ==========================================
  // UI Handlers (MQTT Request/Response)
  // ==========================================

  /**
   * UI Handler: Compose prompt
   * Request: mqttRequest('prompt', 'compose', { projectId, basePrompt, includeTools, tools })
   */
  async handleUICompose(data, context) {
    const { projectId, basePrompt, includeTools, includeStorage, tools } = data;
    const correlationId = context?.correlationId || crypto.randomUUID();

    try {
      this.logger.debug('prompt-composer.handleUICompose', {
        projectId,
        includeTools,
        correlation_id: correlationId
      });

      // Load context
      const projectContext = await this.loadProjectContext(projectId, includeStorage, correlationId);

      // Compose prompt
      const prompt = this.composeSystemPrompt(
        { system_prompt: basePrompt },
        projectContext,
        includeTools ? tools : null
      );

      return {
        success: true,
        prompt,
        context: projectContext,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      this.logger.error('prompt-composer.handleUICompose.error', {
        error: error.message,
        correlation_id: correlationId
      });
      throw { status: 500, code: 'COMPOSE_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: List templates
   * Request: mqttRequest('prompt', 'templates', {})
   * Returns both local templates and prompts from prompt-manager
   */
  async handleUITemplates(data, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();

    try {
      this.logger.debug('prompt-composer.handleUITemplates', {
        correlation_id: correlationId
      });

      // Local templates
      const localTemplates = Array.from(this.templates.values()).map(t => ({
        id: t.id,
        name: t.name,
        variables: t.variables,
        preview: t.prompt.substring(0, 100) + (t.prompt.length > 100 ? '...' : ''),
        source: 'local'
      }));

      // Prompts from prompt-manager
      let managedPrompts = [];
      if (this.config.usePromptManager !== false) {
        const prompts = await this.listPromptsFromManager(correlationId);
        managedPrompts = prompts.map(p => ({
          id: p.id,
          name: p.name,
          title: p.title,
          description: p.description,
          slot_type: p.slot_type,
          variables: p.variables,
          preview: p.content ? p.content.substring(0, 100) + (p.content.length > 100 ? '...' : '') : '',
          source: 'prompt-manager'
        }));
      }

      return {
        success: true,
        templates: localTemplates,
        managedPrompts,
        total: localTemplates.length + managedPrompts.length
      };
    } catch (error) {
      this.logger.error('prompt-composer.handleUITemplates.error', {
        error: error.message
      });
      throw { status: 500, code: 'TEMPLATES_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Get project context
   * Request: mqttRequest('prompt', 'context', { projectId })
   */
  async handleUIContext(data, context) {
    const { projectId } = data;
    const correlationId = context?.correlationId || crypto.randomUUID();

    try {
      this.logger.debug('prompt-composer.handleUIContext', {
        projectId,
        correlation_id: correlationId
      });

      if (!projectId) {
        throw { status: 400, code: 'VALIDATION_ERROR', message: 'projectId is required' };
      }

      const projectContext = await this.loadProjectContext(projectId, true, correlationId);

      return {
        success: true,
        context: projectContext
      };
    } catch (error) {
      if (error.status) throw error;
      this.logger.error('prompt-composer.handleUIContext.error', {
        error: error.message
      });
      throw { status: 500, code: 'CONTEXT_ERROR', message: error.message };
    }
  }

  // ==========================================
  // HTTP API Handlers
  // ==========================================

  async handleComposePrompt(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    const { project_id, base_prompt, include_tools, include_storage, tools } = req.body || {};

    this.logger.debug('prompt-composer.handleComposePrompt', {
      correlation_id: correlationId,
      project_id
    });

    try {
      const projectContext = await this.loadProjectContext(project_id, include_storage, correlationId);

      const prompt = this.composeSystemPrompt(
        { system_prompt: base_prompt },
        projectContext,
        include_tools ? tools : null
      );

      return {
        status: 200,
        data: {
          success: true,
          prompt,
          context: projectContext
        }
      };
    } catch (error) {
      this.logger.error('prompt-composer.handleComposePrompt.error', {
        error: error.message,
        correlation_id: correlationId
      });
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleListTemplates(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();

    this.logger.debug('prompt-composer.handleListTemplates', {
      correlation_id: correlationId
    });

    // Local templates
    const localTemplates = Array.from(this.templates.values()).map(t => ({
      id: t.id,
      name: t.name,
      variables: t.variables,
      prompt: t.prompt,
      source: 'local'
    }));

    // Prompts from prompt-manager
    let managedPrompts = [];
    if (this.config.usePromptManager !== false) {
      const prompts = await this.listPromptsFromManager(correlationId);
      managedPrompts = prompts.map(p => ({
        id: p.id,
        name: p.name,
        title: p.title,
        description: p.description,
        slot_type: p.slot_type,
        variables: p.variables,
        content: p.content,
        source: 'prompt-manager'
      }));
    }

    return {
      status: 200,
      data: {
        success: true,
        templates: localTemplates,
        managedPrompts,
        total: localTemplates.length + managedPrompts.length
      }
    };
  }

  async handleGetContext(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    const { projectId } = req.params || {};

    this.logger.debug('prompt-composer.handleGetContext', {
      correlation_id: correlationId,
      projectId
    });

    if (!projectId) {
      return { status: 400, data: { success: false, error: 'projectId is required' } };
    }

    try {
      const projectContext = await this.loadProjectContext(projectId, true, correlationId);

      return {
        status: 200,
        data: {
          success: true,
          context: projectContext
        }
      };
    } catch (error) {
      this.logger.error('prompt-composer.handleGetContext.error', {
        error: error.message,
        correlation_id: correlationId
      });
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleHealthCheck(req, context) {
    const uptime = (Date.now() - this.startTime) / 1000;

    return {
      status: 200,
      data: {
        status: 'healthy',
        module: this.name,
        version: this.version,
        uptime,
        templates_count: this.templates.size,
        pending_requests: this.pendingProjectRequests.size + this.pendingStorageRequests.size,
        timestamp: new Date().toISOString()
      }
    };
  }

  // ==========================================
  // Tool Handlers (for AI)
  // ==========================================

  async toolComposePrompt(params, context) {
    const { project_id, base_prompt, prompt_name, include_tools, include_storage } = params;
    const correlationId = context?.correlationId || crypto.randomUUID();

    try {
      this.logger.debug('prompt-composer.toolComposePrompt', {
        params,
        correlation_id: correlationId
      });

      const projectContext = await this.loadProjectContext(project_id, include_storage, correlationId);

      // Determine base prompt: from prompt_name (prompt-manager) or base_prompt
      let effectiveBasePrompt = base_prompt;

      if (prompt_name) {
        const managedPrompt = await this.loadPromptFromManager(prompt_name, projectContext, correlationId);
        if (managedPrompt) {
          effectiveBasePrompt = managedPrompt;
        }
      }

      const prompt = this.composeSystemPrompt(
        { system_prompt: effectiveBasePrompt },
        projectContext,
        null // Tools not included when called as a tool
      );

      return {
        success: true,
        prompt,
        prompt_source: prompt_name ? 'prompt-manager' : (base_prompt ? 'provided' : 'default'),
        context: {
          project_name: projectContext.project_name,
          project_description: projectContext.project_description
        }
      };
    } catch (error) {
      this.logger.error('prompt-composer.toolComposePrompt.error', {
        error: error.message
      });
      return { success: false, error: error.message };
    }
  }

  async toolGetContext(params, context) {
    const { project_id } = params;
    const correlationId = context?.correlationId || crypto.randomUUID();

    try {
      this.logger.debug('prompt-composer.toolGetContext', {
        params,
        correlation_id: correlationId
      });

      const projectContext = await this.loadProjectContext(project_id, true, correlationId);

      return {
        success: true,
        context: projectContext
      };
    } catch (error) {
      this.logger.error('prompt-composer.toolGetContext.error', {
        error: error.message
      });
      return { success: false, error: error.message };
    }
  }
}

module.exports = PromptComposerModule;
