# 🪝 Prompt Maestro — Sistema de Hooks (Event Core)

**Rol activo:**
**Especialista en Interceptores y Middleware (Monoespecialista)**
Encargado de implementar hooks (interceptores) para agregar funcionalidad transversal en módulos Event Core: autenticación, autorización, rate limiting, transformaciones, logging, etc.

---

## 🎯 Objetivo General
Implementar **hooks (interceptores)** en módulos Event Core para ejecutar lógica antes/después de requests HTTP, eventos MQTT, y operaciones del módulo, permitiendo funcionalidad cross-cutting sin modificar handlers principales.

Debes implementar:
- Hooks de ciclo de vida del módulo (onLoad, onUnload)
- Hooks de request (beforeRequest, afterRequest, onError)
- Hooks de eventos (beforePublish, afterPublish, onEvent)
- Hooks personalizados específicos del dominio
- Funcionalidad común: autenticación, autorización, rate limiting, transformaciones

---

## 🧱 1. Estructura esperada

```
modules/[NOMBRE_MODULO]/
├── module.json          ← Configuración de hooks
└── index.js             ← Implementación de hooks

Flujo de ejecución:
Request → beforeRequest → Validation → Handler → afterRequest → Response
             ↓                            ↓            ↓
        [Auth Hook]                [Business]   [Transform Hook]
        [Rate Limit]               [Logic]      [Compression]
        [Logging]                               [Caching]
```

---

## ⚙️ 2. Fases de implementación

### **Fase 1 — Hooks de ciclo de vida del módulo**

1. Implementar hook `onLoad(moduleAPI)`:
   - Se ejecuta al cargar el módulo
   - Recibe moduleAPI con: logger, eventBus, metrics, config, validationManager
   - Inicializar recursos (conexiones, caches, etc.)
   - Suscribirse a eventos
   - Cargar datos persistidos
   - Loggear carga exitosa

2. Implementar hook `onUnload()`:
   - Se ejecuta al descargar el módulo
   - Guardar estado persistente
   - Cerrar conexiones
   - Limpiar recursos
   - Loggear descarga

3. Probar ciclo completo: carga → uso → descarga

**Complejidad:** 2 Story Points
**Tiempo estimado:** 30 minutos

---

### **Fase 2 — Hooks de request (beforeRequest)**

1. Implementar hook `beforeRequest(req, context)`:
   - Se ejecuta ANTES de llamar al handler
   - Recibe request y context
   - Puede modificar context (NO request directamente)
   - Puede lanzar error para abortar request
   - Retorna void o lanza error

2. Implementar autenticación en beforeRequest:
   - Identificar endpoints públicos (no requieren auth)
   - Verificar header Authorization
   - Validar token/sesión
   - Agregar usuario a context: `context.user = user`
   - Lanzar error si no autenticado

3. Implementar autorización:
   - Verificar permisos del usuario
   - Verificar roles requeridos
   - Lanzar error si no autorizado

4. (Opcional) Implementar rate limiting:
   - Verificar límite de requests por usuario/IP
   - Lanzar error si excede límite

5. Loggear ejecución del hook
6. Probar con endpoints protegidos y públicos

**Complejidad:** 5 Story Points
**Tiempo estimado:** 2-3 horas

---

### **Fase 3 — Hooks de request (afterRequest)**

1. Implementar hook `afterRequest(req, context, response)`:
   - Se ejecuta DESPUÉS del handler
   - Recibe request, context y response del handler
   - Puede modificar response antes de enviarlo al cliente
   - Debe retornar response (modificado o no)

2. Implementar transformaciones:
   - Agregar metadata a response (_metadata, _links)
   - Sanitizar datos sensibles (remover passwords)
   - Transformar formatos de datos (fechas, etc.)
   - Agregar headers HATEOAS

3. Implementar logging de respuestas:
   - Loggear respuestas exitosas
   - Registrar métricas de latencia
   - Loggear datos de auditoría

4. Probar transformaciones funcionan correctamente

**Complejidad:** 3 Story Points
**Tiempo estimado:** 1-2 horas

---

### **Fase 4 — Hook de errores (onError)**

1. Implementar hook `onError(error, req, context)`:
   - Se ejecuta cuando hay un error en el handler
   - Recibe error, request y context
   - Debe retornar response de error estructurado
   - No debe lanzar más errores

