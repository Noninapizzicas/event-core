const BaseProvider = require('./base-provider');

/**
 * Groq Provider
 *
 * Implementación del proveedor Groq (https://api.groq.com)
 * API compatible con OpenAI — ultra-baja latencia (LPU hardware)
 *
 * Modelos: llama-3.3-70b-versatile, mixtral-8x7b-32768, gemma2-9b-it
 * Compound: groq/compound-beta (multi-tool server-side)
 */
class GroqProvider extends BaseProvider {
  constructor(config, logger, credentialResolver) {
    super(config, logger, credentialResolver);
    this.name = 'groq';
  }

  /**
   * Initialize
   */
  async initialize() {
    await this.refreshApiKey();

    if (!this.apiKey) {
      this.logger.warn('groq.no-api-key', {
        message: 'No Groq API key found (checked credential-manager and environment)'
      });
    }

    this.logger.info('groq.initialized', {
      available: await this.isAvailable(),
      models: this.config.models
    });
  }

  /**
   * Refresh API key from environment
   */
  refreshApiKeyFromEnv() {
    this.apiKey = process.env.GROQ_API_KEY || process.env.GROQ_API_KEY_GLOBAL || null;
  }

  /**
   * Chat completion — formato OpenAI compatible
   */
  async chatCompletion(messages, options = {}) {
    if (!await this.isAvailable()) {
      throw new Error('Groq provider not available (check API key)');
    }

    const model = options.model || this.config.default_model;

    // Estimate tokens for rate limiting
    const messagesText = messages.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
    const estimatedTokens = this.countTokens(messagesText);

    // Check rate limit
    const rateLimitCheck = this.checkRateLimit(estimatedTokens);
    if (!rateLimitCheck.allowed) {
      throw new Error(`Rate limit exceeded: ${rateLimitCheck.reason}`);
    }

    // Build request — OpenAI-compatible format
    const requestData = {
      model,
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || 2000,
      top_p: options.top_p || 1,
      stream: false
    };

    // Add tools if provided (OpenAI function calling format)
    if (options.tools && options.tools.length > 0) {
      requestData.tools = options.tools;
      requestData.tool_choice = options.tool_choice || 'auto';
    }

    const headers = {
      'Authorization': `Bearer ${this.apiKey}`
    };

    this.logger.info('groq.chat.request', {
      model,
      messageCount: messages.length,
      estimatedTokens
    });

    // Make request
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

    const result = {
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

    // Compound models may include executed_tools info
    if (response.executed_tools) {
      result.executed_tools = response.executed_tools;
    }

    return result;
  }

  /**
   * Chat completion (streaming) — SSE compatible con OpenAI
   */
  async chatCompletionStream(messages, options = {}) {
    if (!await this.isAvailable()) {
      throw new Error('Groq provider not available (check API key)');
    }

    const model = options.model || this.config.default_model;

    // Estimate tokens
    const messagesText = messages.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
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

module.exports = GroqProvider;
