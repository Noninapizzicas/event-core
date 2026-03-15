# 🧩 Prompt Maestro — Crear un Módulo con APIs (Event Core)

**Rol activo:**
**Especialista en Implementación de Módulos Event Core (Monoespecialista)**
Encargado de guiar, crear y validar módulos completos con APIs REST, eventos y hooks, según la arquitectura Event Core.

---

## 🎯 Objetivo General
Implementar un **módulo funcional en Event Core** con APIs REST, validación, logging estructurado, publicación de eventos y métricas.

Debes crear:
- `module.json` (manifiesto con endpoints, eventos y configuración)
- `index.js` (clase principal del módulo)
- Handlers CRUD funcionales
- Integración con eventos MQTT
- Métricas y logging estructurado
- (Opcional) Sección `ui` para interfaz JSON-Driven

---

## 🧱 1. Estructura esperada del módulo

```
modules/[NOMBRE_MODULO]/
├── module.json          ← Manifest con APIs y metadata
├── index.js             ← Clase principal del módulo
├── handlers/            ← Handlers separados (opcional)
│   ├── users.js
│   └── products.js
├── models/              ← Modelos de datos (opcional)
│   └── user.js
├── validators/          ← Validadores personalizados (opcional)
│   └── customValidator.js
├── utils/               ← Utilidades (opcional)
│   └── helpers.js
├── config.json          ← Configuración del módulo (opcional)
├── README.md            ← Documentación
└── tests/               ← Tests unitarios (opcional)
    └── index.test.js
```

---

## ⚙️ 2. Fases de implementación

### **Fase 1 — Módulo básico (TODO List)**
1. Crear directorio `modules/todo-list/`
2. Crear `module.json` con las siguientes rutas CRUD:
   - `GET /todos` → `handleListTodos`
   - `POST /todos` → `handleCreateTodo`
   - `GET /todos/:id` → `handleGetTodo`
   - `PUT /todos/:id` → `handleUpdateTodo`
   - `DELETE /todos/:id` → `handleDeleteTodo`
   - `POST /todos/:id/complete` → `handleCompleteTodo`
3. Crear `index.js` con clase `TodoListModule` que incluya:
   - Estado en memoria usando `Map`
   - Hooks: `onLoad()`, `onUnload()`
   - Publicar eventos: `todo.created`, `todo.updated`, `todo.deleted`, `todo.completed`
   - Registrar métricas: `todo.created.total`, `todo.completed.total`, etc.
4. Implementar todos los handlers CRUD con manejo de errores
5. Probar con `curl` todos los endpoints

**Complejidad:** 3 Story Points
**Tiempo estimado:** 1-2 horas

---

### **Fase 2 — Módulo intermedio (User Management)**
1. Crear directorio `modules/user-management/`
2. Crear `module.json` con rutas de autenticación:
   - `POST /register` → `handleRegister`
   - `POST /login` → `handleLogin`
   - `GET /profile` → `handleGetProfile` (requiere auth)
   - `PUT /profile` → `handleUpdateProfile` (requiere auth)
   - `GET /users` → `handleListUsers` (solo admin)
3. Implementar `index.js` con:
   - Registro de usuarios con validación
   - Login con generación de tokens (`crypto.randomBytes`)
   - Hook `beforeRequest` para validar autenticación
   - Sistema de roles (`user`, `admin`)
   - Validación de input con schemas JSON Schema
   - Publicación de eventos: `user.registered`, `user.login`, `user.profile.updated`
4. Implementar almacenamiento de sesiones en memoria
5. Probar flujo completo de autenticación con `curl`

**Complejidad:** 8 Story Points
**Tiempo estimado:** 4-6 horas

---

### **Fase 3 — Módulo avanzado (con persistencia)**
1. Extender el módulo para usar base de datos (SQLite, PostgreSQL o MongoDB)
2. Crear carpeta `models/` con esquemas de datos
3. Implementar validadores personalizados en `validators/`
4. Agregar migraciones de base de datos si es necesario
5. Publicar métricas de base de datos (latencia de queries, conexiones activas)
6. (Opcional) Agregar sección `ui` en `module.json` para interfaz automática

**Complejidad:** 13 Story Points
**Tiempo estimado:** 1-2 días

---

## 🧠 3. Buenas prácticas (Best Practices)

✅ **Validar siempre el input** del usuario antes de procesar
✅ **Manejar errores** con `try/catch` en todos los handlers
✅ **Usar logging estructurado** (`this.logger.info('operation', {...})`)
✅ **Publicar eventos** con `this.eventBus.publish()` para trazabilidad
✅ **Registrar métricas** con `this.metrics.increment()` y `this.metrics.timing()`
✅ **Nunca retornar datos sensibles** (passwords, tokens completos)
✅ **Sanitizar input** para prevenir XSS, SQL injection
✅ **Documentar APIs** en `README.md` con ejemplos de `curl`
✅ **Usar async/await** para operaciones asíncronas
✅ **Implementar idempotencia** en operaciones críticas

---

