# Log Manager Module v2.0

Sistema centralizado de logs **por sesión de arranque**. Cada vez que el core arranca, se crea una nueva sesión con logs organizados por módulo.

## Estructura de Logs

```
data/logs/
├── sessions/                              # Logs por sesión
│   └── 2025-01-14_10-30-00_abc123/       # Una sesión
│       ├── session.json                   # Metadata
│       └── modules/
│           ├── conversation-manager.jsonl
│           ├── ai-gateway.jsonl
│           ├── project-manager.jsonl
│           └── ...
└── current.jsonl                          # Logs consolidados
```

## Configuración

En `module.json`:

```json
{
  "config": {
    "logsPath": "./data/logs",
    "trackedModules": ["*"],              // '*' = todos, o lista específica
    "excludedModules": ["log-manager"],   // Módulos a excluir
    "sessionRetentionDays": 7,            // Días a conservar sesiones
    "retentionDays": 30                   // Días para logs consolidados
  }
}
```

### Trackear módulos específicos

Para debuggear el chat, configura solo los módulos relevantes:

```json
{
  "trackedModules": [
    "conversation-manager",
    "ai-gateway",
    "prompt-manager",
    "tool-orchestrator",
    "project-manager",
    "credential-manager",
    "database-manager",
    "storage-manager",
    "calling-generator"
  ]
}
```

## APIs

### Sesión Actual

```bash
# Info de la sesión actual
GET /modules/log-manager/api/session

# Módulos con logs en esta sesión
GET /modules/log-manager/api/session/modules

# Logs de un módulo específico
GET /modules/log-manager/api/session/modules/ai-gateway/logs
GET /modules/log-manager/api/session/modules/conversation-manager/logs?level=error

# Configurar tracking dinámicamente
PUT /modules/log-manager/api/session/track
{ "modules": ["conversation-manager", "ai-gateway"] }

# Añadir módulos al tracking
POST /modules/log-manager/api/session/track/add
{ "modules": ["prompt-manager"] }
```

### Historial de Sesiones

```bash
# Listar todas las sesiones
GET /modules/log-manager/api/sessions

# Info de una sesión específica
GET /modules/log-manager/api/sessions/2025-01-14_10-30-00_abc123

# Logs de una sesión
GET /modules/log-manager/api/sessions/2025-01-14_10-30-00_abc123/logs
GET /modules/log-manager/api/sessions/2025-01-14_10-30-00_abc123/logs?module=ai-gateway
```

### Logs Consolidados

```bash
# Logs con filtros
GET /modules/log-manager/api/logs?level=error&module=ai-gateway

# Agregar log (frontend)
POST /modules/log-manager/api/logs
{ "level": "error", "module": "chat-ui", "msg": "send.failed", "ctx": {} }

# Estadísticas
GET /modules/log-manager/api/stats
```

## Para la IA

### Leer logs de la sesión actual

```bash
# Ver todos los módulos con logs
cat data/logs/sessions/*/session.json | jq .

# Logs de conversation-manager
cat data/logs/sessions/2025-01-14_*/modules/conversation-manager.jsonl

# Buscar errores en ai-gateway
grep '"level":"error"' data/logs/sessions/*/modules/ai-gateway.jsonl

# Últimos 20 logs de un módulo
tail -20 data/logs/sessions/$(ls -t data/logs/sessions | head -1)/modules/ai-gateway.jsonl
```

### Formato de entrada (JSONL)

```json
{"ts":"2025-01-14T10:00:01.123Z","level":"info","source":"backend","module":"ai-gateway","msg":"request.sent","ctx":{"provider":"anthropic","model":"claude-3"}}
```

## Flujo de Debug del Chat

Para debuggear una conversación, revisa los logs en este orden:

1. **conversation-manager** - Inicio del mensaje, contexto
2. **prompt-manager** - Prompt construido
3. **ai-gateway** - Request/Response al LLM
4. **tool-orchestrator** - Si hay tool calls
5. **calling-generator** - Generación de function calls
6. **database-manager** - Operaciones DB
7. **storage-manager** - Archivos adjuntos
