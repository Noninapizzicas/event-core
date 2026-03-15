# AI Agent Framework

Framework para crear agentes IA event-driven con context management, tool calling y orchestration.

## Overview

El AI Agent Framework permite crear agentes inteligentes que:

✅ **Se suscriben a eventos MQTT** - Responden automáticamente a eventos del sistema
✅ **Mantienen contexto/memoria** - Recuerdan conversaciones anteriores
✅ **Llaman tools** - Acceden a APIs de otros módulos
✅ **Se coordinan** - Múltiples agentes trabajan juntos
✅ **Auto-descubrimiento** - Registry centralizado

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│         AI Agent Framework Module                    │
├─────────────────────────────────────────────────────┤
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │   Agent      │  │   Context    │  │   Tool    │ │
│  │   Registry   │  │   Manager    │  │  Manager  │ │
│  └──────────────┘  └──────────────┘  └───────────┘ │
│                                                      │
│  ┌──────────────────────────────────────────────┐  │
│  │           Active Agents                       │  │
│  │  - Code Reviewer                              │  │
│  │  - Task Prioritizer                           │  │
│  │  - Bug Analyzer                               │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
           ↓                    ↑
    Event Bus (MQTT)    Prompt Manager + AI Gateway
```

---

## Core Components

### 1. **Agent** (agent.js)
Base class para todos los agentes.

**Features:**
- Event subscription (MQTT patterns)
- Context management (memoria)
- Tool calling (access APIs)
- Prompt rendering (integration con Prompt Manager)
- AI invocation (integration con AI Gateway)
- Stats tracking (executions, tokens, cost)

### 2. **Context Manager** (context-manager.js)
Gestiona memoria/contexto para cada agente.

**Features:**
- Message history per agent
- TTL-based cleanup (default 24h)
- Max messages limit (default 100)
- Context summary APIs

### 3. **Tool Manager** (tool-manager.js)
Gestiona tools que agentes pueden usar.

**Built-in Tools:**
- `http_request` - Make HTTP calls
- `publish_event` - Publish MQTT events
- `read_file` - Read file contents
- `write_file` - Write file contents

---

## Creating an Agent

### Method 1: Via API

```http
POST /modules/ai-agent-framework/agents
Content-Type: application/json

{
  "name": "code-reviewer",
  "description": "Reviews code for best practices and bugs",
  "prompt_id": "prompt-123",
  "provider": "deepseek",
  "model": "deepseek-chat",
  "temperature": 0.3,
  "max_tokens": 2000,
  "subscribes": [
    "git.push",
    "code.commit"
  ],
  "tools": [
    "http_request",
    "publish_event",
    "read_file"
  ],
  "context_enabled": true,
  "context_window": 10,
  "enabled": true,
  "metadata": {
    "team": "engineering",
    "priority": "high"
  }
}
```

**Response:**
```json
{
  "id": "abc123def456",
  "name": "code-reviewer",
  "description": "Reviews code for best practices and bugs",
  "prompt_id": "prompt-123",
  "provider": "deepseek",
  "model": "deepseek-chat",
  "subscribes": ["git.push", "code.commit"],
  "tools": ["http_request", "publish_event", "read_file"],
  "enabled": true,
  "created_at": "2025-11-12T00:00:00Z",
  "stats": {
    "executions": 0,
    "successes": 0,
    "failures": 0,
    "total_tokens": 0,
    "total_cost": 0,
    "avg_latency_ms": 0
  }
}
```

### Method 2: Subclass Agent

```javascript
const Agent = require('./agent');

class CodeReviewerAgent extends Agent {
  constructor(config) {
    super({
      name: 'code-reviewer',
      description: 'Reviews code',
      subscribes: ['git.push'],
      ...config
    });
  }

  // Override execute if needed
  async execute(event) {
    const { files, commit_message } = event.payload;

    // Custom logic here
    const review = await this.reviewCode(files);

    return { review, files_reviewed: files.length };
  }

  async reviewCode(files) {
    // Implementation
  }
}

module.exports = CodeReviewerAgent;
```

---

## Agent Lifecycle

```
1. Register Agent
   ↓
2. Subscribe to Events (MQTT)
   ↓
3. Event Received
   ↓
