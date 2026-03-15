# Módulo Project Manager

**Event-driven project lifecycle management with database integration**

## 🎯 Propósito

Gestiona el ciclo de vida completo de proyectos:
- ✅ Creación, actualización y eliminación de proyectos
- ✅ Activación/desactivación de proyecto actual
- ✅ Persistencia via database-manager (100% event-driven)
- ✅ Inicialización automática de esquema DB por proyecto
- ✅ Tracking de proyecto activo
- ✅ Eventos para lifecycle completo

---

## 🏗️ Arquitectura

```
┌──────────────────────────────────────┐
│     Project Manager                  │
├──────────────────────────────────────┤
│ • Project Registry (in-memory)       │
│ • Active Project Tracking            │
│ • Database Integration (via events)  │
│ • Lifecycle Event Publishing         │
└──────────────────────────────────────┘
         ↓ via eventos
┌──────────────────────────────────────┐
│  Database Manager                    │
│  (projects table en system DB)       │
└──────────────────────────────────────┘
```

**Flujo de Creación:**
```
1. POST /projects {"name": "My Project"}
        ↓
2. Project Manager crea registro en DB (via db.query.request)
        ↓
3. Inicializa schema del proyecto (via db.schema.init.request)
        ↓
4. Publica project.created evento
        ↓
5. Proyecto listo para uso
```

---

## 📦 Crear Proyecto

### Via HTTP API

```bash
curl -X POST http://localhost:3000/modules/project-manager/projects \
  -H "Content-Type: application/json" \
  -d '{
    "name": "E-commerce Platform",
    "description": "Main e-commerce project",
    "metadata": {
      "team": "Backend",
      "priority": "high"
    }
  }'
```

**Respuesta:**
```json
{
  "success": true,
  "project": {
    "id": "abc-123-def-456",
    "name": "E-commerce Platform",
    "description": "Main e-commerce project",
    "created_at": "2024-01-15T10:30:00.000Z",
    "updated_at": "2024-01-15T10:30:00.000Z",
    "is_active": false,
    "metadata": {
      "team": "Backend",
      "priority": "high"
    }
  }
}
```

---

## 🔄 Operaciones de Proyecto

### Listar proyectos

```bash
curl http://localhost:3000/modules/project-manager/projects
```

**Respuesta:**
```json
{
  "success": true,
  "projects": [
    {
      "id": "abc-123",
      "name": "E-commerce Platform",
      "description": "Main project",
      "created_at": "2024-01-15T10:30:00.000Z",
      "updated_at": "2024-01-15T10:30:00.000Z",
      "is_active": true,
      "metadata": {}
    },
    {
      "id": "def-456",
      "name": "Analytics Dashboard",
      "description": "Reporting project",
      "created_at": "2024-01-14T09:00:00.000Z",
      "updated_at": "2024-01-14T09:00:00.000Z",
      "is_active": false,
      "metadata": {}
    }
  ],
  "count": 2,
  "active_project_id": "abc-123"
}
```

### Obtener proyecto

```bash
curl http://localhost:3000/modules/project-manager/projects/abc-123
```

**Respuesta:**
```json
{
  "success": true,
  "project": {
    "id": "abc-123",
    "name": "E-commerce Platform",
    "description": "Main project",
    "created_at": "2024-01-15T10:30:00.000Z",
    "updated_at": "2024-01-15T10:30:00.000Z",
    "is_active": true,
    "metadata": {}
  }
}
```

### Actualizar proyecto

```bash
curl -X PUT http://localhost:3000/modules/project-manager/projects/abc-123 \
  -H "Content-Type: application/json" \
  -d '{
    "name": "E-commerce Platform v2",
    "description": "Updated description",
    "metadata": {
      "version": "2.0",
      "team": "Full Stack"
    }
  }'
```

**Respuesta:**
```json
{
  "success": true,
  "project": {
    "id": "abc-123",
    "name": "E-commerce Platform v2",
    "description": "Updated description",
    "created_at": "2024-01-15T10:30:00.000Z",
    "updated_at": "2024-01-15T11:45:00.000Z",
    "is_active": true,
    "metadata": {
      "version": "2.0",
      "team": "Full Stack"
    }
  }
}
```

### Activar proyecto

```bash
curl -X POST http://localhost:3000/modules/project-manager/projects/abc-123/activate
```

**Respuesta:**
```json
{
  "success": true,
  "project": {
    "id": "abc-123",
    "name": "E-commerce Platform",
    "description": "Main project",
    "created_at": "2024-01-15T10:30:00.000Z",
    "updated_at": "2024-01-15T10:30:00.000Z",
    "is_active": true,
    "metadata": {}
  }
}
```

