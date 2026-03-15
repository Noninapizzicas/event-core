const crypto = require('crypto');

const { EVENTS } = require('../../core/constants');

/**
 * Chat AI Bridge Module
 *
 * Puente entre el sistema de chat y ai-gateway que coordina:
 * - Guardado de mensajes de usuario via chat-session
 * - Composición de prompts via prompt-composer
 * - Llamadas a AI via ai-gateway
 * - Guardado de respuestas via chat-session
 *
 * NO maneja tool execution (delegado a ai-gateway cuando execute_tools=true)
 *
 * @module chat-ai-bridge
 * @version 1.0.0
 */
class ChatAiBridgeModule {
  constructor() {
    this.name = 'chat-ai-bridge';
    this.version = '1.0.0';

    // Dependencies (injected in onLoad)
    this.logger = null;
    this.eventBus = null;
    this.uiHandler = null;
    this.config = null;

    // Pending requests tracking
    this.pendingChatRequests = new Map();    // Full chat flow
    this.pendingSessionRequests = new Map(); // session.save requests
    this.pendingPromptRequests = new Map();  // prompt.compose requests
    this.pendingAIRequests = new Map();      // ai.chat requests

    // Active conversations (tracking in-flight requests)
    this.activeRequests = new Map();

    // Cached active project (updated via project.activated event)
    this.activeProjectId = null;

    // Startup time for health check
    this.startTime = Date.now();

    // Stats
    this.stats = {
      messagesProcessed: 0,
      aiCallsTotal: 0,
      aiCallsWithTools: 0,
      errors: 0
    };
  }

  // ==========================================
  // Lifecycle Hooks
  // ==========================================

  async onLoad(context) {
    this.logger = context.logger;
    this.eventBus = context.eventBus;
    this.uiHandler = context.uiHandler;
    this.config = context.moduleConfig || {};

    this.logger.info('chat-ai-bridge.loading', {
      module: this.name,
      version: this.version
    });

    // UI handlers and event subscriptions are auto-wired by the module loader
    // from module.json (events.subscribes with handler fields, and ui_handlers)

    this.logger.info('chat-ai-bridge.loaded', {
      module: this.name
    });
  }

  async onUnload() {
    this.logger.info('chat-ai-bridge.unloading', { module: this.name });

    // UI handler unregistration and event unsubscription are handled
    // automatically by the module loader during unload.

    // Cleanup pending requests
    const pendingMaps = [
      this.pendingChatRequests,
      this.pendingSessionRequests,
      this.pendingPromptRequests,
      this.pendingAIRequests
    ];

    for (const pending of pendingMaps) {
      for (const [, req] of pending.entries()) {
        if (req.timeout) clearTimeout(req.timeout);
        if (req.reject) req.reject(new Error('Module unloading'));
      }
      pending.clear();
    }

    this.activeRequests.clear();

    this.logger.info('chat-ai-bridge.unloaded', { module: this.name });
  }

  // UI handlers (conversation.send, chat-bridge.send, chat-bridge.status)
  // and event subscriptions are auto-wired by the module loader from module.json.

  // ==========================================
  // Main Flow: Chat Send Request
  // ==========================================

