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

    // Unsubscribe tracking for cleanup
    this.unsubscribes = [];

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
    this.config = context.config || {};

    this.logger.info('chat-ai-bridge.loading', {
      module: this.name,
      version: this.version
    });

    // Register UI handlers (MQTT request/response)
    await this.registerUIHandlers();

    // Subscribe to events
    await this.subscribeToEvents();

    this.logger.info('chat-ai-bridge.loaded', {
      module: this.name
    });
  }

  async onUnload() {
    this.logger.info('chat-ai-bridge.unloading', { module: this.name });

    // Unregister UI handlers
    if (this.uiHandler) {
      this.uiHandler.unregister('chat-bridge', 'send');
      this.uiHandler.unregister('chat-bridge', 'status');
    }

    // Unsubscribe all event handlers
    for (const unsub of this.unsubscribes) {
      await unsub();
    }
    this.unsubscribes = [];

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

  // ==========================================
  // UI Handler Registration
  // ==========================================

  async registerUIHandlers() {
    if (!this.uiHandler) return;

    this.uiHandler.register('chat-bridge', 'send', this.handleUISend.bind(this));
    this.uiHandler.register('chat-bridge', 'status', this.handleUIStatus.bind(this));

    this.logger.info('chat-ai-bridge.ui_handlers.registered', {
      domain: 'chat-bridge',
      actions: ['send', 'status']
    });
  }

  // ==========================================
  // Event Subscriptions
  // ==========================================

  async subscribeToEvents() {
    // Main entry point: chat.send.request
    const unsubChatSend = await this.eventBus.subscribe(
      'chat.send.request',
      this.onChatSendRequest.bind(this)
    );
    this.unsubscribes.push(unsubChatSend);

    // Response from ai-gateway
    const unsubAI = await this.eventBus.subscribe(
      EVENTS.AI.CHAT_RESPONSE,
      this.onAIChatResponse.bind(this)
    );
    this.unsubscribes.push(unsubAI);

    // Response from chat-session (save)
    const unsubSessionSave = await this.eventBus.subscribe(
      'session.save.response',
      this.onSessionSaveResponse.bind(this)
    );
    this.unsubscribes.push(unsubSessionSave);

    // Response from prompt-composer
    const unsubPrompt = await this.eventBus.subscribe(
      'prompt.compose.response',
      this.onPromptComposeResponse.bind(this)
    );
    this.unsubscribes.push(unsubPrompt);

    // Response from session context load
    const unsubContext = await this.eventBus.subscribe(
      'session.context.load.response',
      this.onSessionContextResponse.bind(this)
    );
    this.unsubscribes.push(unsubContext);

    this.logger.info('chat-ai-bridge.events.subscribed', {
      events: [
        'chat.send.request',
        'ai.chat.response',
        'session.save.response',
        'prompt.compose.response',
        'session.context.load.response'
      ]
    });
  }

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
        stack: error.stack
      });

      await this.eventBus.publish('chat.send.response', {
        request_id: flowId,
        success: false,
        error: error.message,
        stage: flowState.stage,
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
    const { flowId, conversation_id, use_tools, correlation_id } = flowState;
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
      correlation_id
    });

    return await promise;
  }

  /**
   * Build messages array for AI request
   */
  buildAIMessages(systemPrompt, context, userContent) {
    const messages = [];

    // System prompt
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // Conversation history (from context)
    if (context.messages && context.messages.length > 0) {
      for (const msg of context.messages) {
        // For assistant messages, use content_blocks from metadata if present
        // This preserves thinking blocks required by Claude API
        let content = msg.content;
        if (msg.role === 'assistant' && msg.metadata?.content_blocks) {
          content = msg.metadata.content_blocks;
        }
        messages.push({
          role: msg.role,
          content
        });
      }
    }

    // Current user message (if not already in context)
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.content !== userContent) {
      messages.push({ role: 'user', content: userContent });
    }

    return messages;
  }

  /**
   * Step 4: Call AI via ai-gateway
   */
  async callAI(flowState, messages) {
    const { flowId, conversation_id, use_tools, correlation_id } = flowState;
    const requestId = crypto.randomUUID();

    // Longer timeout for AI calls, especially with tools
    const baseTimeout = this.config.aiTimeout || 60000;
    const toolTimeout = this.config.aiTimeoutWithTools || 180000;
    const timeout = use_tools ? toolTimeout : baseTimeout;

    const promise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingAIRequests.delete(requestId);
        reject(new Error(`AI request timeout after ${timeout / 1000}s`));
      }, timeout);

      this.pendingAIRequests.set(requestId, {
        resolve,
        reject,
        timeout: timeoutId,
        flowId
      });
    });

    await this.eventBus.publish(EVENTS.AI.CHAT_REQUEST, {
      request_id: requestId,
      messages,
      // When tools=true, ai-gateway loads tools automatically
      tools: use_tools,
      // When execute_tools=true, ai-gateway handles the tool loop
      execute_tools: use_tools,
      max_tool_iterations: this.config.maxToolIterations || 10,
      provider: 'auto',
      correlation_id
    });

    return await promise;
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

    // Build metadata, including content_blocks if present (for thinking block preservation)
    const metadata = {
      model: aiResponse.model,
      provider: aiResponse.provider,
      tool_calls_executed: aiResponse.tool_calls_executed,
      iterations: aiResponse.iterations
    };

    // Store content_blocks in metadata when present (preserves thinking blocks for Claude API)
    if (aiResponse.content_blocks) {
      metadata.content_blocks = aiResponse.content_blocks;
    }

    await this.eventBus.publish('session.save.request', {
      request_id: requestId,
      conversation_id,
      role: 'assistant',
      content: aiResponse.content || '[No response]',
      tokens: aiResponse.tokens,
      cost: aiResponse.cost,
      metadata,
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