4. Build Context (last N messages)
   ↓
5. Render Prompt (from Prompt Manager)
   ↓
6. Call AI (via AI Gateway)
   ↓
7. Process Tools (if AI requests)
   ↓
8. Update Context (add to memory)
   ↓
9. Publish Result Event
```

---

## API Endpoints

### Register Agent
```http
POST /modules/ai-agent-framework/agents
```

### List Agents
```http
GET /modules/ai-agent-framework/agents?enabled=true
```

### Get Agent
```http
GET /modules/ai-agent-framework/agents/:id
```

### Update Agent
```http
PUT /modules/ai-agent-framework/agents/:id
Content-Type: application/json

{
  "enabled": false,
  "temperature": 0.5
}
```

### Delete Agent
```http
DELETE /modules/ai-agent-framework/agents/:id
```

### Trigger Agent (Manual)
```http
POST /modules/ai-agent-framework/agents/:id/trigger
Content-Type: application/json

{
  "payload": {
    "message": "Test message",
    "custom_data": "..."
  }
}
```

### Get Context
```http
GET /modules/ai-agent-framework/agents/:id/context
```

**Response:**
```json
{
  "agent_id": "abc123",
  "messages": [
    {
      "role": "user",
      "content": "Hello",
      "timestamp": "2025-11-12T00:00:00Z"
    },
    {
      "role": "assistant",
      "content": "Hi! How can I help?",
      "timestamp": "2025-11-12T00:00:05Z"
    }
  ],
  "metadata": {},
  "created_at": "2025-11-12T00:00:00Z",
  "updated_at": "2025-11-12T00:00:05Z"
}
```

### Clear Context
```http
DELETE /modules/ai-agent-framework/agents/:id/context
```

### List Tools
```http
GET /modules/ai-agent-framework/tools
```

**Response:**
```json
{
  "tools": [
    {
      "name": "http_request",
      "description": "Make HTTP request to any API",
      "parameters": {
        "method": {"type": "string", "required": true},
        "url": {"type": "string", "required": true},
        "body": {"type": "object", "required": false}
      }
    },
    {
      "name": "publish_event",
      "description": "Publish event to MQTT bus",
      "parameters": {
        "event_type": {"type": "string", "required": true},
        "payload": {"type": "object", "required": true}
      }
    }
  ],
  "total": 2
}
```

### Get Agent Stats
```http
GET /modules/ai-agent-framework/agents/:id/stats
```

**Response:**
```json
{
  "agent_id": "abc123",
  "agent_name": "code-reviewer",
  "stats": {
    "executions": 150,
    "successes": 145,
    "failures": 5,
    "total_tokens": 45000,
    "total_cost": 4.5,
    "avg_latency_ms": 850,
    "last_execution": "2025-11-12T12:00:00Z"
  }
}
```

---

## Context Management

Cada agente mantiene contexto (memoria) de sus interacciones:

**Features:**
- Last N messages kept (configurable via `context_window`)
- Automatic TTL cleanup (default 24h)
- Max messages per agent (default 100)
- Clear context via API

**Example:**
```javascript
// Agent receives event
Event: { type: 'user.question', payload: { question: 'What is 2+2?' } }

// Context before:
[]

// AI Response: "4"

// Context after:
[
  { role: 'user', content: 'What is 2+2?', timestamp: '...' },
  { role: 'assistant', content: '4', timestamp: '...' }
]

// Next event
Event: { type: 'user.question', payload: { question: 'And what about 3+3?' } }

// Context sent to AI:
[
  { role: 'user', content: 'What is 2+2?' },
  { role: 'assistant', content: '4' },
  { role: 'user', content: 'And what about 3+3?' }  // ← AI has context!
]
```

---

## Tool Calling

Agentes pueden llamar tools para acceder a datos o ejecutar acciones.

### Format

El AI debe devolver tool calls en este formato:

```
[TOOL:tool_name]({"arg1":"value1","arg2":"value2"})
```

**Example:**
```
I'll read the file for you.

[TOOL:read_file]({"path":"/path/to/file.txt"})

