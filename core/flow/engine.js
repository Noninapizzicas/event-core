/**
 * Flow Engine
 *
 * Motor genérico de ejecución de flows. No sabe nada de facturas,
 * OCR ni Telegram. Solo ejecuta nodos de un flow en orden.
 *
 * Cada nodo puede ser:
 *   - capability: se resuelve via Registry y se llama via services.call
 *   - fn: función JavaScript directa
 *
 * El motor:
 *   - Lee definiciones de flow (JSON)
 *   - Ejecuta nodo a nodo, pasando output → input
 *   - Guarda estado completo de cada paso
 *   - Emite eventos genéricos de progreso
 *   - En error, consulta al agente IA (si está disponible)
 *
 * Eventos emitidos (genéricos, el motor no sabe de Telegram):
 *   flow.node.start    → { flowId, nodeId, input }
 *   flow.node.complete → { flowId, nodeId, output, durationMs }
 *   flow.node.error    → { flowId, nodeId, error, durationMs }
 *   flow.complete      → { flowId, state }
 *   flow.error         → { flowId, nodeId, error, state }
 *
 * Uso:
 *   const engine = new FlowEngine({ services, eventBus, registry, agent, logger });
 *   engine.loadFlows('./flows');
 *
 *   // Ejecutar flow completo
 *   const state = await engine.run('factura', { filePath: '...' });
 *
 *   // Ejecutar un solo nodo (testing)
 *   const result = await engine.runNode('factura', 'ocr', { filePath: '...' });
 *
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

class FlowEngine {
  /**
   * @param {object} deps
   * @param {object} deps.services - ServiceExecutor (services.call)
   * @param {object} deps.eventBus - EventBus (emit)
   * @param {object} deps.registry - Registry de capabilities
   * @param {object} [deps.agent] - FlowAgent (opcional)
   * @param {object} [deps.logger] - Logger
   */
  constructor({ services, eventBus, registry, agent, logger }) {
    this.services = services;
    this.eventBus = eventBus;
    this.registry = registry;
    this.agent = agent || null;
    this.logger = logger || console;
    this.flows = new Map();
    this.functions = new Map();
  }

  /**
   * Carga flows desde un directorio (*.json)
   * @param {string} dir - Directorio con archivos .json
   */
  loadFlows(dir) {
    const absDir = path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
    if (!fs.existsSync(absDir)) return;

    const files = fs.readdirSync(absDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const flow = JSON.parse(fs.readFileSync(path.join(absDir, file), 'utf-8'));
      if (flow.id) {
        this.flows.set(flow.id, flow);
        this.logger.info?.('flow-engine.loaded', { flowId: flow.id, nodes: flow.nodes?.length });
      }
    }
  }

  /**
   * Carga un flow desde objeto directo
   * @param {object} flow - Definición del flow
   */
  loadFlow(flow) {
    if (flow.id) {
      this.flows.set(flow.id, flow);
    }
  }

  /**
   * Registra una función reutilizable por nombre
   * Los nodos con "fn" la referencian por este nombre
   * @param {string} name
   * @param {function} fn - async (input, context) => output
   */
  registerFunction(name, fn) {
    this.functions.set(name, fn);
  }

  /**
   * Ejecuta un flow completo
   * @param {string} flowId - ID del flow
   * @param {object} input - Datos de entrada
   * @param {object} [options]
   * @param {object} [options.context] - Contexto adicional (config, projectId, etc)
   * @param {number} [options.timeout] - Timeout por nodo en ms (default: 120000)
   * @returns {Promise<object>} Estado final del flow
   */
  async run(flowId, input, options = {}) {
    const flow = this.flows.get(flowId);
    if (!flow) {
      throw new Error(`Flow no encontrado: ${flowId}`);
    }

    const { context = {}, timeout = 120000 } = options;
    const runId = `${flowId}-${Date.now()}`;

    const state = {
      runId,
      flowId,
      input,
      steps: {},
      current: null,
      status: 'running',
      startedAt: Date.now()
    };

    // Resolver orden de ejecución
    const order = this._resolveOrder(flow);

    for (const nodeId of order) {
      const node = flow.nodes.find(n => n.id === nodeId);
      if (!node) continue;

      state.current = nodeId;

      // Construir input del nodo
      const nodeInput = this._buildNodeInput(node, state);
      const startTime = Date.now();

      this._emit('flow.node.start', {
        runId, flowId, nodeId,
        input: nodeInput,
        context
      });

      try {
        const output = await this._executeNode(node, nodeInput, {
          ...context,
          state,
          timeout
        });

        const durationMs = Date.now() - startTime;

        state.steps[nodeId] = {
          status: 'complete',
          output,
          durationMs
        };

        this._emit('flow.node.complete', {
          runId, flowId, nodeId,
          output,
          durationMs,
          context
        });

        // Consultar agente (si existe) para inspección post-nodo
        if (this.agent) {
          const decision = await this._consultAgent('evaluate', state, node, output);
          if (decision && decision.action === 'abort') {
            state.status = 'aborted';
            state.abortReason = decision.reason;
            break;
          }
        }

      } catch (error) {
        const durationMs = Date.now() - startTime;
        const errorMsg = error.message || String(error);

        state.steps[nodeId] = {
          status: 'error',
          error: errorMsg,
          durationMs
        };

        this._emit('flow.node.error', {
          runId, flowId, nodeId,
          error: errorMsg,
          durationMs,
          context
        });

        // Consultar agente para decidir qué hacer
        const decision = await this._handleError(state, node, error, context, timeout);

        if (decision === 'abort') {
          state.status = 'error';
          this._emit('flow.error', {
            runId, flowId, nodeId,
            error: errorMsg,
            state,
            context
          });
          return state;
        }
        // Si decision es 'continue', sigue al siguiente nodo
        // Si decision es 'retry-ok', el step ya se actualizó
      }
    }

    if (state.status === 'running') {
      state.status = 'complete';
    }
    state.finishedAt = Date.now();
    state.totalDurationMs = state.finishedAt - state.startedAt;

    this._emit('flow.complete', {
      runId, flowId,
      state,
      context
    });

    return state;
  }

  /**
   * Ejecuta un solo nodo de un flow (para testing paso a paso)
   * @param {string} flowId
   * @param {string} nodeId
   * @param {object} input - Input directo para el nodo
   * @param {object} [options]
   * @returns {Promise<object>} Output del nodo
   */
  async runNode(flowId, nodeId, input, options = {}) {
    const flow = this.flows.get(flowId);
    if (!flow) throw new Error(`Flow no encontrado: ${flowId}`);

    const node = flow.nodes.find(n => n.id === nodeId);
    if (!node) throw new Error(`Nodo no encontrado: ${nodeId} en flow ${flowId}`);

    const { context = {}, timeout = 120000 } = options;
    return this._executeNode(node, input, { ...context, timeout });
  }

  /**
   * Lista flows cargados
   * @returns {object[]}
   */
  listFlows() {
    const result = [];
    for (const [id, flow] of this.flows) {
      result.push({
        id,
        description: flow.description,
        nodes: flow.nodes.map(n => n.id)
      });
    }
    return result;
  }

  // ============================================
  // Internos
  // ============================================

  /**
   * Ejecuta un nodo individual
   */
  async _executeNode(node, input, context) {
    const timeout = context.timeout || 120000;

    // Nodo tipo capability (llama a provider via registry)
    if (node.capability) {
      const { provider, action, defaults } = this.registry.resolve(node.capability);
      const params = { ...defaults, ...input, ...(node.params || {}) };

      const result = await this.services.call(provider, action, params, { timeout });
      return result.data || result;
    }

    // Nodo tipo fn (función registrada)
    if (node.fn) {
      const fn = this.functions.get(node.fn);
      if (!fn) {
        throw new Error(`Función no registrada: ${node.fn}`);
      }
      return await fn(input, context);
    }

    throw new Error(`Nodo ${node.id} no tiene capability ni fn definido`);
  }

  /**
   * Construye el input de un nodo a partir del estado del flow.
   * Si el nodo tiene "inputFrom", usa el output de ese nodo.
   * Si no, usa el output del nodo anterior, o el input inicial.
   */
  _buildNodeInput(node, state) {
    // Input explícito desde otro nodo
    if (node.inputFrom) {
      const source = state.steps[node.inputFrom];
      if (source && source.output) {
        return { ...state.input, ...source.output };
      }
    }

    // Mapeo de campos (transforma output del paso anterior al input de este)
    const prevSteps = Object.entries(state.steps).filter(([, s]) => s.status === 'complete');
    const lastStep = prevSteps.length > 0 ? prevSteps[prevSteps.length - 1] : null;
    const prevOutput = lastStep ? lastStep[1].output : {};

    const base = { ...state.input, ...prevOutput };

    // Aplicar mapeo si existe
    if (node.map) {
      const mapped = {};
      for (const [target, source] of Object.entries(node.map)) {
        mapped[target] = this._resolveValue(source, base);
      }
      return { ...base, ...mapped };
    }

    return base;
  }

  /**
   * Resuelve un valor desde el estado. Soporta dot notation.
   * "output.text" → base.output.text
   */
  _resolveValue(path, obj) {
    if (typeof path !== 'string') return path;
    return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : null), obj);
  }

  /**
   * Resuelve el orden de ejecución de nodos.
   * Sigue la cadena "next", o usa el orden del array si no hay "next".
   */
  _resolveOrder(flow) {
    const nodes = flow.nodes;
    if (!nodes || nodes.length === 0) return [];

    // Si el primer nodo tiene "next", seguir la cadena
    if (nodes[0].next) {
      const order = [];
      const visited = new Set();
      let current = nodes[0].id;

      while (current && !visited.has(current)) {
        visited.add(current);
        order.push(current);
        const node = nodes.find(n => n.id === current);
        if (!node) break;
        // Si next es array, tomar el primero (branch default)
        current = Array.isArray(node.next) ? node.next[0] : node.next;
      }
      return order;
    }

    // Fallback: orden del array
    return nodes.map(n => n.id);
  }

  /**
   * Maneja error de un nodo. Consulta al agente si existe.
   * @returns {'abort'|'continue'|'retry-ok'}
   */
  async _handleError(state, node, error, context, timeout) {
    // Si hay agente, consultar
    if (this.agent) {
      const decision = await this._consultAgent('handleError', state, node, error);

      if (decision) {
        // Reintentar con otro provider
        if (decision.action === 'switch' && decision.provider) {
          this.logger.info?.('flow-engine.agent-switch', {
            nodeId: node.id,
            newProvider: decision.provider
          });
          this.registry.switch(node.capability, decision.provider);

          try {
            const input = this._buildNodeInput(node, state);
            const output = await this._executeNode(node, input, { ...context, timeout });
            state.steps[node.id] = { status: 'complete', output, retriedWith: decision.provider };
            this.registry.reset(node.capability);
            return 'retry-ok';
          } catch (retryError) {
            this.registry.reset(node.capability);
            this.logger.error?.('flow-engine.retry-failed', {
              nodeId: node.id, error: retryError.message
            });
          }
        }

        // Reintentar mismo provider
        if (decision.action === 'retry') {
          try {
            const input = this._buildNodeInput(node, state);
            const output = await this._executeNode(node, input, { ...context, timeout });
            state.steps[node.id] = { status: 'complete', output, retried: true };
            return 'retry-ok';
          } catch (retryError) {
            this.logger.error?.('flow-engine.retry-failed', {
              nodeId: node.id, error: retryError.message
            });
          }
        }

        // Continuar al siguiente nodo ignorando error
        if (decision.action === 'skip') {
          this.logger.info?.('flow-engine.agent-skip', { nodeId: node.id });
          return 'continue';
        }
      }
    }

    // Sin agente o agente no supo decidir: abortar
    return 'abort';
  }

  /**
   * Consulta al agente de forma segura (no falla si el agente falla)
   */
  async _consultAgent(method, ...args) {
    if (!this.agent || typeof this.agent[method] !== 'function') return null;
    try {
      return await this.agent[method](...args);
    } catch (e) {
      this.logger.warn?.('flow-engine.agent-error', { method, error: e.message });
      return null;
    }
  }

  /**
   * Emite evento de forma segura
   */
  _emit(topic, data) {
    try {
      this.eventBus.publish(topic, data);
    } catch (e) {
      this.logger.warn?.('flow-engine.emit-error', { topic, error: e.message });
    }
  }
}

module.exports = FlowEngine;