  /**
   * Main entry point: Handle incoming chat send request
   * Coordinates the full flow: save user msg → compose prompt → call AI → save response
   */
  async onChatSendRequest(event) {
    const data = event.data || event.payload || event;
    const {
      request_id,
      conversation_id,
      content,
      user_id,
      attachments,
      use_tools,
      page_context,
      correlation_id
    } = data;

    const flowId = request_id || crypto.randomUUID();

    this.logger.info('chat-ai-bridge.flow.starting', {
      flowId,
      conversation_id,
      contentLength: content?.length,
      useTools: use_tools !== false,
      correlation_id
    });

    // Track the active flow
    const flowState = {
      flowId,
      conversation_id,
      content,
      user_id,
      attachments: attachments || [],
      use_tools: use_tools !== false,
      page_context: page_context || null,
      correlation_id,
      startTime: Date.now(),
      stage: 'init',
      userMessageId: null,
      assistantMessageId: null,
      prompt: null,
      aiResponse: null,
      error: null
    };

    this.activeRequests.set(flowId, flowState);

    try {
      // Step 1: Save user message
      flowState.stage = 'saving_user_message';
      const userMessage = await this.saveUserMessage(flowState);
      flowState.userMessageId = userMessage?.id;

      // Step 2: Load conversation context
      flowState.stage = 'loading_context';
      const context = await this.loadConversationContext(flowState);

      // Step 3: Compose prompt
      flowState.stage = 'composing_prompt';
      const prompt = await this.composePrompt(flowState, context);
      flowState.prompt = prompt;

      // Step 4: Build messages array for AI
      flowState.stage = 'building_ai_request';
      const aiMessages = this.buildAIMessages(prompt, context, content);

      // Step 5: Call AI
      flowState.stage = 'calling_ai';
      const aiResponse = await this.callAI(flowState, aiMessages);
      flowState.aiResponse = aiResponse;

      // Step 6: Save assistant message
      flowState.stage = 'saving_assistant_message';
      const assistantMessage = await this.saveAssistantMessage(flowState, aiResponse);
      flowState.assistantMessageId = assistantMessage?.id;

      // Step 6b: Publish final complete message to MQTT (safety net for lost streaming chunks)
      const mqttClient = this.uiHandler?.mqtt;
      if (mqttClient && assistantMessage) {
        mqttClient.publish(`conversation/${conversation_id}/message`, JSON.stringify({
          id: assistantMessage.id,
          role: 'assistant',
          content: aiResponse.content || assistantMessage.content || '',
          streaming: false,
          timestamp: assistantMessage.created_at || new Date().toISOString()
        }), { qos: 1 }); // QoS 1 para garantizar entrega
      }

      // Step 7: Send success response
      flowState.stage = 'completed';
      const duration = Date.now() - flowState.startTime;

      this.stats.messagesProcessed++;
      if (aiResponse.tool_calls_executed?.length > 0) {
        this.stats.aiCallsWithTools++;
      }
      this.stats.aiCallsTotal++;

      await this.eventBus.publish('chat.send.response', {
        request_id: flowId,
        success: true,
        user_message: userMessage,
        assistant_message: assistantMessage,
        tokens_used: aiResponse.tokens || 0,
        cost: aiResponse.cost || 0,
        tools_executed: aiResponse.tool_calls_executed || [],
        duration,
        correlation_id
      });

      this.logger.info('chat-ai-bridge.flow.completed', {
        flowId,
        conversation_id,
        duration,
        tokens: aiResponse.tokens,
        toolsExecuted: aiResponse.tool_calls_executed?.length || 0
      });

    } catch (error) {
      flowState.stage = 'error';
      flowState.error = error.message;
      this.stats.errors++;

      this.logger.error('chat-ai-bridge.flow.error', {
        flowId,
        stage: flowState.stage,
        error: error.message,
        stack: error.stack,
        hasPartialContent: !!(flowState.accumulatedContent)
      });

      // Save partial streaming content if the AI started responding before failing.
      // The user already saw these chunks via MQTT, so persist them to avoid ghost messages.
      let assistantMessage = null;
      if (flowState.accumulatedContent && flowState.accumulatedContent.length > 0) {
        try {
          assistantMessage = await this.saveAssistantMessage(flowState, {
            content: flowState.accumulatedContent,
            tokens: 0,
            cost: 0,
            metadata: { partial: true, error: error.message }
          });
          this.logger.info('chat-ai-bridge.partial_content.saved', {
            flowId,
            contentLength: flowState.accumulatedContent.length
          });
        } catch (saveError) {
          this.logger.warn('chat-ai-bridge.partial_content.save_failed', {
            flowId,
            error: saveError.message
          });
        }
      }

      await this.eventBus.publish('chat.send.response', {
        request_id: flowId,
        success: false,
        error: error.message,
        stage: flowState.stage,
        assistant_message: assistantMessage,
        partial_content: !!(flowState.accumulatedContent),
        correlation_id
      });

    } finally {
      this.activeRequests.delete(flowId);
    }
  }

  // ==========================================
  // Flow Steps
  // ==========================================

