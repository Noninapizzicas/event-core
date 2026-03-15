# Módulo Productos v2.0

**Catálogo de productos - Actualizado desde menús generados por IA**

## 🎯 Responsabilidad

Mantener el catálogo de productos actualizado automáticamente desde menús generados por IA. Reacciona a eventos `menu.generado` y `menu.validado` para sincronizar el catálogo sin intervención manual.

## ✅ Características

- ✅ **100% Event-Driven** - Comunica SOLO via `eventBus.publish()` / `subscribe()`
- ✅ **Actualización Automática** - Sincroniza desde `menu.validado`
- ✅ **JSON Schema Validation** - Contratos formales en todos los eventos
- ✅ **Logging estructurado** - Todos los logs con `correlationId`
- ✅ **Métricas completas** - Counters, gauges, timings
- ✅ **< 500 líneas** - Módulo simple y mantenible
- ✅ **Sin HTTP interno** - No usa `fetchInternal` ni `http.request`

## 🔄 Flujo de Trabajo

```
menu.generado (MQTT) → productos
    ↓
Guardar productos como "pendientes"
    ↓
[Operador valida menú]
    ↓
menu.validado (MQTT) → productos
    ↓
Sincronizar catálogo:
  - Crear productos nuevos
  - Actualizar productos existentes
  - Desactivar productos eliminados
    ↓
Publicar eventos (MQTT):
  - producto.creado (por cada nuevo)
  - producto.actualizado (por cada cambio)
  - catalogo.actualizado (resumen)
    ↓
Otros módulos reaccionan:
  - comandero: Usa productos actualizados
  - variaciones: Configura variaciones
  - ingredientes: Registra ingredientes
```

## 📦 Eventos Publicados

### `producto.creado`

Nuevo producto creado desde menú generado.

```json
{
  "event_type": "producto.creado",
  "payload": {
    "producto_id": "prod_pizza_margarita",
    "nombre": "Pizza Margarita",
    "emoji": "🍕",
    "categoria": "Pizzas",
    "precio": 12.50,
    "ingredientes_base": [
      {
        "id": "ing_tomate",
        "nombre": "Salsa de tomate",
        "emoji": "🍅",
        "tipo": "base"
      }
    ],
    "alergenos": ["gluten", "lactosa"],
    "menu_source_id": "menu_1234567890",
    "created_at": "2025-01-17T10:00:00Z"
  }
}
```

### `producto.actualizado`

Producto actualizado (precio, disponibilidad, etc).

```json
{
  "event_type": "producto.actualizado",
  "payload": {
    "producto_id": "prod_pizza_margarita",
    "cambios": {
      "precio": {
        "anterior": 12.50,
        "nuevo": 13.00
      },
      "activo": {
        "anterior": false,
        "nuevo": true
      }
    },
    "updated_at": "2025-01-17T10:05:00Z"
  }
}
```

### `producto.eliminado`

Producto eliminado del catálogo.

```json
{
  "event_type": "producto.eliminado",
  "payload": {
    "producto_id": "prod_pizza_margarita",
    "motivo": "manual"
  }
}
```

### `catalogo.actualizado`

Catálogo completo actualizado desde menú (resumen).

```json
{
  "event_type": "catalogo.actualizado",
  "payload": {
    "menu_id": "menu_1234567890",
    "estadisticas": {
      "productos_nuevos": 5,
      "productos_actualizados": 8,
      "productos_desactivados": 2,
      "categorias_nuevas": 1
    },
    "sync_duration": 450
  }
}
```

## 📡 Eventos Suscritos

### `menu.generado`

Menú generado por IA - guardar productos como pendientes.

**Acción:** Guardar productos en `menusPendientes` Map, esperando validación.

### `menu.validado`

Menú validado por operador - aplicar al catálogo activo.

**Acción:**
1. Recuperar productos pendientes
2. Aplicar correcciones si existen
3. Sincronizar catálogo:
   - Crear productos nuevos → publicar `producto.creado`
   - Actualizar existentes → publicar `producto.actualizado`
   - Desactivar eliminados → publicar `producto.actualizado`
