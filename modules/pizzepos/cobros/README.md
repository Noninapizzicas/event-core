# Módulo Cobros v1.0

**Gestión unificada de cobros - Múltiples métodos de pago**

## 🎯 Responsabilidad

Gestionar todos los cobros del restaurante con soporte para 7 métodos de pago: efectivo, tarjeta, bizum, transferencia, mixto, link de pago y QR. Unifica los 3 módulos legacy de pago en uno solo.

## ✅ Características

- ✅ **100% Event-Driven** - Solo MQTT
- ✅ **7 Métodos de Pago** - Efectivo, tarjeta, bizum, transferencia, mixto, link de pago, QR
- ✅ **Pago Mixto** - Split payment entre múltiples métodos
- ✅ **Links de Pago** - Generación de links para pago online (24h de expiración)
- ✅ **Códigos QR** - Generación de QR para pago rápido (30min de expiración)
- ✅ **Gestión de Propinas** - Soporte para propinas
- ✅ **Cálculo de Cambio** - Automático para efectivo (también en pagos mixtos)
- ✅ **Reembolsos** - Sistema de reembolsos
- ✅ **< 500 líneas** - Simple y mantenible

## 📦 Eventos Publicados

### `cobro.iniciado`
```json
{
  "event_type": "cobro.iniciado",
  "payload": {
    "cobro_id": "cobro_123",
    "cuenta_id": "cuenta_abc",
    "monto": 45.50,
    "metodo_pago": "tarjeta",
    "propina": 4.50
  }
}
```

### `cobro.completado`
```json
{
  "event_type": "cobro.completado",
  "payload": {
    "cobro_id": "cobro_123",
    "cuenta_id": "cuenta_abc",
    "monto_total": 50.00,
    "metodo_pago": "tarjeta",
    "referencia_pago": "REF_123",
    "completado_at": "2025-01-17T10:00:00Z"
  }
}
```

## 🔌 APIs HTTP

| Método | Path | Descripción |
|--------|------|-------------|
| POST | `/cobros` | Iniciar cobro |
| GET | `/cobros` | Listar cobros |
| GET | `/cobros/:id` | Obtener cobro |
| POST | `/cobros/:id/confirmar` | Confirmar cobro |
| POST | `/cobros/:id/reembolsar` | Reembolsar |
| GET | `/metodos-pago` | Métodos disponibles |

## 🧪 Ejemplo de Uso

### Iniciar cobro con propina
```bash
curl -X POST http://localhost:3339/modules/cobros/cobros \
  -H "Content-Type: application/json" \
  -d '{
    "cuenta_id": "cuenta_abc123",
    "monto": 45.50,
    "metodo_pago": "tarjeta",
    "propina": 4.50
  }'
```

### Cobro en efectivo con cambio
```bash
curl -X POST http://localhost:3339/modules/cobros/cobros \
  -d '{
    "cuenta_id": "cuenta_abc123",
    "monto": 45.50,
    "metodo_pago": "efectivo",
    "monto_recibido": 50.00
  }'
```

Respuesta incluye: `"cambio": 4.50`

### Cobro mixto (split payment)
```bash
curl -X POST http://localhost:3339/modules/cobros/cobros \
  -H "Content-Type: application/json" \
  -d '{
    "cuenta_id": "mesa_5_20250117_001",
    "monto": 80.00,
    "metodo_pago": "mixto",
    "propina": 5.00,
    "desglose": [
      {
        "metodo": "efectivo",
        "monto": 40.00,
        "monto_recibido": 50.00
      },
      {
        "metodo": "tarjeta",
        "monto": 45.00,
        "referencia": "VISA-1234"
      }
    ]
  }'
```

Respuesta:
```json
{
  "id": "cobro_123456",
  "cuenta_id": "mesa_5_20250117_001",
  "monto": 80.00,
  "metodo_pago": "mixto",
  "propina": 5.00,
  "monto_total": 85.00,
  "desglose": [
    {
      "metodo": "efectivo",
      "monto": 40.00,
      "monto_recibido": 50.00,
      "cambio": 10.00
    },
    {
      "metodo": "tarjeta",
      "monto": 45.00,
      "referencia": "VISA-1234"
    }
  ],
  "estado": "pendiente"
}
```

