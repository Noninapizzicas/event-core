const https = require('https');
const http = require('http');

/**
 * Base Provider Abstract Class
 *
 * Todos los proveedores LLM deben extender esta clase
 */
class BaseProvider {
  constructor(config, logger, credentialResolver = null) {
    this.config = config;
    this.logger = logger;
    this.name = 'base';

    // Rate limiting state
    this.requestCount = 0;
    this.tokenCount = 0;
    this.lastResetTime = Date.now();

    // API key management
    this.apiKey = null;
    this.credentialResolver = credentialResolver; // Function to resolve credentials via events

    // Context for credential resolution (can be set per-request)
    this.currentProjectId = null;
    this.currentClientId = null;
  }

  /**
   * Initialize provider (load API keys, etc.)
   */
  async initialize() {
    throw new Error('initialize() must be implemented by subclass');
  }

  /**
   * Check if provider is available
   * Resolves credentials via credential-manager if resolver is available
   */
  async isAvailable() {
    // Try to refresh API key if not set
    if (!this.apiKey) {
      await this.refreshApiKey();
    }
    return this.apiKey !== null && this.config.enabled;
  }

  /**
   * Refresh API key - uses credential resolver if available, falls back to env
   * Override in subclasses to specify the provider name for resolution
   */
  async refreshApiKey() {
    // If we have a credential resolver, use it (event-based resolution)
    if (this.credentialResolver) {
      try {
        this.apiKey = await this.credentialResolver(this.name, {
          projectId: this.currentProjectId,
          clientId: this.currentClientId
        });
        return;
      } catch (error) {
        this.logger.debug(`${this.name}.credential.resolver.failed`, {
          error: error.message,
          fallback: 'environment'
        });
        // Fall through to environment check
      }
    }

    // Fallback: check environment directly (legacy support)
    this.refreshApiKeyFromEnv();
  }

  /**
   * Refresh API key from environment variables
   * Override in subclasses to check specific env vars
   */
  refreshApiKeyFromEnv() {
    // Subclasses should implement this for fallback
  }

  /**
   * Set context for credential resolution (projectId, clientId for cascade)
   */
  setContext({ projectId, clientId } = {}) {
    this.currentProjectId = projectId;
    this.currentClientId = clientId;
  }

  /**
   * Chat completion (synchronous)
   */
  async chatCompletion(messages, options = {}) {
    throw new Error('chatCompletion() must be implemented by subclass');
  }

  /**
   * Chat completion (streaming)
   */
  async chatCompletionStream(messages, options = {}) {
    throw new Error('chatCompletionStream() must be implemented by subclass');
  }

  /**
   * Count tokens (approximate)
   */
  countTokens(text) {
    // Rough approximation: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  /**
   * Calculate cost
   */
  calculateCost(inputTokens, outputTokens) {
    const inputCost = (inputTokens / 1000) * (this.config.cost_per_1k_tokens.input || 0);
    const outputCost = (outputTokens / 1000) * (this.config.cost_per_1k_tokens.output || 0);
    return inputCost + outputCost;
  }

  /**
   * Check rate limit
   */
  checkRateLimit(estimatedTokens) {
    const now = Date.now();
    const elapsedMinutes = (now - this.lastResetTime) / 60000;

    // Reset counters if a minute has passed
    if (elapsedMinutes >= 1) {
      this.requestCount = 0;
      this.tokenCount = 0;
      this.lastResetTime = now;
    }

    // Check limits
    const { requests_per_minute, tokens_per_minute } = this.config.rate_limit;

    if (this.requestCount >= requests_per_minute) {
      return {
        allowed: false,
        reason: 'REQUEST_RATE_LIMIT_EXCEEDED',
        retry_after_ms: Math.max(1000, (1 - elapsedMinutes) * 60000)
      };
    }

    if (this.tokenCount + estimatedTokens > tokens_per_minute) {
      return {
        allowed: false,
        reason: 'TOKEN_RATE_LIMIT_EXCEEDED',
        retry_after_ms: Math.max(1000, (1 - elapsedMinutes) * 60000)
      };
    }

    return { allowed: true };
  }

  /**
   * Check rate limit with automatic wait and retry.
   * Instead of failing immediately, waits for the rate limit window to reset
   * and retries up to maxWaitAttempts times.
   */
  async checkRateLimitWithWait(estimatedTokens, maxWaitAttempts = 2) {
    for (let attempt = 0; attempt <= maxWaitAttempts; attempt++) {
      const check = this.checkRateLimit(estimatedTokens);
      if (check.allowed) return check;

      // Last attempt — don't wait, just fail
      if (attempt === maxWaitAttempts) {
        return check;
      }

      const waitMs = Math.min(check.retry_after_ms, 30000); // Cap at 30s
      this.logger.info(`${this.name}.rate_limit.waiting`, {
        reason: check.reason,
        waitMs,
        attempt: attempt + 1,
        maxAttempts: maxWaitAttempts
      });

      await this.sleep(waitMs);
    }
  }

  /**
   * Record usage
   */
  recordUsage(tokens) {
    this.requestCount++;
    this.tokenCount += tokens;
  }

  /**
   * HTTP request helper
   */
  async makeRequest(method, path, data = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.config.api_base);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const options = {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        }
      };

      const req = httpModule.request(options, (res) => {
        let body = '';

        res.on('data', (chunk) => {
          body += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(body);
              resolve(parsed);
            } catch (error) {
              resolve(body);
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          }
        });
      });

      // Timeout para evitar que el request se cuelgue
      req.setTimeout(90000, () => {
        req.destroy();
        reject(new Error(`HTTP request timeout after 90s to ${url.hostname}${url.pathname}`));
      });

      req.on('error', (error) => {
        reject(error);
      });

      if (data) {
        req.write(JSON.stringify(data));
      }

      req.end();
    });
  }

  /**
   * HTTP streaming request helper
   */
  makeStreamRequest(method, path, data = null, headers = {}, onChunk, onEnd, onError) {
    const url = new URL(path, this.config.api_base);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const options = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        ...headers
      }
    };

    const req = httpModule.request(options, (res) => {
      // Reject non-2xx responses immediately instead of parsing as SSE
      if (res.statusCode >= 400) {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let message;
          try {
            const parsed = JSON.parse(body);
            message = parsed.error?.message || parsed.message || body;
          } catch (_) {
            message = body;
          }
          onError(new Error(`HTTP ${res.statusCode}: ${message}`));
        });
        return;
      }

      res.on('data', (chunk) => {
        onChunk(chunk);
      });

      res.on('end', () => {
        onEnd();
      });

      res.on('error', (error) => {
        onError(error);
      });
    });

    req.on('error', (error) => {
      onError(error);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  }

  /**
   * Retry with exponential backoff
   */
  async withRetry(fn, retryConfig) {
    const config = retryConfig || {};
    const maxAttempts = config.max_attempts || 1;
    const initialDelay = config.initial_delay_ms || 1000;
    const maxDelay = config.max_delay_ms || 10000;
    const multiplier = config.backoff_multiplier || 2;

    let attempt = 0;
    let delay = initialDelay;

    while (attempt < maxAttempts) {
      try {
        return await fn();
      } catch (error) {
        attempt++;

        if (attempt >= maxAttempts) {
          throw error;
        }

        this.logger.warn(`${this.name}.retry`, {
          attempt,
          max_attempts: maxAttempts,
          delay,
          error: error.message
        });

        await this.sleep(delay);
        delay = Math.min(delay * multiplier, maxDelay);
      }
    }
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = BaseProvider;
