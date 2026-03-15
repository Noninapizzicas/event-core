# Módulo Persistencia v1.0

**Persistencia de eventos y ventas en archivos JSON**

## 🎯 Responsabilidad

Guardar **todos los eventos críticos** del sistema en archivos JSON para auditoría, análisis y cuadre de caja. Sistema de event sourcing con tres archivos principales:

1. **eventos.json** - Todos los eventos en orden cronológico (event sourcing)
2. **ventas.json** - Solo transacciones completadas (para cuadre de caja)
3. **cuentas_activas.json** - Cuentas abiertas (recuperación tras reinicio)

## ✅ Características

- ✅ **Event Sourcing** - Todos los eventos guardados cronológicamente
- ✅ **Cuentas Activas** - Persistencia de mesas/pedidos abiertos (recuperación tras reinicio)
- ✅ **Cuadre de Caja** - Resumen diario de ventas por método de pago
- ✅ **Rotación Diaria** - Archivos separados por fecha
- ✅ **Backup** - Sistema de backups bajo demanda
- ✅ **Sin Base de Datos** - Solo archivos JSON (fácil backup/restore)
- ✅ **Auditoría Total** - Reconstruir cualquier operación
- ✅ **Varios Comanderos** - Todos ven las mismas cuentas activas
- ✅ **< 600 líneas** - Código simple

## 📁 Estructura de Archivos

```
data/
├── current/
│   ├── eventos.json          # Eventos del día actual (append-only)
│   ├── ventas.json           # Ventas del día actual
│   └── cuentas_activas.json  # Cuentas abiertas (actualizado en tiempo real)
│
├── eventos/
│   ├── 2025-01-17.json       # Eventos archivados por día
│   ├── 2025-01-18.json
│   └── 2025-01-19.json
│
├── ventas/
│   ├── 2025-01-17.json       # Ventas archivadas por día
│   ├── 2025-01-18.json
│   └── 2025-01-19.json
│
└── backups/
    ├── backup_2025-01-17_1705501200/
    │   ├── eventos.json
    │   └── ventas.json
    └── backup_2025-01-18_1705587600/
```

## 📦 Eventos Escuchados

### Eventos de Cuentas
- `cuenta.creada`
- `cuenta.cerrada` → **Trigger creación de venta**

### Eventos de Cobros (CRÍTICO)
- `cobro.iniciado`
- `cobro.completado`
- `cobro.reembolsado`

### Eventos de Pedidos
- `pedido.creado`
- `pedido.enviado_cocina`
- `pedido.completado`

### Eventos Específicos por Canal
- `mesa.abierta`
- `mesa.cerrada`
- `telefono.pedido_creado`
- `llevar.ticket_creado`

## 📄 Formato de Archivos

### eventos.json - Event Sourcing Completo

```json
{
  "fecha": "2025-01-17",
  "eventos": [
    {
      "timestamp": "2025-01-17T13:00:15.234Z",
      "event_type": "mesa.abierta",
      "correlation_id": "corr_abc123",
      "payload": {
        "cuenta_id": "mesa_5_20250117_001",
        "numero_mesa": 5,
        "zona": "terraza",
        "camarero": "Juan Pérez"
      }
    },
    {
      "timestamp": "2025-01-17T13:05:22.456Z",
      "event_type": "pedido.creado",
      "correlation_id": "corr_abc124",
      "payload": {
        "pedido_id": "pedido_xyz",
        "cuenta_id": "mesa_5_20250117_001",
        "items": [
          {
            "producto_id": "prod_pizza_margarita",
            "nombre": "Pizza Margarita",
            "cantidad": 2,
            "precio_total": 25.00
          }
        ]
      }
    },
    {
      "timestamp": "2025-01-17T14:15:30.789Z",
      "event_type": "cobro.completado",
      "correlation_id": "corr_abc125",
      "payload": {
        "cobro_id": "cobro_123",
        "cuenta_id": "mesa_5_20250117_001",
        "monto": 45.50,
        "metodo_pago": "tarjeta",
        "propina": 5.00,
        "monto_total": 50.50
      }
    }
  ],
  "total_eventos": 3,
  "ultima_actualizacion": "2025-01-17T14:15:30.789Z"
}
```

