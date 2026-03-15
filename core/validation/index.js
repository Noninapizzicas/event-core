/**
 * Validation Module
 *
 * Sistema centralizado de validación usando JSON Schema (AJV)
 *
 * Exports:
 * - ValidationManager: Gestor de validación con caché de schemas
 * - ValidationError: Error personalizado para fallos de validación
 * - Middleware: Funciones middleware para HTTP Gateway
 * - Common Schemas: Schemas reutilizables
 * - Schema Builders: Helpers para construir schemas
 */

const { ValidationManager, ValidationError } = require('./manager');
const {
  createValidationMiddleware,
  createResponseValidationMiddleware,
  getAPISchemas,
  isValidJSONSchema,
  formatValidationErrorResponse
} = require('./middleware');
const {
  commonSchemas,
  commonPatterns,
  commonTypes,
  validators,
  schemaBuilders
} = require('./schemas');

module.exports = {
  // Core classes
  ValidationManager,
  ValidationError,

  // Middleware
  createValidationMiddleware,
  createResponseValidationMiddleware,

  // Helpers
  getAPISchemas,
  isValidJSONSchema,
  formatValidationErrorResponse,

  // Schemas y patterns
  commonSchemas,
  commonPatterns,
  commonTypes,
  validators,
  schemaBuilders
};
