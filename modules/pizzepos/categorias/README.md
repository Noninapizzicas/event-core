# Módulo Categorias v1.0

**Catálogo de categorías de productos - Actualizado desde menús generados**

## 🎯 Responsabilidad

Mantener el catálogo de categorías de productos, sincronizado automáticamente desde menús generados por IA. Gestiona orden de visualización y estado activo/inactivo.

## ✅ Características

- ✅ **100% Event-Driven** - Comunica SOLO via `eventBus.publish()` / `subscribe()`
- ✅ **Sincronización Automática** - Desde `menu.generado`
- ✅ **Gestión de Orden** - Reordenamiento dinámico de categorías
- ✅ **JSON Schema Validation** - Contratos formales
- ✅ **Logging estructurado** - Todos los logs con `correlationId`
- ✅ **Métricas completas** - Counters, gauges
- ✅ **< 250 líneas** - Módulo simple y mantenible

## 🔄 Flujo de Trabajo

```
menu.generado (MQTT) → categorias
    ↓
Extraer categorias del payload
    ↓
Por cada categoría:
  - Si no existe → crear nueva
  - Si existe → actualizar (emoji, nombre)
    ↓
Publicar categoria.creada (MQTT)
    ↓
Otros módulos reaccionan:
  - ui-menu: Renderiza categorías en orden
  - analytics: Tracking de categorías populares
```

## 📦 Eventos Publicados

### `categoria.creada`

Nueva categoría creada.

```json
{
  "event_type": "categoria.creada",
  "payload": {
    "categoria_id": "cat_pizzas",
    "nombre": "Pizzas",
    "emoji": "🍕",
    "orden": 0,
    "created_at": "2025-01-17T10:00:00Z"
  }
}
```

### `categoria.actualizada`

Categoría actualizada.

```json
{
  "event_type": "categoria.actualizada",
  "payload": {
    "categoria_id": "cat_pizzas",
    "cambios": {
      "emoji": {
        "anterior": "📋",
        "nuevo": "🍕"
      }
    },
    "updated_at": "2025-01-17T10:05:00Z"
  }
}
```

### `categoria.orden_actualizado`

Orden de categorías actualizado.

```json
{
  "event_type": "categoria.orden_actualizado",
  "payload": {
    "nuevo_orden": [
      {"categoria_id": "cat_pizzas", "orden": 0},
      {"categoria_id": "cat_pastas", "orden": 1},
      {"categoria_id": "cat_ensaladas", "orden": 2}
    ]
  }
}
```

## 📡 Eventos Suscritos

### `menu.generado`

Menú generado - sincronizar categorías.

**Acción:**
1. Extraer `categorias` del payload
2. Por cada categoría:
   - Si no existe → crear y publicar `categoria.creada`
   - Si existe → actualizar y publicar `categoria.actualizada`

## 🔌 APIs HTTP

| Método | Path | Descripción |
|--------|------|-------------|
| GET | `/categorias` | Listar categorías ordenadas |
| GET | `/categorias/:id` | Obtener categoría por ID |
| POST | `/categorias` | Crear categoría manualmente |
| PATCH | `/categorias/:id` | Actualizar categoría |
| POST | `/categorias/reorder` | Reordenar categorías |
| GET | `/health` | Health check |
| GET | `/metrics` | Métricas del módulo |

## 📊 Métricas

**Counters:**
- `categoria.creada.total` - Total de categorías creadas
- `categoria.actualizada.total` - Total de actualizaciones

**Gauges:**
- `categoria.total.count` - Total de categorías
- `categoria.activas.count` - Categorías activas

## 🧪 Ejemplos de Uso

### Listar categorías

```bash
curl http://localhost:3339/modules/categorias/categorias
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
        "activa": true
      },
      {
        "id": "cat_pastas",
        "nombre": "Pastas",
        "emoji": "🍝",
        "orden": 1,
        "activa": true
      }
    ],
    "total": 2
  }
}
```