### ventas.json - Solo Transacciones Completadas

```json
{
  "fecha": "2025-01-17",
  "ventas": [
    {
      "venta_id": "venta_1705501530789_abc123",
      "timestamp": "2025-01-17T14:15:30.789Z",
      "cuenta": {
        "cuenta_id": "mesa_5_20250117_001",
        "tipo": "mesa",
        "origen": "cuentas-mesa",
        "hora_apertura": "2025-01-17T13:00:15.234Z",
        "hora_cierre": "2025-01-17T14:15:30.789Z",
        "metadata": {
          "numero_mesa": 5,
          "zona": "terraza",
          "camarero": "Juan Pérez",
          "tiempo_ocupada": 75
        }
      },
      "cobro": {
        "cobro_id": "cobro_123",
        "monto": 45.50,
        "propina": 5.00,
        "monto_total": 50.50,
        "metodo_pago": "tarjeta",
        "referencia_pago": "REF_123456"
      },
      "pedidos": [
        {
          "pedido_id": "pedido_xyz",
          "items": [
            {
              "producto_id": "prod_pizza_margarita",
              "nombre": "Pizza Margarita",
              "cantidad": 2,
              "precio_unitario": 12.50,
              "precio_total": 25.00
            },
            {
              "producto_id": "prod_cerveza",
              "nombre": "Cerveza",
              "cantidad": 2,
              "precio_unitario": 3.00,
              "precio_total": 6.00
            }
          ],
          "total": 31.00
        }
      ],
      "resumen": {
        "subtotal": 45.50,
        "propina": 5.00,
        "total_final": 50.50
      }
    }
  ],
  "resumen_dia": {
    "total_ventas": 1,
    "total_ingresos": 50.50,
    "total_propinas": 5.00,
    "por_metodo_pago": {
      "efectivo": 0,
      "tarjeta": 50.50,
      "bizum": 0,
      "transferencia": 0
    },
    "por_tipo_cuenta": {
      "mesa": 50.50,
      "telefono": 0,
      "llevar": 0
    },
    "por_camarero": {
      "Juan Pérez": 50.50
    }
  },
  "ultima_actualizacion": "2025-01-17T14:15:30.789Z"
}
```

### cuentas_activas.json - Cuentas Abiertas (Recuperación tras Reinicio)

```json
{
  "fecha": "2025-01-17",
  "cuentas": {
    "mesa_5_20250117_001": {
      "cuenta_id": "mesa_5_20250117_001",
      "tipo": "mesa",
      "origen": "cuentas-mesa",
      "estado": "con_pedido",
      "datos_especificos": {
        "numero_mesa": 5,
        "zona": "terraza",
        "camarero": "Juan Pérez",
        "comensales": 3
      },
      "pedidos": [
        {
          "pedido_id": "pedido_xyz",
          "items": [...],
          "total": 25.00
        }
      ],
      "total": 25.00,
      "created_at": "2025-01-17T13:00:00.000Z",
      "updated_at": "2025-01-17T13:05:00.000Z"
    },
    "tel_20250117_032": {
      "cuenta_id": "tel_20250117_032",
      "tipo": "telefono",
      "origen": "cuentas-telefono",
      "estado": "preparando",
      "datos_especificos": {
        "numero_pedido": 32,
        "telefono": "+34666555444",
        "hora_recogida_estimada": "2025-01-17T14:30:00.000Z"
      },
      "pedidos": [...],
      "total": 28.50,
      "created_at": "2025-01-17T14:00:00.000Z",
      "updated_at": "2025-01-17T14:05:00.000Z"
    }
  },
  "total_cuentas": 2,
  "ultima_actualizacion": "2025-01-17T14:25:00.000Z"
}
```

**Flujo de Cuentas Activas:**

