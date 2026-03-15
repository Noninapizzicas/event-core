/**
 * Context Manager
 *
 * Gestiona contexto/memoria para agentes IA
 */
class ContextManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    // Context storage: Map<agentId, context>
    this.contexts = new Map();

    // Cleanup interval
    this.cleanupInterval = null;
  }

  /**
   * Initialize context manager
   */
  async initialize() {
    // Start cleanup task for expired contexts
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000); // Every minute

    this.logger.info('context-manager.initialized', {
      max_messages: this.config.max_messages_per_agent,
      ttl_minutes: this.config.ttl_minutes
    });
  }

  /**
   * Shutdown context manager
   */
  async shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.logger.info('context-manager.shutdown', {
      total_contexts: this.contexts.size
    });
  }

  /**
   * Get context for agent
   */
  async getContext(agentId) {
    if (!this.contexts.has(agentId)) {
      this.contexts.set(agentId, {
        agent_id: agentId,
        messages: [],
        metadata: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }

    return this.contexts.get(agentId);
  }

  /**
   * Add message to context
   */
  async addMessage(agentId, message) {
    const context = await this.getContext(agentId);

    // Add message
    context.messages.push({
      ...message,
      timestamp: message.timestamp || new Date().toISOString()
    });

    // Trim to max messages
    const maxMessages = this.config.max_messages_per_agent || 100;
    if (context.messages.length > maxMessages) {
      context.messages = context.messages.slice(-maxMessages);
    }

    context.updated_at = new Date().toISOString();

    this.logger.debug('context-manager.message.added', {
      agent_id: agentId,
      message_count: context.messages.length
    });
  }

  /**
   * Update context metadata
   */
  async updateMetadata(agentId, metadata) {
    const context = await this.getContext(agentId);

    context.metadata = {
      ...context.metadata,
      ...metadata
    };

    context.updated_at = new Date().toISOString();
  }

  /**
   * Clear context for agent
   */
  async clearContext(agentId) {
    if (this.contexts.has(agentId)) {
      this.contexts.delete(agentId);

      this.logger.info('context-manager.context.cleared', {
        agent_id: agentId
      });
    }
  }

  /**
   * Get context summary
   */
  async getContextSummary(agentId) {
    const context = await this.getContext(agentId);

    return {
      agent_id: agentId,
      message_count: context.messages.length,
      first_message: context.messages[0]?.timestamp || null,
      last_message: context.messages[context.messages.length - 1]?.timestamp || null,
      created_at: context.created_at,
      updated_at: context.updated_at
    };
  }

  /**
   * Cleanup expired contexts
   */
  cleanup() {
    const now = Date.now();
    const ttlMs = (this.config.ttl_minutes || 1440) * 60 * 1000;

    let cleaned = 0;

    for (const [agentId, context] of this.contexts.entries()) {
      const updatedAt = new Date(context.updated_at).getTime();
      const age = now - updatedAt;

      if (age > ttlMs) {
        this.contexts.delete(agentId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.info('context-manager.cleanup', {
        cleaned,
        remaining: this.contexts.size
      });
    }
  }

  /**
   * Get all contexts (for debugging)
   */
  getAllContexts() {
    return Array.from(this.contexts.entries()).map(([agentId, context]) => ({
      agent_id: agentId,
      message_count: context.messages.length,
      updated_at: context.updated_at
    }));
  }
}

module.exports = ContextManager;
