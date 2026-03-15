/**
 * Hook Manager - Sistema de hooks para Event Core
 *
 * Permite a los módulos interceptar operaciones del core sin acoplamiento directo.
 * Los módulos pueden:
 * - Modificar el contexto de una operación
 * - Bloquear una operación (retornando null)
 * - Ejecutar lógica antes/después de operaciones del core
 *
 * @example
 * // Registrar un hook
 * core.hooks.register('beforeEventPublish', async (context) => {
 *   console.log('Publishing event:', context.eventType);
 *   return context; // Continuar sin modificar
 * });
 *
 * // Modificar contexto
 * core.hooks.register('beforeEventPublish', async (context) => {
 *   return {
 *     ...context,
 *     data: encrypt(context.data) // Modificar data
 *   };
 * });
 *
 * // Bloquear operación
 * core.hooks.register('beforeEventPublish', async (context) => {
 *   if (context.eventType === 'forbidden') {
 *     return null; // Bloquear
 *   }
 *   return context;
 * });
 */

class HookManager {
  constructor() {
    /**
     * Mapa de hooks registrados
     * @type {Object.<string, Function[]>}
     */
    this.hooks = {};

    /**
     * Estadísticas de ejecución de hooks
     * @type {Object.<string, {executions: number, blocked: number, errors: number}>}
     */
    this.stats = {};
  }

  /**
   * Registra un handler para un hook específico
   *
   * @param {string} hookName - Nombre del hook (ej: 'beforeEventPublish')
   * @param {Function} handler - Función async que recibe contexto y retorna contexto modificado o null
   * @returns {Function} Función para unregister este handler
   *
   * @example
   * const unregister = hooks.register('beforeEventPublish', async (ctx) => {
   *   return { ...ctx, modified: true };
   * });
   * // Más tarde...
   * unregister(); // Remover el handler
   */
  register(hookName, handler) {
    if (typeof hookName !== 'string' || !hookName) {
      throw new Error('hookName must be a non-empty string');
    }

    if (typeof handler !== 'function') {
      throw new Error('handler must be a function');
    }

    // Inicializar array de handlers si no existe
    if (!this.hooks[hookName]) {
      this.hooks[hookName] = [];
      this.stats[hookName] = { executions: 0, blocked: 0, errors: 0 };
    }

    // Agregar handler
    this.hooks[hookName].push(handler);

    // Retornar función de unregister
    return () => {
      const index = this.hooks[hookName].indexOf(handler);
      if (index > -1) {
        this.hooks[hookName].splice(index, 1);
      }
    };
  }

  /**
   * Ejecuta todos los handlers registrados para un hook en orden
   *
   * Los handlers se ejecutan secuencialmente (no en paralelo).
   * Cada handler recibe el contexto retornado por el handler anterior.
   * Si un handler retorna null, la cadena se detiene y retorna null.
   * Si un handler retorna undefined, se usa el contexto sin modificar.
   *
   * @param {string} hookName - Nombre del hook a ejecutar
   * @param {*} context - Contexto inicial a pasar al primer handler
   * @returns {Promise<*|null>} Contexto final modificado o null si fue bloqueado
   *
   * @example
   * const result = await hooks.execute('beforeEventPublish', {
   *   eventType: 'user.created',
   *   data: { id: 123 }
   * });
   *
   * if (result === null) {
   *   console.log('Event was blocked by a hook');
   * } else {
   *   console.log('Final context:', result);
   * }
   */
  async execute(hookName, context) {
    const handlers = this.hooks[hookName] || [];

    // Si no hay handlers, retornar contexto sin modificar
    if (handlers.length === 0) {
      return context;
    }

    // Incrementar contador de ejecuciones
    if (this.stats[hookName]) {
      this.stats[hookName].executions++;
    }

    let currentContext = context;

    // Ejecutar handlers secuencialmente
    for (let i = 0; i < handlers.length; i++) {
      const handler = handlers[i];

      try {
        const result = await handler(currentContext);

        // Si handler retorna null, bloquear operación
        if (result === null) {
          if (this.stats[hookName]) {
            this.stats[hookName].blocked++;
          }
          return null;
        }

        // Si handler retorna undefined, mantener contexto actual
        // Si retorna un valor, usarlo como nuevo contexto
        if (result !== undefined) {
          currentContext = result;
        }

      } catch (error) {
        // Registrar error en stats
        if (this.stats[hookName]) {
          this.stats[hookName].errors++;
        }

        // Re-throw error con información adicional
        const enhancedError = new Error(
          `Hook handler error in '${hookName}' (handler ${i + 1}/${handlers.length}): ${error.message}`
        );
        enhancedError.hookName = hookName;
        enhancedError.handlerIndex = i;
        enhancedError.originalError = error;
        throw enhancedError;
      }
    }

    return currentContext;
  }

  /**
   * Remueve todos los handlers de un hook específico
   *
   * @param {string} hookName - Nombre del hook a limpiar
   *
   * @example
   * hooks.clear('beforeEventPublish');
   */
  clear(hookName) {
    if (this.hooks[hookName]) {
      this.hooks[hookName] = [];
    }
  }

  /**
   * Remueve todos los handlers de todos los hooks
   *
   * @example
   * hooks.clearAll();
   */
  clearAll() {
    this.hooks = {};
  }

  /**
   * Obtiene el número de handlers registrados para un hook
   *
   * @param {string} hookName - Nombre del hook
   * @returns {number} Número de handlers registrados
   *
   * @example
   * const count = hooks.getHandlerCount('beforeEventPublish');
   * console.log(`${count} handlers registered`);
   */
  getHandlerCount(hookName) {
    return (this.hooks[hookName] || []).length;
  }

  /**
   * Lista todos los hooks registrados
   *
   * @returns {string[]} Array de nombres de hooks
   *
   * @example
   * const hookNames = hooks.listHooks();
   * console.log('Registered hooks:', hookNames);
   */
  listHooks() {
    return Object.keys(this.hooks);
  }

  /**
   * Obtiene estadísticas de ejecución de hooks
   *
   * @param {string} [hookName] - Nombre del hook (opcional, retorna stats de todos si se omite)
   * @returns {Object} Estadísticas de ejecución
   *
   * @example
   * const stats = hooks.getStats('beforeEventPublish');
   * console.log('Executions:', stats.executions);
   * console.log('Blocked:', stats.blocked);
   * console.log('Errors:', stats.errors);
   */
  getStats(hookName) {
    if (hookName) {
      return this.stats[hookName] || { executions: 0, blocked: 0, errors: 0 };
    }
    return { ...this.stats };
  }

  /**
   * Resetea las estadísticas de un hook o todos los hooks
   *
   * @param {string} [hookName] - Nombre del hook (opcional, resetea todos si se omite)
   *
   * @example
   * hooks.resetStats('beforeEventPublish');
   * hooks.resetStats(); // Reset all
   */
  resetStats(hookName) {
    if (hookName) {
      if (this.stats[hookName]) {
        this.stats[hookName] = { executions: 0, blocked: 0, errors: 0 };
      }
    } else {
      Object.keys(this.stats).forEach(name => {
        this.stats[name] = { executions: 0, blocked: 0, errors: 0 };
      });
    }
  }
}

module.exports = HookManager;
