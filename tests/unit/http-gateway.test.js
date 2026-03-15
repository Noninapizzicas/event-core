/**
 * Tests para HTTP API Gateway
 *
 * Run: node tests/unit/http-gateway.test.js
 */

const http = require('http');
const HTTPGateway = require('../../core/gateway/http');
const ModuleRegistry = require('../../core/modules/registry');
const HookManager = require('../../core/hooks');

// Test framework simple
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
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

// Helper: hacer request HTTP
function makeRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data.length > 0 ? JSON.parse(data) : null;
          resolve({ statusCode: res.statusCode, body: parsed, headers: res.headers });
        } catch (error) {
          resolve({ statusCode: res.statusCode, body: data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

// ============================================================================
// Tests
// ============================================================================

async function runTests() {
  console.log('🧪 Testing HTTP API Gateway\n');

  // ------------------------------------------------------------------------
  // Inicialización y lifecycle
  // ------------------------------------------------------------------------

  await test('HTTPGateway: debe inicializarse con opciones por defecto', async () => {
    const gateway = new HTTPGateway();
    assert(gateway.port === 3000, 'Puerto por defecto 3000');
    assert(gateway.host === '0.0.0.0', 'Host por defecto 0.0.0.0');
    assert(gateway.cors === true, 'CORS habilitado por defecto');
    assert(gateway.isRunning === false, 'No está corriendo inicialmente');
  });

  await test('HTTPGateway: debe aceptar opciones personalizadas', async () => {
    const gateway = new HTTPGateway({
      port: 4000,
      host: '127.0.0.1',
      cors: false,
      coreId: 'test-core'
    });
    assert(gateway.port === 4000, 'Puerto personalizado');
    assert(gateway.host === '127.0.0.1', 'Host personalizado');
    assert(gateway.cors === false, 'CORS deshabilitado');
    assert(gateway.coreId === 'test-core', 'Core ID personalizado');
  });

  await test('HTTPGateway: debe iniciar servidor HTTP', async () => {
    const gateway = new HTTPGateway({ port: 3001 });
    await gateway.start();
    assert(gateway.isRunning === true, 'Gateway está corriendo');
    assert(gateway.stats.started_at !== null, 'Timestamp de inicio registrado');
    await gateway.stop();
  });

  await test('HTTPGateway: debe detener servidor HTTP', async () => {
    const gateway = new HTTPGateway({ port: 3002 });
    await gateway.start();
    await gateway.stop();
    assert(gateway.isRunning === false, 'Gateway detenido');
  });

  await test('HTTPGateway: debe lanzar error si ya está corriendo', async () => {
    const gateway = new HTTPGateway({ port: 3003 });
    await gateway.start();
    try {
      await gateway.start();
      assert(false, 'Debería lanzar error');
    } catch (error) {
      assert(error.message.includes('already running'), 'Error correcto');
    }
    await gateway.stop();
  });

  // ------------------------------------------------------------------------
  // Health y Stats endpoints
  // ------------------------------------------------------------------------

  await test('HTTPGateway: /health debe retornar estado healthy', async () => {
    const gateway = new HTTPGateway({ port: 3004, coreId: 'test-core' });
    await gateway.start();

    const response = await makeRequest({
      host: 'localhost',
      port: 3004,
      path: '/health',
      method: 'GET'
    });

    assert(response.statusCode === 200, 'Status 200');
    assert(response.body.status === 'healthy', 'Estado healthy');
    assert(response.body.core_id === 'test-core', 'Core ID correcto');
    assert(typeof response.body.uptime === 'number', 'Uptime incluido');

    await gateway.stop();
  });

  await test('HTTPGateway: /stats debe retornar estadísticas', async () => {
    const gateway = new HTTPGateway({ port: 3005 });
    await gateway.start();

    const response = await makeRequest({
      host: 'localhost',
      port: 3005,
      path: '/stats',
      method: 'GET'
    });

    assert(response.statusCode === 200, 'Status 200');
    assert(typeof response.body.requests === 'number', 'Requests count');
    assert(typeof response.body.errors === 'number', 'Errors count');
    assert(typeof response.body.uptime === 'number', 'Uptime incluido');

    await gateway.stop();
  });

  // ------------------------------------------------------------------------
  // CORS
  // ------------------------------------------------------------------------

  await test('HTTPGateway: OPTIONS debe manejar CORS preflight', async () => {
    const gateway = new HTTPGateway({ port: 3006 });
    await gateway.start();

    const response = await makeRequest({
      host: 'localhost',
      port: 3006,
      path: '/test',
      method: 'OPTIONS'
    });

    assert(response.statusCode === 204, 'Status 204');
    assert(response.headers['access-control-allow-origin'] === '*', 'CORS origin');
    assert(response.headers['access-control-allow-methods'], 'CORS methods');

    await gateway.stop();
  });

  await test('HTTPGateway: debe agregar CORS headers a respuestas', async () => {
    const gateway = new HTTPGateway({ port: 3007 });
    await gateway.start();

    const response = await makeRequest({
      host: 'localhost',
      port: 3007,
      path: '/health',
      method: 'GET'
    });

    assert(response.headers['access-control-allow-origin'] === '*', 'CORS header presente');

    await gateway.stop();
  });

  await test('HTTPGateway: debe deshabilitar CORS si cors=false', async () => {
    const gateway = new HTTPGateway({ port: 3008, cors: false });
    await gateway.start();

    const response = await makeRequest({
      host: 'localhost',
      port: 3008,
      path: '/health',
      method: 'GET'
    });

    assert(!response.headers['access-control-allow-origin'], 'Sin CORS header');

    await gateway.stop();
  });

  // ------------------------------------------------------------------------
  // Enrutamiento y Module Registry
  // ------------------------------------------------------------------------

  await test('HTTPGateway: debe retornar 404 si API no existe', async () => {
    const registry = new ModuleRegistry();
    const gateway = new HTTPGateway({ port: 3009, registry });
    await gateway.start();

    const response = await makeRequest({
      host: 'localhost',
      port: 3009,
      path: '/modules/test/api',
      method: 'GET'
    });

    assert(response.statusCode === 404, 'Status 404');
    assert(response.body.error.message === 'API endpoint not found', 'Mensaje correcto');

    await gateway.stop();
  });

  await test('HTTPGateway: debe ejecutar handler de módulo registrado', async () => {
    const registry = new ModuleRegistry();

    // Registrar módulo con API
    registry.register('echo', {
      manifest: { name: 'echo', version: '1.0.0', description: 'Echo module' },
      instance: {},
      apis: [
        {
          name: 'ping',
          method: 'GET',
          path: '/ping',
          handler: async (req) => {
            return { message: 'pong', request_id: req.request_id };
          }
        }
      ]
    });

    const gateway = new HTTPGateway({ port: 3010, registry });
    await gateway.start();

    const response = await makeRequest({
      host: 'localhost',
      port: 3010,
      path: '/modules/echo/ping',
      method: 'GET'
    });

    assert(response.statusCode === 200, 'Status 200');
    assert(response.body.message === 'pong', 'Respuesta del handler');
    assert(typeof response.body.request_id === 'string', 'Request ID incluido');

    await gateway.stop();
  });

  await test('HTTPGateway: debe pasar query params al handler', async () => {
    const registry = new ModuleRegistry();

    registry.register('test', {
      manifest: { name: 'test', version: '1.0.0', description: 'Test' },
      instance: {},
      apis: [
        {
          name: 'echo-query',
          method: 'GET',
          path: '/echo',
          handler: async (req) => {
            return { query: req.query };
          }
        }
      ]
    });

    const gateway = new HTTPGateway({ port: 3011, registry });
    await gateway.start();

    const response = await makeRequest({
      host: 'localhost',
      port: 3011,
      path: '/modules/test/echo?foo=bar&baz=qux',
      method: 'GET'
    });

    assert(response.statusCode === 200, 'Status 200');
    assert(response.body.query.foo === 'bar', 'Query param foo');
    assert(response.body.query.baz === 'qux', 'Query param baz');

    await gateway.stop();
  });

  await test('HTTPGateway: debe parsear JSON body en POST', async () => {
    const registry = new ModuleRegistry();

    registry.register('test', {
      manifest: { name: 'test', version: '1.0.0', description: 'Test' },
      instance: {},
      apis: [
        {
          name: 'echo-body',
          method: 'POST',
          path: '/echo',
          handler: async (req) => {
            return { body: req.body };
          }
        }
      ]
    });

    const gateway = new HTTPGateway({ port: 3012, registry });
    await gateway.start();

    const response = await makeRequest({
      host: 'localhost',
      port: 3012,
      path: '/modules/test/echo',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, { message: 'hello', number: 123 });

    assert(response.statusCode === 200, 'Status 200');
    assert(response.body.body.message === 'hello', 'Body message');
    assert(response.body.body.number === 123, 'Body number');

    await gateway.stop();
  });

  await test('HTTPGateway: debe manejar errores del handler', async () => {
    const registry = new ModuleRegistry();

    registry.register('test', {
      manifest: { name: 'test', version: '1.0.0', description: 'Test' },
      instance: {},
      apis: [
        {
          name: 'error',
          method: 'GET',
          path: '/error',
          handler: async () => {
            throw new Error('Handler error');
          }
        }
      ]
    });

    const gateway = new HTTPGateway({ port: 3013, registry });
    await gateway.start();

    const response = await makeRequest({
      host: 'localhost',
      port: 3013,
      path: '/modules/test/error',
      method: 'GET'
    });

    assert(response.statusCode === 500, 'Status 500');
    assert(response.body.error.message === 'Handler execution failed', 'Error message');

    await gateway.stop();
  });

  // ------------------------------------------------------------------------
  // Hook integration
  // ------------------------------------------------------------------------

  await test('HTTPGateway: debe ejecutar hook beforeRequest', async () => {
    const registry = new ModuleRegistry();
    const hooks = new HookManager();

    let hookExecuted = false;

    hooks.register('beforeRequest', async (context) => {
      hookExecuted = true;
      // Modificar query params
      context.query.modified = 'true';
      return context;
    });

    registry.register('test', {
      manifest: { name: 'test', version: '1.0.0', description: 'Test' },
      instance: {},
      apis: [
        {
          name: 'test',
          method: 'GET',
          path: '/test',
          handler: async (req) => {
            return { query: req.query };
          }
        }
      ]
    });

    const gateway = new HTTPGateway({ port: 3014, registry, hooks });
    await gateway.start();

    const response = await makeRequest({
      host: 'localhost',
      port: 3014,
      path: '/modules/test/test',
      method: 'GET'
    });

    assert(hookExecuted === true, 'Hook ejecutado');
    assert(response.body.query.modified === 'true', 'Query modificado por hook');

    await gateway.stop();
  });

  await test('HTTPGateway: hook beforeRequest puede bloquear request', async () => {
    const registry = new ModuleRegistry();
    const hooks = new HookManager();

    hooks.register('beforeRequest', async () => {
      return null; // Bloquear
    });

    registry.register('test', {
      manifest: { name: 'test', version: '1.0.0', description: 'Test' },
      instance: {},
      apis: [
        {
          name: 'test',
          method: 'GET',
          path: '/test',
          handler: async () => ({ success: true })
        }
      ]
    });

    const gateway = new HTTPGateway({ port: 3015, registry, hooks });
    await gateway.start();

    const response = await makeRequest({
      host: 'localhost',
      port: 3015,
      path: '/modules/test/test',
      method: 'GET'
    });

    assert(response.statusCode === 403, 'Status 403');
    assert(response.body.error.message === 'Request blocked by hook', 'Bloqueado');

    await gateway.stop();
  });

  await test('HTTPGateway: debe ejecutar hook afterResponse', async () => {
    const registry = new ModuleRegistry();
    const hooks = new HookManager();

    hooks.register('afterResponse', async (context) => {
      // Agregar metadata a respuesta
      context.data.metadata = { hook_executed: true };
      return context;
    });

    registry.register('test', {
      manifest: { name: 'test', version: '1.0.0', description: 'Test' },
      instance: {},
      apis: [
        {
          name: 'test',
          method: 'GET',
          path: '/test',
          handler: async () => ({ message: 'hello' })
        }
      ]
    });

    const gateway = new HTTPGateway({ port: 3016, registry, hooks });
    await gateway.start();

    const response = await makeRequest({
      host: 'localhost',
      port: 3016,
      path: '/modules/test/test',
      method: 'GET'
    });

    assert(response.body.message === 'hello', 'Respuesta original');
    assert(response.body.metadata.hook_executed === true, 'Metadata agregado por hook');

    await gateway.stop();
  });

  // ------------------------------------------------------------------------
  // Estadísticas
  // ------------------------------------------------------------------------

  await test('HTTPGateway: debe actualizar estadísticas en cada request', async () => {
    const gateway = new HTTPGateway({ port: 3017 });
    await gateway.start();

    // Hacer varios requests
    await makeRequest({ host: 'localhost', port: 3017, path: '/health', method: 'GET' });
    await makeRequest({ host: 'localhost', port: 3017, path: '/health', method: 'GET' });

    const stats = gateway.getStats();
    assert(stats.requests === 2, 'Total requests');
    assert(stats.by_method.GET === 2, 'GET requests');
    assert(stats.by_status[200] === 2, 'Status 200 count');

    await gateway.stop();
  });

  await test('HTTPGateway: debe contar errores en estadísticas', async () => {
    const registry = new ModuleRegistry(); // Agregar registry para evitar error 500
    const gateway = new HTTPGateway({ port: 3018, registry });
    await gateway.start();

    // Request a endpoint no existente
    await makeRequest({ host: 'localhost', port: 3018, path: '/notfound', method: 'GET' });

    const stats = gateway.getStats();
    assert(stats.by_status[404] === 1, '404 count');

    await gateway.stop();
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
