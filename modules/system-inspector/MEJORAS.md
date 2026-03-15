# System Inspector - Propuestas de Mejora

> Generado: 2026-01-11
> Estado: Pendiente de implementar

---

## P0 - SEGURIDAD (Crítico)

### 1. Redacción de secretos en payloads

**Archivo:** `lib/console-buffer.js`

**Problema:** Los payloads MQTT y HTTP pueden contener tokens, API keys, y secretos que se persisten en el archivo JSON sin redactar.

**Solución:**
```javascript
// Añadir al constructor:
this.sensitiveKeys = [
  'password', 'passwd', 'pwd',
  'token', 'access_token', 'refresh_token', 'auth_token', 'bot_token',
  'secret', 'client_secret',
  'apikey', 'api_key', 'apiKey',
  'authorization', 'auth',
  'credential', 'credentials',
  'private_key', 'privateKey',
  'cookie', 'session', 'sessionid',
  'bearer'
];

// Modificar _truncateObject para redactar:
_truncateObject(obj, depth = 0) {
  // ... código existente ...
  if (typeof obj === 'object') {
    const result = {};
    for (const key of Object.keys(obj).slice(0, 50)) {
      if (this._isSensitiveKey(key)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = this._truncateObject(obj[key], depth + 1);
      }
    }
    return result;
  }
}

_isSensitiveKey(key) {
  const lower = key.toLowerCase();
  return this.sensitiveKeys.some(s => lower.includes(s));
}
```

**Criterio de éxito:** `grep -iE "token|apikey|secret" system-console.json` retorna vacío o `[REDACTED]`

---

### 2. Autenticación opcional en endpoints

**Archivo:** `index.js`

**Problema:** Endpoints expuestos sin autenticación permiten leer todo el buffer y limpiar evidencia.

**Solución:**
```javascript
// En _loadConfig():
auth_token: process.env.INSPECTOR_TOKEN || moduleConfig.auth_token || null,
allowed_ips: moduleConfig.allowed_ips || ['127.0.0.1', '::1'],

// Nuevo método:
_checkAuth(req) {
  if (!this.config.auth_token) return true; // No configurado = permitido

  const token = req.headers['x-inspector-token'];
  if (token === this.config.auth_token) return true;

  // Verificar IP si hay allowlist
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  if (this.config.allowed_ips.includes(clientIp)) return true;

  return false;
}

// En cada handler:
handleGetStatus(req, res) {
  if (!this._checkAuth(req)) {
    return { error: 'Unauthorized', status: 401 };
  }
  // ...
}
```

**Criterio de éxito:** Sin `INSPECTOR_TOKEN` o header válido, retorna 401.

---

## P1 - ROBUSTEZ (Importante)

### 3. Escritura atómica con rename

**Archivo:** `lib/file-writer.js`

**Problema:** Si el proceso crashea durante `writeFile`, el archivo queda corrupto.

**Solución:**
```javascript
async _write() {
  if (this.writing) return;
  this.writing = true;

  const tempPath = this.filePath + '.tmp';

  try {
    const state = this.buffer.getFullState(this.coreId, this.startTime);
    const json = JSON.stringify(state, null, 2);

    // Escribir a archivo temporal
    await fs.promises.writeFile(tempPath, json, 'utf8');

    // Rename atómico (POSIX garantiza atomicidad)
    await fs.promises.rename(tempPath, this.filePath);

    this.lastError = null;
  } catch (error) {
    // Limpiar temporal si existe
    try { await fs.promises.unlink(tempPath); } catch {}

    if (this.lastError !== error.message) {
      console.error('[system-inspector] Write error:', error.message);
      this.lastError = error.message;
    }
  } finally {
    this.writing = false;
  }
}
```

**Criterio de éxito:** Archivo siempre válido JSON incluso si se mata el proceso durante escritura.

---

### 4. TTL cleanup para pendingRequests

**Archivo:** `lib/http-interceptor.js`

