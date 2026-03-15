/**
 * Schema Store - Schemas comunes reutilizables y helpers
 *
 * Contiene:
 * - Schemas predefinidos para estructuras comunes (eventos, requests, etc.)
 * - Helpers de validación
 * - Patrones reutilizables
 */

/**
 * Schemas comunes del sistema
 */
const commonSchemas = {
  // ============================================================
  // Event Envelope Schema
  // ============================================================
  'event.envelope': {
    $id: 'event.envelope',
    type: 'object',
    required: ['event_id', 'event_type', 'timestamp', 'source', 'data'],
    properties: {
      event_id: {
        type: 'string',
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        description: 'UUID v4 del evento'
      },
      event_type: {
        type: 'string',
        pattern: '^[a-z0-9._-]+$',
        minLength: 3,
        maxLength: 100,
        description: 'Tipo de evento (ej: user.created, file.updated)'
      },
      timestamp: {
        type: 'string',
        format: 'date-time',
        description: 'Timestamp ISO 8601'
      },
      source: {
        type: 'object',
        required: ['core_id'],
        properties: {
          core_id: {
            type: 'string',
            minLength: 1,
            description: 'ID del core que emitió el evento'
          },
          module_id: {
            type: 'string',
            description: 'ID del módulo que emitió el evento (opcional)'
          }
        },
        additionalProperties: false
      },
      data: {
        type: 'object',
        description: 'Payload del evento'
      },
      trace: {
        type: 'object',
        properties: {
          trace_id: { type: 'string' },
          span_id: { type: 'string' },
          parent_span_id: { type: 'string' }
        },
        description: 'Contexto de tracing (W3C)'
      },
      metadata: {
        type: 'object',
        description: 'Metadata adicional'
      }
    },
    additionalProperties: false
  },

  // ============================================================
  // HTTP Request Schema
  // ============================================================
  'http.request': {
    $id: 'http.request',
    type: 'object',
    required: ['method', 'path'],
    properties: {
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
        description: 'Método HTTP'
      },
      path: {
        type: 'string',
        pattern: '^/',
        description: 'Path de la request'
      },
      query: {
        type: 'object',
        description: 'Query parameters'
      },
      body: {
        description: 'Request body (puede ser cualquier tipo)'
      },
      headers: {
        type: 'object',
        description: 'HTTP headers'
      },
      request_id: {
        type: 'string',
        description: 'ID único de la request'
      }
    },
    additionalProperties: true
  },

  // ============================================================
  // HTTP Response Schema
  // ============================================================
  'http.response': {
    $id: 'http.response',
    type: 'object',
    required: ['status'],
    properties: {
      status: {
        type: 'integer',
        minimum: 100,
        maximum: 599,
        description: 'HTTP status code'
      },
      body: {
        description: 'Response body'
      },
      headers: {
        type: 'object',
        description: 'Response headers'
      }
    },
    additionalProperties: false
  },

  // ============================================================
  // Module Manifest Schema
  // ============================================================
  'module.manifest': {
    $id: 'module.manifest',
    type: 'object',
    required: ['name', 'version', 'description'],
    properties: {
      name: {
        type: 'string',
        pattern: '^[a-z0-9-]+$',
        minLength: 2,
        maxLength: 50,
        description: 'Nombre del módulo (lowercase, guiones)'
      },
      version: {
        type: 'string',
        pattern: '^\\d+\\.\\d+\\.\\d+$',
        description: 'Versión semántica (ej: 1.0.0)'
      },
      description: {
        type: 'string',
        minLength: 10,
        maxLength: 500,
        description: 'Descripción del módulo'
      },
      author: {
        type: 'string',
        description: 'Autor del módulo'
      },
      provides: {
        type: 'object',
        properties: {
          apis: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'method', 'path'],
              properties: {
                name: { type: 'string' },
                method: {
                  type: 'string',
                  enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']
                },
                path: { type: 'string', pattern: '^/' },
                description: { type: 'string' },
                schemas: {
                  type: 'object',
                  properties: {
                    request: {
                      type: 'object',
                      properties: {
                        body: { type: 'object' },
                        query: { type: 'object' },
                        headers: { type: 'object' }
                      }
                    },
                    response: { type: 'object' }
                  }
                }
              }
            }
          },
          hooks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Hooks que el módulo implementa'
          }
        }
      },
      subscribes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Topics MQTT a los que se suscribe'
      },
      requires: {
        type: 'object',
        properties: {
          core: {
            type: 'string',
            pattern: '^>=?\\d+\\.\\d+\\.\\d+$',
            description: 'Versión mínima del core requerida'
          }
        }
      },
      config: {
        type: 'object',
        description: 'Configuración del módulo'
      }
    },
    additionalProperties: false
  },

  // ============================================================
  // API Schema Definition (para definir schemas en manifests)
  // ============================================================
  'api.schema': {
    $id: 'api.schema',
    type: 'object',
    properties: {
      request: {
        type: 'object',
        properties: {
          body: { type: 'object', description: 'JSON Schema para request body' },
          query: { type: 'object', description: 'JSON Schema para query params' },
          headers: { type: 'object', description: 'JSON Schema para headers' }
        }
      },
      response: {
        type: 'object',
        description: 'JSON Schema para response'
      }
    }
  }
};

