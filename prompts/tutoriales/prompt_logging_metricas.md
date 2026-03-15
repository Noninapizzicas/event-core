# 📊 Prompt Maestro — Logging y Métricas (Event Core)

**Rol activo:**
**Especialista en Observabilidad y Monitoreo (Monoespecialista)**
Encargado de implementar logging estructurado, métricas, trazas y dashboards para garantizar la observabilidad completa de módulos Event Core.

---

## 🎯 Objetivo General
Implementar **observabilidad completa** en un módulo Event Core usando logging estructurado (JSON), métricas (counters, gauges, timings), trazabilidad con correlation IDs y dashboards de monitoreo.

Debes implementar:
- Logging estructurado con niveles (debug, info, warn, error)
- Métricas de negocio (counters, gauges, timings)
- Métricas de sistema (CPU, memoria, latencia)
- Trazabilidad completa con correlation IDs
- Health checks
- Endpoint de métricas para monitoreo
- (Opcional) Dashboard de métricas en UI

---

## 🧱 1. Estructura esperada

```
modules/[NOMBRE_MODULO]/
├── module.json          ← APIs de metrics y health
└── index.js             ← Logging y métricas integrados

Logs:
logs/[modulo].log        ← Logs en JSON estructurado

Endpoints de monitoreo:
GET /modules/[modulo]/metrics    ← Métricas del módulo
GET /modules/[modulo]/health     ← Health check
```

---

## ⚙️ 2. Fases de implementación

### **Fase 1 — Logging estructurado básico**

1. En hook `onLoad()`, obtener logger desde `moduleAPI.logger`
2. Implementar logging en todos los handlers usando:
   - `this.logger.debug(event, data)` - Debugging detallado
   - `this.logger.info(event, data)` - Información general
   - `this.logger.warn(event, data)` - Advertencias
   - `this.logger.error(event, data)` - Errores
3. Formato de logs:
   - Event: nombre descriptivo (ej: `user.created`, `todo.list`)
   - Data: objeto JSON con contexto
   - SIEMPRE incluir `correlationId` en data
4. Loggear:
   - Inicio de operaciones importantes
   - Éxito de operaciones
   - Errores con stack trace
   - Eventos publicados/recibidos
5. NO loggear datos sensibles (passwords, tokens, PII)
6. Verificar logs en archivo JSON

**Complejidad:** 2 Story Points
**Tiempo estimado:** 30 minutos

---

### **Fase 2 — Métricas de negocio**

1. En hook `onLoad()`, obtener metrics desde `moduleAPI.metrics`
2. Implementar métricas en handlers:
   - **Counter**: `this.metrics.increment(name, value, tags)`
     - Para contar eventos (ej: `todo.created.total`)
   - **Gauge**: `this.metrics.gauge(name, value, tags)`
     - Para valores actuales (ej: `todo.active.count`)
   - **Timing**: `this.metrics.timing(name, duration, tags)`
     - Para medir latencia (ej: `todo.create.duration`)
3. Nomenclatura de métricas:
   - `<entity>.<action>.<type>` (ej: `todo.created.total`)
   - `<entity>.<state>.<type>` (ej: `todo.active.count`)
4. Registrar métricas en:
   - Creación de recursos (counter)
   - Actualizaciones (counter)
   - Eliminaciones (counter)
   - Errores (counter)
   - Estados actuales (gauge)
   - Latencias de operaciones (timing)
5. Usar tags para categorizar métricas
6. Verificar métricas se registran correctamente

**Complejidad:** 3 Story Points
**Tiempo estimado:** 1-2 horas

---

### **Fase 3 — Trazabilidad con Correlation IDs**

1. Usar `context.correlationId` disponible automáticamente en handlers HTTP
2. Incluir correlationId en TODOS los logs:
   ```javascript
   this.logger.info('todo.created', {
     todoId: todo.id,
     correlationId: context.correlationId
   });
   ```
3. Propagar correlationId en eventos publicados:
   ```javascript
   await this.eventBus.publish('todo.created', payload, {
     correlationId: context.correlationId
   });
   ```
4. En event handlers, usar correlationId del evento recibido
5. Implementar búsqueda de logs por correlationId
6. Documentar flujos con correlation IDs
7. Probar rastreo completo de un request