**Caso de uso:** Dos clientes en una mesa quieren pagar por separado, uno en efectivo y otro con tarjeta.

### Link de pago (para pedidos online/delivery)
```bash
curl -X POST http://localhost:3339/modules/cobros/cobros \
  -H "Content-Type: application/json" \
  -d '{
    "cuenta_id": "telefono_666123456_001",
    "monto": 32.50,
    "metodo_pago": "link_pago"
  }'
```

Respuesta:
```json
{
  "id": "cobro_789012",
  "cuenta_id": "telefono_666123456_001",
  "monto": 32.50,
  "metodo_pago": "link_pago",
  "link_url": "https://pay.pizzepos.com/checkout/pay_1705497600_abc123def",
  "expira_en": "2025-01-18T14:30:00.000Z",
  "estado": "pendiente",
  "estado_externo": "pendiente",
  "referencia_externa": "pay_1705497600_abc123def"
}
```

**Caso de uso:** Cliente llama por teléfono, se le envía el link por WhatsApp/SMS para que pague online antes de preparar el pedido.

**Flujo:**
1. Cliente hace pedido por teléfono
2. Empleado crea cobro con `metodo_pago: "link_pago"`
3. Sistema genera link único con 24h de expiración
4. Empleado envía link al cliente vía WhatsApp/SMS
5. Cliente paga desde su móvil
6. Sistema recibe webhook del gateway de pago
7. Cobro se marca como completado automáticamente

### Código QR (para pago rápido en mesa)
```bash
curl -X POST http://localhost:3339/modules/cobros/cobros \
  -H "Content-Type: application/json" \
  -d '{
    "cuenta_id": "mesa_8_20250117_003",
    "monto": 65.80,
    "metodo_pago": "qr",
    "propina": 4.20
  }'
```

Respuesta:
```json
{
  "id": "cobro_345678",
  "cuenta_id": "mesa_8_20250117_003",
  "monto": 65.80,
  "metodo_pago": "qr",
  "propina": 4.20,
  "monto_total": 70.00,
  "qr_data": "{\"type\":\"payment\",\"id\":\"qr_1705497600_xyz789\",\"amount\":70,\"currency\":\"EUR\",\"merchant\":\"PIZZEPOS\",\"reference\":\"cobro_345678\"}",
  "qr_url": "http://localhost:3339/modules/cobros/qr/qr_1705497600_xyz789.png",
  "expira_en": "2025-01-17T15:00:00.000Z",
  "estado": "pendiente",
  "estado_externo": "pendiente",
  "referencia_externa": "qr_1705497600_xyz789"
}
```

**Caso de uso:** Cliente en mesa quiere pagar con su móvil, escanea QR y paga con Bizum/Apple Pay/Google Pay sin interacción con camarero.

**Flujo:**
1. Cliente pide la cuenta en mesa
2. Camarero genera QR de pago desde TPV
3. Sistema genera QR con 30min de expiración
4. Se muestra QR en pantalla del comandero o se imprime en ticket
5. Cliente escanea QR con su móvil
6. Cliente paga con Bizum/wallet en su teléfono
7. Sistema recibe confirmación y marca cuenta como pagada
8. Mesa se libera automáticamente

## 💡 Ventajas vs Legacy

### ❌ Legacy (3 módulos separados)
- Duplicación de código
- Sin unificación
- Difícil mantenimiento

### ✅ Cobros v1.0 (unificado)
- Un solo módulo
- Código compartido
- Fácil añadir nuevos métodos

---

**Versión:** 1.1.0
**Líneas:** ~490
**Métodos:** 7 (efectivo, tarjeta, bizum, transferencia, mixto, link_pago, qr)
**Reemplaza:** pago-efectivo, pago-tarjeta, pago-bizum (3 módulos legacy unificados)
