/**
 * CryptoHandshake - Protocolo de handshake criptográfico entre cores
 *
 * 4 pasos sin broker de confianza:
 * 1. Core A envía challenge + public key
 * 2. Core B responde con su challenge + public key + HMAC
 * 3. Core A verifica HMAC (prueba de shared secret)
 * 4. Canal seguro establecido
 *
 * Transporte: MQTT topics core/{id}/security/handshake/{request|response}/{handshake_id}
 */

const crypto = require('crypto');

class CryptoHandshake {
  constructor(core, keyManager) {
    this.core = core;
    this.keyManager = keyManager;
    this.pendingHandshakes = new Map();
    this.handshakeTimeout = core?.config?.modules?.['security-p2p']?.handshake_timeout_ms || 30000;
  }

  /**
   * Inicia handshake con otro core
   */
  async initiateHandshake(targetCoreId) {
    const handshakeId = crypto.randomBytes(16).toString('hex');
    const challenge = crypto.randomBytes(32).toString('base64');

    this.pendingHandshakes.set(handshakeId, {
      target_core_id: targetCoreId,
      challenge,
      started_at: Date.now(),
      status: 'initiated'
    });

    // Timeout automático
    const timer = setTimeout(() => {
      if (this.pendingHandshakes.has(handshakeId)) {
        this.pendingHandshakes.delete(handshakeId);
        if (this.core?.emit) {
          this.core.emit('security.handshake.timeout', { target_core_id: targetCoreId });
        }
      }
    }, this.handshakeTimeout);

    if (timer.unref) timer.unref();

    const request = {
      source_core_id: this.core.id,
      handshake_id: handshakeId,
      challenge,
      public_key: this.keyManager.getPublicKey(),
      timestamp: Date.now(),
      version: '1.0'
    };

    if (this.core?.mqtt?.publish) {
      await this.core.mqtt.publish(
        `core/${targetCoreId}/security/handshake/request/${handshakeId}`,
        JSON.stringify(request),
        { qos: 1 }
      );
    }

    return handshakeId;
  }

  /**
   * Maneja solicitud de handshake entrante
   */
  async handleHandshakeRequest(topic, message) {
    try {
      const request = JSON.parse(message.toString());

      if (!request.source_core_id || !request.handshake_id || !request.challenge || !request.public_key) {
        return;
      }

      if (!await this.shouldAcceptHandshake(request.source_core_id)) {
        return;
      }

      // Computar shared secret con el peer
      const sharedSecret = this.keyManager.computeSharedSecret(request.public_key);
      this.keyManager.trustPeer(request.public_key, {
        core_id: request.source_core_id,
        shared_secret: sharedSecret
      });

      const responseChallenge = crypto.randomBytes(32).toString('base64');

      const hmac = this.calculateMutualHMAC(
        request.challenge,
        responseChallenge,
        sharedSecret,
        request.source_core_id,
        this.core.id
      );

      const response = {
        source_core_id: this.core.id,
        target_core_id: request.source_core_id,
        handshake_id: request.handshake_id,
        public_key: this.keyManager.getPublicKey(),
        original_challenge: request.challenge,
        response_challenge: responseChallenge,
        hmac,
        timestamp: Date.now(),
        version: '1.0'
      };

      if (this.core?.mqtt?.publish) {
        await this.core.mqtt.publish(
          `core/${request.source_core_id}/security/handshake/response/${request.handshake_id}`,
          JSON.stringify(response),
          { qos: 1 }
        );
      }

      if (this.core?.emit) {
        this.core.emit('security.handshake.accepted', {
          peer_core_id: request.source_core_id,
          handshake_id: request.handshake_id
        });
      }
    } catch (error) {
      if (this.core?.logger) {
        this.core.logger.error('handshake.request.error', { error: error.message });
      }
    }
  }

  /**
   * Maneja respuesta de handshake
   */
  async handleHandshakeResponse(topic, message) {
    try {
      const response = JSON.parse(message.toString());

      const pending = this.pendingHandshakes.get(response.handshake_id);
      if (!pending) return;

      if (pending.target_core_id !== response.source_core_id) {
        this.pendingHandshakes.delete(response.handshake_id);
        return;
      }

      // Computar shared secret
      const sharedSecret = this.keyManager.computeSharedSecret(response.public_key);

      // Verificar HMAC mutuo
      const expectedHMAC = this.calculateMutualHMAC(
        response.original_challenge,
        response.response_challenge,
        sharedSecret,
        this.core.id,
        response.source_core_id
      );

      if (response.hmac !== expectedHMAC) {
        this.pendingHandshakes.delete(response.handshake_id);
        if (this.core?.emit) {
          this.core.emit('security.handshake.failed', {
            peer_core_id: response.source_core_id,
            reason: 'hmac_mismatch'
          });
        }
        return;
      }

      // Handshake exitoso — marcar peer como trusted
      this.keyManager.trustPeer(response.public_key, {
        core_id: response.source_core_id,
        shared_secret: sharedSecret
      });

      this.pendingHandshakes.delete(response.handshake_id);

      const duration = Date.now() - pending.started_at;

      if (this.core?.emit) {
        this.core.emit('security.peer.trusted', {
          peer_core_id: response.source_core_id,
          handshake_id: response.handshake_id,
          duration_ms: duration,
          fingerprint: this.keyManager.getFingerprint()
        });
      }
    } catch (error) {
      if (this.core?.logger) {
        this.core.logger.error('handshake.response.error', { error: error.message });
      }
    }
  }

  /**
   * Calcula HMAC mutuo (determinístico independiente de quién inicia)
   */
  calculateMutualHMAC(challengeA, challengeB, sharedSecret, coreIdA, coreIdB) {
    const sortedIds = [coreIdA, coreIdB].sort();
    const hmac = crypto.createHmac('sha256', sharedSecret);
    hmac.update(challengeA);
    hmac.update(challengeB);
    hmac.update(sortedIds[0]);
    hmac.update(sortedIds[1]);
    hmac.update('event-core-v1');
    return hmac.digest('hex');
  }

  /**
   * Política de aceptación de handshakes
   */
  async shouldAcceptHandshake(sourceCoreId) {
    const whitelist = this.core?.config?.security?.whitelist || [];
    if (whitelist.length > 0 && !whitelist.includes(sourceCoreId)) return false;

    const blacklist = this.core?.config?.security?.blacklist || [];
    if (blacklist.includes(sourceCoreId)) return false;

    return true;
  }
}

module.exports = CryptoHandshake;
