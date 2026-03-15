# Módulo Calling Generator

**Generador de funciones ejecutables desde definiciones de plugins con soporte HTTP y event-based**

## 🎯 Propósito

Convierte definiciones de funciones en plugins JSON en funciones JavaScript ejecutables que pueden:
- Realizar llamadas HTTP a APIs externas
- Ejecutar funciones locales via eventos
- Registrarse automáticamente en tool-orchestrator
- Manejar autenticación (Bearer, API Key, Basic Auth)

---

## 🔧 Tipos de Funciones Soportadas

### 1. HTTP Functions
Funciones que hacen llamadas HTTP a APIs externas.

**Métodos soportados:** GET, POST, PUT, DELETE, PATCH

**Ejemplo de definición:**
```json
{
  "get_weather": {
    "method": "GET",
    "endpoint": "/weather/{city}",
    "description": "Get weather for a city",
    "parameters": {
      "type": "object",
      "required": ["city"],
      "properties": {
        "city": { "type": "string" }
      }
    }
  }
}
```

### 2. Local Event-based Functions
Funciones que se ejecutan via eventos internos.

**Ejemplo de definición:**
```json
{
  "process_data": {
    "method": "local_function",
    "event_topic": "mymodule.process.request",
    "description": "Process data locally",
    "parameters": {
      "type": "object",
      "required": ["data"],
      "properties": {
        "data": { "type": "string" }
      }
    }
  }
}
```

---

## 📦 Eventos Publicados

### `function.generated`
Función generada desde plugin.

```json
{
  "event_type": "function.generated",
  "payload": {
    "full_name": "weather-api.get_weather",
    "plugin_name": "weather-api",
    "function_name": "get_weather",
    "type": "http",
    "generated_at": "2024-01-15T10:30:00.000Z"
  }
}
```

### `function.executed`
Función ejecutada exitosamente.

```json
{
  "event_type": "function.executed",
  "payload": {
    "full_name": "weather-api.get_weather",
    "duration": 245,
    "has_result": true,
    "executed_at": "2024-01-15T10:30:00.000Z"
  }
}
```

### `function.failed`
Ejecución de función falló.

```json
{
  "event_type": "function.failed",
  "payload": {
    "full_name": "weather-api.get_weather",
    "error": "HTTP 404: Not Found",
    "reason": "http_error",
    "failed_at": "2024-01-15T10:30:00.000Z"
  }
}
```

**Razones de fallo:**
- `timeout` - Timeout en ejecución
- `http_error` - Error HTTP (4xx, 5xx)
- `network_error` - Error de red
- `module_error` - Error en módulo local
- `validation_error` - Argumentos inválidos

### `function.generation.error`
Error al generar función desde plugin.

```json
{
  "event_type": "function.generation.error",
  "payload": {
    "plugin_name": "weather-api",
    "function_name": "get_weather",
    "error": "Invalid endpoint definition"
  }
}
```

---

## 📡 Eventos Suscritos

### `plugin.loaded`
Genera funciones cuando se carga un plugin.

```json
{
  "name": "weather-api",
  "definition": {
    "metadata": {
      "name": "weather-api",
      "base_url": "https://api.weather.com",
      "auth_type": "bearer"
    },
    "functions": {
      "get_weather": { ... }
    }
  }
}
```

### `function.get.request`
Obtener metadata de función.

```json
{
  "name": "weather-api.get_weather",
  "request_id": "req_123",
  "correlation_id": "uuid"
}
```

### `function.list.request`
Listar funciones generadas.

```json
{
  "request_id": "req_456",
  "correlation_id": "uuid"
}
```

### `function.execute.request`
Ejecutar función.

```json
{
  "name": "weather-api.get_weather",
  "args": {
    "city": "London"
  },
  "request_id": "req_789",
  "correlation_id": "uuid"
}
```

---

## 🔌 APIs HTTP

| Método | Path | Descripción |
|--------|------|-------------|
| GET | `/functions` | Listar funciones generadas |
| GET | `/functions/:name` | Obtener metadata de función |
| POST | `/functions/:name/execute` | Ejecutar función |
| GET | `/health` | Health check |
| GET | `/metrics` | Métricas |

---

## 🧪 Ejemplos de Uso

