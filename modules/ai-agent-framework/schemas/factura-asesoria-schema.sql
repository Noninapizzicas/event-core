-- Schema para proyecto factura-asesoria
-- Ejecutar: POST /modules/database-manager/databases/factura-asesoria/init

CREATE TABLE IF NOT EXISTS facturas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archivo TEXT NOT NULL,
  archivo_original TEXT,
  chat_id INTEGER NOT NULL,
  from_user TEXT,
  caption TEXT,
  estado TEXT DEFAULT 'pendiente' CHECK(estado IN ('pendiente', 'procesando', 'procesada', 'error')),
  fecha_recepcion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  fecha_procesado TIMESTAMP,

  -- Datos extraidos por OCR
  texto_ocr TEXT,
  confianza_ocr REAL,

  -- Datos parseados (fase posterior)
  importe REAL,
  fecha_factura DATE,
  proveedor TEXT,
  cif_proveedor TEXT,
  concepto TEXT,

  -- Metadata
  error_mensaje TEXT,
  intentos INTEGER DEFAULT 0
);

-- Indices para busquedas rapidas
CREATE INDEX IF NOT EXISTS idx_facturas_estado ON facturas(estado);
CREATE INDEX IF NOT EXISTS idx_facturas_fecha ON facturas(fecha_recepcion);
CREATE INDEX IF NOT EXISTS idx_facturas_chat ON facturas(chat_id);

-- Vista para facturas pendientes
CREATE VIEW IF NOT EXISTS v_facturas_pendientes AS
SELECT id, archivo, chat_id, fecha_recepcion, caption
FROM facturas
WHERE estado = 'pendiente'
ORDER BY fecha_recepcion ASC;

-- Vista para resumen diario
CREATE VIEW IF NOT EXISTS v_resumen_diario AS
SELECT
  DATE(fecha_recepcion) as fecha,
  COUNT(*) as total,
  SUM(CASE WHEN estado = 'pendiente' THEN 1 ELSE 0 END) as pendientes,
  SUM(CASE WHEN estado = 'procesada' THEN 1 ELSE 0 END) as procesadas,
  SUM(CASE WHEN estado = 'error' THEN 1 ELSE 0 END) as errores
FROM facturas
GROUP BY DATE(fecha_recepcion)
ORDER BY fecha DESC;
