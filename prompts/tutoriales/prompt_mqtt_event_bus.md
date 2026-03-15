# 📡 Prompt Maestro — MQTT y Event Bus (Event Core)

**Rol activo:**
**Especialista en Comunicación Asíncrona y Event-Driven Architecture (Monoespecialista)**
Encargado de implementar publicación y suscripción de eventos MQTT para comunicación desacoplada entre módulos Event Core.

---

## 🎯 Objetivo General
Implementar **comunicación basada en eventos** usando MQTT pub/sub para desacoplar módulos, habilitar integraciones y crear flujos reactivos entre componentes del sistema.

Debes implementar:
- Publicación de eventos desde módulos (publisher)
- Suscripción a eventos de otros módulos (subscriber)
- Trazabilidad completa con correlation IDs
- Manejo de errores y reintentos
- Patrones avanzados: request/response, broadcast, Dead Letter Queue

---

## 🧱 1. Estructura esperada

```
modules/[MODULO_PUBLISHER]/
├── module.json          ← Define eventos que publica
└── index.js             ← Publica eventos con eventBus.publish()

modules/[MODULO_SUBSCRIBER]/
├── module.json          ← Define eventos a los que se suscribe
└── index.js             ← Registra handlers en onLoad()

core/event-bus/
├── index.js             ← EventBus principal [YA EXISTE]
└── mqtt/
    ├── client.js        ← Cliente MQTT [YA EXISTE]
    └── pool.js          ← Connection pooling [YA EXISTE]
```

---

## ⚙️ 2. Fases de implementación

### **Fase 1 — Publicar eventos básicos**

1. En `module.json` del módulo publisher, definir sección `events.publishes` con lista de eventos
2. En handlers del módulo, publicar eventos usando:
   ```javascript
   await this.eventBus.publish('evento.nombre', payload, options)
   ```
3. Payload debe ser objeto JSON serializable (< 1KB recomendado)
4. Incluir siempre `correlationId` en options para trazabilidad
5. Loggear publicación del evento con nivel `info`
6. Registrar métrica `events.published` con tag de tipo de evento
7. Verificar en logs MQTT broker que evento se publica correctamente

**Complejidad:** 2 Story Points
**Tiempo estimado:** 30 minutos

---

### **Fase 2 — Suscribirse a eventos**

1. En `module.json` del módulo subscriber, definir sección `events.subscribes` con lista de eventos
2. En hook `onLoad()`, registrar handlers para cada evento:
   ```javascript
   await this.eventBus.subscribe('evento.nombre', this.handleEvento.bind(this))
   ```
3. Implementar handler como función async que recibe `event` con estructura:
   ```javascript
   {
     eventId: 'evt_123',
     eventType: 'user.created',
     correlationId: 'req_abc',
     timestamp: '2025-01-14T...',
     payload: { ... }
   }
   ```
4. Handler debe:
   - Loggear recepción del evento con `correlationId`
   - Manejar errores con try/catch
   - Ser idempotente (procesar mismo evento múltiples veces sin problemas)
   - Registrar métrica `events.received`
5. Probar flujo completo: publicar evento → verificar logs de subscriber

**Complejidad:** 5 Story Points
**Tiempo estimado:** 2-3 horas

---

### **Fase 3 — Trazabilidad con Correlation IDs**

1. En HTTP requests, el `correlationId` se genera automáticamente en `context.correlationId`
2. Al publicar evento, propagar `correlationId` del request original:
   ```javascript
   await this.eventBus.publish('user.created', payload, {
     correlationId: context.correlationId
   })
   ```
3. En subscriber, usar mismo `correlationId` en logs y eventos subsecuentes:
   ```javascript
   this.logger.info('event.received', {
     correlationId: event.correlationId
   })
   ```
4. Al publicar nuevo evento desde subscriber, mantener `correlationId`:
   ```javascript
   await this.eventBus.publish('notification.sent', payload, {
     correlationId: event.correlationId
   })
   ```
5. Implementar búsqueda de logs por `correlationId` para rastrear flujo completo
6. Documentar cadena de eventos en diagrama de flujo

**Complejidad:** 3 Story Points
**Tiempo estimado:** 1-2 horas

---

### **Fase 4 — Patrones avanzados**

Implementar al menos uno de estos patrones:

#### **A) Request/Response para UI (RECOMENDADO)**

El patrón estándar para comunicación UI↔Backend. Ver documentación completa en `docs/architecture/mqtt-request-response.md`.

