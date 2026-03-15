/**
 * Plugin Manager Module
 * Discovers and manages JSON-based function plugins
 *
 * Follows event-driven architecture
 */

const fs = require('fs');
const path = require('path');

class PluginManagerModule {
  constructor() {
    this.name = 'plugin-manager';
    this.version = '2.0.0';

    // State
    this.plugins = new Map(); // name -> definition
    this.pluginsPath = null;
    this.watchInterval = null;

    // Dependencies (injected)
    this.logger = null;
    this.metrics = null;
    this.eventBus = null;
    this.config = null;
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(core) {
    this.logger = core.logger;
    this.metrics = core.metrics;
    this.eventBus = core.eventBus;
    this.config = core.moduleConfig || {};

    this.logger.info('module.loading', {
      module: this.name,
      version: this.version
    });

    // Configure plugins path
    this.pluginsPath = path.resolve(
      __dirname,
      this.config.pluginsPath || '../../plugins'
    );

    // Ensure plugins directory exists
    this.ensurePluginsDirectory();

    // Event subscriptions are auto-wired by the loader from module.json

    // Discover and load plugins
    await this.discoverPlugins();

    // Setup auto-reload if enabled
    if (this.config.autoReload) {
      this.startWatching();
    }

    // Update metrics
    this.updateMetrics();

    this.logger.info('module.loaded', {
      module: this.name,
      version: this.version,
      plugins_path: this.pluginsPath,
      plugins_count: this.plugins.size,
      auto_reload: !!this.config.autoReload
    });
  }

  async onUnload() {
    this.logger.info('module.unloading', { module: this.name });

    // Stop watching
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }

    // Publish unload events for all plugins
    for (const [name] of this.plugins.entries()) {
      await this.eventBus.publish('plugin.unloaded', {
        name,
        unloaded_at: new Date().toISOString()
      });
    }

    this.plugins.clear();

    this.logger.info('module.unloaded', { module: this.name });
  }

  // ==========================================
  // Initialization Helpers
  // ==========================================

  ensurePluginsDirectory() {
    if (!fs.existsSync(this.pluginsPath)) {
      fs.mkdirSync(this.pluginsPath, { recursive: true });
      this.logger.info('plugins.directory.created', {
        path: this.pluginsPath
      });
    }
  }

  startWatching() {
    const interval = this.config.watchInterval || 5000;

    this.logger.info('plugins.watch.started', { interval });

    this.watchInterval = setInterval(() => {
      this.discoverPlugins();
    }, interval);
  }

  updateMetrics() {
    // REMOVED: this.metrics.gauge('plugin.count', this.plugins.size);

    let totalFunctions = 0;
    for (const plugin of this.plugins.values()) {
      totalFunctions += Object.keys(plugin.functions || {}).length;
    }
    // REMOVED: this.metrics.gauge('plugin.functions.count', totalFunctions);
  }

  // ==========================================
  // Event Handlers (wired by loader from module.json)
  // ==========================================

  async onGetPluginRequest(event) {
    const { name, request_id, correlation_id } = event.payload || event;

    this.logger.info('plugin.get.request.received', {
      name,
      request_id,
      correlation_id
    });

    const plugin = this.plugins.get(name);

    if (plugin) {
      await this.eventBus.publish('plugin.get.response', {
        request_id,
        success: true,
        plugin
      }, { correlationId: correlation_id });
    } else {
      await this.eventBus.publish('plugin.get.response', {
        request_id,
        success: false,
        error: `Plugin '${name}' not found`
      }, { correlationId: correlation_id });
    }
  }

  async onListPluginsRequest(event) {
    const { request_id, correlation_id } = event.payload || event;

    this.logger.info('plugin.list.request.received', {
      request_id,
      correlation_id
    });

    const pluginsList = this.getPluginsSummary();

    await this.eventBus.publish('plugin.list.response', {
      request_id,
      success: true,
      plugins: pluginsList,
      count: pluginsList.length
    }, { correlationId: correlation_id });
  }

