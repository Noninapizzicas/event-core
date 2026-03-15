/**
 * Providers Core Module
 *
 * Sistema de providers para servicios externos y locales.
 * Autodescubre, carga y expone funciones via eventos.
 *
 * @example
 * const { ProviderRegistry, ProviderExecutor, ProviderLoader } = require('./providers');
 *
 * // Crear instancias
 * const registry = new ProviderRegistry({ logger });
 * const executor = new ProviderExecutor({ registry, logger });
 * const loader = new ProviderLoader({
 *   providersPath: './services/providers',
 *   registry,
 *   executor,
 *   eventBus,
 *   logger
 * });
 *
 * // Cargar todos los providers
 * await loader.loadAll();
 *
 * // Usar desde un módulo:
 * eventBus.publish('google.vision.extract.request', { image: base64 });
 * eventBus.subscribe('google.vision.extract.response', (result) => {
 *   console.log('OCR result:', result.data);
 * });
 */

const ProviderRegistry = require('./registry');
const ProviderExecutor = require('./executor');
const ProviderLoader = require('./loader');

/**
 * Crea y configura el sistema de providers completo
 *
 * @param {Object} options - Opciones
 * @param {string} options.providersPath - Path a providers
 * @param {Object} options.eventBus - EventBus instance
 * @param {Object} options.logger - Logger instance
 * @returns {Object} { registry, executor, loader }
 */
function createProviderSystem(options = {}) {
  const logger = options.logger || null;

  const registry = new ProviderRegistry({ logger });
  const executor = new ProviderExecutor({
    registry,
    logger,
    credentialResolver: options.credentialResolver
  });
  const loader = new ProviderLoader({
    providersPath: options.providersPath || './services/providers',
    registry,
    executor,
    eventBus: options.eventBus,
    logger
  });

  return { registry, executor, loader };
}

module.exports = {
  ProviderRegistry,
  ProviderExecutor,
  ProviderLoader,
  createProviderSystem
};