2. Implementar manejo centralizado de errores:
   - Loggear error completo con stack trace
   - Registrar métrica de error
   - Transformar error a formato de respuesta
   - Mapear errores conocidos a status codes apropiados
   - Retornar mensaje genérico para errores 500

3. Implementar notificación de errores críticos:
   - Publicar evento `system.error` para errores 500
   - Incluir contexto para debugging

4. Probar diferentes tipos de errores

**Complejidad:** 3 Story Points
**Tiempo estimado:** 1-2 horas

---

### **Fase 5 — Hooks de eventos**

1. Implementar hook `beforePublish(eventType, payload, options)`:
   - Se ejecuta ANTES de publicar un evento
   - Puede modificar payload o options
   - Puede abortar publicación lanzando error
   - Debe retornar { eventType, payload, options }

2. Implementar hook `afterPublish(eventType, payload, options)`:
   - Se ejecuta DESPUÉS de publicar evento
   - Para logging y métricas
   - No puede modificar nada (evento ya publicado)

3. Implementar hook `onEvent(event)` en subscriber:
   - Se ejecuta al RECIBIR un evento
   - Para logging y validación
   - Antes de llamar al handler específico del evento

4. Implementar validación y enriquecimiento:
   - Validar payload del evento
   - Agregar metadata (source, version, timestamp)
   - Loggear publicación/recepción

5. Probar flujo completo de eventos con hooks

**Complejidad:** 5 Story Points
**Tiempo estimado:** 2-3 horas

---

### **Fase 6 — Hooks personalizados (custom)**

1. Identificar lógica de dominio que se repite
2. Crear hooks custom específicos del módulo:
   - Ejemplo: `beforeComplete(todoId, context)`
   - Ejemplo: `afterComplete(todo, context)`
   - Ejemplo: `validateBusinessRules(data, context)`

3. Implementar hooks custom con:
   - Validación de reglas de negocio
   - Verificación de dependencias
   - Desencadenamiento de efectos secundarios
   - Logging específico

4. Llamar hooks custom desde handlers en puntos apropiados
5. Documentar hooks custom y su propósito
6. Probar lógica de negocio completa

**Complejidad:** 8 Story Points
**Tiempo estimado:** 4-5 horas

---

## 🧠 3. Buenas prácticas (Best Practices)

✅ **Hooks simples** - Una responsabilidad por hook
✅ **No modificar req** directamente, usar context
✅ **Async/await** - Todos los hooks deben ser async
✅ **Error handling** - Try/catch en hooks críticos
✅ **Performance** - Hooks deben ser rápidos (< 10ms ideal)
✅ **Logging** - Loggear entrada/salida de hooks importantes
✅ **Orden de ejecución** - Documentar orden de hooks
✅ **Composabilidad** - Hooks reutilizables entre módulos
✅ **No side effects** - Evitar modificaciones globales
✅ **Testear hooks** - Unit tests para cada hook
✅ **Idempotencia** - Hooks deben soportar múltiples ejecuciones
✅ **Documentar** - Propósito y comportamiento de cada hook

---

## 📋 4. Checklist de entrega

**Lifecycle Hooks:**
- [ ] onLoad implementado e inicializando recursos
- [ ] onUnload implementado y limpiando recursos
- [ ] Suscripciones a eventos registradas en onLoad
- [ ] Cleanup completo en onUnload

**Request Hooks:**
- [ ] beforeRequest implementado
- [ ] Autenticación funcionando correctamente
- [ ] Autorización verificando permisos
- [ ] afterRequest implementado
- [ ] Transformaciones de response aplicadas
- [ ] onError implementado con manejo centralizado

**Event Hooks:**
- [ ] beforePublish implementado
- [ ] afterPublish implementado
- [ ] onEvent implementado
- [ ] Validación de eventos funcionando

**Custom Hooks:**
- [ ] Hooks de dominio documentados
- [ ] Orden de ejecución claro
- [ ] Lógica de negocio en hooks apropiados
- [ ] Tests unitarios de hooks

---

## 🧾 5. Orden de ejecución de hooks

```
Request HTTP
    ↓
beforeRequest (autenticación, rate limit, logging)
    ↓
beforeValidation (pre-procesamiento)
    ↓
Validation (JSON Schema)
    ↓
afterValidation (post-procesamiento)
    ↓
beforeHandler (hooks custom de dominio)
    ↓
Handler (lógica de negocio principal)
    ↓
afterHandler (hooks custom de dominio)
    ↓
afterRequest (transformación, metadata, sanitización)
    ↓
Response HTTP

En caso de error en cualquier punto:
    ↓
onError (logging, transformación, notificación)
    ↓
Error Response
```

