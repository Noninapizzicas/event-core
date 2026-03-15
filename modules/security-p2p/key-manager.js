/**
 * KeyManager - Gestión de llaves X25519 para Security P2P
 *
 * Genera pares de claves ECDH (X25519), computa shared secrets,
 * y mantiene un registro de peers confiables.
 *
 * Algoritmo: X25519 (Elliptic Curve Diffie-Hellman)
 * - 128-bit security level
 * - 32-byte keys
 * - Usado en Signal, WireGuard, TLS 1.3
 */

const crypto = require('crypto');

class KeyManager {
  constructor() {
    this.keyPair = null;
    this.trustedPeers = new Map(); // public_key_pem → { public_key, ...metadata }
  }

  /**
   * Genera un par de claves X25519
   */
  async generateKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    this.keyPair = { publicKey, privateKey };
  }

  /**
   * Retorna la clave pública en formato PEM
   */
  getPublicKey() {
    if (!this.keyPair) throw new Error('Key pair not generated');
    return this.keyPair.publicKey.export({ type: 'spki', format: 'pem' });
  }

  /**
   * Retorna la clave pública en formato PEM (alias)
   */
  getPublicKeyPEM() {
    return this.getPublicKey();
  }

  /**
   * Genera un fingerprint de 16 caracteres (SHA-256 truncado)
   */
  getFingerprint() {
    const pem = this.getPublicKey();
    return crypto.createHash('sha256')
      .update(pem)
      .digest('hex')
      .substring(0, 16)
      .toUpperCase();
  }

  /**
   * Computa el shared secret ECDH con un peer
   * @param {string} peerPublicKeyPEM - Clave pública del peer en formato PEM
   * @returns {Buffer} Shared secret de 32 bytes
   */
  computeSharedSecret(peerPublicKeyPEM) {
    if (!this.keyPair) throw new Error('Key pair not generated');

    const peerKey = crypto.createPublicKey(peerPublicKeyPEM);
    return crypto.diffieHellman({
      publicKey: peerKey,
      privateKey: this.keyPair.privateKey
    });
  }

  /**
   * Agrega un peer como confiable
   * @param {string} publicKey - Identificador del peer (normalmente PEM)
   * @param {object} metadata - Metadata adicional ({ name, ... })
   */
  trustPeer(publicKey, metadata = {}) {
    this.trustedPeers.set(publicKey, {
      public_key: publicKey,
      ...metadata,
      trusted_at: Date.now()
    });
  }

  /**
   * Verifica si un peer es confiable
   */
  isTrusted(publicKey) {
    return this.trustedPeers.has(publicKey);
  }

  /**
   * Lista todos los peers confiables
   */
  listTrustedPeers() {
    return Array.from(this.trustedPeers.values());
  }

  /**
   * Elimina un peer de la lista de confianza
   * @returns {boolean} true si existía y fue eliminado
   */
  untrustPeer(publicKey) {
    return this.trustedPeers.delete(publicKey);
  }

  /**
   * Exporta el estado completo (para backup/migración)
   */
  exportState() {
    if (!this.keyPair) throw new Error('Key pair not generated');

    return {
      public_key: this.getPublicKey(),
      private_key: this.keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      trusted_peers: this.listTrustedPeers()
    };
  }

  /**
   * Importa estado desde un backup
   */
  importState(state) {
    const privateKey = crypto.createPrivateKey(state.private_key);
    const publicKey = crypto.createPublicKey(privateKey);

    this.keyPair = { publicKey, privateKey };
    this.trustedPeers = new Map();

    for (const peer of (state.trusted_peers || [])) {
      this.trustedPeers.set(peer.public_key, peer);
    }
  }
}

module.exports = KeyManager;
