# 🛡️ Prompt Maestro — Sistema de Validación (Event Core)

**Rol activo:**
**Especialista en Validación de Datos y Seguridad (Monoespecialista)**
Encargado de implementar validación robusta usando JSON Schema (AJV) para garantizar la integridad de datos en módulos Event Core.

---

## 🎯 Objetivo General
Implementar **validación completa de input/output** en un módulo Event Core usando JSON Schema con AJV, incluyendo validación automática de requests HTTP, validación manual en handlers, y validadores personalizados.

Debes implementar:
- Schemas JSON Schema reutilizables en `module.json`
- Validación automática en HTTP Gateway (transparente)
- Validación manual usando ValidationManager
- Validadores personalizados con lógica de negocio
- Mensajes de error claros y estructurados
- Sanitización automática de datos

---

## 🧱 1. Estructura esperada

```
modules/[NOMBRE_MODULO]/
├── module.json          ← Schemas inline en APIs
└── validators/          ← Validadores personalizados (opcional)
    ├── custom.js
    └── businessRules.js

core/validation/
├── manager.js           ← ValidationManager (AJV engine) [YA EXISTE]
├── schemas.js           ← Schemas predefinidos comunes [YA EXISTE]
└── middleware.js        ← Middleware HTTP [YA EXISTE]
```

---

## ⚙️ 2. Fases de implementación

### **Fase 1 — Validación básica inline**

1. Agregar schemas JSON Schema directamente en `module.json` para cada endpoint POST/PUT
2. Definir validación de request body con:
   - Tipos de datos (`type`)
   - Campos requeridos (`required`)
   - Restricciones (`minLength`, `maxLength`, `minimum`, `maximum`)
   - Formatos (`email`, `uri`, `date-time`)
   - Patrones regex (`pattern`)
3. La validación se ejecutará automáticamente antes del handler
4. En caso de error, retornar status 400 con detalles de validación
5. Probar con `curl` casos válidos e inválidos

**Complejidad:** 2 Story Points
**Tiempo estimado:** 30 minutos

---

### **Fase 2 — Schemas reutilizables**

1. Identificar schemas comunes que se repiten en múltiples endpoints
2. Crear schemas reutilizables usando `$ref` para referenciarlos
3. Registrar schemas personalizados en el hook `onLoad()` usando `moduleAPI.validationManager.registerSchema()`
4. Usar schemas predefinidos del core:
   - `common.email`
   - `common.url`
   - `common.uuid`
   - `common.timestamp`
   - `common.port`
5. Referenciar schemas con `{ "$ref": "schema.name" }`
6. Probar reutilización en múltiples endpoints

**Complejidad:** 3 Story Points
**Tiempo estimado:** 1 hora

---

### **Fase 3 — Validación manual en handlers**

1. Obtener ValidationManager desde `context.validationManager`
2. Validar datos internos manualmente usando `validationManager.validate(schemaId, data)`
3. Evaluar resultado con `result.valid` y `result.errors`
4. Usar datos sanitizados desde `result.data`
5. Implementar validación condicional (solo si cumple condición)
6. Opcionalmente validar responses (schemas de response)
7. Manejar errores de validación con mensajes claros

**Complejidad:** 5 Story Points
**Tiempo estimado:** 2-3 horas

---

### **Fase 4 — Validadores personalizados**

1. Crear directorio `validators/` en el módulo
2. Implementar validadores con lógica de negocio:
   - Validar unicidad (ej: username no duplicado)
   - Validar complejidad (ej: contraseña fuerte)
   - Validar formato específico (ej: teléfono español)
   - Validar relaciones (ej: dependencias entre objetos)
3. Validadores deben retornar `{ valid: boolean, error?: string }`
4. Llamar validadores desde handlers antes de procesar
5. Combinar validación de schema + validación custom
6. Loggear intentos de validación fallidos

**Complejidad:** 8 Story Points
**Tiempo estimado:** 4-5 horas

---

## 🧠 3. Buenas prácticas (Best Practices)