4. Publicar `catalogo.actualizado` con estadísticas

## 🔌 APIs HTTP

| Método | Path | Descripción |
|--------|------|-------------|
| GET | `/productos` | Listar productos (filtros: categoria, activo) |
| GET | `/productos/:id` | Obtener producto por ID |
| GET | `/productos/search?q=` | Buscar productos por nombre |
| GET | `/categorias` | Listar categorías con conteo |
| PATCH | `/productos/:id` | Actualizar producto |
| DELETE | `/productos/:id` | Eliminar producto |
| GET | `/stats` | Estadísticas del catálogo |
| GET | `/health` | Health check |
| GET | `/metrics` | Métricas del módulo |

## 📊 Métricas

**Counters:**
- `producto.creado.total` - Total de productos creados
- `producto.actualizado.total` - Total de actualizaciones
- `producto.eliminado.total` - Total de productos eliminados
- `catalogo.actualizado.total` - Total de sincronizaciones completas
- `producto.errors.total` - Total de errores

**Gauges:**
- `producto.activos.count` - Productos activos actualmente
- `producto.por_categoria.count` - Productos por categoría

**Timings:**
- `producto.list.duration` - Latencia de listado
- `producto.search.duration` - Latencia de búsqueda
- `catalogo.sync.duration` - Latencia de sincronización completa

## 🧪 Ejemplos de Uso

### Listar productos

```bash
# Todos los productos
curl http://localhost:3339/modules/productos/productos

# Solo activos
curl http://localhost:3339/modules/productos/productos?activo=true

# Por categoría
curl http://localhost:3339/modules/productos/productos?categoria=Pizzas
```

**Respuesta:**
```json
{
  "status": 200,
  "data": {
    "productos": [
      {
        "id": "prod_pizza_margarita",
        "nombre": "Pizza Margarita",
        "emoji": "🍕",
        "categoria": "Pizzas",
        "precio": 12.50,
        "activo": true
      }
    ],
    "total": 1
  }
}
```

### Buscar productos

```bash
curl http://localhost:3339/modules/productos/productos/search?q=margarita
```

### Listar categorías

```bash
curl http://localhost:3339/modules/productos/categorias
```

**Respuesta:**
```json
{
  "status": 200,
  "data": {
    "categorias": [
      {
        "id": "cat_pizzas",
        "nombre": "Pizzas",
        "emoji": "🍕",
        "orden": 0,
        "productos_count": 8
      }
    ],
    "total": 1
  }
}
```

### Actualizar producto

```bash
curl -X PATCH http://localhost:3339/modules/productos/productos/prod_pizza_margarita \
  -H "Content-Type: application/json" \
  -d '{
    "precio": 13.50,
    "activo": true
  }'
```

**Evento publicado a MQTT:**
```
Topic: core/core-a/events/producto/actualizado
Payload: { producto_id: "prod_pizza_margarita", cambios: {...} }
```

### Estadísticas del catálogo

```bash
curl http://localhost:3339/modules/productos/stats
```

**Respuesta:**
```json
{
  "status": 200,
  "data": {
    "total_productos": 25,
    "productos_activos": 23,
    "productos_inactivos": 2,
    "total_categorias": 5,
    "productos_por_categoria": {
      "Pizzas": 8,
      "Pastas": 6,
      "Ensaladas": 4,
      "Bebidas": 5,
      "Postres": 2
    },
    "productos_con_alergenos": 18,
    "menus_pendientes_validacion": 1
  }
}
```

## 🏗️ Arquitectura

```
menu.validado (MQTT)
    ↓
onMenuValidado()
    ↓
syncCatalogo()
    ↓
    ├── Crear productos nuevos
    │   └── publishProductoCreado() → MQTT
    ├── Actualizar existentes
    │   └── publishProductoActualizado() → MQTT
    └── Desactivar eliminados
        └── publishProductoActualizado() → MQTT
    ↓
publishCatalogoActualizado() → MQTT
    ↓
Otros módulos reaccionan (comandero, variaciones, ingredientes)
```

