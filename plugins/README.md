# Event Core - Universal Plugin System

Sistema de plugins JSON para agregar herramientas infinitas a Event Core sin tocar código.

## 🎯 Arquitectura

```
plugins/                    Plugin Manager          Calling Generator        Tool Orchestrator
  github/                  ↓                       ↓                        ↓
    github.functions.json  → Carga definición  →  Genera funciones    →   Registra tools
  slack/                   ↓                       ↓                        ↓
    slack.functions.json   → Valida estructura →  HTTP/Local ejecutables → Valida con AJV
  weather/                 ↓                       ↓                        ↓
    weather.functions.json → Publica evento    →  Maneja auth         →   Ejecuta tools
                                                                            ↓
                                                                     AI Agent Framework
                                                                            ↓
                                                                    Agents usan tools
```

## 📦 Estructura de un Plugin

Cada plugin es un directorio con un archivo `<name>.functions.json`:

```
plugins/
└── github/
    └── github.functions.json
```

### Formato del JSON

```json
{
  "metadata": {
    "name": "github",
    "version": "1.0.0",
    "description": "GitHub API integration",
    "base_url": "https://api.github.com",
    "auth_type": "bearer",
    "auth_header_name": "Authorization",
    "documentation": "https://docs.github.com/en/rest"
  },
  "functions": {
    "create_issue": {
      "method": "POST",
      "endpoint": "/repos/{owner}/{repo}/issues",
      "description": "Create a new issue",
      "parameters": {
        "type": "object",
        "properties": {
          "owner": { "type": "string", "description": "Repository owner" },
          "repo": { "type": "string", "description": "Repository name" },
          "title": { "type": "string", "description": "Issue title" },
          "body": { "type": "string", "description": "Issue body" }
        },
        "required": ["owner", "repo", "title"]
      }
    }
  }
}
```

## 🔐 Tipos de Autenticación

### Bearer Token
```json
{
  "metadata": {
    "auth_type": "bearer"
  }
}
```
Env var: `<PLUGIN_NAME>_API_KEY`

Ejemplo: `GITHUB_API_KEY=ghp_xxxxx`

### API Key en Header
```json
{
  "metadata": {
    "auth_type": "api_key_header",
    "auth_header_name": "X-API-Key"
  }
}
```
Env var: `<PLUGIN_NAME>_API_KEY`

### API Key en Query
```json
{
  "metadata": {
    "auth_type": "api_key_query",
    "auth_query_param_name": "appid"
  }
}
```
Env var: `<PLUGIN_NAME>_API_KEY`

Ejemplo: `WEATHER_API_KEY=abc123`

### Basic Auth
```json
{
  "metadata": {
    "auth_type": "basic_auth"
  }
}
```
Env vars:
- `<PLUGIN_NAME>_AUTH_USER`
- `<PLUGIN_NAME>_AUTH_PASS`

### Sin Autenticación
```json
{
  "metadata": {
    "auth_type": "none"
  }
}
```

## 🔧 Métodos HTTP Soportados

### GET
```json
{
  "method": "GET",
  "endpoint": "/weather",
  "parameters": {
    "properties": {
      "city": { "type": "string" }
    }
  }
}
```

### POST / PUT / PATCH
```json
{
  "method": "POST",
  "endpoint": "/repos/{owner}/{repo}/issues",
  "parameters": {
    "properties": {
      "owner": { "type": "string" },
      "title": { "type": "string" },
      "body": { "type": "string" }
    }
  }
}
```

Body se genera automáticamente de los parámetros.

### Path Parameters
Usar `{paramName}` en el endpoint:
```json
{
  "endpoint": "/repos/{owner}/{repo}/issues"
}
```

### Query Parameters
En GET, todos los parámetros van como query string automáticamente.

## 🚀 Funciones Locales

Para funciones que no son HTTP calls, sino que se ejecutan localmente vía eventos:

```json
{
  "method": "local_function",
  "event_topic": "myplugin.process.request",
  "description": "Process data locally",
  "parameters": {
    "properties": {
      "data": { "type": "object" }
    }
  }
}
```

El módulo que implementa la función debe suscribirse al `event_topic` y responder:

```javascript
eventBus.subscribe('myplugin.process.request', (event) => {
  const { requestId, args, respondTo } = event;

  // Process args
  const result = processData(args.data);

  // Respond
  eventBus.publish(respondTo, {
    success: true,
    result: result
  });
});
```

## 📚 Plugins Incluidos

### GitHub (`plugins/github/`)
- `github.create_issue` - Create issue
- `github.create_comment` - Comment on issue/PR
- `github.get_repository` - Get repo info
- `github.list_issues` - List issues
- `github.create_pull_request` - Create PR

**Env var**: `GITHUB_API_KEY=ghp_xxxxx`

### Slack (`plugins/slack/`)
- `slack.send_message` - Send message to channel
- `slack.create_channel` - Create channel
- `slack.invite_user` - Invite user to channel
- `slack.upload_file` - Upload file
- `slack.get_channel_info` - Get channel info

**Env var**: `SLACK_API_KEY=xoxb-xxxxx`

### Weather (`plugins/weather/`)
- `weather.get_current_weather` - Current weather
- `weather.get_forecast` - 5-day forecast
- `weather.get_air_pollution` - Air quality

**Env var**: `WEATHER_API_KEY=abc123`

### HTTP Utils (`plugins/http-utils/`)
- `http.get_request` - Generic GET
- `http.post_request` - Generic POST
- `http.webhook_call` - Call webhook

**Env var**: None (no auth)

## 🤖 Uso desde AI Agents

Los agentes pueden llamar herramientas automáticamente:

```javascript
const agent = new Agent({
  prompt_id: "github-manager",
  tools: [
    "github.create_issue",
    "github.create_comment",
    "slack.send_message"
  ]
});

await agent.execute({
  event_type: "bug.detected",
  payload: { error: "NullPointerException", file: "auth.js" }
});
```

El agente decide cuándo y cómo usar las herramientas basándose en el prompt y el contexto.

## 📖 Crear un Nuevo Plugin

### 1. Crear directorio
```bash
mkdir -p plugins/mi-plugin
```

### 2. Crear definición JSON
```bash
cat > plugins/mi-plugin/mi-plugin.functions.json <<'EOF'
{
  "metadata": {
    "name": "mi-plugin",
    "version": "1.0.0",
    "description": "Mi API personalizada",
    "base_url": "https://api.mi-servicio.com",
    "auth_type": "bearer"
  },
  "functions": {
    "mi_funcion": {
      "method": "POST",
      "endpoint": "/api/action",
      "description": "Hace algo útil",
      "parameters": {
        "type": "object",
        "properties": {
          "data": {
            "type": "string",
            "description": "Datos a enviar"
          }
        },
        "required": ["data"]
      }
    }
  }
}
EOF
```

### 3. Configurar API key
```bash
export MI_PLUGIN_API_KEY=xxx
```

### 4. Reiniciar Event Core
El Plugin Manager cargará el nuevo plugin automáticamente.

### 5. Verificar carga
```bash
curl http://localhost:3000/modules/plugin-manager/plugins
```

### 6. Usar desde agent
```javascript
const agent = new Agent({
  tools: ["mi-plugin.mi_funcion"]
});
```

## 🔍 APIs HTTP del Sistema

### Plugin Manager

**GET** `/modules/plugin-manager/plugins`
Lista todos los plugins cargados

**GET** `/modules/plugin-manager/plugin/:name`
Obtiene un plugin específico

**POST** `/modules/plugin-manager/plugins/reload`
Recarga todos los plugins

### Tool Orchestrator

**GET** `/modules/tool-orchestrator/tools`
Lista todas las herramientas registradas

**GET** `/modules/tool-orchestrator/tool/:name`
Obtiene información de una herramienta

**POST** `/modules/tool-orchestrator/tool/:name/call`
Ejecuta una herramienta directamente via HTTP
```bash
curl -X POST http://localhost:3000/modules/tool-orchestrator/tool/github.create_issue/call \
  -H "Content-Type: application/json" \
  -d '{
    "owner": "user",
    "repo": "repo",
    "title": "Bug found",
    "body": "Description"
  }'
```

### Calling Generator

**GET** `/modules/calling-generator/functions`
Lista todas las funciones generadas

**GET** `/modules/calling-generator/function/:name`
Obtiene metadata de una función

## 🐛 Debugging

### Ver plugins cargados
```bash
curl http://localhost:3000/modules/plugin-manager/plugins | jq
```

### Ver herramientas registradas
```bash
curl http://localhost:3000/modules/tool-orchestrator/tools | jq
```

### Ver funciones generadas
```bash
curl http://localhost:3000/modules/calling-generator/functions | jq
```

### Test de herramienta
```bash
curl -X POST http://localhost:3000/modules/tool-orchestrator/tool/weather.get_current_weather/call \
  -H "Content-Type: application/json" \
  -d '{"q": "Madrid", "units": "metric"}'
```

### Logs
```bash
# Ver logs del Plugin Manager
grep "plugin-manager" logs/*.log

# Ver logs del Calling Generator
grep "calling-generator" logs/*.log

# Ver tool execution
grep "tool-manager.tool.executed" logs/*.log
```

## ⚙️ Configuración Avanzada

### Plugin Manager

```json
{
  "plugins_path": "../../plugins",
  "auto_reload": false,
  "watch_interval": 5000
}
```

### Tool Orchestrator

```json
{
  "validation_enabled": true,
  "timeout_ms": 30000,
  "max_retries": 0
}
```

### Calling Generator

```json
{
  "localFunctionTimeout": 5000,
  "httpTimeout": 30000,
  "maxRetries": 3,
  "retryDelay": 1000
}
```

## 🎯 Mejores Prácticas

1. **Nombres descriptivos**: Usa `plugin.action` format
2. **Validación estricta**: Define `required` en parameters
3. **Documentación**: Agrega `description` a todo
4. **Versionado**: Mantén `version` en metadata
5. **Secrets seguros**: NUNCA hardcodear API keys en JSON
6. **Timeout razonable**: Ajusta según la API
7. **Error handling**: Las funciones deben fallar gracefully

## 📊 Métricas

El sistema genera métricas automáticas:

- `plugins.loaded.total` - Plugins cargados
- `functions.generated.total` - Funciones generadas
- `tools.registered.total` - Tools registrados
- `tool.call.requests.total` - Llamadas totales
- `tool.call.success.total` - Llamadas exitosas
- `tool.call.failed.total` - Llamadas fallidas
- `tool.call.duration.ms` - Latencia de llamadas
- `calling_generator.http_call.*` - Métricas HTTP
- `calling_generator.local_call.*` - Métricas locales

## 🚦 Estado del Sistema

El sistema está **production-ready** con:

- ✅ 3 módulos core (Plugin Manager, Tool Orchestrator, Calling Generator)
- ✅ 4 plugins de ejemplo (GitHub, Slack, Weather, HTTP)
- ✅ 16+ herramientas listas para usar
- ✅ Integración completa con AI Agent Framework
- ✅ Validación JSON Schema
- ✅ Auth multi-proveedor
- ✅ Timeout y retry logic
- ✅ Métricas completas
- ✅ API HTTP para debugging

**Total**: 230 SP completados en el proyecto Event Core 🎉
