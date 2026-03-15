# AI Gateway Module

Gateway unificado para múltiples proveedores LLM con rate limiting, retry, streaming y cost tracking.

## Supported Providers

### 1. **DeepSeek** (Priority 1) 🥇
- **API Base**: `https://api.deepseek.com/v1`
- **Models**: `deepseek-chat`, `deepseek-coder`
- **Cost**: $0.0001/1K input tokens, $0.0002/1K output tokens
- **Why first**: Excelente costo/performance ratio

### 2. **Anthropic Claude** (Priority 2)
- **API Base**: `https://api.anthropic.com/v1`
- **Models**: `claude-3-5-sonnet-20241022`, `claude-3-opus-20240229`, `claude-3-haiku-20240307`
- **Cost**: $0.003/1K input tokens, $0.015/1K output tokens

### 3. **OpenAI** (Priority 3)
- **API Base**: `https://api.openai.com/v1`
- **Models**: `gpt-4o`, `gpt-4o-mini`, `gpt-3.5-turbo`
- **Cost**: $0.0015/1K input tokens, $0.006/1K output tokens

### 4. **Ollama** (Priority 4) - Local
- **API Base**: `http://localhost:11434/api`
- **Models**: `llama2`, `codellama`, `mistral`, `mixtral`
- **Cost**: $0 (local)

---

## Features

✅ **Multi-provider support** - 4 proveedores listos
✅ **Auto fallback** - Si un proveedor falla, prueba el siguiente
✅ **Rate limiting** - Por proveedor, configurable
✅ **Retry con exponential backoff** - 3 intentos default
✅ **Streaming SSE** - Para UIs reactivas
✅ **Cost tracking** - Por proveedor y request
✅ **Usage analytics** - Requests, tokens, cost, errors
✅ **Priority-based routing** - DeepSeek primero por defecto

---

## Configuration

Edit `modules/ai-gateway/module.json`:

```json
{
  "config": {
    "providers": {
      "deepseek": {
        "enabled": true,
        "priority": 1,
        "rate_limit": {
          "requests_per_minute": 60,
          "tokens_per_minute": 100000
        }
      }
    },
    "retry": {
      "max_attempts": 3,
      "initial_delay_ms": 1000,
      "backoff_multiplier": 2
    },
    "fallback": {
      "enabled": true,
      "strategy": "priority"
    }
  }
}
```

---

## Environment Variables

Set API keys in `.env` or environment:

```bash
# Required for each provider you want to use
DEEPSEEK_API_KEY=your_deepseek_key
ANTHROPIC_API_KEY=your_anthropic_key
OPENAI_API_KEY=your_openai_key

# Ollama doesn't need API key (local)
```

---

## API Endpoints

### Chat Completion
```http
POST /modules/ai-gateway/chat
Content-Type: application/json

{
  "messages": [
    {"role": "user", "content": "Hello!"}
  ],
  "provider": "auto",
  "temperature": 0.7,
  "max_tokens": 2000
}
```

**Response:**
```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "content": "Hello! How can I help you today?",
  "usage": {
    "input_tokens": 5,
    "output_tokens": 10,
    "total_tokens": 15
  },
  "cost": 0.0000025,
  "latency_ms": 450,
  "finish_reason": "stop"
}
```

### Chat Completion Stream
```http
POST /modules/ai-gateway/chat/stream
Content-Type: application/json

{
  "messages": [
    {"role": "user", "content": "Write a poem"}
  ],
  "provider": "deepseek"
}
```

**Response (SSE):**
```
data: {"type":"chunk","content":"Roses"}

data: {"type":"chunk","content":" are"}

data: {"type":"chunk","content":" red,"}

data: {"type":"done","provider":"deepseek","usage":{...},"cost":0.001}
```

### List Providers
```http
GET /modules/ai-gateway/providers
```

**Response:**
```json
{
  "providers": [
    {
      "name": "deepseek",
      "priority": 1,
      "available": true,
      "models": ["deepseek-chat", "deepseek-coder"],
      "default_model": "deepseek-chat",
      "rate_limit": {
        "requests_per_minute": 60,
        "tokens_per_minute": 100000
      },
      "usage": {
        "requests": 150,
        "tokens": 45000,
        "cost": 4.5,
        "errors": 0
      }
    }
  ]
}
```

### List Models
```http
GET /modules/ai-gateway/models?provider=deepseek
```

