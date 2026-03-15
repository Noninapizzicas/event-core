/**
 * HTTP Validation Middleware
 *
 * Middleware para validar requests y responses HTTP usando JSON Schema
 *
 * Features:
 * - Validación automática de request body, query params, headers
 * - Validación opcional de responses (modo warning)
 * - Integración con ValidationManager
 * - Errores HTTP 400 con detalles de validación
 * - Logging de errores de validación
 */

const { ValidationError } = require('./manager');

/**
 * Crea middleware de validación para requests HTTP
 *
 * @param {ValidationManager} validationManager - Instance del ValidationManager
 * @param {Object} options - Opciones de configuración
 * @param {boolean} options.requireSchemas - Rechazar requests sin schema (default: false)
 * @param {boolean} options.validateResponses - Validar responses (default: false)
 * @param {boolean} options.strict - Modo estricto (default: true)
 * @param {Object} options.logger - Logger instance (opcional)
 * @returns {Function} - Middleware function
 *
 * @example
 * const middleware = createValidationMiddleware(validationManager, {
 *   requireSchemas: false,
 *   validateResponses: false,
 *   logger: logger
 * });
 *
 * // En HTTP Gateway:
 * await middleware(request, context);
 */
function createValidationMiddleware(validationManager, options = {}) {
  const {
    requireSchemas = false,
    validateResponses = false,
    strict = true,
    logger = null
  } = options;

  /**
   * Middleware function - valida request antes de llegar al handler
   *
   * @param {Object} request - Request object
   * @param {Object} context - Request context con moduleAPI
   * @throws {ValidationError} - Si la validación falla
   */
  return async function validateRequest(request, context) {
    const { method, path, body, query, headers } = request;
    const moduleAPI = context.moduleAPI;

    // Si no hay API en el contexto, skip
    if (!moduleAPI) {
      return;
    }

    // Obtener schemas del módulo
    const schemas = moduleAPI.schemas;

    // Si se requieren schemas y no hay, rechazar
    if (requireSchemas && !schemas) {
      if (logger) {
        logger.warn('validation.no_schema_defined', {
          method,
          path,
          module: moduleAPI.moduleName,
          api: moduleAPI.name
        });
      }

      if (strict) {
        throw new ValidationError(
          `API ${method} ${path} does not have validation schema defined`,
          []
        );
      }
      return;
    }

    // Si no hay schemas, skip validación
    if (!schemas || !schemas.request) {
      return;
    }

    const requestSchemas = schemas.request;
    const errors = [];

    // ================================================================
    // Validar Request Body
    // ================================================================
    if (requestSchemas.body && (body !== undefined && body !== null)) {
      const result = validationManager.validateInline(requestSchemas.body, body);

      if (!result.valid) {
        errors.push({
          location: 'body',
          errors: result.errors
        });

        if (logger) {
          logger.warn('validation.body.failed', {
            method,
            path,
            error_count: result.errors.length,
            errors: result.errors
          });
        }
      }
    }

    // ================================================================
    // Validar Query Parameters
    // ================================================================
    if (requestSchemas.query && query && Object.keys(query).length > 0) {
      const result = validationManager.validateInline(requestSchemas.query, query);

      if (!result.valid) {
        errors.push({
          location: 'query',
          errors: result.errors
        });

        if (logger) {
          logger.warn('validation.query.failed', {
            method,
            path,
            error_count: result.errors.length,
            errors: result.errors
          });
        }
      }
    }

    // ================================================================
    // Validar Headers (opcional)
    // ================================================================
    if (requestSchemas.headers && headers) {
      const result = validationManager.validateInline(requestSchemas.headers, headers);

      if (!result.valid) {
        errors.push({
          location: 'headers',
          errors: result.errors
        });

        if (logger) {
          logger.warn('validation.headers.failed', {
            method,
            path,
            error_count: result.errors.length,
            errors: result.errors
          });
        }
      }
    }

    // ================================================================
    // Si hay errores, rechazar request
    // ================================================================
    if (errors.length > 0) {
      // Flatten todos los errores
      const allErrors = errors.flatMap(e => e.errors.map(err => ({
        location: e.location,
        ...err
      })));

      throw new ValidationError(
        'Request validation failed',
        allErrors
      );
    }
  };
}

/**
 * Crea middleware de validación para responses HTTP
 *
 * @param {ValidationManager} validationManager - Instance del ValidationManager
 * @param {Object} options - Opciones de configuración
 * @param {boolean} options.strict - Rechazar responses inválidas (default: false, solo warning)
 * @param {Object} options.logger - Logger instance (opcional)
 * @returns {Function} - Middleware function
 *
 * @example
 * const middleware = createResponseValidationMiddleware(validationManager, {
 *   strict: false,  // Solo warnings, no rechaza
 *   logger: logger
 * });
 *
 * // En HTTP Gateway (después del handler):
 * await middleware(response, context);
 */
function createResponseValidationMiddleware(validationManager, options = {}) {
  const {
    strict = false,
    logger = null
  } = options;

  /**
   * Middleware function - valida response después del handler
   *
   * @param {*} response - Response data del handler
   * @param {Object} context - Request context con moduleAPI
   * @throws {ValidationError} - Si strict=true y validación falla
   */
  return async function validateResponse(response, context) {
    const moduleAPI = context.moduleAPI;

    // Si no hay API en el contexto, skip
    if (!moduleAPI) {
      return;
    }

    // Obtener schema de response
    const schemas = moduleAPI.schemas;

    if (!schemas || !schemas.response) {
      return; // Skip si no hay schema
    }

    const responseSchema = schemas.response;

    // Validar response
    const result = validationManager.validateInline(responseSchema, response);

    if (!result.valid) {
      if (logger) {
        logger.warn('validation.response.failed', {
          method: context.method,
          path: context.path,
          module: moduleAPI.moduleName,
          api: moduleAPI.name,
          error_count: result.errors.length,
          errors: result.errors
        });
      }

      if (strict) {
        throw new ValidationError(
          'Response validation failed',
          result.errors
        );
      }
    }
  };
}

/**
 * Helper para extraer schema de un módulo API
 *
 * @param {Object} moduleAPI - Module API object
 * @returns {Object|null} - Schemas object o null
 */
function getAPISchemas(moduleAPI) {
  if (!moduleAPI) return null;
  return moduleAPI.schemas || null;
}

/**
 * Helper para validar que un schema es válido JSON Schema
 *
 * @param {Object} schema - Schema a validar
 * @returns {boolean} - true si es válido
 */
function isValidJSONSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return false;
  }

  // Debe tener al menos 'type' o '$ref'
  return ('type' in schema) || ('$ref' in schema);
}

/**
 * Helper para formatear errores de validación para HTTP response
 *
 * @param {ValidationError} error - ValidationError instance
 * @param {Object} options - Opciones de formato
 * @returns {Object} - Objeto formateado para response
 */
function formatValidationErrorResponse(error, options = {}) {
  const { includeDetails = true } = options;

  const response = {
    error: error.message,
    status: error.statusCode || 400
  };

  if (includeDetails && error.errors && error.errors.length > 0) {
    response.validation_errors = error.errors.map(err => ({
      location: err.location || 'unknown',
      path: err.path,
      message: err.message,
      keyword: err.keyword
    }));
  }

  return response;
}

module.exports = {
  createValidationMiddleware,
  createResponseValidationMiddleware,
  getAPISchemas,
  isValidJSONSchema,
  formatValidationErrorResponse
};