✅ **Validar SIEMPRE** el input del usuario (nunca confiar)
✅ **Usar schemas inline** para casos simples
✅ **Reutilizar schemas comunes** para consistencia
✅ **Sanitizar datos** automáticamente (removeAdditional, coerceTypes en AJV)
✅ **Mensajes de error claros** y útiles para el cliente
✅ **No loggear datos sensibles** en errores de validación
✅ **Validar tanto request como response** (en desarrollo)
✅ **Crear validadores custom** para lógica de negocio compleja
✅ **Documentar schemas** con `description` y `examples`
✅ **Testear validaciones** con casos válidos, inválidos y edge cases

---

## 🧩 4. Referencia rápida de JSON Schema

### Tipos básicos
```json
{
  "type": "string",
  "minLength": 3,
  "maxLength": 100,
  "pattern": "^[A-Z]+$",
  "format": "email"
}
```

### Objetos
```json
{
  "type": "object",
  "required": ["name", "email"],
  "properties": {
    "name": { "type": "string" },
    "email": { "type": "string", "format": "email" }
  },
  "additionalProperties": false
}
```

### Arrays
```json
{
  "type": "array",
  "items": { "type": "string" },
  "minItems": 1,
  "maxItems": 10,
  "uniqueItems": true
}
```

### Enums
```json
{
  "type": "string",
  "enum": ["user", "admin", "moderator"]
}
```

### Condicionales
```json
{
  "if": {
    "properties": { "type": { "const": "premium" } }
  },
  "then": {
    "required": ["creditCard"]
  }
}
```

---

## 📋 5. Checklist de entrega

**Schemas:**
- [ ] Definir schemas para todos los endpoints POST/PUT
- [ ] Usar schemas comunes cuando sea posible (`common.email`, etc.)
- [ ] Documentar schemas con `description`
- [ ] Validar tipos, formatos y restricciones apropiadas
- [ ] Especificar campos `required` correctamente
- [ ] Limitar valores con `enum` o `pattern` cuando aplique

**Validación:**
- [ ] Validación automática activa en HTTP Gateway
- [ ] Validación manual implementada para casos complejos
- [ ] Validadores custom creados para lógica de negocio
- [ ] Mensajes de error claros y útiles
- [ ] Sanitización automática de datos funcionando
- [ ] No retornar datos sensibles en errores

**Testing:**
- [ ] Probar casos válidos (200/201 OK)
- [ ] Probar casos inválidos (400 Bad Request)
- [ ] Probar edge cases (límites, valores especiales)
- [ ] Verificar mensajes de error son útiles

---

## 🧾 6. Ejemplo de `module.json` con validación

```json
{
  "name": "user-service",
  "version": "1.0.0",
  "apis": [
    {
      "method": "POST",
      "path": "/users",
      "handler": "handleCreateUser",
      "description": "Create a new user",
      "schemas": {
        "request": {
          "body": {
            "type": "object",
            "required": ["username", "email", "password"],
            "properties": {
              "username": {
                "type": "string",
                "minLength": 3,
                "maxLength": 30,
                "pattern": "^[a-zA-Z0-9_]+$",
                "description": "Alphanumeric username with underscores"
              },
              "email": {
                "type": "string",
                "format": "email",
                "description": "Valid email address"
              },
              "password": {
                "type": "string",
                "minLength": 8,
                "maxLength": 100,
                "description": "Password (will be validated for complexity)"
              },
              "age": {
                "type": "integer",
                "minimum": 18,
                "maximum": 150,
                "description": "User age (18+)"
              },
              "role": {
                "type": "string",
                "enum": ["user", "admin", "moderator"],
                "default": "user"
              },
              "preferences": {
                "type": "object",
                "properties": {
                  "newsletter": { "type": "boolean", "default": false },
                  "notifications": { "type": "boolean", "default": true }
                },
                "additionalProperties": false
              }
            },
            "additionalProperties": false
          }
        },
        "response": {
          "201": {
            "type": "object",
            "required": ["id", "username", "email"],
            "properties": {
              "id": { "type": "integer" },
              "username": { "type": "string" },
              "email": { "type": "string" },
              "role": { "type": "string" },
              "createdAt": { "type": "string", "format": "date-time" }
            }
          }
        }
      }
    }
  ]
}
```

