/**
 * Security P2P Module v1.0.0
 *
 * Módulo de seguridad Zero Trust P2P para Event Core.
 * Cifra/descifra eventos entre cores usando X25519 + AES-256-GCM.
 *
 * Se integra al core vía hooks (beforeEventPublish, afterEventReceive)
 * para cifrado transparente sin modificar otros módulos.
 *
 * Emite: security.peer.trusted, security.peer.revoked, security.handshake.*
 * Hooks: beforeEventPublish, afterEventReceive
 */

const KeyManager = require('./key-manager');
const SecureEnvelope = require('./secure-envelope');
const CryptoHandshake = require('./crypto-handshake');

class SecurityP2PModule {
  constructor() {
    this.name = 'security-p2p';
    this.version = '1.0.0';

    this.keyManager = new KeyManager();
    this.encryptionEnabled = true;

    // Shared secrets por peer (public_key → Buffer)
    this._sharedSecrets = new Map();

    this.stats = {
      events_encrypted: 0,
      events_decrypted: 0,
      encryption_errors: 0,
      decryption_errors: 0
    };

    // Dependencias (inyectadas en onLoad)
    this.core = null;
    this.logger = null;
    this.metrics = null;
    this.cryptoHandshake = null;
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(core) {
    this.core = core;
    this.logger = core.logger;
    this.metrics = core.metrics;

    // Generar claves al cargar
    await this.keyManager.generateKeyPair();

    // Inicializar handshake
    this.cryptoHandshake = new CryptoHandshake(core, this.keyManager);

    // Registrar hooks para cifrado transparente
    if (core.hooks) {
      core.hooks.register('beforeEventPublish', this.hookBeforeEventPublish.bind(this));
      core.hooks.register('afterEventReceive', this.hookAfterEventReceive.bind(this));
    }

    // Suscribirse a topics de handshake MQTT
    if (core.mqtt?.subscribe) {
      await core.mqtt.subscribe('core/+/security/handshake/request/#');
      await core.mqtt.subscribe('core/+/security/handshake/response/#');
      core.mqtt.on('message', this._handleMqttMessage.bind(this));
    }

    // Registrar UI handlers si disponible
    if (core.uiHandler) {
      this._registerUIHandlers(core.uiHandler);
    }

    if (this.logger) {
      this.logger.info('module.loaded', {
        module: this.name,
        version: this.version,
        fingerprint: this.keyManager.getFingerprint()
      });
    }
  }

  async onUnload() {
    if (this.core?.uiHandler) {
      const actions = ['status', 'public-key', 'trust-peer', 'revoke-peer', 'trusted-peers', 'health'];
      for (const action of actions) {
        this.core.uiHandler.unregister('security-p2p', action);
      }
    }

    this._sharedSecrets.clear();

    if (this.logger) {
      this.logger.info('module.unloaded', { module: this.name });
    }
  }

  // ==========================================
  // Hooks — Cifrado transparente de eventos
  // ==========================================

  /**
   * Hook: cifra eventos salientes para peers trusted.
   * No cifra eventos del sistema (system.*) ni si no hay peers.
   */
  async hookBeforeEventPublish(context) {
    if (!context || !context.envelope) return context;
    if (!this.encryptionEnabled) return context;

    // No cifrar eventos del sistema
    if (context.eventType && context.eventType.startsWith('system.')) return context;

    // Necesitamos al menos un peer trusted con shared secret
    const trustedPeers = this.keyManager.listTrustedPeers();
    if (trustedPeers.length === 0) return context;

    try {
      // Buscar el primer peer con shared secret disponible
      let sharedSecret = null;
      for (const peer of trustedPeers) {
        sharedSecret = this._sharedSecrets.get(peer.public_key);
        if (sharedSecret) break;
      }

      if (!sharedSecret) return context;

      const encryptedEnvelope = SecureEnvelope.encrypt(context.envelope, sharedSecret);
      this.stats.events_encrypted++;

      return {
        ...context,
        envelope: encryptedEnvelope
      };
    } catch (error) {
      this.stats.encryption_errors++;
      return context;
    }
  }

  /**
   * Hook: descifra eventos entrantes de peers trusted.
   */
  async hookAfterEventReceive(context) {
    if (!context || !context.envelope) return context;
    if (!SecureEnvelope.isEncrypted(context.envelope)) return context;

    try {
      // Buscar shared secret que pueda descifrar
      for (const [, secret] of this._sharedSecrets) {
        try {
          const decryptedEnvelope = SecureEnvelope.decrypt(context.envelope, secret);
          this.stats.events_decrypted++;

          return {
            ...context,
            envelope: decryptedEnvelope
          };
        } catch {
          continue; // Probar siguiente secret
        }
      }

      // Ningún secret pudo descifrar
      this.stats.decryption_errors++;
      return context;
    } catch (error) {
      this.stats.decryption_errors++;
      return context;
    }
  }

  // ==========================================
  // API handlers (para UI y HTTP)
  // ==========================================

  async handleStatus() {
    return {
      status: 200,
      data: {
        module: this.name,
        version: this.version,
        encryption_enabled: this.encryptionEnabled,
        fingerprint: this.keyManager.getFingerprint(),
        trusted_peers: this.keyManager.listTrustedPeers().length,
        stats: this.stats
      }
    };
  }

  async handleGetPublicKey() {
    return {
      status: 200,
      data: {
        public_key: this.keyManager.getPublicKey(),
        fingerprint: this.keyManager.getFingerprint()
      }
    };
  }

  async handleTrustPeer({ body }) {
    const { public_key, name } = body || {};
    if (!public_key) {
      return { status: 400, error: 'public_key required' };
    }

    this.keyManager.trustPeer(public_key, { name });

    // Computar shared secret si es una clave válida
    try {
      const sharedSecret = this.keyManager.computeSharedSecret(public_key);
      this._sharedSecrets.set(public_key, sharedSecret);
    } catch {
      // No es una clave PEM válida — trust sin shared secret
    }

    return {
      status: 200,
      data: {
        trusted: true,
        fingerprint: this.keyManager.getFingerprint(),
        peer_count: this.keyManager.listTrustedPeers().length
      }
    };
  }

  async handleRevokePeer({ body }) {
    const { public_key } = body || {};
    if (!public_key) {
      return { status: 400, error: 'public_key required' };
    }

    const removed = this.keyManager.untrustPeer(public_key);
    this._sharedSecrets.delete(public_key);

    return {
      status: 200,
      data: { revoked: removed }
    };
  }

  async handleListTrustedPeers() {
    return {
      status: 200,
      data: {
        peers: this.keyManager.listTrustedPeers().map(p => ({
          public_key: p.public_key.substring(0, 40) + '...',
          name: p.name,
          trusted_at: p.trusted_at
        }))
      }
    };
  }

  async handleHealthCheck() {
    return {
      status: 200,
      data: {
        module: this.name,
        status: 'healthy',
        has_keys: !!this.keyManager.getPublicKey(),
        encryption_enabled: this.encryptionEnabled,
        trusted_peers: this.keyManager.listTrustedPeers().length
      }
    };
  }

  // ==========================================
  // Internal
  // ==========================================

  _registerUIHandlers(uiHandler) {
    uiHandler.register('security-p2p', 'status', this.handleStatus.bind(this));
    uiHandler.register('security-p2p', 'public-key', this.handleGetPublicKey.bind(this));
    uiHandler.register('security-p2p', 'trust-peer', this.handleTrustPeer.bind(this));
    uiHandler.register('security-p2p', 'revoke-peer', this.handleRevokePeer.bind(this));
    uiHandler.register('security-p2p', 'trusted-peers', this.handleListTrustedPeers.bind(this));
    uiHandler.register('security-p2p', 'health', this.handleHealthCheck.bind(this));
  }

  _handleMqttMessage(topic, message) {
    if (topic.includes('/security/handshake/request/')) {
      this.cryptoHandshake.handleHandshakeRequest(topic, message);
    } else if (topic.includes('/security/handshake/response/')) {
      this.cryptoHandshake.handleHandshakeResponse(topic, message);
    }
  }
}

module.exports = SecurityP2PModule;
