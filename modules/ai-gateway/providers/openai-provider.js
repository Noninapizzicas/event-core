const BaseProvider = require('./base-provider');

/**
 * OpenAI Provider
 *
 * Implementación del proveedor OpenAI (https://api.openai.com)
 * Priority: 3
 */
class OpenAIProvider extends BaseProvider {
  constructor(config, logger, credentialResolver) {
    super(config, logger, credentialResolver);
    this.name = 'openai';
  }

  /**
   * Initialize
   */
  async initialize() {
    await this.refreshApiKey();

    if (!this.apiKey) {
      this.logger.warn('openai.no-api-key', {
        message: 'No OpenAI API key found (checked credential-manager and environment)'
      });
    }

    this.logger.info('openai.initialized', {
      available: await this.isAvailable(),
      models: this.config.models
    });
  }

  /**
   * Refresh API key from environment (fallback when credential resolver unavailable)
   */
  refreshApiKeyFromEnv() {
    this.apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_GLOBAL || null;
  }

  /**
   * Convert messages to OpenAI format with vision support
   */
  convertMessagesForVision(messages) {
    return messages.map(m => {
      // Check if message has image content
      if (m.image_base64) {
        const mediaType = m.image_type || 'image/jpeg';
        const imageUrl = `data:${mediaType};base64,${m.image_base64}`;

        const content = [
          {
            type: 'image_url',
            image_url: { url: imageUrl, detail: 'high' }
          }
        ];

        if (m.content) {
          content.push({ type: 'text', text: m.content });
        }

        return { role: m.role, content };
      }

      // Handle array content format (already in OpenAI format)
      if (Array.isArray(m.content)) {
        return m;
      }

      // Standard text message
      return m;
    });
  }

  /**
   * Check if messages contain images
   */
  hasVisionContent(messages) {
    return messages.some(m =>
      m.image_base64 ||
      (Array.isArray(m.content) && m.content.some(c => c.type === 'image_url' || c.type === 'image'))
    );
  }

  /**
   * Chat completion
   */
  async chatCompletion(messages, options = {}) {
    if (!await this.isAvailable()) {
      throw new Error('OpenAI provider not available (check API key)');
    }

    // Use vision model if images are present
    const hasImages = this.hasVisionContent(messages);
    const model = options.model || (hasImages ? 'gpt-4o' : this.config.default_model);

    // Convert messages for vision if needed
    const processedMessages = hasImages ? this.convertMessagesForVision(messages) : messages;

    // Estimate tokens (approximate for images)
    const messagesText = messages.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
    const estimatedTokens = this.countTokens(messagesText) + (hasImages ? 1000 : 0); // Add tokens for image

    // Check rate limit
    const rateLimitCheck = this.checkRateLimit(estimatedTokens);
    if (!rateLimitCheck.allowed) {
      throw new Error(`Rate limit exceeded: ${rateLimitCheck.reason}`);
    }

    // Build request
    const requestData = {
      model,
      messages: processedMessages,
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || (hasImages ? 4000 : 2000),
      top_p: options.top_p || 1,
      stream: false
    };

    // Add tools if provided (OpenAI format)
    if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
      requestData.tools = options.tools;
      // Allow model to choose whether to use tools
      requestData.tool_choice = options.tool_choice || 'auto';
    }

    const headers = {
      'Authorization': `Bearer ${this.apiKey}`
    };

    // Make request with retry
    const response = await this.withRetry(
      () => this.makeRequest('POST', '/chat/completions', requestData, headers),
      options.retryConfig || {}
    );

    // Extract response
    const message = response.choices[0]?.message || {};
    const content = message.content || '';
    const toolCalls = message.tool_calls || null;
    const inputTokens = response.usage?.prompt_tokens || estimatedTokens;
    const outputTokens = response.usage?.completion_tokens || this.countTokens(content);
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
      finish_reason: response.choices[0]?.finish_reason || 'stop'
    };
  }

  /**
   * Chat completion (streaming)
   */
  async chatCompletionStream(messages, options = {}) {
    if (!await this.isAvailable()) {
      throw new Error('OpenAI provider not available (check API key)');
    }

    const model = options.model || this.config.default_model;

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
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || 2000,
      top_p: options.top_p || 1,
      stream: true
    };

    const headers = {
      'Authorization': `Bearer ${this.apiKey}`
    };

    return new Promise((resolve, reject) => {
      let buffer = '';
      let fullContent = '';

      this.makeStreamRequest(
        'POST',
        '/chat/completions',
        requestData,
        headers,
        (chunk) => {
          buffer += chunk.toString();

          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();

              if (data === '[DONE]') {
                continue;
              }

              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices[0]?.delta?.content || '';

                if (delta) {
                  fullContent += delta;

                  if (options.onChunk) {
                    options.onChunk(delta);
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

module.exports = OpenAIProvider;