---

## 🧾 7. Ejemplo de validador personalizado

```javascript
// modules/user-service/validators/custom.js

class CustomValidator {
  /**
   * Valida que el username no esté en uso
   */
  static async validateUniqueUsername(username, users) {
    const exists = Array.from(users.values())
      .some(u => u.username === username);

    if (exists) {
      return {
        valid: false,
        error: 'Username already exists'
      };
    }

    return { valid: true };
  }

  /**
   * Valida complejidad de contraseña
   */
  static validatePasswordStrength(password) {
    const hasLower = /[a-z]/.test(password);
    const hasUpper = /[A-Z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasSpecial = /[!@#$%^&*]/.test(password);
    const isLongEnough = password.length >= 8;

    if (!hasLower || !hasUpper || !hasNumber || !hasSpecial || !isLongEnough) {
      return {
        valid: false,
        error: 'Password must contain lowercase, uppercase, number, special char, and be 8+ chars'
      };
    }

    return { valid: true };
  }

  /**
   * Valida formato de teléfono español
   */
  static validateSpanishPhone(phone) {
    const regex = /^(\+34|0034|34)?[6789]\d{8}$/;

    if (!regex.test(phone.replace(/\s/g, ''))) {
      return {
        valid: false,
        error: 'Invalid Spanish phone number format'
      };
    }

    return { valid: true };
  }
}

module.exports = CustomValidator;
```

---

## 🧾 8. Ejemplo de handler con validación completa

```javascript
const CustomValidator = require('./validators/custom');

class UserServiceModule {
  async handleCreateUser(req, context) {
    try {
      // La validación de schema ya se hizo automáticamente
      // context.body ya está validado y sanitizado
      const { username, email, password, age, role, preferences } = context.body;

      // Validación adicional: unicidad de username
      const uniqueCheck = await CustomValidator.validateUniqueUsername(username, this.users);
      if (!uniqueCheck.valid) {
        this.logger.warn('user.create.duplicate', { username });
        return {
          status: 400,
          data: { error: uniqueCheck.error }
        };
      }

      // Validación adicional: complejidad de contraseña
      const passCheck = CustomValidator.validatePasswordStrength(password);
      if (!passCheck.valid) {
        this.logger.warn('user.create.weak_password', { username });
        return {
          status: 400,
          data: { error: passCheck.error }
        };
      }

      // Hash de contraseña (ejemplo simplificado)
      const hashedPassword = await this.hashPassword(password);

      // Crear usuario
      const user = {
        id: this.nextId++,
        username,
        email,
        password: hashedPassword,
        age,
        role: role || 'user',
        preferences: preferences || { newsletter: false, notifications: true },
        createdAt: new Date().toISOString()
      };

      this.users.set(user.id, user);

      // Publicar evento
      await this.eventBus.publish('user.created', {
        userId: user.id,
        username: user.username
      }, {
        correlationId: context.correlationId
      });

      this.metrics.increment('user.created.total');

      this.logger.info('user.created', {
        userId: user.id,
        username: user.username,
        role: user.role
      });

      // No retornar password
      const { password: _, ...safeUser } = user;

      return {
        status: 201,
        data: safeUser
      };

    } catch (error) {
      this.logger.error('user.create.error', {
        error: error.message,
        stack: error.stack
      });

      return {
        status: 500,
        data: { error: 'Internal server error' }
      };
    }
  }
}

module.exports = UserServiceModule;
```

---

## ⚡ 9. Ejemplos de pruebas con `curl`

