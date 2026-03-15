/**
 * Flow Agent
 *
 * Agente IA que asiste al Flow Engine en decisiones.
 * No sabe nada de flows concretos. Recibe contexto y decide.
 *
 * Capacidades:
 *   - evaluate: inspeccionar resultado de un nodo y decidir si continuar
 *   - handleError: ante un error, decidir: retry, switch provider, skip, abort
 *
 * El agente usa un LLM (configurable via provider) para tomar decisiones.
 * Si no hay LLM disponible, usa reglas básicas (fallback sin IA).
 *
 * Decisiones posibles:
 *   { action: 'continue' }                    → seguir al siguiente nodo
 *   { action: 'abort', reason: '...' }        → parar el flow
 *   { action: 'retry' }                       → reintentar mismo provider
 *   { action: 'switch', provider: '...' }     → reintentar con otro provider
 *   { action: 'skip' }                        → saltar nodo y continuar
 *
 * Uso:
 *   const agent = new FlowAgent({ registry, llmCall, logger });
 *   const decision = await agent.handleError(state, node, error);
 *
 * @version 1.0.0
 */

const https = require('https');

class FlowAgent {
  /**
   * @param {object} deps
   * @param {object} deps.registry - Registry de capabilities
   * @param {object} [deps.llm] - Configuración LLM
   * @param {string} [deps.llm.provider] - 'deepseek' | 'openai'
   * @param {string} [deps.llm.apiKey] - API key (o se lee de env)
   * @param {object} [deps.logger]
   */
  constructor({ registry, llm, logger }) {
    this.registry = registry;
    this.llm = llm || {};
    this.logger = logger || console;

    this.providers = {
      deepseek: {
        hostname: 'api.deepseek.com',
        path: '/chat/completions',
        model: 'deepseek-chat',
        envKey: 'DEEPSEEK_API_KEY'
      },
      openai: {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        model: 'gpt-4o-mini',
        envKey: 'OPENAI_API_KEY'
      }
    };
  }

  /**
   * Evalúa el resultado de un nodo (post-ejecución).
   * Decide si el flow debe continuar o abortar.
   *
   * @param {object} state - Estado del flow
   * @param {object} node - Nodo actual
   * @param {object} output - Output del nodo
   * @returns {Promise<object>} Decisión
   */
  async evaluate(state, node, output) {
    // Reglas básicas sin LLM
    if (!this._hasLLM()) {
      return this._evaluateBasic(state, node, output);
    }

    const prompt = this._buildEvaluatePrompt(state, node, output);
    return this._askLLM(prompt);
  }

  /**
   * Decide qué hacer ante un error en un nodo.
   *
   * @param {object} state - Estado del flow
   * @param {object} node - Nodo que falló
   * @param {Error} error - Error ocurrido
   * @returns {Promise<object>} Decisión
   */
  async handleError(state, node, error) {
    // Reglas básicas sin LLM
    if (!this._hasLLM()) {
      return this._handleErrorBasic(state, node, error);
    }

    const prompt = this._buildErrorPrompt(state, node, error);
    return this._askLLM(prompt);
  }

  // ============================================
  // Reglas básicas (fallback sin LLM)
  // ============================================

  _evaluateBasic(state, node, output) {
    // Si el output indica fallo explícito
    if (output && output.success === false) {
      return { action: 'abort', reason: output.error || 'Nodo reportó fallo' };
    }
    return { action: 'continue' };
  }

  _handleErrorBasic(state, node, error) {
    const errorMsg = error.message || String(error);

    // Timeout → reintentar una vez
    if (errorMsg.includes('Timeout') || errorMsg.includes('timeout')) {
      const step = state.steps[node.id];
      if (!step?.retried) {
        return { action: 'retry' };
      }
    }

    // Si hay providers alternativos, probar el primero
    if (node.capability) {
      const alts = this.registry.alternatives(node.capability);
      if (alts.length > 0) {
        const current = this.registry.resolve(node.capability).provider;
        const next = alts.find(a => a !== current);
        if (next) {
          return { action: 'switch', provider: next };
        }
      }
    }

    // Sin alternativas → abortar
    return { action: 'abort', reason: errorMsg };
  }

