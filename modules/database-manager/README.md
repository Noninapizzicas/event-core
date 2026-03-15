# Módulo Database Manager

**Gestión de bases de datos SQLite por proyecto usando sql.js (JavaScript puro)**

## 📦 Eventos Publicados

### `db.created`
Cuando se crea una nueva base de datos para un proyecto.

```json
{
  "event_type": "db.created",
  "payload": {
    "project_id": "my-project",
    "created_at": "2024-01-15T10:30:00.000Z"
  }
}
```

### `db.deleted`
Cuando se elimina una base de datos.

```json
{
  "event_type": "db.deleted",
  "payload": {
    "project_id": "my-project",
    "deleted_at": "2024-01-15T10:30:00.000Z"
  }
}
```

### `db.query.executed`
Cuando se ejecuta una consulta SQL exitosamente.

```json
{
  "event_type": "db.query.executed",
  "payload": {
    "project_id": "my-project",
    "result_count": 10,
    "read_only": false,
    "duration": 15
  }
}
```

### `db.schema.initialized`
Cuando se inicializa el esquema de una base de datos.

```json
{
  "event_type": "db.schema.initialized",
  "payload": {
    "project_id": "my-project",
    "initialized_at": "2024-01-15T10:30:00.000Z"
  }
}
```

### `db.query.response`
Respuesta a una solicitud de query vía evento.

```json
{
  "event_type": "db.query.response",
  "payload": {
    "success": true,
    "project_id": "my-project",
    "request_id": "req-123",
    "data": [{"id": 1, "name": "test"}]
  }
}
```

### `db.schema.init.response`
Respuesta a una solicitud de inicialización de esquema vía evento.

```json
{
  "event_type": "db.schema.init.response",
  "payload": {
    "success": true,
    "project_id": "my-project",
    "request_id": "req-456"
  }
}
```

---

## 📡 Eventos Suscritos

### `db.query.request`
Permite a otros módulos ejecutar queries SQL sin HTTP interno.

```json
{
  "project_id": "my-project",
  "query": "SELECT * FROM users WHERE id = ?",
  "params": [1],
  "read_only": true,
  "request_id": "req-123",
  "correlation_id": "uuid"
}
```

### `db.schema.init.request`
Permite inicializar esquemas vía eventos.

```json
{
  "project_id": "my-project",
  "schema": "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)",
  "request_id": "req-456",
  "correlation_id": "uuid"
}
```

---

## 🔌 APIs HTTP

| Método | Path | Descripción |
|--------|------|-------------|
| GET | `/databases` | Listar todas las bases de datos |
| POST | `/databases/:projectId/query` | Ejecutar query SQL |
| GET | `/databases/:projectId/schema` | Obtener esquema de la BD |
| POST | `/databases/:projectId/init` | Inicializar esquema |
| DELETE | `/databases/:projectId` | Eliminar base de datos |
| GET | `/databases/:projectId/tables` | Listar tablas |
| GET | `/health` | Health check |
| GET | `/metrics` | Métricas del módulo |

---

## 🧪 Ejemplos de Uso

### Listar bases de datos
```bash
curl http://localhost:3000/modules/database-manager/databases
```

### Ejecutar query
```bash
curl -X POST http://localhost:3000/modules/database-manager/databases/my-project/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "SELECT * FROM users WHERE active = ?",
    "params": [1],
    "read_only": true
  }'
```

### Inicializar esquema
```bash
curl -X POST http://localhost:3000/modules/database-manager/databases/my-project/init \
  -H "Content-Type: application/json" \
  -d '{
    "schema": "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE, created_at TEXT DEFAULT CURRENT_TIMESTAMP)"
  }'
```

### Obtener tablas
```bash
curl http://localhost:3000/modules/database-manager/databases/my-project/tables
```

### Eliminar base de datos
```bash
curl -X DELETE http://localhost:3000/modules/database-manager/databases/my-project
```

---

## 🔄 Uso desde Otros Módulos (Event-Driven)

### Ejecutar query vía eventos
```javascript
// En otro módulo
async queryDatabase(projectId, query, params, correlationId) {
  const requestId = `req_${Date.now()}`;

  // Esperar respuesta
  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);

    const unsubscribe = this.eventBus.on('db.query.response', (event) => {
      if (event.payload.request_id === requestId) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(event.payload);
      }
    });
  });

  // Publicar solicitud
  await this.eventBus.publish('db.query.request', {
    project_id: projectId,
    query,
    params,
    request_id: requestId,
    read_only: true,
    correlation_id: correlationId
  });

  return await responsePromise;
}
```

---

## 📊 Métricas

### Counters
- `db.created.total` - Total de BDs creadas
- `db.deleted.total` - Total de BDs eliminadas
- `db.query.total` - Total de queries ejecutadas
- `db.query.errors` - Total de errores en queries
- `db.schema.init.total` - Total de esquemas inicializados
- `db.schema.init.errors` - Errores en inicialización
- `db.saved.total` - Total de guardados a disco
- `db.save.errors` - Errores al guardar

### Gauges
- `db.loaded.count` - BDs cargadas en memoria
- `db.projects.count` - Total de proyectos con BD

### Timings
- `db.query.duration` - Duración de queries
- `db.save.duration` - Duración de guardado
- `db.load.duration` - Duración de carga

---

## ⚙️ Configuración

```json
{
  "projectsPath": "./data/projects",
  "autoSave": true,
  "maxDatabases": 100,
  "queryTimeout": 10000
}
```
