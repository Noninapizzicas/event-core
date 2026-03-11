const fs = require('fs').promises;
const path = require('path');
const DeepSeekProvider = require('./providers/deepseek-provider');
const AnthropicProvider = require('./providers/anthropic-provider');
const OpenAIProvider = require('./providers/openai-provider');
const OllamaProvider = require('./providers/ollama-provider');
const GroqProvider = require('./providers/groq-provider');
const GeminiProvider = require('./providers/gemini-provider');

const { EVENTS } = require('../../core/constants');

/**
 * AI Gateway Module
 *
 * Cliente unificado para múltiples proveedores LLM con:
 * - Rate limiting
 * - Retry con exponential backoff
 * - Streaming SSE
 * - Cost tracking
 * - Fallback automático entre proveedores
 */
class AIGatewayModule {
  constructor() {
    this.providers = new Map();
    this.usage = new Map(); // Track usage per provider
    this.config = null;
    this.logger = null;
    this.eventBus = null;

    // UI State: Provider/modelo seleccionado actualmente
    this.currentProvider = 'auto';
    this.currentModel = null;

    // Credential resolution
    this.pendingCredentialRequests = new Map(); // requestId -> {resolve, reject, timeout}
    this.credentialCache = new Map(); // provider -> {apiKey, resolvedAt, projectId}

    // Configuración de parámetros LLM
    this.chatConfig = {
      temperature: 0.7,
      maxTokens: 2048,
      topP: 1.0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      systemPrompt: '',
      stream: true
    };
  }

  // ============ UI HELPERS ============

  /**
   * Get display name for provider
   */
  getProviderDisplayName(providerId) {
    const displayNames = {
      deepseek: 'DeepSeek',
      anthropic: 'Anthropic Claude',
      openai: 'OpenAI',
      ollama: 'Ollama (Local)',
      groq: 'Groq',
      gemini: 'Google Gemini'
    };
    return displayNames[providerId] || providerId;
  }

  /**
   * Get icon for provider
   */
  getProviderIcon(providerId) {
    const icons = {
      deepseek: '🔮',
      anthropic: '🧠',
      openai: '🤖',
      ollama: '🦙',
      groq: '⚡',
      gemini: '💎'
    };
    return icons[providerId] || '⚡';
  }

  /**
   * Get display name for model
   */
  getModelDisplayName(modelId) {
    const displayNames = {
      'deepseek-chat': 'DeepSeek Chat',
      'deepseek-coder': 'DeepSeek Coder',
      'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
      'claude-3-opus-20240229': 'Claude 3 Opus',
      'claude-3-haiku-20240307': 'Claude 3 Haiku',
      'gpt-4o': 'GPT-4o',
      'gpt-4o-mini': 'GPT-4o Mini',
      'gpt-3.5-turbo': 'GPT-3.5 Turbo',
      'deepseek-reasoner': 'DeepSeek Reasoner',
      'llama2': 'Llama 2',
      'codellama': 'Code Llama',
      'mistral': 'Mistral',
      'mixtral': 'Mixtral',
      'llama-3.3-70b-versatile': 'Llama 3.3 70B',
      'mixtral-8x7b-32768': 'Mixtral 8x7B',
      'gemma2-9b-it': 'Gemma 2 9B',
      'gemini-2.5-flash': 'Gemini 2.5 Flash',
      'gemini-2.5-pro': 'Gemini 2.5 Pro'
    };
    return displayNames[modelId] || modelId;
  }

  /**
   * Get provider status
   */
  getProviderStatus(available, provider) {
    if (!available) {
      return 'no_api_key';
    }
    // Could add more status checks here (rate_limited, error, etc.)
    return 'ready';
  }

  /**
   * Module lifecycle: onLoad
   */
  async onLoad(context) {
    this.logger = context.logger;
    this.eventBus = context.eventBus;
    this.moduleLoader = context.moduleLoader; // Para acceder a tools registry
    this.activity = context.activity?.forModule('ai-gateway');

    this.activity?.action('module.loading', {});

    // Load config from module.json
    const moduleJsonPath = path.join(__dirname, 'module.json');
    const moduleJson = JSON.parse(await fs.readFile(moduleJsonPath, 'utf-8'));
    this.config = moduleJson.config || {};

    // Initialize providers
    await this.initializeProviders();

    // Event subscriptions are auto-wired by the loader from module.json

    const availableProviders = await this.getAvailableProviderNames();

    this.activity?.action('module.loaded', {
      providers_count: this.providers.size,
      providers_available: availableProviders
    });

    this.logger.info('ai-gateway.loaded', {
      providers_count: this.providers.size,
      providers_available: availableProviders
    });
  }

  // Event Handlers: onAIChatRequest, onAIRequestCreated, onCredentialResponse
  // are wired by the loader from module.json

