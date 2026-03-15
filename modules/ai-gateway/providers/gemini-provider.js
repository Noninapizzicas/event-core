const BaseProvider = require('./base-provider');

/**
 * Gemini Provider
 *
 * Implementación del proveedor Google Gemini (https://generativelanguage.googleapis.com)
 *
 * Características:
 * - RAG gestionado (File Search) con storage gratuito
 * - Grounding con Google Search
 * - Code Execution server-side
 * - Ventana de contexto hasta 1M tokens
 *
 * Auth: API key como query param (?key=...) o header x-goog-api-key
 * Formato: diferente de OpenAI — usa contents[]/parts[] en vez de messages[]
 */
class GeminiProvider extends BaseProvider {
  constructor(config, logger, credentialResolver) {
    super(config, logger, credentialResolver);
    this.name = 'gemini';
  }

  /**
   * Initialize
   */
  async initialize() {
    await this.refreshApiKey();

    if (!this.apiKey) {
      this.logger.warn('gemini.no-api-key', {
        message: 'No Gemini API key found (checked credential-manager and environment)'
      });
    }

    this.logger.info('gemini.initialized', {
      available: await this.isAvailable(),
      models: this.config.models
    });
  }

  /**
   * Refresh API key from environment
   */
  refreshApiKeyFromEnv() {
    this.apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY_GLOBAL || null;
  }

  /**
   * Convert OpenAI-style messages to Gemini contents format
   * OpenAI: [{ role: 'user'|'assistant'|'system', content: '...' }]
   * Gemini: { system_instruction, contents: [{ role: 'user'|'model', parts: [{ text }] }] }
   */
  convertMessages(messages) {
    let systemInstruction = null;
    const contents = [];

    for (const m of messages) {
      if (m.role === 'system') {
        // Gemini usa system_instruction separado
        systemInstruction = systemInstruction
          ? systemInstruction + '\n' + (typeof m.content === 'string' ? m.content : '')
          : (typeof m.content === 'string' ? m.content : '');
        continue;
      }

      const role = m.role === 'assistant' ? 'model' : 'user';
      const parts = [];

      // Assistant messages with tool_calls: convert to functionCall parts
      if (m.role === 'assistant' && m.tool_calls && Array.isArray(m.tool_calls)) {
        if (m.content) {
          parts.push({ text: m.content });
        }
        for (const tc of m.tool_calls) {
          let args = {};
          if (tc.function?.arguments) {
            try {
              args = typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments;
            } catch { args = {}; }
          }
          parts.push({
            functionCall: {
              name: tc.function?.name || tc.name,
              args
            }
          });
        }
        contents.push({ role, parts });
        continue;
      }

      // Handle image content
      if (m.image_base64) {
        parts.push({
          inline_data: {
            mime_type: m.image_type || 'image/jpeg',
            data: m.image_base64
          }
        });
      }

      // Handle array content
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === 'text') {
            parts.push({ text: part.text });
          } else if (part.type === 'image_url' && part.image_url?.url) {
            // data:mime;base64,data format
            const match = part.image_url.url.match(/^data:(.+?);base64,(.+)$/);
            if (match) {
              parts.push({
                inline_data: {
                  mime_type: match[1],
                  data: match[2]
                }
              });
            }
          }
        }
      } else if (typeof m.content === 'string' && m.content) {
        parts.push({ text: m.content });
      }

      // Handle tool call results (role: 'tool' → functionResponse)
      if (m.role === 'tool' && m.tool_call_id) {
        contents.push({
          role: 'function',
          parts: [{
            functionResponse: {
              name: m.name || m.tool_call_id,
              response: { result: m.content }
            }
          }]
        });
        continue;
      }

      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }

    return { systemInstruction, contents };
  }

  /**
   * Convert tools to Gemini format
   * OpenAI: [{ type: 'function', function: { name, description, parameters } }]
   * Gemini: [{ functionDeclarations: [{ name, description, parameters }] }]
   */
  convertTools(tools) {
    if (!tools || tools.length === 0) return null;

    const functionDeclarations = tools.map(tool => {
      const fn = tool.function || tool;
      return {
        name: fn.name,
        description: fn.description || '',
        parameters: fn.parameters || { type: 'object', properties: {} }
      };
    });

    return [{ functionDeclarations }];
  }

  /**
   * Chat completion
   */
  async chatCompletion(messages, options = {}) {
    if (!await this.isAvailable()) {
      throw new Error('Gemini provider not available (check API key)');
    }

    const model = options.model || this.config.default_model;

    // Convert messages to Gemini format
    const { systemInstruction, contents } = this.convertMessages(messages);

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
      contents,
      generationConfig: {
        temperature: options.temperature || 0.7,
        topP: options.top_p || 1,
        maxOutputTokens: options.max_tokens || 2000
      }
    };

    if (systemInstruction) {
      requestData.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    // Add tools if provided
    const geminiTools = this.convertTools(options.tools);
    if (geminiTools) {
      requestData.tools = geminiTools;
    }

    // Gemini auth via header
    const headers = {
      'x-goog-api-key': this.apiKey
    };

    // Gemini endpoint: /models/{model}:generateContent
    const endpoint = `/models/${model}:generateContent`;

    this.logger.info('gemini.chat.request', {
      model,
      messageCount: contents.length,
      estimatedTokens
    });

    // Make request
    const response = await this.withRetry(
      () => this.makeRequest('POST', endpoint, requestData, headers),
      options.retryConfig || {}
    );

    // Extract response
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    let content = '';
    let toolCalls = null;

    for (const part of parts) {
      if (part.text) {
        content += part.text;
      }
      if (part.functionCall) {
        if (!toolCalls) toolCalls = [];
        toolCalls.push({
          id: `gemini-${Date.now()}-${toolCalls.length}`,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {})
          }
        });
      }
    }

    const inputTokens = response.usageMetadata?.promptTokenCount || estimatedTokens;
    const outputTokens = response.usageMetadata?.candidatesTokenCount || this.countTokens(content);
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
      finish_reason: candidate?.finishReason === 'STOP' ? 'stop' : (candidate?.finishReason || 'stop')
    };
  }

  /**
   * Chat completion (streaming) — Gemini SSE format
   */
  async chatCompletionStream(messages, options = {}) {
    if (!await this.isAvailable()) {
      throw new Error('Gemini provider not available (check API key)');
    }

    const model = options.model || this.config.default_model;

    // Convert messages
    const { systemInstruction, contents } = this.convertMessages(messages);

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
      contents,
      generationConfig: {
        temperature: options.temperature || 0.7,
        topP: options.top_p || 1,
        maxOutputTokens: options.max_tokens || 2000
      }
    };

    if (systemInstruction) {
      requestData.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const headers = {
      'x-goog-api-key': this.apiKey
    };

    // Streaming endpoint: /models/{model}:streamGenerateContent?alt=sse
    const endpoint = `/models/${model}:streamGenerateContent?alt=sse`;

    return new Promise((resolve, reject) => {
      let buffer = '';
      let fullContent = '';

      this.makeStreamRequest(
        'POST',
        endpoint,
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
                const parts = parsed.candidates?.[0]?.content?.parts || [];

                for (const part of parts) {
                  if (part.text) {
                    fullContent += part.text;
                    if (options.onChunk) {
                      options.onChunk(part.text);
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

module.exports = GeminiProvider;
