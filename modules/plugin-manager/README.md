# Módulo Plugin Manager

**Descubrimiento y gestión de plugins JSON con definiciones de funciones**

## 🔌 Estructura de Plugin

Los plugins se almacenan en `plugins/` y deben tener un archivo `.functions.json`:

```
plugins/
├── math-tools/
│   └── math.functions.json
├── text-utils/
│   └── text.functions.json
└── api-helpers/
    └── api.functions.json
```

### Formato de Plugin

```json
{
  "metadata": {
    "name": "math-tools",
    "version": "1.0.0",
    "description": "Mathematical utility functions",
    "author": "Aichat Team"
  },
  "functions": {
    "calculate_sum": {
      "description": "Sum two numbers",
      "parameters": {
        "type": "object",
        "required": ["a", "b"],
        "properties": {
          "a": { "type": "number" },
          "b": { "type": "number" }
        }
      },
      "returns": {
        "type": "number"
      }
    },
    "calculate_average": {
      "description": "Calculate average of numbers",
      "parameters": {
        "type": "object",
        "required": ["numbers"],
        "properties": {
          "numbers": {
            "type": "array",
            "items": { "type": "number" }
          }
        }
      },
      "returns": {
        "type": "number"
      }
    }
  }
}
```

---

## 📦 Eventos Publicados

### `plugin.loaded`
Plugin cargado exitosamente.

```json
{
  "event_type": "plugin.loaded",
  "payload": {
    "name": "math-tools",
    "version": "1.0.0",
    "description": "Mathematical utility functions",
    "functions": ["calculate_sum", "calculate_average"],
    "function_count": 2,
    "loaded_at": "2024-01-15T10:30:00.000Z"
  }
}
```

### `plugin.unloaded`
Plugin descargado.

```json
{
  "event_type": "plugin.unloaded",
  "payload": {
    "name": "math-tools",
    "unloaded_at": "2024-01-15T10:30:00.000Z"
  }
}
```

### `plugin.error`
Error al cargar plugin.

```json
{
  "event_type": "plugin.error",
  "payload": {
    "file": "/path/to/plugin.functions.json",
    "error": "Invalid JSON syntax",
    "context": "load"
  }
}
```

### `plugin.reloaded`
Todos los plugins recargados.

```json
{
  "event_type": "plugin.reloaded",
  "payload": {
    "count": 5,
    "loaded": 5,
    "errors": 0,
    "reloaded_at": "2024-01-15T10:30:00.000Z"
  }
}
```

### `plugin.get.response`
Respuesta a solicitud de plugin vía eventos.

```json
{
  "event_type": "plugin.get.response",
  "payload": {
    "request_id": "req_123",
    "success": true,
    "plugin": { ... }
  }
}
```

### `plugin.list.response`
Respuesta a solicitud de lista de plugins.

```json
{
  "event_type": "plugin.list.response",
  "payload": {
    "request_id": "req_456",
    "success": true,
    "plugins": [...],
    "count": 5
  }
}
```

---

## 📡 Eventos Suscritos

### `plugin.get.request`
Obtener definición de plugin por nombre.

```json
{
  "name": "math-tools",
  "request_id": "req_123",
  "correlation_id": "uuid"
}
```

### `plugin.list.request`
Listar todos los plugins cargados.

```json
{
  "request_id": "req_456",
  "correlation_id": "uuid"
}
```

---

## 🔌 APIs HTTP

| Método | Path | Descripción |
|--------|------|-------------|
| GET | `/plugins/:name` | Obtener definición de plugin |
| GET | `/plugins` | Listar todos los plugins |
| POST | `/plugins/reload` | Recargar plugins desde disco |
| GET | `/health` | Health check |
| GET | `/metrics` | Métricas |

---

## 🧪 Ejemplos de Uso

### Listar plugins
```bash
curl http://localhost:3000/modules/plugin-manager/plugins
```

**Respuesta:**
```json
{
  "success": true,
  "plugins": [
    {
      "name": "math-tools",
      "version": "1.0.0",
      "description": "Mathematical utility functions",
      "functions": ["calculate_sum", "calculate_average"],
      "function_count": 2
    },
    {
      "name": "text-utils",
      "version": "1.0.0",
      "description": "Text manipulation functions",
      "functions": ["to_uppercase", "word_count"],
      "function_count": 2
    }
  ],
  "count": 2,
  "total_functions": 4
}
```

### Obtener plugin específico
```bash
curl http://localhost:3000/modules/plugin-manager/plugins/math-tools
```

### Recargar plugins
```bash
curl -X POST http://localhost:3000/modules/plugin-manager/plugins/reload
```

---

## 🔄 Uso desde Otros Módulos (Event-Driven)

### Obtener plugin vía eventos
```javascript
// En ai-agent-framework
async getPluginDefinition(pluginName, correlationId) {
  const requestId = `plugin_${Date.now()}`;

  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);

    const unsubscribe = this.eventBus.on('plugin.get.response', (event) => {
      if (event.payload.request_id === requestId) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(event.payload);
      }
    });
  });

  await this.eventBus.publish('plugin.get.request', {
    name: pluginName,
    request_id: requestId,
    correlation_id: correlationId
  });

  const response = await responsePromise;

  if (!response.success) {
    throw new Error(response.error);
  }

  return response.plugin;
}
```

### Listar plugins vía eventos
```javascript
async listAvailablePlugins(correlationId) {
  const requestId = `list_${Date.now()}`;

  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);

    const unsubscribe = this.eventBus.on('plugin.list.response', (event) => {
      if (event.payload.request_id === requestId) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(event.payload);
      }
    });
  });

  await this.eventBus.publish('plugin.list.request', {
    request_id: requestId,
    correlation_id: correlationId
  });

  return await responsePromise;
}
```

---

## 🔧 Auto-Reload

El módulo puede monitorear cambios en el directorio de plugins:

```json
{
  "autoReload": true,
  "watchInterval": 5000
}
```

Cuando está activado:
- Escanea el directorio cada `watchInterval` ms
- Carga nuevos plugins automáticamente
- Publica eventos `plugin.loaded` por cada nuevo plugin

---

## 📊 Métricas

### Counters
- `plugin.loaded.total` - Total de plugins cargados
- `plugin.error.total` - Errores de carga
- `plugin.reload.total` - Recargas ejecutadas

### Gauges
- `plugin.count` - Plugins actualmente cargados
- `plugin.functions.count` - Total de funciones disponibles

### Timings
- `plugin.discovery.duration` - Tiempo de descubrimiento
- `plugin.load.duration` - Tiempo de carga individual

---

## ⚙️ Configuración

```json
{
  "pluginsPath": "../../plugins",
  "autoReload": false,
  "watchInterval": 5000,
  "validateSchema": true
}
```

---

## 🎯 Casos de Uso

1. **AI Agent Framework** - Descubrir funciones disponibles para agentes
2. **Tool Orchestrator** - Obtener definiciones de herramientas
3. **Code Generation** - Generar código basado en schemas de funciones
4. **API Documentation** - Auto-documentar funciones disponibles
