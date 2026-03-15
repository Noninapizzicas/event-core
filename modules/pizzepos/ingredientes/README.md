# Módulo Ingredientes v1.0

**Catálogo de ingredientes - Actualizado desde menús generados por IA**

## 🎯 Responsabilidad

Mantener el catálogo unificado de ingredientes extraídos automáticamente de menús generados por IA. Registra ingredientes con sus propiedades (tipo, emoji, alérgenos) y los hace disponibles para otros módulos.

## ✅ Características

- ✅ **100% Event-Driven** - Comunica SOLO via `eventBus.publish()` / `subscribe()`
- ✅ **Actualización Automática** - Sincroniza desde `menu.generado` y `producto.creado`
- ✅ **Gestión de Alérgenos** - Detecta y registra ingredientes alérgenos
- ✅ **JSON Schema Validation** - Contratos formales
- ✅ **Logging estructurado** - Todos los logs con `correlationId`
- ✅ **Métricas completas** - Counters, gauges, timings
- ✅ **< 300 líneas** - Módulo simple y mantenible

## 🔄 Flujo de Trabajo

```
menu.generado (MQTT) → ingredientes
    ↓
Extraer ingredientes_catalogo
    ↓
Por cada ingrediente:
  - Si no existe → crear nuevo
  - Si existe → actualizar propiedades
    ↓
Publicar ingrediente.creado (MQTT)
    ↓
Otros módulos reaccionan:
  - variaciones: Configura ingredientes removibles/añadibles
  - alergenos: Actualiza listado de alérgenos
  - analytics: Tracking de ingredientes populares
```

## 📦 Eventos Publicados

### `ingrediente.creado`

Nuevo ingrediente creado desde menú generado.

```json
{
  "event_type": "ingrediente.creado",
  "payload": {
    "ingrediente_id": "ing_tomate",
    "nombre": "Salsa de tomate",
    "emoji": "🍅",
    "tipo": "base",
    "es_alergeno": false,
    "alergenos": [],
    "created_at": "2025-01-17T10:00:00Z"
  }
}
```

### `ingrediente.actualizado`

Ingrediente actualizado (precio, disponibilidad, etc).

```json
{
  "event_type": "ingrediente.actualizado",
  "payload": {
    "ingrediente_id": "ing_mozzarella",
    "cambios": {
      "precio_extra": {
        "anterior": 1.00,
        "nuevo": 1.50
      },
      "disponible": {
        "anterior": true,
        "nuevo": false
      }
    },
    "updated_at": "2025-01-17T10:05:00Z"
  }
}
```

## 📡 Eventos Suscritos

### `menu.generado`

Menú generado por IA - extraer ingredientes del catálogo.

**Acción:**
1. Extraer `ingredientes_catalogo` del payload
2. Por cada ingrediente:
   - Si no existe → crear y publicar `ingrediente.creado`
   - Si existe → actualizar y publicar `ingrediente.actualizado`

### `producto.creado`

Producto creado - registrar ingredientes.

**Acción:**
1. Extraer `ingredientes_base` del payload
2. Registrar ingredientes que no existan en catálogo

## 🔌 APIs HTTP

| Método | Path | Descripción |
|--------|------|-------------|
| GET | `/ingredientes` | Listar ingredientes (filtros: tipo, alergeno) |
| GET | `/ingredientes/:id` | Obtener ingrediente por ID |
| GET | `/ingredientes/search?q=` | Buscar ingredientes |
| GET | `/alergenos` | Listar ingredientes alérgenos agrupados |
| PATCH | `/ingredientes/:id` | Actualizar ingrediente |
| GET | `/health` | Health check |
| GET | `/metrics` | Métricas del módulo |

## 📊 Métricas

**Counters:**
- `ingrediente.creado.total` - Total de ingredientes creados
- `ingrediente.actualizado.total` - Total de actualizaciones

**Gauges:**
- `ingrediente.total.count` - Total de ingredientes en catálogo
- `ingrediente.alergenos.count` - Ingredientes alérgenos

**Timings:**
- `ingrediente.sync.duration` - Latencia de sincronización

## 🧪 Ejemplos de Uso

### Listar ingredientes

