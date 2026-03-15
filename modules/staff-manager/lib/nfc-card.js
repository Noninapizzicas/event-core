/**
 * NFCCard - Serialización/deserialización de payloads NFC
 *
 * Soporta dos tipos de tag (ambos caben en NTAG215 — 504 bytes):
 *
 *   core_info  →  Info de conexión del core (onboarding de dispositivos, Opción A)
 *   employee   →  Identidad de empleado (control de jornada)
 *
 * Flujo Opción A:
 *   Admin escribe tag tipo core_info → tablet lo toca → se conecta sola al core.
 *
 * Flujo empleado:
 *   Admin genera tarjeta de empleado → escribe NTAG215 → empleado toca
 *   al entrar/salir → core registra jornada.
 */

const crypto = require('crypto');

const NFC_VERSION = 1;

const TAG_TYPES = {
  CORE_INFO: 'core_info',
  EMPLOYEE: 'employee'
};

class NFCCard {
  /**
   * Genera payload para tag tipo "core_info" (Opción A).
   * El admin escribe este tag una sola vez; las tablets nuevas lo tocan para conectarse.
   *
   * @param {object} params
   * @param {string} params.core_id        - ID único del core (ej: "pizzicas-01")
   * @param {string} params.endpoint       - MQTT endpoint (ej: "mqtt://192.168.1.10:1883")
   * @param {string} params.publicKeyPEM   - Clave pública X25519 en formato PEM
   * @returns {object} Payload listo para serializar y escribir al tag
   */
  static generateCoreInfoTag({ core_id, endpoint, publicKeyPEM }) {
    if (!core_id || !endpoint || !publicKeyPEM) {
      throw new Error('core_id, endpoint y publicKeyPEM son requeridos');
    }

    const pub = NFCCard._pemToBase64url(publicKeyPEM);
    const fp  = NFCCard._fingerprintFromPEM(publicKeyPEM);

    const payload = {
      v:       NFC_VERSION,
      type:    TAG_TYPES.CORE_INFO,
      core_id,
      endpoint,
      pub,
      fp,
      issued:  new Date().toISOString().split('T')[0]
    };

    NFCCard._assertFitsNTAG215(payload);
    return payload;
  }

  /**
   * Genera payload para tarjeta personal de empleado.
   *
   * @param {object} employee
   * @param {string} employee.id    - ID del empleado (ej: "emp-1a2b3c")
   * @param {string} employee.name  - Nombre visible
   * @param {string} employee.role  - Rol (ej: "camarero", "cocina", "admin")
   * @returns {object} Payload listo para serializar y escribir al tag
   */
  static generateEmployeeCard({ id, name, role }) {
    if (!id || !name || !role) {
      throw new Error('id, name y role son requeridos');
    }

    const payload = {
      v:      NFC_VERSION,
      type:   TAG_TYPES.EMPLOYEE,
      emp_id: id,
      name,
      role
    };

    NFCCard._assertFitsNTAG215(payload);
    return payload;
  }

  /**
   * Parsea y valida un payload leído desde un tag NFC.
   *
   * @param {string|object} raw - JSON string o objeto ya parseado
   * @returns {object} Payload validado (con publicKeyPEM recompuesta para core_info)
   * @throws {Error} Si el payload es inválido o incompleto
   */
  static parsePayload(raw) {
    const payload = typeof raw === 'string' ? JSON.parse(raw) : { ...raw };

    if (payload.v !== NFC_VERSION) {
      throw new Error(`Versión de tag no soportada: ${payload.v}`);
    }

    if (!Object.values(TAG_TYPES).includes(payload.type)) {
      throw new Error(`Tipo de tag desconocido: "${payload.type}"`);
    }

    if (payload.type === TAG_TYPES.CORE_INFO) {
      if (!payload.core_id || !payload.endpoint || !payload.pub) {
        throw new Error('Tag core_info incompleto: faltan core_id, endpoint o pub');
      }
      payload.publicKeyPEM = NFCCard._base64urlToPEM(payload.pub);
    }

    if (payload.type === TAG_TYPES.EMPLOYEE) {
      if (!payload.emp_id || !payload.name || !payload.role) {
        throw new Error('Tag employee incompleto: faltan emp_id, name o role');
      }
    }

    return payload;
  }

  /**
   * Serializa un payload a JSON string para escritura física en el tag.
   */
  static serialize(payload) {
    return JSON.stringify(payload);
  }

  /**
   * Tamaño en bytes del payload serializado.
   */
  static byteSize(payload) {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  }

  // ── Utilidades privadas ───────────────────────────────────────────────────

  /**
   * Convierte PEM → base64url (elimina headers y saltos de línea).
   * Una clave X25519 pública queda en ~44 bytes base64url.
   */
  static _pemToBase64url(pem) {
    const lines = pem.split('\n').filter(l => !l.startsWith('---') && l.trim());
    return Buffer.from(lines.join(''), 'base64').toString('base64url');
  }

  /**
   * Reconstruye PEM a partir de base64url.
   */
  static _base64urlToPEM(b64url) {
    const b64    = Buffer.from(b64url, 'base64url').toString('base64');
    const chunks = b64.match(/.{1,64}/g) || [];
    return ['-----BEGIN PUBLIC KEY-----', ...chunks, '-----END PUBLIC KEY-----'].join('\n');
  }

  /**
   * Fingerprint SHA-256 truncado a 16 hex (8 bytes).
   */
  static _fingerprintFromPEM(pem) {
    return crypto.createHash('sha256')
      .update(pem)
      .digest('hex')
      .substring(0, 16)
      .toUpperCase();
  }

  static _assertFitsNTAG215(payload) {
    const size = NFCCard.byteSize(payload);
    if (size > 504) {
      throw new Error(`Payload demasiado grande: ${size} bytes (NTAG215 máx: 504)`);
    }
  }
}

NFCCard.TAG_TYPES = TAG_TYPES;
NFCCard.NFC_VERSION = NFC_VERSION;

module.exports = NFCCard;
