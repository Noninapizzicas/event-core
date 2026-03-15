# Event Core - Core Infrastructure

**Core minimalista** que provee solo infraestructura, nunca features.

---

## 📦 Componentes Implementados

### ✅ Hook System (`hooks.js`)

Sistema de hooks que permite a los módulos interceptar operaciones del core sin acoplamiento directo.

**Features:**
- ✅ Registro de múltiples handlers por hook
- ✅ Ejecución secuencial con chaining
- ✅ Modificación de contexto
- ✅ Bloqueo de operaciones (retornando `null`)
- ✅ Error handling con información detallada
- ✅ Estadísticas de ejecución (executions, blocked, errors)
- ✅ 21 tests unitarios pasando

**Uso:**

```javascript
const HookManager = require('./hooks');
const hooks = new HookManager();

// Registrar hook
hooks.register('beforeEventPublish', async (context) => {
  console.log('Publishing:', context.eventType);
  return context; // Continuar sin modificar
});

// Modificar contexto
hooks.register('beforeEventPublish', async (context) => {
  return {
    ...context,
    data: encrypt(context.data) // Cifrar data
  };
});

// Bloquear operación
hooks.register('beforeEventPublish', async (context) => {
  if (context.eventType === 'forbidden') {
    return null; // Bloquear
  }
  return context;
});

// Ejecutar hooks
const result = await hooks.execute('beforeEventPublish', {
  eventType: 'user.created',
  data: { id: 123 }
});

if (result === null) {
  console.log('Event was blocked');
} else {
  // Publicar evento con data modificada
  publish(result);
}
```

**Stats:**

```javascript
const stats = hooks.getStats('beforeEventPublish');
console.log(`Executions: ${stats.executions}`);
console.log(`Blocked: ${stats.blocked}`);
console.log(`Errors: ${stats.errors}`);
```

---

### ✅ Observability (`observability/`)

Sistema completo de observabilidad con Logger, Tracer y Metrics.

**Features:**
- ✅ Logger con niveles (debug, info, warn, error)
- ✅ Structured logging con contexto
- ✅ Child loggers con contexto heredado
- ✅ Tracer con W3C Trace Context
- ✅ Distributed tracing con trace/span IDs
- ✅ Trace inject/extract para propagación
- ✅ Metrics: Counter y Histogram
- ✅ Percentiles (p50, p95, p99)
- ✅ Helpers measure() para timing automático
- ✅ 19 tests unitarios pasando

**Uso:**

```javascript
const { Logger, Tracer, Metrics } = require('./observability');

// Logger
const logger = new Logger({ level: 'info', coreId: 'core-a' });
logger.info('module.loaded', { module: 'echo', version: '1.0.0' });
logger.error('event.failed', { eventType: 'user.created' }, error);

// Tracer
const tracer = new Tracer({ coreId: 'core-a', logger });
const trace = tracer.start('process.file');
trace.addTag('filename', 'data.json');
trace.addLog('Processing started');
trace.end();

// Metrics
const metrics = new Metrics({ coreId: 'core-a' });
metrics.increment('events.published');
metrics.observe('event.duration_ms', 123.45);

const result = await metrics.measure('db.query', async () => {
  return await db.query('SELECT * FROM users');
});
```

---

## 🔲 Componentes Pendientes

### MQTT (`broker/`, `mqtt/`)
- `broker/embedded.js` - Aedes broker embebido
- `mqtt/client.js` - MQTT client wrapper
- `mqtt/topics.js` - Topic helpers

### Events (`events/`)
- `bus.js` - EventEmitter wrapper
- `router.js` - MQTT integration
- `envelope.js` - Event standardization

### Modules (`modules/`)
- `loader.js` - Autodescubrimiento
- `manager.js` - Lifecycle management
- `registry.js` - Module registry

### API (`api/`)
- `gateway.js` - HTTP server
- `router.js` - Route registration

### Schemas (`schemas/`)
- JSON Schemas para validación

---

## 🧪 Testing

```bash
# Tests unitarios
node tests/unit/hooks.test.js

# Todos los tests
npm test
```

---

## 📊 Progress v0.1.0

- [x] Hook System (8 SP) - **COMPLETADO** ✅
- [x] Observability (8 SP) - **COMPLETADO** ✅
- [ ] MQTT Broker (8 SP) - **IN PROGRESS** 🔄
- [ ] Event Bus (8 SP)
- [ ] Module Loader (13 SP)
- [ ] HTTP Gateway (10 SP)
- [ ] Echo Module (3 SP)
- [ ] File Watcher Module (2 SP)
- [ ] Security P2P Module (21 SP)
- [ ] CLI HTTP Client (8 SP)
- [ ] Integration Tests (13 SP)

**Total:** 94 SP | **Completado:** 16 SP (17%) | **Tests:** 40 pasando

---

**Next:** Implementar MQTT Broker con prompt `arquitecto_event_driven_y_messaging_v1.1.0.json`
