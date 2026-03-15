/**
 * Tests para Security P2P Module
 *
 * Run: node tests/unit/security-p2p.test.js
 */

const KeyManager = require('../../modules/security-p2p/key-manager');
const SecureEnvelope = require('../../modules/security-p2p/secure-envelope');
const SecurityP2PModule = require('../../modules/security-p2p');

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

// ============================================================================
// Tests
// ============================================================================

async function runTests() {
  console.log('🧪 Testing Security P2P Module\n');

  // ------------------------------------------------------------------------
  // KeyManager Tests
  // ------------------------------------------------------------------------

  await test('KeyManager: debe generar par de claves X25519', async () => {
    const keyManager = new KeyManager();
    await keyManager.generateKeyPair();

    const publicKey = keyManager.getPublicKey();
    assert(publicKey, 'Public key generada');
    assert(publicKey.length > 0, 'Public key no vacía');
  });

  await test('KeyManager: debe generar fingerprint único', async () => {
    const keyManager = new KeyManager();
    await keyManager.generateKeyPair();

    const fingerprint = keyManager.getFingerprint();
    assert(fingerprint, 'Fingerprint generado');
    assert(fingerprint.length === 16, 'Fingerprint de 16 caracteres');
  });

  await test('KeyManager: debe computar shared secret', async () => {
    const km1 = new KeyManager();
    const km2 = new KeyManager();

    await km1.generateKeyPair();
    await km2.generateKeyPair();

    const secret1 = km1.computeSharedSecret(km2.getPublicKeyPEM());
    const secret2 = km2.computeSharedSecret(km1.getPublicKeyPEM());

    assert(secret1, 'Shared secret 1 generado');
    assert(secret2, 'Shared secret 2 generado');
    assert(secret1.equals(secret2), 'Shared secrets son iguales (DH correcto)');
  });

  await test('KeyManager: debe agregar/remover trusted peers', async () => {
    const keyManager = new KeyManager();
    await keyManager.generateKeyPair();

    const peerKey = 'peer-public-key-123';
    keyManager.trustPeer(peerKey, { name: 'peer1' });

    assert(keyManager.isTrusted(peerKey), 'Peer es confiable');

    const peers = keyManager.listTrustedPeers();
    assert(peers.length === 1, '1 peer confiable');
    assert(peers[0].public_key === peerKey, 'Public key correcto');

    const removed = keyManager.untrustPeer(peerKey);
    assert(removed === true, 'Peer removido');
    assert(keyManager.isTrusted(peerKey) === false, 'Peer ya no es confiable');
  });

  await test('KeyManager: debe exportar/importar estado', async () => {
    const km1 = new KeyManager();
    await km1.generateKeyPair();
    km1.trustPeer('peer-123', { name: 'test' });

    const state = km1.exportState();
    assert(state.public_key, 'State tiene public key');
    assert(state.private_key, 'State tiene private key');
    assert(state.trusted_peers.length === 1, 'State tiene trusted peers');

    const km2 = new KeyManager();
    km2.importState(state);

    assert(km2.getPublicKey() === km1.getPublicKey(), 'Public key importada correctamente');
    assert(km2.isTrusted('peer-123'), 'Trusted peers importados');
  });

  // ------------------------------------------------------------------------
  // SecureEnvelope Tests
  // ------------------------------------------------------------------------

  await test('SecureEnvelope: debe cifrar/descifrar envelope', async () => {
    const km1 = new KeyManager();
    const km2 = new KeyManager();
    await km1.generateKeyPair();
    await km2.generateKeyPair();

    const sharedSecret = km1.computeSharedSecret(km2.getPublicKeyPEM());

    const envelope = {
      event_id: 'test-123',
      event_type: 'test.event',
      timestamp: new Date().toISOString(),
      data: { message: 'hello world', number: 42 }
    };

    const encrypted = SecureEnvelope.encrypt(envelope, sharedSecret);

    assert(encrypted.encrypted, 'Envelope tiene campo encrypted');
    assert(encrypted.encrypted.ciphertext, 'Tiene ciphertext');
    assert(encrypted.encrypted.iv, 'Tiene IV');
    assert(encrypted.encrypted.auth_tag, 'Tiene auth tag');
    assert(encrypted.data === null, 'Data original limpiado');

    const decrypted = SecureEnvelope.decrypt(encrypted, sharedSecret);

    assert(decrypted.data, 'Data descifrado');
    assert(decrypted.data.message === 'hello world', 'Mensaje descifrado correctamente');
    assert(decrypted.data.number === 42, 'Número descifrado correctamente');
  });

  await test('SecureEnvelope: descifrado con clave incorrecta debe fallar', async () => {
    const km1 = new KeyManager();
    const km2 = new KeyManager();
    const km3 = new KeyManager();

    await km1.generateKeyPair();
    await km2.generateKeyPair();
    await km3.generateKeyPair();

    const secret12 = km1.computeSharedSecret(km2.getPublicKeyPEM());
    const secret13 = km1.computeSharedSecret(km3.getPublicKeyPEM());

    const envelope = {
      event_id: 'test-123',
      event_type: 'test.event',
      timestamp: new Date().toISOString(),
      data: { secret: 'confidential' }
    };

    const encrypted = SecureEnvelope.encrypt(envelope, secret12);

    try {
      SecureEnvelope.decrypt(encrypted, secret13);
      assert(false, 'Debería lanzar error');
    } catch (error) {
      assert(error.message.includes('Decryption failed'), 'Error de descifrado');
    }
  });

  await test('SecureEnvelope: debe detectar envelope cifrado', async () => {
    const km1 = new KeyManager();
    await km1.generateKeyPair();

    const envelope = {
      event_id: 'test-123',
      data: { message: 'test' }
    };

    assert(SecureEnvelope.isEncrypted(envelope) === false, 'Envelope sin cifrar detectado');

    const encrypted = SecureEnvelope.encrypt(envelope, Buffer.alloc(32));
    assert(SecureEnvelope.isEncrypted(encrypted) === true, 'Envelope cifrado detectado');
  });

  await test('SecureEnvelope: debe firmar y verificar envelope', async () => {
    const km1 = new KeyManager();
    await km1.generateKeyPair();
    const secret = Buffer.alloc(32, 1);

    const envelope = {
      event_id: 'test-123',
      event_type: 'test.event',
      timestamp: new Date().toISOString(),
      data: { message: 'test' }
    };

    const signed = SecureEnvelope.sign(envelope, secret);
    assert(signed.security?.signature, 'Firma agregada');

    const valid = SecureEnvelope.verify(signed, secret);
    assert(valid === true, 'Firma válida');

    // Modificar data
    signed.data.message = 'modified';
    const invalid = SecureEnvelope.verify(signed, secret);
    assert(invalid === false, 'Firma inválida después de modificación');
  });

  // ------------------------------------------------------------------------
  // SecurityP2PModule Tests
  // ------------------------------------------------------------------------

  await test('SecurityP2PModule: debe inicializarse correctamente', async () => {
    const module = new SecurityP2PModule();
    assert(module.keyManager, 'Tiene KeyManager');
    assert(module.encryptionEnabled === true, 'Cifrado habilitado por defecto');
  });

  await test('SecurityP2PModule: onLoad debe generar claves', async () => {
    const module = new SecurityP2PModule();

    const mockCore = {
      logger: null,
      metrics: null,
      hooks: {
        register: (name, handler) => {}
      }
    };

    await module.onLoad(mockCore);

    const fingerprint = module.keyManager.getFingerprint();
    assert(fingerprint, 'Fingerprint generado');
    assert(fingerprint.length === 16, 'Fingerprint válido');
  });

  await test('SecurityP2PModule: hookBeforeEventPublish debe cifrar eventos', async () => {
    const module = new SecurityP2PModule();

    const mockCore = {
      logger: null,
      metrics: null,
      hooks: { register: () => {} }
    };

    await module.onLoad(mockCore);

    // Agregar un peer confiable
    const km2 = new KeyManager();
    await km2.generateKeyPair();
    const peerPublicKey = km2.getPublicKey();
    await module.handleTrustPeer({ body: { public_key: peerPublicKey, name: 'peer1' } });

    // Simular contexto de evento
    const context = {
      eventType: 'user.action',
      data: { action: 'click' },
      envelope: {
        event_id: 'test-123',
        event_type: 'user.action',
        timestamp: new Date().toISOString(),
        data: { action: 'click' }
      }
    };

    const result = await module.hookBeforeEventPublish(context);

    assert(result, 'Contexto retornado');
    assert(result.envelope.encrypted, 'Envelope cifrado');
    assert(result.envelope.data === null, 'Data original limpiado');
    assert(module.stats.events_encrypted === 1, 'Estadística actualizada');
  });

  await test('SecurityP2PModule: hookBeforeEventPublish no debe cifrar eventos del sistema', async () => {
    const module = new SecurityP2PModule();

    const mockCore = {
      logger: null,
      metrics: null,
      hooks: { register: () => {} }
    };

    await module.onLoad(mockCore);

    const context = {
      eventType: 'system.log',
      envelope: {
        event_id: 'test-123',
        data: { level: 'info' }
      }
    };

    const result = await module.hookBeforeEventPublish(context);

    assert(result, 'Contexto retornado');
    assert(!result.envelope.encrypted, 'Evento del sistema no cifrado');
  });

  await test('SecurityP2PModule: debe manejar errores de cifrado gracefully', async () => {
    const module = new SecurityP2PModule();

    const mockCore = {
      logger: null,
      metrics: null,
      hooks: { register: () => {} }
    };

    await module.onLoad(mockCore);

    // Envelope inválido
    const context = {
      eventType: 'test.event',
      envelope: null
    };

    const result = await module.hookBeforeEventPublish(context);

    assert(result, 'Contexto retornado sin error');
    assert(module.stats.encryption_errors === 0, 'Sin errores registrados (envelope null es válido)');
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
