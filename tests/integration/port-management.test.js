#!/usr/bin/env node

/**
 * Port Management System Integration Test
 *
 * Tests the complete port management and service orchestration system:
 * - Port Manager
 * - Service Registry
 * - Service Orchestrator
 * - Integration with Event Core
 *
 * Usage:
 *   node tests/integration/port-management.test.js
 */

const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

// Import components
const { PortManager, ServiceRegistry } = require('../../core/utils');
const { ServiceManager } = require('../../core/orchestrator');

// Test utilities
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`   ✅ ${message}`);
    testsPassed++;
  } else {
    console.error(`   ❌ ${message}`);
    testsFailed++;
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Cleanup registry file before tests
function cleanupRegistryFile() {
  const registryFile = path.join(process.cwd(), '.services.json');
  if (fs.existsSync(registryFile)) {
    fs.unlinkSync(registryFile);
  }
}

// ============================================================================
// Test Suite 1: Port Manager
// ============================================================================
async function testPortManager() {
  console.log('\n📦 Test Suite 1: Port Manager\n');

  const portManager = new PortManager({ basePort: 5000 });

  // Test 1.1: Find free port
  try {
    const port = await portManager.findFreePort(5000);
    assert(port >= 5000 && port < 6000, `Found free port: ${port}`);
  } catch (error) {
    assert(false, `Find free port failed: ${error.message}`);
  }

  // Test 1.2: Check port availability
  try {
    const available = await portManager.isPortAvailable(5000);
    assert(typeof available === 'boolean', `Port availability check returned boolean: ${available}`);
  } catch (error) {
    assert(false, `Port availability check failed: ${error.message}`);
  }

  // Test 1.3: Find port in range
  try {
    const port = await portManager.findFreePortInRange(6000, 6100);
    assert(port >= 6000 && port <= 6100, `Found port in range: ${port}`);
  } catch (error) {
    assert(false, `Find port in range failed: ${error.message}`);
  }

  // Test 1.4: Reserve and release port
  try {
    const port = await portManager.findFreePort(5100);
    portManager.reservePort(port);
    const stillAvailable = await portManager.isPortAvailable(port);
    assert(!stillAvailable, `Port ${port} correctly reserved`);

    portManager.releasePort(port);
    const availableAgain = await portManager.isPortAvailable(port);
    assert(availableAgain, `Port ${port} correctly released`);
  } catch (error) {
    assert(false, `Port reservation/release failed: ${error.message}`);
  }
}

// ============================================================================
// Test Suite 2: Service Registry
// ============================================================================
async function testServiceRegistry() {
  console.log('\n📦 Test Suite 2: Service Registry\n');

  cleanupRegistryFile();

  const registry = new ServiceRegistry({
    autocleanup: false // Disable for testing
  });

  // Test 2.1: Register service
  try {
    const serviceData = registry.register('test-core-a', 'EVENT_CORE', 3333, {
      version: '0.1.0',
      modules: ['echo', 'security-p2p']
    });

    assert(serviceData.id === 'test-core-a', 'Service registered with correct ID');
    assert(serviceData.type === 'EVENT_CORE', 'Service registered with correct type');
    assert(serviceData.port === 3333, 'Service registered with correct port');
    assert(serviceData.status === 'running', 'Service status is running');
  } catch (error) {
    assert(false, `Service registration failed: ${error.message}`);
  }

  // Test 2.2: Get service
  try {
    const service = registry.getService('test-core-a');
    assert(service !== null, 'Service retrieved successfully');
    assert(service.id === 'test-core-a', 'Retrieved service has correct ID');
  } catch (error) {
    assert(false, `Get service failed: ${error.message}`);
  }

  // Test 2.3: Heartbeat
  try {
    await sleep(100);
    const before = registry.getService('test-core-a').lastHeartbeatTimestamp;
    await sleep(100);

    const result = registry.heartbeat('test-core-a');
    const after = registry.getService('test-core-a').lastHeartbeatTimestamp;

    assert(result === true, 'Heartbeat returned true');
    assert(after > before, 'Heartbeat timestamp updated');
  } catch (error) {
    assert(false, `Heartbeat failed: ${error.message}`);
  }

  // Test 2.4: Get active services
  try {
    const services = registry.getActiveServices();
    assert(Object.keys(services).length > 0, 'Active services retrieved');
    assert('test-core-a' in services, 'Registered service in active services');
  } catch (error) {
    assert(false, `Get active services failed: ${error.message}`);
  }

  // Test 2.5: Get services by type
  try {
    const cores = registry.getServicesByType('EVENT_CORE');
    assert(cores.length === 1, 'Found 1 Event Core service');
    assert(cores[0].id === 'test-core-a', 'Service by type has correct ID');
  } catch (error) {
    assert(false, `Get services by type failed: ${error.message}`);
  }

  // Test 2.6: Find free port for type
  try {
    const port = await registry.findFreePort('EVENT_CORE');
    assert(port >= 3000 && port <= 3999, `Found free EVENT_CORE port: ${port}`);
  } catch (error) {
    assert(false, `Find free port for type failed: ${error.message}`);
  }

  // Test 2.7: Get stats
  try {
    const stats = registry.getStats();
    assert(stats.totalServices === 1, 'Stats show correct total services');
    assert(stats.byType.EVENT_CORE === 1, 'Stats show correct services by type');
    assert(stats.byStatus.running === 1, 'Stats show correct services by status');
  } catch (error) {
    assert(false, `Get stats failed: ${error.message}`);
  }

  // Test 2.8: Unregister service
  try {
    const result = registry.unregister('test-core-a');
    assert(result === true, 'Service unregistered successfully');

    const service = registry.getService('test-core-a');
    assert(service === null, 'Service no longer in registry after unregister');
  } catch (error) {
    assert(false, `Unregister failed: ${error.message}`);
  }

  // Test 2.9: Registry persistence
  try {
    registry.register('test-persist', 'EVENT_CORE', 3334);

    // Check file exists
    const registryFile = path.join(process.cwd(), '.services.json');
    assert(fs.existsSync(registryFile), 'Registry file created');

    // Load in new registry instance
    const registry2 = new ServiceRegistry({ autocleanup: false });
    const loaded = registry2.getService('test-persist');
    assert(loaded !== null, 'Service loaded from persisted file');

    registry2.clear();
  } catch (error) {
    assert(false, `Registry persistence failed: ${error.message}`);
  }

  registry.destroy();
  cleanupRegistryFile();
}

// ============================================================================
// Test Suite 3: Service Orchestrator
// ============================================================================
async function testServiceOrchestrator() {
  console.log('\n📦 Test Suite 3: Service Orchestrator\n');

  cleanupRegistryFile();

  const registry = new ServiceRegistry({ autocleanup: false });
  const manager = new ServiceManager({
    registry,
    startDelay: 500,
    healthCheckRetries: 5,
    healthCheckInterval: 500
  });

  // Test 3.1: Define services
  try {
    manager.define('test-service-a', {
      type: 'EVENT_CORE',
      command: 'echo',
      args: ['Service A running on port {PORT}'],
      dependsOn: []
    });

    manager.define('test-service-b', {
      type: 'EVENT_CORE',
      command: 'echo',
      args: ['Service B depends on A'],
      dependsOn: ['test-service-a']
    });

    manager.define('test-service-c', {
      type: 'EVENT_CORE',
      command: 'echo',
      args: ['Service C depends on B'],
      dependsOn: ['test-service-b']
    });

    assert(manager.definitions.size === 3, 'Three services defined');
  } catch (error) {
    assert(false, `Service definition failed: ${error.message}`);
  }

  // Test 3.2: Resolve start order
  try {
    const order = manager.resolveStartOrder();
    assert(Array.isArray(order), 'Start order is array');
    assert(order.length === 3, 'Start order includes all services');
    assert(order[0] === 'test-service-a', 'Service A starts first (no deps)');
    assert(order[1] === 'test-service-b', 'Service B starts second (deps: A)');
    assert(order[2] === 'test-service-c', 'Service C starts third (deps: B)');
  } catch (error) {
    assert(false, `Resolve start order failed: ${error.message}`);
  }

  // Test 3.3: Detect circular dependencies
  try {
    const manager2 = new ServiceManager({ registry });

    manager2.define('svc-x', {
      type: 'EVENT_CORE',
      command: 'echo',
      args: ['X'],
      dependsOn: ['svc-y']
    });

    manager2.define('svc-y', {
      type: 'EVENT_CORE',
      command: 'echo',
      args: ['Y'],
      dependsOn: ['svc-x']
    });

    let caughtError = false;
    try {
      manager2.resolveStartOrder();
    } catch (error) {
      caughtError = error.message.includes('Circular dependency');
    }

    assert(caughtError, 'Circular dependency detected correctly');
  } catch (error) {
    assert(false, `Circular dependency detection failed: ${error.message}`);
  }

  // Test 3.4: Print status
  try {
    // Just verify it doesn't crash
    manager.printStatus();
    assert(true, 'Print status executed without errors');
  } catch (error) {
    assert(false, `Print status failed: ${error.message}`);
  }

  registry.destroy();
  cleanupRegistryFile();
}

// ============================================================================
// Test Suite 4: CLI Scripts
// ============================================================================
async function testCLIScripts() {
  console.log('\n📦 Test Suite 4: CLI Scripts\n');

  // Test 4.1: orchestrator-cli.js exists
  try {
    const cliPath = path.join(__dirname, '..', '..', 'scripts', 'orchestrator-cli.js');
    const exists = fs.existsSync(cliPath);
    assert(exists, 'orchestrator-cli.js exists');
  } catch (error) {
    assert(false, `CLI script check failed: ${error.message}`);
  }

  // Test 4.2: services.sh exists and is executable
  try {
    const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'services.sh');
    const exists = fs.existsSync(scriptPath);
    assert(exists, 'services.sh exists');

    if (exists) {
      const stats = fs.statSync(scriptPath);
      const isExecutable = !!(stats.mode & fs.constants.S_IXUSR);
      assert(isExecutable, 'services.sh is executable');
    }
  } catch (error) {
    assert(false, `services.sh check failed: ${error.message}`);
  }

  // Test 4.3: start-multi-core.sh exists and is executable
  try {
    const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'start-multi-core.sh');
    const exists = fs.existsSync(scriptPath);
    assert(exists, 'start-multi-core.sh exists');

    if (exists) {
      const stats = fs.statSync(scriptPath);
      const isExecutable = !!(stats.mode & fs.constants.S_IXUSR);
      assert(isExecutable, 'start-multi-core.sh is executable');
    }
  } catch (error) {
    assert(false, `start-multi-core.sh check failed: ${error.message}`);
  }

  // Test 4.4: services.js config exists
  try {
    const configPath = path.join(__dirname, '..', '..', 'config', 'services.js');
    const exists = fs.existsSync(configPath);
    assert(exists, 'config/services.js exists');

    if (exists) {
      const services = require(configPath);
      assert(typeof services === 'object', 'services.js exports an object');
      assert('mqtt-broker' in services, 'mqtt-broker service defined');
      assert('core-a' in services, 'core-a service defined');
    }
  } catch (error) {
    assert(false, `services.js config check failed: ${error.message}`);
  }
}