  // ==========================================
  // HTTP API Handlers
  // ==========================================

  async handleGetPlugin(req, context) {
    const { name } = context.params;

    this.logger.info('plugin.get.start', {
      name,
      correlation_id: context.correlationId
    });

    const plugin = this.plugins.get(name);

    if (!plugin) {
      this.logger.warn('plugin.get.not_found', {
        name,
        correlation_id: context.correlationId
      });

      return {
        status: 404,
        data: {
          success: false,
          error: `Plugin '${name}' not found`
        }
      };
    }

    this.logger.info('plugin.retrieved', {
      name,
      correlation_id: context.correlationId
    });

    return {
      status: 200,
      data: {
        success: true,
        plugin
      }
    };
  }

  async handleListPlugins(req, context) {
    this.logger.info('plugins.list.start', {
      correlation_id: context.correlationId
    });

    const pluginsList = this.getPluginsSummary();

    let totalFunctions = 0;
    for (const p of pluginsList) {
      totalFunctions += p.function_count;
    }

    this.logger.info('plugins.listed', {
      count: pluginsList.length,
      total_functions: totalFunctions,
      correlation_id: context.correlationId
    });

    return {
      status: 200,
      data: {
        success: true,
        plugins: pluginsList,
        count: pluginsList.length,
        total_functions: totalFunctions
      }
    };
  }

  async handleReloadPlugins(req, context) {
    this.logger.info('plugins.reload.start', {
      correlation_id: context.correlationId
    });

    try {
      const result = await this.reloadPlugins(context.correlationId);

      // REMOVED (migrate-to-event-metrics): this.metrics.increment('plugin.reload.total');
    // → Counter extracted from events

      // Publish event
      await this.eventBus.publish('plugin.reloaded', {
        count: result.count,
        loaded: result.loaded,
        errors: result.errors,
        reloaded_at: new Date().toISOString()
      }, { correlationId: context.correlationId });

      this.logger.info('plugins.reloaded', {
        count: result.count,
        loaded: result.loaded,
        errors: result.errors,
        correlation_id: context.correlationId
      });

      return {
        status: 200,
        data: {
          success: true,
          message: 'Plugins reloaded successfully',
          count: result.count,
          loaded: result.loaded,
          errors: result.errors
        }
      };
    } catch (error) {
      this.logger.error('plugins.reload.error', {
        error: error.message,
        correlation_id: context.correlationId
      });

      return {
        status: 500,
        data: {
          success: false,
          error: 'Failed to reload plugins',
          message: error.message
        }
      };
    }
  }

  async handleHealthCheck(req, context) {
    return {
      status: 200,
      data: {
        status: 'healthy',
        module: this.name,
        version: this.version,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        plugins_count: this.plugins.size,
        plugins_path: this.pluginsPath,
        auto_reload: !!this.config.autoReload
      }
    };
  }

  async handleGetMetrics(req, context) {
    let totalFunctions = 0;
    for (const plugin of this.plugins.values()) {
      totalFunctions += Object.keys(plugin.functions || {}).length;
    }

    return {
      status: 200,
      data: {
        counters: {
          'plugin.loaded.total': this.metrics.getCounter('plugin.loaded.total') || 0,
          'plugin.error.total': this.metrics.getCounter('plugin.error.total') || 0,
          'plugin.reload.total': this.metrics.getCounter('plugin.reload.total') || 0
        },
        gauges: {
          'plugin.count': this.plugins.size,
          'plugin.functions.count': totalFunctions
        }
      }
    };
  }

  // ==========================================
  // Core Logic
  // ==========================================

