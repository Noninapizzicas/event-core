/**
 * Módulo Facturas
 *
 * Procesamiento de facturas: cualquier formato de entrada → datos estructurados.
 *
 * Pipeline unitario:
 *   Archivo (PDF/IMG) → [PDF→PNG] → Sharp prepare → OCR → IA estructura → JSON
 *
 * Expone:
 * - UI handlers (domain: facturas) para el frontend
 * - Tools para AI agents
 * - Eventos en tiempo real (factura.recibida/procesada/error/exportada)
 *
 * @version 1.0.0
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ServiceExecutor = require('../../core/service-executor');

// Prompt para estructurar texto OCR en JSON de factura
const PROMPT_ESTRUCTURA = `Eres un experto en extracción de datos de facturas. A partir del texto OCR que te proporciono, extrae los datos estructurados en JSON con este formato exacto:

{
  "emisor": {
    "nombre": "",
    "cif": "",
    "direccion": "",
    "telefono": "",
    "web": ""
  },
  "receptor": {
    "nombre": "",
    "cif": "",
    "direccion": "",
    "codigo_cliente": ""
  },
  "factura": {
    "numero": "",
    "fecha": "",
    "forma_pago": ""
  },
  "lineas": [
    {
      "descripcion": "",
      "unidades": 0,
      "precio": 0,
      "descuento": "",
      "importe": 0
    }
  ],
  "totales": {
    "base_imponible": 0,
    "iva_porcentaje": 0,
    "iva_importe": 0,
    "total_factura": 0,
    "resto_cobrar": 0
  }
}

Devuelve SOLO el JSON, sin explicaciones ni markdown.`;

// Extensiones de imagen soportadas
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.tif'];


class FacturasModule {
  constructor() {
    this.name = 'facturas';
    this.version = '1.0.0';

    // Injected by loader
    this.logger = null;
    this.eventBus = null;
    this.uiHandler = null;

    // Service executor (wraps eventBus request/response)
    this.services = null;

    // Active project tracking
    this.activeProjectId = null;

    // Module config (from module.json, overridable)
    this.config = {
      ocr: {
        provider: 'local.google-vision',
        hint: 'DOCUMENT_TEXT_DETECTION',
        languages: ['es', 'en']
      },
      ai: {
        provider: 'deepseek',
        temperature: 0.1,
        maxTokens: 2000
      },
      processing: {
        dpi: 300,
        maxWidth: 2400,
        maxHeight: 3200,
        sharp: { grayscale: true, normalize: true, sharpen: true }
      },
      timeouts: {
        pdfConvert: 60000,
        sharp: 30000,
        ocr: 60000,
        ai: 60000,
        db: 30000
      }
    };
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(context) {
    this.logger = context.logger;
    this.eventBus = context.eventBus;
    this.uiHandler = context.uiHandler;

    // Create service executor for calling providers
    this.services = new ServiceExecutor(this.eventBus, this.logger);

    // Merge config from loader-injected moduleConfig
    if (context.moduleConfig && Object.keys(context.moduleConfig).length > 0) {
      Object.assign(this.config, context.moduleConfig);
    }

    this.logger.info('facturas.loaded');
  }

  async onUnload() {
    this.logger.info('facturas.unloaded');
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  onProjectActivated(event) {
    const data = event.data || event;
    this.activeProjectId = data.project_id;
    this.logger.debug('facturas.project.activated', { project_id: data.project_id });
  }

  /**
   * Reacciona a factura.entrada (emitido por fuentes: telegram, gmail, manual, etc.)
   * Contrato: { projectId, filePath, source, origen }
   */
  async onFacturaEntrada(event) {
    const data = event.data || event;
    const { projectId, filePath, source, origen } = data;

    if (!projectId || !filePath) {
      this.logger.warn('facturas.entrada.invalida', { data });
      return;
    }

    if (!fs.existsSync(filePath)) {
      this.logger.error('facturas.entrada.archivo-no-existe', { filePath, projectId });
      return;
    }

    this.logger.info('facturas.entrada.recibida', { source, projectId, filePath });

    try {
      await this.procesarArchivo(filePath, projectId, { source, origen });
    } catch (e) {
      this.logger.error('facturas.entrada.error', { error: e.message, filePath, projectId });
    }
  }

  // ==========================================
  // CORE: Procesamiento de factura individual
  // ==========================================

  /**
   * Procesa un archivo de factura y devuelve datos estructurados.
   * Este es el corazón del módulo.
   *
   * @param {string} filePath - Ruta al archivo (PDF o imagen)
   * @param {string} projectId - ID del proyecto
   * @param {Object} options - Opciones adicionales
   * @param {string} options.source - Origen: 'telegram' | 'gmail' | 'manual'
   * @param {Object} options.origen - Metadata del origen (botName, chatId, etc.)
   * @param {string} options.facturaId - ID existente en DB (para reprocesar)
   * @returns {Promise<Object>} Resultado con datos estructurados
   */
  async procesarArchivo(filePath, projectId, options = {}) {
    const { source = 'manual', origen = {}, facturaId = null } = options;
    const startTime = Date.now();
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();

    this.logger.info('facturas.procesando', { filePath, projectId, source });

    // Directorios de trabajo del proyecto
    const storageDir = path.join(process.cwd(), 'data/projects', projectId, 'storage');
    const preproDir = path.join(storageDir, 'preprocesadas');
    const ocrDir = path.join(storageDir, 'ocr');
    const structDir = path.join(storageDir, 'estructuradas');

    for (const dir of [preproDir, ocrDir, structDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    // Registrar en DB (o actualizar si reprocesando)
    let facturaDbId = facturaId;
    if (!facturaDbId) {
      try {
        const regResult = await this.services.call(
          'local.facturas-db', 'registrar',
          { proyecto: projectId, nombre_archivo: fileName, source, path_original: filePath, origen },
          { timeout: this.config.timeouts.db }
        );
        const regData = regResult.data || regResult;
        facturaDbId = regData.id;

        // Notificar UI
        this.eventBus.publish('factura.recibida', {
          projectId, id: facturaDbId, nombre_archivo: fileName, source
        });
      } catch (e) {
        this.logger.error('facturas.registrar.error', { error: e.message });
      }
    }

    // Marcar como procesando
    if (facturaDbId) {
      await this.actualizarDB(projectId, facturaDbId, { estado: 'procesando' });
    }

    try {
      // PASO 1: Obtener imágenes del archivo
      let imagenes = [];

      if (ext === '.pdf') {
        imagenes = await this.convertirPDF(filePath, preproDir);
      } else if (IMAGE_EXTENSIONS.includes(ext)) {
        // Copiar imagen a preprocesadas si no está ya ahí
        const dest = path.join(preproDir, fileName);
        if (path.resolve(filePath) !== path.resolve(dest)) {
          fs.copyFileSync(filePath, dest);
        }
        imagenes = [dest];
      } else {
        throw new Error(`Formato no soportado: ${ext}`);
      }

      if (imagenes.length === 0) {
        throw new Error('No se generaron imágenes del archivo');
      }

      // PASO 2-4: Procesar cada imagen
      const resultadosPagina = [];

      for (const imgPath of imagenes) {
        const baseName = path.basename(imgPath, path.extname(imgPath));

        // PASO 2: Preparar imagen para OCR
        const preparedPath = path.join(preproDir, `prepared_${baseName}.png`);
        await this.prepararImagen(imgPath, preparedPath);

        // PASO 3: OCR
        const textoOCR = await this.extraerOCR(preparedPath);

        if (!textoOCR) {
          this.logger.warn('facturas.ocr.vacio', { imagen: baseName });
          continue;
        }

        // Guardar texto OCR
        fs.writeFileSync(path.join(ocrDir, `${baseName}.txt`), textoOCR, 'utf-8');

        // PASO 4: Estructurar con IA
        const estructura = await this.estructurarConIA(textoOCR);

        if (estructura) {
          // Guardar JSON estructurado
          fs.writeFileSync(
            path.join(structDir, `${baseName}.json`),
            JSON.stringify(estructura, null, 2),
            'utf-8'
          );
          resultadosPagina.push({ baseName, textoOCR, estructura });
        }
      }

      if (resultadosPagina.length === 0) {
        throw new Error('No se pudo extraer datos de ninguna página');
      }

      // Combinar resultados (si multi-página, usar el primer resultado con datos)
      const resultado = resultadosPagina[0].estructura;
      const textoCompleto = resultadosPagina.map(r => r.textoOCR).join('\n\n--- PÁGINA ---\n\n');

      // Aplanar datos para la DB
      const datosDB = this.aplanarParaDB(resultado, textoCompleto);
      datosDB.estado = 'procesada';
      datosDB.fecha_procesado = new Date().toISOString();
      datosDB.path_procesada = path.join(structDir, `${path.basename(fileName, ext)}.json`);

      // Actualizar en DB
      if (facturaDbId) {
        await this.actualizarDB(projectId, facturaDbId, datosDB);
      }

      const duration = Date.now() - startTime;
      this.logger.info('facturas.procesada', {
        id: facturaDbId, fileName, duration_ms: duration,
        proveedor: resultado.emisor?.nombre, total: resultado.totales?.total_factura
      });

      // Notificar UI en tiempo real
      this.eventBus.publish('factura.procesada', {
        projectId, id: facturaDbId,
        datos: {
          estado: 'procesada',
          numero_factura: resultado.factura?.numero,
          nombre_proveedor: resultado.emisor?.nombre,
          total: resultado.totales?.total_factura,
          fecha_factura: resultado.factura?.fecha
        }
      });

      return {
        success: true,
        id: facturaDbId,
        estructura: resultado,
        datosDB,
        paginas: resultadosPagina.length,
        duration_ms: duration
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error('facturas.error', {
        id: facturaDbId, fileName, error: error.message, duration_ms: duration
      });

      // Actualizar estado error en DB
      if (facturaDbId) {
        await this.actualizarDB(projectId, facturaDbId, {
          estado: 'error',
          ocr_error: error.message
        });
      }

      // Notificar UI
      this.eventBus.publish('factura.error', {
        projectId, id: facturaDbId, error: error.message
      });

      return {
        success: false,
        id: facturaDbId,
        error: error.message,
        duration_ms: duration
      };
    }
  }

  // ==========================================
  // Pipeline Steps
  // ==========================================

  /**
   * Convierte PDF a imágenes PNG
   */
  async convertirPDF(pdfPath, outputDir) {
    const result = await this.services.call('local.pdf-to-png', 'convert', {
      pdf: pdfPath,
      dpi: this.config.processing.dpi,
      outputFolder: outputDir
    }, { timeout: this.config.timeouts.pdfConvert });

    const data = result.data || result;
    return (data.images || []).map(img => img.path || path.join(outputDir, img.name));
  }

  /**
   * Prepara imagen para OCR (grayscale, normalize, sharpen)
   */
  async prepararImagen(inputPath, outputPath) {
    await this.services.call('local.sharp', 'prepare-ocr', {
      image: inputPath,
      options: {
        ...this.config.processing.sharp,
        maxWidth: this.config.processing.maxWidth,
        maxHeight: this.config.processing.maxHeight
      },
      output: outputPath
    }, { timeout: this.config.timeouts.sharp });
  }

  /**
   * Extrae texto via OCR (Google Vision)
   */
  async extraerOCR(imagePath) {
    const result = await this.services.call('local.google-vision', 'extract', {
      image: imagePath,
      hint: this.config.ocr.hint,
      languageHints: this.config.ocr.languages
    }, { timeout: this.config.timeouts.ocr });

    const data = result.data || result;
    return data.text || '';
  }

  /**
   * Estructura texto OCR con IA (DeepSeek)
   */
  async estructurarConIA(textoOCR) {
    const result = await this.services.call('ai', 'chat', {
      messages: [
        { role: 'system', content: PROMPT_ESTRUCTURA },
        { role: 'user', content: textoOCR }
      ],
      provider: this.config.ai.provider,
      temperature: this.config.ai.temperature,
      max_tokens: this.config.ai.maxTokens
    }, { timeout: this.config.timeouts.ai });

    const data = result.data || result;
    const respuesta = data.content || data.message || '';

    if (!respuesta) return null;

    // Limpiar posible markdown wrapping
    const cleaned = respuesta.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

    try {
      return JSON.parse(cleaned);
    } catch (e) {
      this.logger.warn('facturas.ia.parse-error', { error: e.message });
      return null;
    }
  }

  // ==========================================
  // Helpers
  // ==========================================

  /**
   * Aplana la estructura JSON de DeepSeek al formato plano de la DB
   */
  aplanarParaDB(estructura, textoOCR) {
    return {
      factura_numero: estructura.factura?.numero || null,
      factura_fecha: estructura.factura?.fecha || null,
      proveedor_nif: estructura.emisor?.cif || null,
      proveedor_nombre: estructura.emisor?.nombre || null,
      concepto: (estructura.lineas || []).map(l => l.descripcion).filter(Boolean).join(' + ') || null,
      base_imponible: estructura.totales?.base_imponible || null,
      tipo_iva: estructura.totales?.iva_porcentaje || null,
      cuota_iva: estructura.totales?.iva_importe || null,
      total_factura: estructura.totales?.total_factura || null,
      metodo_pago: estructura.factura?.forma_pago || null,
      ocr_texto: textoOCR ? textoOCR.substring(0, 5000) : null,
      ocr_provider: this.config.ocr.provider
    };
  }

  /**
   * Actualiza campos de una factura en la DB
   */
  async actualizarDB(projectId, facturaId, campos) {
    try {
      await this.services.call('local.facturas-db', 'actualizar', {
        proyecto: projectId, id: facturaId, campos
      }, { timeout: this.config.timeouts.db });
    } catch (e) {
      this.logger.error('facturas.db.actualizar.error', { id: facturaId, error: e.message });
    }
  }

  // ==========================================
  // UI Handlers (domain: facturas)
  // ==========================================

  /**
   * Procesa un archivo existente en disco
   * UI: mqttRequest('facturas', 'procesar', { proyecto, filePath, source })
   */
  async handleProcesar(data) {
    const { proyecto, filePath, source = 'manual', origen } = data;
    if (!proyecto || !filePath) {
      return { status: 400, error: 'proyecto y filePath son requeridos' };
    }

    if (!fs.existsSync(filePath)) {
      return { status: 404, error: `Archivo no encontrado: ${filePath}` };
    }

    const result = await this.procesarArchivo(filePath, proyecto, { source, origen });
    return { status: result.success ? 200 : 500, data: result };
  }

  /**
   * Sube un archivo (base64) y lo procesa
   * UI: mqttRequest('facturas', 'subir', { proyecto, archivo: { nombre, contenido, mimeType }, source })
   */
  async handleSubir(data) {
    const { proyecto, archivo, source = 'manual' } = data;
    if (!proyecto || !archivo?.nombre || !archivo?.contenido) {
      return { status: 400, error: 'proyecto y archivo (nombre, contenido) son requeridos' };
    }

    // Guardar archivo en storage del proyecto
    const storageDir = path.join(process.cwd(), 'data/projects', proyecto, 'storage', 'pendientes');
    if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });

    const timestamp = Date.now();
    const safeName = archivo.nombre.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(storageDir, `${timestamp}_${safeName}`);

    // Decodificar base64 y guardar
    const buffer = Buffer.from(archivo.contenido, 'base64');
    fs.writeFileSync(filePath, buffer);

    this.logger.info('facturas.subida', { nombre: safeName, size: buffer.length, proyecto });

    // Procesar
    const result = await this.procesarArchivo(filePath, proyecto, {
      source,
      origen: { manual: true, nombreOriginal: archivo.nombre }
    });

    return { status: result.success ? 201 : 500, data: result };
  }

  /**
   * Reprocesa una factura existente
   * UI: mqttRequest('facturas', 'reprocesar', { proyecto, id })
   */
  async handleReprocesar(data) {
    const { proyecto, id } = data;
    if (!proyecto || !id) {
      return { status: 400, error: 'proyecto e id son requeridos' };
    }

    // Obtener factura de la DB
    let factura;
    try {
      const result = await this.services.call('local.facturas-db', 'obtener', {
        proyecto, id
      }, { timeout: this.config.timeouts.db });
      factura = (result.data || result);
    } catch (e) {
      return { status: 404, error: `Factura no encontrada: ${e.message}` };
    }

    if (!factura?.path_original || !fs.existsSync(factura.path_original)) {
      return { status: 404, error: 'Archivo original no encontrado en disco' };
    }

    const result = await this.procesarArchivo(factura.path_original, proyecto, {
      source: factura.source || 'manual',
      facturaId: id
    });

    return { status: result.success ? 200 : 500, data: result };
  }

  /**
   * Lista facturas con filtros
   * UI: mqttRequest('facturas', 'listar', { proyecto, estado?, source?, limit? })
   */
  async handleListar(data) {
    const { proyecto, estado, desde, hasta, limit = 100 } = data;
    if (!proyecto) {
      return { status: 400, error: 'proyecto es requerido' };
    }

    try {
      const result = await this.services.call('local.facturas-db', 'listar', {
        proyecto, estado, desde, hasta, limit
      }, { timeout: this.config.timeouts.db });

      return { status: 200, data: result.data || result };
    } catch (e) {
      return { status: 500, error: e.message };
    }
  }

  /**
   * Obtiene una factura por ID
   * UI: mqttRequest('facturas', 'obtener', { proyecto, id })
   */
  async handleObtener(data) {
    const { proyecto, id } = data;
    if (!proyecto || !id) {
      return { status: 400, error: 'proyecto e id son requeridos' };
    }

    try {
      const result = await this.services.call('local.facturas-db', 'obtener', {
        proyecto, id
      }, { timeout: this.config.timeouts.db });

      const factura = result.data || result;
      if (!factura) return { status: 404, error: 'Factura no encontrada' };

      return { status: 200, data: { factura } };
    } catch (e) {
      return { status: 500, error: e.message };
    }
  }

  /**
   * Actualiza campos de una factura
   * UI: mqttRequest('facturas', 'actualizar', { proyecto, id, datos })
   */
  async handleActualizar(data) {
    const { proyecto, id, datos } = data;
    if (!proyecto || !id || !datos) {
      return { status: 400, error: 'proyecto, id y datos son requeridos' };
    }

    try {
      const result = await this.services.call('local.facturas-db', 'actualizar', {
        proyecto, id, campos: datos
      }, { timeout: this.config.timeouts.db });

      return { status: 200, data: result.data || result };
    } catch (e) {
      return { status: 500, error: e.message };
    }
  }

  /**
   * Estadísticas de facturas
   * UI: mqttRequest('facturas', 'estadisticas', { proyecto })
   */
  async handleEstadisticas(data) {
    const { proyecto } = data;
    if (!proyecto) {
      return { status: 400, error: 'proyecto es requerido' };
    }

    try {
      const result = await this.services.call('local.facturas-db', 'estadisticas', {
        proyecto
      }, { timeout: this.config.timeouts.db });

      const stats = result.data || result;

      // Adaptar formato al que espera el frontend
      return {
        status: 200,
        data: {
          total: stats.general?.total || 0,
          pendientes: stats.general?.pendientes || 0,
          procesadas: stats.general?.procesadas || 0,
          errores: stats.general?.errores || 0,
          exportadas: stats.general?.exportadas || 0,
          porSource: stats.porSource || []
        }
      };
    } catch (e) {
      return { status: 500, error: e.message };
    }
  }

  /**
   * Exportar facturas procesadas
   * UI: mqttRequest('facturas', 'exportar', { proyecto, semana? })
   */
  async handleExportar(data) {
    const { proyecto, semana } = data;
    if (!proyecto) {
      return { status: 400, error: 'proyecto es requerido' };
    }

    try {
      const result = await this.services.call('local.facturas-db', 'exportar', {
        proyecto, semana
      }, { timeout: this.config.timeouts.db });

      const exportData = result.data || result;

      // Generar CSV fiscal
      const csvPath = await this.generarCSV(proyecto, exportData.facturas || []);

      // Marcar como exportadas si hay IDs
      if (exportData.ids?.length > 0) {
        const semanaExport = exportData.semana || this.calcularSemanaISO();
        await this.services.call('local.facturas-db', 'marcarExportadas', {
          proyecto, ids: exportData.ids, semana: semanaExport
        }, { timeout: this.config.timeouts.db });
      }

      // Notificar UI
      this.eventBus.publish('factura.exportada', {
        projectId: proyecto,
        total: exportData.total || 0,
        archivo: csvPath
      });

      return {
        status: 200,
        data: {
          path: csvPath,
          total: exportData.total || 0
        }
      };
    } catch (e) {
      return { status: 500, error: e.message };
    }
  }

  // ==========================================
  // AI Tool Handlers
  // ==========================================

  async handleToolProcesar(args) {
    const { projectId, filePath, source = 'manual' } = args;
    if (!projectId || !filePath) {
      return { status: 400, data: { error: 'projectId y filePath son requeridos' } };
    }

    const result = await this.procesarArchivo(filePath, projectId, { source });
    return { status: result.success ? 200 : 500, data: result };
  }

  async handleToolListar(args) {
    return this.handleListar({ proyecto: args.projectId, ...args });
  }

  async handleToolEstadisticas(args) {
    return this.handleEstadisticas({ proyecto: args.projectId });
  }

  // ==========================================
  // CSV Export
  // ==========================================

  async generarCSV(projectId, facturas) {
    const exportDir = path.join(process.cwd(), 'data/projects', projectId, 'storage', 'export');
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

    const headers = [
      'Fecha', 'Num_Factura', 'NIF_Emisor', 'Nombre_Emisor',
      'NIF_Receptor', 'Nombre_Receptor', 'Descripcion',
      'Base_Imponible', 'Tipo_IVA', 'Cuota_IVA',
      'Tipo_RE', 'Cuota_RE', 'Total_Factura',
      'Forma_Pago', 'Clave_Operacion'
    ];

    const BOM = '\uFEFF';
    let csv = BOM + headers.join(';') + '\n';

    for (const f of facturas) {
      const nif = f['NIF Proveedor'] || '';
      const total = parseFloat(f['Total'] || 0);
      const claveOp = (!nif || (total < 400 && !(f['NIF Receptor'] || ''))) ? 'F2' : 'F1';

      const row = [
        f['Fecha Factura'] || '',
        f['Nº Factura'] || '',
        nif,
        f['Proveedor'] || '',
        '', // NIF Receptor (se rellena de config del proyecto)
        '', // Nombre Receptor
        f['Concepto'] || '',
        f['Base Imponible'] || 0,
        f['% IVA'] || 0,
        f['Cuota IVA'] || 0,
        0, // Tipo RE
        0, // Cuota RE
        total,
        '', // Forma Pago
        claveOp
      ];

      csv += row.map(v => this.escapeCsv(v)).join(';') + '\n';
    }

    const fecha = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const csvPath = path.join(exportDir, `facturas_${fecha}.csv`);
    fs.writeFileSync(csvPath, csv, 'utf-8');

    return csvPath;
  }

  escapeCsv(value) {
    const str = String(value);
    if (str.includes(';') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  calcularSemanaISO(fecha = new Date()) {
    const d = new Date(fecha);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }
}

module.exports = FacturasModule;
