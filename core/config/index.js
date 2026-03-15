/**
 * Config Loader
 *
 * Loads configuration from:
 * 1. Default config.json
 * 2. Environment-specific config (config.{NODE_ENV}.json)
 * 3. Environment variables (EVENT_CORE_*)
 * 4. CLI arguments
 *
 * Priority (highest to lowest):
 * CLI args > ENV vars > config.{NODE_ENV}.json > config.json
 *
 * @example
 * const config = loadConfig({ cliArgs: { port: 3001 } });
 * console.log(config.http.port); // 3001
 */

const fs = require('fs');
const path = require('path');

/**
 * Deep merge two objects
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key in source) {
    if (source[key] instanceof Object && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Load JSON config file
 */
function loadConfigFile(configPath) {
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.warn(`Warning: Failed to load config from ${configPath}: ${error.message}`);
  }
  return {};
}

/**
 * Extract config from environment variables
 *
 * Maps env vars like EVENT_CORE_HTTP_PORT=3001 to config.http.port
 */
function loadFromEnv() {
  const config = {};

  // Simple mappings
  const envMappings = {
    'EVENT_CORE_ID': 'core.id',
    'EVENT_CORE_ENV': 'core.environment',
    'EVENT_CORE_PORT': 'http.port',
    'EVENT_CORE_HTTP_HOST': 'http.host',
    'EVENT_CORE_BROKER_PORT': 'mqtt.broker.port',
    'EVENT_CORE_BROKER_HOST': 'mqtt.broker.host',
    'EVENT_CORE_BROKER_URL': 'mqtt.broker.url',
    'EVENT_CORE_MODULES_PATH': 'modules.path',
    'EVENT_CORE_LOG_LEVEL': 'observability.logging.level',
    'EVENT_CORE_TRACING_ENABLED': 'observability.tracing.enabled',
    'EVENT_CORE_METRICS_ENABLED': 'observability.metrics.enabled',
    'EVENT_CORE_ENCRYPTION_ENABLED': 'security.encryption.enabled'
  };

  for (const [envKey, configPath] of Object.entries(envMappings)) {
    if (process.env[envKey]) {
      let value = process.env[envKey];

      // Type coercion
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (!isNaN(value)) value = parseInt(value);

      // Set nested value
      const parts = configPath.split('.');
      let current = config;

      for (let i = 0; i < parts.length - 1; i++) {
        if (!current[parts[i]]) current[parts[i]] = {};
        current = current[parts[i]];
      }

      current[parts[parts.length - 1]] = value;
    }
  }

  return config;
}

/**
 * Validate config
 */
function validateConfig(config) {
  const errors = [];

  // Required fields
  if (!config.core?.id) {
    errors.push('core.id is required');
  }

  if (!config.http?.port || config.http.port < 1 || config.http.port > 65535) {
    errors.push('http.port must be between 1 and 65535');
  }

  if (!config.mqtt?.broker?.port || config.mqtt.broker.port < 1 || config.mqtt.broker.port > 65535) {
    errors.push('mqtt.broker.port must be between 1 and 65535');
  }

  if (!config.modules?.path) {
    errors.push('modules.path is required');
  }

  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n  - ${errors.join('\n  - ')}`);
  }

  return true;
}

/**
 * Load complete configuration
 *
 * @param {Object} options - Load options
 * @param {string} options.configPath - Path to config.json (default: ./config.json)
 * @param {Object} options.cliArgs - CLI arguments to override config
 * @param {boolean} options.validate - Validate config (default: true)
 * @returns {Object} Merged configuration
 */
function loadConfig(options = {}) {
  const {
    configPath = path.resolve(__dirname, '../../config.json'),
    cliArgs = {},
    validate = true
  } = options;

  const env = process.env.NODE_ENV || 'development';

  // Step 1: Load base config.json
  let config = loadConfigFile(configPath);

  // Step 2: Load environment-specific config (config.production.json, etc)
  const envConfigPath = configPath.replace('.json', `.${env}.json`);
  const envConfig = loadConfigFile(envConfigPath);
  config = deepMerge(config, envConfig);

  // Step 3: Merge environment variables
  const envVars = loadFromEnv();
  config = deepMerge(config, envVars);

  // Step 4: Merge CLI arguments (highest priority)
  if (Object.keys(cliArgs).length > 0) {
    const cliConfig = {};

    if (cliArgs.coreId) cliConfig.core = { id: cliArgs.coreId };
    if (cliArgs.httpPort) {
      cliConfig.http = { port: cliArgs.httpPort };
    }
    if (cliArgs.brokerPort) {
      cliConfig.mqtt = { broker: { port: cliArgs.brokerPort } };
    }
    if (cliArgs.modulesPath) {
      cliConfig.modules = { path: cliArgs.modulesPath };
    }
    if (cliArgs.logLevel) {
      cliConfig.observability = { logging: { level: cliArgs.logLevel } };
    }

    config = deepMerge(config, cliConfig);
  }

  // Step 5: Validate
  if (validate) {
    validateConfig(config);
  }

  return config;
}

/**
 * Get a nested config value
 *
 * @param {Object} config - Config object
 * @param {string} path - Dot-separated path (e.g., 'http.port')
 * @param {*} defaultValue - Default value if not found
 * @returns {*} Config value
 *
 * @example
 * const port = getConfigValue(config, 'http.port', 3000);
 */
function getConfigValue(config, path, defaultValue = undefined) {
  const parts = path.split('.');
  let current = config;

  for (const part of parts) {
    if (current[part] === undefined) {
      return defaultValue;
    }
    current = current[part];
  }

  return current;
}

module.exports = {
  loadConfig,
  getConfigValue,
  deepMerge,
  validateConfig
};