**Backend (registrar handlers en el módulo):**
```javascript
async onLoad(context) {
  // Registrar handlers para UI
  context.uiHandler.register('midominio', 'list', this.handleUIList.bind(this));
  context.uiHandler.register('midominio', 'create', this.handleUICreate.bind(this));
  context.uiHandler.register('midominio', 'update', this.handleUIUpdate.bind(this));
  context.uiHandler.register('midominio', 'delete', this.handleUIDelete.bind(this));
}

async handleUIList(data, context) {
  const items = this.listItems();
  return { status: 200, data: { items } };
}

async handleUICreate(data, context) {
  const item = this.createItem(data);
  return { status: 201, data: { item } };
}
```

**Frontend (TypeScript):**
```typescript
import { mqttRequest } from '$lib/ui-core/mqtt-request';

// Listar items
const response = await mqttRequest<{ items: Item[] }>('midominio', 'list');

// Crear item
const result = await mqttRequest('midominio', 'create', { name: 'Nuevo' });

// Con manejo de errores
try {
  const response = await mqttRequest('midominio', 'delete', { id: '123' });
} catch (error) {
  if (error instanceof MqttTimeoutError) {
    console.error('Backend no responde');
  }
}
```

**Topics MQTT:**
- Request: `ui/request/{domain}/{action}`
- Response: `ui/response/{request_id}`

#### **B) Request/Response genérico (RPC sobre MQTT)**
```javascript
// Publisher (requester)
const response = await this.eventBus.request('user.profile.get', {
  userId: 123
}, {
  timeout: 5000
});

// Subscriber (responder)
await this.eventBus.onRequest('user.profile.get', async (request) => {
  const user = await this.getUser(request.payload.userId);
  return { user };
});
```

#### **C) Broadcast a múltiples servicios**
```javascript
await this.eventBus.broadcast('system.shutdown', {
  reason: 'Maintenance',
  gracePeriod: 60000
});
```

#### **D) Event Filtering (wildcards)**
```javascript
await this.eventBus.subscribe('user.*', this.handleAnyUserEvent.bind(this));
await this.eventBus.subscribe('order.*.failed', this.handleOrderFailure.bind(this));
```

#### **E) Dead Letter Queue (DLQ)**
```javascript
async handleEvent(event) {
  try {
    await this.processEvent(event);
  } catch (error) {
    if (event.retryCount < 3) {
      await this.eventBus.publish(event.eventType, event.payload, {
        retryCount: (event.retryCount || 0) + 1,
        delay: 1000 * Math.pow(2, event.retryCount)
      });
    } else {
      await this.eventBus.publish('dlq.' + event.eventType, {
        originalEvent: event,
        error: error.message
      });
    }
  }
}
```

**Complejidad:** 13 Story Points
**Tiempo estimado:** 1-2 días

---

## 🧠 3. Buenas prácticas (Best Practices)

✅ **Nomenclatura clara** para eventos (`entity.action`, ej: `user.created`, `order.paid`)
✅ **Payloads pequeños** (< 1KB ideal, usar IDs en vez de objetos completos)
✅ **Eventos inmutables** - No modificar payload recibido
✅ **Idempotencia** - Handlers deben soportar procesamiento múltiple del mismo evento
✅ **Correlation IDs** - SIEMPRE propagar para trazabilidad completa
✅ **Manejo de errores** - Try/catch en todos los handlers de eventos
✅ **Reintentos** - Implementar backoff exponencial para fallos transitorios
✅ **DLQ** - Dead Letter Queue para eventos que fallan después de reintentos
✅ **Versioning** - Incluir versión en payload para evolución de schemas
✅ **Logging** - Loggear publicación Y recepción de eventos
✅ **Métricas** - Contar eventos publicados/procesados/fallidos
✅ **Timeouts** - Límites en request/response
✅ **No bloquear** - Handlers async deben ser rápidos (< 100ms ideal)

---

## 📋 4. Checklist de entrega

**Publicación:**
- [ ] Definir eventos en `module.json` (publishes)
- [ ] Publicar eventos en operaciones clave del módulo
- [ ] Incluir payload mínimo necesario (no objetos completos)
- [ ] Propagar correlationId en todos los eventos
- [ ] Loggear eventos publicados con nivel info
- [ ] Registrar métrica de publicación por tipo de evento

**Suscripción:**
- [ ] Definir suscripciones en `module.json` (subscribes)
- [ ] Implementar handlers para cada tipo de evento
- [ ] Manejo de errores con try/catch en handlers
- [ ] Implementar idempotencia en handlers
- [ ] Loggear eventos recibidos con correlationId
- [ ] Registrar métrica de procesamiento

**Trazabilidad:**
- [ ] Propagar correlationId en toda la cadena de eventos
- [ ] Logs estructurados con correlationId
- [ ] Métricas por tipo de evento
- [ ] Implementar DLQ para eventos fallidos