## 🧩 4. Opcional — Interfaz gráfica (UI JSON-Driven)

Si el módulo debe tener UI automática:
- Agregar en `module.json` una sección `ui` con vistas (`table`, `form`, `detail`)
- Definir columnas, formularios y acciones
- La UI se generará automáticamente en `http://localhost:3000/ui`

Ejemplo:
```json
"ui": {
  "views": {
    "list": {
      "type": "table",
      "title": "Lista de TODOs",
      "endpoint": "/modules/todo-list/todos",
      "columns": ["id", "title", "completed", "createdAt"]
    },
    "create": {
      "type": "form",
      "title": "Crear TODO",
      "endpoint": "/modules/todo-list/todos",
      "method": "POST",
      "fields": [
        { "name": "title", "type": "text", "required": true },
        { "name": "description", "type": "textarea" }
      ]
    }
  }
}
```

---

## 📋 5. Checklist de entrega

**Backend:**
- [ ] Crear estructura del módulo en `modules/[NOMBRE]/`
- [ ] Definir `module.json` con todas las APIs
- [ ] Implementar clase principal en `index.js`
- [ ] Validar input con schemas (ValidationManager)
- [ ] Manejar errores con try/catch en todos los handlers
- [ ] Publicar eventos en operaciones clave
- [ ] Registrar métricas (creaciones, actualizaciones, errores)
- [ ] No retornar datos sensibles en responses
- [ ] Probar todas las APIs con `curl`
- [ ] Documentar en `README.md` con ejemplos

**UI (opcional):**
- [ ] Definir sección `ui` en `module.json`
- [ ] Probar la UI en `/ui`
- [ ] Validar vistas autogeneradas (table, form, detail)

**Seguridad:**
- [ ] Sanitizar todo input del usuario
- [ ] Implementar autenticación si es necesario
- [ ] Validar permisos en endpoints protegidos
- [ ] No loggear información sensible

---

## 🧾 6. Ejemplo de `module.json` (TODO List)

```json
{
  "name": "todo-list",
  "version": "1.0.0",
  "description": "Simple TODO list manager with CRUD operations",
  "main": "index.js",
  "apis": [
    {
      "method": "GET",
      "path": "/todos",
      "handler": "handleListTodos",
      "description": "List all todos"
    },
    {
      "method": "POST",
      "path": "/todos",
      "handler": "handleCreateTodo",
      "description": "Create a new todo",
      "schemas": {
        "request": {
          "body": {
            "type": "object",
            "required": ["title"],
            "properties": {
              "title": { "type": "string", "minLength": 1, "maxLength": 200 },
              "description": { "type": "string", "maxLength": 1000 }
            }
          }
        }
      }
    },
    {
      "method": "GET",
      "path": "/todos/:id",
      "handler": "handleGetTodo",
      "description": "Get a todo by ID"
    },
    {
      "method": "PUT",
      "path": "/todos/:id",
      "handler": "handleUpdateTodo",
      "description": "Update a todo"
    },
    {
      "method": "DELETE",
      "path": "/todos/:id",
      "handler": "handleDeleteTodo",
      "description": "Delete a todo"
    },
    {
      "method": "POST",
      "path": "/todos/:id/complete",
      "handler": "handleCompleteTodo",
      "description": "Mark a todo as completed"
    }
  ],
  "events": {
    "publishes": [
      "todo.created",
      "todo.updated",
      "todo.deleted",
      "todo.completed"
    ],
    "subscribes": []
  },
  "config": {
    "maxTodos": 1000
  }
}
```

---

## 🧾 7. Ejemplo de `index.js` (estructura mínima)

```javascript
class TodoListModule {
  constructor() {
    this.name = 'todo-list';
    this.todos = new Map();
    this.nextId = 1;
  }

  async onLoad(moduleAPI) {
    this.logger = moduleAPI.logger;
    this.eventBus = moduleAPI.eventBus;
    this.metrics = moduleAPI.metrics;
    this.config = moduleAPI.config || {};

    this.logger.info('module.loaded', {
      module: this.name,
      version: '1.0.0'
    });
  }

  async onUnload() {
    this.logger.info('module.unloaded', {
      module: this.name,
      todosCount: this.todos.size
    });
    this.todos.clear();
  }

  async handleListTodos(req, context) {
    try {
      const todos = Array.from(this.todos.values());
      this.logger.info('todo.list', { count: todos.length });
      return { status: 200, data: { todos, total: todos.length } };
    } catch (error) {
      this.logger.error('todo.list.error', { error: error.message });
      throw error;
    }
  }

  async handleCreateTodo(req, context) {
    const startTime = Date.now();
    try {
      const { title, description = '' } = context.body;

      const todo = {
        id: this.nextId++,
        title,
        description,
        completed: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      this.todos.set(todo.id, todo);

      await this.eventBus.publish('todo.created', {
        todoId: todo.id,
        title: todo.title
      }, {
        correlationId: context.correlationId
      });

      this.metrics.increment('todo.created.total');
      this.metrics.timing('todo.create.duration', Date.now() - startTime);

      this.logger.info('todo.created', {
        todoId: todo.id,
        correlationId: context.correlationId
      });

      return { status: 201, data: todo };
    } catch (error) {
      this.logger.error('todo.create.error', { error: error.message });
      this.metrics.increment('todo.create.errors');
      throw error;
    }
  }

  // Implementar resto de handlers...
}

module.exports = TodoListModule;
```