### Listar funciones generadas
```bash
curl http://localhost:3000/modules/calling-generator/functions
```

**Respuesta:**
```json
{
  "success": true,
  "functions": [
    {
      "full_name": "weather-api.get_weather",
      "plugin_name": "weather-api",
      "function_name": "get_weather",
      "type": "http",
      "description": "Get weather for a city",
      "method": "GET",
      "endpoint": "/weather/{city}"
    }
  ],
  "count": 1
}
```

### Obtener metadata de función
```bash
curl http://localhost:3000/modules/calling-generator/functions/weather-api.get_weather
```

**Respuesta:**
```json
{
  "success": true,
  "function": {
    "full_name": "weather-api.get_weather",
    "plugin_name": "weather-api",
    "function_name": "get_weather",
    "type": "http",
    "description": "Get weather for a city",
    "parameters": {
      "type": "object",
      "required": ["city"],
      "properties": {
        "city": { "type": "string" }
      }
    },
    "method": "GET",
    "endpoint": "/weather/{city}"
  }
}
```

### Ejecutar función
```bash
curl -X POST http://localhost:3000/modules/calling-generator/functions/weather-api.get_weather/execute \
  -H "Content-Type: application/json" \
  -d '{
    "args": {
      "city": "London"
    }
  }'
```

**Respuesta exitosa:**
```json
{
  "success": true,
  "result": {
    "data": {
      "city": "London",
      "temperature": 15,
      "condition": "Cloudy"
    },
    "status_code": 200
  },
  "duration": 245
}
```

**Respuesta con error:**
```json
{
  "success": false,
  "error": "HTTP 404: City not found"
}
```

---

## 🔐 Autenticación

### Tipos de Autenticación Soportados

#### 1. Bearer Token
```json
{
  "metadata": {
    "auth_type": "bearer"
  }
}
```

Variable de entorno: `{PLUGIN_NAME}_API_KEY`

Header generado: `Authorization: Bearer {API_KEY}`

#### 2. API Key en Header
```json
{
  "metadata": {
    "auth_type": "api_key_header",
    "auth_header_name": "X-API-Key"
  }
}
```

Variable de entorno: `{PLUGIN_NAME}_API_KEY`

Header generado: `X-API-Key: {API_KEY}`

#### 3. API Key en Query Parameter
```json
{
  "metadata": {
    "auth_type": "api_key_query",
    "auth_query_param_name": "apiKey"
  }
}
```

Variable de entorno: `{PLUGIN_NAME}_API_KEY`

URL generada: `https://api.example.com/endpoint?apiKey={API_KEY}`

#### 4. Basic Auth
```json
{
  "metadata": {
    "auth_type": "basic_auth"
  }
}
```

Variables de entorno:
- `{PLUGIN_NAME}_AUTH_USER`
- `{PLUGIN_NAME}_AUTH_PASS`

Header generado: `Authorization: Basic {base64(user:pass)}`

#### 5. Sin Autenticación
```json
{
  "metadata": {
    "auth_type": "none"
  }
}
```

---

## 🔄 Ejemplo de Plugin Completo

### Archivo: `plugins/weather-api.functions.json`

```json
{
  "metadata": {
    "name": "weather-api",
    "version": "1.0.0",
    "description": "Weather API plugin",
    "base_url": "https://api.weather.com/v1",
    "auth_type": "api_key_header",
    "auth_header_name": "X-Weather-API-Key"
  },
  "functions": {
    "get_weather": {
      "method": "GET",
      "endpoint": "/weather/{city}",
      "description": "Get current weather for a city",
      "parameters": {
        "type": "object",
        "required": ["city"],
        "properties": {
          "city": {
            "type": "string",
            "description": "City name"
          },
          "units": {
            "type": "string",
            "enum": ["metric", "imperial"],
            "description": "Temperature units"
          }
        }
      }
    },
    "get_forecast": {
      "method": "GET",
      "endpoint": "/forecast/{city}",
      "description": "Get 7-day forecast",
      "parameters": {
        "type": "object",
        "required": ["city"],
        "properties": {
          "city": { "type": "string" },
          "days": {
            "type": "integer",
            "minimum": 1,
            "maximum": 7,
            "default": 7
          }
        }
      }
    }
  }
}
```

### Configurar API Key