**Efectos:**
- Proyecto anterior se desactiva automáticamente
- Se publica `project.deactivated` para proyecto anterior
- Se publica `project.activated` para nuevo proyecto
- Solo puede haber 1 proyecto activo a la vez

### Obtener proyecto activo

```bash
curl http://localhost:3000/modules/project-manager/projects/active
```

**Respuesta:**
```json
{
  "success": true,
  "project": {
    "id": "abc-123",
    "name": "E-commerce Platform",
    "is_active": true,
    ...
  }
}
```

### Eliminar proyecto

```bash
curl -X DELETE http://localhost:3000/modules/project-manager/projects/abc-123
```

**Respuesta:**
```json
{
  "success": true,
  "id": "abc-123",
  "message": "Project deleted successfully"
}
```

**Restricciones:**
- ❌ No se puede eliminar proyecto activo
- Debe desactivarse primero (activar otro proyecto)

---

## 📡 Eventos Publicados

### project.created
Publicado cuando se crea un proyecto.

```json
{
  "event_id": "uuid",
  "event_type": "project.created",
  "correlation_id": "uuid",
  "occurred_at": "2024-01-15T10:30:00.000Z",
  "producer": "project-manager",
  "payload": {
    "project_id": "abc-123",
    "name": "E-commerce Platform",
    "description": "Main project",
    "created_at": "2024-01-15T10:30:00.000Z"
  }
}
```

### project.updated
Publicado cuando se actualiza metadata del proyecto.

```json
{
  "event_type": "project.updated",
  "payload": {
    "project_id": "abc-123",
    "updated_fields": ["name", "description"],
    "updated_at": "2024-01-15T11:45:00.000Z"
  }
}
```

### project.deleted
Publicado cuando se elimina un proyecto.

```json
{
  "event_type": "project.deleted",
  "payload": {
    "project_id": "abc-123",
    "name": "E-commerce Platform",
    "deleted_at": "2024-01-15T12:00:00.000Z"
  }
}
```

### project.activated
Publicado cuando se activa un proyecto.

```json
{
  "event_type": "project.activated",
  "payload": {
    "project_id": "abc-123",
    "name": "E-commerce Platform",
    "activated_at": "2024-01-15T10:35:00.000Z"
  }
}
```

### project.deactivated
Publicado cuando se desactiva un proyecto (al activar otro).

```json
{
  "event_type": "project.deactivated",
  "payload": {
    "project_id": "def-456",
    "name": "Analytics Dashboard",
    "deactivated_at": "2024-01-15T10:35:00.000Z"
  }
}
```

---

## 🔍 Eventos de Query (Request/Response)

### project.get.request / project.get.response

**Request:**
```javascript
await eventBus.publish('project.get.request', {
  request_id: 'req-123',
  project_id: 'abc-123',
  correlation_id: 'corr-456'
});
```

**Response:**
```json
{
  "event_type": "project.get.response",
  "payload": {
    "request_id": "req-123",
    "success": true,
    "project": { "id": "abc-123", "name": "...", ... },
    "error": null
  }
}
```

### project.list.request / project.list.response

**Request:**
```javascript
await eventBus.publish('project.list.request', {
  request_id: 'req-123',
  correlation_id: 'corr-456'
});
```

**Response:**
```json
{
  "event_type": "project.list.response",
  "payload": {
    "request_id": "req-123",
    "success": true,
    "projects": [...],
    "count": 5,
    "active_project_id": "abc-123"
  }
}
```

### project.active.request / project.active.response

**Request:**
```javascript
await eventBus.publish('project.active.request', {
  request_id: 'req-123',
  correlation_id: 'corr-456'
});
```

**Response:**
```json
{
  "event_type": "project.active.response",
  "payload": {
    "request_id": "req-123",
    "success": true,
    "active_project_id": "abc-123"
  }
}
```

---

## 🗄️ Integración con Database Manager

El Project Manager usa **100% eventos** para comunicarse con database-manager:

**Crear proyecto:**
```javascript
// 1. Insert project metadata
await eventBus.publish('db.query.request', {
  project_id: 'system',
  query: 'INSERT INTO projects (id, name, ...) VALUES (?, ?, ...)',
  params: [projectId, name, ...],
  read_only: false,
  request_id: 'req-123'
});

// 2. Wait for db.query.response
```