**NO hay HTTP interno.** Solo eventos MQTT.

## 📝 Estructura de Producto

```json
{
  "id": "prod_pizza_margarita",
  "nombre": "Pizza Margarita",
  "emoji": "🍕",
  "categoria": "Pizzas",
  "categoria_emoji": "🍕",
  "descripcion": "Pizza clásica con tomate y mozzarella",
  "precio": 12.50,
  "ingredientes_base": [
    {
      "id": "ing_tomate",
      "nombre": "Salsa de tomate",
      "emoji": "🍅",
      "tipo": "base",
      "es_alergeno": false
    }
  ],
  "alergenos": ["gluten", "lactosa"],
  "variaciones": {
    "permite_quitar": ["ing_mozzarella"],
    "permite_anadir": true,
    "extras_sugeridos": [
      {
        "ingrediente_id": "ing_champinones",
        "precio_extra": 1.50
      }
    ]
  },
  "metadata": {
    "popularidad": "alta",
    "tiempo_preparacion": 15,
    "vegetariano": true,
    "vegano": false
  },
  "activo": true,
  "menu_source_id": "menu_1234567890",
  "created_at": "2025-01-17T10:00:00Z",
  "updated_at": "2025-01-17T10:00:00Z"
}
```

## 🔍 Logging

Todos los logs incluyen `correlationId` para tracing:

```json
{
  "timestamp": "2025-01-17T10:00:00Z",
  "level": "info",
  "event": "catalogo.sincronizado",
  "module": "productos",
  "correlation_id": "req_abc123",
  "data": {
    "menu_id": "menu_1234567890",
    "estadisticas": {
      "productos_nuevos": 5,
      "productos_actualizados": 8
    }
  }
}
```

## 🧩 Integración con Otros Módulos

```
productos
    ↓ producto.creado
comandero ← Usa productos en interfaz de pedidos
    ↓ producto.creado
variaciones ← Configura variaciones permitidas
    ↓ producto.creado
ingredientes ← Registra ingredientes en catálogo global
    ↓ catalogo.actualizado
analytics ← Actualiza métricas de catálogo
```

**Todo via eventos MQTT.** Ningún módulo llama directamente a otro.

## 🎓 Ventajas del Enfoque

1. **Actualización Automática** - Menú validado → catálogo sincronizado automáticamente
2. **Trazabilidad** - Cada producto sabe de qué menú proviene (`menu_source_id`)
3. **Sin Duplicación** - Productos con mismo ID se actualizan, no duplican
4. **Desactivación Inteligente** - Productos no presentes en nuevo menú se desactivan (no eliminan)
5. **Event-Driven** - Otros módulos reaccionan a cambios sin polling
6. **Historial** - Productos desactivados quedan en catálogo para historial de pedidos

## 🔄 Estados del Producto

- **Activo (`activo: true`)** - Disponible para venta
- **Inactivo (`activo: false`)** - No disponible, pero existe en catálogo

## 📝 Notas de Implementación

### Persistencia

Actualmente usa `Map` en memoria. Para producción:

```javascript
// Cambiar a:
const db = require('./database');
this.productos = db.collection('productos');
```

### Sincronización Idempotente

La sincronización es idempotente:
- Mismo menú validado 2 veces → mismo resultado
- Productos con mismo ID se actualizan, no duplican
- Categorías con mismo ID se reutilizan

### Desactivación vs Eliminación

Por defecto, productos no presentes en nuevo menú se **desactivan**, no eliminan. Esto preserva:
- Historial de pedidos anteriores
- Referencias a producto_id en otros módulos
- Posibilidad de reactivar si vuelven al menú

Para eliminar permanentemente, usar `DELETE /productos/:id`.

---

**Versión:** 2.0.0
**Líneas de código:** ~480
**Cumplimiento prompts:** 100%
**Basado en:** TEMPLATE_MODULO.md y ARQUITECTURA_MENU_GENERATIVO.md