```bash
# Todos los ingredientes
curl http://localhost:3339/modules/ingredientes/ingredientes

# Solo alérgenos
curl http://localhost:3339/modules/ingredientes/ingredientes?alergeno=true

# Por tipo
curl http://localhost:3339/modules/ingredientes/ingredientes?tipo=proteina
```

**Respuesta:**
```json
{
  "status": 200,
  "data": {
    "ingredientes": [
      {
        "id": "ing_mozzarella",
        "nombre": "Mozzarella",
        "emoji": "🧀",
        "tipo": "proteina",
        "es_alergeno": true,
        "alergenos": ["lactosa"],
        "disponible": true,
        "precio_extra": 1.50
      }
    ],
    "total": 1
  }
}
```

### Listar alérgenos agrupados

```bash
curl http://localhost:3339/modules/ingredientes/alergenos
```

**Respuesta:**
```json
{
  "status": 200,
  "data": {
    "alergenos": [...],
    "total": 8,
    "por_tipo": {
      "gluten": [
        {"id": "ing_harina", "nombre": "Harina de trigo", "emoji": "🌾"}
      ],
      "lactosa": [
        {"id": "ing_mozzarella", "nombre": "Mozzarella", "emoji": "🧀"},
        {"id": "ing_parmesano", "nombre": "Parmesano", "emoji": "🧀"}
      ],
      "frutos_secos": [
        {"id": "ing_nueces", "nombre": "Nueces", "emoji": "🥜"}
      ]
    }
  }
}
```

### Buscar ingredientes

```bash
curl http://localhost:3339/modules/ingredientes/ingredientes/search?q=queso
```

### Actualizar ingrediente

```bash
curl -X PATCH http://localhost:3339/modules/ingredientes/ingredientes/ing_mozzarella \
  -H "Content-Type: application/json" \
  -d '{
    "precio_extra": 1.80,
    "disponible": true
  }'
```

## 🏗️ Arquitectura

```
menu.generado (MQTT)
    ↓
onMenuGenerado()
    ↓
ingredientes_catalogo.forEach()
    ↓
    ├── Ingrediente nuevo?
    │   └── publishIngredienteCreado() → MQTT
    └── Ingrediente existente?
        └── publishIngredienteActualizado() → MQTT
    ↓
variaciones module reacciona
alergenos module reacciona
```

**NO hay HTTP interno.** Solo eventos MQTT.

## 📝 Tipos de Ingredientes

- `base` - Bases (masa, salsa tomate, etc)
- `proteina` - Proteínas (quesos, carnes, pescados)
- `vegetal` - Vegetales (tomate, cebolla, pimiento)
- `condimento` - Condimentos (orégano, albahaca, pimienta)
- `salsa` - Salsas (barbacoa, carbonara, pesto)
- `topping` - Toppings adicionales
- `otro` - Otros

## 🔍 Alérgenos Soportados

- `gluten` - Cereales con gluten
- `lactosa` - Leche y derivados
- `huevo` - Huevo y derivados
- `pescado` - Pescado
- `marisco` - Crustáceos y moluscos
- `frutos_secos` - Frutos de cáscara
- `soja` - Soja y derivados
- `apio` - Apio y derivados
- `mostaza` - Mostaza
- `sesamo` - Granos de sésamo
- `sulfitos` - Dióxido de azufre y sulfitos
- `altramuces` - Altramuces

## 🧩 Integración con Otros Módulos

```
ingredientes
    ↓ ingrediente.creado
variaciones ← Configura ingredientes removibles/añadibles
    ↓ ingrediente.creado
alergenos ← Actualiza alertas de alérgenos
    ↓ ingrediente.actualizado
analytics ← Tracking de ingredientes populares
```

**Todo via eventos MQTT.**

## 📊 Estadísticas de Catálogo

```javascript
{
  "total": 45,
  "alergenos": 12,
  "por_tipo": {
    "base": 5,
    "proteina": 15,
    "vegetal": 18,
    "condimento": 7
  }
}
```

---

**Versión:** 1.0.0
**Líneas de código:** ~280
**Cumplimiento prompts:** 100%
**Basado en:** TEMPLATE_MODULO.md