/**
 * Patrones comunes reutilizables
 */
const commonPatterns = {
  // Identificadores
  uuid: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  coreId: '^[a-z0-9-]+$',
  moduleId: '^[a-z0-9-]+$',
  eventType: '^[a-z0-9._-]+$',

  // URLs y paths
  httpPath: '^/',
  mqttTopic: '^[a-z0-9/+#-]+$',

  // Versiones
  semver: '^\\d+\\.\\d+\\.\\d+$',
  semverRange: '^>=?\\d+\\.\\d+\\.\\d+$',

  // Dates
  iso8601: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}',

  // Common
  email: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$',
  slug: '^[a-z0-9-]+$'
};

/**
 * Tipos comunes reutilizables (para usar con $ref)
 */
const commonTypes = {
  uuid: {
    type: 'string',
    pattern: commonPatterns.uuid,
    description: 'UUID v4'
  },

  timestamp: {
    type: 'string',
    format: 'date-time',
    description: 'ISO 8601 timestamp'
  },

  coreId: {
    type: 'string',
    pattern: commonPatterns.coreId,
    minLength: 2,
    maxLength: 50,
    description: 'Core identifier'
  },

  moduleId: {
    type: 'string',
    pattern: commonPatterns.moduleId,
    minLength: 2,
    maxLength: 50,
    description: 'Module identifier'
  },

  eventType: {
    type: 'string',
    pattern: commonPatterns.eventType,
    minLength: 3,
    maxLength: 100,
    description: 'Event type (dot notation)'
  },

  httpMethod: {
    type: 'string',
    enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']
  },

  semver: {
    type: 'string',
    pattern: commonPatterns.semver,
    description: 'Semantic version (e.g., 1.2.3)'
  }
};

/**
 * Helpers de validación
 */
const validators = {
  /**
   * Verifica si un string es un UUID válido
   */
  isUUID(str) {
    if (typeof str !== 'string') return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
  },

  /**
   * Verifica si un string es un event type válido
   */
  isEventType(str) {
    if (typeof str !== 'string') return false;
    return /^[a-z0-9._-]+$/.test(str) && str.length >= 3 && str.length <= 100;
  },

  /**
   * Verifica si un string es un HTTP method válido
   */
  isHTTPMethod(str) {
    if (typeof str !== 'string') return false;
    return ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'].includes(str.toUpperCase());
  },

  /**
   * Verifica si un string es un semver válido
   */
  isSemver(str) {
    if (typeof str !== 'string') return false;
    return /^\d+\.\d+\.\d+$/.test(str);
  },

  /**
   * Verifica si un timestamp es ISO 8601 válido
   */
  isISO8601(str) {
    if (typeof str !== 'string') return false;
    const date = new Date(str);
    return date.toISOString() === str;
  },

  /**
   * Verifica si un objeto tiene las propiedades requeridas
   */
  hasRequiredProperties(obj, requiredProps) {
    if (typeof obj !== 'object' || obj === null) return false;
    return requiredProps.every(prop => prop in obj);
  }
};

/**
 * Schema builders - Funciones helper para crear schemas comunes
 */
const schemaBuilders = {
  /**
   * Crea un schema para un objeto con propiedades requeridas
   */
  object(required, properties, options = {}) {
    return {
      type: 'object',
      required,
      properties,
      additionalProperties: options.additionalProperties !== undefined
        ? options.additionalProperties
        : false,
      ...options
    };
  },

  /**
   * Crea un schema para un array
   */
  array(itemSchema, options = {}) {
    return {
      type: 'array',
      items: itemSchema,
      minItems: options.minItems,
      maxItems: options.maxItems,
      uniqueItems: options.uniqueItems,
      ...options
    };
  },

  /**
   * Crea un schema para un string con restricciones
   */
  string(options = {}) {
    return {
      type: 'string',
      minLength: options.minLength,
      maxLength: options.maxLength,
      pattern: options.pattern,
      format: options.format,
      enum: options.enum,
      ...options
    };
  },

  /**
   * Crea un schema para un número con restricciones
   */
  number(options = {}) {
    return {
      type: options.integer ? 'integer' : 'number',
      minimum: options.minimum,
      maximum: options.maximum,
      exclusiveMinimum: options.exclusiveMinimum,
      exclusiveMaximum: options.exclusiveMaximum,
      ...options
    };
  },

  /**
   * Crea un schema para una API request
   */
  apiRequest(bodySchema, querySchema, options = {}) {
    const schema = {
      type: 'object',
      properties: {}
    };

    if (bodySchema) {
      schema.properties.body = bodySchema;
    }

    if (querySchema) {
      schema.properties.query = querySchema;
    }

    if (options.headers) {
      schema.properties.headers = options.headers;
    }

    return schema;
  },

  /**
   * Crea un schema para una API response
   */
  apiResponse(dataSchema, options = {}) {
    return {
      type: 'object',
      required: options.required || ['success'],
      properties: {
        success: { type: 'boolean' },
        data: dataSchema,
        error: { type: 'string' },
        ...options.properties
      },
      additionalProperties: false
    };
  }
};

module.exports = {
  commonSchemas,
  commonPatterns,
  commonTypes,
  validators,
  schemaBuilders
};