1. **Cuenta abierta** → Agregar a `cuentas_activas.json`
2. **Pedido agregado** → Actualizar total en `cuentas_activas.json`
3. **Cobro completado** → Remover de `cuentas_activas.json` + Crear en `ventas.json`

**Recuperación tras Reinicio:**

```javascript
// Al iniciar el sistema, cada módulo de cuentas lee sus cuentas activas
const response = await fetch('http://localhost:3339/modules/persistencia/cuentas-activas?tipo=mesa');
const data = await response.json();

// Restaurar estado de cada cuenta
for (const cuenta of data.cuentas) {
  // Recrear mesa en memoria
  this.mesasActivas.set(cuenta.datos_especificos.numero_mesa, cuenta);
}
```

**Beneficios:**
- ✅ Si se reinicia el sistema, no se pierden mesas ocupadas
- ✅ Varios comanderos (pantallas) ven las mismas cuentas
- ✅ Datos "calientes" siempre disponibles
- ✅ Recuperación automática del estado

## 🔌 APIs HTTP

| Método | Path | Descripción |
|--------|------|-------------|
| GET | `/cuentas-activas` | Cuentas abiertas (acepta ?tipo=mesa/telefono/llevar) |
| GET | `/eventos` | Eventos del día actual |
| GET | `/eventos/:fecha` | Eventos de fecha específica (YYYY-MM-DD) |
| GET | `/ventas` | Ventas del día actual |
| GET | `/ventas/:fecha` | Ventas de fecha específica |
| GET | `/cuadre-caja` | Cuadre de caja del día actual |
| GET | `/cuadre-caja/:fecha` | Cuadre de caja de fecha específica |
| POST | `/backup` | Crear backup manual |

## 🧪 Ejemplo de Uso

### Ver eventos del día actual
```bash
curl http://localhost:3339/modules/persistencia/eventos
```

Respuesta:
```json
{
  "fecha": "2025-01-17",
  "eventos": [...],
  "total": 156
}
```

### Ver eventos de una fecha específica
```bash
curl http://localhost:3339/modules/persistencia/eventos/2025-01-15
```

### Ver ventas del día
```bash
curl http://localhost:3339/modules/persistencia/ventas
```

### Cuadre de caja del día
```bash
curl http://localhost:3339/modules/persistencia/cuadre-caja
```

Respuesta:
```json
{
  "fecha": "2025-01-17",
  "timestamp": "2025-01-17T23:45:00.000Z",
  "cuadre": {
    "total_ventas": 85,
    "total_ingresos": 4250.50,
    "total_propinas": 320.00,
    "por_metodo_pago": {
      "efectivo": 1200.00,
      "tarjeta": 2500.50,
      "bizum": 450.00,
      "transferencia": 100.00
    },
    "por_tipo_cuenta": {
      "mesa": 3200.50,
      "telefono": 850.00,
      "llevar": 200.00
    },
    "por_camarero": {
      "Juan Pérez": 1500.00,
      "María García": 1800.50,
      "Pedro Martínez": 950.00
    }
  }
}
```

### Crear backup
```bash
curl -X POST http://localhost:3339/modules/persistencia/backup
```

Respuesta:
```json
{
  "message": "Backup creado exitosamente",
  "backup_name": "backup_2025-01-17_1705501200",
  "backup_path": "./data/backups/backup_2025-01-17_1705501200"
}
```

## 🔄 Flujo Típico

### Operación Normal

1. **Evento ocurre en el sistema**
   - Ej: `mesa.abierta`
   - Módulo persistencia lo escucha

2. **Guardar en eventos.json**
   - Append al array de eventos
   - Guardar archivo actualizado

3. **Si es cuenta.cerrada**
   - Buscar cobro asociado en eventos
   - Buscar pedidos asociados
   - Construir registro de venta completo
   - Guardar en ventas.json
   - Actualizar resumen del día

### Rotación Diaria (00:00)