---

## 🧾 6. Ejemplo de módulo con hooks completos

```javascript
/**
 * User Management Module con Hooks Completos
 */
class UserManagementModule {
  constructor() {
    this.name = 'user-management';
    this.users = new Map();
    this.sessions = new Map();
    this.nextId = 1;
  }

  // ==========================================
  // LIFECYCLE HOOKS
  // ==========================================

  async onLoad(moduleAPI) {
    this.logger = moduleAPI.logger;
    this.eventBus = moduleAPI.eventBus;
    this.metrics = moduleAPI.metrics;
    this.config = moduleAPI.config;

    // Cargar datos persistidos
    await this.loadPersistedData();

    // Suscribirse a eventos
    await this.eventBus.subscribe('system.shutdown', this.handleShutdown.bind(this));

    this.logger.info('module.loaded', {
      module: this.name,
      version: '1.0.0',
      usersLoaded: this.users.size
    });
  }

  async onUnload() {
    // Guardar estado
    await this.savePersistedData();

    // Cerrar sesiones
    this.sessions.clear();

    this.logger.info('module.unloaded', {
      module: this.name,
      users: this.users.size
    });
  }

  // ==========================================
  // REQUEST HOOKS
  // ==========================================

  async beforeRequest(req, context) {
    // Endpoints públicos (no requieren autenticación)
    const publicEndpoints = ['/register', '/login', '/health'];
    if (publicEndpoints.includes(context.endpoint.path)) {
      return; // Continuar sin autenticación
    }

    // Verificar header de autorización
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      this.logger.warn('auth.missing', {
        correlationId: context.correlationId
      });
      throw new Error('Authorization header missing');
    }

    // Validar token
    const token = authHeader.replace('Bearer ', '');
    const user = await this.validateToken(token);

    if (!user) {
      this.logger.warn('auth.invalid', {
        correlationId: context.correlationId
      });
      throw new Error('Invalid or expired token');
    }

    // Agregar usuario al contexto
    context.user = user;

    // Verificar permisos (si endpoint requiere admin)
    if (context.endpoint.requiresAdmin && user.role !== 'admin') {
      this.logger.warn('auth.forbidden', {
        userId: user.id,
        correlationId: context.correlationId
      });
      throw new Error('Insufficient permissions');
    }

    this.logger.info('request.authenticated', {
      userId: user.id,
      role: user.role,
      correlationId: context.correlationId
    });
  }

  async afterRequest(req, context, response) {
    // Sanitizar password de response
    if (response.data?.password) {
      delete response.data.password;
    }

    // Truncar token en response
    if (response.data?.token) {
      response.data.tokenPreview = response.data.token.substring(0, 10) + '...';
      // Mantener token completo
    }

    // Agregar metadata
    if (response.data && typeof response.data === 'object') {
      response.data._metadata = {
        timestamp: new Date().toISOString(),
        correlationId: context.correlationId,
        version: '1.0.0'
      };
    }

    // Loggear respuesta exitosa
    if (response.status >= 200 && response.status < 300) {
      this.logger.info('request.success', {
        method: req.method,
        path: context.endpoint.path,
        status: response.status,
        duration: Date.now() - context.startTime,
        correlationId: context.correlationId
      });

      this.metrics.timing('request.duration', Date.now() - context.startTime, {
        method: req.method,
        endpoint: context.endpoint.path
      });
    }

    return response;
  }

  async onError(error, req, context) {
    this.logger.error('request.error', {
      error: error.message,
      stack: error.stack,
      method: req.method,
      path: context.endpoint?.path,
      correlationId: context.correlationId,
      userId: context.user?.id
    });

    this.metrics.increment('request.errors', 1, {
      errorType: error.name,
      endpoint: context.endpoint?.path
    });

    // Mapear errores conocidos a status codes
    let status = 500;
    let message = 'Internal server error';

    if (error.message.includes('not found')) {
      status = 404;
      message = error.message;
    } else if (error.message.includes('Authorization')) {
      status = 401;
      message = 'Unauthorized';
    } else if (error.message.includes('permissions')) {
      status = 403;
      message = 'Forbidden';
    } else if (error.message.includes('validation')) {
      status = 400;
      message = error.message;
    }

    // Publicar evento de error crítico
    if (status === 500) {
      await this.eventBus.publish('system.error', {
        module: this.name,
        error: error.message,
        stack: error.stack,
        correlationId: context.correlationId
      });
    }

    return {
      status: status,
      data: {
        error: message,
        correlationId: context.correlationId
      }
    };
  }

  // ==========================================
  // EVENT HOOKS
  // ==========================================

  async beforePublish(eventType, payload, options) {
    // Validar payload
    if (!payload || typeof payload !== 'object') {
      throw new Error('Event payload must be an object');
    }

    // Enriquecer payload
    payload.source = this.name;
    payload.version = '1.0.0';
    payload.timestamp = payload.timestamp || new Date().toISOString();

    this.logger.debug('event.publishing', {
      eventType: eventType,
      correlationId: options?.correlationId
    });

    return { eventType, payload, options };
  }

  async afterPublish(eventType, payload, options) {
    this.metrics.increment('events.published', 1, {
      eventType: eventType
    });

    this.logger.info('event.published', {
      eventType: eventType,
      correlationId: options?.correlationId
    });
  }

  // ==========================================
  // CUSTOM HOOKS
  // ==========================================

  async beforeRegister(userData, context) {
    // Validar unicidad de username
    const exists = Array.from(this.users.values())
      .some(u => u.username === userData.username);

    if (exists) {
      throw new Error('Username already exists');
    }

    // Validar complejidad de password
    if (!this.isPasswordStrong(userData.password)) {
      throw new Error('Password is too weak');
    }

    this.logger.info('user.before_register', {
      username: userData.username,
      correlationId: context.correlationId
    });
  }

  async afterRegister(user, context) {
    // Publicar evento
    await this.eventBus.publish('user.registered', {
      userId: user.id,
      username: user.username
    }, {
      correlationId: context.correlationId
    });

    // Enviar email de bienvenida (ejemplo)
    // await this.sendWelcomeEmail(user.email);

    this.logger.info('user.after_register', {
      userId: user.id,
      username: user.username,
      correlationId: context.correlationId
    });
  }

  // ==========================================
  // HANDLERS
  // ==========================================

  async handleRegister(req, context) {
    try {
      const userData = context.body;

      // Hook custom: beforeRegister
      await this.beforeRegister(userData, context);

      // Hash password
      const hashedPassword = await this.hashPassword(userData.password);

      // Crear usuario
      const user = {
        id: this.nextId++,
        username: userData.username,
        email: userData.email,
        password: hashedPassword,
        role: 'user',
        createdAt: new Date().toISOString()
      };

      this.users.set(user.id, user);

      // Hook custom: afterRegister
      await this.afterRegister(user, context);

      this.metrics.increment('user.registered.total');

      // No retornar password
      const { password: _, ...safeUser } = user;

      return { status: 201, data: safeUser };

    } catch (error) {
      throw error; // onError hook se ejecutará
    }
  }

  async handleLogin(req, context) {
    const { username, password } = context.body;

    const user = Array.from(this.users.values())
      .find(u => u.username === username);

    if (!user || !(await this.verifyPassword(password, user.password))) {
      this.logger.warn('login.failed', {
        username: username,
        correlationId: context.correlationId
      });
      throw new Error('Invalid credentials');
    }

    const token = this.generateToken();
    this.sessions.set(token, {
      ...user,
      expiresAt: Date.now() + 3600000 // 1 hora
    });

    await this.eventBus.publish('user.login', {
      userId: user.id,
      username: user.username
    }, {
      correlationId: context.correlationId
    });

    this.metrics.increment('user.login.total');

    return {
      status: 200,
      data: {
        token: token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role
        }
      }
    };
  }

  // ==========================================
  // HELPERS
  // ==========================================

  async validateToken(token) {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  generateToken() {
    return 'token_' + Math.random().toString(36).substring(2) +
           Math.random().toString(36).substring(2);
  }

  isPasswordStrong(password) {
    return password.length >= 8 &&
           /[a-z]/.test(password) &&
           /[A-Z]/.test(password) &&
           /[0-9]/.test(password) &&
           /[!@#$%^&*]/.test(password);
  }

  async hashPassword(password) {
    // Implementación simplificada
    return 'hashed_' + password;
  }

  async verifyPassword(plain, hashed) {
    return 'hashed_' + plain === hashed;
  }

  async loadPersistedData() {
    // Implementar carga desde BD
  }

  async savePersistedData() {
    // Implementar guardado en BD
  }

  async handleShutdown(event) {
    this.logger.warn('system.shutdown.received', {
      reason: event.payload.reason
    });
    await this.onUnload();
  }
}

module.exports = UserManagementModule;
```

