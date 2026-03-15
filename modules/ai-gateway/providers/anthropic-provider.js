const BaseProvider = require('./base-provider');

/**
 * Anthropic Provider
 *
 * Implementación del proveedor Anthropic Claude (https://api.anthropic.com)
 * Priority: 2
 */
class AnthropicProvider extends BaseProvider {
  constructor(config, logger, credentialResolver) {
    super(config, logger, credentialResolver);
    this.name = 'anthropic';
    this.apiVersion = '2023-06-01';
  }

  /**
   * Initialize
   */
  async initialize() {
    await this.refreshApiKey();

    if (!this.apiKey) {
      this.logger.warn('anthropic.no-api-key', {
        message: 'No Anthropic API key found (checked credential-manager and environment)'
      });
    }

    this.logger.info('anthropic.initialized', {
      available: await this.isAvailable(),
      models: this.config.models
    });
  }

  /**
   * Refresh API key from environment (fallback when credential resolver unavailable)
   */
  refreshApiKeyFromEnv() {
    this.apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_GLOBAL || null;
  }

  /**
   * Convert OpenAI format messages to Anthropic format
   * Supports vision: messages with image_base64 field
   */
  convertMessages(messages) {
    const systemMessages = messages.filter(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');

    const system = systemMessages.map(m => {
      // Handle system messages with content array
      if (Array.isArray(m.content)) {
        return m.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      }
      return m.content;
    }).join('\n');

    const anthropicMessages = chatMessages.map(m => {
      // Tool result messages: convert from OpenAI format to Anthropic format
      // { role: 'tool', tool_call_id, content } → { role: 'user', content: [{ type: 'tool_result', ... }] }
      if (m.role === 'tool' && m.tool_call_id) {
        return {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          }]
        };
      }

      // User messages with tool_result content array: pass through directly
      if (m.role === 'user' && Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result')) {
        return { role: 'user', content: m.content };
      }

      const role = m.role === 'assistant' ? 'assistant' : 'user';

      // Assistant messages with tool_calls: convert to Anthropic tool_use content blocks
      if (m.role === 'assistant' && m.tool_calls && Array.isArray(m.tool_calls)) {
        const contentParts = [];
        // Add text content first if present
        if (m.content) {
          contentParts.push({ type: 'text', text: m.content });
        }
        // Convert each tool_call to tool_use block
        for (const tc of m.tool_calls) {
          let input = {};
          if (tc.function?.arguments) {
            try {
              input = typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments;
            } catch { input = {}; }
          }
          // Use tc.input for Anthropic-native format or tc.function for OpenAI format
          contentParts.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name || tc.name,
            input: tc.input || input
          });
        }
        return { role: 'assistant', content: contentParts };
      }