### Crear categoría manualmente

```bash
curl -X POST http://localhost:3339/modules/categorias/categorias \
  -H "Content-Type: application/json" \
  -d '{
    "nombre": "Postres",
    "emoji": "🍰",
    "descripcion": "Deliciosos postres caseros",
    "color": "#FF6B9D"
  }'
```

### Reordenar categorías

```bash
curl -X POST http://localhost:3339/modules/categorias/categorias/reorder \
  -H "Content-Type: application/json" \
  -d '{
    "orden": [
      {"categoria_id": "cat_postres"},
      {"categoria_id": "cat_pizzas"},
      {"categoria_id": "cat_pastas"}
    ]
  }'
```

**Evento publicado:**
```
Topic: core/core-a/events/categoria/orden_actualizado
```

### Actualizar categoría

```bash
curl -X PATCH http://localhost:3339/modules/categorias/categorias/cat_pizzas \
  -H "Content-Type: application/json" \
  -d '{
    "emoji": "🍕🔥",
    "color": "#FF4444"
  }'
```

## 🏗️ Arquitectura

```
menu.generado (MQTT)
    ↓
onMenuGenerado()
    ↓
categorias.forEach()
    ↓
    ├── Categoría nueva?
    │   └── publishCategoriaCreada() → MQTT
    └── Categoría existente?
        └── publishCategoriaActualizada() → MQTT
    ↓
ui-menu module reacciona
analytics module reacciona
```

**NO hay HTTP interno.** Solo eventos MQTT.

## 📝 Estructura de Categoría

```json
{
  "id": "cat_pizzas",
  "nombre": "Pizzas",
  "emoji": "🍕",
  "orden": 0,
  "activa": true,
  "descripcion": "Nuestras deliciosas pizzas",
  "color": "#FF6347",
  "icono": "pizza-slice",
  "created_at": "2025-01-17T10:00:00Z",
  "updated_at": "2025-01-17T10:00:00Z"
}
```

## 🎨 UI Integration

Las categorías definen:
- **orden** - Posición en menú (0 = primera)
- **emoji** - Icono visual principal
- **color** - Color de tema para UI
- **icono** - Nombre de icono alternativo

```javascript
// Ejemplo en UI
categorias.forEach(cat => {
  renderCategory({
    title: `${cat.emoji} ${cat.nombre}`,
    color: cat.color,
    order: cat.orden
  });
});
```

## 🧩 Integración con Otros Módulos

```
categorias
    ↓ categoria.creada
ui-menu ← Renderiza categoría en menú
    ↓ categoria.orden_actualizado
ui-menu ← Re-renderiza orden de categorías
    ↓ categoria.actualizada
analytics ← Actualiza métricas
```

**Todo via eventos MQTT.**

## 📊 Ordenamiento

- **Orden automático:** Categorías de menú IA reciben orden según aparición
- **Orden manual:** Endpoint `/reorder` permite cambiar orden
- **Persistencia:** Orden se mantiene entre sincronizaciones

```javascript
// Auto-orden desde menú IA
cat_pizzas: orden = 0
cat_pastas: orden = 1
cat_ensaladas: orden = 2

// Después de reorder manual
cat_ensaladas: orden = 0  // ← Ahora primero
cat_pizzas: orden = 1
cat_pastas: orden = 2
```

## 🔄 Sincronización con Menú

Cuando llega `menu.generado`:
1. **Categorías nuevas** → Se crean con orden automático
2. **Categorías existentes** → Se actualizan (emoji, nombre) pero mantienen orden personalizado
3. **Categorías no presentes** → Se mantienen (no se desactivan)

Esto permite:
- Agregar categorías manualmente
- Personalizar orden
- Mantener categorías custom entre actualizaciones de menú

---

**Versión:** 1.0.0
**Líneas de código:** ~240
**Cumplimiento prompts:** 100%
**Basado en:** TEMPLATE_MODULO.md