**Inicializar schema del proyecto:**
```javascript
await eventBus.publish('db.schema.init.request', {
  project_id: projectId,
  schema: 'CREATE TABLE IF NOT EXISTS conversations (...); ...',
  request_id: 'req-456'
});
```

---

## 📊 Métricas

### Counters
- `project.created.total` - Proyectos creados
- `project.updated.total` - Proyectos actualizados
- `project.deleted.total` - Proyectos eliminados
- `project.activated.total` - Activaciones
- `project.query.total` - Queries totales
- `project.error.total` - Errores

### Gauges
- `project.active.count` - Proyectos activos (0 o 1)
- `project.total.count` - Total de proyectos

### Timings
- `project.creation.duration` - Duración creación
- `project.query.duration` - Duración queries

---

## ⚙️ Configuración

```json
{
  "dbTimeout": 10000,
  "maxProjects": 1000,
  "defaultSchema": "CREATE TABLE IF NOT EXISTS conversations (...); CREATE TABLE IF NOT EXISTS messages (...);"
}
```

**Parámetros:**
- `dbTimeout`: Timeout para queries DB (default: 10000ms)
- `maxProjects`: Máximo proyectos permitidos (default: 1000)
- `defaultSchema`: Schema SQL inicial para nuevos proyectos

---

## 🎯 Casos de Uso

1. **Multi-Tenant SaaS** - Cada cliente = 1 proyecto
2. **Ambientes** - dev/staging/prod como proyectos separados
3. **Feature Branches** - Cada feature con su proyecto
4. **A/B Testing** - Variantes como proyectos
5. **Client Projects** - Agencia con múltiples clientes

---

## 🔗 Integración con Otros Módulos

### Database Manager
Persistencia completa via eventos:
```javascript
await eventBus.publish('db.query.request', { ... });
await eventBus.publish('db.schema.init.request', { ... });
```

### Chat API
Usa proyecto activo automáticamente:
```javascript
const activeProjectId = projectManager.getActiveProjectId();
await chatApi.createConversation(userId, activeProjectId);
```

### Credential Manager
Credentials scoped por proyecto:
```javascript
await credentialManager.setCredential('openai', 'GLOBAL', null, apiKey);
await credentialManager.setCredential('openai', 'PROJECT', projectId, projectApiKey);
```

### AI Agent Framework
Agentes scoped por proyecto:
```javascript
await agentFramework.registerAgent({
  name: 'project-assistant',
  project_id: activeProjectId,
  ...
});
```

---

## ⚠️ Consideraciones

1. **Proyecto Activo**: Solo puede haber 1 proyecto activo a la vez
2. **No Delete Active**: No se puede eliminar proyecto activo
3. **Schema Init**: Cada proyecto obtiene schema DB automáticamente al crearse
4. **System DB**: Metadata de proyectos se guarda en DB del sistema (project_id='system')
5. **Event-Driven**: 100% comunicación via eventos, sin HTTP interno
6. **In-Memory Cache**: Projects cacheados en memoria para performance
7. **Persistence**: Todos los cambios se persisten inmediatamente en DB

---

## 📝 Ejemplo Completo

```bash
# 1. Crear proyecto
curl -X POST http://localhost:3000/modules/project-manager/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "My SaaS", "description": "Production environment"}'

# Respuesta: {"success": true, "project": {"id": "proj-123", ...}}

# 2. Activar proyecto
curl -X POST http://localhost:3000/modules/project-manager/projects/proj-123/activate

# 3. Verificar proyecto activo
curl http://localhost:3000/modules/project-manager/projects/active

# 4. Crear conversación en proyecto activo (via chat-api)
curl -X POST http://localhost:3000/modules/chat-api/conversations \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user-456"}'
# Chat API usa automáticamente proj-123 como projectId

# 5. Cambiar a otro proyecto
curl -X POST http://localhost:3000/modules/project-manager/projects/proj-789/activate
# Automáticamente desactiva proj-123 y activa proj-789

# 6. Listar todos los proyectos
curl http://localhost:3000/modules/project-manager/projects
```

---

## 🏁 Health & Metrics

```bash
# Health check
curl http://localhost:3000/modules/project-manager/health

# Respuesta
{
  "status": "healthy",
  "module": "project-manager",
  "projects_count": 5,
  "active_project": "proj-123",
  "uptime": 3600.5
}

# Metrics
curl http://localhost:3000/modules/project-manager/metrics

# Respuesta
{
  "module": "project-manager",
  "metrics": {
    "total_projects": 5,
    "active_project_id": "proj-123",
    "pending_db_requests": 0
  }
}
```
