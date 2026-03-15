/**
 * Service Executor
 *
 * Ejecuta llamadas a servicios via eventos request/response.
 * Inyecta project_id automáticamente según el scope.
 *
 * @example
 * const executor = new ServiceExecutor(eventBus, logger);
 * const result = await executor.call('local.google-vision', 'extract', { image: '/path/to/img.png' });
 */

const crypto = require('crypto');

class ServiceExecutor {
  constructor(eventBus, logger) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.pending = new Map();
    this.subscriptions = new Map(); // Track active subscriptions
  }

  /**
   * Llama a un servicio
   *
   * @param {string} service - Nombre del servicio (ej: 'local.google-vision')
   * @param {string} action - Acción a ejecutar (ej: 'extract')
   * @param {Object} params - Parámetros para el servicio
   * @param {Object} options - Opciones adicionales
   * @param {number} options.timeout - Timeout en ms (default: 60000)
   * @param {string} options.projectId - Project ID para credenciales
   * @returns {Promise<Object>}
   */
  async call(service, action, params = {}, options = {}) {
    const { timeout = 60000, projectId = null } = options;

    const requestId = crypto.randomUUID();
    const requestEvent = `${service}.${action}.request`;
    const responseEvent = `${service}.${action}.response`;

    // Construir payload
    const payload = {
      request_id: requestId,
      ...params
    };

    // Inyectar project_id si existe (para resolución de credenciales)
    if (projectId) {
      payload.project_id = projectId;
    }

    return new Promise((resolve, reject) => {
      let timer;
      let unsubscribe;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (unsubscribe) {
          try { unsubscribe(); } catch (e) { /* ignore */ }
        }
        this.pending.delete(requestId);
      };

      // Timeout
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout: ${service}.${action} after ${timeout}ms`));
      }, timeout);

      // Suscribirse SOLO al evento de respuesta específico
      unsubscribe = this.eventBus.subscribe(responseEvent, (event) => {
        // Manejar envelope del EventBus
        const data = event.data || event;

        // Verificar que es nuestra respuesta
        if (data.request_id !== requestId) return;

        cleanup();

        if (data.success === false || data.error) {
          reject(new Error(data.error || 'Service error'));
        } else {
          resolve(data);
        }
      });

      // Guardar referencia para posible cancelación
      this.pending.set(requestId, { cleanup });

      // Publicar request
      this.eventBus.publish(requestEvent, payload);

      this.logger?.debug('service.call', {
        requestId,
        service,
        action,
        projectId,
        responseEvent
      });
    });
  }

  /**
   * Crea un executor con scope de proyecto fijo
   *
   * @param {string} projectId - ID del proyecto
   * @returns {Object} - Executor con project_id inyectado
   */
  scoped(projectId) {
    return {
      call: (service, action, params = {}, options = {}) => {
        return this.call(service, action, params, { ...options, projectId });
      }
    };
  }

  /**
   * Cancela todas las peticiones pendientes
   */
  cancelAll() {
    for (const [requestId, { cleanup }] of this.pending) {
      if (cleanup) cleanup();
    }
    this.pending.clear();
  }
}

module.exports = ServiceExecutor;
