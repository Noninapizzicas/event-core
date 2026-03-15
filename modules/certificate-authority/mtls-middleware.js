/**
 * mTLS Middleware - Autenticación por certificado cliente
 *
 * Middleware para el HTTP Gateway que valida certificados cliente
 * presentados en la conexión TLS.
 *
 * Dos modos de operación:
 *   1. TLS nativo (Node.js tls.createServer con requestCert)
 *   2. Proxy mode (nginx/reverse-proxy pasa el cert en header X-Client-Cert)
 *
 * Se integra al gateway vía hook beforeRequest.
 */

class MTLSMiddleware {
  /**
   * @param {Object} options
   * @param {Object} options.caManager - CAManager instance
   * @param {Object} [options.logger] - Logger
   * @param {Object} [options.metrics] - Metrics
   * @param {string} [options.mode] - 'native' | 'proxy' (default: 'proxy')
   * @param {string} [options.certHeader] - Header con el certificado en modo proxy
   * @param {Array<string>} [options.excludePaths] - Paths que no requieren certificado
   * @param {boolean} [options.allowUnauthenticated] - Si true, permite acceso sin cert
   */
  constructor(options = {}) {
    this.caManager = options.caManager;
    this.logger = options.logger || null;
    this.metrics = options.metrics || null;
    this.mode = options.mode || 'proxy';
    this.certHeader = options.certHeader || 'x-client-cert';
    this.excludePaths = options.excludePaths || [
      '/health',
      '/ready',
      '/stats',
      '/modules/certificate-authority/ca-cert',
      '/3333/ca-cert'
    ];
    this.allowUnauthenticated = options.allowUnauthenticated || false;

    this.stats = {
      authenticated: 0,
      rejected: 0,
      bypassed: 0,
      errors: 0
    };
  }

  /**
   * Hook handler para beforeRequest del HTTP gateway
   *
   * @param {Object} context - Request context del gateway
   * @returns {Object|null} context modificado (null = bloquear request)
   */
  async authenticate(context) {
    if (!context) return context;

    const { path, headers } = context;

    // Verificar exclusiones
    if (this._isExcludedPath(path)) {
      this.stats.bypassed++;
      return context;
    }

    // Obtener certificado según modo
    let clientCert = null;

    if (this.mode === 'proxy') {
      // En modo proxy, nginx pasa el certificado URL-encoded en un header
      const certHeader = headers?.[this.certHeader];
      if (certHeader) {
        try {
          clientCert = decodeURIComponent(certHeader);
        } catch {
          clientCert = certHeader;
        }
      }
    } else if (this.mode === 'native') {
      // En modo TLS nativo, el cert viene en el socket
      clientCert = context._tlsCertificate;
    }

    // Sin certificado
    if (!clientCert) {
      if (this.allowUnauthenticated) {
        this.stats.bypassed++;
        return {
          ...context,
          auth: { authenticated: false, method: 'none' }
        };
      }

      this.stats.rejected++;
      if (this.logger) {
        this.logger.warn('mtls.no_certificate', { path });
      }
      return null; // Bloquea el request (gateway devuelve 403)
    }

    // Verificar certificado contra la CA
    try {
      const verification = this.caManager.verifyCertificate(clientCert);

      if (!verification.valid) {
        this.stats.rejected++;
        if (this.logger) {
          this.logger.warn('mtls.invalid_certificate', {
            path,
            error: verification.error,
            serialNumber: verification.serialNumber
          });
        }

        if (this.metrics) {
          this.metrics.increment('mtls.rejected');
        }

        return null; // Bloquear
      }

      // Certificado válido — enriquecer contexto
      this.stats.authenticated++;

      if (this.logger) {
        this.logger.debug('mtls.authenticated', {
          path,
          type: verification.type,
          identifier: verification.identifier,
          serialNumber: verification.serialNumber
        });
      }

      if (this.metrics) {
        this.metrics.increment('mtls.authenticated');
      }

      return {
        ...context,
        auth: {
          authenticated: true,
          method: 'mtls',
          type: verification.type,
          identifier: verification.identifier,
          commonName: verification.commonName,
          serialNumber: verification.serialNumber,
          expiresAt: verification.expiresAt
        }
      };

    } catch (error) {
      this.stats.errors++;

      if (this.logger) {
        this.logger.error('mtls.verification_error', {
          path,
          error: error.message
        }, error);
      }

      return null; // Bloquear ante error
    }
  }

  /**
   * Genera configuración TLS para Node.js https.createServer
   * (modo nativo — alternativa a usar proxy)
   *
   * @returns {Object} Opciones para tls.createServer / https.createServer
   */
  getTLSOptions() {
    const caCert = this.caManager.getCACertificate();

    return {
      // Requerir certificado cliente
      requestCert: true,
      // Rechazar si no presenta certificado (false = permite sin cert)
      rejectUnauthorized: !this.allowUnauthenticated,
      // Nuestra CA como autoridad aceptada
      ca: [caCert]
    };
  }

  /**
   * Genera configuración nginx para mTLS
   *
   * @returns {string} Fragmento de configuración nginx
   */
  getNginxConfig() {
    return `# mTLS Configuration for Event Core
# Instalar el certificado CA en nginx:
# ssl_client_certificate /path/to/ca-cert.pem;
# ssl_verify_client on;  # o 'optional' para permitir sin cert
#
# Pasar certificado al backend:
# proxy_set_header X-Client-Cert $ssl_client_escaped_cert;
#
# Ejemplo completo:
server {
    listen 443 ssl;
    server_name portal.example.com;

    ssl_certificate     /etc/ssl/server-cert.pem;
    ssl_certificate_key /etc/ssl/server-key.pem;

    # mTLS - Certificado cliente
    ssl_client_certificate /path/to/ca-cert.pem;
    ssl_verify_client on;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header X-Client-Cert $ssl_client_escaped_cert;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
    }
}`;
  }

  /**
   * Estadísticas del middleware
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Verifica si un path está excluido de autenticación
   * @private
   */
  _isExcludedPath(requestPath) {
    if (!requestPath) return false;
    return this.excludePaths.some(excluded => {
      if (excluded.endsWith('*')) {
        return requestPath.startsWith(excluded.slice(0, -1));
      }
      return requestPath === excluded || requestPath.startsWith(excluded + '/');
    });
  }
}

module.exports = MTLSMiddleware;
