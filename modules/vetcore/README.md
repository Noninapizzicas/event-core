# VetCore — Sistema de Gestión Veterinaria

> Vertical construida sobre **event-core** para clínicas veterinarias.  
> Misma arquitectura fractal de Pizzepos, dominio veterinario.

---

## ¿Qué problema resuelve?

Las clínicas veterinarias pequeñas y medianas gestionan citas en papel, mandan recordatorios por WhatsApp a mano, pierden historias clínicas entre archivadores y no tienen datos para tomar decisiones. VetCore centraliza todo en un sistema event-driven con IA integrada.

---

## Módulos de la Vertical

| Módulo | Espejo Pizzepos | Función |
|---|---|---|
| `pacientes` | productos | Ficha de cada mascota |
| `propietarios` | cuentas | Dueños y sus mascotas |
| `especies` | categorias | Perros, gatos, exóticos, aves… |
| `servicios` | carta/productos | Catálogo de servicios y precios |
| `citas` | pedidos | Agenda y reservas |
| `sala-espera` | comandero | Cola en tiempo real |
| `historia-clinica` | — | Consultas, diagnósticos, prescripciones |
| `protocolo-generator` | menu-generator | Protocolos de tratamiento con IA |
| `ficha-digital` | carta-digital | QR con servicios y tarifas |
| `tarifario-impresion` | carta-impresion | PDF imprimible de tarifas |
| `recordatorios` | — | Vacunas y seguimiento por Telegram/WhatsApp |
| `cobros-vet` | cobros | Facturación y pagos |

---

## Capacidades heredadas del sistema

- **AI Gateway** — triage de síntomas, sugerencias de diagnóstico, generación de protocolos
- **Telegram Service** — recordatorios automáticos de vacunas y revisiones
- **Channel Manager** — WhatsApp, Telegram, teléfono para reservas
- **Bot Manager** — bot de autoservicio para que el dueño reserve cita 24/7
- **Scheduler** — recordatorios programados (vacuna en 30 días, revisión en 7 días)
- **Credential Manager** — acceso por rol: veterinario, enfermero, recepcionista, dueño
- **Facturación** — facturas digitales con firma y envío por email/Telegram
- **OCR Plugin** — digitalización de analíticas y documentos en papel
- **PDF Viewer** — historias clínicas en PDF generadas on-demand
- **Dashboard** — métricas de clínica en tiempo real
- **Metricas** — diagnósticos más frecuentes, servicios más rentables, tiempo medio de consulta

---

## Flujo principal

```
Dueño manda WhatsApp/Telegram
    → Bot Manager recibe y gestiona reserva
    → cita.creada (MQTT)
    → recordatorios.programar (Scheduler: -24h, -1h)
    → sala-espera.paciente_llegado (en clínica)
    → veterinario abre historia-clinica
    → protocolo-generator sugiere protocolo con IA
    → historia-clinica.consulta_registrada
    → diagnostico.emitido + tratamiento.prescrito
    → cobros-vet.cobro_realizado
    → Scheduler programa recordatorio de revisión
    → Telegram/WhatsApp notifica al dueño
```

---

## Precio de Venta Sugerido

| Plan | Precio/mes | Incluye |
|---|---|---|
| **Básico** | 49 €/mes | Citas + Historia clínica + 1 veterinario |
| **Pro** | 99 €/mes | Todo Básico + IA + Bot WhatsApp + Recordatorios ilimitados |
| **Clínica** | 199 €/mes | Todo Pro + Multi-veterinario + Farmacia + API |

> Margen alto: el sistema corre en VPS propio (12-20 €/mes). Coste de IA ~2-5 €/mes por clínica.

---

## Stack Técnico

- **Runtime**: Node.js 18+ / event-core
- **Frontend**: SvelteKit 2 + Svelte 5 (heredado del sistema)
- **Base de datos**: SQLite (sql.js) — sin infraestructura extra
- **Mensajería**: MQTT (Aedes embebido)
- **IA**: DeepSeek / Claude / OpenAI via AI Gateway
- **Canales**: Telegram Bot API + WhatsApp Business API
- **Deploy**: Docker compose, 1 VPS por clínica o multi-tenant