---

## ⚡ 7. Pruebas de hooks

```bash
# 1. Probar autenticación (beforeRequest)
# Sin token - debe fallar 401
curl http://localhost:3000/modules/user-management/profile

# 2. Registrar usuario
curl -X POST http://localhost:3000/modules/user-management/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "email": "alice@example.com",
    "password": "SecurePass123!"
  }'

# 3. Login y guardar token
TOKEN=$(curl -X POST http://localhost:3000/modules/user-management/login \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "SecurePass123!"}' | jq -r '.token')

# 4. Acceder a endpoint protegido (beforeRequest debe autenticar)
curl http://localhost:3000/modules/user-management/profile \
  -H "Authorization: Bearer $TOKEN"

# 5. Verificar logs de hooks
tail -f logs/user-management.log | grep "beforeRequest\|afterRequest\|onError"

# 6. Verificar transformaciones (afterRequest debe sanitizar password)
# Response NO debe contener password completo
```

---

## 📦 8. Convenciones del Agente Núcleo

- Hooks: siempre funciones async
- Nombrado: usar camelCase (beforeRequest, afterRequest, onLoad)
- Context: usar para pasar datos entre hooks (NO modificar req)
- Errors: lanzar Error para abortar request
- Return: hooks deben retornar apropiadamente (void, response, etc.)
- Logging: loggear entrada y salida de hooks importantes
- Performance: hooks deben ser rápidos (< 10ms ideal)
- Composición: hooks deben ser independientes y componibles
- Documentación: documentar propósito y comportamiento