  /**
   * Resolve credential from credential-manager via events
   * Supports cascade: CUSTOM → CLIENT → PROJECT → GLOBAL
   */
  async resolveCredential(providerName, { projectId, clientId, customId } = {}) {
    // Check cache first (valid for 5 minutes)
    const cacheKey = `${providerName}:${projectId || 'global'}:${clientId || ''}:${customId || ''}`;
    const cached = this.credentialCache.get(cacheKey);
    if (cached && (Date.now() - cached.resolvedAt) < 300000) {
      return cached.apiKey;
    }

    const requestId = `cred-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      // Set timeout for credential resolution
      const timeout = setTimeout(() => {
        this.pendingCredentialRequests.delete(requestId);
        reject(new Error(`Credential resolution timeout for ${providerName}`));
      }, 5000);

      // Store pending request
      this.pendingCredentialRequests.set(requestId, { resolve, reject, timeout, providerName, cacheKey });

      // Publish request to credential-manager
      this.eventBus.publish(EVENTS.CREDENTIAL.RESOLVE_REQUEST, {
        provider: providerName.toUpperCase(),
        project_id: projectId,
        client_id: clientId,
        custom_id: customId,
        request_id: requestId
      });

      this.logger.debug('ai-gateway.credential.request', {
        request_id: requestId,
        provider: providerName,
        project_id: projectId
      });
    });
  }

  /**
   * Handle credential resolution response from credential-manager
   */
  async onCredentialResponse(event) {
    const { request_id, success, api_key, resolved_from, error } = event.data || event.payload || event;

    const pending = this.pendingCredentialRequests.get(request_id);
    if (!pending) {
      // Not our request or already timed out
      return;
    }

    // Clean up
    clearTimeout(pending.timeout);
    this.pendingCredentialRequests.delete(request_id);

    if (success && api_key) {
      // Cache the credential
      this.credentialCache.set(pending.cacheKey, {
        apiKey: api_key,
        resolvedAt: Date.now(),
        resolvedFrom: resolved_from
      });

      this.logger.info('ai-gateway.credential.resolved', {
        provider: pending.providerName,
        resolved_from,
        request_id
      });

      pending.resolve(api_key);
    } else {
      this.logger.warn('ai-gateway.credential.failed', {
        provider: pending.providerName,
        error,
        request_id
      });

      pending.reject(new Error(error || `No credential found for ${pending.providerName}`));
    }
  }

  /**
   * Event Handler: ai.chat.request
   * Handler principal para conversation-manager
   * Publica ai.chat.response con el resultado
   */
  async onAIChatRequest(event) {
    // EventEnvelope uses .data, legacy uses .payload
    const {
      request_id,
      messages,
      tools,
      execute_tools,
      max_tool_iterations,
      provider: requestedProvider,
      model,
      temperature,
      max_tokens,
      project_id,
      correlation_id,
      stream
    } = event.data || event.payload || event;

    const correlationId = correlation_id || event.correlationId;
    const endTimer = this.activity?.timer('chat.request');

    this.activity?.action('chat.request.received', {
      request_id,
      provider: requestedProvider,
      model,
      messages_count: messages?.length || 0,
      tools_count: tools?.length || 0
    });

    this.logger.info('ai-gateway.chat.request.received', {
      request_id,
      provider: requestedProvider,
      has_messages: !!messages,
      has_tools: !!(tools && tools.length),
      tools_count: tools?.length || 0,
      project_id,
      correlation_id: correlationId
    });

    try {
      // Build onChunk callback for streaming (handles text deltas and tool status)
      const onChunk = stream ? (data) => {
        if (typeof data === 'object' && data.tool) {
          this.eventBus.publish(EVENTS.AI.CHAT_CHUNK, {
            request_id,
            tool: data.tool,
            done: false
          });
        } else {
          this.eventBus.publish(EVENTS.AI.CHAT_CHUNK, {
            request_id,
            delta: typeof data === 'string' ? data : '',
            done: false
          });
        }
      } : null;

      // Procesar la solicitud
      const result = await this.handleChatCompletion({
        body: {
          messages,
          tools,
          execute_tools,
          max_tool_iterations,
          provider: requestedProvider,
          model,
          temperature,
          max_tokens,
          stream: !!stream,
          metadata: { request_id, project_id }
        }
      }, { correlationId, projectId: project_id, onChunk });

      // Signal streaming done
      if (stream && result.status === 200) {
        await this.eventBus.publish(EVENTS.AI.CHAT_CHUNK, {
          request_id,
          delta: '',
          done: true
        });
      }

      // Publicar respuesta exitosa
      await this.eventBus.publish(EVENTS.AI.CHAT_RESPONSE, {
        request_id,
        success: result.status === 200,
        message: result.data?.content,
        content: result.data?.content,
        tool_calls: result.data?.tool_calls || null,
        tool_calls_executed: result.data?.tool_results || [],
        iterations: result.data?.iterations || 1,
        tokens: result.data?.usage?.total_tokens || 0,
        cost: result.data?.cost || 0,
        model: result.data?.model,
        provider: result.data?.provider || requestedProvider,
        error: result.status !== 200 ? result.data?.message : null
      }, { correlationId });

      endTimer?.({
        success: result.status === 200,
        provider: result.data?.provider,
        model: result.data?.model,
        tokens: result.data?.usage?.total_tokens || 0
      });

      this.activity?.action('chat.response.sent', {
        request_id,
        success: result.status === 200,
        provider: result.data?.provider,
        model: result.data?.model,
        tokens: result.data?.usage?.total_tokens || 0,
        has_tool_calls: !!(result.data?.tool_calls)
      });

      this.logger.info('ai-gateway.chat.response.sent', {
        request_id,
        success: result.status === 200,
        has_tool_calls: !!(result.data?.tool_calls),
        correlation_id: correlationId
      });

    } catch (error) {
      endTimer?.({ success: false, error: error.message });
      this.activity?.error('chat.request', error, { request_id, provider: requestedProvider });

      this.logger.error('ai-gateway.chat.request.error', {
        request_id,
        error: error.message,
        correlation_id: correlationId
      });

      // Publicar error
      await this.eventBus.publish(EVENTS.AI.CHAT_RESPONSE, {
        request_id,
        success: false,
        message: null,
        content: null,
        tool_calls: null,
        tokens: 0,
        cost: 0,
        model: null,
        provider: requestedProvider,
        error: error.message
      }, { correlationId });
    }
  }

  /**
   * Event Handler: ai.request.created
   * Procesa solicitudes de IA enviadas por otros módulos via eventos
   */
  async onAIRequestCreated(event) {
    const {
      request_id,
      messages,
      provider: requestedProvider,
      model,
      temperature,
      max_tokens,
      metadata
    } = event.data || event.payload || {};

    const correlationId = event.correlationId || metadata?.correlationId;

    this.logger.info('ai-gateway.request.received', {
      request_id,
      provider: requestedProvider,
      has_messages: !!messages,
      correlation_id: correlationId
    });

    try {
      // Procesar la solicitud usando el handler HTTP existente
      const result = await this.handleChatCompletion({
        body: {
          messages,
          provider: requestedProvider,
          model,
          temperature,
          max_tokens,
          metadata: { ...metadata, request_id }
        }
      }, { correlationId });

      // Publicar evento de completado con la respuesta
      await this.eventBus.publish(EVENTS.AI.COMPLETION_COMPLETED, {
        provider: result.data?.provider || requestedProvider,
        model: result.data?.model,
        prompt_id: metadata?.prompt_id,
        tokens_used: result.data?.usage?.total_tokens || 0,
        latency_ms: result.data?.latency_ms || 0,
        cost: result.data?.cost || 0,
        metadata: {
          request_id,
          response_content: result.data?.content,
          response_data: result.data,
          source: metadata?.source,
          correlationId,
          success: result.status === 200,
          error: result.status !== 200 ? result.data?.message : null
        }
      }, { correlationId });

      this.logger.info('ai-gateway.request.completed', {
        request_id,
        status: result.status,
        correlation_id: correlationId
      });

    } catch (error) {
      this.logger.error('ai-gateway.request.error', {
        request_id,
        error: error.message,
        correlation_id: correlationId
      });

      // Publicar evento de error
      await this.eventBus.publish(EVENTS.AI.COMPLETION_COMPLETED, {
        provider: requestedProvider,
        model,
        prompt_id: metadata?.prompt_id,
        tokens_used: 0,
        latency_ms: 0,
        cost: 0,
        metadata: {
          request_id,
          source: metadata?.source,
          correlationId,
          success: false,
          error: error.message
        }
      }, { correlationId });
    }
  }

  /**
   * Module lifecycle: onUnload
   */
  async onUnload() {
    this.logger.info('ai-gateway.unloaded', {
      total_requests: Array.from(this.usage.values()).reduce((sum, u) => sum + u.requests, 0),
      total_cost: Array.from(this.usage.values()).reduce((sum, u) => sum + u.cost, 0)
    });
  }

  /**
   * Initialize all providers
   */
  async initializeProviders() {
    const providerClasses = {
      deepseek: DeepSeekProvider,
      anthropic: AnthropicProvider,
      openai: OpenAIProvider,
      ollama: OllamaProvider,
      groq: GroqProvider,
      gemini: GeminiProvider
    };

    // Create credential resolver bound to this gateway
    const credentialResolver = this.resolveCredential.bind(this);

    for (const [name, ProviderClass] of Object.entries(providerClasses)) {
      const providerConfig = this.config.providers?.[name];

      if (providerConfig && providerConfig.enabled) {
        const provider = new ProviderClass(providerConfig, this.logger, credentialResolver);
        await provider.initialize();

        this.providers.set(name, provider);

        // Initialize usage tracking
        this.usage.set(name, {
          requests: 0,
          tokens: 0,
          cost: 0,
          errors: 0
        });
      }
    }
  }

  /**
   * Get available provider names
   */
  async getAvailableProviderNames() {
    const names = [];
    for (const [name, provider] of this.providers.entries()) {
      if (await provider.isAvailable()) {
        names.push(name);
      }
    }
    return names;
  }

  /**
   * Get provider by priority
   */
  async getProvidersByPriority() {
    const available = [];

    for (const [name, provider] of this.providers.entries()) {
      if (await provider.isAvailable()) {
        available.push({
          name,
          provider,
          priority: this.config.providers[name].priority
        });
      }
    }

    // Sort by priority (1 = highest)
    available.sort((a, b) => a.priority - b.priority);

    return available.map(item => ({ name: item.name, provider: item.provider }));
  }

  /**
   * API Handler: Chat Completion
   * Format: return { status, data }
   * Supports tools for function calling with optional auto-execution
   *
   * Options:
   * - tools: Array of tools to make available
   * - execute_tools: If true, auto-execute tool calls and continue conversation
   * - max_tool_iterations: Max tool call loops (default: 10)
   */
  async handleChatCompletion(req, context) {
    try {
      const {
        messages: initialMessages,
        tools: requestedTools,
        provider: requestedProvider,
        model,
        temperature,
        max_tokens,
        top_p,
        metadata,
        execute_tools,
        max_tool_iterations,
        stream
      } = req.body || {};
      const onChunk = context?.onChunk;
      const projectId = context?.projectId || metadata?.project_id;

      if (!initialMessages || !Array.isArray(initialMessages) || initialMessages.length === 0) {
        return {
          status: 400,
          data: { error: 'INVALID_REQUEST', message: 'messages array is required' }
        };
      }

      const startTime = Date.now();
      const maxIterations = max_tool_iterations || 10;
      let messages = [...initialMessages];
      let totalTokens = 0;
      let totalCost = 0;
      let allToolResults = [];

      // Get tools - use provided array, or if true/truthy load from moduleLoader
      let tools = null;
      if (Array.isArray(requestedTools) && requestedTools.length > 0) {
        // Explicit tools array provided
        tools = requestedTools;
      } else if (requestedTools && this.moduleLoader) {
        // tools=true or truthy - load from moduleLoader
        const availableTools = this.getAvailableTools();
        if (availableTools.length > 0) {
          tools = availableTools;
        }
      }

      // Determine provider first
      let providerName;
      let provider;

      if (requestedProvider && requestedProvider !== 'auto') {
        provider = this.providers.get(requestedProvider);
        if (!provider) {
          return {
            status: 400,
            data: { error: 'PROVIDER_NOT_FOUND', message: `Provider '${requestedProvider}' not found or not enabled` }
          };
        }
        if (!await provider.isAvailable({ projectId })) {
          return {
            status: 503,
            data: { error: 'PROVIDER_NOT_AVAILABLE', message: `Provider '${requestedProvider}' not available` }
          };
        }
        providerName = requestedProvider;
      } else {
        const providers = await this.getProvidersByPriority();
        if (providers.length === 0) {
          return {
            status: 503,
            data: { error: 'NO_PROVIDERS_AVAILABLE', message: 'No AI providers available. Check your API keys in credentials.' }
          };
        }
        providerName = providers[0].name;
        provider = providers[0].provider;
      }

      // Translate tools to provider format
      const translatedTools = tools ? this.translateToolsForProvider(tools, providerName) : null;

      // Chat options
      const chatOptions = {
        model,
        temperature,
        max_tokens,
        top_p,
        tools: translatedTools,
        projectId,
        retryConfig: this.config.retry
      };

      // Determine if we can use real streaming:
      // - stream requested AND no tools to execute
      // Real streaming gives text-as-it-generates experience
      const useRealStreaming = stream && onChunk && (!translatedTools || !execute_tools);

      // Agentic loop - execute tools and continue conversation
      let result;
      let iteration = 0;
      let consecutiveToolErrors = 0;
      const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

      while (iteration < maxIterations) {
        iteration++;

        this.logger.info('ai-gateway.chat.iteration', {
          iteration,
          messages_count: messages.length,
          has_tools: !!translatedTools,
          streaming: useRealStreaming && iteration === 1
        });

        // Call AI - use streaming for first/only call when no tools
        if (useRealStreaming) {
          result = await this.chatStreamWithRetry(provider, messages, {
            ...chatOptions,
            onChunk
          });
        } else {
          result = await this.chatWithRetry(provider, messages, chatOptions);
        }

        // Accumulate usage
        totalTokens += result.usage?.total_tokens || 0;
        totalCost += result.cost || 0;

        // Check for tool calls
        if (!result.tool_calls || result.tool_calls.length === 0) {
          // No tool calls - we're done
          break;
        }

        // If execute_tools is not enabled, return with tool_calls for caller to handle
        if (!execute_tools) {
          break;
        }

        this.logger.info('ai-gateway.tools.executing', {
          iteration,
          tool_calls_count: result.tool_calls.length,
          tools: result.tool_calls.map(tc => tc.function?.name || tc.name)
        });

        // Parse and execute tool calls
        const toolCalls = this.parseToolCallsFromProvider(result, providerName);

        // Notify frontend: tools are being executed
        if (onChunk) {
          for (const tc of toolCalls) {
            onChunk({ tool: { name: tc.name, status: 'executing' } });
          }
        }

        const toolResults = await this.executeToolCalls(toolCalls, context);
        allToolResults.push(...toolResults);

        // Notify frontend: tools completed
        if (onChunk) {
          for (const tr of toolResults) {
            onChunk({ tool: { name: tr.name, status: tr.status === 'error' ? 'error' : 'completed' } });
          }
        }

        // Check if any tool requires confirmation (pause the loop)
        const pendingConfirmation = toolResults.find(r => r.requires_confirmation);
        if (pendingConfirmation) {
          this.logger.info('ai-gateway.tools.pending_confirmation', {
            tool: pendingConfirmation.name
          });
          result.pending_confirmation = pendingConfirmation;
          break;
        }

        // Track consecutive tool errors to break infinite retry loops
        // (e.g. DeepSeek repeatedly sending truncated JSON that always fails)
        const allFailed = toolResults.length > 0 && toolResults.every(r => r.status === 'error');
        if (allFailed) {
          consecutiveToolErrors++;
          this.logger.warn('ai-gateway.tools.consecutive_errors', {
            iteration,
            consecutive: consecutiveToolErrors,
            max: MAX_CONSECUTIVE_TOOL_ERRORS,
            tools: toolResults.map(r => r.name)
          });

          if (consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
            this.logger.error('ai-gateway.tools.error_loop_broken', {
              iterations: iteration,
              consecutive_errors: consecutiveToolErrors,
              last_errors: toolResults.map(r => ({ name: r.name, error: r.error }))
            });

            // Inject a system hint so the LLM can give a human-readable error
            messages.push({
              role: 'assistant',
              content: result.content || null,
              tool_calls: result._raw_tool_calls || result.tool_calls
            });
            const errorToolMessages = this.formatToolResultsForProvider(
              toolResults.map(r => ({
                ...r,
                result: `Error after ${consecutiveToolErrors} retries: ${r.error}. ` +
                  'Do NOT retry. Tell the user what went wrong and suggest a simpler request.'
              })),
              providerName
            );
            messages.push(...errorToolMessages);

            // One last call so the LLM can compose a final user-facing message
            if (iteration < maxIterations) {
              const finalOpts = { ...chatOptions, tools: null }; // strip tools to force text
              result = await this.chatWithRetry(provider, messages, finalOpts);
              totalTokens += result.usage?.total_tokens || 0;
              totalCost += result.cost || 0;
            }
            break;
          }
        } else {
          consecutiveToolErrors = 0;
        }

        // Add assistant message with tool calls to conversation
        // Use raw API names (_raw_tool_calls) so the provider sees its own names echoed back
        messages.push({
          role: 'assistant',
          content: result.content || null,
          tool_calls: result._raw_tool_calls || result.tool_calls
        });

        // Add tool results to conversation
        const toolResultMessages = this.formatToolResultsForProvider(toolResults, providerName);
        messages.push(...toolResultMessages);
      }

      // Post-hoc streaming: when tools were active, real-time streaming was
      // not possible. Simulate typewriter effect by publishing content progressively.
      if (stream && onChunk && !useRealStreaming && result?.content) {
        const content = result.content;
        const chunkSize = 12;
        for (let i = 0; i < content.length; i += chunkSize) {
          onChunk(content.slice(i, i + chunkSize));
          await new Promise(r => setTimeout(r, 10));
        }
      }

      const latencyMs = Date.now() - startTime;

      // Record usage
      const usageStats = this.usage.get(providerName);
      if (usageStats) {
        usageStats.requests++;
        usageStats.tokens += totalTokens;
        usageStats.cost += totalCost;
      }

      // Publish completion event
      if (this.config.analytics?.enabled && this.eventBus) {
        this.eventBus.publish(EVENTS.AI.COMPLETION_COMPLETED, {
          provider: providerName,
          model: result.model,
          prompt_id: metadata?.prompt_id,
          tokens_used: totalTokens,
          latency_ms: latencyMs,
          cost: totalCost,
          tool_calls_count: allToolResults.length,
          iterations: iteration,
          metadata
        });
      }

      return {
        status: 200,
        data: {
          ...result,
          usage: {
            ...result.usage,
            total_tokens: totalTokens
          },
          cost: totalCost,
          latency_ms: latencyMs,
          iterations: iteration,
          tool_results: allToolResults.length > 0 ? allToolResults : undefined,
          metadata
        }
      };
    } catch (error) {
      this.logger.error('ai-gateway.chat.error', { error: error.message });
      return {
        status: 500,
        data: { error: 'CHAT_FAILED', message: error.message }
      };
    }
  }

  /**
   * API Handler: Chat Completion Stream (SSE)
   * Note: Streaming requires special handling
   */
  async handleChatStream(req, context) {
    // For now, return error - streaming needs special HTTP handling
    return {
      status: 501,
      data: { error: 'NOT_IMPLEMENTED', message: 'Streaming requires SSE, use /chat for now' }
    };
  }

  /**
   * API Handler: List Providers
   */
  async handleListProviders(req, context) {
    try {
      const providers = [];

      for (const [name, provider] of this.providers.entries()) {
        const available = await provider.isAvailable();
        const usage = this.usage.get(name);

        providers.push({
          name,
          priority: this.config.providers?.[name]?.priority || 99,
          available,
          models: this.config.providers?.[name]?.models || [],
          default_model: this.config.providers?.[name]?.default_model,
          usage: usage || { requests: 0, tokens: 0, cost: 0, errors: 0 }
        });
      }

      // Sort by priority
      providers.sort((a, b) => a.priority - b.priority);

      return { status: 200, data: { providers } };
    } catch (error) {
      this.logger.error('ai-gateway.list-providers.error', { error: error.message });
      return { status: 500, data: { error: 'LIST_PROVIDERS_FAILED', message: error.message } };
    }
  }

  /**
   * API Handler: List Models
   */
  async handleListModels(req, context) {
    try {
      const { provider: providerName } = req.query || {};
      const models = [];

      if (providerName) {
        const providerConfig = this.config.providers?.[providerName];
        if (providerConfig) {
          for (const model of providerConfig.models || []) {
            models.push({
              provider: providerName,
              model,
              default: model === providerConfig.default_model
            });
          }
        }
      } else {
        // All models from all providers
        for (const [name, config] of Object.entries(this.config.providers || {})) {
          if (config.enabled) {
            for (const model of config.models || []) {
              models.push({
                provider: name,
                model,
                default: model === config.default_model
              });
            }
          }
        }
      }

      return { status: 200, data: { models, total: models.length } };
    } catch (error) {
      this.logger.error('ai-gateway.list-models.error', { error: error.message });
      return { status: 500, data: { error: 'LIST_MODELS_FAILED', message: error.message } };
    }
  }

  /**
   * API Handler: Get Usage
   */
  async handleGetUsage(req, context) {
    try {
      const { provider: providerName } = req.query || {};

      const usageData = [];

      if (providerName) {
        const usage = this.usage.get(providerName);
        if (usage) {
          usageData.push({ provider: providerName, ...usage });
        }
      } else {
        // All providers
        for (const [name, usage] of this.usage.entries()) {
          usageData.push({ provider: name, ...usage });
        }
      }

      // Calculate totals
      const totals = usageData.reduce(
        (acc, u) => ({
          requests: acc.requests + u.requests,
          tokens: acc.tokens + u.tokens,
          cost: acc.cost + u.cost,
          errors: acc.errors + u.errors
        }),
        { requests: 0, tokens: 0, cost: 0, errors: 0 }
      );

      return { status: 200, data: { usage: usageData, totals } };
    } catch (error) {
      this.logger.error('ai-gateway.usage.error', { error: error.message });
      return { status: 500, data: { error: 'GET_USAGE_FAILED', message: error.message } };
    }
  }

  /**
   * API Handler: Test Provider
   */
  async handleTestProvider(req, context) {
    try {
      const { provider: providerName } = req.body || {};

      if (!providerName) {
        return { status: 400, data: { error: 'INVALID_REQUEST', message: 'provider is required' } };
      }

      const provider = this.providers.get(providerName);

      if (!provider) {
        return { status: 404, data: { error: 'PROVIDER_NOT_FOUND', message: `Provider '${providerName}' not found` } };
      }

      const available = await provider.isAvailable();

      if (!available) {
        return {
          status: 503,
          data: { provider: providerName, available: false, message: 'Provider not available (check API key)' }
        };
      }

      // Test with simple message
      const testMessages = [
        { role: 'user', content: 'Say "OK" if you can receive this message' }
      ];

      const startTime = Date.now();

      const result = await provider.chatCompletion(testMessages, { max_tokens: 10 });

      const latencyMs = Date.now() - startTime;

      return {
        status: 200,
        data: {
          provider: providerName,
          available: true,
          latency_ms: latencyMs,
          response_preview: result.content?.slice(0, 50),
          model: result.model
        }
      };
    } catch (error) {
      this.logger.error('ai-gateway.test.error', { error: error.message });
      return { status: 500, data: { error: 'TEST_FAILED', message: error.message } };
    }
  }

  // ============ UI API HANDLERS ============

  /**
   * API Handler: UI State
   * GET /ui/state - Estado completo para la UI (listo para pintar)
   */
  async handleUIState(req, context) {
    try {
      const providers = [];

      for (const [name, provider] of this.providers.entries()) {
        const available = await provider.isAvailable();
        const config = this.config.providers?.[name];
        const usage = this.usage.get(name);

        // Construir lista de modelos formateada
        const models = (config?.models || []).map(modelId => ({
          id: modelId,
          name: this.getModelDisplayName(modelId),
          isDefault: modelId === config?.default_model,
          isSelected: this.currentProvider === name && this.currentModel === modelId
        }));

        providers.push({
          id: name,
          displayName: this.getProviderDisplayName(name),
          icon: this.getProviderIcon(name),
          available,
          status: this.getProviderStatus(available, provider),
          priority: config?.priority || 99,
          isSelected: this.currentProvider === name,
          models,
          pricing: {
            input: config?.cost_per_1k_tokens?.input || 0,
            output: config?.cost_per_1k_tokens?.output || 0,
            currency: 'USD'
          },
          limits: {
            requestsPerMinute: config?.rate_limit?.requests_per_minute || 60,
            tokensPerMinute: config?.rate_limit?.tokens_per_minute || 100000
          },
          usage: usage || { requests: 0, tokens: 0, cost: 0, errors: 0 }
        });
      }

      // Ordenar por prioridad
      providers.sort((a, b) => a.priority - b.priority);

      // Calcular totales de uso
      const totalUsage = Array.from(this.usage.values()).reduce(
        (acc, u) => ({
          requests: acc.requests + u.requests,
          tokens: acc.tokens + u.tokens,
          cost: acc.cost + u.cost,
          errors: acc.errors + u.errors
        }),
        { requests: 0, tokens: 0, cost: 0, errors: 0 }
      );

      return {
        status: 200,
        data: {
          providers,
          current: {
            provider: this.currentProvider,
            model: this.currentModel,
            displayName: this.currentProvider === 'auto'
              ? 'Automático'
              : this.getProviderDisplayName(this.currentProvider),
            modelDisplayName: this.currentModel
              ? this.getModelDisplayName(this.currentModel)
              : null
          },
          usage: {
            session: totalUsage
          }
        }
      };
    } catch (error) {
      this.logger.error('ai-gateway.ui-state.error', { error: error.message });
      return { status: 500, data: { error: 'UI_STATE_FAILED', message: error.message } };
    }
  }

  /**
   * API Handler: UI Select
   * POST /ui/select - Seleccionar provider y modelo
   */
  async handleUISelect(req, context) {
    try {
      const { provider, model } = req.body || {};

      // Validar provider
      if (provider && provider !== 'auto') {
        if (!this.providers.has(provider)) {
          return {
            status: 400,
            data: { error: 'INVALID_PROVIDER', message: `Provider '${provider}' not found` }
          };
        }

        const providerInstance = this.providers.get(provider);
        const available = await providerInstance.isAvailable();

        if (!available) {
          return {
            status: 400,
            data: { error: 'PROVIDER_NOT_AVAILABLE', message: `Provider '${provider}' is not available (check API key)` }
          };
        }

        // Validar modelo si se proporciona
        if (model) {
          const config = this.config.providers?.[provider];
          if (!config?.models?.includes(model)) {
            return {
              status: 400,
              data: { error: 'INVALID_MODEL', message: `Model '${model}' not available for provider '${provider}'` }
            };
          }
        }
      }

      // Actualizar selección
      this.currentProvider = provider || 'auto';
      this.currentModel = model || null;

      this.logger.info('ai-gateway.ui.selected', {
        provider: this.currentProvider,
        model: this.currentModel
      });

      return {
        status: 200,
        data: {
          success: true,
          current: {
            provider: this.currentProvider,
            model: this.currentModel,
            displayName: this.currentProvider === 'auto'
              ? 'Automático'
              : this.getProviderDisplayName(this.currentProvider),
            modelDisplayName: this.currentModel
              ? this.getModelDisplayName(this.currentModel)
              : null
          }
        }
      };
    } catch (error) {
      this.logger.error('ai-gateway.ui-select.error', { error: error.message });
      return { status: 500, data: { error: 'UI_SELECT_FAILED', message: error.message } };
    }
  }

  /**
   * API Handler: UI Config GET
   * GET /ui/config - Obtener configuración de parámetros LLM
   */
  async handleUIConfigGet(req, context) {
    try {
      // Definición de parámetros con metadatos para la UI
      const configSchema = {
        temperature: {
          value: this.chatConfig.temperature,
          type: 'range',
          min: 0,
          max: 2,
          step: 0.1,
          label: 'Temperatura',
          description: 'Creatividad de las respuestas (0=preciso, 2=creativo)',
          icon: '🌡️'
        },
        maxTokens: {
          value: this.chatConfig.maxTokens,
          type: 'range',
          min: 256,
          max: 8192,
          step: 256,
          label: 'Máx. Tokens',
          description: 'Longitud máxima de la respuesta',
          icon: '📏'
        },
        topP: {
          value: this.chatConfig.topP,
          type: 'range',
          min: 0,
          max: 1,
          step: 0.05,
          label: 'Top P',
          description: 'Nucleus sampling (diversidad)',
          icon: '🎯'
        },
        frequencyPenalty: {
          value: this.chatConfig.frequencyPenalty,
          type: 'range',
          min: -2,
          max: 2,
          step: 0.1,
          label: 'Penalización Frecuencia',
          description: 'Reduce repetición de palabras',
          icon: '🔄'
        },
        presencePenalty: {
          value: this.chatConfig.presencePenalty,
          type: 'range',
          min: -2,
          max: 2,
          step: 0.1,
          label: 'Penalización Presencia',
          description: 'Fomenta temas nuevos',
          icon: '💡'
        },
        systemPrompt: {
          value: this.chatConfig.systemPrompt,
          type: 'textarea',
          maxLength: 4000,
          label: 'System Prompt',
          description: 'Instrucciones iniciales para el modelo',
          icon: '📝',
          placeholder: 'Ej: Eres un asistente experto en programación...'
        },
        stream: {
          value: this.chatConfig.stream,
          type: 'toggle',
          label: 'Streaming',
          description: 'Respuestas en tiempo real',
          icon: '⚡'
        }
      };

      return {
        status: 200,
        data: {
          config: configSchema,
          presets: [
            { id: 'precise', name: 'Preciso', icon: '🎯', temperature: 0.3, topP: 0.9 },
            { id: 'balanced', name: 'Balanceado', icon: '⚖️', temperature: 0.7, topP: 1.0 },
            { id: 'creative', name: 'Creativo', icon: '🎨', temperature: 1.2, topP: 0.95 },
            { id: 'code', name: 'Código', icon: '💻', temperature: 0.2, topP: 0.9, systemPrompt: 'Eres un experto programador. Responde con código limpio y comentado.' }
          ]
        }
      };
    } catch (error) {
      this.logger.error('ai-gateway.ui-config-get.error', { error: error.message });
      return { status: 500, data: { error: 'UI_CONFIG_GET_FAILED', message: error.message } };
    }
  }

  /**
   * API Handler: UI Config POST
   * POST /ui/config - Actualizar configuración de parámetros LLM
   */
  async handleUIConfigPost(req, context) {
    try {
      const updates = req.body || {};

      // Validar y aplicar cada parámetro
      if (typeof updates.temperature === 'number') {
        this.chatConfig.temperature = Math.max(0, Math.min(2, updates.temperature));
      }
      if (typeof updates.maxTokens === 'number') {
        this.chatConfig.maxTokens = Math.max(256, Math.min(8192, updates.maxTokens));
      }
      if (typeof updates.topP === 'number') {
        this.chatConfig.topP = Math.max(0, Math.min(1, updates.topP));
      }
      if (typeof updates.frequencyPenalty === 'number') {
        this.chatConfig.frequencyPenalty = Math.max(-2, Math.min(2, updates.frequencyPenalty));
      }
      if (typeof updates.presencePenalty === 'number') {
        this.chatConfig.presencePenalty = Math.max(-2, Math.min(2, updates.presencePenalty));
      }
      if (typeof updates.systemPrompt === 'string') {
        this.chatConfig.systemPrompt = updates.systemPrompt.slice(0, 4000);
      }
      if (typeof updates.stream === 'boolean') {
        this.chatConfig.stream = updates.stream;
      }

      // Aplicar preset si se proporciona
      if (updates.preset) {
        const presets = {
          precise: { temperature: 0.3, topP: 0.9 },
          balanced: { temperature: 0.7, topP: 1.0 },
          creative: { temperature: 1.2, topP: 0.95 },
          code: { temperature: 0.2, topP: 0.9, systemPrompt: 'Eres un experto programador. Responde con código limpio y comentado.' }
        };
        const preset = presets[updates.preset];
        if (preset) {
          Object.assign(this.chatConfig, preset);
        }
      }

      this.logger.info('ai-gateway.ui.config-updated', { config: this.chatConfig });

      return {
        status: 200,
        data: {
          success: true,
          config: this.chatConfig
        }
      };
    } catch (error) {
      this.logger.error('ai-gateway.ui-config-post.error', { error: error.message });
      return { status: 500, data: { error: 'UI_CONFIG_POST_FAILED', message: error.message } };
    }
  }

  // ============ TOOLS API HANDLERS ============

  /**
   * API Handler: List available tools
   * GET /tools - Lista todas las tools disponibles para AI
   */
  async handleListTools(req, context) {
    try {
      const tools = this.getAvailableTools();

      return {
        status: 200,
        data: {
          tools,
          count: tools.length,
          source: 'moduleLoader'
        }
      };
    } catch (error) {
      this.logger.error('ai-gateway.list-tools.error', { error: error.message });
      return { status: 500, data: { error: 'LIST_TOOLS_FAILED', message: error.message } };
    }
  }

  /**
   * API Handler: Execute a tool
   * POST /tools/:name/execute - Ejecuta una tool específica
   */
  async handleExecuteTool(req, context) {
    try {
      const toolName = context.params?.name || req.body?.name;
      const args = req.body?.args || req.body?.arguments || {};

      if (!toolName) {
        return { status: 400, data: { error: 'INVALID_REQUEST', message: 'tool name is required' } };
      }

      // Check if tool exists
      const tool = this.moduleLoader?.getTool(toolName);
      if (!tool) {
        return { status: 404, data: { error: 'TOOL_NOT_FOUND', message: `Tool '${toolName}' not found` } };
      }

      // Check confirmation requirement
      if (tool.confirmation) {
        const confirmed = req.body?.confirmed === true;
        if (!confirmed) {
          return {
            status: 200,
            data: {
              requires_confirmation: true,
              tool: toolName,
              description: tool.description,
              message: 'Esta acción requiere confirmación. Envía confirmed: true para ejecutar.'
            }
          };
        }
      }

      // Execute
      const result = await this.moduleLoader.executeTool(toolName, args);

      return {
        status: result?.status || 200,
        data: {
          success: true,
          tool: toolName,
          result: result?.data || result
        }
      };

    } catch (error) {
      this.logger.error('ai-gateway.execute-tool.error', { error: error.message });
      return { status: 500, data: { error: 'EXECUTE_TOOL_FAILED', message: error.message } };
    }
  }

  // ============ TOOLS INTEGRATION ============

  /**
   * Get available tools from Module Loader
   * Returns tools in format suitable for AI providers
   */
  getAvailableTools() {
    if (!this.moduleLoader) {
      return [];
    }

    return this.moduleLoader.getToolsForAI();
  }

  /**
   * Execute tool calls from AI response
   * @param {Array} toolCalls - Array of tool calls from AI
   * @param {Object} context - Execution context
   * @returns {Array} Results for each tool call
   */
  async executeToolCalls(toolCalls, context = {}) {
    if (!this.moduleLoader || !toolCalls || !Array.isArray(toolCalls)) {
      return [];
    }

    const results = [];

    for (const call of toolCalls) {
      const { id, name: rawName, arguments: args } = call;

      // Normalize tool name: convert dots to underscores for provider tools
      // DeepSeek may return "gmail.send" but we register as "gmail_send"
      const name = this.normalizeToolName(rawName);

      try {
        // Check if tool requires confirmation
        if (this.moduleLoader.toolRequiresConfirmation(name)) {
          this.logger.info('ai-gateway.tool.requires_confirmation', {
            tool: name,
            call_id: id
          });

          // Return pending confirmation status
          results.push({
            tool_call_id: id,
            name,
            status: 'pending_confirmation',
            requires_confirmation: true
          });
          continue;
        }

        // Execute tool via moduleLoader
        this.logger.info('ai-gateway.tool.executing', {
          tool: name,
          call_id: id,
          correlation_id: context.correlationId
        });

        // Inject context fields (project_id, conversation_id) into tool args
        // so multi-tenant tools receive them automatically
        const enrichedArgs = {
          ...args,
          ...(context.projectId && !args.project_id ? { project_id: context.projectId } : {}),
          ...(context.conversationId && !args.conversation_id ? { conversation_id: context.conversationId } : {})
        };

        const result = await this.moduleLoader.executeTool(name, enrichedArgs);

        results.push({
          tool_call_id: id,
          name,
          status: 'success',
          result: result?.data || result
        });

        this.logger.info('ai-gateway.tool.executed', {
          tool: name,
          call_id: id,
          status: result?.status || 200
        });

      } catch (error) {
        this.logger.error('ai-gateway.tool.error', {
          tool: name,
          call_id: id,
          error: error.message
        });

        results.push({
          tool_call_id: id,
          name,
          status: 'error',
          result: `Error executing ${name}: ${error.message}`,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * Translate tools to provider-specific format
   * @param {Array} tools - Tools from moduleLoader (internal format)
   * @param {string} providerName - Target provider name
   * @returns {Array} Provider-formatted tools
   */
  translateToolsForProvider(tools, providerName) {
    if (!tools || !Array.isArray(tools) || tools.length === 0) {
      return [];
    }

    switch (providerName) {
      case 'anthropic':
        // Anthropic format: { name, description, input_schema }
        return tools.map(tool => ({
          name: tool.name,
          description: tool.description || '',
          input_schema: tool.parameters || {
            type: 'object',
            properties: {},
            required: []
          }
        }));

      case 'gemini':
        // Gemini format: handled inside gemini-provider.convertTools()
        // Pass through as-is — the provider will convert
        return tools.map(tool => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.parameters || {
              type: 'object',
              properties: {},
              required: []
            }
          }
        }));

      case 'openai':
      case 'deepseek':
      case 'groq':
      case 'ollama':
      default:
        // OpenAI-compatible format (DeepSeek, Groq, Ollama all use this)
        return tools.map(tool => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.parameters || {
              type: 'object',
              properties: {},
              required: []
            }
          }
        }));
    }
  }

  /**
   * Safely parse JSON arguments from tool calls
   * Handles truncated JSON from providers that exceed token limits
   * by attempting partial field recovery before giving up.
   *
   * @param {string|object} args - Arguments to parse
   * @returns {object} Parsed arguments or recovered fields
   */
  safeParseArguments(args) {
    if (typeof args !== 'string') return args || {};
    try {
      return JSON.parse(args);
    } catch (e) {
      this.logger?.warn('ai-gateway.tool-args-parse-error', {
        error: e.message,
        args_length: args.length,
        truncated: args.substring(0, 200)
      });

      // Attempt partial recovery: extract top-level string fields from truncated JSON
      // This handles the common case where DeepSeek truncates a long "content" value
      const recovered = this._recoverFieldsFromTruncatedJSON(args);
      if (recovered && Object.keys(recovered).length > 0) {
        this.logger?.info('ai-gateway.tool-args-partial-recovery', {
          recovered_fields: Object.keys(recovered),
          original_length: args.length
        });
        recovered._partial_recovery = true;
        return recovered;
      }

      return { _parse_error: e.message, _raw: args };
    }
  }

  /**
   * Attempt to recover key-value pairs from truncated JSON
   * Extracts complete "key":"value" pairs that appear before the truncation point.
   * For the last (truncated) string value, captures what's available.
   *
   * @param {string} raw - Truncated JSON string
   * @returns {object|null} Recovered fields or null
   */
  _recoverFieldsFromTruncatedJSON(raw) {
    if (!raw || typeof raw !== 'string') return null;

    const result = {};

    // Match complete "key": "value" pairs (handles escaped quotes inside values)
    const completeFieldRegex = /"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let match;
    let lastIndex = 0;

    while ((match = completeFieldRegex.exec(raw)) !== null) {
      result[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
      lastIndex = completeFieldRegex.lastIndex;
    }

    // Try to recover the last truncated string field
    // Pattern: after the last complete pair, look for "key": "value... (unterminated)
    const remainder = raw.slice(lastIndex);
    const truncatedMatch = remainder.match(/"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (truncatedMatch) {
      const key = truncatedMatch[1];
      let value = truncatedMatch[2].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
      // Mark truncated content so consumers know it's incomplete
      if (value.length > 0) {
        result[key] = value;
        result._truncated_field = key;
      }
    }

    // Also try to recover non-string fields: "key": number/boolean/null
    const nonStringRegex = /"([^"]+)"\s*:\s*(true|false|null|\d+(?:\.\d+)?)\s*[,}]/g;
    while ((match = nonStringRegex.exec(raw)) !== null) {
      if (!(match[1] in result)) {
        try {
          result[match[1]] = JSON.parse(match[2]);
        } catch {
          result[match[1]] = match[2];
        }
      }
    }

    return Object.keys(result).filter(k => !k.startsWith('_')).length > 0 ? result : null;
  }

  /**
   * Parse tool calls from provider response to internal format
   * @param {Object} response - Provider response
   * @param {string} providerName - Source provider name
   * @returns {Array} Normalized tool calls: [{ id, name, arguments }]
   */
  parseToolCallsFromProvider(response, providerName) {
    if (!response) return [];

    let toolCalls = [];

    switch (providerName) {
      case 'anthropic':
        // Anthropic provider already normalizes tool_use blocks to OpenAI-compatible
        // tool_calls format in chatCompletion(), so read from response.tool_calls
        if (response.tool_calls && Array.isArray(response.tool_calls)) {
          toolCalls = response.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function?.name,
            arguments: this.safeParseArguments(tc.function?.arguments)
          }));
        }
        break;

      case 'openai':
      case 'deepseek':
        // OpenAI/DeepSeek: message.tool_calls array
        if (response.tool_calls && Array.isArray(response.tool_calls)) {
          toolCalls = response.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function?.name,
            arguments: this.safeParseArguments(tc.function?.arguments)
          }));
        }
        // Also check choices[0].message.tool_calls for raw API responses
        else if (response.choices?.[0]?.message?.tool_calls) {
          toolCalls = response.choices[0].message.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function?.name,
            arguments: this.safeParseArguments(tc.function?.arguments)
          }));
        }
        break;

      case 'groq':
        // Groq: OpenAI-compatible format
        if (response.tool_calls && Array.isArray(response.tool_calls)) {
          toolCalls = response.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function?.name,
            arguments: this.safeParseArguments(tc.function?.arguments)
          }));
        }
        break;

      case 'gemini':
        // Gemini: tool_calls already normalized by gemini-provider
        if (response.tool_calls && Array.isArray(response.tool_calls)) {
          toolCalls = response.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function?.name,
            arguments: this.safeParseArguments(tc.function?.arguments)
          }));
        }
        break;

      case 'ollama':
        // Ollama: similar to OpenAI when tools are supported
        if (response.message?.tool_calls) {
          toolCalls = response.message.tool_calls.map(tc => ({
            id: tc.id || `ollama-${Date.now()}`,
            name: tc.function?.name,
            arguments: this.safeParseArguments(tc.function?.arguments)
          }));
        }
        break;

      default:
        // Try OpenAI format as default
        if (response.tool_calls && Array.isArray(response.tool_calls)) {
          toolCalls = response.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function?.name,
            arguments: this.safeParseArguments(tc.function?.arguments)
          }));
        }
    }

    return toolCalls;
  }

  /**
   * Format tool results for provider
   * @param {Array} results - Tool execution results: [{ tool_call_id, result }]
   * @param {string} providerName - Target provider name
   * @returns {Array} Provider-formatted tool result messages
   */
  formatToolResultsForProvider(results, providerName) {
    if (!results || !Array.isArray(results)) return [];

    switch (providerName) {
      case 'anthropic':
        // Anthropic: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }
        return [{
          role: 'user',
          content: results.map(r => ({
            type: 'tool_result',
            tool_use_id: r.tool_call_id,
            content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result)
          }))
        }];

      case 'openai':
      case 'deepseek':
        // OpenAI/DeepSeek: { role: 'tool', tool_call_id, content }
        return results.map(r => ({
          role: 'tool',
          tool_call_id: r.tool_call_id,
          content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result)
        }));

      case 'groq':
      case 'ollama':
        // Groq/Ollama: same as OpenAI
        return results.map(r => ({
          role: 'tool',
          tool_call_id: r.tool_call_id,
          content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result)
        }));

      case 'gemini':
        // Gemini: functionResponse parts
        return results.map(r => ({
          role: 'tool',
          tool_call_id: r.tool_call_id,
          name: r.name,
          content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result)
        }));

      default:
        return results.map(r => ({
          role: 'tool',
          tool_call_id: r.tool_call_id,
          content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result)
        }));
    }
  }

  // ============ HELPER METHODS ============

  /**
   * Normalize tool name for lookup
   * Converts dots to underscores for provider tools
   * Example: "gmail.send" -> "gmail_send"
   *
   * @param {string} name - Tool name from AI response
   * @returns {string} Normalized tool name
   */
  normalizeToolName(name) {
    if (!name || typeof name !== 'string') return name;

    // First try exact match
    if (this.moduleLoader?.getTool(name)) {
      return name;
    }

    // Try converting dots to underscores (provider tool format)
    const normalized = name.replace(/\./g, '_');
    if (this.moduleLoader?.getTool(normalized)) {
      return normalized;
    }

    // Return original if no match found (will error later with proper message)
    return name;
  }

  /**
   * Chat with retry
   */
  async chatWithRetry(provider, messages, options) {
    return provider.withRetry(
      () => provider.chatCompletion(messages, options),
      options.retryConfig
    );
  }

  /**
   * Chat streaming with retry
   * Uses chatCompletionStream instead of chatCompletion
   */
  async chatStreamWithRetry(provider, messages, options) {
    return provider.withRetry(
      () => provider.chatCompletionStream(messages, options),
      options.retryConfig
    );
  }
}

module.exports = AIGatewayModule;
