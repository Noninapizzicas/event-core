const BaseProvider = require('./base-provider');

/**
 * Ollama Provider
 *
 * Implementación del proveedor Ollama (local) (http://localhost:11434)
 * Priority: 4
 * Cost: $0 (local)
 */
class OllamaProvider extends BaseProvider {
  constructor(config, logger, credentialResolver) {
    super(config, logger, credentialResolver);
    this.name = 'ollama';
  }

  /**
   * Initialize
   */
  async initialize() {
    // Ollama doesn't need API key (local)
    this.apiKey = 'local';

    // Check if Ollama is running
    try {
      await this.makeRequest('GET', '/api/tags');
      this.logger.info('ollama.initialized', {
        available: true,
        models: this.config.models
      });
    } catch (error) {
      this.logger.warn('ollama.not-running', {
        message: 'Ollama not available (is it running locally?)',
        error: error.message
      });
      this.apiKey = null;
    }
  }

  /**
   * Chat completion
   */
  async chatCompletion(messages, options = {}) {
    if (!await this.isAvailable()) {
      throw new Error('Ollama provider not available (is Ollama running locally?)');
    }

    const model = options.model || this.config.default_model;

    // Estimate tokens
    const messagesText = messages.map(m => m.content).join(' ');
    const estimatedTokens = this.countTokens(messagesText);

    // Check rate limit (Ollama is more permissive)
    const rateLimitCheck = this.checkRateLimit(estimatedTokens);
    if (!rateLimitCheck.allowed) {
      throw new Error(`Rate limit exceeded: ${rateLimitCheck.reason}`);
    }

    // Build Ollama-specific request
    const requestData = {
      model,
      messages,
      stream: false,
      options: {
        temperature: options.temperature || 0.7,
        top_p: options.top_p || 1,
        num_predict: options.max_tokens || 2000
      }
    };

    // Make request with retry
    const response = await this.withRetry(
      () => this.makeRequest('POST', '/api/chat', requestData),
      options.retryConfig || {}
    );

    // Extract response
    const content = response.message?.content || '';
    const outputTokens = this.countTokens(content);
    const totalTokens = estimatedTokens + outputTokens;

    // Record usage
    this.recordUsage(totalTokens);

    // Ollama has no cost (local)
    const cost = 0;

    return {
      provider: this.name,
      model,
      content,
      usage: {
        input_tokens: estimatedTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens
      },
      cost,
      finish_reason: response.done ? 'stop' : 'length'
    };
  }

  /**
   * Chat completion (streaming)
   */
  async chatCompletionStream(messages, options = {}) {
    if (!await this.isAvailable()) {
      throw new Error('Ollama provider not available (is Ollama running locally?)');
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

    // Build Ollama-specific request
    const requestData = {
      model,
      messages,
      stream: true,
      options: {
        temperature: options.temperature || 0.7,
        top_p: options.top_p || 1,
        num_predict: options.max_tokens || 2000
      }
    };

    return new Promise((resolve, reject) => {
      let buffer = '';
      let fullContent = '';

      this.makeStreamRequest(
        'POST',
        '/api/chat',
        requestData,
        {},
        (chunk) => {
          buffer += chunk.toString();

          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (line.trim()) {
              try {
                const parsed = JSON.parse(line);
                const delta = parsed.message?.content || '';

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

          resolve({
            provider: this.name,
            model,
            content: fullContent,
            usage: {
              input_tokens: estimatedTokens,
              output_tokens: outputTokens,
              total_tokens: totalTokens
            },
            cost: 0,
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

module.exports = OllamaProvider;
