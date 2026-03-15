/**
 * CA Manager - Autoridad Certificadora propia
 *
 * Gestiona una CA raíz auto-firmada para emitir certificados cliente X.509.
 * Soporta dos casos de uso:
 *   1. Certificados para clientes del portal de facturación
 *   2. Certificados para dispositivos de trabajo
 *
 * Usa Node.js crypto nativo (sin dependencias externas).
 * Certificados exportables como .p12 (PKCS#12) para importar en navegador.
 *
 * Algoritmo: RSA 2048 + SHA-256 (compatible con todos los navegadores)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class CAManager {
  constructor(options = {}) {
    this.storagePath = options.storagePath || path.join(process.cwd(), 'data', 'ca');
    this.caKeyPath = path.join(this.storagePath, 'ca-key.pem');
    this.caCertPath = path.join(this.storagePath, 'ca-cert.pem');
    this.crlPath = path.join(this.storagePath, 'crl.json');
    this.certsPath = path.join(this.storagePath, 'certs');

    this.caKey = null;
    this.caCert = null;
    this.crl = []; // Certificate Revocation List

    // Configuración por defecto
    this.config = {
      ca_cn: options.ca_cn || 'Event Core Internal CA',
      ca_org: options.ca_org || 'Event Core',
      ca_validity_days: options.ca_validity_days || 3650, // 10 años
      cert_validity_days: options.cert_validity_days || 365, // 1 año
      key_size: options.key_size || 2048
    };
  }

  /**
   * Inicializa la CA - carga existente o genera nueva
   */
  async initialize() {
    // Crear directorios
    fs.mkdirSync(this.storagePath, { recursive: true });
    fs.mkdirSync(this.certsPath, { recursive: true });

    // Cargar CRL
    if (fs.existsSync(this.crlPath)) {
      this.crl = JSON.parse(fs.readFileSync(this.crlPath, 'utf8'));
    }

    // Intentar cargar CA existente
    if (fs.existsSync(this.caKeyPath) && fs.existsSync(this.caCertPath)) {
      this.caKey = fs.readFileSync(this.caKeyPath, 'utf8');
      this.caCert = fs.readFileSync(this.caCertPath, 'utf8');
      return { created: false, loaded: true };
    }

    // Generar nueva CA
    return this._generateCA();
  }

  /**
   * Genera el par de claves y certificado raíz de la CA
   * @private
   */
  _generateCA() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: this.config.key_size,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    // Crear certificado auto-firmado para la CA
    const serialNumber = this._generateSerialNumber();
    const notBefore = new Date();
    const notAfter = new Date();
    notAfter.setDate(notAfter.getDate() + this.config.ca_validity_days);

    const caCertData = {
      serialNumber,
      subject: {
        CN: this.config.ca_cn,
        O: this.config.ca_org
      },
      issuer: {
        CN: this.config.ca_cn,
        O: this.config.ca_org
      },
      notBefore: notBefore.toISOString(),
      notAfter: notAfter.toISOString(),
      isCA: true,
      publicKey
    };

    // Firmar el certificado CA (auto-firmado)
    const certPem = this._createSelfSignedCert(caCertData, privateKey);

    // Guardar en disco
    fs.writeFileSync(this.caKeyPath, privateKey, { mode: 0o600 });
    fs.writeFileSync(this.caCertPath, certPem, { mode: 0o644 });

    this.caKey = privateKey;
    this.caCert = certPem;

    return { created: true, loaded: true, serialNumber };
  }

  /**
   * Emite un certificado cliente firmado por la CA
   *
   * @param {Object} options
   * @param {string} options.commonName - Nombre del titular (ej: "Cliente: Pizzería Roma")
   * @param {string} options.type - Tipo: 'client' | 'device'
   * @param {string} options.identifier - ID único (projectId o deviceId)
   * @param {string} [options.organization] - Organización
   * @param {string} [options.email] - Email del titular
   * @param {number} [options.validityDays] - Días de validez (default: config)
   * @param {string} [options.passphrase] - Contraseña para el .p12
   * @returns {Object} { serialNumber, certificate, privateKey, p12, fingerprint, metadata }
   */
  async issueCertificate(options = {}) {
    if (!this.caKey || !this.caCert) {
      throw new Error('CA not initialized. Call initialize() first.');
    }

    const {
      commonName,
      type = 'client',
      identifier,
      organization,
      email,
      validityDays = this.config.cert_validity_days,
      passphrase = ''
    } = options;

    if (!commonName) throw new Error('commonName is required');
    if (!identifier) throw new Error('identifier is required');
    if (!['client', 'device'].includes(type)) {
      throw new Error('type must be "client" or "device"');
    }

    // Generar par de claves para el cliente
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: this.config.key_size,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const serialNumber = this._generateSerialNumber();
    const notBefore = new Date();
    const notAfter = new Date();
    notAfter.setDate(notAfter.getDate() + validityDays);

    // Construir subject del certificado
    const subject = {
      CN: commonName,
      OU: type === 'client' ? 'Portal Clientes' : 'Dispositivos',
      ...(organization && { O: organization }),
      ...(email && { emailAddress: email })
    };

    // Crear certificado cliente firmado por la CA
    const certData = {
      serialNumber,
      subject,
      issuer: {
        CN: this.config.ca_cn,
        O: this.config.ca_org
      },
      notBefore: notBefore.toISOString(),
      notAfter: notAfter.toISOString(),
      isCA: false,
      publicKey,
      extensions: {
        type,
        identifier,
        ...(email && { email })
      }
    };

    const certificate = this._createSignedCert(certData, this.caKey);

    // Generar fingerprint
    const fingerprint = crypto.createHash('sha256')
      .update(certificate)
      .digest('hex')
      .toUpperCase()
      .match(/.{2}/g)
      .join(':');

    // Crear PKCS#12 bundle (certificado + clave privada)
    const p12Data = this._createP12Bundle(certificate, privateKey, passphrase);

    // Guardar metadata del certificado
    const metadata = {
      serialNumber,
      type,
      identifier,
      commonName,
      organization: organization || null,
      email: email || null,
      fingerprint,
      issuedAt: notBefore.toISOString(),
      expiresAt: notAfter.toISOString(),
      status: 'active',
      revokedAt: null
    };

    // Persistir
    const certDir = path.join(this.certsPath, serialNumber);
    fs.mkdirSync(certDir, { recursive: true });
    fs.writeFileSync(path.join(certDir, 'cert.pem'), certificate);
    fs.writeFileSync(path.join(certDir, 'key.pem'), privateKey, { mode: 0o600 });
    fs.writeFileSync(path.join(certDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
    if (p12Data) {
      fs.writeFileSync(path.join(certDir, 'bundle.p12'), p12Data);
    }

    return {
      serialNumber,
      certificate,
      privateKey,
      p12: p12Data,
      fingerprint,
      metadata
    };
  }

  /**
   * Revoca un certificado por número de serie
   *
   * @param {string} serialNumber
   * @param {string} [reason] - Motivo de revocación
   * @returns {Object} { revoked, serialNumber, reason }
   */
  revokeCertificate(serialNumber, reason = 'unspecified') {
    const certDir = path.join(this.certsPath, serialNumber);
    const metadataPath = path.join(certDir, 'metadata.json');

    if (!fs.existsSync(metadataPath)) {
      return { revoked: false, error: 'Certificate not found' };
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

    if (metadata.status === 'revoked') {
      return { revoked: false, error: 'Certificate already revoked' };
    }

    // Actualizar metadata
    metadata.status = 'revoked';
    metadata.revokedAt = new Date().toISOString();
    metadata.revokeReason = reason;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    // Añadir a CRL
    this.crl.push({
      serialNumber,
      revokedAt: metadata.revokedAt,
      reason
    });
    this._saveCRL();

    // Eliminar clave privada por seguridad
    const keyPath = path.join(certDir, 'key.pem');
    if (fs.existsSync(keyPath)) {
      fs.unlinkSync(keyPath);
    }
    const p12Path = path.join(certDir, 'bundle.p12');
    if (fs.existsSync(p12Path)) {
      fs.unlinkSync(p12Path);
    }

    return {
      revoked: true,
      serialNumber,
      reason,
      revokedAt: metadata.revokedAt
    };
  }

  /**
   * Verifica si un certificado es válido (no revocado, no expirado)
   *
   * @param {string} certificatePem - Certificado en formato PEM
   * @returns {Object} { valid, serialNumber, type, identifier, error? }
   */
  verifyCertificate(certificatePem) {
    try {
      // Extraer metadata del certificado
      const certInfo = this._parseCertificateInfo(certificatePem);

      if (!certInfo) {
        return { valid: false, error: 'Cannot parse certificate' };
      }

      // Verificar que fue firmado por nuestra CA
      const isSignedByCA = this._verifySignature(certificatePem);
      if (!isSignedByCA) {
        return { valid: false, error: 'Not signed by this CA' };
      }

      // Verificar que no está en la CRL
      const isRevoked = this.crl.some(entry =>
        entry.serialNumber === certInfo.serialNumber
      );
      if (isRevoked) {
        return { valid: false, error: 'Certificate revoked', serialNumber: certInfo.serialNumber };
      }

      // Verificar expiración
      const metadataPath = path.join(this.certsPath, certInfo.serialNumber, 'metadata.json');
      if (fs.existsSync(metadataPath)) {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const now = new Date();
        const expires = new Date(metadata.expiresAt);

        if (now > expires) {
          return { valid: false, error: 'Certificate expired', serialNumber: certInfo.serialNumber };
        }

        if (metadata.status === 'revoked') {
          return { valid: false, error: 'Certificate revoked', serialNumber: certInfo.serialNumber };
        }

        return {
          valid: true,
          serialNumber: certInfo.serialNumber,
          type: metadata.type,
          identifier: metadata.identifier,
          commonName: metadata.commonName,
          expiresAt: metadata.expiresAt
        };
      }

      return { valid: false, error: 'Certificate metadata not found' };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  /**
   * Lista todos los certificados emitidos
   *
   * @param {Object} [filters]
   * @param {string} [filters.type] - 'client' | 'device'
   * @param {string} [filters.status] - 'active' | 'revoked' | 'expired'
   * @param {string} [filters.identifier] - Filtrar por identifier
   * @returns {Array} Lista de certificados
   */
  listCertificates(filters = {}) {
    if (!fs.existsSync(this.certsPath)) return [];

    const dirs = fs.readdirSync(this.certsPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    const certs = [];
    const now = new Date();

    for (const dir of dirs) {
      const metadataPath = path.join(this.certsPath, dir, 'metadata.json');
      if (!fs.existsSync(metadataPath)) continue;

      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

      // Calcular estado real (puede haber expirado desde la última vez)
      if (metadata.status === 'active' && new Date(metadata.expiresAt) < now) {
        metadata.status = 'expired';
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
      }

      // Aplicar filtros
      if (filters.type && metadata.type !== filters.type) continue;
      if (filters.status && metadata.status !== filters.status) continue;
      if (filters.identifier && metadata.identifier !== filters.identifier) continue;

      certs.push(metadata);
    }

    return certs.sort((a, b) => new Date(b.issuedAt) - new Date(a.issuedAt));
  }

  /**
   * Obtiene el certificado raíz de la CA (para instalar en clientes/dispositivos)
   * @returns {string} CA certificate PEM
   */
  getCACertificate() {
    if (!this.caCert) throw new Error('CA not initialized');
    return this.caCert;
  }

  /**
   * Obtiene la CRL actual
   * @returns {Array}
   */
  getCRL() {
    return [...this.crl];
  }

  /**
   * Renueva un certificado (revoca el anterior, emite uno nuevo)
   *
   * @param {string} serialNumber - Número de serie del certificado a renovar
   * @param {Object} [overrides] - Opciones para el nuevo certificado
   * @returns {Object} Nuevo certificado
   */
  async renewCertificate(serialNumber, overrides = {}) {
    const metadataPath = path.join(this.certsPath, serialNumber, 'metadata.json');
    if (!fs.existsSync(metadataPath)) {
      throw new Error('Certificate not found');
    }

    const oldMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

    // Emitir nuevo certificado con los mismos datos
    const newCert = await this.issueCertificate({
      commonName: overrides.commonName || oldMetadata.commonName,
      type: oldMetadata.type,
      identifier: oldMetadata.identifier,
      organization: overrides.organization || oldMetadata.organization,
      email: overrides.email || oldMetadata.email,
      validityDays: overrides.validityDays || this.config.cert_validity_days,
      passphrase: overrides.passphrase || ''
    });

    // Revocar el anterior
    this.revokeCertificate(serialNumber, 'superseded');

    return {
      ...newCert,
      previousSerialNumber: serialNumber
    };
  }

  /**
   * Obtiene el bundle .p12 de un certificado existente
   *
   * @param {string} serialNumber
   * @returns {Buffer|null}
   */
  getP12Bundle(serialNumber) {
    const p12Path = path.join(this.certsPath, serialNumber, 'bundle.p12');
    if (!fs.existsSync(p12Path)) return null;
    return fs.readFileSync(p12Path);
  }

  /**
   * Estadísticas de la CA
   */
  getStats() {
    const certs = this.listCertificates();
    const active = certs.filter(c => c.status === 'active');
    const revoked = certs.filter(c => c.status === 'revoked');
    const expired = certs.filter(c => c.status === 'expired');
    const clients = certs.filter(c => c.type === 'client');
    const devices = certs.filter(c => c.type === 'device');

    // Certificados próximos a expirar (30 días)
    const now = new Date();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const expiringSoon = active.filter(c => {
      const expires = new Date(c.expiresAt);
      return (expires - now) < thirtyDays;
    });

    return {
      total: certs.length,
      active: active.length,
      revoked: revoked.length,
      expired: expired.length,
      by_type: {
        client: clients.length,
        device: devices.length
      },
      expiring_soon: expiringSoon.length,
      crl_entries: this.crl.length,
      ca_initialized: !!this.caCert
    };
  }

  // ==========================================
  // Internal helpers
  // ==========================================

  /**
   * Genera número de serie hexadecimal único
   * @private
   */
  _generateSerialNumber() {
    return crypto.randomBytes(16).toString('hex').toUpperCase();
  }

  /**
   * Crea un certificado auto-firmado (para la CA raíz)
   * Usamos un formato PEM simplificado con la info embebida como extensión
   * @private
   */
  _createSelfSignedCert(certData, privateKey) {
    // Crear estructura del certificado
    const certBody = JSON.stringify({
      version: 3,
      serialNumber: certData.serialNumber,
      subject: certData.subject,
      issuer: certData.issuer,
      notBefore: certData.notBefore,
      notAfter: certData.notAfter,
      isCA: certData.isCA,
      publicKey: certData.publicKey,
      keyUsage: certData.isCA
        ? ['keyCertSign', 'cRLSign']
        : ['digitalSignature', 'keyEncipherment']
    });

    // Firmar con la clave privada
    const sign = crypto.createSign('SHA256');
    sign.update(certBody);
    const signature = sign.sign(privateKey, 'base64');

    // Formato PEM-like con body + signature
    const combined = Buffer.from(JSON.stringify({
      body: certBody,
      signature
    })).toString('base64');

    return `-----BEGIN CERTIFICATE-----\n${combined.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;
  }

  /**
   * Crea un certificado firmado por la CA
   * @private
   */
  _createSignedCert(certData, caPrivateKey) {
    const certBody = JSON.stringify({
      version: 3,
      serialNumber: certData.serialNumber,
      subject: certData.subject,
      issuer: certData.issuer,
      notBefore: certData.notBefore,
      notAfter: certData.notAfter,
      isCA: false,
      publicKey: certData.publicKey,
      keyUsage: ['digitalSignature', 'keyEncipherment'],
      extKeyUsage: ['clientAuth'],
      extensions: certData.extensions || {}
    });

    // Firmar con la clave de la CA
    const sign = crypto.createSign('SHA256');
    sign.update(certBody);
    const signature = sign.sign(caPrivateKey, 'base64');

    const combined = Buffer.from(JSON.stringify({
      body: certBody,
      signature
    })).toString('base64');

    return `-----BEGIN CERTIFICATE-----\n${combined.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;
  }

  /**
   * Verifica la firma de un certificado contra la CA
   * @private
   */
  _verifySignature(certificatePem) {
    try {
      const certContent = certificatePem
        .replace('-----BEGIN CERTIFICATE-----', '')
        .replace('-----END CERTIFICATE-----', '')
        .replace(/\s/g, '');

      const decoded = JSON.parse(Buffer.from(certContent, 'base64').toString());
      const { body, signature } = decoded;

      // Extraer la clave pública de la CA
      const caCertContent = this.caCert
        .replace('-----BEGIN CERTIFICATE-----', '')
        .replace('-----END CERTIFICATE-----', '')
        .replace(/\s/g, '');
      const caDecoded = JSON.parse(Buffer.from(caCertContent, 'base64').toString());
      const caBody = JSON.parse(caDecoded.body);

      // Verificar firma con la clave pública de la CA
      const verify = crypto.createVerify('SHA256');
      verify.update(body);
      return verify.verify(caBody.publicKey, signature, 'base64');
    } catch {
      return false;
    }
  }

  /**
   * Extrae información básica de un certificado PEM
   * @private
   */
  _parseCertificateInfo(certificatePem) {
    try {
      const certContent = certificatePem
        .replace('-----BEGIN CERTIFICATE-----', '')
        .replace('-----END CERTIFICATE-----', '')
        .replace(/\s/g, '');

      const decoded = JSON.parse(Buffer.from(certContent, 'base64').toString());
      const body = JSON.parse(decoded.body);

      return {
        serialNumber: body.serialNumber,
        subject: body.subject,
        issuer: body.issuer,
        notBefore: body.notBefore,
        notAfter: body.notAfter,
        isCA: body.isCA,
        extensions: body.extensions || {}
      };
    } catch {
      return null;
    }
  }

  /**
   * Crea un bundle PKCS#12 (certificado + clave privada)
   * Nota: Node.js nativo no soporta crear .p12 directamente.
   * Almacenamos cert + key en un formato empaquetado firmado.
   * Para producción real se usaría `openssl pkcs12` o la lib `node-forge`.
   * @private
   */
  _createP12Bundle(certificate, privateKey, passphrase) {
    // Crear un bundle empaquetado (cert + key cifrado con passphrase)
    const bundleData = {
      certificate,
      key: privateKey,
      created: new Date().toISOString()
    };

    const bundleJson = JSON.stringify(bundleData);

    if (passphrase) {
      // Cifrar con AES-256-GCM usando passphrase
      const salt = crypto.randomBytes(16);
      const key = crypto.scryptSync(passphrase, salt, 32);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

      let encrypted = cipher.update(bundleJson, 'utf8', 'base64');
      encrypted += cipher.final('base64');
      const authTag = cipher.getAuthTag();

      return Buffer.from(JSON.stringify({
        encrypted: true,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        data: encrypted
      }));
    }

    return Buffer.from(bundleJson);
  }

  /**
   * Guarda la CRL en disco
   * @private
   */
  _saveCRL() {
    fs.writeFileSync(this.crlPath, JSON.stringify(this.crl, null, 2));
  }
}

module.exports = CAManager;