  // ============================================
  // Lógica LLM
  // ============================================

  _hasLLM() {
    const providerName = this.llm.provider || 'deepseek';
    const config = this.providers[providerName];
    if (!config) return false;
    const key = this.llm.apiKey || process.env[config.envKey];
    return !!key;
  }

  _buildEvaluatePrompt(state, node, output) {
    const capabilities = this.registry.list();

    return [
      'Eres un agente que supervisa la ejecución de un flow de procesamiento.',
      'Analiza el resultado del último nodo y decide si el flow debe continuar.',
      '',
      'ESTADO DEL FLOW:',
      JSON.stringify({
        flowId: state.flowId,
        currentNode: node.id,
        completedSteps: Object.keys(state.steps),
        nodeOutput: this._summarize(output)
      }, null, 2),
      '',
      'RESPONDE SOLO con un JSON (sin markdown):',
      '{ "action": "continue" }  → todo bien, seguir',
      '{ "action": "abort", "reason": "..." }  → parar el flow',
      '',
      'Evalúa: ¿el output tiene sentido? ¿hay datos vacíos o sospechosos?'
    ].join('\n');
  }

  _buildErrorPrompt(state, node, error) {
    const alternatives = node.capability ? this.registry.alternatives(node.capability) : [];
    const current = node.capability ? this.registry.resolve(node.capability) : null;

    return [
      'Eres un agente que supervisa la ejecución de un flow de procesamiento.',
      'Un nodo ha fallado. Decide qué hacer.',
      '',
      'NODO QUE FALLÓ:',
      JSON.stringify({
        nodeId: node.id,
        capability: node.capability || null,
        currentProvider: current?.provider || null,
        error: error.message || String(error)
      }, null, 2),
      '',
      'ALTERNATIVAS DISPONIBLES:',
      alternatives.length > 0 ? JSON.stringify(alternatives) : 'Ninguna',
      '',
      'PASOS COMPLETADOS:',
      JSON.stringify(Object.keys(state.steps)),
      '',
      'RESPONDE SOLO con un JSON (sin markdown):',
      '{ "action": "retry" }  → reintentar mismo provider',
      '{ "action": "switch", "provider": "nombre" }  → cambiar provider',
      '{ "action": "skip" }  → saltar y continuar',
      '{ "action": "abort", "reason": "..." }  → parar todo',
      '',
      'Decide basándote en el tipo de error y las alternativas disponibles.'
    ].join('\n');
  }

  /**
   * Llama al LLM y parsea la decisión
   */
  async _askLLM(prompt) {
    try {
      const providerName = this.llm.provider || 'deepseek';
      const config = this.providers[providerName];
      const apiKey = this.llm.apiKey || process.env[config.envKey];

      const response = await this._callHTTP(prompt, apiKey, config);
      const content = response.choices?.[0]?.message?.content || '';

      // Parsear JSON de la respuesta
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const decision = JSON.parse(jsonMatch[0]);
        this.logger.info?.('flow-agent.decision', { decision });
        return decision;
      }

      this.logger.warn?.('flow-agent.no-json', { content: content.substring(0, 200) });
      return null;

    } catch (e) {
      this.logger.warn?.('flow-agent.llm-error', { error: e.message });
      return null;
    }
  }

  /**
   * Llamada HTTP al LLM
   */
  _callHTTP(prompt, apiKey, config) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 200
      });

      const options = {
        hostname: config.hostname,
        port: 443,
        path: config.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 30000
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(`LLM ${res.statusCode}: ${parsed.error?.message || data.substring(0, 200)}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error(`Parse error: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('LLM timeout')); });
      req.write(body);
      req.end();
    });
  }

  /**
   * Resume un objeto para no enviar demasiado al LLM
   */
  _summarize(obj) {
    if (!obj) return null;
    const str = JSON.stringify(obj);
    if (str.length < 500) return obj;

    // Resumir campos largos
    const summary = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v.length > 200) {
        summary[k] = v.substring(0, 200) + `... (${v.length} chars)`;
      } else {
        summary[k] = v;
      }
    }
    return summary;
  }
}

module.exports = FlowAgent;