1. **Detectar cambio de día**
2. **Mover archivos actuales**
   - `current/eventos.json` → `eventos/2025-01-17.json`
   - `current/ventas.json` → `ventas/2025-01-17.json`
3. **Limpiar caches**
4. **Crear archivos nuevos vacíos**

## 💡 Ventajas del Sistema JSON

### ✅ Simplicidad
- No necesitas instalar/configurar base de datos
- Archivos legibles directamente
- Fácil debugging (abre el JSON y ve qué pasó)

### ✅ Backup Trivial
```bash
# Backup = copiar carpeta data/
cp -r data/ backup_2025-01-17/
```

### ✅ Portabilidad
- Copiar archivos a otro servidor
- Importar/exportar fácil
- Compatible con cualquier sistema

### ✅ Event Sourcing Natural
- Reconstruir estado en cualquier momento
- Auditoría completa
- Replay de eventos

### ✅ Sin Dependencias
- Cero configuración
- Funciona en cualquier sistema con Node.js
- No necesitas credenciales, puertos, etc.

## ⚠️ Limitaciones

### ❌ Escalabilidad
- Archivos JSON grandes (>1MB) se vuelven lentos
- Solución: Rotar más frecuentemente (por turno en vez de por día)

### ❌ Concurrencia
- Write lock simple (un write a la vez)
- Para alto volumen considerar base de datos

### ❌ Queries Complejas
- No puedes hacer "SELECT WHERE..." directamente
- Necesitas parsear todo el JSON
- Para reportes complejos, considerar indexar en DB

## 🔧 Configuración

En `module.json`:
```json
{
  "config": {
    "data_dir": "./data",
    "eventos_dir": "./data/eventos",
    "ventas_dir": "./data/ventas",
    "current_dir": "./data/current",
    "backup_dir": "./data/backups",
    "rotacion_diaria": true,
    "rotacion_hora": "00:00"
  }
}
```

## 📊 Casos de Uso

### 1. Cuadre de Caja al Final del Turno
```bash
# Ver cuadre del día
curl http://localhost:3339/modules/persistencia/cuadre-caja

# Ver desglose por método de pago
# Ver total por camarero
# Ver propinas totales
```

### 2. Auditoría de Operación
```bash
# ¿Qué pasó en la cuenta mesa_5_20250117_001?
cat data/current/eventos.json | jq '.eventos[] | select(.payload.cuenta_id == "mesa_5_20250117_001")'

# Ver cronología completa
# Ver quién abrió, qué se pidió, cómo se pagó
```

### 3. Análisis de Ventas
```bash
# Ver ventas del día
curl http://localhost:3339/modules/persistencia/ventas

# Analizar productos más vendidos
cat data/ventas/2025-01-17.json | jq '.ventas[].pedidos[].items[] | .nombre' | sort | uniq -c

# Ver camareros top
cat data/ventas/2025-01-17.json | jq '.resumen_dia.por_camarero'
```

### 4. Backup Antes de Cerrar
```bash
# Crear backup del día
curl -X POST http://localhost:3339/modules/persistencia/backup

# Resultado: data/backups/backup_2025-01-17_timestamp/
```

## 🚀 Migración a Base de Datos (Futuro)

Si creces y necesitas DB, los eventos JSON facilitan migración:

```javascript
// Script de migración
const eventos = require('./data/eventos/2025-01-17.json');

for (const evento of eventos.eventos) {
  await db.query(
    'INSERT INTO eventos (timestamp, type, payload) VALUES ($1, $2, $3)',
    [evento.timestamp, evento.event_type, JSON.stringify(evento.payload)]
  );
}
```

## 📈 Métricas

```bash
curl http://localhost:3339/modules/persistencia/metrics
```

Respuesta:
```json
{
  "eventos_guardados": 1520,
  "ventas_guardadas": 85,
  "errores_escritura": 0,
  "eventos_dia": 156,
  "ventas_dia": 12
}
```

---

**Versión:** 1.0.0
**Líneas:** ~390
**Tipo:** Módulo de infraestructura
**Storage:** Archivos JSON (sin base de datos)