After reading, I found...
```

### Built-in Tools

#### 1. http_request
```javascript
[TOOL:http_request]({
  "method": "POST",
  "url": "http://localhost:3000/api/endpoint",
  "body": {"key": "value"},
  "headers": {"Authorization": "Bearer token"}
})
```

#### 2. publish_event
```javascript
[TOOL:publish_event]({
  "event_type": "code.review.completed",
  "payload": {"files": 5, "issues": 3}
})
```

#### 3. read_file
```javascript
[TOOL:read_file]({
  "path": "/path/to/file.txt"
})
```

#### 4. write_file
```javascript
[TOOL:write_file]({
  "path": "/path/to/output.txt",
  "content": "File contents here"
})
```

### Tool Permissions

Agentes solo pueden usar tools especificados en su configuración:

```json
{
  "name": "my-agent",
  "tools": ["read_file", "publish_event"]  // ← Only these tools allowed
}
```

Si el agente intenta usar un tool no permitido:
```json
{
  "error": "Tool 'write_file' not allowed for this agent"
}
```

### Adding Custom Tools

```javascript
// In your module
const toolManager = agentFramework.toolManager;

toolManager.registerTool({
  name: 'send_email',
  description: 'Send email via SMTP',
  parameters: {
    to: { type: 'string', required: true },
    subject: { type: 'string', required: true },
    body: { type: 'string', required: true }
  },
  handler: async (args) => {
    // Implementation
    await sendEmail(args.to, args.subject, args.body);
    return { success: true, sent_at: new Date().toISOString() };
  }
});
```

---

## Events Published

Agentes publican eventos en su ciclo de vida:

### agent.{name}.completed
```json
{
  "agent_id": "abc123",
  "agent_name": "code-reviewer",
  "trigger_event": "git.push",
  "result": {
    "content": "Code review results...",
    "tools_used": [
      {"tool": "read_file", "success": true, "result": {...}}
    ]
  },
  "timestamp": "2025-11-12T12:00:00Z"
}
```

### agent.{name}.failed
```json
{
  "agent_id": "abc123",
  "agent_name": "code-reviewer",
  "trigger_event": "git.push",
  "error": "AI Gateway timeout",
  "timestamp": "2025-11-12T12:00:00Z"
}
```

---

## Configuration

Edit `modules/ai-agent-framework/module.json`:

```json
{
  "config": {
    "max_agents": 100,
    "context": {
      "max_messages_per_agent": 100,
      "ttl_minutes": 1440
    },
    "execution": {
      "timeout_ms": 60000,
      "max_retries": 3
    },
    "tools": {
      "enabled": true,
      "timeout_ms": 10000
    }
  }
}
```

---

## Integration Example

### Full Workflow

```bash
# 1. Create a prompt
curl -X POST http://localhost:3000/modules/prompt-manager/prompts \
  -H "Content-Type: application/json" \
  -d '{
    "name": "code-reviewer",
    "content": "Review this code:\n\n{{code}}\n\nCheck for: bugs, best practices, security issues.",
    "variables": [
      {"name": "code", "type": "string", "required": true}
    ]
  }'

# Response: { "id": "prompt-abc123", ... }

# 2. Create an agent
curl -X POST http://localhost:3000/modules/ai-agent-framework/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "code-reviewer",
    "prompt_id": "prompt-abc123",
    "provider": "deepseek",
    "subscribes": ["git.push"],
    "tools": ["read_file", "publish_event"]
  }'

# Response: { "id": "agent-def456", ... }

# 3. Trigger the agent (or let it listen to git.push events)
curl -X POST http://localhost:3000/modules/ai-agent-framework/agents/agent-def456/trigger \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {
      "code": "function add(a, b) { return a + b; }",
      "file": "math.js"
    }
  }'

# Response:
# {
#   "agent_id": "agent-def456",
#   "result": {
#     "content": "Code review: The function looks good. It follows best practices...",
#     "provider": "deepseek",
#     "usage": {"total_tokens": 150},
#     "cost": 0.00003
#   }
# }

# 4. Check agent stats
curl http://localhost:3000/modules/ai-agent-framework/agents/agent-def456/stats