**Complejidad:** 2 Story Points
**Tiempo estimado:** 1 hora

---

### **Fase 4 — Métricas de sistema y Health Check**

1. Implementar reporte periódico de métricas de sistema:
   - Uso de memoria (heap used, heap total, RSS)
   - Uso de CPU (user, system)
   - Tamaño de colecciones en memoria
2. Crear endpoint `/health` que retorne:
   - Status: healthy/unhealthy
   - Uptime del proceso
   - Timestamp actual
   - Versión del módulo
   - Checks de dependencias (DB, EventBus, etc.)
3. Crear endpoint `/metrics` que retorne:
   - Counters: valores acumulados
   - Gauges: valores actuales
   - Timings: promedios, min, max
4. Formato de respuesta: JSON estructurado
5. Probar ambos endpoints con curl

**Complejidad:** 3 Story Points
**Tiempo estimado:** 1-2 horas

---

### **Fase 5 — Dashboard de métricas (opcional)**

1. Agregar sección `ui.views.dashboard` en `module.json`
2. Crear widgets de estadísticas:
   - Stat widgets para counters principales
   - Gráficas para tendencias
   - Tablas para métricas detalladas
3. Configurar auto-refresh (ej: cada 10 segundos)
4. Implementar endpoints de estadísticas si no existen
5. Probar dashboard en navegador
6. Verificar actualización automática

**Complejidad:** 8 Story Points
**Tiempo estimado:** 4-5 horas

---

## 🧠 3. Buenas prácticas (Best Practices)

✅ **Logs estructurados** en JSON (no strings planos)
✅ **Correlation IDs** en TODOS los logs y eventos
✅ **Niveles apropiados** (debug para desarrollo, info para producción)
✅ **No loggear datos sensibles** (passwords, tokens, PII)
✅ **Métricas significativas** (de negocio, no solo técnicas)
✅ **Nomenclatura consistente** para métricas (entity.action.type)
✅ **Tags/labels** en métricas para filtrado
✅ **Health checks** completos y útiles
✅ **Dashboards accionables** con métricas clave
✅ **Alertas configuradas** para eventos críticos (en producción)
✅ **Sampling** en producción para reducir volumen de logs
✅ **Rotación de logs** para evitar llenar disco

---

## 📋 4. Checklist de entrega

**Logging:**
- [ ] Logger integrado en módulo (desde moduleAPI)
- [ ] Logs estructurados en formato JSON
- [ ] Correlation IDs en todos los logs
- [ ] Niveles apropiados (debug, info, warn, error)
- [ ] No loggear datos sensibles
- [ ] Logs de inicio/fin de operaciones importantes
- [ ] Logs de errores con stack trace completo

**Métricas:**
- [ ] Métricas de negocio registradas (counters, gauges, timings)
- [ ] Métricas de sistema registradas (memoria, CPU)
- [ ] Nomenclatura consistente y documentada
- [ ] Tags/labels para categorización
- [ ] Endpoint `/metrics` implementado
- [ ] Endpoint `/health` implementado

**Observabilidad:**
- [ ] Correlation IDs propagados en eventos
- [ ] Logs estructurados con contexto completo
- [ ] Dashboard de métricas funcional (opcional)
- [ ] Health checks funcionando correctamente
- [ ] Documentación de métricas disponibles

---

## 🧾 5. Ejemplo de implementación completa