**Documentación:**
- [ ] Documentar eventos publicados con descripción
- [ ] Documentar estructura de payload de cada evento
- [ ] Crear diagrama de flujo de eventos
- [ ] Comandos curl para probar flujo completo

---

## 🧾 5. Ejemplo de módulo Publisher

**modules/user-service/module.json:**
```json
{
  "name": "user-service",
  "events": {
    "publishes": [
      "user.created",
      "user.updated",
      "user.deleted",
      "user.login"
    ],
    "subscribes": []
  }
}
```

**modules/user-service/index.js:**
```javascript
class UserServiceModule {
  async handleCreateUser(req, context) {
    try {
      const user = {
        id: this.nextId++,
        username: context.body.username,
        email: context.body.email,
        createdAt: new Date().toISOString()
      };

      this.users.set(user.id, user);

      // Publicar evento
      await this.eventBus.publish('user.created', {
        userId: user.id,
        username: user.username,
        email: user.email
      }, {
        correlationId: context.correlationId
      });

      this.logger.info('user.created', {
        userId: user.id,
        correlationId: context.correlationId
      });

      this.metrics.increment('user.created.total');
      this.metrics.increment('events.published', 1, {
        eventType: 'user.created'
      });

      return { status: 201, data: user };
    } catch (error) {
      this.logger.error('user.create.error', { error: error.message });
      throw error;
    }
  }
}

module.exports = UserServiceModule;
```

---

## 🧾 6. Ejemplo de módulo Subscriber

**modules/notification-service/module.json:**
```json
{
  "name": "notification-service",
  "events": {
    "subscribes": [
      "user.created",
      "user.updated",
      "user.login"
    ],
    "publishes": [
      "notification.sent",
      "notification.failed"
    ]
  }
}
```

**modules/notification-service/index.js:**
```javascript
class NotificationServiceModule {
  async onLoad(moduleAPI) {
    this.eventBus = moduleAPI.eventBus;
    this.logger = moduleAPI.logger;
    this.metrics = moduleAPI.metrics;

    // Registrar handlers de eventos
    await this.eventBus.subscribe('user.created', this.handleUserCreated.bind(this));
    await this.eventBus.subscribe('user.updated', this.handleUserUpdated.bind(this));
    await this.eventBus.subscribe('user.login', this.handleUserLogin.bind(this));

    this.logger.info('notification.service.loaded', {
      subscriptions: ['user.created', 'user.updated', 'user.login']
    });
  }

  async handleUserCreated(event) {
    const startTime = Date.now();

    try {
      this.logger.info('user.created.received', {
        userId: event.payload.userId,
        correlationId: event.correlationId
      });

      this.metrics.increment('events.received', 1, {
        eventType: 'user.created'
      });

      // Enviar email de bienvenida
      await this.sendEmail({
        to: event.payload.email,
        subject: 'Welcome!',
        template: 'welcome',
        data: {
          username: event.payload.username
        }
      });

      // Publicar evento de éxito
      await this.eventBus.publish('notification.sent', {
        type: 'welcome_email',
        userId: event.payload.userId,
        email: event.payload.email
      }, {
        correlationId: event.correlationId
      });

      this.metrics.increment('notification.sent.total', 1, {
        type: 'welcome_email'
      });

      this.metrics.timing('notification.processing.time', Date.now() - startTime);

    } catch (error) {
      this.logger.error('notification.send.error', {
        error: error.message,
        userId: event.payload?.userId,
        correlationId: event.correlationId
      });

      // Publicar evento de fallo
      await this.eventBus.publish('notification.failed', {
        type: 'welcome_email',
        userId: event.payload.userId,
        error: error.message
      }, {
        correlationId: event.correlationId
      });

      this.metrics.increment('notification.failed.total', 1, {
        type: 'welcome_email'
      });
    }
  }

  async handleUserUpdated(event) {
    // Solo procesar cambios de email
    if (event.payload.field === 'email') {
      this.logger.info('user.email.updated', {
        userId: event.payload.userId,
        correlationId: event.correlationId
      });

      await this.sendEmail({
        to: event.payload.newEmail,
        subject: 'Email changed',
        template: 'email_changed'
      });
    }
  }

  async handleUserLogin(event) {
    this.logger.info('user.login.received', {
      userId: event.payload.userId,
      correlationId: event.correlationId
    });

    // Registrar última conexión
    await this.updateLastSeen(event.payload.userId);
  }

  async sendEmail(options) {
    // Implementación de envío de email
    this.logger.info('email.sent', {
      to: options.to,
      subject: options.subject
    });
  }
}

module.exports = NotificationServiceModule;
```

---

## ⚡ 7. Pruebas de eventos

