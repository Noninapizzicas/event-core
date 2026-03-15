/**
 * Tests para RouteCode - Sistema de códigos numéricos de ruta
 *
 * Run: node tests/unit/route-code.test.js
 */

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

// Mock handler
const mockHandler = async () => ({ status: 200, data: { ok: true } });

// ============================================================================
// Tests
// ============================================================================

async function runTests() {
  console.log('🧪 Testing RouteCode System\n');

  // ------------------------------------------------------------------------
  // Registro con routeCode
  // ------------------------------------------------------------------------

  let registry;

  await test('Registry: debe registrar módulo con routeCode', async () => {
    registry = new ModuleRegistry();

    registry.register('certificate-authority', {
      manifest: {
        version: '1.0.0',
        description: 'CA module',
        routeCode: '3333'
      },
      instance: {},
      apis: [
        { name: 'status', method: 'GET', path: '/status', handler: mockHandler },
        { name: 'issue', method: 'POST', path: '/issue', handler: mockHandler },
        { name: 'revoke', method: 'POST', path: '/revoke', handler: mockHandler },
        { name: 'list', method: 'GET', path: '/list', handler: mockHandler }
      ],
      hooks: []
    });

    assert(registry.codeIndex.has('3333'), 'Código 3333 registrado');
    assert(registry.codeIndex.get('3333') === 'certificate-authority', 'Apunta al módulo correcto');
  });

  await test('Registry: debe encontrar API por ruta estándar /modules/...', async () => {
    const api = registry.findAPI('/modules/certificate-authority/status', 'GET');

    assert(api !== null, 'API encontrada');
    assert(api.moduleName === 'certificate-authority', 'Módulo correcto');
    assert(api.apiName === 'status', 'API name correcto');
  });

  await test('Registry: debe encontrar API por código numérico /3333/...', async () => {
    const api = registry.findAPI('/3333/status', 'GET');

    assert(api !== null, 'API encontrada via código');
    assert(api.moduleName === 'certificate-authority', 'Módulo correcto');
    assert(api.apiName === 'status', 'API name correcto');
  });

  await test('Registry: POST también funciona via código', async () => {
    const issueApi = registry.findAPI('/3333/issue', 'POST');
    assert(issueApi !== null, 'POST /3333/issue encontrado');
    assert(issueApi.apiName === 'issue', 'API name correcto');

    const revokeApi = registry.findAPI('/3333/revoke', 'POST');
    assert(revokeApi !== null, 'POST /3333/revoke encontrado');
    assert(revokeApi.apiName === 'revoke', 'API name correcto');
  });

  await test('Registry: GET con otro path funciona via código', async () => {
    const api = registry.findAPI('/3333/list', 'GET');
    assert(api !== null, 'GET /3333/list encontrado');
    assert(api.apiName === 'list', 'API name correcto');
  });

  await test('Registry: debe rechazar método incorrecto via código', async () => {
    const api = registry.findAPI('/3333/issue', 'GET'); // issue es POST
    assert(api === null, 'No debería encontrar GET para ruta POST');
  });

  await test('Registry: debe rechazar código inexistente', async () => {
    const api = registry.findAPI('/9999/status', 'GET');
    assert(api === null, 'No debería encontrar código 9999');
  });

  await test('Registry: debe rechazar path inexistente bajo código válido', async () => {
    const api = registry.findAPI('/3333/no-existe', 'GET');
    assert(api === null, 'No debería encontrar path inexistente');
  });

  // ------------------------------------------------------------------------
  // Rutas con parámetros dinámicos + routeCode
  // ------------------------------------------------------------------------

  await test('Registry: routeCode con parámetros dinámicos', async () => {
    const registry2 = new ModuleRegistry();

    registry2.register('device-manager', {
      manifest: {
        version: '1.0.0',
        description: 'Device manager',
        routeCode: '4444'
      },
      instance: {},
      apis: [
        { name: 'getDevice', method: 'GET', path: '/devices/:id', handler: mockHandler },
        { name: 'listDevices', method: 'GET', path: '/devices', handler: mockHandler }
      ],
      hooks: []
    });

    // Ruta estándar con params
    const stdApi = registry2.findAPI('/modules/device-manager/devices/abc123', 'GET');
    assert(stdApi !== null, 'Encontrado via ruta estándar');
    assert(stdApi.params.id === 'abc123', 'Params extraídos correctamente');

    // Ruta por código con params
    const codeApi = registry2.findAPI('/4444/devices/abc123', 'GET');
    assert(codeApi !== null, 'Encontrado via código con params');
    assert(codeApi.params.id === 'abc123', 'Params extraídos via código');

    // Ruta exacta sin params
    const listApi = registry2.findAPI('/4444/devices', 'GET');
    assert(listApi !== null, 'List encontrado via código');
    assert(listApi.apiName === 'listDevices', 'API name correcto');
  });

  // ------------------------------------------------------------------------
  // Múltiples módulos con routeCode
  // ------------------------------------------------------------------------

  await test('Registry: múltiples módulos con diferentes códigos', async () => {
    const registry3 = new ModuleRegistry();

    registry3.register('mod-a', {
      manifest: { version: '1.0.0', routeCode: '1111' },
      instance: {},
      apis: [{ name: 'ping', method: 'GET', path: '/ping', handler: mockHandler }],
      hooks: []
    });

    registry3.register('mod-b', {
      manifest: { version: '1.0.0', routeCode: '2222' },
      instance: {},
      apis: [{ name: 'ping', method: 'GET', path: '/ping', handler: mockHandler }],
      hooks: []
    });

    const apiA = registry3.findAPI('/1111/ping', 'GET');
    assert(apiA !== null, 'Módulo A encontrado');
    assert(apiA.moduleName === 'mod-a', 'Es mod-a');

    const apiB = registry3.findAPI('/2222/ping', 'GET');
    assert(apiB !== null, 'Módulo B encontrado');
    assert(apiB.moduleName === 'mod-b', 'Es mod-b');
  });

  // ------------------------------------------------------------------------
  // Módulo sin routeCode (compatibilidad)
  // ------------------------------------------------------------------------

  await test('Registry: módulo sin routeCode sigue funcionando normal', async () => {
    const registry4 = new ModuleRegistry();

    registry4.register('normal-module', {
      manifest: { version: '1.0.0' },
      instance: {},
      apis: [{ name: 'status', method: 'GET', path: '/status', handler: mockHandler }],
      hooks: []
    });

    const api = registry4.findAPI('/modules/normal-module/status', 'GET');
    assert(api !== null, 'Ruta estándar funciona');

    assert(registry4.codeIndex.size === 0, 'Sin códigos registrados');
  });

  // ------------------------------------------------------------------------
  // Unregister limpia rutas por código
  // ------------------------------------------------------------------------

  await test('Registry: unregister limpia rutas por código', async () => {
    const registry5 = new ModuleRegistry();

    registry5.register('temp-mod', {
      manifest: { version: '1.0.0', routeCode: '5555' },
      instance: {},
      apis: [{ name: 'test', method: 'GET', path: '/test', handler: mockHandler }],
      hooks: []
    });

    // Verificar que existe
    assert(registry5.findAPI('/5555/test', 'GET') !== null, 'Existe antes de unregister');
    assert(registry5.codeIndex.has('5555'), 'Código en index');

    // Unregister
    registry5.unregister('temp-mod');

    // Verificar que se limpió
    assert(registry5.findAPI('/5555/test', 'GET') === null, 'No existe después de unregister');
    assert(!registry5.codeIndex.has('5555'), 'Código eliminado del index');
    assert(registry5.findAPI('/modules/temp-mod/test', 'GET') === null, 'Ruta estándar también limpia');
  });

  // ------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------

  await test('Registry: resolveCode devuelve nombre de módulo', async () => {
    assert(registry.resolveCode('3333') === 'certificate-authority', 'Resuelve 3333');
    assert(registry.resolveCode('9999') === null, 'Null para código desconocido');
  });

  await test('Registry: getRouteCodes devuelve mapa completo', async () => {
    const codes = registry.getRouteCodes();
    assert(codes['3333'] === 'certificate-authority', 'Mapa correcto');
  });

  await test('Registry: getStats incluye route_codes', async () => {
    const stats = registry.getStats();
    assert(typeof stats.total_route_codes === 'number', 'Tiene total_route_codes');
    assert(stats.total_route_codes >= 1, 'Al menos 1 código');
  });

  // ------------------------------------------------------------------------
  // Resultados
  // ------------------------------------------------------------------------

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Tests: ${testsPassed} passed, ${testsFailed} failed, ${testsPassed + testsFailed} total`);
  console.log(`${'='.repeat(50)}`);

  if (testsFailed > 0) {
    process.exit(1);
  }
}

runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