```javascript
/**
 * TODO List Module con Observabilidad Completa
 */
class TodoListModule {
  constructor() {
    this.name = 'todo-list';
    this.todos = new Map();
    this.nextId = 1;

    // Estadísticas para métricas
    this.stats = {
      created: 0,
      updated: 0,
      deleted: 0,
      completed: 0,
      errors: 0,
      createDurations: []
    };
  }

  async onLoad(moduleAPI) {
    this.logger = moduleAPI.logger;
    this.metrics = moduleAPI.metrics;
    this.eventBus = moduleAPI.eventBus;

    this.logger.info('module.loaded', {
      module: this.name,
      version: '1.0.0'
    });

    // Iniciar reporte de métricas de sistema
    this.startSystemMetricsReporting();
  }

  startSystemMetricsReporting() {
    setInterval(() => {
      const memUsage = process.memoryUsage();

      this.metrics.gauge('system.memory.heap.used', memUsage.heapUsed);
      this.metrics.gauge('system.memory.heap.total', memUsage.heapTotal);
      this.metrics.gauge('system.memory.rss', memUsage.rss);
      this.metrics.gauge('todo.collection.size', this.todos.size);
    }, 10000); // Cada 10 segundos
  }

  async handleCreateTodo(req, context) {
    const startTime = Date.now();

    this.logger.info('todo.create.start', {
      correlationId: context.correlationId,
      userId: context.user?.id
    });

    try {
      const { title, description } = context.body;

      const todo = {
        id: this.nextId++,
        title,
        description,
        completed: false,
        createdAt: new Date().toISOString()
      };

      this.todos.set(todo.id, todo);

      // Actualizar estadísticas
      this.stats.created++;
      const duration = Date.now() - startTime;
      this.stats.createDurations.push(duration);

      // Métricas
      this.metrics.increment('todo.created.total');
      this.metrics.gauge('todo.active.count', this.todos.size);
      this.metrics.timing('todo.create.duration', duration);

      // Evento
      await this.eventBus.publish('todo.created', {
        todoId: todo.id,
        title: todo.title
      }, {
        correlationId: context.correlationId
      });

      // Log de éxito
      this.logger.info('todo.created', {
        todoId: todo.id,
        title: todo.title,
        duration: duration,
        correlationId: context.correlationId
      });

      return { status: 201, data: todo };

    } catch (error) {
      this.stats.errors++;
      this.metrics.increment('todo.create.errors', 1, {
        errorType: error.name
      });

      this.logger.error('todo.create.error', {
        error: error.message,
        stack: error.stack,
        correlationId: context.correlationId
      });

      throw error;
    }
  }

  async handleGetMetrics(req, context) {
    const avgDuration = this.stats.createDurations.length > 0
      ? this.stats.createDurations.reduce((a, b) => a + b, 0) / this.stats.createDurations.length
      : 0;

    const completedCount = Array.from(this.todos.values())
      .filter(t => t.completed).length;

    const completionRate = this.todos.size > 0
      ? (completedCount / this.todos.size) * 100
      : 0;

    return {
      status: 200,
      data: {
        counters: {
          'todo.created.total': this.stats.created,
          'todo.updated.total': this.stats.updated,
          'todo.deleted.total': this.stats.deleted,
          'todo.completed.total': this.stats.completed,
          'todo.errors.total': this.stats.errors
        },
        gauges: {
          'todo.active.count': this.todos.size,
          'todo.completed.count': completedCount,
          'todo.completion.rate': completionRate
        },
        timings: {
          'todo.create.avg_duration': avgDuration.toFixed(2),
          'todo.create.min_duration': Math.min(...this.stats.createDurations) || 0,
          'todo.create.max_duration': Math.max(...this.stats.createDurations) || 0
        }
      }
    };
  }

  async handleHealthCheck(req, context) {
    const isHealthy = this.todos.size < 10000; // Ejemplo de check

    return {
      status: isHealthy ? 200 : 503,
      data: {
        status: isHealthy ? 'healthy' : 'unhealthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        checks: {
          todos: {
            healthy: isHealthy,
            count: this.todos.size,
            limit: 10000
          }
        }
      }
    };
  }
}

module.exports = TodoListModule;
```

---

## 🧾 6. Ejemplo de `module.json` con endpoints de monitoreo

```json
{
  "name": "todo-list",
  "apis": [
    {
      "method": "GET",
      "path": "/metrics",
      "handler": "handleGetMetrics",
      "description": "Get module metrics"
    },
    {
      "method": "GET",
      "path": "/health",
      "handler": "handleHealthCheck",
      "description": "Health check endpoint"
    }
  ]
}
```

---

## ⚡ 7. Consultas de logs y métricas

```bash
# Ver logs en tiempo real
tail -f logs/todo-list.log

# Buscar logs por correlationId
grep "req_abc123" logs/*.log | jq .

# Buscar errores
grep '"level":"error"' logs/*.log | jq .

# Contar eventos por tipo
grep '"event":"todo.created"' logs/*.log | wc -l

# Ver métricas
curl http://localhost:3000/modules/todo-list/metrics | jq .

# Ver health check
curl http://localhost:3000/modules/todo-list/health | jq .

# Analizar tiempos de respuesta
grep '"event":"todo.created"' logs/*.log | jq '.data.duration' | \
  awk '{sum+=$1; count++} END {print "Avg:", sum/count, "ms"}'

# Ver últimos errores
grep '"level":"error"' logs/*.log | tail -5 | jq .
```

