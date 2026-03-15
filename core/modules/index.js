/**
 * Modules System - Loader + Registry
 *
 * @example
 * const { ModuleLoader, ModuleRegistry } = require('./modules');
 *
 * const registry = new ModuleRegistry({ logger });
 * const loader = new ModuleLoader({
 *   modulesPath: './modules',
 *   core,
 *   logger
 * });
 *
 * await loader.loadAll();
 *
 * // Registrar módulos en el registry
 * for (const module of loader.getLoadedModules()) {
 *   const moduleData = loader.getModule(module.name);
 *   registry.register(module.name, {
 *     manifest: moduleData.manifest,
 *     instance: moduleData.instance,
 *     apis: moduleData.manifest.provides?.apis || [],
 *     hooks: moduleData.manifest.provides?.hooks || [],
 *     subscribes: moduleData.manifest.subscribes || []
 *   });
 * }
 */

const ModuleLoader = require('./loader');
const ModuleRegistry = require('./registry');

module.exports = {
  ModuleLoader,
  ModuleRegistry
};