// ============================================================================
// Test Suite 5: Integration with index.js
// ============================================================================
async function testIndexIntegration() {
  console.log('\n📦 Test Suite 5: Integration with index.js\n');

  // Test 5.1: ServiceRegistry import in index.js
  try {
    const indexPath = path.join(__dirname, '..', '..', 'index.js');
    const content = fs.readFileSync(indexPath, 'utf8');

    assert(content.includes('ServiceRegistry'), 'index.js imports ServiceRegistry');
    assert(content.includes('serviceRegistry:'), 'core state includes serviceRegistry');
    assert(content.includes('heartbeatTimer:'), 'core state includes heartbeatTimer');
    assert(content.includes('findFreePort'), 'index.js uses findFreePort');
    assert(content.includes('registry.register'), 'index.js registers service');
    assert(content.includes('heartbeat'), 'index.js has heartbeat logic');
    assert(content.includes('unregister'), 'index.js unregisters on shutdown');
  } catch (error) {
    assert(false, `index.js integration check failed: ${error.message}`);
  }
}

// ============================================================================
// Main Test Runner
// ============================================================================
async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║        Port Management System - Integration Tests         ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    await testPortManager();
    await testServiceRegistry();
    await testServiceOrchestrator();
    await testCLIScripts();
    await testIndexIntegration();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                      TEST RESULTS                          ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    console.log(`   ✅ Tests Passed: ${testsPassed}`);
    console.log(`   ❌ Tests Failed: ${testsFailed}`);
    console.log(`   📊 Total Tests:  ${testsPassed + testsFailed}\n`);

    if (testsFailed === 0) {
      console.log('🎉 All tests passed!\n');
      process.exit(0);
    } else {
      console.log('⚠️  Some tests failed.\n');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n💥 Test suite crashed:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run tests
if (require.main === module) {
  runAllTests();
}

module.exports = { runAllTests };
