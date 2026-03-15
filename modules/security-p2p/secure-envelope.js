/**
 * SecureEnvelope - Cifrado E2E de eventos
 *
 * Cifra/descifra payloads de eventos usando AES-256-GCM.
 * También firma y verifica integridad con HMAC-SHA256.
 *
 * Todos los métodos son estáticos para facilitar uso sin instanciar.
 */

const crypto = require('crypto');

class SecureEnvelope {
  /**
   * Cifra el data de un envelope usando AES-256-GCM
   * @param {object} envelope - Envelope con campo data
   * @param {Buffer} sharedSecret - Shared secret de 32 bytes (de ECDH)
   * @returns {object} Envelope con encrypted: {ciphertext, iv, auth_tag} y data: null
   */
  static encrypt(envelope, sharedSecret) {
    const plaintext = JSON.stringify(envelope.data);
    const iv = crypto.randomBytes(12); // 96-bit nonce para AES-GCM
    const key = sharedSecret.slice(0, 32);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    return {
      ...envelope,
      data: null,
      encrypted: {
        ciphertext,
        iv: iv.toString('hex'),
        auth_tag: authTag.toString('hex')
      }
    };
  }

  /**
   * Descifra un envelope cifrado
   * @param {object} encrypted - Envelope con campo encrypted
   * @param {Buffer} sharedSecret - Shared secret de 32 bytes
   * @returns {object} Envelope con data restaurado
   */
  static decrypt(encrypted, sharedSecret) {
    const { ciphertext, iv, auth_tag } = encrypted.encrypted;
    const key = sharedSecret.slice(0, 32);

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
      decipher.setAuthTag(Buffer.from(auth_tag, 'hex'));

      let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      const data = JSON.parse(decrypted);
      const result = { ...encrypted };
      delete result.encrypted;
      result.data = data;
      return result;
    } catch (error) {
      throw new Error(`Decryption failed: ${error.message}`);
    }
  }

  /**
   * Verifica si un envelope está cifrado
   */
  static isEncrypted(envelope) {
    return !!(envelope && envelope.encrypted);
  }

  /**
   * Firma un envelope con HMAC-SHA256
   * @param {object} envelope - Envelope a firmar
   * @param {Buffer} secret - Secret para HMAC
   * @returns {object} Envelope con security.signature
   */
  static sign(envelope, secret) {
    const payload = JSON.stringify(envelope.data);
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    return {
      ...envelope,
      security: {
        ...(envelope.security || {}),
        signature
      }
    };
  }

  /**
   * Verifica la firma HMAC de un envelope
   * @returns {boolean} true si la firma es válida
   */
  static verify(signed, secret) {
    if (!signed.security?.signature) return false;

    const payload = JSON.stringify(signed.data);
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return signed.security.signature === expected;
  }
}

module.exports = SecureEnvelope;