  async discoverPlugins() {
    const startTime = Date.now();

    this.logger.info('plugins.discovery.start', {
      path: this.pluginsPath
    });

    try {
      if (!fs.existsSync(this.pluginsPath)) {
        this.logger.warn('plugins.directory.missing', {
          path: this.pluginsPath
        });
        return { count: 0, loaded: 0, errors: 0 };
      }

      const pluginDirs = fs.readdirSync(this.pluginsPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      let loadedCount = 0;
      let errorCount = 0;

      for (const dirName of pluginDirs) {
        const pluginDirPath = path.join(this.pluginsPath, dirName);
        const files = fs.readdirSync(pluginDirPath);
        const definitionFile = files.find(f => f.endsWith('.functions.json'));

        if (definitionFile) {
          const filePath = path.join(pluginDirPath, definitionFile);
          const success = await this.loadPluginFromFile(filePath);

          if (success) {
            loadedCount++;
          } else {
            errorCount++;
          }
        }
      }

      const duration = Date.now() - startTime;

      this.logger.info('plugins.discovery.completed', {
        total: this.plugins.size,
        loaded: loadedCount,
        errors: errorCount,
        duration
      });

      // REMOVED: this.metrics.timing('plugin.discovery.duration', duration);
      this.updateMetrics();

      return {
        count: this.plugins.size,
        loaded: loadedCount,
        errors: errorCount
      };
    } catch (error) {
      this.logger.error('plugins.discovery.error', {
        error: error.message,
        path: this.pluginsPath
      });

      await this.eventBus.publish('plugin.error', {
        error: error.message,
        context: 'discovery'
      });

      // REMOVED (migrate-to-event-metrics): this.metrics.increment('plugin.error.total');
    // → Counter extracted from events

      throw error;
    }
  }

  async loadPluginFromFile(filePath) {
    const startTime = Date.now();

    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const pluginDef = JSON.parse(fileContent);

      // Validate structure
      if (!pluginDef.metadata || !pluginDef.metadata.name || !pluginDef.functions) {
        this.logger.error('plugin.load.invalid_structure', {
          file: filePath
        });

        await this.eventBus.publish('plugin.error', {
          file: filePath,
          error: 'Invalid structure: missing metadata, name, or functions',
          context: 'load'
        });

        // REMOVED (migrate-to-event-metrics): this.metrics.increment('plugin.error.total');
    // → Counter extracted from events
        return false;
      }

      const pluginName = pluginDef.metadata.name;

      // Skip if already loaded
      if (this.plugins.has(pluginName)) {
        this.logger.debug('plugin.already_loaded', { name: pluginName });
        return true;
      }

      // Store plugin
      this.plugins.set(pluginName, pluginDef);

      const duration = Date.now() - startTime;
      const functionNames = Object.keys(pluginDef.functions);

      this.logger.info('plugin.loaded', {
        name: pluginName,
        version: pluginDef.metadata.version || '1.0.0',
        function_count: functionNames.length,
        file: filePath,
        duration
      });

      // Publish event
      await this.eventBus.publish('plugin.loaded', {
        name: pluginName,
        definition: pluginDef,
        version: pluginDef.metadata.version || '1.0.0',
        description: pluginDef.metadata.description || '',
        functions: functionNames,
        function_count: functionNames.length,
        loaded_at: new Date().toISOString()
      });

      // REMOVED (migrate-to-event-metrics): this.metrics.increment('plugin.loaded.total');
    // → Counter extracted from events
      // REMOVED: this.metrics.timing('plugin.load.duration', duration);

      return true;
    } catch (error) {
      this.logger.error('plugin.load.error', {
        file: filePath,
        error: error.message
      });

      await this.eventBus.publish('plugin.error', {
        file: filePath,
        error: error.message,
        context: 'load'
      });

      // REMOVED (migrate-to-event-metrics): this.metrics.increment('plugin.error.total');
    // → Counter extracted from events
      return false;
    }
  }

  async reloadPlugins(correlationId) {
    this.logger.info('plugins.reload.clearing');
    this.plugins.clear();
    return await this.discoverPlugins();
  }

  getPluginsSummary() {
    return Array.from(this.plugins.entries()).map(([name, def]) => ({
      name,
      version: def.metadata.version || '1.0.0',
      description: def.metadata.description || '',
      functions: Object.keys(def.functions),
      function_count: Object.keys(def.functions).length
    }));
  }
}

module.exports = PluginManagerModule;