---

## 🧭 9. Formato de salida esperado

Debes retornar:

1. **Resumen de hooks implementados**
   - Lifecycle hooks (onLoad, onUnload)
   - Request hooks (beforeRequest, afterRequest, onError)
   - Event hooks (beforePublish, afterPublish, onEvent)
   - Custom hooks

2. **Orden de ejecución**
   - Diagrama de flujo de hooks
   - Secuencia completa de request → response

3. **Funcionalidad implementada**
   - Autenticación y autorización
   - Rate limiting (si aplica)
   - Transformaciones de response
   - Manejo de errores
   - Validación de eventos

4. **Casos de uso probados**
   - Request sin autenticación (401)
   - Request con autenticación (200)
   - Request sin permisos (403)
   - Request con error (500)

5. **Contenido completo de archivos**
   - `index.js` con todos los hooks
   - Helpers usados por hooks

6. **Logs de ejecución**
   - Ejemplos de logs de hooks
   - Trazas de requests completos

7. **Checklist completado**
   - Marcar cada ítem como ✅ o ❌

---

## 🧩 10. Reglas operativas

- **Hooks simples** - Una responsabilidad clara
- **No modificar req** - Usar context para comunicación
- **Async obligatorio** - Todos los hooks deben ser async
- **Error handling** - Try/catch donde sea apropiado
- **Performance** - Hooks deben ser rápidos
- **Logging apropiado** - No sobre-loggear
- **Documentar** - Propósito y comportamiento
- **Testear** - Unit tests para hooks críticos
- **No side effects globales** - Evitar modificaciones fuera de scope
- **Composable** - Hooks reutilizables

---

## 🔄 11. Capa de Consolidación (al finalizar)

### **Estado de hooks**
- ✅ Lifecycle hooks funcionando (onLoad, onUnload)
- ✅ Request hooks funcionando (beforeRequest, afterRequest, onError)
- ✅ Autenticación implementada
- ✅ Autorización implementada
- ✅ Transformaciones aplicadas
- ✅ Manejo de errores centralizado
- ⚠️ Event hooks implementados (o pendientes)
- ⚠️ Custom hooks implementados (o pendientes)

### **Pendientes**
- Tests unitarios de hooks
- Rate limiting completo
- Hooks de validación
- Hooks de caché
- Documentación completa de hooks

### **Próximos pasos**
- Agregar más validaciones en beforeRequest
- Implementar rate limiting avanzado
- Crear hooks reutilizables en core/
- Optimizar performance de hooks

### **Métricas**
- Total de hooks implementados: X
- Latencia de hooks: X ms (promedio)
- Cobertura de tests: X%

---

**Versión del prompt:** 1.0.0
**Fecha:** 2025-01-14
**Compatible con:** Event Core v0.5.0+
