/**
 * ValidationManager - Sistema centralizado de validación con AJV
 *
 * Proporciona validación de datos usando JSON Schema con:
 * - Caché de schemas compilados para performance
 * - Soporte para schemas inline y registrados
 * - Formato de errores legible para usuarios
 * - Integración con logger para debugging
 * - Coerción de tipos y aplicación de defaults
 *
 * @example
 * const validator = new ValidationManager({ logger });
 *
 * // Registrar schema
 * validator.registerSchema('user.create', {
 *   type: 'object',
 *   required: ['email', 'name'],
 *   properties: {
 *     email: { type: 'string', format: 'email' },
 *     name: { type: 'string', minLength: 1 }
 *   }
 * });
 *
 * // Validar datos
 * const result = validator.validate('user.create', data);
 * if (!result.valid) {
 *   console.error(result.errors);
 * }
 */

const Ajv = require('ajv');

// ajv-formats es opcional - agregar si está disponible
let addFormats;
try {
  addFormats = require('ajv-formats');
} catch (e) {
  addFormats = null;
}

class ValidationManager {
  /**
   * @param {Object} options - Opciones de configuración
   * @param {Object} options.logger - Logger instance (opcional)
   * @param {boolean} options.allErrors - Reportar todos los errores (default: true)
   * @param {boolean} options.removeAdditional - Remover propiedades adicionales (default: true)
   * @param {boolean} options.useDefaults - Aplicar defaults del schema (default: true)
   * @param {boolean} options.coerceTypes - Coerción automática de tipos (default: true)
   * @param {boolean} options.strict - Modo estricto de AJV (default: false)
   */
  constructor(options = {}) {
    this.logger = options.logger || null;

    // Configurar AJV con opciones optimizadas
    this.ajv = new Ajv({
      allErrors: options.allErrors !== false,
      removeAdditional: options.removeAdditional !== false,
      useDefaults: options.useDefaults !== false,
      coerceTypes: options.coerceTypes !== false,
      strict: options.strict || false,
      // Opciones adicionales
      verbose: true,  // Para mejor debugging
      $data: true     // Soporte para $data references
    });

    // Agregar formatos estándar (email, uri, date-time, etc.) si disponible
    if (addFormats) {
      addFormats(this.ajv);
    }

    // Caché de schemas compilados: { schemaId: compiledValidator }
    this.schemas = new Map();

    // Estadísticas de validación
    this.stats = {
      validations: 0,
      successes: 0,
      failures: 0,
      by_schema: {}
    };

    if (this.logger) {
      this.logger.debug('validation.manager.initialized', {
        allErrors: options.allErrors !== false,
        removeAdditional: options.removeAdditional !== false,
        coerceTypes: options.coerceTypes !== false
      });
    }
  }

  /**
   * Registra un schema para validación
   *
   * @param {string} schemaId - Identificador único del schema
   * @param {Object} schema - JSON Schema
   * @returns {boolean} - true si se registró correctamente
   *
   * @example
   * validator.registerSchema('api.request', {
   *   type: 'object',
   *   required: ['path', 'method'],
   *   properties: {
   *     path: { type: 'string' },
   *     method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] }
   *   }
   * });
   */
  registerSchema(schemaId, schema) {
    try {
      // Compilar schema (esto valida el schema también)
      const validate = this.ajv.compile(schema);

      // Guardar en caché
      this.schemas.set(schemaId, {
        schema,
        validate,
        registeredAt: new Date().toISOString()
      });

      // Inicializar estadísticas para este schema
      this.stats.by_schema[schemaId] = {
        validations: 0,
        successes: 0,
        failures: 0
      };

      if (this.logger) {
        this.logger.debug('validation.schema.registered', {
          schema_id: schemaId,
          required: schema.required || [],
          properties: schema.properties ? Object.keys(schema.properties).length : 0
        });
      }

      return true;

    } catch (error) {
      if (this.logger) {
        this.logger.error('validation.schema.registration_failed', {
          schema_id: schemaId,
          error: error.message
        }, error);
      }
      throw new Error(`Failed to register schema '${schemaId}': ${error.message}`);
    }
  }

  /**
   * Valida datos contra un schema registrado
   *
   * @param {string} schemaId - ID del schema registrado
   * @param {*} data - Datos a validar
   * @returns {Object} - { valid: boolean, errors: array|null, data: * }
   *
   * @example
   * const result = validator.validate('user.create', { email: 'test@example.com' });
   * if (!result.valid) {
   *   console.error('Validation failed:', result.errors);
   * }
   */
  validate(schemaId, data) {
    const schemaEntry = this.schemas.get(schemaId);

    if (!schemaEntry) {
      const error = `Schema '${schemaId}' not registered`;

      if (this.logger) {
        this.logger.warn('validation.schema.not_found', {
          schema_id: schemaId
        });
      }

      return {
        valid: false,
        errors: [{ message: error, schemaId }],
        data: null
      };
    }

    // Ejecutar validación
    this.stats.validations++;
    this.stats.by_schema[schemaId].validations++;

    const valid = schemaEntry.validate(data);

    if (valid) {
      this.stats.successes++;
      this.stats.by_schema[schemaId].successes++;

      return {
        valid: true,
        errors: null,
        data: data  // Puede haber sido modificado (coercion, defaults, removeAdditional)
      };

    } else {
      this.stats.failures++;
      this.stats.by_schema[schemaId].failures++;

      const formattedErrors = this.formatErrors(schemaEntry.validate.errors);

      if (this.logger) {
        this.logger.warn('validation.failed', {
          schema_id: schemaId,
          error_count: formattedErrors.length,
          errors: formattedErrors
        });
      }

      return {
        valid: false,
        errors: formattedErrors,
        data: null
      };
    }
  }

