# Prompt Manager Module

Sistema de gestión de prompts con versionado, templates y analytics para Event Core.

## Features

✅ **CRUD completo** - Crear, leer, actualizar, eliminar prompts
✅ **Versionado semántico** - Cada cambio de contenido crea una nueva versión
✅ **Template system** - Variables {{variable}} con tipado
✅ **Analytics** - Tracking de uso, tokens, latency, cost
✅ **A/B Testing** - Comparar performance de prompts
✅ **Storage en filesystem** - JSON files en `data/prompts/`
✅ **Tag-based filtering** - Organiza prompts por tags
✅ **Search** - Busca en name, title, description

---

## API Endpoints

### Create Prompt
```http
POST /modules/prompt-manager/prompts
Content-Type: application/json

{
  "name": "code-reviewer",
  "title": "Code Reviewer Agent",
  "description": "Reviews code for best practices and bugs",
  "content": "Review this code:\n\n{{code}}\n\nLanguage: {{language}}",
  "variables": [
    {"name": "code", "type": "string", "required": true},
    {"name": "language", "type": "string", "required": true}
  ],
  "tags": ["code", "review"],
  "metadata": {
    "model": "deepseek-chat",
    "temperature": 0.3
  }
}
```

### List Prompts
```http
GET /modules/prompt-manager/prompts?tag=code&search=review
```

### Get Prompt
```http
GET /modules/prompt-manager/prompts/:id
```

### Update Prompt
```http
PUT /modules/prompt-manager/prompts/:id
Content-Type: application/json

{
  "content": "Updated prompt content",
  "description": "Updated description"
}
```

### Delete Prompt
```http
DELETE /modules/prompt-manager/prompts/:id
```

### List Versions
```http
GET /modules/prompt-manager/prompts/:id/versions
```

### Render Template
```http
POST /modules/prompt-manager/prompts/:id/render
Content-Type: application/json

{
  "variables": {
    "code": "function foo() { return 42; }",
    "language": "javascript"
  },
  "version": "1.0.0"
}
```

Response:
```json
{
  "prompt_id": "abc123",
  "version": "1.0.0",
  "rendered": "Review this code:\n\nfunction foo() { return 42; }\n\nLanguage: javascript",
  "variables_used": {
    "code": "function foo() { return 42; }",
    "language": "javascript"
  }
}
```

### Get Analytics
```http
GET /modules/prompt-manager/analytics?prompt_id=abc123&days=30
```

Response:
```json
{
  "analytics": [
    {
      "prompt_id": "abc123",
      "version": "1.0.0",
      "usage_count": 150,
      "total_tokens": 45000,
      "avg_tokens": 300,
      "total_latency_ms": 75000,
      "avg_latency_ms": 500,
      "total_cost": 0.45,
      "avg_cost": 0.003,
      "first_used": "2025-11-01T00:00:00Z",
      "last_used": "2025-11-12T12:00:00Z"
    }
  ],
  "total": 1
}
```

### Compare Prompts (A/B Testing)
```http
POST /modules/prompt-manager/prompts/compare
Content-Type: application/json

{
  "prompt_a_id": "abc123",
  "prompt_b_id": "def456",
  "metric": "usage_count"
}
```

---

## Configuration

Edit `modules/prompt-manager/module.json`:

```json
{
  "config": {
    "storage_path": "./data/prompts",
    "max_versions_per_prompt": 10,
    "enable_analytics": true,
    "analytics_retention_days": 90
  }
}
```

---

## Event Subscriptions

El módulo se suscribe a eventos de IA para registrar analytics automáticamente:

- `ai.completion.completed` - Registra tokens, latency, cost
- `ai.request.started` - Tracking de requests

---

## Prompt Structure

Cada prompt se almacena como:

```json
{
  "id": "abc123def456",
  "name": "code-reviewer",
  "title": "Code Reviewer Agent",
  "description": "Reviews code for best practices",
  "content": "Review this code:\n\n{{code}}",
  "variables": [
    {"name": "code", "type": "string", "required": true}
  ],
  "tags": ["code", "review"],
  "metadata": {
    "model": "deepseek-chat",
    "temperature": 0.3
  },
  "versions": [
    {
      "version": "1.0.0",
      "content": "Review this code:\n\n{{code}}",
      "variables": [...],
      "created_at": "2025-11-12T00:00:00Z",
      "created_by": "system"
    },
    {
      "version": "1.0.1",
      "content": "Review this code carefully:\n\n{{code}}",
      "variables": [...],
      "created_at": "2025-11-12T01:00:00Z",
      "created_by": "system"
    }
  ],
  "current_version": "1.0.1",
  "created_at": "2025-11-12T00:00:00Z",
  "updated_at": "2025-11-12T01:00:00Z"
}
```

