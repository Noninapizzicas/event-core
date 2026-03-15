/**
 * Pipeline Executor
 * Orquesta secuencias de agentes (agente1 → agente2 → agente3)
 */

class PipelineExecutor {
  constructor(config, logger, eventBus) {
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
    this.activePipelines = new Map(); // pipelineId -> pipelineState
    this.timeout = config.pipelineTimeout || 300000; // 5 min default
  }

  /**
   * Inicia un nuevo pipeline
   */
  async start(pipelineConfig) {
    const {
      agents,           // Array de nombres de agentes
      trigger,          // Trigger que lo activó
      eventData,        // Datos del evento original
      context           // Contexto construido
    } = pipelineConfig;

    const pipelineId = `pipeline_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const state = {
      id: pipelineId,
      agents,
      currentStep: 0,
      totalSteps: agents.length,
      trigger,
      originalEventData: eventData,
      context,
      sharedData: {},      // Datos que se comparten entre agentes
      results: [],         // Resultados de cada paso
      status: 'running',
      startedAt: new Date().toISOString(),
      timeoutId: null
    };

    // Configurar timeout
    state.timeoutId = setTimeout(() => {
      this.handleTimeout(pipelineId);
    }, this.timeout);

    this.activePipelines.set(pipelineId, state);

    this.logger.info('pipeline-executor.started', {
      pipelineId,
      agents,
      totalSteps: agents.length
    });

    // Publicar evento de inicio
    await this.eventBus.publish('pipeline.started', {
      pipelineId,
      agents,
      trigger: trigger.id,
      timestamp: new Date().toISOString()
    });

    // Ejecutar primer paso
    await this.executeStep(pipelineId);

    return pipelineId;
  }

  /**
   * Ejecuta el paso actual del pipeline
   */
  async executeStep(pipelineId) {
    const state = this.activePipelines.get(pipelineId);
    if (!state || state.status !== 'running') return;

    const { agents, currentStep, context, sharedData, originalEventData } = state;
    const agentName = agents[currentStep];

    this.logger.info('pipeline-executor.step.starting', {
      pipelineId,
      step: currentStep + 1,
      totalSteps: agents.length,
      agent: agentName
    });

    // Construir contexto para este paso
    const stepContext = {
      ...context,
      pipeline: {
        id: pipelineId,
        step: currentStep + 1,
        total: agents.length,
        agents,
        isFirst: currentStep === 0,
        isLast: currentStep === agents.length - 1
      },
      previousResults: sharedData
    };

    // Publicar agent.execute.request
    await this.eventBus.publish('agent.execute.request', {
      agentName,
      context: stepContext,
      task: context.task || `Paso ${currentStep + 1} de ${agents.length}`,
      pipelineId
    });
  }

  /**
   * Maneja la completación de un agente
   */
  async handleAgentCompleted(agentName, result, pipelineId) {
    const state = this.activePipelines.get(pipelineId);
    if (!state) {
      // No es parte de un pipeline, ignorar
      return false;
    }

    if (state.status !== 'running') {
      return false;
    }

    const expectedAgent = state.agents[state.currentStep];
    if (agentName !== expectedAgent) {
      this.logger.warn('pipeline-executor.unexpected-agent', {
        pipelineId,
        expected: expectedAgent,
        received: agentName
      });
      return false;
    }

    // Guardar resultado
    state.results.push({
      agent: agentName,
      step: state.currentStep + 1,
      result,
      completedAt: new Date().toISOString()
    });

    // Merge sharedData si el agente devolvió datos para compartir
    if (result?.sharedData) {
      state.sharedData = { ...state.sharedData, ...result.sharedData };
    }

    // También guardar el resultado completo accesible por nombre de agente
    state.sharedData[agentName] = result;

    this.logger.info('pipeline-executor.step.completed', {
      pipelineId,
      step: state.currentStep + 1,
      agent: agentName
    });

    // Publicar evento de paso completado
    await this.eventBus.publish('pipeline.step.completed', {
      pipelineId,
      step: state.currentStep + 1,
      agent: agentName,
      timestamp: new Date().toISOString()
    });

    // ¿Hay más pasos?
    state.currentStep++;

    if (state.currentStep < state.totalSteps) {
      // Ejecutar siguiente paso
      await this.executeStep(pipelineId);
    } else {
      // Pipeline completado
      await this.complete(pipelineId);
    }

    return true;
  }

  /**
   * Maneja el fallo de un agente
   */
  async handleAgentFailed(agentName, error, pipelineId) {
    const state = this.activePipelines.get(pipelineId);
    if (!state || state.status !== 'running') {
      return false;
    }

    this.logger.error('pipeline-executor.step.failed', {
      pipelineId,
      step: state.currentStep + 1,
      agent: agentName,
      error
    });

    await this.fail(pipelineId, `Agent ${agentName} failed: ${error}`);
    return true;
  }

  /**
   * Completa el pipeline exitosamente
   */
  async complete(pipelineId) {
    const state = this.activePipelines.get(pipelineId);
    if (!state) return;

    // Cancelar timeout
    if (state.timeoutId) {
      clearTimeout(state.timeoutId);
    }

    state.status = 'completed';
    state.completedAt = new Date().toISOString();

    this.logger.info('pipeline-executor.completed', {
      pipelineId,
      steps: state.totalSteps,
      duration: Date.now() - new Date(state.startedAt).getTime()
    });

    // Publicar evento
    await this.eventBus.publish('pipeline.completed', {
      pipelineId,
      results: state.results,
      sharedData: state.sharedData,
      timestamp: new Date().toISOString()
    });

    // Limpiar después de un tiempo
    setTimeout(() => {
      this.activePipelines.delete(pipelineId);
    }, 60000);
  }

  /**
   * Falla el pipeline
   */
  async fail(pipelineId, error) {
    const state = this.activePipelines.get(pipelineId);
    if (!state) return;

    // Cancelar timeout
    if (state.timeoutId) {
      clearTimeout(state.timeoutId);
    }

    state.status = 'failed';
    state.error = error;
    state.failedAt = new Date().toISOString();

    this.logger.error('pipeline-executor.failed', {
      pipelineId,
      step: state.currentStep + 1,
      error
    });

    // Publicar evento
    await this.eventBus.publish('pipeline.failed', {
      pipelineId,
      step: state.currentStep + 1,
      error,
      timestamp: new Date().toISOString()
    });

    // Limpiar después de un tiempo
    setTimeout(() => {
      this.activePipelines.delete(pipelineId);
    }, 60000);
  }

  /**
   * Maneja timeout de pipeline
   */
  async handleTimeout(pipelineId) {
    const state = this.activePipelines.get(pipelineId);
    if (!state || state.status !== 'running') return;

    await this.fail(pipelineId, 'Pipeline timeout');
  }

  /**
   * Obtiene estado de un pipeline
   */
  getState(pipelineId) {
    return this.activePipelines.get(pipelineId);
  }

  /**
   * Lista pipelines activos
   */
  listActive() {
    return Array.from(this.activePipelines.values())
      .filter(p => p.status === 'running');
  }

  /**
   * Cancela un pipeline
   */
  async cancel(pipelineId) {
    const state = this.activePipelines.get(pipelineId);
    if (!state || state.status !== 'running') return false;

    await this.fail(pipelineId, 'Cancelled by user');
    return true;
  }
}

module.exports = PipelineExecutor;