  /**
   * Valida datos con un schema inline (no registrado)
   * Útil para validaciones one-off
   *
   * @param {Object} schema - JSON Schema
   * @param {*} data - Datos a validar
   * @returns {Object} - { valid: boolean, errors: array|null, data: * }
   *
   * @example
   * const result = validator.validateInline(
   *   { type: 'string', minLength: 5 },
   *   'hello'
   * );
   */
  validateInline(schema, data) {
    try {
      const validate = this.ajv.compile(schema);
      const valid = validate(data);

      this.stats.validations++;

      if (valid) {
        this.stats.successes++;
        return {
          valid: true,
          errors: null,
          data: data
        };
      } else {
        this.stats.failures++;
        return {
          valid: false,
          errors: this.formatErrors(validate.errors),
          data: null
        };
      }

    } catch (error) {
      if (this.logger) {
        this.logger.error('validation.inline.failed', {
          error: error.message
        }, error);
      }

      return {
        valid: false,
        errors: [{ message: `Schema compilation failed: ${error.message}` }],
        data: null
      };
    }
  }

  /**
   * Formatea errores de AJV en un formato legible
   *
   * @param {Array} ajvErrors - Array de errores de AJV
   * @returns {Array} - Array de errores formateados
   *
   * @private
   */
  formatErrors(ajvErrors) {
    if (!ajvErrors || ajvErrors.length === 0) {
      return [];
    }

    return ajvErrors.map(err => {
      const path = err.instancePath || '/';
      const message = err.message || 'Validation error';

      // Construir mensaje específico según el tipo de error
      let detailedMessage = message;

      switch (err.keyword) {
        case 'required':
          detailedMessage = `Missing required property: ${err.params.missingProperty}`;
          break;
        case 'type':
          detailedMessage = `Invalid type at ${path}: expected ${err.params.type}`;
          break;
        case 'format':
          detailedMessage = `Invalid format at ${path}: expected ${err.params.format}`;
          break;
        case 'enum':
          detailedMessage = `Invalid value at ${path}: must be one of [${err.params.allowedValues.join(', ')}]`;
          break;
        case 'minLength':
          detailedMessage = `String at ${path} is too short: minimum ${err.params.limit} characters`;
          break;
        case 'maxLength':
          detailedMessage = `String at ${path} is too long: maximum ${err.params.limit} characters`;
          break;
        case 'minimum':
          detailedMessage = `Value at ${path} is too small: minimum ${err.params.limit}`;
          break;
        case 'maximum':
          detailedMessage = `Value at ${path} is too large: maximum ${err.params.limit}`;
          break;
        case 'pattern':
          detailedMessage = `Value at ${path} does not match pattern: ${err.params.pattern}`;
          break;
        case 'additionalProperties':
          detailedMessage = `Unexpected property at ${path}: ${err.params.additionalProperty}`;
          break;
      }

      return {
        path,
        keyword: err.keyword,
        message: detailedMessage,
        params: err.params,
        data: err.data
      };
    });
  }

  /**
   * Desregistra un schema
   *
   * @param {string} schemaId - ID del schema a desregistrar
   * @returns {boolean} - true si se desregistró, false si no existía
   */
  unregisterSchema(schemaId) {
    const existed = this.schemas.has(schemaId);

    if (existed) {
      this.schemas.delete(schemaId);
      delete this.stats.by_schema[schemaId];

      if (this.logger) {
        this.logger.debug('validation.schema.unregistered', {
          schema_id: schemaId
        });
      }
    }

    return existed;
  }

  /**
   * Verifica si un schema está registrado
   *
   * @param {string} schemaId - ID del schema
   * @returns {boolean}
   */
  hasSchema(schemaId) {
    return this.schemas.has(schemaId);
  }

  /**
   * Obtiene un schema registrado
   *
   * @param {string} schemaId - ID del schema
   * @returns {Object|null} - Schema object o null si no existe
   */
  getSchema(schemaId) {
    const entry = this.schemas.get(schemaId);
    return entry ? entry.schema : null;
  }

  /**
   * Lista todos los schemas registrados
   *
   * @returns {Array<string>} - Array de schema IDs
   */
  listSchemas() {
    return Array.from(this.schemas.keys());
  }

  /**
   * Limpia todos los schemas registrados
   */
  clearSchemas() {
    this.schemas.clear();
    this.stats.by_schema = {};

    if (this.logger) {
      this.logger.debug('validation.schemas.cleared');
    }
  }

  /**
   * Obtiene estadísticas de validación
   *
   * @param {string} [schemaId] - ID de schema específico (opcional)
   * @returns {Object} - Estadísticas
   */
  getStats(schemaId) {
    if (schemaId) {
      return this.stats.by_schema[schemaId] || null;
    }
    return { ...this.stats };
  }

  /**
   * Resetea estadísticas
   *
   * @param {string} [schemaId] - ID de schema específico (opcional)
   */
  resetStats(schemaId) {
    if (schemaId) {
      if (this.stats.by_schema[schemaId]) {
        this.stats.by_schema[schemaId] = {
          validations: 0,
          successes: 0,
          failures: 0
        };
      }
    } else {
      this.stats.validations = 0;
      this.stats.successes = 0;
      this.stats.failures = 0;

      Object.keys(this.stats.by_schema).forEach(id => {
        this.stats.by_schema[id] = {
          validations: 0,
          successes: 0,
          failures: 0
        };
      });
    }
  }
}

/**
 * ValidationError - Error personalizado para fallos de validación
 */
class ValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'ValidationError';
    this.errors = errors;
    this.statusCode = 400;  // HTTP status code
  }

  toJSON() {
    return {
      error: this.message,
      validation_errors: this.errors,
      status: this.statusCode
    };
  }
}

module.exports = { ValidationManager, ValidationError };