  /**
   * Step 1: Save user message via chat-session
   */
  async saveUserMessage(flowState) {
    const { flowId, conversation_id, content, user_id, attachments, correlation_id } = flowState;
    const requestId = crypto.randomUUID();
    const timeout = this.config.requestTimeout || 10000;

    const promise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingSessionRequests.delete(requestId);
        reject(new Error('Save user message timeout'));
      }, timeout);

      this.pendingSessionRequests.set(requestId, {
        resolve,
        reject,
        timeout: timeoutId,
        type: 'user',
        flowId
      });
    });

    await this.eventBus.publish('session.save.request', {
      request_id: requestId,
      conversation_id,
      role: 'user',
      content,
      user_id,
      attachments,
      correlation_id
    });

    return await promise;
  }

  /**
   * Step 2: Load conversation context (messages in context window)
   */
  async loadConversationContext(flowState) {
    const { flowId, conversation_id, correlation_id } = flowState;
    const requestId = crypto.randomUUID();
    const timeout = this.config.requestTimeout || 10000;

    const promise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingSessionRequests.delete(requestId);
        // Don't fail - return empty context
        resolve({ messages: [], conversation: null });
      }, timeout);

      this.pendingSessionRequests.set(requestId, {
        resolve,
        reject,
        timeout: timeoutId,
        type: 'context',
        flowId
      });
    });

    await this.eventBus.publish('session.context.load.request', {
      request_id: requestId,
      conversation_id,
      correlation_id
    });

    return await promise;
  }

  /**
   * Step 3: Compose system prompt via prompt-composer
   */
  async composePrompt(flowState, context) {
    const { flowId, conversation_id, use_tools, page_context, correlation_id } = flowState;
    const requestId = crypto.randomUUID();
    const timeout = this.config.requestTimeout || 10000;

    const promise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingPromptRequests.delete(requestId);
        // Don't fail - return default prompt
        resolve('You are a helpful AI assistant.');
      }, timeout);

      this.pendingPromptRequests.set(requestId, {
        resolve,
        reject,
        timeout: timeoutId,
        flowId
      });
    });

    await this.eventBus.publish('prompt.compose.request', {
      request_id: requestId,
      conversation: context.conversation,
      project_id: context.conversation?.project_id,
      include_tools: use_tools,
      page_context: page_context || null,
      correlation_id
    });

    return await promise;
  }

  /**
   * Build messages array for AI request
   *
   * Context budget: maxContextTokens (default 24000 ≈ ~96k chars)
   * When history exceeds budget, oldest messages are dropped and a brief
   * summary is injected so the AI knows earlier context existed.
   */
  buildAIMessages(systemPrompt, context, userContent) {
    const messages = [];

    // System prompt
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // Conversation history (from context)
    // Estimate tokens to avoid exceeding provider limits
    const maxContextTokens = this.config.maxContextTokens || 24000;
    let estimatedTokens = this.estimateTokens(systemPrompt || '');

    if (context.messages && context.messages.length > 0) {
      // Add messages from oldest to newest, but skip old ones if we'd exceed limit
      const historyMessages = [];
      for (const msg of context.messages) {
        historyMessages.push({ role: msg.role, content: msg.content });
      }

      // Try all messages first; trim oldest if over budget
      let totalHistoryTokens = historyMessages.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      let startIdx = 0;
      while (totalHistoryTokens + estimatedTokens > maxContextTokens && startIdx < historyMessages.length - 2) {
        totalHistoryTokens -= this.estimateTokens(historyMessages[startIdx].content);
        startIdx++;
      }

      if (startIdx > 0) {
        this.logger.info('chat-ai-bridge.context.trimmed', {
          dropped: startIdx,
          remaining: historyMessages.length - startIdx,
          estimatedTokens: totalHistoryTokens + estimatedTokens
        });

        // Inject a brief summary so the AI knows earlier messages existed
        const droppedMessages = historyMessages.slice(0, startIdx);
        const summary = this.summarizeDroppedMessages(droppedMessages);
        messages.push({ role: 'system', content: summary });
        estimatedTokens += this.estimateTokens(summary);
      }

      for (let i = startIdx; i < historyMessages.length; i++) {
        messages.push(historyMessages[i]);
      }
      estimatedTokens += totalHistoryTokens;
    }

    // Current user message (if not already in context)
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.content !== userContent) {
      messages.push({ role: 'user', content: userContent });
    }

    return messages;
  }

  /**
   * Build a compact summary of dropped messages so the AI retains
   * awareness of earlier conversation topics without full token cost.
   */
  summarizeDroppedMessages(droppedMessages) {
    const topics = [];
    for (const msg of droppedMessages) {
      if (msg.role === 'user' && msg.content) {
        // Take the first 120 chars of each user message as a topic hint
        const snippet = msg.content.length > 120
          ? msg.content.slice(0, 120) + '...'
          : msg.content;
        topics.push(snippet);
      }
    }

    if (topics.length === 0) {
      return `[Contexto previo: se omitieron ${droppedMessages.length} mensajes anteriores de esta conversación por límite de contexto.]`;
    }

    const topicList = topics.slice(-5).map((t, i) => `${i + 1}. ${t}`).join('\n');
    return `[Contexto previo: se omitieron ${droppedMessages.length} mensajes. Temas tratados anteriormente:\n${topicList}\nContinúa la conversación con el contexto reciente que sigue.]`;
  }

  /**
   * Rough token estimation (~4 chars per token for mixed content)
   */
  estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Step 4: Call AI via ai-gateway
   * Supports streaming: publishes chunks to MQTT conversation/{id}/message
   */
  async callAI(flowState, messages) {
    const { flowId, conversation_id, use_tools, correlation_id } = flowState;
    const requestId = crypto.randomUUID();

    // Longer timeout for AI calls, especially with tools
    const baseTimeout = this.config.aiTimeout || 60000;
    const toolTimeout = this.config.aiTimeoutWithTools || 180000;
    const timeout = use_tools ? toolTimeout : baseTimeout;

    // Streaming: accumulate chunks and forward to frontend via MQTT
    // Store on flowState so partial content is recoverable on error
    flowState.accumulatedContent = '';
    let accumulatedContent = '';
    let chunkUnsub = null;
    const streamingMsgId = crypto.randomUUID();
    const mqttClient = this.uiHandler?.mqtt;
    const canStream = !!mqttClient;

    if (canStream) {
      // Subscribe to chunk events BEFORE sending the request
      chunkUnsub = await this.eventBus.subscribe(EVENTS.AI.CHAT_CHUNK, (event) => {
        const chunkData = event.data || event;
        if (chunkData.request_id !== requestId) return;

        if (chunkData.done) {
          // Stream complete - publish end signal
          mqttClient.publish('conversation/stream/end', JSON.stringify({
            conversationId: conversation_id
          }), { qos: 1 });
          return;
        }

        // Tool status event - forward to dedicated topic
        if (chunkData.tool) {
          mqttClient.publish(`conversation/${conversation_id}/tool-status`, JSON.stringify({
            tool: chunkData.tool,
            timestamp: new Date().toISOString()
          }), { qos: 0 });
          return;
        }

        // Accumulate delta
        accumulatedContent += chunkData.delta || '';
        flowState.accumulatedContent = accumulatedContent;

        // Forward to frontend via MQTT
        mqttClient.publish(`conversation/${conversation_id}/message`, JSON.stringify({
          id: streamingMsgId,
          role: 'assistant',
          content: accumulatedContent,
          streaming: true,
          timestamp: new Date().toISOString()
        }), { qos: 0 }); // QoS 0 for speed
      });
    }

    const promise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingAIRequests.delete(requestId);
        if (chunkUnsub) chunkUnsub();
        reject(new Error(`AI request timeout after ${timeout / 1000}s`));
      }, timeout);

      this.pendingAIRequests.set(requestId, {
        resolve,
        reject,
        timeout: timeoutId,
        flowId,
        chunkUnsub // store for cleanup
      });
    });

    await this.eventBus.publish(EVENTS.AI.CHAT_REQUEST, {
      request_id: requestId,
      messages,
      tools: use_tools ? true : false,       // true = load from moduleLoader
      execute_tools: use_tools ? true : false,
      max_tool_iterations: this.config.maxToolIterations || 10,
      provider: 'auto',
      stream: canStream,
      project_id: this.activeProjectId || null,
      correlation_id
    });

    try {
      const result = await promise;
      return result;
    } finally {
      // Always cleanup chunk subscription
      if (chunkUnsub) {
        await chunkUnsub();
      }
    }
  }

  /**
   * Step 5: Save assistant message via chat-session
   */
  async saveAssistantMessage(flowState, aiResponse) {
    const { flowId, conversation_id, correlation_id } = flowState;
    const requestId = crypto.randomUUID();
    const timeout = this.config.requestTimeout || 10000;

    const promise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingSessionRequests.delete(requestId);
        // Don't fail flow - message was sent even if not saved
        resolve({ id: null, saved: false });
      }, timeout);

      this.pendingSessionRequests.set(requestId, {
        resolve,
        reject,
        timeout: timeoutId,
        type: 'assistant',
        flowId
      });
    });

    await this.eventBus.publish('session.save.request', {
      request_id: requestId,
      conversation_id,
      role: 'assistant',
      content: aiResponse.content || '[No response]',
      tokens: aiResponse.tokens,
      cost: aiResponse.cost,
      metadata: {
        model: aiResponse.model,
        provider: aiResponse.provider,
        tool_calls_executed: aiResponse.tool_calls_executed,
        iterations: aiResponse.iterations
      },
      correlation_id
    });

    return await promise;
  }

  // ==========================================
  // Response Handlers
  // ==========================================

  async onAIChatResponse(event) {
    const eventData = event.data || event;
    const { request_id, success, content, tool_calls_executed, tokens, cost, model, provider, iterations, error } = eventData;

    const pending = this.pendingAIRequests.get(request_id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingAIRequests.delete(request_id);

    if (success) {
      pending.resolve({
        content,
        tool_calls_executed: tool_calls_executed || [],
        tokens,
        cost,
        model,
        provider,
        iterations
      });
    } else {
      pending.reject(new Error(error || 'AI request failed'));
    }
  }

  async onSessionSaveResponse(event) {
    const eventData = event.data || event;
    const { request_id, success, message, error } = eventData;

    const pending = this.pendingSessionRequests.get(request_id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingSessionRequests.delete(request_id);

    if (success) {
      pending.resolve(message);
    } else {
      // For saves, don't fail the whole flow
      this.logger.warn('chat-ai-bridge.session_save.failed', {
        request_id,
        type: pending.type,
        error
      });
      pending.resolve({ id: null, saved: false, error });
    }
  }

  async onSessionContextResponse(event) {
    const eventData = event.data || event;
    const { request_id, success, messages, conversation, error } = eventData;

    const pending = this.pendingSessionRequests.get(request_id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingSessionRequests.delete(request_id);

    if (success) {
      pending.resolve({ messages: messages || [], conversation });
    } else {
      // Don't fail - return empty context
      pending.resolve({ messages: [], conversation: null });
    }
  }

  async onPromptComposeResponse(event) {
    const eventData = event.data || event;
    const { request_id, success, prompt, error } = eventData;

    const pending = this.pendingPromptRequests.get(request_id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingPromptRequests.delete(request_id);

    if (success) {
      pending.resolve(prompt);
    } else {
      // Don't fail - return default prompt
      pending.resolve('You are a helpful AI assistant.');
    }
  }

  // ==========================================
  // UI Handlers (MQTT Request/Response)
  // ==========================================

  // ==========================================
  // Project Lifecycle
  // ==========================================

  /**
   * Handle project.activated - cache the active project ID
   * Eliminates the need for RPC call on every chat message
   */
  async onProjectActivated(event) {
    const data = event.data || event;
    const { project_id, name } = data;

    if (!project_id) return;

    this.activeProjectId = project_id;
    this.logger.info('chat-ai-bridge.project.activated', { project_id, project_name: name });
  }

  /**
   * Handle project.deactivated - clear cached project ID
   */
  async onProjectDeactivated(event) {
    const data = event.data || event;
    const { project_id } = data;

    if (this.activeProjectId === project_id) {
      this.activeProjectId = null;
      this.logger.info('chat-ai-bridge.project.deactivated', { project_id });
    }
  }

  // ==========================================
  // Helper: Get Active Project
  // ==========================================

  /**
   * Get active project ID.
   * Uses cached value from project.activated event when available.
   * Falls back to RPC query if cache is empty (e.g., module loaded after project was activated).
   */
  async getActiveProjectId(correlationId) {
    // Fast path: return cached value
    if (this.activeProjectId) {
      return this.activeProjectId;
    }

    // Slow path: RPC fallback (first call or after module restart)
    this.logger.debug('chat-ai-bridge.getActiveProjectId.rpc_fallback', { correlationId });

    const requestId = crypto.randomUUID();

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        unsub();
        resolve(null);
      }, 5000);

      const unsub = await this.eventBus.subscribe(EVENTS.PROJECT.ACTIVE_RESPONSE, (event) => {
        const data = event.data || event;
        if (data.request_id === requestId) {
          clearTimeout(timeout);
          unsub();
          const projectId = data.active_project_id
            || (Array.isArray(data.active_project_ids) && data.active_project_ids[0])
            || null;
          // Cache for next time
          if (projectId) {
            this.activeProjectId = projectId;
          }
          resolve(projectId);
        }
      });

      await this.eventBus.publish(EVENTS.PROJECT.ACTIVE_REQUEST, {
        request_id: requestId,
        correlation_id: correlationId
      });
    });
  }

  // ==========================================
  // UI Handler: conversation.send (primary frontend entry point)
  // ==========================================

  /**
   * UI Handler: conversation.send
   * Replaces conversation-manager facade for send action.
   * Frontend calls: mqttRequest('conversation', 'send', { conversationId, content, attachments })
   */
  async handleConversationSend(data, request) {
    const { conversationId, content, attachments, pageContext } = data;
    const correlationId = request?.correlationId || crypto.randomUUID();

    this.logger.info('chat-ai-bridge.handleConversationSend', { correlationId, conversationId });

    if (!content || content.trim().length === 0) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Content is required' };
    }

    try {
      // Get active project
      const projectId = await this.getActiveProjectId(correlationId);
      if (!projectId) {
        throw { status: 400, code: 'NO_PROJECT', message: 'No active project' };
      }

      // Create conversation if needed
      let convId = conversationId;
      if (!convId) {
        const createRequestId = crypto.randomUUID();
        const createResponse = await new Promise(async (resolve, reject) => {
          const timeout = setTimeout(() => { unsub(); reject(new Error('Create conversation timeout')); }, 10000);
          const unsub = await this.eventBus.subscribe('session.create.response', (event) => {
            const d = event.data || event;
            if (d.request_id === createRequestId) {
              clearTimeout(timeout);
              unsub();
              resolve(d);
            }
          });
          await this.eventBus.publish('session.create.request', {
            request_id: createRequestId,
            project_id: projectId,
            correlation_id: correlationId
          });
        });

        if (!createResponse.success) {
          throw { status: 500, code: 'CREATE_ERROR', message: createResponse.error || 'Failed to create conversation' };
        }
        convId = createResponse.conversation?.id;
      }

      // Execute chat flow via internal event (triggers onChatSendRequest)
      const requestId = crypto.randomUUID();
      const responsePromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingChatRequests.delete(requestId);
          reject(new Error('Chat request timeout'));
        }, (this.config.aiTimeoutWithTools || 180000) + 30000);
        this.pendingChatRequests.set(requestId, { resolve, reject, timeout });
      });

      const unsubResponse = await this.eventBus.subscribe('chat.send.response', (event) => {
        const eventData = event.data || event;
        if (eventData.request_id === requestId) {
          const pending = this.pendingChatRequests.get(requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingChatRequests.delete(requestId);
            if (eventData.success) pending.resolve(eventData);
            else pending.reject(new Error(eventData.error || 'Chat request failed'));
          }
          unsubResponse();
        }
      });

      await this.eventBus.publish('chat.send.request', {
        request_id: requestId,
        conversation_id: convId,
        content,
        attachments: attachments || [],
        use_tools: true,
        page_context: pageContext || null,
        correlation_id: correlationId
      });

      const result = await responsePromise;

      return {
        conversationId: convId,
        user_message: result.user_message,
        assistant_message: result.assistant_message,
        tokens_used: result.tokens_used,
        cost: result.cost,
        duration: result.duration
      };

    } catch (error) {
      if (error.status) throw error;
      this.logger.error('chat-ai-bridge.handleConversationSend.error', {
        correlationId,
        error: error.message
      });
      throw { status: 500, code: 'SEND_ERROR', message: error.message };
    }
  }

  // ==========================================
  // UI Handlers: chat-bridge domain (internal)
  // ==========================================

  /**
   * UI Handler: Send message through the bridge
   */
  async handleUISend(data, context) {
    const { conversationId, content, useTools } = data;
    const correlationId = context?.correlationId || crypto.randomUUID();

    try {
      this.logger.debug('chat-ai-bridge.handleUISend', {
        conversationId,
        contentLength: content?.length,
        correlation_id: correlationId
      });

      if (!conversationId) {
        throw { status: 400, code: 'VALIDATION_ERROR', message: 'conversationId is required' };
      }

      if (!content || content.trim().length === 0) {
        throw { status: 400, code: 'VALIDATION_ERROR', message: 'content is required' };
      }

      // Create request ID for tracking
      const requestId = crypto.randomUUID();

      // Set up response promise
      const responsePromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingChatRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }, (this.config.aiTimeoutWithTools || 180000) + 30000); // Extra buffer

        this.pendingChatRequests.set(requestId, {
          resolve,
          reject,
          timeout
        });
      });

      // Subscribe to response for this specific request
      const unsubResponse = await this.eventBus.subscribe('chat.send.response', (event) => {
        const eventData = event.data || event;
        if (eventData.request_id === requestId) {
          const pending = this.pendingChatRequests.get(requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingChatRequests.delete(requestId);
            if (eventData.success) {
              pending.resolve(eventData);
            } else {
              pending.reject(new Error(eventData.error || 'Chat request failed'));
            }
          }
          unsubResponse(); // Cleanup subscription
        }
      });

      // Trigger the flow
      await this.eventBus.publish('chat.send.request', {
        request_id: requestId,
        conversation_id: conversationId,
        content,
        use_tools: useTools !== false,
        correlation_id: correlationId
      });

      // Wait for response
      const result = await responsePromise;

      return {
        success: true,
        userMessage: result.user_message,
        assistantMessage: result.assistant_message,
        tokensUsed: result.tokens_used,
        cost: result.cost,
        toolsExecuted: result.tools_executed,
        duration: result.duration
      };

    } catch (error) {
      if (error.status) throw error;
      this.logger.error('chat-ai-bridge.handleUISend.error', {
        error: error.message
      });
      throw { status: 500, code: 'SEND_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Get bridge status
   */
  async handleUIStatus(data, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();

    try {
      this.logger.debug('chat-ai-bridge.handleUIStatus', {
        correlation_id: correlationId
      });

      return {
        success: true,
        activeRequests: this.activeRequests.size,
        pendingAI: this.pendingAIRequests.size,
        pendingSession: this.pendingSessionRequests.size,
        pendingPrompt: this.pendingPromptRequests.size,
        stats: { ...this.stats },
        uptime: (Date.now() - this.startTime) / 1000
      };

    } catch (error) {
      this.logger.error('chat-ai-bridge.handleUIStatus.error', {
        error: error.message
      });
      throw { status: 500, code: 'STATUS_ERROR', message: error.message };
    }
  }

  // ==========================================
  // HTTP API Handlers
  // ==========================================

  async handleSendMessage(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    const { conversation_id, content, use_tools } = req.body || {};

    this.logger.debug('chat-ai-bridge.handleSendMessage', {
      correlation_id: correlationId,
      conversation_id
    });

    if (!conversation_id) {
      return { status: 400, data: { success: false, error: 'conversation_id is required' } };
    }

    if (!content || content.trim().length === 0) {
      return { status: 400, data: { success: false, error: 'content is required' } };
    }

    try {
      // Create request ID
      const requestId = crypto.randomUUID();

      // Set up response promise
      const responsePromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingChatRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }, (this.config.aiTimeoutWithTools || 180000) + 30000);

        this.pendingChatRequests.set(requestId, { resolve, reject, timeout });
      });

      // Subscribe to response
      const unsubResponse = await this.eventBus.subscribe('chat.send.response', (event) => {
        const eventData = event.data || event;
        if (eventData.request_id === requestId) {
          const pending = this.pendingChatRequests.get(requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingChatRequests.delete(requestId);
            pending.resolve(eventData);
          }
          unsubResponse();
        }
      });

      // Trigger flow
      await this.eventBus.publish('chat.send.request', {
        request_id: requestId,
        conversation_id,
        content,
        use_tools: use_tools !== false,
        correlation_id: correlationId
      });

      const result = await responsePromise;

      if (result.success) {
        return {
          status: 200,
          data: {
            success: true,
            user_message: result.user_message,
            assistant_message: result.assistant_message,
            tokens_used: result.tokens_used,
            cost: result.cost,
            tools_executed: result.tools_executed,
            duration: result.duration
          }
        };
      } else {
        return {
          status: 500,
          data: { success: false, error: result.error }
        };
      }

    } catch (error) {
      this.logger.error('chat-ai-bridge.handleSendMessage.error', {
        error: error.message,
        correlation_id: correlationId
      });
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleGetStatus(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();

    this.logger.debug('chat-ai-bridge.handleGetStatus', {
      correlation_id: correlationId
    });

    return {
      status: 200,
      data: {
        success: true,
        active_requests: this.activeRequests.size,
        pending: {
          ai: this.pendingAIRequests.size,
          session: this.pendingSessionRequests.size,
          prompt: this.pendingPromptRequests.size,
          chat: this.pendingChatRequests.size
        },
        stats: { ...this.stats },
        uptime: (Date.now() - this.startTime) / 1000
      }
    };
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
        active_requests: this.activeRequests.size,
        stats: { ...this.stats },
        timestamp: new Date().toISOString()
      }
    };
  }

  // ==========================================
  // Tool Handlers (for AI)
  // ==========================================

  async toolSendMessage(params, context) {
    const { conversation_id, content, use_tools } = params;
    const correlationId = context?.correlationId || crypto.randomUUID();

    try {
      this.logger.debug('chat-ai-bridge.toolSendMessage', {
        params,
        correlation_id: correlationId
      });

      if (!conversation_id) {
        return { success: false, error: 'conversation_id is required' };
      }

      if (!content || content.trim().length === 0) {
        return { success: false, error: 'content is required' };
      }

      // Create request ID
      const requestId = crypto.randomUUID();

      // Set up response promise
      const responsePromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingChatRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }, (this.config.aiTimeoutWithTools || 180000) + 30000);

        this.pendingChatRequests.set(requestId, { resolve, reject, timeout });
      });

      // Subscribe to response
      const unsubResponse = await this.eventBus.subscribe('chat.send.response', (event) => {
        const eventData = event.data || event;
        if (eventData.request_id === requestId) {
          const pending = this.pendingChatRequests.get(requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingChatRequests.delete(requestId);
            pending.resolve(eventData);
          }
          unsubResponse();
        }
      });

      // Trigger flow
      await this.eventBus.publish('chat.send.request', {
        request_id: requestId,
        conversation_id,
        content,
        use_tools: use_tools !== false,
        correlation_id: correlationId
      });

      const result = await responsePromise;

      if (result.success) {
        return {
          success: true,
          response: result.assistant_message?.content || '[No response]',
          tokens_used: result.tokens_used,
          tools_executed: result.tools_executed?.length || 0
        };
      } else {
        return { success: false, error: result.error };
      }

    } catch (error) {
      this.logger.error('chat-ai-bridge.toolSendMessage.error', {
        error: error.message
      });
      return { success: false, error: error.message };
    }
  }
}

module.exports = ChatAiBridgeModule;
