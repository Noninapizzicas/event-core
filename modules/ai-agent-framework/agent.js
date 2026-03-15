const crypto = require('crypto');

/**
 * Base Agent Class
 *
 * Todos los agentes deben extender esta clase
 */
class Agent {
  constructor(config) {
    this.id = config.id || this.generateId();
    this.name = config.name;
    this.description = config.description || '';
    this.prompt_id = config.prompt_id; // From Prompt Manager
    this.prompt_file = config.prompt_file; // Local file path (relative to module)
    this.knowledge_file = config.knowledge_file; // Knowledge file to embed in prompt
    this.provider = config.provider || 'auto'; // AI provider
    this.model = config.model || null;
    this.temperature = config.temperature || 0.7;
    this.max_tokens = config.max_tokens || 2000;

    // Event subscriptions
    this.subscribes = config.subscribes || [];

    // Tools this agent can use
    this.tools = config.tools || [];

    // Context management
    this.context_enabled = config.context_enabled !== false;
    this.context_window = config.context_window || 10; // Last N messages

    // Execution config
    this.enabled = config.enabled !== false;
    this.timeout_ms = config.timeout_ms || 60000;
    this.max_retries = config.max_retries || 3;

    // Metadata
    this.metadata = config.metadata || {};
    this.created_at = config.created_at || new Date().toISOString();
    this.updated_at = config.updated_at || new Date().toISOString();

    // Stats
    this.stats = {
      executions: 0,
      successes: 0,
      failures: 0,
      total_tokens: 0,
      total_cost: 0,
      avg_latency_ms: 0,
      last_execution: null
    };

    // Dependencies (injected by framework)
    this.logger = null;
    this.eventBus = null;
    this.contextManager = null;
    this.toolManager = null;
    this.promptManager = null;
    this.aiGateway = null;
  }

  /**
   * Initialize agent (called by framework)
   */
  async initialize(dependencies) {
    this.logger = dependencies.logger;
    this.eventBus = dependencies.eventBus;
    this.contextManager = dependencies.contextManager;
    this.toolManager = dependencies.toolManager;
    this.promptManager = dependencies.promptManager;
    this.aiGateway = dependencies.aiGateway;

    // Subscribe to events
    for (const eventPattern of this.subscribes) {
      this.eventBus.subscribe(eventPattern, this.handleEvent.bind(this));
    }

    this.logger.info('agent.initialized', {
      agent_id: this.id,
      name: this.name,
      subscribes: this.subscribes
    });
  }

  /**
   * Handle incoming event (override in subclass if needed)
   */
  async handleEvent(event) {
    if (!this.enabled) {
      this.logger.debug('agent.disabled', { agent_id: this.id, event_type: event.type });
      return;
    }

    try {
      this.logger.info('agent.event.received', {
        agent_id: this.id,
        event_type: event.type
      });

      // Start execution
      const result = await this.execute(event);

      // Update stats
      this.stats.executions++;
      this.stats.successes++;
      this.stats.last_execution = new Date().toISOString();

      // Publish completion event
      this.eventBus.publish(`agent.${this.name}.completed`, {
        agent_id: this.id,
        agent_name: this.name,
        trigger_event: event.type,
        result,
        timestamp: new Date().toISOString()
      });

      return result;
    } catch (error) {
      this.logger.error('agent.execution.failed', {
        agent_id: this.id,
        event_type: event.type,
        error: error.message
      });

      this.stats.executions++;
      this.stats.failures++;

      // Publish failure event
      this.eventBus.publish(`agent.${this.name}.failed`, {
        agent_id: this.id,
        agent_name: this.name,
        trigger_event: event.type,
        error: error.message,
        timestamp: new Date().toISOString()
      });

      throw error;
    }
  }

  /**
   * Execute agent logic (must be implemented by subclass or uses default)
   */
  async execute(event) {
    // Default implementation: render prompt + call AI + optionally use tools

    // 1. Build context
    const context = await this.buildContext(event);

    // 2. Render prompt
    const prompt = await this.renderPrompt(event, context);

    // 3. Call AI
    const aiResponse = await this.callAI(prompt, context);

    // 4. Process tools if needed
    const result = await this.processTools(aiResponse, event, context);

    // 5. Update context
    if (this.context_enabled) {
      await this.updateContext(event, result);
    }

    return result;
  }

