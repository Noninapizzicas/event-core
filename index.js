#!/usr/bin/env node

// Load environment variables from .env file
require('dotenv').config();

/**
 * Event Core - Main Entry Point
 *
 * Orchestrates initialization of all core components:
 * - MQTT Broker (Aedes)
 * - Event Bus
 * - Hook System
 * - Module Loader
 * - HTTP Gateway
 * - Observability
 *
 * Usage:
 *   node index.js [--port 3000] [--broker-port 1883] [--core-id mycore]
 *
 * Environment variables:
 *   EVENT_CORE_PORT=3000
 *   EVENT_CORE_BROKER_PORT=1883
 *   EVENT_CORE_ID=mycore
 *   EVENT_CORE_MODULES_PATH=./modules
 *   EVENT_CORE_LOG_LEVEL=info
 */

const path = require('path');
const fs = require('fs');

// Core components
const { MQTTClient } = require('./core/mqtt');
const EventBus = require('./core/events/bus');
const HookManager = require('./core/hooks');
const { ModuleLoader, ModuleRegistry } = require('./core/modules');
const { createProviderSystem } = require('./core/providers');
const HTTPGateway = require('./core/gateway/http');
const { Logger, Tracer, Metrics, ActivityLogger } = require('./core/observability');
const { loadConfig, getConfigValue } = require('./core/config');
const { ValidationManager, commonSchemas } = require('./core/validation');
const { UIRequestHandler } = require('./core/ui');

// Port Management & Service Registry
const { ServiceRegistry } = require('./core/utils');

// Handler System
const HandlerLoader = require('./core/handler-loader');
const ServiceExecutor = require('./core/service-executor');