**Problema:** Requests que nunca responden (timeout) nunca se limpian del Map.

**Solución:**
```javascript
constructor(buffer, core) {
  // ... existente ...
  this.requestTTL = 60000; // 60 segundos
  this.cleanupTimer = null;
}

async start() {
  // ... existente ...
  // Iniciar cleanup periódico
  this.cleanupTimer = setInterval(() => this._cleanupStale(), 30000);
}

stop() {
  // ... existente ...
  if (this.cleanupTimer) {
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }
}

_cleanupStale() {
  const now = Date.now();
  for (const [key, value] of this.pendingRequests.entries()) {
    if (now - value.startTime > this.requestTTL) {
      // Registrar como timeout
      this.buffer.network(value.method, value.path, 408, this.requestTTL, {
        error: 'Request timeout (not responded)',
        request_body: value.body
      });
      this.pendingRequests.delete(key);
    }
  }
}
```

**Criterio de éxito:** `pendingRequests.size` se mantiene estable bajo carga.

---

## P2 - IA-FIRST (Mejora UX)

### 5. Modo compact en /status

**Archivo:** `index.js`

**Problema:** `/status` retorna todo el buffer (500 entries, ~50KB). Claude gasta tokens innecesariamente.

**Solución:**
```javascript
handleGetStatus(req, res) {
  if (!this.buffer) {
    return { error: 'System Inspector not initialized' };
  }

  const mode = req.query?.mode || 'full';

  if (mode === 'compact') {
    return this._getCompactStatus();
  }

  return this.buffer.getFullState(this.core.id, this.startTime);
}

_getCompactStatus() {
  const errors = this.buffer.getErrors().slice(0, 5);
  const network = this.buffer.getNetwork()
    .filter(r => r.status >= 400 || r.duration_ms > 1000)
    .slice(0, 5);

  const slowest = this.buffer.getNetwork()
    .sort((a, b) => (b.duration_ms || 0) - (a.duration_ms || 0))
    .slice(0, 3);

  return {
    _meta: {
      generated_at: new Date().toISOString(),
      core_id: this.core.id,
      uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
      mode: 'compact'
    },
    summary: this.buffer.getSummary(),
    top_errors: errors,
    failed_requests: network,
    slowest_requests: slowest,
    insights: this._generateInsights()
  };
}

_generateInsights() {
  const insights = [];
  const summary = this.buffer.getSummary();

  if (summary.errors > 0) {
    insights.push(`${summary.errors} errores detectados`);
  }
  if (summary.network_failures > 0) {
    const rate = ((summary.network_failures / summary.network_requests) * 100).toFixed(1);
    insights.push(`${rate}% de requests fallidos`);
  }
  if (summary.mqtt_messages > 100) {
    insights.push('Alto volumen MQTT - considerar filtros');
  }

  return insights.length > 0 ? insights : ['Sistema operando normalmente'];
}
```

**Criterio de éxito:** `curl /status?mode=compact | wc -c` < 2000 bytes.

---

### 6. Query params para filtros

**Archivo:** `index.js`

**Problema:** No hay forma de pedir "últimos 10 errores" o filtrar por tipo.

**Solución:**
```javascript
handleGetStatus(req, res) {
  const { mode, type, limit, since } = req.query || {};

  let entries = this.buffer.getAll();

  // Filtrar por tipo
  if (type) {
    entries = entries.filter(e => e.type === type);
  }

  // Filtrar por timestamp
  if (since) {
    const sinceDate = new Date(since);
    entries = entries.filter(e => new Date(e.ts) > sinceDate);
  }

  // Limitar resultados
  if (limit) {
    entries = entries.slice(0, parseInt(limit, 10));
  }

  // ...
}
```

**Uso:** `/status?type=error&limit=10&since=2026-01-11T09:00:00Z`

---

## P3 - DEVEX (Nice to have)

### 7. Métricas Prometheus

**Archivo nuevo:** `lib/metrics.js`