  /**
   * Build context for execution
   */
  async buildContext(event) {
    if (!this.context_enabled || !this.contextManager) {
      return { messages: [] };
    }

    const context = await this.contextManager.getContext(this.id);

    // Get last N messages
    const messages = context.messages.slice(-this.context_window);

    return { messages };
  }

  /**
   * Render prompt template
   * Supports: prompt_id (from prompt-manager) OR prompt_file (local file)
   */
  async renderPrompt(event, context) {
    let promptContent = null;

    // Option 1: Load from local file (for built-in agents like Architect)
    if (this.prompt_file) {
      const fs = require('fs').promises;
      const path = require('path');
      const promptPath = path.join(__dirname, this.prompt_file);

      try {
        promptContent = await fs.readFile(promptPath, 'utf8');

        // If knowledge_file is specified, embed it in the prompt
        if (this.knowledge_file) {
          const knowledgePath = path.join(__dirname, this.knowledge_file);
          const knowledge = await fs.readFile(knowledgePath, 'utf8');
          promptContent = promptContent.replace('{{architect_knowledge}}', knowledge);
        }
      } catch (error) {
        this.logger?.error('agent.prompt.file.read.failed', {
          agent_id: this.id,
          prompt_file: this.prompt_file,
          error: error.message
        });
      }
    }

    // Option 2: Load from prompt-manager
    if (!promptContent && this.prompt_id && this.promptManager) {
      const variables = {
        ...event.payload,
        event_type: event.type,
        timestamp: event.timestamp
      };

      const rendered = await this.promptManager.renderTemplate(this.prompt_id, variables);
      promptContent = rendered.rendered;
    }

    // Fallback: use event payload
    if (!promptContent) {
      return event.payload?.message || JSON.stringify(event.payload);
    }

    // Replace event variables in prompt
    const variables = {
      ...event.payload,
      event_type: event.type,
      timestamp: event.timestamp
    };

    for (const [key, value] of Object.entries(variables)) {
      promptContent = promptContent.replace(new RegExp(`{{${key}}}`, 'g'), String(value || ''));
    }

    return promptContent;
  }

  /**
   * Call AI Gateway with native function calling support
   */
  async callAI(prompt, context) {
    if (!this.aiGateway) {
      throw new Error('AI Gateway not available');
    }

    // Build messages array
    const messages = [];

    // Add context messages
    if (context.messages && context.messages.length > 0) {
      messages.push(...context.messages);
    }

    // Add current prompt
    messages.push({
      role: 'user',
      content: prompt
    });

    // Get tool definitions for native function calling
    const tools = this.getToolDefinitions();

    // Call AI Gateway
    const startTime = Date.now();

    const response = await this.aiGateway.chatCompletion({
      messages,
      tools: tools.length > 0 ? tools : undefined,
      provider: this.provider,
      model: this.model,
      temperature: this.temperature,
      max_tokens: this.max_tokens,
      metadata: {
        agent_id: this.id,
        agent_name: this.name,
        prompt_id: this.prompt_id
      }
    });

    const latencyMs = Date.now() - startTime;

    // Update stats
    this.stats.total_tokens += response.usage?.total_tokens || 0;
    this.stats.total_cost += response.cost || 0;

    // Update avg latency
    const totalExecutions = this.stats.executions + 1;
    this.stats.avg_latency_ms =
      (this.stats.avg_latency_ms * this.stats.executions + latencyMs) / totalExecutions;

    return response;
  }

  /**
   * Get tool definitions in OpenAI/DeepSeek format
   * Used for native function calling
   */
  getToolDefinitions() {
    if (!this.toolManager || !this.tools || this.tools.length === 0) {
      return [];
    }

    // Get full tool definitions from toolManager
    const definitions = [];

    for (const toolName of this.tools) {
      const tool = this.toolManager.getTool(toolName);
      if (tool) {
        definitions.push({
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
        });
      }
    }

    return definitions;
  }