---

## 🧾 8. Ejemplo de formato de log

```json
{
  "timestamp": "2025-01-14T10:30:45.123Z",
  "level": "info",
  "event": "todo.created",
  "module": "todo-list",
  "correlationId": "req_abc123xyz",
  "data": {
    "todoId": 42,
    "title": "Comprar leche",
    "duration": 15
  },
  "hostname": "server-01",
  "pid": 12345
}
```

---

## 📦 9. Convenciones del Agente Núcleo

- Logs: formato JSON estructurado obligatorio
- Event names: dot notation (`todo.created`, `user.login`)
- Correlation IDs: incluir en TODOS los logs
- Métricas: nomenclatura `entity.action.type`
- Tags: usar objeto para categorizar métricas
- Health checks: retornar 200 (healthy) o 503 (unhealthy)
- Endpoint /metrics: retornar JSON con counters, gauges, timings
- Endpoint /health: retornar status, uptime, checks
- No loggear: passwords, tokens, PII, datos sensibles
- Niveles: debug (desarrollo), info (producción normal), warn (anomalías), error (fallos)

---

## 🧭 10. Formato de salida esperado

Debes retornar:

1. **Resumen de observabilidad implementada**
   - Logs implementados (eventos loggeados)
   - Métricas registradas (counters, gauges, timings)
   - Endpoints de monitoreo creados

2. **Lista de métricas**
   - Nombre de métrica
   - Tipo (counter, gauge, timing)
   - Descripción y propósito
   - Tags usados

3. **Ejemplos de logs**
   - Log de inicio de operación
   - Log de éxito
   - Log de error
   - Todos con correlationId

4. **Respuestas de endpoints**
   - Ejemplo de respuesta de /metrics
   - Ejemplo de respuesta de /health

5. **Comandos de consulta**
   - Comandos grep para buscar logs
   - Comandos curl para ver métricas
   - Comandos para análisis de logs

6. **Dashboard** (si implementado)
   - Configuración de widgets
   - Endpoints que alimentan widgets
   - Captura o descripción visual

7. **Contenido completo de archivos**
   - `index.js` con logging y métricas
   - `module.json` con endpoints
   - Handlers de metrics y health

8. **Checklist completado**
   - Marcar cada ítem como ✅ o ❌

---

## 🧩 11. Reglas operativas

- **Logs estructurados siempre** (JSON, no strings)
- **Correlation IDs obligatorios** en todos los logs
- **No loggear datos sensibles** (passwords, tokens, PII)
- **Métricas de negocio primero** (luego técnicas)
- **Nomenclatura consistente** (entity.action.type)
- **Tags para categorizar** métricas
- **Health checks útiles** (no solo "OK")
- **Endpoints eficientes** (no consultas pesadas)
- **Dashboards accionables** (métricas que importan)
- **Documentar métricas** (qué miden y por qué)

---

## 🔄 12. Capa de Consolidación (al finalizar)

### **Estado de observabilidad**
- ✅ Logging estructurado funcionando
- ✅ Métricas de negocio registrándose
- ✅ Correlation IDs propagándose
- ✅ Endpoints /metrics y /health funcionando
- ⚠️ Dashboard implementado (o pendiente)

### **Pendientes**
- Tests unitarios de métricas
- Integración con Prometheus/Grafana (producción)
- Alertas configuradas
- Rotación de logs automática
- Sampling de logs en producción

### **Próximos pasos**
- Agregar más métricas de sistema
- Crear alertas en métricas críticas
- Integrar con sistema de monitoreo externo
- Implementar distributed tracing completo
- Optimizar volumen de logs

### **Métricas de implementación**
- Total de eventos loggeados: X tipos
- Total de métricas registradas: X (Y counters, Z gauges, W timings)
- Endpoints de monitoreo: 2 (/metrics, /health)
- Correlation IDs: 100% cobertura

---

**Versión del prompt:** 1.0.0
**Fecha:** 2025-01-14
**Compatible con:** Event Core v0.5.0+
