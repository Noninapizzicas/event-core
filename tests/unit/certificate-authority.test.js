/**
 * Tests para Certificate Authority Module
 *
 * Run: node tests/unit/certificate-authority.test.js
 */

const fs = require('fs');
const path = require('path');
const CAManager = require('../../modules/certificate-authority/ca-manager');
const MTLSMiddleware = require('../../modules/certificate-authority/mtls-middleware');
const CertificateAuthorityModule = require('../../modules/certificate-authority');

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

// Test data directory
const TEST_CA_PATH = path.join(__dirname, '..', '.tmp-test-ca');

function cleanup() {
  if (fs.existsSync(TEST_CA_PATH)) {
    fs.rmSync(TEST_CA_PATH, { recursive: true, force: true });
  }
}

// ============================================================================
// Tests
// ============================================================================

async function runTests() {
  console.log('🧪 Testing Certificate Authority Module\n');

  cleanup();

  // ------------------------------------------------------------------------
  // CAManager Tests
  // ------------------------------------------------------------------------

  let ca;

  await test('CAManager: debe inicializar y generar CA raíz', async () => {
    ca = new CAManager({ storagePath: TEST_CA_PATH });
    const result = await ca.initialize();

    assert(result.created === true, 'CA debería haberse creado');
    assert(result.loaded === true, 'CA debería estar cargada');
    assert(ca.caCert, 'CA cert debería existir');
    assert(ca.caKey, 'CA key debería existir');
    assert(ca.caCert.includes('-----BEGIN CERTIFICATE-----'), 'CA cert en formato PEM');
  });

  await test('CAManager: debe cargar CA existente sin regenerar', async () => {
    const ca2 = new CAManager({ storagePath: TEST_CA_PATH });
    const result = await ca2.initialize();

    assert(result.created === false, 'No debería recrear la CA');
    assert(result.loaded === true, 'Debería cargar la existente');
    assert(ca2.caCert === ca.caCert, 'Mismo certificado CA');
  });

  await test('CAManager: debe emitir certificado cliente', async () => {
    const cert = await ca.issueCertificate({
      commonName: 'Test Client: Pizzería Roma',
      type: 'client',
      identifier: 'project-001',
      organization: 'Pizzería Roma SL',
      email: 'admin@pizzeriaroma.com'
    });

    assert(cert.serialNumber, 'Tiene número de serie');
    assert(cert.certificate, 'Tiene certificado PEM');
    assert(cert.privateKey, 'Tiene clave privada');
    assert(cert.fingerprint, 'Tiene fingerprint');
    assert(cert.metadata.type === 'client', 'Tipo correcto');
    assert(cert.metadata.identifier === 'project-001', 'Identifier correcto');
    assert(cert.metadata.status === 'active', 'Estado activo');
    assert(cert.certificate.includes('-----BEGIN CERTIFICATE-----'), 'Cert en PEM');
  });

  await test('CAManager: debe emitir certificado dispositivo', async () => {
    const cert = await ca.issueCertificate({
      commonName: 'Portátil-Dev-01',
      type: 'device',
      identifier: 'device-macbook-001'
    });

    assert(cert.metadata.type === 'device', 'Tipo dispositivo');
    assert(cert.metadata.identifier === 'device-macbook-001', 'Device ID correcto');
  });

  await test('CAManager: debe rechazar tipo inválido', async () => {
    try {
      await ca.issueCertificate({
        commonName: 'Test',
        type: 'invalid',
        identifier: 'x'
      });
      assert(false, 'Debería haber lanzado error');
    } catch (e) {
      assert(e.message.includes('type must be'), 'Error correcto');
    }
  });

  await test('CAManager: debe rechazar sin commonName', async () => {
    try {
      await ca.issueCertificate({ type: 'client', identifier: 'x' });
      assert(false, 'Debería haber lanzado error');
    } catch (e) {
      assert(e.message.includes('commonName'), 'Error correcto');
    }
  });

  let issuedSerial;

  await test('CAManager: debe verificar certificado válido', async () => {
    const cert = await ca.issueCertificate({
      commonName: 'Verify Test',
      type: 'client',
      identifier: 'project-verify'
    });
    issuedSerial = cert.serialNumber;

    const result = ca.verifyCertificate(cert.certificate);
    assert(result.valid === true, 'Certificado debería ser válido');
    assert(result.type === 'client', 'Tipo correcto');
    assert(result.identifier === 'project-verify', 'Identifier correcto');
  });

  await test('CAManager: debe revocar certificado', async () => {
    const result = ca.revokeCertificate(issuedSerial, 'test-revocation');

    assert(result.revoked === true, 'Debería estar revocado');
    assert(result.serialNumber === issuedSerial, 'Serial correcto');
  });

  await test('CAManager: certificado revocado no debe ser válido', async () => {
    // Re-leer el cert del disco
    const certPath = path.join(TEST_CA_PATH, 'certs', issuedSerial, 'cert.pem');
    const certPem = fs.readFileSync(certPath, 'utf8');

    const result = ca.verifyCertificate(certPem);
    assert(result.valid === false, 'No debería ser válido');
    assert(result.error.includes('revoked'), 'Error de revocación');
  });

  await test('CAManager: no debe revocar certificado ya revocado', async () => {
    const result = ca.revokeCertificate(issuedSerial);
    assert(result.revoked === false, 'No debería revocarse de nuevo');
    assert(result.error.includes('already revoked'), 'Error correcto');
  });

  await test('CAManager: debe listar certificados', async () => {
    const all = ca.listCertificates();
    assert(all.length >= 3, 'Al menos 3 certificados emitidos');

    const clients = ca.listCertificates({ type: 'client' });
    assert(clients.length >= 2, 'Al menos 2 clientes');

    const devices = ca.listCertificates({ type: 'device' });
    assert(devices.length >= 1, 'Al menos 1 dispositivo');
  });

  await test('CAManager: debe filtrar por estado', async () => {
    const active = ca.listCertificates({ status: 'active' });
    const revoked = ca.listCertificates({ status: 'revoked' });

    assert(active.length >= 2, 'Al menos 2 activos');
    assert(revoked.length >= 1, 'Al menos 1 revocado');
  });

  await test('CAManager: debe renovar certificado', async () => {
    const original = await ca.issueCertificate({
      commonName: 'Renew Test',
      type: 'device',
      identifier: 'device-renew'
    });

    const renewed = await ca.renewCertificate(original.serialNumber);

    assert(renewed.serialNumber !== original.serialNumber, 'Nuevo serial');
    assert(renewed.previousSerialNumber === original.serialNumber, 'Referencia al anterior');

    // El original debe estar revocado
    const certPath = path.join(TEST_CA_PATH, 'certs', original.serialNumber, 'metadata.json');
    const oldMeta = JSON.parse(fs.readFileSync(certPath, 'utf8'));
    assert(oldMeta.status === 'revoked', 'Original revocado');
    assert(oldMeta.revokeReason === 'superseded', 'Razón: superseded');
  });

  await test('CAManager: debe obtener CRL', async () => {
    const crl = ca.getCRL();
    assert(Array.isArray(crl), 'CRL es array');
    assert(crl.length >= 2, 'Al menos 2 revocaciones');
    assert(crl[0].serialNumber, 'Tiene serialNumber');
    assert(crl[0].revokedAt, 'Tiene fecha de revocación');
  });

  await test('CAManager: debe obtener estadísticas', async () => {
    const stats = ca.getStats();
    assert(stats.total >= 4, 'Al menos 4 certificados');
    assert(stats.active >= 2, 'Al menos 2 activos');
    assert(stats.revoked >= 2, 'Al menos 2 revocados');
    assert(stats.ca_initialized === true, 'CA inicializada');
    assert(typeof stats.by_type.client === 'number', 'Stats por tipo');
    assert(typeof stats.by_type.device === 'number', 'Stats por tipo device');
  });

  await test('CAManager: debe crear bundle P12', async () => {
    const cert = await ca.issueCertificate({
      commonName: 'P12 Test',
      type: 'client',
      identifier: 'project-p12',
      passphrase: 'testpass123'
    });

    assert(cert.p12, 'Tiene bundle P12');
    assert(Buffer.isBuffer(cert.p12), 'P12 es Buffer');

    // Debe poder recuperar el bundle
    const retrieved = ca.getP12Bundle(cert.serialNumber);
    assert(retrieved, 'Bundle recuperado');
  });

  await test('CAManager: P12 de revocado debe ser null', async () => {
    const cert = await ca.issueCertificate({
      commonName: 'P12 Revoke Test',
      type: 'client',
      identifier: 'project-p12-revoke'
    });

    ca.revokeCertificate(cert.serialNumber, 'test');
    const p12 = ca.getP12Bundle(cert.serialNumber);
    assert(p12 === null, 'P12 eliminado tras revocación');
  });

  await test('CAManager: debe rechazar certificado no firmado por CA', async () => {
    const fakeCert = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';
    const result = ca.verifyCertificate(fakeCert);
    assert(result.valid === false, 'No debería ser válido');
  });

  // ------------------------------------------------------------------------
  // MTLSMiddleware Tests
  // ------------------------------------------------------------------------

  console.log('');

  let middleware;

  await test('MTLSMiddleware: debe inicializar correctamente', async () => {
    middleware = new MTLSMiddleware({
      caManager: ca,
      excludePaths: ['/health', '/public/*'],
      allowUnauthenticated: false
    });

    assert(middleware.mode === 'proxy', 'Modo proxy por defecto');
    assert(middleware.stats.authenticated === 0, 'Stats en cero');
  });

  await test('MTLSMiddleware: debe excluir paths configurados', async () => {
    const result = await middleware.authenticate({
      path: '/health',
      headers: {}
    });

    assert(result !== null, 'No debería bloquear /health');
    assert(middleware.stats.bypassed === 1, 'Incrementó bypassed');
  });

  await test('MTLSMiddleware: debe excluir paths con wildcard', async () => {
    const result = await middleware.authenticate({
      path: '/public/assets/logo.png',
      headers: {}
    });

    assert(result !== null, 'No debería bloquear /public/*');
  });

  await test('MTLSMiddleware: debe rechazar request sin certificado', async () => {
    const result = await middleware.authenticate({
      path: '/modules/facturacion/facturas',
      headers: {}
    });

    assert(result === null, 'Debería bloquear sin certificado');
    assert(middleware.stats.rejected >= 1, 'Incrementó rejected');
  });

  await test('MTLSMiddleware: debe autenticar con certificado válido', async () => {
    const cert = await ca.issueCertificate({
      commonName: 'mTLS Test Client',
      type: 'client',
      identifier: 'project-mtls'
    });

    const result = await middleware.authenticate({
      path: '/modules/facturacion/facturas',
      headers: {
        'x-client-cert': encodeURIComponent(cert.certificate)
      }
    });

    assert(result !== null, 'No debería bloquear');
    assert(result.auth, 'Debería tener auth');
    assert(result.auth.authenticated === true, 'Autenticado');
    assert(result.auth.method === 'mtls', 'Método mTLS');
    assert(result.auth.type === 'client', 'Tipo client');
    assert(result.auth.identifier === 'project-mtls', 'Identifier correcto');
    assert(middleware.stats.authenticated >= 1, 'Incrementó authenticated');
  });

  await test('MTLSMiddleware: debe rechazar certificado revocado', async () => {
    const cert = await ca.issueCertificate({
      commonName: 'Revoked mTLS',
      type: 'device',
      identifier: 'device-revoked'
    });

    ca.revokeCertificate(cert.serialNumber, 'test');

    const result = await middleware.authenticate({
      path: '/api/data',
      headers: {
        'x-client-cert': encodeURIComponent(cert.certificate)
      }
    });

    assert(result === null, 'Debería bloquear certificado revocado');
  });

  await test('MTLSMiddleware: allowUnauthenticated debe permitir sin cert', async () => {
    const permissive = new MTLSMiddleware({
      caManager: ca,
      allowUnauthenticated: true
    });

    const result = await permissive.authenticate({
      path: '/api/data',
      headers: {}
    });

    assert(result !== null, 'No debería bloquear');
    assert(result.auth.authenticated === false, 'No autenticado');
    assert(result.auth.method === 'none', 'Método none');
  });

  await test('MTLSMiddleware: debe generar TLS options', async () => {
    const opts = middleware.getTLSOptions();

    assert(opts.requestCert === true, 'requestCert true');
    assert(opts.rejectUnauthorized === true, 'rejectUnauthorized true');
    assert(Array.isArray(opts.ca), 'CA es array');
    assert(opts.ca[0].includes('CERTIFICATE'), 'Contiene cert CA');
  });

  await test('MTLSMiddleware: debe generar config nginx', async () => {
    const config = middleware.getNginxConfig();

    assert(config.includes('ssl_client_certificate'), 'Tiene ssl_client_certificate');
    assert(config.includes('ssl_verify_client'), 'Tiene ssl_verify_client');
    assert(config.includes('X-Client-Cert'), 'Tiene header proxy');
  });

  await test('MTLSMiddleware: debe reportar estadísticas', async () => {
    const stats = middleware.getStats();

    assert(typeof stats.authenticated === 'number', 'Tiene authenticated');
    assert(typeof stats.rejected === 'number', 'Tiene rejected');
    assert(typeof stats.bypassed === 'number', 'Tiene bypassed');
  });

  // ------------------------------------------------------------------------
  // Module Integration Tests
  // ------------------------------------------------------------------------

  console.log('');

  await test('Module: debe crear instancia correctamente', async () => {
    const mod = new CertificateAuthorityModule();

    assert(mod.name === 'certificate-authority', 'Nombre correcto');
    assert(mod.version === '1.0.0', 'Versión correcta');
  });

  await test('Module: debe cargar con core mock', async () => {
    const mod = new CertificateAuthorityModule();
    const mockCore = {
      logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {}
      },
      metrics: {
        increment: () => {},
        observe: () => {}
      },
      hooks: {
        register: () => {}
      },
      config: {
        modules: {
          'certificate-authority': {
            storagePath: path.join(TEST_CA_PATH, 'module-test'),
            mtls_enabled: true
          }
        }
      }
    };

    await mod.onLoad(mockCore);

    assert(mod.caManager !== null, 'CAManager inicializado');
    assert(mod.mtlsMiddleware !== null, 'mTLS middleware inicializado');
  });

  // ------------------------------------------------------------------------
  // Cleanup & Results
  // ------------------------------------------------------------------------

  cleanup();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Tests: ${testsPassed} passed, ${testsFailed} failed, ${testsPassed + testsFailed} total`);
  console.log(`${'='.repeat(50)}`);

  if (testsFailed > 0) {
    process.exit(1);
  }
}

runTests().catch(error => {
  console.error('Fatal error:', error);
  cleanup();
  process.exit(1);
});