```bash
export WEATHER_API_API_KEY="your-api-key-here"
```

### Usar las funciones generadas

```bash
# Via HTTP API
curl -X POST http://localhost:3000/modules/calling-generator/functions/weather-api.get_weather/execute \
  -H "Content-Type: application/json" \
  -d '{ "args": { "city": "London", "units": "metric" } }'

# Via eventos
{
  "event_type": "function.execute.request",
  "payload": {
    "name": "weather-api.get_weather",
    "args": { "city": "London", "units": "metric" },
    "request_id": "req_123"
  }
}
```

---

## 🔄 Integración con Tool Orchestrator

Cuando `registerWithToolOrchestrator: true` (default), las funciones generadas se registran automáticamente como tools:

```javascript
// Las funciones están disponibles en tool-orchestrator
await toolOrchestrator.callTool('weather-api.get_weather', {
  city: 'London'
});
```

---

## 📊 Métricas

### Counters
- `function.generated.total` - Funciones generadas
- `function.executed.total` - Ejecuciones exitosas
- `function.failed.total` - Ejecuciones fallidas
- `function.http_call.total` - Llamadas HTTP totales
- `function.http_call.success` - Llamadas HTTP exitosas
- `function.http_call.error` - Llamadas HTTP fallidas
- `function.local_call.total` - Llamadas locales totales
- `function.local_call.success` - Llamadas locales exitosas
- `function.local_call.error` - Llamadas locales fallidas

### Gauges
- `function.count` - Funciones actualmente generadas
- `function.plugins.count` - Plugins con funciones generadas

### Timings
- `function.generation.duration` - Tiempo de generación
- `function.execution.duration` - Tiempo de ejecución
- `function.http_call.duration` - Tiempo de llamada HTTP

---

## ⚙️ Configuración

```json
{
  "localFunctionTimeout": 5000,
  "httpTimeout": 30000,
  "maxRetries": 3,
  "retryDelay": 1000,
  "registerWithToolOrchestrator": true
}
```

| Config | Descripción | Default |
|--------|-------------|---------|
| `localFunctionTimeout` | Timeout para funciones locales (ms) | `5000` |
| `httpTimeout` | Timeout para llamadas HTTP (ms) | `30000` |
| `maxRetries` | Reintentos en caso de error | `3` |
| `retryDelay` | Delay entre reintentos (ms) | `1000` |
| `registerWithToolOrchestrator` | Registrar en tool-orchestrator | `true` |

---

## 🎯 Casos de Uso

1. **API Wrappers** - Envolver APIs externas en funciones reutilizables
2. **Multi-API Integration** - Integrar múltiples APIs desde plugins
3. **Tool Ecosystem** - Crear ecosistema de herramientas para AI agents
4. **Microservices** - Llamar microservices via funciones generadas
5. **Hybrid Execution** - Mezclar llamadas HTTP y funciones locales

---

## 🔍 Parámetros en URLs

Los parámetros se pueden pasar de 3 formas:

### 1. Path Parameters
```json
{
  "endpoint": "/weather/{city}"
}
```

Args: `{ "city": "London" }`

URL generada: `/weather/London`

### 2. Query Parameters (GET)
```json
{
  "method": "GET",
  "endpoint": "/weather"
}
```

Args: `{ "city": "London", "units": "metric" }`

URL generada: `/weather?city=London&units=metric`

### 3. Request Body (POST/PUT/PATCH)
```json
{
  "method": "POST",
  "endpoint": "/weather/search"
}
```

Args: `{ "city": "London", "units": "metric" }`

Body enviado: `{ "city": "London", "units": "metric" }`

---

## ⚠️ Consideraciones

1. **API Keys**: Las API keys deben configurarse como variables de entorno con el formato `{PLUGIN_NAME}_API_KEY`.
2. **Timeout**: Si una función HTTP tarda más de `httpTimeout`, se cancelará automáticamente.
3. **Funciones Locales**: Las funciones `local_function` requieren que otro módulo esté escuchando el evento especificado.
4. **Tool Orchestrator**: Si `registerWithToolOrchestrator: false`, las funciones NO estarán disponibles para AI agents.
5. **Error Handling**: Los errores HTTP (4xx, 5xx) se propagan como excepciones.