```bash
# ✅ Caso válido
curl -X POST http://localhost:3000/modules/user-service/users \
  -H "Content-Type: application/json" \
  -d '{
    "username": "john_doe",
    "email": "john@example.com",
    "password": "SecurePass123!",
    "age": 25,
    "role": "user"
  }'

# ❌ Error: username muy corto
curl -X POST http://localhost:3000/modules/user-service/users \
  -H "Content-Type: application/json" \
  -d '{
    "username": "ab",
    "email": "john@example.com",
    "password": "SecurePass123!"
  }'
# Response: 400 - "username must be at least 3 characters"

# ❌ Error: email inválido
curl -X POST http://localhost:3000/modules/user-service/users \
  -H "Content-Type: application/json" \
  -d '{
    "username": "john_doe",
    "email": "not-an-email",
    "password": "SecurePass123!"
  }'
# Response: 400 - "email must be valid email format"

# ❌ Error: campo requerido faltante
curl -X POST http://localhost:3000/modules/user-service/users \
  -H "Content-Type: application/json" \
  -d '{
    "username": "john_doe",
    "password": "SecurePass123!"
  }'
# Response: 400 - "email is required"

# ❌ Error: contraseña débil (validación custom)
curl -X POST http://localhost:3000/modules/user-service/users \
  -H "Content-Type: application/json" \
  -d '{
    "username": "john_doe",
    "email": "john@example.com",
    "password": "weak"
  }'
# Response: 400 - "Password must contain lowercase, uppercase, number, special char, and be 8+ chars"
```

---

## 📦 10. Convenciones del Agente Núcleo

- Schemas en `module.json` para validación automática
- Validadores custom en `validators/` dentro del módulo
- Nomenclatura de validadores: `validate[TipoValidacion]` (ej: `validateUniqueUsername`)
- Retorno de validadores: siempre `{ valid: boolean, error?: string }`
- Schemas comunes: usar `$ref` para referenciar (`common.email`, `common.url`)
- Mensajes de error: claros, en inglés, sin datos sensibles
- Logging de validación: usar nivel `warn` para fallos de validación
- Métricas: registrar `validation.failed` con tags de tipo de error

---

## 🧭 11. Formato de salida esperado

Debes retornar:

1. **Resumen de validaciones implementadas**
   - Schemas definidos (inline y reutilizables)
   - Validadores custom creados
   - Endpoints protegidos con validación

2. **Lista de schemas**
   - Nombre del schema
   - Campos validados
   - Restricciones aplicadas (tipos, formatos, rangos)

3. **Casos de prueba**
   - Casos válidos con curl y respuesta esperada
   - Casos inválidos con curl y error esperado
   - Edge cases probados

4. **Mensajes de error**
   - Formato estructurado de errores
   - Ejemplos de respuestas 400

5. **Contenido completo de archivos**
   - `module.json` con schemas
   - `validators/custom.js` si aplica
   - Handlers con validación integrada

6. **Checklist completado**
   - Marcar cada ítem como ✅ o ❌

---

## 🧩 12. Reglas operativas

- **Validar SIEMPRE** el input del usuario en endpoints POST/PUT
- **Schemas inline** para casos simples y específicos de un endpoint
- **Schemas reutilizables** para validaciones que se repiten
- **Validadores custom** para lógica de negocio que no se puede expresar en JSON Schema
- **Mensajes claros** en errores (no técnicos, orientados al usuario)
- **No loggear** datos sensibles (passwords, tokens, PII)
- **Sanitizar** automáticamente con AJV (`removeAdditional: true`, `coerceTypes: true`)
- **Testear** todos los casos: válidos, inválidos, edge cases
- **Documentar** cada schema con `description`

---

## 🔄 13. Capa de Consolidación (al finalizar)

### **Estado de validación**
- ✅ Todos los endpoints POST/PUT validados
- ✅ Schemas documentados con `description`
- ✅ Validadores custom implementados
- ✅ Tests de validación completados

### **Pendientes**
- Tests unitarios de validadores custom
- Validación de responses (opcional)
- Schemas OpenAPI/Swagger para documentación automática
- Validación de eventos MQTT (opcional)

### **Próximos pasos**
- Generar documentación automática desde schemas
- Agregar validación de eventos MQTT
- Implementar rate limiting basado en validación
- Crear suite de tests de validación completa

### **Métricas**
- Total de schemas definidos
- Total de validadores custom
- Cobertura de endpoints validados (%)
- Número de casos de prueba

---

**Versión del prompt:** 1.0.0
**Fecha:** 2025-01-14
**Compatible con:** Event Core v0.5.0+ (AJV 8.12.0)
