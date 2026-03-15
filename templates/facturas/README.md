# Plantilla: Sistema de Facturas

Plantilla para configurar el sistema de gestión de facturas por proyecto.

## Estructura

```
templates/facturas/
├── config/
│   └── facturas.json      # Configuración del sistema
├── flows/
│   ├── entrada-telegram.json   # Recepción desde Telegram
│   ├── entrada-gmail.json      # Recepción desde Gmail
│   ├── procesar-lote.json      # Procesamiento semanal
│   ├── procesar-factura.json   # OCR individual
│   └── consolidar-excel.json   # Exportación a Excel
└── storage/facturas/
    ├── inbox/             # Facturas pendientes
    ├── procesadas/
    │   ├── originales/    # Archivos procesados
    │   └── ocr/           # Resultados OCR
    └── exports/           # Archivos Excel
```

## Uso

1. Copiar la plantilla a un proyecto:
   ```bash
   cp -r templates/facturas/* data/projects/MI_PROYECTO/
   ```

2. Editar `config/facturas.json` con la configuración del cliente:
   - `telegram.botName`: nombre del bot de Telegram
   - `gmail.account`: cuenta de Gmail (si aplica)
   - `schedule.*`: horarios de procesamiento

3. Los flujos se cargan automáticamente al iniciar el sistema.

## Flujos

### entrada-telegram
- **Trigger**: `bot.file.stored` (imagen/PDF recibido)
- **Acciones**: Guarda en inbox, registra en BD, emite `factura.recibida`

### entrada-gmail
- **Schedule**: Diario a las 3am
- **Acciones**: Busca emails con adjuntos, descarga, registra en BD

### procesar-lote
- **Schedule**: Domingos a las 3am
- **Acciones**: Obtiene pendientes, emite `factura.procesar` por cada una

### procesar-factura
- **Trigger**: `factura.procesar`
- **Acciones**: OCR con Google Vision, extracción con AI, actualiza BD

### consolidar-excel
- **Schedule**: Domingos a las 6am
- **Acciones**: Genera Excel, notifica si está configurado

## Eventos

| Evento | Descripción |
|--------|-------------|
| `factura.recibida` | Nueva factura en inbox |
| `factura.procesar` | Solicitud de procesamiento OCR |
| `factura.procesada` | OCR completado |
| `factura.exportada` | Excel generado |

## Configuración

```json
{
  "telegram": {
    "botName": "nombre_del_bot"
  },
  "gmail": {
    "enabled": false,
    "account": "cuenta@gmail.com"
  },
  "schedule": {
    "gmail": "0 3 * * *",
    "procesamiento": "0 3 * * 0",
    "exportacion": "0 6 * * 0"
  }
}
```