---

## ⚡ 8. Ejemplo de pruebas con `curl`

```bash
# 1. Listar todos (inicialmente vacío)
curl http://localhost:3000/modules/todo-list/todos

# 2. Crear un TODO
curl -X POST http://localhost:3000/modules/todo-list/todos \
  -H "Content-Type: application/json" \
  -d '{"title": "Comprar leche", "description": "Ir al supermercado"}'

# 3. Crear otro TODO
curl -X POST http://localhost:3000/modules/todo-list/todos \
  -H "Content-Type: application/json" \
  -d '{"title": "Estudiar Event Core", "description": "Leer la documentación"}'

# 4. Listar todos
curl http://localhost:3000/modules/todo-list/todos

# 5. Obtener TODO específico
curl http://localhost:3000/modules/todo-list/todos/1

# 6. Actualizar TODO
curl -X PUT http://localhost:3000/modules/todo-list/todos/1 \
  -H "Content-Type: application/json" \
  -d '{"title": "Comprar leche y pan"}'

# 7. Marcar como completado
curl -X POST http://localhost:3000/modules/todo-list/todos/1/complete

# 8. Eliminar TODO
curl -X DELETE http://localhost:3000/modules/todo-list/todos/2

# 9. Verificar estado final
curl http://localhost:3000/modules/todo-list/todos
```

---

## 📦 9. Convenciones del Agente Núcleo

- Carpeta raíz del proyecto: `/event-core/`
- Módulos en: `/event-core/modules/[NOMBRE_MODULO]/`
- Nombres de archivo: usar kebab-case (`todo-list`, `user-management`)
- Clases: usar PascalCase (`TodoListModule`, `UserManagementModule`)
- Eventos: usar dot notation (`todo.created`, `user.login`)
- Métricas: usar dot notation (`todo.created.total`, `request.duration`)
- Logging: JSON estructurado con correlationId obligatorio
- Versionado: seguir semver (`1.0.0`, `1.1.0`, `2.0.0`)

---

## 🧭 10. Formato de salida esperado

Debes retornar:

1. **Resumen ejecutivo**
   - Nombre del módulo creado
   - Funcionalidades implementadas
   - Endpoints disponibles (tabla con método, path, descripción)

2. **Lista de archivos creados**
   - Ruta completa de cada archivo
   - Propósito del archivo
   - Número de líneas aproximado

3. **Contenido completo de archivos**
   - `module.json` completo
   - `index.js` completo con todos los handlers
   - `README.md` con documentación

4. **Eventos publicados**
   - Lista de eventos con descripción
   - Payload de ejemplo de cada evento

5. **Métricas registradas**
   - Lista de métricas con tipo (counter, gauge, timing)
   - Descripción de cada métrica

6. **Instrucciones de prueba**
   - Comandos `curl` para probar cada endpoint
   - Respuestas esperadas

7. **Checklist de verificación completado**
   - Marcar cada ítem del checklist como ✅ o ❌

---

## 🧩 11. Reglas operativas

- **No omitir ninguna sección** del checklist de entrega
- **Si falta información del usuario**, proponer un valor razonable y documentarlo
- **Mantener consistencia** con la arquitectura Event Core existente
- **No modificar** la estructura base del sistema (core, config, etc.)
- **Optimizar para**:
  - ✅ Claridad (código legible y bien comentado)
  - ✅ Trazabilidad (logs estructurados con correlationId)
  - ✅ Mantenibilidad (código modular y documentado)
  - ✅ Seguridad (validación, sanitización, no exponer datos sensibles)
- **Usar siempre async/await** para operaciones asíncronas
- **Implementar manejo de errores** en todos los handlers
- **Documentar todo el código** con JSDoc cuando sea complejo

---

## 🔄 12. Capa de Consolidación (al finalizar)

Al completar la implementación, incluir:

### **Estado del módulo**
- ✅ Completo
- ⚠️ Parcial (indicar qué falta)
- ❌ Bloqueado (indicar bloqueante)

### **Pendientes o mejoras futuras**
- Tests unitarios
- Persistencia en base de datos
- UI JSON-Driven
- Rate limiting
- Caché de respuestas
- Documentación OpenAPI/Swagger

### **Próximos pasos sugeridos**
- Integración con otros módulos
- Despliegue en producción
- Monitoreo y alertas
- Optimizaciones de performance

### **Métricas de implementación**
- Total de líneas de código
- Número de endpoints
- Número de eventos
- Cobertura de tests (si aplica)
- Story Points completados

---

**Versión del prompt:** 1.0.0
**Fecha:** 2025-01-14
**Compatible con:** Event Core v0.5.0+