```javascript
class MetricsExporter {
  constructor(buffer) {
    this.buffer = buffer;
  }

  getPrometheusMetrics() {
    const s = this.buffer.getSummary();
    return `
# HELP system_inspector_entries_total Total entries captured
# TYPE system_inspector_entries_total counter
system_inspector_entries_total ${s.total}

# HELP system_inspector_errors_total Total errors captured
# TYPE system_inspector_errors_total counter
system_inspector_errors_total ${s.errors}

# HELP system_inspector_http_requests_total Total HTTP requests
# TYPE system_inspector_http_requests_total counter
system_inspector_http_requests_total ${s.network_requests}

# HELP system_inspector_http_failures_total Failed HTTP requests
# TYPE system_inspector_http_failures_total counter
system_inspector_http_failures_total ${s.network_failures}

# HELP system_inspector_mqtt_messages_total MQTT messages captured
# TYPE system_inspector_mqtt_messages_total counter
system_inspector_mqtt_messages_total ${s.mqtt_messages}

# HELP system_inspector_buffer_size Current buffer entries
# TYPE system_inspector_buffer_size gauge
system_inspector_buffer_size ${this.buffer.entries.length}
`.trim();
  }
}
```

**Endpoint:** `GET /modules/system-inspector/metrics`

---

## ADAPTACIONES POR ARQUITECTURA

### Express/Koa/Fastify (sin hooks nativos)

```javascript
// middleware.js
module.exports = function createInspectorMiddleware(core) {
  return (req, res, next) => {
    const request_id = req.headers['x-request-id'] || crypto.randomUUID();
    req._inspectorStart = Date.now();
    req._inspectorId = request_id;

    core.hooks?.emit?.('beforeRequest', {
      request_id,
      method: req.method,
      path: req.path,
      body: req.body,
      headers: req.headers
    });

    const originalEnd = res.end;
    res.end = function(...args) {
      core.hooks?.emit?.('afterResponse', {
        request_id: req._inspectorId,
        status: res.statusCode,
        data: res._body
      });
      return originalEnd.apply(this, args);
    };

    next();
  };
};
```

### Multi-core (PM2/Cluster)

```javascript
// Configuración por worker
const coreId = `core-${process.env.PM2_INSTANCE_ID || process.pid}`;
const outputFile = `./data/system-console-${coreId}.json`;

// Script de consolidación (cron cada 10s)
const consolidated = { cores: {} };
for (const file of glob.sync('./data/system-console-core-*.json')) {
  const data = JSON.parse(fs.readFileSync(file));
  consolidated.cores[data._meta.core_id] = data;
}
fs.writeFileSync('./data/system-console-all.json', JSON.stringify(consolidated));
```

### Con trace-id distribuido

```javascript
// En console-buffer.js, modificar add():
add(entry) {
  const traceId = asyncLocalStorage?.getStore()?.traceId
    || entry.trace_id
    || null;

  const normalizedEntry = {
    ...entry,
    trace_id: traceId
  };
  // ...
}
```

---

## CHECKLIST DE VALIDACIÓN

```bash
# 1. Verificar módulo activo
curl -s http://localhost:3000/modules/system-inspector/status | jq '._meta'

# 2. Verificar NO hay secretos expuestos
curl -s http://localhost:3000/modules/system-inspector/status | grep -iE '"(token|apikey|secret|password)".*:.*"[^R\[]'

# 3. Verificar JSON válido
cat ./data/system-console.json | jq . > /dev/null && echo "OK"

# 4. Verificar errores
curl -s http://localhost:3000/modules/system-inspector/errors | jq '.count'

# 5. Verificar modo compact (cuando se implemente)
curl -s "http://localhost:3000/modules/system-inspector/status?mode=compact" | jq '.insights'
```

---

## HISTORIAL DE CAMBIOS

| Fecha | Cambio | Estado |
|-------|--------|--------|
| 2026-01-11 | Documento creado con propuestas P0-P3 | Pendiente |

