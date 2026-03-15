/**
 * Tests para CLI HTTP Client
 *
 * Run: node tests/unit/cli.test.js
 */

const CLIClient = require('../../cli/client');
const HTTPGateway = require('../../core/gateway/http');
const ModuleRegistry = require('../../core/modules/registry');

// Test framework
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function test(description, fn) {
  try {
    await fn();
    console.log(`✓ ${description}`);
    testsPassed++;
  } catch (error) {
    console.error(`✗ ${description}`);
    console.error(`  ${error.message}`);
    testsFailed++;
  }
}

// Helper: sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Tests
// ============================================================================

async function runTests() {
  console.log('🧪 Testing CLI HTTP Client\n');

  // Setup: Iniciar gateway de prueba
  const registry = new ModuleRegistry();
  const gateway = new HTTPGateway({
    port: 5000,
    registry,
    coreId: 'test-cli'
  });

  await gateway.start();
  await sleep(100);

  const client = new CLIClient({
    baseUrl: 'http://localhost:5000',
    timeout: 5000,
    verbose: false
  });

  // ------------------------------------------------------------------------
  // Tests básicos
  // ------------------------------------------------------------------------

  await test('CLIClient: debe inicializarse con opciones por defecto', async () => {
    const defaultClient = new CLIClient();
    assert(defaultClient.baseUrl === 'http://localhost:3000', 'Base URL por defecto');
    assert(defaultClient.timeout === 10000, 'Timeout por defecto');
    assert(defaultClient.verbose === false, 'Verbose por defecto');
  });

  await test('CLIClient: debe aceptar opciones personalizadas', async () => {
    const customClient = new CLIClient({
      baseUrl: 'http://example.com:8080',
      timeout: 5000,
      verbose: true
    });
    assert(customClient.baseUrl === 'http://example.com:8080', 'Base URL personalizada');
    assert(customClient.timeout === 5000, 'Timeout personalizado');
    assert(customClient.verbose === true, 'Verbose activado');
  });

  // ------------------------------------------------------------------------
  // HTTP Methods
  // ------------------------------------------------------------------------

  await test('CLIClient: GET /health debe retornar status', async () => {
    const health = await client.get('/health');
    assert(health.status === 'healthy', 'Status healthy');
    assert(health.core_id === 'test-cli', 'Core ID correcto');
  });

  await test('CLIClient: health() shortcut debe funcionar', async () => {
    const health = await client.health();
    assert(health.status === 'healthy', 'Status healthy');
  });

  await test('CLIClient: GET /stats debe retornar estadísticas', async () => {
    const stats = await client.get('/stats');
    assert(typeof stats.requests === 'number', 'Stats tiene requests');
    assert(typeof stats.errors === 'number', 'Stats tiene errors');
  });

  await test('CLIClient: stats() shortcut debe funcionar', async () => {
    const stats = await client.stats();
    assert(typeof stats.requests === 'number', 'Stats tiene requests');
  });

  await test('CLIClient: GET a endpoint inexistente debe fallar', async () => {
    try {
      await client.get('/notfound');
      assert(false, 'Debería lanzar error');
    } catch (error) {
      assert(error.statusCode === 404, 'Status 404');
    }
  });

  await test('CLIClient: request() con método personalizado', async () => {
    const response = await client.request('GET', '/health');
    assert(response.statusCode === 200, 'Status 200');
    assert(response.data.status === 'healthy', 'Data correcta');
  });

  // ------------------------------------------------------------------------
  // Timeout
  // ------------------------------------------------------------------------

  await test('CLIClient: debe manejar timeout', async () => {
    const slowClient = new CLIClient({
      baseUrl: 'http://localhost:9999', // Puerto inexistente
      timeout: 100
    });

    try {
      await slowClient.get('/health');
      assert(false, 'Debería lanzar error de timeout');
    } catch (error) {
      // El error puede ser ECONNREFUSED o TIMEOUT dependiendo del timing
      assert(
        error.code === 'TIMEOUT' || error.code === 'ECONNREFUSED',
        'Error de timeout o conexión rechazada'
      );
    }
  });

  // ------------------------------------------------------------------------
  // Error handling
  // ------------------------------------------------------------------------

  await test('CLIClient: debe manejar errores HTTP 4xx', async () => {
    try {
      await client.get('/modules/nonexistent/api');
      assert(false, 'Debería lanzar error');
    } catch (error) {
      assert(error.statusCode === 404, 'Status 404');
      assert(error.message, 'Tiene mensaje de error');
    }
  });

  // ------------------------------------------------------------------------
  // Verbose mode
  // ------------------------------------------------------------------------

  await test('CLIClient: modo verbose debe funcionar', async () => {
    const verboseClient = new CLIClient({
      baseUrl: 'http://localhost:5000',
      verbose: true
    });

    // Capturar stderr
    let stderrOutput = '';
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrOutput += chunk.toString();
      return true;
    };

    await verboseClient.get('/health');

    process.stderr.write = originalStderrWrite;

    assert(stderrOutput.includes('GET'), 'Verbose muestra método');
    assert(stderrOutput.includes('200'), 'Verbose muestra status');
  });

  // ------------------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------------------

  await test('Cleanup: debe cerrar gateway', async () => {
    await gateway.stop();
    assert(gateway.isRunning === false, 'Gateway detenido');
  });

  // ------------------------------------------------------------------------
  // Resumen
  // ------------------------------------------------------------------------

  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ Tests passed: ${testsPassed}`);
  console.log(`❌ Tests failed: ${testsFailed}`);
  console.log(`📊 Total: ${testsPassed + testsFailed}`);
  console.log(`${'='.repeat(60)}\n`);

  process.exit(testsFailed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(error => {
  console.error('\n❌ Test suite failed:', error);
  process.exit(1);
});
