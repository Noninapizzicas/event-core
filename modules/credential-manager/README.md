# Módulo Credential Manager

**Gestión multi-nivel de credenciales con almacenamiento en .env**

## 🔐 Niveles de Prioridad

| Nivel | Prioridad | Requiere ID | Descripción |
|-------|-----------|-------------|-------------|
| CUSTOM | 1 (más alta) | Sí | Credenciales específicas personalizadas |
| CLIENT | 2 | Sí | Credenciales por cliente |
| PROJECT | 3 | Sí | Credenciales por proyecto |
| GLOBAL | 4 (fallback) | No | Credenciales globales |

### Resolución en Cascada
```
CUSTOM_{customId} → CLIENT_{clientId} → PROJECT_{projectId} → GLOBAL
```

---

## 📦 Eventos Publicados

### `credential.saved`
```json
{
  "event_type": "credential.saved",
  "payload": {
    "key": "OPENAI_API_KEY_PROJECT_myapp",
    "provider": "OPENAI",
    "level": "PROJECT",
    "identifier": "myapp",
    "created": true,
    "updated": false
  }
}
```

### `credential.updated`
```json
{
  "event_type": "credential.updated",
  "payload": {
    "key": "OPENAI_API_KEY_GLOBAL",
    "updated_at": "2024-01-15T10:30:00.000Z"
  }
}
```

### `credential.deleted`
```json
{
  "event_type": "credential.deleted",
  "payload": {
    "key": "OPENAI_API_KEY_CLIENT_old",
    "deleted_at": "2024-01-15T10:30:00.000Z"
  }
}
```

### `credential.resolved`
```json
{
  "event_type": "credential.resolved",
  "payload": {
    "provider": "OPENAI",
    "resolved_from": "PROJECT",
    "key": "OPENAI_API_KEY_PROJECT_myapp"
  }
}
```

### `credential.resolve.failed`
```json
{
  "event_type": "credential.resolve.failed",
  "payload": {
    "provider": "UNKNOWN",
    "attempts": [
      "UNKNOWN_API_KEY_CUSTOM_x",
      "UNKNOWN_API_KEY_CLIENT_y",
      "UNKNOWN_API_KEY_PROJECT_z",
      "UNKNOWN_API_KEY_GLOBAL"
    ]
  }
}
```

### `credential.resolve.response`
Respuesta a solicitudes de resolución vía eventos.

```json
{
  "event_type": "credential.resolve.response",
  "payload": {
    "request_id": "req_123",
    "success": true,
    "provider": "OPENAI",
    "api_key": "sk-xxx...",
    "resolved_from": "PROJECT"
  }
}
```

---

## 📡 Eventos Suscritos

### `credential.resolve.request`
Permite a otros módulos resolver credenciales sin HTTP interno.

```json
{
  "provider": "OPENAI",
  "project_id": "myapp",
  "client_id": "client123",
  "custom_id": null,
  "request_id": "req_123",
  "correlation_id": "uuid"
}
```

---

## 🔌 APIs HTTP

| Método | Path | Descripción |
|--------|------|-------------|
| POST | `/credentials` | Guardar credencial |
| GET | `/credentials/resolve` | Resolver por cascada |
| GET | `/credentials` | Listar (enmascaradas) |
| PUT | `/credentials/:key` | Actualizar valor |
| DELETE | `/credentials/:key` | Eliminar |
| GET | `/credentials/levels` | Info de niveles |
| GET | `/health` | Health check |
| GET | `/metrics` | Métricas |

---

## 🧪 Ejemplos de Uso

### Guardar credencial GLOBAL
```bash
curl -X POST http://localhost:3000/modules/credential-manager/credentials \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "OPENAI",
    "level": "GLOBAL",
    "api_key": "sk-your-global-key"
  }'
```

### Guardar credencial PROJECT
```bash
curl -X POST http://localhost:3000/modules/credential-manager/credentials \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "DEEPSEEK",
    "level": "PROJECT",
    "identifier": "myapp",
    "api_key": "sk-project-specific-key"
  }'
```

### Resolver credencial
```bash
curl "http://localhost:3000/modules/credential-manager/credentials/resolve?provider=OPENAI&projectId=myapp&clientId=client123"
```

### Listar credenciales
```bash
curl "http://localhost:3000/modules/credential-manager/credentials?level=GLOBAL"
```

### Actualizar credencial
```bash
curl -X PUT http://localhost:3000/modules/credential-manager/credentials/OPENAI_API_KEY_GLOBAL \
  -H "Content-Type: application/json" \
  -d '{"api_key": "sk-new-key"}'
```

### Eliminar credencial
```bash
curl -X DELETE http://localhost:3000/modules/credential-manager/credentials/OPENAI_API_KEY_CLIENT_old
```

---

## 🔄 Uso desde Otros Módulos (Event-Driven)

### Resolver credencial vía eventos
```javascript
// En ai-connector
async getCredential(provider, context) {
  const requestId = `req_${Date.now()}`;

  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);

    const unsubscribe = this.eventBus.on('credential.resolve.response', (event) => {
      if (event.payload.request_id === requestId) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(event.payload);
      }
    });
  });

  await this.eventBus.publish('credential.resolve.request', {
    provider,
    project_id: context.projectId,
    client_id: context.clientId,
    custom_id: context.customId,
    request_id: requestId,
    correlation_id: context.correlationId
  });

  const response = await responsePromise;

  if (!response.success) {
    throw new Error(response.error);
  }

  return response.api_key;
}
```

---

## 📊 Métricas

### Counters
- `credential.saved.total` - Total guardadas
- `credential.updated.total` - Total actualizadas
- `credential.deleted.total` - Total eliminadas
- `credential.resolved.total` - Total resueltas
- `credential.resolve.failed.total` - Resoluciones fallidas
- `credential.errors.total` - Errores generales

### Gauges
- `credential.count.total` - Total de credenciales
- `credential.count.global` - Credenciales GLOBAL
- `credential.count.project` - Credenciales PROJECT
- `credential.count.client` - Credenciales CLIENT
- `credential.count.custom` - Credenciales CUSTOM

### Timings
- `credential.resolve.duration` - Tiempo de resolución
- `credential.save.duration` - Tiempo de guardado

---

## 📁 Formato .env

```bash
# Credentials managed by credential-manager
# Last updated: 2024-01-15T10:30:00.000Z

# GLOBAL credentials
OPENAI_API_KEY_GLOBAL=sk-xxx
ANTHROPIC_API_KEY_GLOBAL=sk-yyy

# PROJECT credentials
DEEPSEEK_API_KEY_PROJECT_myapp=sk-zzz
OPENAI_API_KEY_PROJECT_other=sk-aaa

# CLIENT credentials
ANTHROPIC_API_KEY_CLIENT_acme=sk-bbb

# CUSTOM credentials
OPENAI_API_KEY_CUSTOM_special=sk-ccc
```

---

## ⚙️ Configuración

```json
{
  "envFile": ".env",
  "maskLength": 4,
  "levels": {
    "CUSTOM": {
      "priority": 1,
      "requiresIdentifier": true,
      "description": "Highest priority - custom specific"
    },
    "CLIENT": {
      "priority": 2,
      "requiresIdentifier": true,
      "description": "Client-specific"
    },
    "PROJECT": {
      "priority": 3,
      "requiresIdentifier": true,
      "description": "Project-specific"
    },
    "GLOBAL": {
      "priority": 4,
      "requiresIdentifier": false,
      "description": "Global fallback"
    }
  }
}
```