---

## Template Syntax

Variables se definen con `{{variable_name}}`:

```
Hello {{name}}!

Your order #{{order_id}} contains {{item_count}} items.

Total: ${{total_price}}
```

Al renderizar con:
```json
{
  "name": "John",
  "order_id": "12345",
  "item_count": 3,
  "total_price": 99.99
}
```

Produce:
```
Hello John!

Your order #12345 contains 3 items.

Total: $99.99
```

---

## Versioning Strategy

- **Patch bump** (1.0.0 → 1.0.1): Cuando se actualiza el `content`
- **Manual versioning**: Puedes especificar version en el request
- **Max versions**: Se mantienen las últimas N versiones (configurable)
- **Rollback**: Puedes renderizar versiones antiguas especificando `version`

---

## Analytics

El módulo registra automáticamente:

- **usage_count**: Cuántas veces se usó el prompt
- **total_tokens**: Tokens totales consumidos
- **avg_tokens**: Tokens promedio por uso
- **total_latency_ms**: Latencia total
- **avg_latency_ms**: Latencia promedio
- **total_cost**: Costo total (USD)
- **avg_cost**: Costo promedio por uso
- **first_used**: Primera vez usado
- **last_used**: Última vez usado

---

## A/B Testing

Compara dos prompts para determinar cuál funciona mejor:

```javascript
// Crear dos variantes
POST /modules/prompt-manager/prompts
{ "name": "welcome-v1", "content": "Hello!" }

POST /modules/prompt-manager/prompts
{ "name": "welcome-v2", "content": "Hi there!" }

// Después de usar ambos...

// Comparar
POST /modules/prompt-manager/prompts/compare
{
  "prompt_a_id": "id_v1",
  "prompt_b_id": "id_v2",
  "metric": "avg_cost"
}
```

---

## Integration with AI Gateway

El Prompt Manager se integra con AI Gateway:

```javascript
// 1. Crear prompt
POST /modules/prompt-manager/prompts
{ "name": "summarize", "content": "Summarize: {{text}}" }

// 2. Renderizar
POST /modules/prompt-manager/prompts/:id/render
{ "variables": { "text": "Long text..." } }

// 3. Enviar a AI Gateway
POST /modules/ai-gateway/chat
{
  "prompt": "<rendered_text>",
  "provider": "deepseek",
  "model": "deepseek-chat"
}

// 4. Analytics se registran automáticamente
```

---

## Storage Format

Prompts se guardan en `data/prompts/`:

```
data/prompts/
├── abc123def456.json     # Prompt 1
├── def456ghi789.json     # Prompt 2
└── _analytics.json       # Analytics agregados
```

---

## CLI Usage

```bash
# Crear prompt
curl -X POST http://localhost:3000/modules/prompt-manager/prompts \
  -H "Content-Type: application/json" \
  -d '{"name":"test","content":"Hello {{name}}"}'

# Listar prompts
curl http://localhost:3000/modules/prompt-manager/prompts

# Renderizar
curl -X POST http://localhost:3000/modules/prompt-manager/prompts/:id/render \
  -H "Content-Type: application/json" \
  -d '{"variables":{"name":"World"}}'

# Ver analytics
curl http://localhost:3000/modules/prompt-manager/analytics
```

---

## Error Handling

Errores comunes:

- **409 PROMPT_EXISTS**: Ya existe un prompt con ese nombre
- **404 PROMPT_NOT_FOUND**: Prompt no encontrado
- **404 VERSION_NOT_FOUND**: Versión no encontrada
- **500 CREATE/UPDATE/DELETE_FAILED**: Error interno

---

## Next Steps

1. Integrar con **AI Gateway Module** (próximo)
2. Crear **AI Agent Framework** que use estos prompts
3. Agregar **UI en Dashboard** para gestión visual
4. Implementar **import/export** de prompts
5. Agregar **prompt suggestions** con IA

---

**Status**: ✅ Ready for integration
**Version**: 1.0.0
**Dependencies**: Module Loader (core)
**Next**: AI Gateway Module
