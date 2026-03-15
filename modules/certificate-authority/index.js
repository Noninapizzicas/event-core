/**
 * Certificate Authority Module v1.0.0
 *
 * Módulo de Autoridad Certificadora interna para Event Core.
 * Emite, revoca y verifica certificados X.509 cliente.
 *
 * Dos casos de uso:
 *   1. Certificados para clientes del portal de facturación
 *   2. Certificados para dispositivos de trabajo
 *
 * Se integra al gateway HTTP vía hook beforeRequest para
 * autenticación mTLS transparente.
 *
 * Emite: certificate.issued, certificate.revoked, certificate.renewed, certificate.expired
 * Hooks: beforeRequest (autenticación mTLS)
 */

const CAManager = require('./ca-manager');
const MTLSMiddleware = require('./mtls-middleware');

class CertificateAuthorityModule {
  constructor() {
    this.name = 'certificate-authority';
    this.version = '1.0.0';

    this.caManager = null;
    this.mtlsMiddleware = null;

    this.stats = {
      certificates_issued: 0,
      certificates_revoked: 0,
      certificates_renewed: 0,
      verification_requests: 0
    };

    // Dependencias (inyectadas en onLoad)
    this.core = null;
    this.logger = null;
    this.metrics = null;
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(core) {
    this.core = core;
    this.logger = core.logger;
    this.metrics = core.metrics;

    // Leer configuración del módulo (inyectada por el loader desde module.json)
    const config = core.moduleConfig || {};

    // Inicializar CA Manager
    this.caManager = new CAManager({
      storagePath: config.storagePath,
      ca_cn: config.ca_cn,
      ca_org: config.ca_org,
      ca_validity_days: config.ca_validity_days,
      cert_validity_days: config.cert_validity_days,
      key_size: config.key_size
    });

    const result = await this.caManager.initialize();

    // Inicializar middleware mTLS
    this.mtlsMiddleware = new MTLSMiddleware({
      caManager: this.caManager,
      logger: this.logger,
      metrics: this.metrics,
      mode: config.mtls_mode || 'proxy',
      certHeader: config.cert_header || 'x-client-cert',
      excludePaths: config.exclude_paths || [
        '/health',
        '/ready',
        '/stats',
        '/modules/certificate-authority/ca-cert',
        '/modules/certificate-authority/status'
      ],
      allowUnauthenticated: config.allow_unauthenticated !== false // true por defecto durante desarrollo
    });

    // Registrar hook para autenticación mTLS
    if (core.hooks && config.mtls_enabled) {
      core.hooks.register('beforeRequest', this.mtlsMiddleware.authenticate.bind(this.mtlsMiddleware));
    }

    if (this.logger) {
      this.logger.info('module.loaded', {
        module: this.name,
        version: this.version,
        ca_created: result.created,
        ca_loaded: result.loaded,
        mtls_enabled: !!config.mtls_enabled,
        mtls_mode: config.mtls_mode || 'proxy'
      });
    }
  }

  async onUnload() {
    // UI handlers auto-unwired by loader
    if (this.logger) {
      this.logger.info('module.unloaded', { module: this.name });
    }
  }

  // ==========================================
  // API Handlers
  // ==========================================

  /**
   * GET /status — Estado del módulo y la CA
   */
  async handleStatus() {
    return {
      status: 200,
      data: {
        module: this.name,
        version: this.version,
        ca: this.caManager.getStats(),
        mtls: this.mtlsMiddleware.getStats(),
        stats: this.stats
      }
    };
  }

  /**
   * GET /ca-cert — Descargar certificado raíz de la CA
   * (público — para que clientes/dispositivos instalen la CA)
   */
  async handleGetCACert() {
    const cert = this.caManager.getCACertificate();
    return {
      status: 200,
      data: {
        certificate: cert,
        instructions: {
          browser: 'Importar como "Autoridad de certificación" en Configuración > Certificados',
          windows: 'Doble click > Instalar certificado > Almacén: Entidades de certificación raíz de confianza',
          macos: 'Abrir con Acceso a Llaveros > Añadir a "Sistema" > Confiar siempre',
          linux: 'Copiar a /usr/local/share/ca-certificates/ y ejecutar update-ca-certificates',
          android: 'Configuración > Seguridad > Instalar desde almacenamiento',
          ios: 'Enviar por email > Instalar perfil > Configuración > General > Gestión de perfiles'
        }
      }
    };
  }

  /**
   * POST /issue — Emitir nuevo certificado
   */
  async handleIssueCertificate({ body }) {
    const { commonName, type, identifier, organization, email, validityDays, passphrase } = body || {};

    if (!commonName || !type || !identifier) {
      return {
        status: 400,
        data: {
          error: 'Required fields: commonName, type (client|device), identifier'
        }
      };
    }

    try {
      const result = await this.caManager.issueCertificate({
        commonName,
        type,
        identifier,
        organization,
        email,
        validityDays,
        passphrase
      });

      this.stats.certificates_issued++;

      // Emitir evento
      if (this.core?.emit) {
        this.core.emit('certificate.issued', {
          serialNumber: result.serialNumber,
          type,
          identifier,
          commonName,
          fingerprint: result.fingerprint
        });
      }

      if (this.logger) {
        this.logger.info('certificate.issued', {
          serialNumber: result.serialNumber,
          type,
          identifier,
          commonName
        });
      }

      return {
        status: 201,
        data: {
          serialNumber: result.serialNumber,
          fingerprint: result.fingerprint,
          metadata: result.metadata,
          // No devolver la clave privada por HTTP — solo disponible via download P12
          certificate: result.certificate,
          hasP12: !!result.p12
        }
      };
    } catch (error) {
      return {
        status: 400,
        data: { error: error.message }
      };
    }
  }

  /**
   * POST /revoke — Revocar certificado
   */
  async handleRevokeCertificate({ body }) {
    const { serialNumber, reason } = body || {};

    if (!serialNumber) {
      return { status: 400, data: { error: 'serialNumber is required' } };
    }

    const result = this.caManager.revokeCertificate(serialNumber, reason);

    if (result.revoked) {
      this.stats.certificates_revoked++;

      if (this.core?.emit) {
        this.core.emit('certificate.revoked', {
          serialNumber,
          reason: reason || 'unspecified'
        });
      }

      if (this.logger) {
        this.logger.info('certificate.revoked', { serialNumber, reason });
      }
    }

    return {
      status: result.revoked ? 200 : 400,
      data: result
    };
  }

  /**
   * POST /renew — Renovar certificado
   */
  async handleRenewCertificate({ body }) {
    const { serialNumber, passphrase, validityDays } = body || {};

    if (!serialNumber) {
      return { status: 400, data: { error: 'serialNumber is required' } };
    }

    try {
      const result = await this.caManager.renewCertificate(serialNumber, {
        passphrase,
        validityDays
      });

      this.stats.certificates_renewed++;

      if (this.core?.emit) {
        this.core.emit('certificate.renewed', {
          oldSerialNumber: serialNumber,
          newSerialNumber: result.serialNumber
        });
      }

      if (this.logger) {
        this.logger.info('certificate.renewed', {
          old: serialNumber,
          new: result.serialNumber
        });
      }

      return {
        status: 200,
        data: {
          serialNumber: result.serialNumber,
          previousSerialNumber: result.previousSerialNumber,
          fingerprint: result.fingerprint,
          metadata: result.metadata
        }
      };
    } catch (error) {
      return { status: 400, data: { error: error.message } };
    }
  }

  /**
   * GET /list — Listar certificados
   */
  async handleListCertificates({ query }) {
    const filters = {};
    if (query?.type) filters.type = query.type;
    if (query?.status) filters.status = query.status;
    if (query?.identifier) filters.identifier = query.identifier;

    const certs = this.caManager.listCertificates(filters);

    return {
      status: 200,
      data: {
        certificates: certs,
        total: certs.length,
        filters
      }
    };
  }

  /**
   * POST /verify — Verificar certificado
   */
  async handleVerifyCertificate({ body }) {
    const { certificate } = body || {};

    if (!certificate) {
      return { status: 400, data: { error: 'certificate (PEM) is required' } };
    }

    this.stats.verification_requests++;
    const result = this.caManager.verifyCertificate(certificate);

    return {
      status: 200,
      data: result
    };
  }

  /**
   * GET /crl — Obtener lista de revocación
   */
  async handleGetCRL() {
    return {
      status: 200,
      data: {
        revoked: this.caManager.getCRL(),
        updated: new Date().toISOString()
      }
    };
  }

  /**
   * GET /download-p12/:serialNumber — Descargar bundle .p12
   */
  async handleDownloadP12({ query }) {
    const { serialNumber } = query || {};

    if (!serialNumber) {
      return { status: 400, data: { error: 'serialNumber query param is required' } };
    }

    const p12 = this.caManager.getP12Bundle(serialNumber);

    if (!p12) {
      return { status: 404, data: { error: 'P12 bundle not found (may have been revoked)' } };
    }

    return {
      status: 200,
      data: {
        serialNumber,
        bundle: p12.toString('base64'),
        contentType: 'application/x-pkcs12',
        filename: `certificate-${serialNumber.substring(0, 8)}.p12`
      }
    };
  }

  /**
   * GET /nginx-config — Configuración nginx para mTLS
   */
  async handleGetNginxConfig() {
    return {
      status: 200,
      data: {
        config: this.mtlsMiddleware.getNginxConfig()
      }
    };
  }

  /**
   * GET /health — Health check
   */
  async handleHealthCheck() {
    const caStats = this.caManager.getStats();

    return {
      status: 200,
      data: {
        module: this.name,
        status: caStats.ca_initialized ? 'healthy' : 'degraded',
        ca_initialized: caStats.ca_initialized,
        active_certificates: caStats.active,
        expiring_soon: caStats.expiring_soon,
        mtls_stats: this.mtlsMiddleware.getStats()
      }
    };
  }

}

module.exports = CertificateAuthorityModule;
