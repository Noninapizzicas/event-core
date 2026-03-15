# Módulo Cocina v1.0

**Display de cocina en tiempo real - Sistema de preparación de pedidos**

## 🎯 Responsabilidad

Gestionar el display de cocina con actualizaciones en tiempo real. Recibe pedidos desde el módulo de pedidos, permite marcar items como preparados y notifica cuando los pedidos están listos para servir.

## ✅ Características

- ✅ **100% Event-Driven** - Solo MQTT
- ✅ **Tiempo Real** - SSE para actualizaciones live
- ✅ **Cola de Preparación** - Gestión de pedidos activos
- ✅ **Tracking de Items** - Estado individual de cada item
- ✅ **Métricas** - Tiempos de preparación promedio
- ✅ **Historial** - Últimos 50 pedidos completados
- ✅ **< 400 líneas** - Simple y mantenible

## 📦 Eventos Publicados

### `cocina.item_preparado`
```json
{
  "event_type": "cocina.item_preparado",
  "payload": {
    "pedido_id": "pedido_123",
    "item_id": "item_abc",
    "producto_id": "prod_pizza_margarita",
    "nombre": "Pizza Margarita",
    "cantidad": 2,
    "preparado_at": "2025-01-17T10:05:00Z"
  }
}
```

### `cocina.pedido_listo`
```json
{
  "event_type": "cocina.pedido_listo",
  "payload": {
    "pedido_id": "pedido_123",
    "numero_mesa": 5,
    "items_count": 3,
    "tiempo_preparacion": 420,
    "listo_at": "2025-01-17T10:07:00Z"
  }
}
```

## 🔔 Eventos Escuchados

- `pedido.enviado_cocina` - Nuevo pedido en cola
- `pedido.item_agregado` - Item añadido a pedido activo
- `pedido.cancelado` - Remover pedido de cola

## 🔌 APIs HTTP

| Método | Path | Descripción |
|--------|------|-------------|
| GET | `/cocina/activos` | Pedidos activos en cocina |
| GET | `/cocina/historial` | Últimos pedidos completados |
| GET | `/cocina/pedidos/:id` | Detalle de pedido |
| POST | `/cocina/items/:item_id/preparar` | Marcar item como preparado |
| POST | `/cocina/pedidos/:id/listo` | Marcar pedido completo listo |
| GET | `/cocina/stream` | SSE stream tiempo real |

## 🧪 Ejemplo de Uso

### Ver pedidos activos
```bash
curl http://localhost:3339/modules/cocina/cocina/activos
```

Respuesta:
```json
{
  "pedidos": [
    {
      "pedido_id": "pedido_123",
      "numero_mesa": 5,
      "items": [
        {
          "item_id": "item_abc",
          "nombre": "Pizza Margarita",
          "cantidad": 2,
          "estado": "pendiente",
          "variaciones": {
            "ingredientes_quitar": ["aceitunas"]
          },
          "notas": "Sin aceitunas por favor"
        }
      ],
      "estado": "activo",
      "recibido_at": "2025-01-17T10:00:00Z"
    }
  ],
  "total": 1,
  "items_pendientes": 1
}
```

### Marcar item como preparado
```bash
curl -X POST http://localhost:3339/modules/cocina/cocina/items/item_abc/preparar
```

Respuesta:
```json
{
  "item": {
    "item_id": "item_abc",
    "nombre": "Pizza Margarita",
    "estado": "listo",
    "preparado_at": "2025-01-17T10:05:00Z"
  },
  "pedido_completo": false
}
```

### Marcar pedido completo como listo
```bash
curl -X POST http://localhost:3339/modules/cocina/cocina/pedidos/pedido_123/listo
```

### Conectar a stream SSE (tiempo real)
```bash
curl -N http://localhost:3339/modules/cocina/cocina/stream
```

Eventos recibidos:
```
data: {"type":"connected","data":{"pedidos_activos":[...]}}

data: {"type":"nuevo_pedido","data":{...}}

data: {"type":"item_preparado","data":{...}}

data: {"type":"pedido_listo","data":{...}}
```

## 🔄 Flujo Típico

1. **Pedido llega a cocina**
   - Evento `pedido.enviado_cocina` recibido
   - Pedido añadido a cola activa
   - SSE notifica a displays

2. **Preparación de items**
   - Cocinero marca item como preparado
   - POST `/cocina/items/:item_id/preparar`
   - Evento `cocina.item_preparado` publicado
   - SSE actualiza displays

3. **Pedido completo**
   - Todos los items marcados como listos
   - Evento `cocina.pedido_listo` publicado
   - Pedido movido a historial
   - SSE notifica que está listo para servir

## 📊 Métricas

```bash
curl http://localhost:3339/modules/cocina/metrics
```

Respuesta:
```json
{
  "pedidos_recibidos": 150,
  "items_preparados": 420,
  "pedidos_listos": 148,
  "pedidos_cancelados": 2,
  "tiempo_promedio_preparacion": 385.5,
  "pedidos_activos": 2,
  "clientes_sse": 3
}
```

## 💡 Ventajas

- **Tiempo Real** - Displays actualizados instantáneamente
- **Sin Polling** - SSE push en vez de HTTP polling
- **Estado Granular** - Tracking a nivel de item individual
- **Métricas** - Tiempos de preparación para optimización
- **Simple** - < 400 líneas, fácil de entender

## 🎨 Integración con UI

### HTML + SSE básico
```javascript
const eventSource = new EventSource('http://localhost:3339/modules/cocina/cocina/stream');

eventSource.onmessage = (event) => {
  const message = JSON.parse(event.data);

  switch (message.type) {
    case 'nuevo_pedido':
      agregarPedidoADisplay(message.data);
      break;
    case 'item_preparado':
      marcarItemPreparado(message.data);
      break;
    case 'pedido_listo':
      notificarPedidoListo(message.data);
      break;
  }
};
```

---

**Versión:** 1.0.0
**Líneas:** ~390
**Reemplaza:** comandero-display, kitchen-screen