### **Monitorear eventos MQTT (debugging)**
```bash
# Suscribirse a todos los eventos
mosquitto_sub -h localhost -p 1883 -t '/events/#' -v

# Suscribirse a eventos específicos
mosquitto_sub -h localhost -p 1883 -t '/events/user.created'
```

### **Publicar evento manualmente (testing)**
```bash
mosquitto_pub -h localhost -p 1883 -t '/events/user.created' \
  -m '{
    "eventType": "user.created",
    "payload": {
      "userId": 999,
      "username": "test_user",
      "email": "test@example.com"
    }
  }'
```

### **Probar flujo completo**
```bash
# 1. Crear usuario (trigger evento)
curl -X POST http://localhost:3000/modules/user-service/users \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "email": "alice@example.com",
    "password": "SecurePass123!"
  }'

# 2. Verificar logs de publicación
tail -f logs/user-service.log | grep "user.created"

# 3. Verificar logs de suscripción
tail -f logs/notification-service.log | grep "user.created.received"

# 4. Verificar que notification.sent se publica
tail -f logs/notification-service.log | grep "notification.sent"

# 5. Buscar por correlationId
grep "correlationId.*req_abc123" logs/*.log
```

---

## 📦 8. Convenciones del Agente Núcleo

- Eventos: nomenclatura `entity.action` (ej: `user.created`, `order.paid`)
- Payloads: objetos JSON serializables < 1KB
- Correlation IDs: obligatorios en todos los eventos
- Topics MQTT: `/events/[event.type]`
- Versioning: incluir `version: "1.0"` en payload
- Timestamps: formato ISO 8601 (`new Date().toISOString()`)
- Event IDs: generados automáticamente por EventBus
- Logging: nivel `info` para eventos normales, `error` para fallos
- Métricas: `events.published`, `events.received`, `events.failed`

---

## 🧭 9. Formato de salida esperado

Debes retornar:

1. **Resumen de eventos implementados**
   - Eventos publicados por el módulo (con descripción)
   - Eventos a los que se suscribe (con descripción)
   - Handlers implementados

2. **Diagrama de flujo de eventos**
   ```
   User creates account (HTTP POST)
   → user-service publishes user.created
   → notification-service receives user.created
   → notification-service sends welcome email
   → notification-service publishes notification.sent
   ```

3. **Estructura de payloads**
   - Payload de cada evento con ejemplo
   - Campos obligatorios vs opcionales

4. **Pruebas realizadas**
   - Comandos curl usados
   - Logs de publicación
   - Logs de recepción
   - Correlation IDs propagados correctamente

5. **Métricas registradas**
   - Lista de métricas con tipo y tags
   - Ejemplo de valores esperados

6. **Contenido completo de archivos**
   - `module.json` de publisher
   - `module.json` de subscriber
   - `index.js` de ambos módulos

7. **Checklist completado**
   - Marcar cada ítem como ✅ o ❌

---

## 🧩 10. Reglas operativas

- **Eventos inmutables** - No modificar payloads recibidos
- **Idempotencia obligatoria** - Procesar mismo evento múltiples veces sin side effects duplicados
- **Correlation IDs siempre** - NUNCA publicar evento sin correlationId
- **Payloads pequeños** - Usar referencias (IDs) en vez de objetos completos
- **Manejo de errores** - Try/catch en todos los handlers
- **Logging completo** - Publicación + Recepción + Procesamiento
- **Métricas completas** - Contar publicaciones, recepciones, fallos
- **No bloquear** - Handlers deben ser rápidos (< 100ms ideal)
- **Versionado** - Incluir versión en payload para compatibilidad
- **No side effects** - Evitar modificaciones globales en handlers

---

## 🔄 11. Capa de Consolidación (al finalizar)

### **Estado del sistema de eventos**
- ✅ Publicación funcionando correctamente
- ✅ Suscripción funcionando correctamente
- ✅ Correlation IDs propagándose
- ✅ Métricas registrándose
- ✅ Logging completo

### **Pendientes**
- Implementar DLQ (Dead Letter Queue) completo
- Event sourcing (opcional)
- Event replay (opcional)
- Schema validation de eventos
- Monitoreo de latencia de eventos

### **Próximos pasos**
- Crear dashboard de eventos en UI
- Visualización de flujos de eventos
- Alertas en eventos críticos
- Métricas de throughput de eventos

### **Métricas de implementación**
- Total de eventos publicados: X tipos
- Total de suscripciones: X handlers
- Latencia promedio de eventos: X ms
- Tasa de fallos: X%

---

**Versión del prompt:** 1.0.0
**Fecha:** 2025-01-14
**Compatible con:** Event Core v0.5.0+ (MQTT 3.1.1)
