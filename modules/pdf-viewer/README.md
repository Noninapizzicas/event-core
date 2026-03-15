# PDF Viewer Module

Módulo para visualizar y extraer texto de archivos PDF.

## Características

- **Visualizar PDFs**: Carga PDFs en base64 para mostrar en el navegador
- **Extraer texto**: Extrae texto de PDFs (requiere pdf-parse)
- **Metadata**: Obtiene información sobre PDFs
- **Listar PDFs**: Encuentra todos los PDFs en un proyecto

## APIs HTTP

### GET `/modules/pdf-viewer/pdf/view`

Obtiene un PDF para visualización.

**Query params:**
- `project_id` (requerido): ID del proyecto
- `file_path` (requerido): Ruta del archivo PDF

**Respuesta:**
```json
{
  "success": true,
  "data": {
    "file_path": "/docs/manual.pdf",
    "size": 204800,
    "modified": "2025-01-15T10:30:00Z",
    "content": "JVBERi0xLjQK...",
    "content_type": "application/pdf"
  }
}
```

### GET `/modules/pdf-viewer/pdf/extract-text`

Extrae texto de un PDF.

**Query params:**
- `project_id` (requerido)
- `file_path` (requerido)
- `page` (opcional): Número de página específico (1-indexed)

**Nota:** Requiere instalar `pdf-parse`:
```bash
npm install pdf-parse
```

### GET `/modules/pdf-viewer/pdf/metadata`

Obtiene metadata de un PDF.

**Query params:**
- `project_id` (requerido)
- `file_path` (requerido)

**Respuesta:**
```json
{
  "success": true,
  "data": {
    "file_path": "/docs/manual.pdf",
    "filename": "manual.pdf",
    "size": 204800,
    "size_formatted": "200 KB",
    "created": "2025-01-10T08:00:00Z",
    "modified": "2025-01-15T10:30:00Z"
  }
}
```

### GET `/modules/pdf-viewer/pdf/list`

Lista todos los PDFs en un proyecto.

**Query params:**
- `project_id` (requerido)

**Respuesta:**
```json
{
  "success": true,
  "data": {
    "project_id": "proj-123",
    "pdfs": [
      {
        "name": "manual.pdf",
        "path": "/docs/manual.pdf",
        "size": 204800,
        "size_formatted": "200 KB",
        "modified": "2025-01-15T10:30:00Z"
      }
    ],
    "count": 1
  }
}
```

## Eventos MQTT

### Subscripciones

- `pdf.view.request` - Solicitud para ver PDF
- `pdf.extract.request` - Solicitud para extraer texto
- `pdf.metadata.request` - Solicitud de metadata
- `pdf.list.request` - Solicitud para listar PDFs

### Publicaciones

- `pdf.view.response` - Respuesta con PDF
- `pdf.extract.response` - Respuesta con texto extraído
- `pdf.metadata.response` - Respuesta con metadata
- `pdf.list.response` - Respuesta con lista de PDFs
- `pdf.error` - Error en operación

## Configuración

```json
{
  "max_pdf_size": 52428800,
  "cache_enabled": true,
  "cache_ttl": 3600000
}
```

- `max_pdf_size`: Tamaño máximo de PDF (50MB default)
- `cache_enabled`: Habilitar caché en memoria
- `cache_ttl`: Tiempo de vida del caché (1 hora default)

## Integración con UI

El módulo está diseñado para integrarse con el visor PDF en la UI:

```javascript
// Cargar PDF
const response = await fetch(
  `/modules/pdf-viewer/pdf/view?project_id=${projectId}&file_path=${filePath}`
);
const data = await response.json();

// Mostrar en navegador
const pdfBlob = base64ToBlob(data.data.content, 'application/pdf');
const url = URL.createObjectURL(pdfBlob);
iframe.src = url;
```

## Mejoras Futuras

Para funcionalidad completa de extracción de texto:

1. Instalar pdf-parse:
```bash
npm install pdf-parse
```

2. Actualizar el método `extractText`:
```javascript
const pdf = require('pdf-parse');
const buffer = await fs.readFile(fullPath);
const data = await pdf(buffer);
return data.text;
```

## Seguridad

- Path traversal protection
- Validación de extensión .pdf
- Límite de tamaño de archivo
- Access control por proyecto

## Métricas

- `pdfs_viewed_total` - Total de PDFs visualizados
- `text_extractions_total` - Total de extracciones de texto
- `pdf_errors_total` - Total de errores
