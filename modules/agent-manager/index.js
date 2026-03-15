/**
 * Agent Manager Module
 *
 * Orquestación de agentes. Decide qué agente usar, construye contexto, gestiona pipelines.
 * NO ejecuta agentes directamente - publica agent.execute.request para ai-agent-framework.
 *
 * Escucha: bot.* (de bot-manager), agent.*.completed/failed (de ai-agent-framework)
 * Publica: agent.execute.request, pipeline.*
 */

const TriggerRegistry = require('./services/trigger-registry');
const ContextBuilder = require('./services/context-builder');
const PipelineExecutor = require('./services/pipeline-executor');

class AgentManagerModule {
  constructor() {
    this.name = 'agent-manager';
    this.version = '1.0.0';

    // Dependencies
    this.logger = null;
    this.eventBus = null;
    this.config = null;

    // Services
    this.triggerRegistry = null;
    this.contextBuilder = null;
    this.pipelineExecutor = null;

    // Wildcard subscriptions (managed manually; static subs are auto-wired)
    this.wildcardUnsubscribes = [];
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(context) {
    this.logger = context.logger;
    this.eventBus = context.eventBus;

    // Load config from loader-injected moduleConfig
    this.config = context.moduleConfig || {};

    this.logger.info('agent-manager.loading', {
      version: this.version
    });

    // Initialize services
    this.triggerRegistry = new TriggerRegistry(this.config, this.logger);
    await this.triggerRegistry.initialize();

    this.contextBuilder = new ContextBuilder(this.logger);
    this.pipelineExecutor = new PipelineExecutor(this.config, this.logger, this.eventBus);

    // Subscribe to wildcard events (static events are auto-wired via module.json)
    await this.subscribeToWildcardEvents();

    this.logger.info('agent-manager.loaded', {
      version: this.version,
      triggers_count: this.triggerRegistry.getAll().length
    });
  }

  async onUnload() {
    this.logger.info('agent-manager.unloading');

    // Unsubscribe wildcard events (static events are managed by the loader)
    for (const unsub of this.wildcardUnsubscribes) {
      if (typeof unsub === 'function') {
        await unsub();
      }
    }
    this.wildcardUnsubscribes = [];

    this.logger.info('agent-manager.unloaded');
  }

  // ==========================================
  // Event Subscriptions
  // ==========================================

  async subscribeToWildcardEvents() {
    // Wildcard subscriptions cannot be auto-wired from module.json — keep imperative
    const unsubCompleted = await this.eventBus.subscribe(
      'agent.*.completed',
      this.onAgentCompleted.bind(this)
    );
    this.wildcardUnsubscribes.push(unsubCompleted);

    const unsubFailed = await this.eventBus.subscribe(
      'agent.*.failed',
      this.onAgentFailed.bind(this)
    );
    this.wildcardUnsubscribes.push(unsubFailed);

    this.logger.info('agent-manager.wildcard-subscribed', {
      events: ['agent.*.completed', 'agent.*.failed']
    });
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  /**
   * Handler for bot.file.stored (auto-wired from module.json)
   */
  async onBotFileStored(event) {
    return this.onBotEvent('bot.file.stored', event);
  }

  /**
   * Handler for bot.message.received (auto-wired from module.json)
   */
  async onBotMessageReceived(event) {
    return this.onBotEvent('bot.message.received', event);
  }

  /**
   * Handler for bot.command.received (auto-wired from module.json)
   */
  async onBotCommandReceived(event) {
    return this.onBotEvent('bot.command.received', event);
  }

  /**
   * Maneja eventos de bot-manager (bot.file.stored, bot.message.received, etc.)
   */
  async onBotEvent(eventType, event) {
    const data = event?.data || event?.payload || event;

    this.logger.debug('agent-manager.event.received', {
      eventType,
      botName: data.botName
    });

    // Buscar triggers que coincidan
    const matchingTriggers = this.triggerRegistry.findMatching(eventType, data);

    if (matchingTriggers.length === 0) {
      this.logger.debug('agent-manager.no-matching-triggers', {
        eventType,
        botName: data.botName
      });
      return;
    }

    this.logger.info('agent-manager.triggers.matched', {
      eventType,
      count: matchingTriggers.length
    });

    // Ejecutar cada trigger
    for (const trigger of matchingTriggers) {
      await this.executeTrigger(trigger, eventType, data);
    }
  }

  /**
   * Ejecuta un trigger (invoca agente o inicia pipeline)
   */
  async executeTrigger(trigger, eventType, eventData) {
    // Construir contexto
    const context = this.contextBuilder.build(
      trigger.contextTemplate,
      eventData,
      { eventType }
    );

    // Construir tarea
    const task = this.contextBuilder.buildTask(trigger, eventData, context);
    context.task = task;

    // ¿Es pipeline o agente único?
    if (trigger.pipeline && trigger.pipeline.length > 0) {
      // Pipeline multi-agente
      await this.pipelineExecutor.start({
        agents: trigger.pipeline,
        trigger,
        eventData,
        context
      });
    } else if (trigger.agent) {
      // Agente único
      await this.invokeAgent(trigger.agent, context, task);
    } else {
      this.logger.warn('agent-manager.trigger.no-target', {
        triggerId: trigger.id
      });
    }
  }

  /**
   * Invoca un agente único
   */
  async invokeAgent(agentName, context, task) {
    this.logger.info('agent-manager.invoking-agent', {
      agentName,
      botName: context.source?.botName
    });

    await this.eventBus.publish('agent.execute.request', {
      agentName,
      context,
      task
    });
  }

  /**
   * Maneja agent.*.completed
   */
  async onAgentCompleted(event) {
    const data = event?.data || event?.payload || event;
    const { agent_name, agentName, result, pipelineId } = data;
    const name = agent_name || agentName;

    this.logger.debug('agent-manager.agent.completed', {
      agentName: name,
      pipelineId
    });

    // Si es parte de un pipeline, continuar
    if (pipelineId) {
      await this.pipelineExecutor.handleAgentCompleted(name, result, pipelineId);
    }
  }

  /**
   * Maneja agent.*.failed
   */
  async onAgentFailed(event) {
    const data = event?.data || event?.payload || event;
    const { agent_name, agentName, error, pipelineId } = data;
    const name = agent_name || agentName;

    this.logger.error('agent-manager.agent.failed', {
      agentName: name,
      error,
      pipelineId
    });

    // Si es parte de un pipeline, manejarlo
    if (pipelineId) {
      await this.pipelineExecutor.handleAgentFailed(name, error, pipelineId);
    }
  }

  // ==========================================
  // API Methods (para uso via Claude/eventos)
  // ==========================================

  /**
   * Añade un nuevo trigger
   */
  async addTrigger(config) {
    return await this.triggerRegistry.add(config);
  }

  /**
   * Elimina un trigger
   */
  async removeTrigger(triggerId) {
    return await this.triggerRegistry.remove(triggerId);
  }

  /**
   * Actualiza un trigger
   */
  async updateTrigger(triggerId, updates) {
    return await this.triggerRegistry.update(triggerId, updates);
  }

  /**
   * Lista todos los triggers
   */
  listTriggers() {
    return this.triggerRegistry.getAll();
  }

  /**
   * Obtiene un trigger por ID
   */
  getTrigger(triggerId) {
    return this.triggerRegistry.get(triggerId);
  }

  /**
   * Lista pipelines activos
   */
  listActivePipelines() {
    return this.pipelineExecutor.listActive();
  }

  /**
   * Obtiene estado de un pipeline
   */
  getPipelineState(pipelineId) {
    return this.pipelineExecutor.getState(pipelineId);
  }

  /**
   * Cancela un pipeline
   */
  async cancelPipeline(pipelineId) {
    return await this.pipelineExecutor.cancel(pipelineId);
  }

  /**
   * Ejecuta un agente manualmente (para pruebas)
   */
  async testAgent(agentName, testContext = {}) {
    const context = {
      source: {
        event: 'manual.test',
        botName: testContext.botName || 'test',
        chatId: testContext.chatId || 0,
        timestamp: new Date().toISOString()
      },
      reply: {
        via: 'test',
        botName: testContext.botName || 'test',
        chatId: testContext.chatId || 0
      },
      ...testContext
    };

    const task = testContext.task || `Prueba manual del agente ${agentName}`;

    await this.invokeAgent(agentName, context, task);

    return { success: true, message: `Agent ${agentName} invoked` };
  }
}

module.exports = AgentManagerModule;