**Response:**
```json
{
  "models": [
    {
      "provider": "deepseek",
      "model": "deepseek-chat",
      "default": true
    },
    {
      "provider": "deepseek",
      "model": "deepseek-coder",
      "default": false
    }
  ],
  "total": 2
}
```

### Get Usage
```http
GET /modules/ai-gateway/usage?provider=deepseek
```

**Response:**
```json
{
  "usage": [
    {
      "provider": "deepseek",
      "requests": 150,
      "tokens": 45000,
      "cost": 4.5,
      "errors": 0
    }
  ],
  "totals": {
    "requests": 150,
    "tokens": 45000,
    "cost": 4.5,
    "errors": 0
  }
}
```

### Test Provider
```http
POST /modules/ai-gateway/providers/test
Content-Type: application/json

{
  "provider": "deepseek"
}
```

**Response:**
```json
{
  "provider": "deepseek",
  "available": true,
  "latency_ms": 423,
  "response_preview": "OK",
  "model": "deepseek-chat"
}
```

---

## Auto Fallback

Cuando `provider: "auto"` (default), el sistema intenta proveedores en orden de priority:

```
1. DeepSeek   (si falla →)
2. Anthropic  (si falla →)
3. OpenAI     (si falla →)
4. Ollama     (si falla → error)
```

Ejemplo:
```javascript
// DeepSeek no disponible → fallback a Claude automáticamente
POST /modules/ai-gateway/chat
{
  "messages": [...],
  "provider": "auto"  // or omit this field
}

// Response indica qué proveedor se usó:
{
  "provider": "anthropic",  // ← Usó Claude porque DeepSeek falló
  "model": "claude-3-5-sonnet-20241022",
  ...
}
```

---

## Rate Limiting

Cada proveedor tiene límites independientes:

```javascript
// Config per provider
"rate_limit": {
  "requests_per_minute": 60,
  "tokens_per_minute": 100000
}
```

Si excedes el límite:
```json
{
  "error": "RATE_LIMIT_EXCEEDED",
  "message": "Rate limit exceeded: REQUEST_RATE_LIMIT_EXCEEDED",
  "retry_after_ms": 15000
}
```

---

## Retry Strategy

Exponential backoff con 3 intentos default:

```javascript
// Config
"retry": {
  "max_attempts": 3,
  "initial_delay_ms": 1000,
  "max_delay_ms": 10000,
  "backoff_multiplier": 2
}
```

Delays: 1s → 2s → 4s

---

## Streaming Example

### JavaScript (Browser)
```javascript
const response = await fetch('http://localhost:3000/modules/ai-gateway/chat/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    messages: [
      { role: 'user', content: 'Write a story' }
    ]
  })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value);
  const lines = chunk.split('\n');

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6));

      if (data.type === 'chunk') {
        process.stdout.write(data.content);
      } else if (data.type === 'done') {
        console.log('\n\nUsage:', data.usage);
        console.log('Cost:', data.cost);
      }
    }
  }
}
```

### curl
```bash
curl -N -X POST http://localhost:3000/modules/ai-gateway/chat/stream \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role":"user","content":"Count to 10"}],
    "provider": "deepseek"
  }'
```

---

## Integration with Prompt Manager

Renderiza prompts y envíalos al AI Gateway:

```javascript
// 1. Renderizar prompt
const rendered = await fetch('http://localhost:3000/modules/prompt-manager/prompts/:id/render', {
  method: 'POST',
  body: JSON.stringify({
    variables: { name: 'John', task: 'debug code' }
  })
}).then(r => r.json());

// 2. Enviar a AI Gateway
const response = await fetch('http://localhost:3000/modules/ai-gateway/chat', {
  method: 'POST',
  body: JSON.stringify({
    messages: [
      { role: 'user', content: rendered.rendered }
    ],
    provider: 'deepseek',
    metadata: {
      prompt_id: ':id',
      user_id: 'john'
    }
  })
}).then(r => r.json());

// 3. Analytics se registran automáticamente en Prompt Manager
```

---

## Cost Tracking

El sistema rastrea costos por proveedor:

```javascript
// Costs per 1K tokens (configurable)
deepseek: {
  input: $0.0001,
  output: $0.0002
}

anthropic: {
  input: $0.003,
  output: $0.015
}

openai: {
  input: $0.0015,
  output: $0.006
}

ollama: {
  input: $0,
  output: $0  // Local, no cost
}
```

**Cálculo:**
```
cost = (input_tokens / 1000) * input_rate + (output_tokens / 1000) * output_rate
```