# 5. View context
curl http://localhost:3000/modules/ai-agent-framework/agents/agent-def456/context
```

---

## Use Cases

### 1. Code Reviewer Agent
```javascript
{
  "name": "code-reviewer",
  "subscribes": ["git.push", "pr.opened"],
  "tools": ["read_file", "http_request"],
  "prompt_id": "code-review-prompt"
}
```

### 2. Bug Analyzer Agent
```javascript
{
  "name": "bug-analyzer",
  "subscribes": ["error.occurred", "exception.thrown"],
  "tools": ["read_file", "publish_event"],
  "prompt_id": "bug-analysis-prompt"
}
```

### 3. Task Prioritizer Agent
```javascript
{
  "name": "task-prioritizer",
  "subscribes": ["task.created"],
  "tools": ["http_request"],
  "prompt_id": "task-priority-prompt"
}
```

### 4. Documentation Generator Agent
```javascript
{
  "name": "doc-generator",
  "subscribes": ["code.committed"],
  "tools": ["read_file", "write_file"],
  "prompt_id": "doc-gen-prompt"
}
```

### 5. Customer Support Agent
```javascript
{
  "name": "support-agent",
  "subscribes": ["ticket.created"],
  "tools": ["http_request", "publish_event"],
  "context_enabled": true,
  "context_window": 20,
  "prompt_id": "support-prompt"
}
```

---

## Multi-Agent Coordination

Múltiples agentes pueden trabajar juntos:

```
User asks question
   ↓
[Question Classifier Agent]
   ↓ publishes: question.classified { category: "technical" }
   ↓
[Technical Expert Agent] ← subscribes to "question.classified"
   ↓ answers question
   ↓ publishes: question.answered { answer: "..." }
   ↓
[Response Formatter Agent] ← subscribes to "question.answered"
   ↓ formats answer
   ↓ publishes: response.ready
```

**Implementation:**
```javascript
// Agent 1: Classifier
{
  "name": "question-classifier",
  "subscribes": ["user.question"],
  "tools": ["publish_event"]
}

// Agent 2: Technical Expert
{
  "name": "technical-expert",
  "subscribes": ["question.classified"],
  "tools": ["read_file", "publish_event"]
}

// Agent 3: Formatter
{
  "name": "response-formatter",
  "subscribes": ["question.answered"],
  "tools": ["publish_event"]
}
```

---

## Troubleshooting

### Agent not responding to events
```bash
# Check if agent is enabled
curl http://localhost:3000/modules/ai-agent-framework/agents/:id

# Check event subscriptions
# Verify event pattern matches (e.g., "git.*" matches "git.push")

# Check agent stats for errors
curl http://localhost:3000/modules/ai-agent-framework/agents/:id/stats
```

### Context not working
```bash
# Check context_enabled
curl http://localhost:3000/modules/ai-agent-framework/agents/:id

# View current context
curl http://localhost:3000/modules/ai-agent-framework/agents/:id/context

# Clear and retry
curl -X DELETE http://localhost:3000/modules/ai-agent-framework/agents/:id/context
```

### Tool calls failing
```bash
# List available tools
curl http://localhost:3000/modules/ai-agent-framework/tools

# Check agent's allowed tools
curl http://localhost:3000/modules/ai-agent-framework/agents/:id

# Verify tool format in AI response
# Should be: [TOOL:tool_name]({"arg":"value"})
```

---

## Performance Tips

1. **Use context_window wisely**: Más contexto = más tokens = más costo
2. **Disable context for stateless agents**: Si no necesitas memoria, `context_enabled: false`
3. **Use DeepSeek for cost savings**: 5-10x más barato que GPT-4/Claude
4. **Batch tool calls**: Si un agente hace muchas llamadas HTTP, considera crear un tool custom que las agrupe
5. **Monitor stats**: Revisa regularmente `/agents/:id/stats` para detectar problemas

---

## Future Enhancements

- [ ] Agent templates library
- [ ] Visual agent builder (UI)
- [ ] Agent testing framework
- [ ] Agent versioning
- [ ] Streaming responses from agents
- [ ] Agent collaboration protocols
- [ ] Agent marketplace
- [ ] Fine-tuning agent prompts based on feedback

---

**Status**: ✅ Ready for use
**Version**: 1.0.0
**Dependencies**: Prompt Manager, AI Gateway
**Next**: Create example agents
