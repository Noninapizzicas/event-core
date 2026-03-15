#!/usr/bin/env node

/**
 * Event Core CLI - Interfaz de línea de comandos
 *
 * Comandos disponibles:
 * - health              - Health check del gateway
 * - stats               - Gateway statistics
 * - call <method> <path> [data]  - Llamar API
 * - modules             - Listar módulos
 * - help                - Ayuda
 *
 * @example
 * # Health check
 * $ event-core health
 *
 * # Stats
 * $ event-core stats
 *
 * # Llamar API
 * $ event-core call GET /modules/echo/ping
 * $ event-core call POST /modules/echo/echo '{"message":"hello"}'
 *
 * # Listar módulos
 * $ event-core modules
 */

const CLIClient = require('./client');

// Parse args
const args = process.argv.slice(2);
const command = args[0];

// Config desde env vars
const config = {
  baseUrl: process.env.EVENT_CORE_URL || 'http://localhost:3000',
  timeout: parseInt(process.env.EVENT_CORE_TIMEOUT || '10000'),
  verbose: process.env.EVENT_CORE_VERBOSE === 'true'
};

const client = new CLIClient(config);

/**
 * Formatea output como JSON pretty
 */
function printJSON(data) {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Formatea error
 */
function printError(error) {
  console.error(`Error: ${error.message}`);
  if (error.statusCode) {
    console.error(`HTTP Status: ${error.statusCode}`);
  }
  if (error.response) {
    console.error(`Response: ${JSON.stringify(error.response, null, 2)}`);
  }
}

/**
 * Comando: health
 */
async function cmdHealth() {
  try {
    const health = await client.health();
    printJSON(health);
    process.exit(0);
  } catch (error) {
    printError(error);
    process.exit(1);
  }
}

/**
 * Comando: stats
 */
async function cmdStats() {
  try {
    const stats = await client.stats();
    printJSON(stats);
    process.exit(0);
  } catch (error) {
    printError(error);
    process.exit(1);
  }
}

/**
 * Comando: call <method> <path> [data]
 */
async function cmdCall() {
  const method = args[1]?.toUpperCase();
  const path = args[2];
  const dataArg = args[3];

  if (!method || !path) {
    console.error('Usage: event-core call <method> <path> [data]');
    console.error('Example: event-core call GET /modules/echo/ping');
    console.error('Example: event-core call POST /modules/echo/echo \'{"message":"hello"}\'');
    process.exit(1);
  }

  // Parse data si existe
  let data = null;
  if (dataArg) {
    try {
      data = JSON.parse(dataArg);
    } catch (error) {
      console.error('Error: Invalid JSON data');
      console.error(error.message);
      process.exit(1);
    }
  }

  try {
    const response = await client.request(method, path, data);
    printJSON(response.data);
    process.exit(0);
  } catch (error) {
    printError(error);
    process.exit(1);
  }
}

/**
 * Comando: modules
 */
async function cmdModules() {
  try {
    const stats = await client.stats();

    console.log(`Total APIs: ${stats.total_apis || 0}`);
    console.log(`\nAvailable APIs:`);

    if (stats.apis && stats.apis.length > 0) {
      for (const api of stats.apis) {
        console.log(`  ${api.method.padEnd(6)} ${api.path}`);
        if (api.moduleName) {
          console.log(`         → Module: ${api.moduleName}`);
        }
      }
    } else {
      console.log('  (no APIs registered)');
    }

    process.exit(0);
  } catch (error) {
    printError(error);
    process.exit(1);
  }
}

/**
 * Comando: help
 */
function cmdHelp() {
  console.log(`
Event Core CLI v0.1.0

Usage: event-core <command> [options]

Commands:
  health                        Health check del gateway
  stats                         Gateway statistics
  call <method> <path> [data]   Llamar API del gateway
  modules                       Listar módulos y APIs disponibles
  help                          Mostrar ayuda

Environment Variables:
  EVENT_CORE_URL                URL base del gateway (default: http://localhost:3000)
  EVENT_CORE_TIMEOUT            Timeout en ms (default: 10000)
  EVENT_CORE_VERBOSE            Modo verbose (default: false)

Examples:
  # Health check
  $ event-core health

  # Gateway stats
  $ event-core stats

  # Llamar API GET
  $ event-core call GET /modules/echo/ping

  # Llamar API POST con data
  $ event-core call POST /modules/echo/echo '{"message":"hello world"}'

  # Listar módulos
  $ event-core modules

  # Verbose mode
  $ EVENT_CORE_VERBOSE=true event-core health

  # Custom gateway URL
  $ EVENT_CORE_URL=http://localhost:4000 event-core health
`);
  process.exit(0);
}

// Router de comandos
async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    cmdHelp();
    return;
  }

  switch (command) {
    case 'health':
      await cmdHealth();
      break;

    case 'stats':
      await cmdStats();
      break;

    case 'call':
      await cmdCall();
      break;

    case 'modules':
      await cmdModules();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "event-core help" for usage information');
      process.exit(1);
  }
}

// Run
main().catch(error => {
  printError(error);
  process.exit(1);
});