      // Check if message has image content (vision support)
      if (m.image_base64 || (Array.isArray(m.content) && m.content.some(c => c.type === 'image'))) {
        const contentParts = [];

        // Add image if present in image_base64 field
        if (m.image_base64) {
          const mediaType = m.image_type || 'image/jpeg';
          contentParts.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: m.image_base64
            }
          });
        }

        // Handle array content format
        if (Array.isArray(m.content)) {
          for (const part of m.content) {
            if (part.type === 'image' && part.source) {
              contentParts.push(part);
            } else if (part.type === 'text') {
              contentParts.push({ type: 'text', text: part.text });
            }
          }
        } else if (typeof m.content === 'string') {
          contentParts.push({ type: 'text', text: m.content });
        }

        return { role, content: contentParts };
      }

      // Standard text message
      return { role, content: m.content };
    });

    return { system, messages: anthropicMessages };
  }

  /**
   * Chat completion
   */
  async chatCompletion(messages, options = {}) {
    if (!await this.isAvailable()) {
      throw new Error('Anthropic provider not available (check API key)');
    }

    const model = options.model || this.config.default_model;

    // Convert messages
    const { system, messages: anthropicMessages } = this.convertMessages(messages);

    // Estimate tokens
    const messagesText = messages.map(m => m.content).join(' ');
    const estimatedTokens = this.countTokens(messagesText);

    // Check rate limit
    const rateLimitCheck = this.checkRateLimit(estimatedTokens);
    if (!rateLimitCheck.allowed) {
      throw new Error(`Rate limit exceeded: ${rateLimitCheck.reason}`);
    }

    // Build request
    const requestData = {
      model,
      messages: anthropicMessages,
      max_tokens: options.max_tokens || 2000,
      temperature: options.temperature || 0.7,
      top_p: options.top_p || 1,
      stream: false
    };

    if (system) {
      requestData.system = system;
    }

    // Add tools if provided (Anthropic format)
    if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
      requestData.tools = options.tools;
      // Allow model to choose whether to use tools
      requestData.tool_choice = options.tool_choice || { type: 'auto' };
    }

    const headers = {
      'x-api-key': this.apiKey,
      'anthropic-version': this.apiVersion
    };

    // Make request with retry
    const response = await this.withRetry(
      () => this.makeRequest('POST', '/messages', requestData, headers),
      options.retryConfig || {}
    );

    // Extract response - handle both text and tool_use content blocks
    let content = '';
    let toolCalls = null;

    if (Array.isArray(response.content)) {
      // Extract text content
      const textBlocks = response.content.filter(block => block.type === 'text');
      content = textBlocks.map(block => block.text).join('');

      // Extract tool_use blocks (convert to normalized format)
      const toolUseBlocks = response.content.filter(block => block.type === 'tool_use');
      if (toolUseBlocks.length > 0) {
        toolCalls = toolUseBlocks.map(block => ({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {})
          }
        }));
      }
    } else {
      content = response.content?.[0]?.text || '';
    }

    const inputTokens = response.usage?.input_tokens || estimatedTokens;
    const outputTokens = response.usage?.output_tokens || this.countTokens(content);
    const totalTokens = inputTokens + outputTokens;

    // Record usage
    this.recordUsage(totalTokens);

    // Calculate cost
    const cost = this.calculateCost(inputTokens, outputTokens);

    return {
      provider: this.name,
      model,
      content,
      tool_calls: toolCalls,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens
      },
      cost,
      finish_reason: response.stop_reason || 'stop'
    };
  }

  /**
   * Chat completion (streaming)
   */
  async chatCompletionStream(messages, options = {}) {
    if (!await this.isAvailable()) {
      throw new Error('Anthropic provider not available (check API key)');
    }

    const model = options.model || this.config.default_model;

    // Convert messages
    const { system, messages: anthropicMessages } = this.convertMessages(messages);

    // Estimate tokens
    const messagesText = messages.map(m => m.content).join(' ');
    const estimatedTokens = this.countTokens(messagesText);

    // Check rate limit
    const rateLimitCheck = this.checkRateLimit(estimatedTokens);
    if (!rateLimitCheck.allowed) {
      throw new Error(`Rate limit exceeded: ${rateLimitCheck.reason}`);
    }

    // Build request
    const requestData = {
      model,
      messages: anthropicMessages,
      max_tokens: options.max_tokens || 2000,
      temperature: options.temperature || 0.7,
      top_p: options.top_p || 1,
      stream: true
    };

    if (system) {
      requestData.system = system;
    }

    const headers = {
      'x-api-key': this.apiKey,
      'anthropic-version': this.apiVersion
    };

    return new Promise((resolve, reject) => {
      let buffer = '';
      let fullContent = '';

      this.makeStreamRequest(
        'POST',
        '/messages',
        requestData,
        headers,
        (chunk) => {
          buffer += chunk.toString();

          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();

              try {
                const parsed = JSON.parse(data);

                if (parsed.type === 'content_block_delta') {
                  const delta = parsed.delta?.text || '';

                  if (delta) {
                    fullContent += delta;

                    if (options.onChunk) {
                      options.onChunk(delta);
                    }
                  }
                }
              } catch (error) {
                // Ignore parse errors
              }
            }
          }
        },
        () => {
          const outputTokens = this.countTokens(fullContent);
          const totalTokens = estimatedTokens + outputTokens;

          this.recordUsage(totalTokens);

          const cost = this.calculateCost(estimatedTokens, outputTokens);

          resolve({
            provider: this.name,
            model,
            content: fullContent,
            usage: {
              input_tokens: estimatedTokens,
              output_tokens: outputTokens,
              total_tokens: totalTokens
            },
            cost,
            finish_reason: 'stop'
          });
        },
        (error) => {
          reject(error);
        }
      );
    });
  }
}

module.exports = AnthropicProvider;