// Parse CLI args
function parseCLIArgs() {
  const args = process.argv.slice(2);
  const cliArgs = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      cliArgs.httpPort = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--broker-port' && args[i + 1]) {
      cliArgs.brokerPort = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--core-id' && args[i + 1]) {
      cliArgs.coreId = args[i + 1];
      i++;
    } else if (args[i] === '--modules-path' && args[i + 1]) {
      cliArgs.modulesPath = args[i + 1];
      i++;
    } else if (args[i] === '--log-level' && args[i + 1]) {
      cliArgs.logLevel = args[i + 1];
      i++;
    } else if (args[i] === '--config' && args[i + 1]) {
      cliArgs.configPath = args[i + 1];
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Event Core - Meta-Core Event-Driven Framework

Usage:
  node index.js [options]

Options:
  --config <path>         Path to config file (default: ./config.json)
  --port <port>           HTTP Gateway port (overrides config)
  --broker-port <port>    MQTT Broker port (overrides config)
  --core-id <id>          Core instance ID (overrides config)
  --modules-path <path>   Modules directory (overrides config)
  --log-level <level>     Log level: debug, info, warn, error (overrides config)
  --help, -h              Show this help message

Configuration Priority (highest to lowest):
  1. CLI arguments (--port, etc)
  2. Environment variables (EVENT_CORE_*)
  3. config.{NODE_ENV}.json (e.g., config.production.json)
  4. config.json

Environment Variables:
  NODE_ENV                Environment (development, production, etc)
  EVENT_CORE_PORT         HTTP Gateway port
  EVENT_CORE_BROKER_PORT  MQTT Broker port
  EVENT_CORE_ID           Core instance ID
  EVENT_CORE_MODULES_PATH Modules directory path
  EVENT_CORE_LOG_LEVEL    Log level

Examples:
  node index.js
  node index.js --port 3001 --core-id core-b
  NODE_ENV=production node index.js
  EVENT_CORE_LOG_LEVEL=debug node index.js
  node index.js --config /path/to/custom-config.json
      `);
      process.exit(0);
    }
  }

  return cliArgs;
}

// Main initialization
async function main() {
  // Parse CLI arguments
  const cliArgs = parseCLIArgs();

  // Load configuration
  const config = loadConfig({
    configPath: cliArgs.configPath,
    cliArgs
  });

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                    EVENT CORE v0.1.0                       ║');
  console.log('║          Meta-Core Event-Driven Framework                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  console.log(`📋 Configuration:`);
  console.log(`   Environment:    ${config.core.environment}`);
  console.log(`   Core ID:        ${config.core.id}`);
  console.log(`   HTTP Port:      ${config.http.port}`);
  console.log(`   Broker Port:    ${config.mqtt.broker.port}`);
  console.log(`   Modules Path:   ${config.modules.path}`);
  console.log(`   Log Level:      ${config.observability.logging.level}\n`);

  // Global state
  const core = {
    id: config.core.id,
    config,
    mqttClient: null,
    eventBus: null,
    hooks: null,
    moduleLoader: null,
    httpGateway: null,
    logger: null,
    tracer: null,
    metrics: null,
    activity: null,  // ActivityLogger for centralized activity monitoring
    validationManager: null,
    serviceRegistry: null,
    heartbeatTimer: null,
    uiHandler: null,  // UI Request/Response handler
    providerSystem: null  // Provider system for external/local services
  };

  try {
    // ========================================================================
    // Step 1: Initialize Observability
    // ========================================================================
    console.log('🔍 [1/7] Initializing Observability...');

    core.logger = new Logger({
      level: config.observability.logging.level,
      coreId: config.core.id
    });

    core.tracer = new Tracer({
      service_name: `event-core-${config.core.id}`
    });

    core.metrics = new Metrics();

    core.logger.info('core.observability.initialized', {
      log_level: config.observability.logging.level,
      core_id: config.core.id
    });

    // Note: ActivityLogger will be fully initialized after EventBus is ready

    // ========================================================================
    // Step 2: Initialize Validation System
    // ========================================================================
    console.log('✓ [2/7] Initializing Validation System...');

    core.validationManager = new ValidationManager({
      logger: core.logger,
      allErrors: true,
      removeAdditional: true,
      useDefaults: true,
      coerceTypes: true
    });

    // Registrar schemas comunes
    Object.entries(commonSchemas).forEach(([schemaId, schema]) => {
      try {
        core.validationManager.registerSchema(schemaId, schema);
      } catch (error) {
        core.logger.warn('validation.schema.registration_failed', {
          schema_id: schemaId,
          error: error.message
        });
      }
    });

    core.logger.info('core.validation.initialized', {
      schemas_registered: Object.keys(commonSchemas).length
    });

    // ========================================================================
    // Step 3: Initialize MQTT Client (with embedded broker fallback)
    // ========================================================================
    console.log('📡 [3/8] Connecting to MQTT Broker...');

    core.mqttClient = new MQTTClient({
      brokerUrl: `mqtt://localhost:${config.mqtt.broker.port}`,
      coreId: config.core.id,
      brokerPort: config.mqtt.broker.port,
      logger: core.logger,
      metrics: core.metrics,
      usePool: config.mqtt.pool?.enabled || false,
      poolConfig: config.mqtt.pool ? {
        min: config.mqtt.pool.min,
        max: config.mqtt.pool.max,
        idleTimeout: config.mqtt.pool.idle_timeout,
        acquireTimeout: config.mqtt.pool.acquire_timeout,
        healthCheckInterval: config.mqtt.pool.health_check_interval
      } : {}
    });

    await core.mqttClient.connect();

    const mqttStats = core.mqttClient.getStats();
    console.log(`   ✅ ${mqttStats.usingEmbedded ? 'Started embedded broker' : 'Connected to external broker'} on port ${config.mqtt.broker.port}`);

    if (mqttStats.pooling?.enabled) {
      console.log(`   🔄 Connection pooling enabled (${config.mqtt.pool.min}-${config.mqtt.pool.max} connections)`);
    }

    core.logger.info('core.mqtt.connected', {
      using_embedded: mqttStats.usingEmbedded,
      port: config.mqtt.broker.port,
      pooling_enabled: mqttStats.pooling?.enabled || false
    });

    // ========================================================================
    // Step 4: Initialize Hook System
    // ========================================================================
    console.log('🪝 [4/8] Initializing Hook System...');

    core.hooks = new HookManager({
      logger: core.logger
    });

    core.logger.info('core.hooks.initialized', {
      available_hooks: core.hooks.listHooks().length
    });

    // ========================================================================
    // Step 4: Initialize Event Bus
    // ========================================================================
    console.log('🔄 [5/8] Initializing Event Bus...');

    core.eventBus = new EventBus({
      coreId: config.core.id,
      mqtt: core.mqttClient,
      hooks: core.hooks,
      logger: core.logger,
      tracer: core.tracer,
      metrics: core.metrics
    });

    core.logger.info('core.eventbus.initialized', {
      core_id: config.core.id
    });

    // Initialize ActivityLogger now that EventBus is ready
    core.activity = new ActivityLogger({
      coreId: config.core.id,
      eventBus: core.eventBus,
      logger: core.logger,
      enabled: true,
      minLevel: config.observability.logging.level
    });

    // Connect ActivityLogger back to EventBus for event flow monitoring
    core.eventBus.activity = core.activity;

    core.activity.logSystem('core.activity_logger.initialized', {
      coreId: config.core.id
    });

    core.logger.info('core.activity.initialized', {
      core_id: config.core.id
    });

    // ========================================================================
    // Step 5.5: Initialize UI Request Handler
    // ========================================================================
    console.log('🖥️  [5.5/8] Initializing UI Request Handler...');

    core.uiHandler = new UIRequestHandler({
      mqttClient: core.mqttClient,
      logger: core.logger,
      metrics: core.metrics
    });

    await core.uiHandler.start();

    core.logger.info('core.ui_handler.initialized', {
      topic: 'ui/request/#'
    });

    // ========================================================================
    // Step 6: Initialize Provider System (BEFORE modules for tool integration)
    // ========================================================================
    console.log('🔌 [6/8] Loading Service Providers...');

    const providersPath = path.resolve(__dirname, './services/providers');

    if (fs.existsSync(providersPath)) {
      core.providerSystem = createProviderSystem({
        providersPath,
        eventBus: core.eventBus,
        logger: core.logger
      });

      const providerResults = await core.providerSystem.loader.loadAll();
      const loadedProviders = providerResults.filter(r => r.success);

      core.logger.info('core.providers.loaded', {
        count: loadedProviders.length,
        providers: loadedProviders.map(p => p.providerName)
      });

      console.log(`   ✅ Loaded ${loadedProviders.length} provider(s):`);
      loadedProviders.forEach(p => {
        const status = p.available ? '✓' : '✗';
        console.log(`      ${status} ${p.providerName} (${p.functions?.length || 0} functions)`);
      });
      console.log('');
    } else {
      console.log('   ℹ️  No providers directory found, skipping...\n');
    }

    // ========================================================================
    // Step 6.5: Load Modules (after providers for tool auto-registration)
    // ========================================================================
    console.log('📦 [6.5/8] Loading Modules...');

    const modulesPath = path.resolve(__dirname, config.modules.path);

    if (!fs.existsSync(modulesPath)) {
      core.logger.warn('core.modules.path_not_found', {
        path: modulesPath
      });
      console.log(`   ⚠️  Modules path not found: ${modulesPath}`);
      console.log(`   ℹ️  Continuing without modules...\n`);
    } else {
      // Create the core context that will be passed to modules
      // Include providerRegistry for AI tool auto-registration
      const coreContext = {
        id: config.core.id,
        config,
        logger: core.logger,
        metrics: core.metrics,
        hooks: core.hooks,
        eventBus: core.eventBus,
        tracer: core.tracer,
        activity: core.activity,
        uiHandler: core.uiHandler,
        validationManager: core.validationManager,
        // Provider registry for AI agent tool auto-discovery
        providerRegistry: core.providerSystem?.registry || null
      };

      // Create Module Registry
      core.moduleRegistry = new ModuleRegistry({
        logger: core.logger,
        metrics: core.metrics
      });

      core.moduleLoader = new ModuleLoader({
        modulesPath,
        core: coreContext,
        registry: core.moduleRegistry,
        logger: core.logger,
        metrics: core.metrics,
        config: config.modules || {}
      });

      // Register provider functions as AI tools (unifies tool systems)
      // This makes provider tools (gmail_send, ocr_extract, etc.) available to ai-gateway
      if (core.providerSystem?.registry) {
        core.moduleLoader.registerProviderTools(core.providerSystem.registry);
      }

      await core.moduleLoader.loadAll();

      const loadedModules = core.moduleLoader.getLoadedModules();

      core.logger.info('core.modules.loaded', {
        count: loadedModules.length,
        modules: loadedModules.map(m => m.name)
      });

      console.log(`   ✅ Loaded ${loadedModules.length} module(s):`);
      loadedModules.forEach(mod => {
        console.log(`      - ${mod.name} v${mod.version}`);
      });
      console.log('');
    }

    // ========================================================================
    // Step 6.7: Initialize Handler System (Centralized Actions)
    // ========================================================================
    console.log('⚡ [6.7/8] Loading Event Handlers...');

    // Create Service Executor for handlers
    core.serviceExecutor = new ServiceExecutor(core.eventBus, core.logger);

    // Create Handler Loader
    core.handlerLoader = new HandlerLoader(core.eventBus, core.serviceExecutor, core.logger);

    // Centralized loading: single tree at ./handlers/
    // Structure: handlers/global/ + handlers/projects/{id}/
    // Also loads legacy: handlers/*.js + data/projects/{id}/handlers/
    core.handlerLoader.loadCentralized('./handlers', './data/projects');

    const handlerStats = core.handlerLoader.getStats();
    console.log(`   ✅ Loaded ${handlerStats.total} handler(s):`);
    console.log(`      - Global: ${handlerStats.global}`);
    for (const [proj, count] of Object.entries(handlerStats.byProject)) {
      console.log(`      - ${proj}: ${count}`);
    }
    console.log('');

    core.logger.info('core.handlers.loaded', handlerStats);

    // ========================================================================
    // Step 7: Initialize Service Registry & Allocate Port
    // ========================================================================
    console.log('📋 [7/8] Initializing Service Registry...');

    core.serviceRegistry = new ServiceRegistry({
      autocleanup: true
    });

    // Check if port is already specified or if we should auto-allocate
    let httpPort = config.http.port;

    // Auto-allocate port if using default and it might conflict
    if (!process.env.HTTP_PORT && !cliArgs.httpPort) {
      try {
        const autoPort = await core.serviceRegistry.findFreePort('EVENT_CORE');
        console.log(`   🔍 Auto-allocated port: ${autoPort}`);
        httpPort = autoPort;
      } catch (error) {
        core.logger.warn('core.registry.port_allocation_failed', {
          error: error.message,
          fallback: httpPort
        });
        console.log(`   ⚠️  Port auto-allocation failed, using configured port: ${httpPort}`);
      }
    }

    // ========================================================================
    // Step 7: Start HTTP Gateway
    // ========================================================================
    console.log('🌐 [8/8] Starting HTTP Gateway...');

    core.httpGateway = new HTTPGateway({
      port: httpPort,
      coreId: config.core.id,
      logger: core.logger,
      metrics: core.metrics,
      eventBus: core.eventBus,
      activity: core.activity,  // ActivityLogger for API monitoring
      moduleLoader: core.moduleLoader,
      registry: core.moduleRegistry,
      validationManager: core.validationManager,
      validation: config.validation || {
        enabled: true,
        requireSchemas: false,
        validateResponses: false,
        strict: true
      },
      compression: config.http?.compression || {
        enabled: true,
        minSize: 1024,
        level: 6
      },
      cache: config.http?.cache || {
        enabled: false,
        maxSize: 100,
        defaultTTL: 60000
      },
      core: core  // Pass core for UI Gateway
    });

    await core.httpGateway.start();

    core.logger.info('core.gateway.started', {
      port: httpPort,
      core_id: config.core.id
    });

    // ========================================================================
    // Register Service in Registry
    // ========================================================================
    const loadedModules = core.moduleLoader ? core.moduleLoader.getLoadedModules() : [];

    core.serviceRegistry.register(config.core.id, 'EVENT_CORE', httpPort, {
      version: '0.1.0',
      pid: process.pid,
      modules: loadedModules.map(m => m.name),
      mqtt_port: config.mqtt.broker.port,
      using_embedded_mqtt: mqttStats.usingEmbedded
    });

    // Start heartbeat timer (every 10 seconds)
    core.heartbeatTimer = setInterval(() => {
      core.serviceRegistry.heartbeat(config.core.id);
    }, 10000);

    core.logger.info('core.registry.registered', {
      core_id: config.core.id,
      port: httpPort
    });

    // ========================================================================
    // Startup Complete
    // ========================================================================
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║                  ✅ CORE STARTED SUCCESSFULLY               ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    console.log('📍 Endpoints:');
    console.log(`   HTTP Gateway:   http://localhost:${httpPort}`);
    console.log(`   Admin UI:       http://localhost:${httpPort}/ui`);
    console.log(`   MQTT Broker:    mqtt://localhost:${config.mqtt.broker.port}`);
    console.log(`   Health Check:   http://localhost:${httpPort}/health\n`);

    console.log('🔧 Management:');
    console.log(`   View Status:    curl http://localhost:${httpPort}/stats`);
    console.log(`   List Modules:   curl http://localhost:${httpPort}/modules`);
    console.log(`   Shutdown:       Ctrl+C or SIGTERM\n`);

    console.log('📋 Service Registry:');
    console.log(`   Registered as:  ${config.core.id}`);
    console.log(`   Registry file:  ${core.serviceRegistry.registryFile}\n`);

    core.metrics.increment('core.startup.success');

    // ========================================================================
    // Re-activate existing projects (notify modules of active projects)
    // ========================================================================
    if (core.moduleLoader) {
      const pmData = core.moduleLoader.getModule('project-manager');
      if (pmData?.instance?.reactivateExistingProjects) {
        await pmData.instance.reactivateExistingProjects();
      }
    }

    // ========================================================================
    // Graceful Shutdown
    // ========================================================================
    const shutdown = async (signal) => {
      console.log(`\n\n🛑 Received ${signal}, shutting down gracefully...\n`);

      core.logger.info('core.shutdown.initiated', { signal });

      try {
        // Step 1: Stop heartbeat timer
        if (core.heartbeatTimer) {
          clearInterval(core.heartbeatTimer);
          core.heartbeatTimer = null;
        }

        // Step 2: Unregister from Service Registry
        if (core.serviceRegistry) {
          console.log('   [1/5] Unregistering from Service Registry...');
          core.serviceRegistry.unregister(config.core.id);
          core.logger.info('core.registry.unregistered');
        }

        // Step 3: Flush ActivityLogger
        if (core.activity) {
          console.log('   [2/6] Flushing Activity Logs...');
          core.activity.logSystem('core.shutdown.started', { signal });
          core.activity.close();
          core.logger.info('core.activity.closed');
        }

        // Step 4: Stop HTTP Gateway
        if (core.httpGateway) {
          console.log('   [3/7] Stopping HTTP Gateway...');
          await core.httpGateway.stop();
          core.logger.info('core.gateway.stopped');
        }

        // Step 4.5: Stop UI Request Handler
        if (core.uiHandler) {
          console.log('   [4/7] Stopping UI Request Handler...');
          await core.uiHandler.stop();
          core.logger.info('core.ui_handler.stopped');
        }

        // Step 5: Unload Modules (before providers - reverse order of init)
        if (core.moduleLoader) {
          console.log('   [4/7] Unloading modules...');
          await core.moduleLoader.unloadAll();
          core.logger.info('core.modules.unloaded');
        }

        // Step 5.3: Unload Handlers
        if (core.handlerLoader) {
          console.log('   [4.5/7] Unloading handlers...');
          core.handlerLoader.unloadAll();
          core.logger.info('core.handlers.unloaded');
        }

        // Step 5.5: Unload Providers
        if (core.providerSystem) {
          console.log('   [5/7] Unloading providers...');
          await core.providerSystem.loader.unloadAll();
          core.logger.info('core.providers.unloaded');
        }

        // Step 6: Disconnect MQTT Client (also stops embedded broker if used)
        if (core.mqttClient) {
          console.log('   [5/6] Disconnecting MQTT Client...');
          await core.mqttClient.disconnect();
          core.logger.info('core.mqtt.disconnected');
        }

        console.log('\n✅ Shutdown complete. Goodbye!\n');
        process.exit(0);

      } catch (error) {
        console.error('\n❌ Error during shutdown:', error.message);
        core.logger.error('core.shutdown.error', { error: error.message }, error);
        process.exit(1);
      }
    };

    // Register signal handlers
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      console.error('\n💥 Uncaught Exception:', error);
      core.logger.error('core.uncaught_exception', { error: error.message }, error);
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('\n💥 Unhandled Rejection:', reason);
      core.logger.error('core.unhandled_rejection', { reason }, reason);
      shutdown('unhandledRejection');
    });

  } catch (error) {
    console.error('\n❌ Startup failed:', error.message);
    console.error(error.stack);

    if (core.logger) {
      core.logger.error('core.startup.failed', { error: error.message }, error);
    }

    process.exit(1);
  }
}

// Run
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { parseCLIArgs, loadConfig, main };