**Ejemplo:**
```
Input: 500 tokens
Output: 1000 tokens
Provider: deepseek

cost = (500 / 1000) * 0.0001 + (1000 / 1000) * 0.0002
     = 0.00005 + 0.0002
     = 0.00025 USD ($0.00025)
```

---

## Provider Architecture

Cada proveedor implementa `BaseProvider`:

```javascript
class BaseProvider {
  async initialize()
  async isAvailable()
  async chatCompletion(messages, options)
  async chatCompletionStream(messages, options)
  checkRateLimit(tokens)
  recordUsage(tokens)
  calculateCost(inputTokens, outputTokens)
  withRetry(fn, retryConfig)
}
```

### Adding a New Provider

```javascript
// 1. Create provider class
class MyProvider extends BaseProvider {
  constructor(config, logger) {
    super(config, logger);
    this.name = 'myprovider';
  }

  async initialize() {
    this.apiKey = process.env.MYPROVIDER_API_KEY;
  }

  async chatCompletion(messages, options) {
    // Implementation
  }
}

// 2. Add to index.js
const MyProvider = require('./providers/my-provider');

// 3. Add config to module.json
"myprovider": {
  "enabled": true,
  "priority": 5,
  "api_base": "https://api.myprovider.com",
  ...
}
```

---

## Events Published

El módulo publica eventos para analytics:

```javascript
eventBus.publish('ai.completion.completed', {
  provider: 'deepseek',
  model: 'deepseek-chat',
  prompt_id: 'abc123',
  tokens_used: 150,
  latency_ms: 450,
  cost: 0.000025,
  metadata: { user_id: 'john' }
});
```

El **Prompt Manager** se suscribe a estos eventos para tracking automático.

---

## Error Handling

```javascript
// Provider not found
{
  "error": "PROVIDER_NOT_FOUND",
  "message": "Provider 'xyz' not found or not enabled"
}

// Provider not available (API key missing)
{
  "error": "PROVIDER_NOT_AVAILABLE",
  "message": "Provider 'deepseek' not available"
}

// Rate limit exceeded
{
  "error": "RATE_LIMIT_EXCEEDED",
  "message": "Rate limit exceeded: TOKEN_RATE_LIMIT_EXCEEDED"
}

// All providers failed (with fallback)
{
  "error": "ALL_PROVIDERS_FAILED",
  "message": "All providers failed. Last error: Connection timeout"
}
```

---

## CLI Usage

```bash
# Chat completion
curl -X POST http://localhost:3000/modules/ai-gateway/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role":"user","content":"Hello!"}
    ],
    "provider": "deepseek"
  }'

# List providers
curl http://localhost:3000/modules/ai-gateway/providers

# Get usage stats
curl http://localhost:3000/modules/ai-gateway/usage

# Test provider
curl -X POST http://localhost:3000/modules/ai-gateway/providers/test \
  -H "Content-Type: application/json" \
  -d '{"provider":"deepseek"}'
```

---

## Performance Tips

1. **Use DeepSeek for cost-sensitive tasks**: 5-10x cheaper than Claude/GPT-4
2. **Use Ollama for development**: Zero cost, local, fast for testing
3. **Enable streaming for UIs**: Better UX, progressive rendering
4. **Set appropriate max_tokens**: Reduce cost and latency
5. **Batch requests**: Reduce overhead (future feature)

---

## Troubleshooting

### Provider not available
```bash
# Check API keys
echo $DEEPSEEK_API_KEY
echo $ANTHROPIC_API_KEY
echo $OPENAI_API_KEY

# Test provider
curl -X POST http://localhost:3000/modules/ai-gateway/providers/test \
  -d '{"provider":"deepseek"}'
```

### Ollama not working
```bash
# Is Ollama running?
curl http://localhost:11434/api/tags

# Start Ollama
ollama serve

# Pull a model
ollama pull llama2
```

### Rate limit issues
```javascript
// Increase limits in module.json
"rate_limit": {
  "requests_per_minute": 120,  // ← Increase
  "tokens_per_minute": 200000  // ← Increase
}
```

---

## Future Enhancements

- [ ] Request batching
- [ ] Response caching
- [ ] Load balancing across instances
- [ ] More providers (Cohere, Hugging Face, etc.)
- [ ] Token estimation improvements (tiktoken)
- [ ] Cost alerts and budgets
- [ ] A/B testing framework integration
- [ ] Prompt optimization suggestions

---

**Status**: ✅ Ready for integration
**Version**: 1.0.0
**Dependencies**: Module Loader, Prompt Manager (optional)
**Next**: AI Agent Framework
