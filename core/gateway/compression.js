/**
 * Compression Middleware for HTTP Gateway
 *
 * Provides automatic response compression using gzip or brotli:
 * - Auto-detection from Accept-Encoding header
 * - Configurable minimum size (don't compress small payloads)
 * - Content-type whitelist (JSON, HTML, CSS, JS, XML, text)
 * - Compression metrics (ratio, bytes saved)
 * - Brotli preferred (better compression) with gzip fallback
 *
 * Reduces bandwidth by ~70-80% for compressible content.
 *
 * @example
 * const compression = new CompressionMiddleware({
 *   enabled: true,
 *   minSize: 1024,
 *   level: 6
 * });
 *
 * const result = await compression.compress(data, headers);
 * // Returns: { data, encoding, originalSize, compressedSize, ratio }
 */

const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const brotliCompress = promisify(zlib.brotliCompress);

class CompressionMiddleware {
  /**
   * @param {Object} options - Configuration
   * @param {boolean} options.enabled - Enable compression (default: true)
   * @param {number} options.minSize - Minimum size in bytes to compress (default: 1024)
   * @param {number} options.level - Compression level 1-9 (default: 6)
   * @param {Array<string>} options.contentTypes - Content types to compress
   * @param {Object} options.logger - Logger instance (optional)
   * @param {Object} options.metrics - Metrics instance (optional)
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.minSize = options.minSize || 1024; // 1KB minimum
    this.level = options.level || 6; // Compression level (1-9)
    this.logger = options.logger || null;
    this.metrics = options.metrics || null;

    // Content types that should be compressed
    this.compressibleTypes = options.contentTypes || [
      'application/json',
      'application/javascript',
      'application/xml',
      'text/html',
      'text/css',
      'text/plain',
      'text/xml',
      'text/javascript',
      'image/svg+xml'
    ];

    // Statistics
    this.stats = {
      requests: 0,
      compressed: 0,
      skipped: 0,
      originalBytes: 0,
      compressedBytes: 0,
      bytesSaved: 0,
      avgRatio: 0
    };

    if (this.logger) {
      this.logger.debug('compression.initialized', {
        enabled: this.enabled,
        min_size: this.minSize,
        level: this.level
      });
    }
  }

  /**
   * Compress response data if applicable
   *
   * @param {Buffer|string|Object} data - Response data
   * @param {Object} headers - Request headers
   * @param {string} contentType - Response content type
   * @returns {Promise<Object>} - { data, encoding, originalSize, compressedSize, ratio, compressed }
   */
  async compress(data, headers = {}, contentType = 'application/json') {
    this.stats.requests++;

    // Check if compression is enabled
    if (!this.enabled) {
      return this._skipCompression(data, 'disabled');
    }

    // Convert data to buffer/string
    let buffer;
    if (Buffer.isBuffer(data)) {
      buffer = data;
    } else if (typeof data === 'string') {
      buffer = Buffer.from(data, 'utf-8');
    } else {
      // Assume JSON
      buffer = Buffer.from(JSON.stringify(data), 'utf-8');
    }

    const originalSize = buffer.length;
    this.stats.originalBytes += originalSize;

    // Check minimum size
    if (originalSize < this.minSize) {
      return this._skipCompression(buffer, 'too_small', originalSize);
    }

    // Check content type
    if (!this._shouldCompressContentType(contentType)) {
      return this._skipCompression(buffer, 'incompressible_type', originalSize);
    }

    // Check Accept-Encoding header
    const acceptEncoding = headers['accept-encoding'] || '';
    const encoding = this._selectEncoding(acceptEncoding);

    if (!encoding) {
      return this._skipCompression(buffer, 'no_encoding_support', originalSize);
    }

    // Compress
    try {
      const startTime = Date.now();
      const compressed = await this._compressBuffer(buffer, encoding);
      const duration = Date.now() - startTime;

      const compressedSize = compressed.length;
      const ratio = ((1 - compressedSize / originalSize) * 100).toFixed(2);
      const bytesSaved = originalSize - compressedSize;

      // Update statistics
      this.stats.compressed++;
      this.stats.compressedBytes += compressedSize;
      this.stats.bytesSaved += bytesSaved;
      this._updateAvgRatio(parseFloat(ratio));

      if (this.logger) {
        this.logger.debug('compression.success', {
          encoding,
          original_size: originalSize,
          compressed_size: compressedSize,
          ratio: `${ratio}%`,
          bytes_saved: bytesSaved,
          duration
        });
      }

      if (this.metrics) {
        this.metrics.increment('compression.compressed');
        this.metrics.observe('compression.ratio', parseFloat(ratio));
        this.metrics.observe('compression.bytes_saved', bytesSaved);
        this.metrics.observe('compression.duration', duration);
      }

      return {
        data: compressed,
        encoding,
        originalSize,
        compressedSize,
        ratio: parseFloat(ratio),
        bytesSaved,
        compressed: true
      };

    } catch (error) {
      if (this.logger) {
        this.logger.error('compression.error', {
          error: error.message,
          encoding
        }, error);
      }

      if (this.metrics) {
        this.metrics.increment('compression.errors');
      }

      // Return uncompressed on error
      return this._skipCompression(buffer, 'error', originalSize);
    }
  }