  /**
   * Process tool calls if needed
   * Supports both native tool_calls (DeepSeek/OpenAI) and legacy text format
   */
  async processTools(aiResponse, event, context) {
    // Check for native tool_calls first (DeepSeek/OpenAI format)
    let toolCalls = [];

    if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
      // Native function calling format
      toolCalls = aiResponse.tool_calls.map(tc => ({
        id: tc.id,
        tool_name: tc.function?.name || tc.name,
        arguments: typeof tc.function?.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function?.arguments || tc.arguments || {}
      }));
    } else {
      // Fallback: legacy text format [TOOL:name]({args})
      toolCalls = this.extractToolCalls(aiResponse.content);
    }

    if (toolCalls.length === 0 || !this.toolManager) {
      return {
        content: aiResponse.content,
        provider: aiResponse.provider,
        model: aiResponse.model,
        usage: aiResponse.usage,
        cost: aiResponse.cost,
        tools_used: []
      };
    }

    // Execute tools
    const toolResults = [];

    for (const toolCall of toolCalls) {
      try {
        this.logger?.info('agent.tool.executing', {
          agent_id: this.id,
          tool: toolCall.tool_name,
          args: toolCall.arguments
        });

        const result = await this.toolManager.executeTool(
          toolCall.tool_name,
          toolCall.arguments,
          this.tools
        );

        toolResults.push({
          tool_call_id: toolCall.id,
          tool: toolCall.tool_name,
          success: true,
          result
        });
      } catch (error) {
        this.logger?.error('agent.tool.failed', {
          agent_id: this.id,
          tool: toolCall.tool_name,
          error: error.message
        });

        toolResults.push({
          tool_call_id: toolCall.id,
          tool: toolCall.tool_name,
          success: false,
          error: error.message
        });
      }
    }

    return {
      content: aiResponse.content,
      provider: aiResponse.provider,
      model: aiResponse.model,
      usage: aiResponse.usage,
      cost: aiResponse.cost,
      tools_used: toolResults,
      finish_reason: aiResponse.finish_reason
    };
  }

  /**
   * Extract tool calls from AI response (legacy format)
   * Format: [TOOL:tool_name]({"arg1":"value1"})
   * Kept for backwards compatibility
   */
  extractToolCalls(content) {
    if (!content || typeof content !== 'string') {
      return [];
    }

    const toolPattern = /\[TOOL:([^\]]+)\]\(({[^)]+})\)/g;
    const toolCalls = [];

    let match;
    while ((match = toolPattern.exec(content)) !== null) {
      try {
        toolCalls.push({
          tool_name: match[1],
          arguments: JSON.parse(match[2])
        });
      } catch (error) {
        this.logger?.warn('agent.tool.parse-failed', {
          agent_id: this.id,
          raw: match[0]
        });
      }
    }

    return toolCalls;
  }

  /**
   * Update context after execution
   */
  async updateContext(event, result) {
    if (!this.contextManager) return;

    await this.contextManager.addMessage(this.id, {
      role: 'assistant',
      content: result.content,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Generate unique ID
   */
  generateId() {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Serialize agent to JSON
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      prompt_id: this.prompt_id,
      prompt_file: this.prompt_file,
      knowledge_file: this.knowledge_file,
      provider: this.provider,
      model: this.model,
      temperature: this.temperature,
      max_tokens: this.max_tokens,
      subscribes: this.subscribes,
      tools: this.tools,
      context_enabled: this.context_enabled,
      context_window: this.context_window,
      enabled: this.enabled,
      timeout_ms: this.timeout_ms,
      max_retries: this.max_retries,
      metadata: this.metadata,
      created_at: this.created_at,
      updated_at: this.updated_at,
      stats: this.stats
    };
  }

  /**
   * Create agent from JSON
   */
  static fromJSON(json) {
    return new Agent(json);
  }
}

module.exports = Agent;