  /**
   * Compress buffer with specified encoding
   *
   * @param {Buffer} buffer - Data to compress
   * @param {string} encoding - 'gzip' or 'br'
   * @returns {Promise<Buffer>} - Compressed data
   * @private
   */
  async _compressBuffer(buffer, encoding) {
    if (encoding === 'br') {
      // Brotli compression
      return brotliCompress(buffer, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: this.level
        }
      });
    } else {
      // Gzip compression
      return gzip(buffer, {
        level: this.level
      });
    }
  }

  /**
   * Select best encoding from Accept-Encoding header
   *
   * @param {string} acceptEncoding - Accept-Encoding header value
   * @returns {string|null} - 'br', 'gzip', or null
   * @private
   */
  _selectEncoding(acceptEncoding) {
    const encodings = acceptEncoding.toLowerCase().split(',').map(e => e.trim());

    // Prefer brotli (better compression)
    if (encodings.includes('br')) {
      return 'br';
    }

    // Fallback to gzip
    if (encodings.includes('gzip')) {
      return 'gzip';
    }

    return null;
  }

  /**
   * Check if content type should be compressed
   *
   * @param {string} contentType - Content-Type header
   * @returns {boolean}
   * @private
   */
  _shouldCompressContentType(contentType) {
    if (!contentType) {
      return false;
    }

    // Extract base type (remove charset, etc.)
    const baseType = contentType.split(';')[0].trim().toLowerCase();

    return this.compressibleTypes.includes(baseType);
  }

  /**
   * Skip compression and return original data
   *
   * @param {Buffer} buffer - Original data
   * @param {string} reason - Skip reason
   * @param {number} originalSize - Original size
   * @returns {Object}
   * @private
   */
  _skipCompression(buffer, reason, originalSize = 0) {
    this.stats.skipped++;

    if (this.metrics) {
      this.metrics.increment('compression.skipped', 1, { reason });
    }

    return {
      data: buffer,
      encoding: null,
      originalSize,
      compressedSize: originalSize,
      ratio: 0,
      bytesSaved: 0,
      compressed: false,
      skipReason: reason
    };
  }

  /**
   * Update average compression ratio
   *
   * @param {number} ratio - Current ratio
   * @private
   */
  _updateAvgRatio(ratio) {
    if (this.stats.compressed === 1) {
      this.stats.avgRatio = ratio;
    } else {
      // Running average
      this.stats.avgRatio =
        (this.stats.avgRatio * (this.stats.compressed - 1) + ratio) / this.stats.compressed;
    }
  }

  /**
   * Get compression statistics
   *
   * @returns {Object} - Statistics
   */
  getStats() {
    return {
      ...this.stats,
      compressionRate: this.stats.requests > 0
        ? ((this.stats.compressed / this.stats.requests) * 100).toFixed(2) + '%'
        : '0%',
      totalSavings: this.stats.originalBytes > 0
        ? ((this.stats.bytesSaved / this.stats.originalBytes) * 100).toFixed(2) + '%'
        : '0%'
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      requests: 0,
      compressed: 0,
      skipped: 0,
      originalBytes: 0,
      compressedBytes: 0,
      bytesSaved: 0,
      avgRatio: 0
    };
  }
}

module.exports = CompressionMiddleware;
