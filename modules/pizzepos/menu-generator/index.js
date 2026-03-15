/**
 * Menu Generator v4.0.0
 *
 * Asistente de cartas de restaurante — expone tools para el agentic loop del chat.
 * El usuario habla por el chat, el LLM usa estas herramientas para operar sobre cartas.
 *
 * Tools:
 *   menu.generate        — Genera carta estructurada desde texto (OCR, lista, JSON)
 *   menu.list_cartas     — Lista cartas generadas
 *   menu.get_carta       — Obtiene carta completa por ID
 *   menu.update_prices   — Ajusta precios (%, por categoría, individuales)
 *   menu.add_product     — Añade producto a carta
 *   menu.remove_product  — Elimina producto de carta
 *   menu.add_category    — Añade categoría a carta
 *   menu.update_product  — Actualiza datos de producto
 *   menu.search_products — Busca productos por nombre/ingrediente
 *   menu.stats           — Estadísticas de carta
 *
 * Flujo de generación:
 *   texto → ai.chat.request → AI estructura → parseAndStructure → carta.generada
 *
 * Output: schemas/carta-output.json
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

// Lazy-loaded service providers (local, no external deps)
let sharpProvider = null;
let pdfjsProvider = null;
let googleVisionProvider = null;
let tesseractProvider = null;
let scribeOcrProvider = null;
let documentProcessorProvider = null;

function getSharpProvider() {
  if (!sharpProvider) {
    sharpProvider = require(path.resolve(__dirname, '../../../services/providers/local/sharp'));
  }
  return sharpProvider;
}

function getPdfjsProvider() {
  if (!pdfjsProvider) {
    pdfjsProvider = require(path.resolve(__dirname, '../../../services/providers/local/pdfjs'));
  }
  return pdfjsProvider;
}

function getGoogleVisionProvider() {
  if (!googleVisionProvider) {
    googleVisionProvider = require(path.resolve(__dirname, '../../../services/providers/local/google-vision'));
  }
  return googleVisionProvider;
}

function getTesseractProvider() {
  if (!tesseractProvider) {
    tesseractProvider = require(path.resolve(__dirname, '../../../services/providers/local/tesseract'));
  }
  return tesseractProvider;
}

function getScribeOcrProvider() {
  if (!scribeOcrProvider) {
    scribeOcrProvider = require(path.resolve(__dirname, '../../../services/providers/local/scribe-ocr'));
  }
  return scribeOcrProvider;
}

function getDocumentProcessorProvider() {
  if (!documentProcessorProvider) {
    documentProcessorProvider = require(path.resolve(__dirname, '../../../services/providers/local/document-processor'));
  }
  return documentProcessorProvider;
}

const PROMPT_EXTRACCION = `Eres un experto en digitalización de cartas de restaurante para sistemas POS.

Se te proporciona el contenido de una carta/menú de restaurante.
Puede ser texto OCR, una lista de productos, datos JSON crudos, o cualquier formato.

Tu trabajo es extraer y estructurar TODOS los productos en este formato JSON exacto:

{
  "nombre_carta": "Nombre del restaurante o carta detectado",
  "categorias": [
    { "id": "categoria_slug", "nombre": "Nombre Original", "orden": 1 }
  ],
  "productos": [
    {
      "id": "categoriaslug_productoslug",
      "nombre": "Nombre Original del Producto",
      "categoria": "categoria_slug",
      "precio": 11.50,
      "ingredientes": [
        { "nombre": "Tomate", "emoji": "🍅", "tipo": "verdura", "precio_extra": 0 },
        { "nombre": "Mozzarella", "emoji": "🧀", "tipo": "queso", "precio_extra": 0 }
      ]
    }
  ]
}

REGLAS OBLIGATORIAS:
1. IDs en snake_case sin acentos ni caracteres especiales
2. ID de producto: {id_categoria}_{nombre_producto_slug} (ej: "pizzicas_country")
3. ID de categoría: nombre en snake_case (ej: "pizzicas", "entrantes")
4. Precios de producto SIEMPRE como números (11.50, no "11.50"). Si no hay precio visible, pon 0
5. Ingredientes SIEMPRE como array de objetos, NUNCA un string plano
6. Cada ingrediente DEBE incluir los 4 campos:
   - "nombre": nombre del ingrediente tal cual
   - "emoji": el emoji más representativo
   - "tipo": clasificación obligatoria, uno de: "queso", "carne", "verdura", "salsa", "masa", "marisco", "otro"
   - "precio_extra": SIEMPRE 0. Los precios de extras los configura el jefe manualmente después
7. Mantén los nombres originales de productos tal cual aparecen
8. Agrupa productos en categorías tal como aparecen en la carta
9. Si no hay categorías claras, crea una categoría "general"
10. Devuelve SOLO el JSON, sin explicaciones, sin markdown, sin bloques de código`;

class MenuGeneratorModule {
  constructor() {
    this.name = 'menu-generator';
    this.version = '4.0.0';
    this.eventBus = null;
    this.logger = null;
    this.metrics = null;

    this.pendingAI = new Map();

    // Multi-tenant: project_id → Map<carta_id, carta>
    this.cartasPerProject = new Map();
    // project_id → { featurePath, storagePath }
    this.projectPaths = new Map();
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(context) {
    this.eventBus = context.eventBus;
    this.logger = context.logger;
    this.metrics = context.metrics;

    // Event subscriptions are auto-wired from module.json by the loader.
    // Do NOT subscribe manually here to avoid duplicate handlers.

    this.logger.info('module.loaded', { module: this.name, version: this.version });
  }

  async onUnload() {
    this.pendingAI.clear();
    this.cartasPerProject.clear();
    this.projectPaths.clear();
    this.logger.info('module.unloaded', { module: this.name });
  }

  // Helpers for per-project access
  getCartas(projectId) {
    if (!this.cartasPerProject.has(projectId)) {
      this.cartasPerProject.set(projectId, new Map());
    }
    return this.cartasPerProject.get(projectId);
  }

  getPaths(projectId) {
    return this.projectPaths.get(projectId);
  }

  async onProjectActivated(event) {
    const data = event.data || event;
    const { project_id, base_path, metadata } = data;

    const resolvedBase = (metadata?.is_system === true) ? process.cwd() : base_path;
    if (resolvedBase) {
      this.projectPaths.set(project_id, {
        featurePath: path.join(resolvedBase, 'storage', 'pizzepos'),
        storagePath: path.join(resolvedBase, 'storage')
      });
    }

    this.logger.info('menu-generator.project.activated', {
      project_id,
      paths: this.projectPaths.get(project_id)
    });

    // Load persisted cartas from disk
    await this.loadCartasFromDisk(project_id);
  }

  async onProjectDeactivated(event) {
    // No-op: keep data in memory for multi-tenant access
  }

  // ==========================================
  // Carta Persistence
  // ==========================================

  cartasDirFor(projectId) {
    const paths = this.getPaths(projectId);
    return paths ? path.join(paths.featurePath, 'cartas') : null;
  }

  async saveCartaToDisk(carta, projectId) {
    const dir = this.cartasDirFor(projectId);
    if (!dir) return;
    try {
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${carta.meta.id}.json`);
      await fs.writeFile(filePath, JSON.stringify(carta, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn('menu-generator.carta.save_failed', { carta_id: carta.meta?.id, project_id: projectId, error: err.message });
    }
  }

  async loadCartasFromDisk(projectId) {
    const dir = this.cartasDirFor(projectId);
    if (!dir) return;
    try {
      await fs.mkdir(dir, { recursive: true });
      const files = await fs.readdir(dir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      const cartas = this.getCartas(projectId);

      for (const file of jsonFiles) {
        try {
          const content = await fs.readFile(path.join(dir, file), 'utf-8');
          const carta = JSON.parse(content);
          if (carta.meta?.id) {
            cartas.set(carta.meta.id, carta);
          }
        } catch (err) {
          this.logger.warn('menu-generator.carta.load_failed', { file, project_id: projectId, error: err.message });
        }
      }

      this.logger.info('menu-generator.cartas.loaded', { project_id: projectId, count: cartas.size });
    } catch (err) {
      this.logger.warn('menu-generator.cartas.dir_error', { project_id: projectId, error: err.message });
    }
  }

  /**
   * Save base64 media file to media/{subfolder}/ in the project storage.
   * Used for product images, category images, branding, etc.
   * Keeps media separate from the OCR pipeline (preprocesadas/).
   * Returns { absolutePath, relativePath }.
   */
  async saveMediaFile(base64Data, prefix, projectId, subfolder = 'productos', ext = '.jpg') {
    const paths = this.getPaths(projectId);
    if (!paths) {
      throw new Error(`No paths for project ${projectId} — cannot save media file`);
    }

    const dir = path.join(paths.featurePath, 'media', subfolder);
    await fs.mkdir(dir, { recursive: true });

    let buffer = Buffer.from(base64Data, 'base64');

    // Auto-process product/category images: square crop + resize + compress
    if (subfolder === 'productos' || subfolder === 'categorias') {
      buffer = await this.processImageSquare(buffer);
      ext = '.jpg'; // always output as JPEG after processing
    }

    const filename = `${prefix}_${Date.now().toString(36)}${ext}`;
    const absolutePath = path.join(dir, filename);
    await fs.writeFile(absolutePath, buffer);

    const relativePath = '/' + path.relative(paths.storagePath, absolutePath).replace(/\\/g, '/');
    return { absolutePath, relativePath };
  }

  /**
   * Process image for carta display: center-crop to square, resize to 600x600, JPEG q85.
   * Falls back to original buffer if sharp fails (e.g. unsupported format).
   */
  async processImageSquare(buffer, size = 600, quality = 85) {
    try {
      const sharp = require('sharp');
      const processed = await sharp(buffer)
        .resize(size, size, {
          fit: 'cover',       // crop to fill the square
          position: 'centre'  // center the crop
        })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      return processed;
    } catch (err) {
      // If sharp fails, return original buffer unchanged
      if (this.logger) {
        this.logger.warn('menu.image.process_failed', { error: err.message });
      }
      return buffer;
    }
  }

  /**
   * Save base64 image to the project's preprocesadas/ directory.
   * Used exclusively for the OCR pipeline (PDF→Image→Prepare→OCR).
   * Returns { absolutePath, relativePath } where relativePath is for the frontend FilePicker.
   */
  async savePipelineFile(base64Data, prefix, projectId, ext = '.png') {
    const paths = this.getPaths(projectId);
    if (!paths) {
      throw new Error(`No paths for project ${projectId} — cannot save pipeline file`);
    }

    const dir = path.join(paths.featurePath, 'preprocesadas');
    await fs.mkdir(dir, { recursive: true });

    const filename = `${prefix}_${Date.now().toString(36)}${ext}`;
    const absolutePath = path.join(dir, filename);
    const buffer = Buffer.from(base64Data, 'base64');
    await fs.writeFile(absolutePath, buffer);

    const relativePath = '/' + path.relative(paths.storagePath, absolutePath).replace(/\\/g, '/');
    return { absolutePath, relativePath };
  }

  /**
   * Save OCR text result to the project's ocr/ directory.
   * Follows facturas pipeline convention (contexto/facturas.json → estructura_storage).
   * Returns the relative path for reference.
   */
  async saveOcrResult(text, sourceLabel, projectId) {
    const paths = this.getPaths(projectId);
    if (!paths || !text) return null;
    try {
      const dir = path.join(paths.featurePath, 'ocr');
      await fs.mkdir(dir, { recursive: true });

      const filename = `${sourceLabel || 'ocr'}_${Date.now().toString(36)}.txt`;
      const absolutePath = path.join(dir, filename);
      await fs.writeFile(absolutePath, text, 'utf-8');

      return '/' + path.relative(paths.storagePath, absolutePath).replace(/\\/g, '/');
    } catch (err) {
      this.logger.warn('menu-generator.ocr.save_failed', { project_id: projectId, error: err.message });
      return null;
    }
  }

  /**
   * Resolve a project-relative path (e.g. "/pizzepos/0.png") to an absolute filesystem path.
   * Uses project storagePath since FilePicker paths are relative to the storage root.
   * Paths that are already absolute and exist, or base64/data URIs, are returned as-is.
   */
  resolveFilePath(userPath, projectId) {
    if (!userPath || typeof userPath !== 'string') return userPath;

    // Data URIs and base64 pass through
    if (userPath.startsWith('data:')) return userPath;
    const base64Prefixes = ['/9j/', 'iVBORw', 'R0lGOD', 'UklGR', 'Qk', 'SUkq', 'TU0A'];
    if (base64Prefixes.some(p => userPath.startsWith(p))) return userPath;

    const paths = projectId ? this.getPaths(projectId) : null;
    const root = paths?.storagePath || paths?.featurePath;
    if (root) {
      const normalized = path.normalize(userPath).replace(/^\/+/, '');
      return path.resolve(root, normalized);
    }

    // Fallback: return as-is
    return userPath;
  }

  // ==========================================
  // UI Handlers (frontend micro-módulos)
  // ==========================================

  async handleGenerate(data) {
    const result = await this.toolGenerate(data);
    if (result.error) {
      throw { status: result.status || 400, code: 'GENERATE_ERROR', message: result.error };
    }
    return result.data;
  }

  async handleListCartas(data) {
    const result = await this.toolListCartas({ project_id: data?.project_id });
    return result.data;
  }

  async handleGetCarta(data) {
    const result = await this.toolGetCarta({ carta_id: data.id, project_id: data.project_id });
    if (result.error) {
      throw { status: result.status || 404, code: 'NOT_FOUND', message: result.error };
    }
    return result.data;
  }

  async handleHealth() {
    let totalCartas = 0;
    for (const cartas of this.cartasPerProject.values()) totalCartas += cartas.size;
    return {
      status: 'healthy',
      module: this.name,
      version: this.version,
      generando: this.pendingAI.size,
      generadas: totalCartas,
      proyectos: this.cartasPerProject.size
    };
  }

  async handleEnrichProducts(data) {
    const result = await this.toolEnrichProducts(data);
    if (result.error) {
      throw { status: result.status || 400, code: 'ENRICH_ERROR', message: result.error };
    }
    return result.data;
  }

  async handleSetProductImage(data) {
    const result = await this.toolSetProductImage(data);
    if (result.error) {
      throw { status: result.status || 400, code: 'IMAGE_ERROR', message: result.error };
    }
    return result.data;
  }

  async handleSetCategoryImage(data) {
    const result = await this.toolSetCategoryImage(data);
    if (result.error) {
      throw { status: result.status || 400, code: 'IMAGE_ERROR', message: result.error };
    }
    return result.data;
  }

  // ==========================================
  // Pipeline Handlers — bridge frontend panels to local service providers
  // ==========================================

  async handleSharpPrepareOcr(data) {
    const { project_id } = data;
    const provider = getSharpProvider();
    const result = await provider['prepare-ocr']({
      image: this.resolveFilePath(data.image, project_id),
      options: data.options || {}
    });

    if (result.success && result.image && this.getPaths(project_id)) {
      try {
        const { relativePath } = await this.savePipelineFile(result.image, 'prepared', project_id);
        result.path = relativePath;
      } catch (err) {
        this.logger.warn('menu-generator.pipeline.save_failed', { step: 'prepare', project_id, error: err.message });
      }
    }

    return result;
  }

  async handlePdfjsInfo(data) {
    const { project_id } = data;
    const provider = getPdfjsProvider();
    const result = await provider.info({ pdf: this.resolveFilePath(data.pdf, project_id) });
    return result.data || result;
  }

  async handlePdfjsRender(data) {
    const { project_id } = data;
    const provider = getPdfjsProvider();
    const result = await provider.render({
      pdf: this.resolveFilePath(data.pdf, project_id),
      page: data.page || 1,
      scale: data.scale || 2.0
    });

    const renderData = result.data || result;

    if (renderData.image && this.getPaths(project_id)) {
      try {
        const page = data.page || 1;
        const { relativePath } = await this.savePipelineFile(renderData.image, `page${page}`, project_id);
        renderData.path = relativePath;
      } catch (err) {
        this.logger.warn('menu-generator.pipeline.save_failed', { step: 'render', project_id, error: err.message });
      }
    }

    return renderData;
  }

  async handleGoogleVisionExtract(data) {
    const { project_id } = data;
    const provider = getGoogleVisionProvider();
    const result = await provider.extract({
      image: this.resolveFilePath(data.image, project_id),
      hint: data.hint || 'DOCUMENT_TEXT_DETECTION',
      languageHints: data.languageHints || []
    });

    const text = result.text || result.data?.text;
    if (text) {
      result.ocr_path = await this.saveOcrResult(text, 'gvision', project_id);
    }
    return result;
  }

  async handleTesseractExtract(data) {
    const { project_id } = data;
    const provider = getTesseractProvider();
    const result = await provider.extract({
      image: this.resolveFilePath(data.image, project_id),
      language: data.language || 'eng'
    });
    const out = result.data || result;

    const text = out.text;
    if (text) {
      out.ocr_path = await this.saveOcrResult(text, 'tesseract', project_id);
    }
    return out;
  }

  async handleScribeOcrExtract(data) {
    const { project_id } = data;
    const provider = getScribeOcrProvider();
    const result = await provider.extract({
      input: this.resolveFilePath(data.input || data.image, project_id),
      lang: data.lang || data.language || 'eng'
    });
    const out = result.data || result;

    const text = out.text;
    if (text) {
      out.ocr_path = await this.saveOcrResult(text, 'scribe', project_id);
    }
    return out;
  }

  async handleDocumentProcessorProcess(data) {
    const { project_id } = data;
    const provider = getDocumentProcessorProvider();
    const result = await provider.process({
      document: this.resolveFilePath(data.document || data.image, project_id),
      language: data.language || 'es'
    });
    const out = result.data || result;

    const text = out.text;
    if (text) {
      out.ocr_path = await this.saveOcrResult(text, 'docproc', project_id);
    }
    return out;
  }

  // ==========================================
  // Tools — expuestos al LLM via agentic loop
  // ==========================================

  async toolGenerate({ texto, nombre, project_id }) {
    if (!texto || texto.trim().length < 10) {
      return { status: 400, error: 'Se requiere "texto" con el contenido de la carta (mínimo 10 caracteres)' };
    }
    if (!project_id) {
      return { status: 400, error: 'Se requiere "project_id"' };
    }

    const cartaId = `carta_${Date.now().toString(36)}`;
    const requestId = crypto.randomUUID();

    this.pendingAI.set(requestId, {
      id: cartaId,
      project_id,
      nombre: nombre || 'Carta sin nombre',
      created_at: new Date().toISOString()
    });

    await this.eventBus.publish('ai.chat.request', {
      request_id: requestId,
      messages: [
        { role: 'system', content: PROMPT_EXTRACCION },
        { role: 'user', content: texto }
      ],
      provider: 'auto',
      temperature: 0.1,
      max_tokens: 8000,
      stream: false,
      tools: false
    }, { correlationId: requestId });

    this.metrics?.increment('menu.generate.requested');
    this.logger.info('menu.generate.requested', { carta_id: cartaId, project_id, texto_length: texto.length });

    return {
      status: 202,
      data: {
        carta_id: cartaId,
        estado: 'generando',
        message: 'Carta en proceso de generación. Usa menu.get_carta con este ID para ver el resultado.'
      }
    };
  }

  async toolListCartas({ project_id }) {
    if (!project_id) return { status: 400, error: 'Se requiere "project_id"' };

    const cartas = Array.from(this.getCartas(project_id).values())
      .sort((a, b) => new Date(b.meta.created_at) - new Date(a.meta.created_at));

    const pendientes = Array.from(this.pendingAI.values())
      .filter(p => p.project_id === project_id);

    const lista = [
      ...pendientes.map(p => ({
        id: p.id, nombre: p.nombre, estado: 'generando',
        productos: 0, categorias: 0, created_at: p.created_at
      })),
      ...cartas.map(c => ({
        id: c.meta.id, nombre: c.meta.nombre, estado: 'generado',
        productos: c.productos.length, categorias: c.categorias.length,
        created_at: c.meta.created_at
      }))
    ];

    return { status: 200, data: { cartas: lista, total: lista.length } };
  }

  async toolGetCarta({ carta_id, project_id }) {
    if (!carta_id) return { status: 400, error: 'Se requiere carta_id' };
    if (!project_id) return { status: 400, error: 'Se requiere project_id' };

    const carta = this.getCartas(project_id).get(carta_id);
    if (!carta) {
      const pending = Array.from(this.pendingAI.values()).find(p => p.id === carta_id && p.project_id === project_id);
      if (pending) {
        return { status: 200, data: { id: carta_id, estado: 'generando', message: 'La carta aún se está generando' } };
      }
      return { status: 404, error: `Carta "${carta_id}" no encontrada` };
    }

    return { status: 200, data: carta };
  }

  async toolUpdatePrices({ carta_id, project_id, porcentaje, categoria, precios }) {
    if (!project_id) return { status: 400, error: 'Se requiere project_id' };
    const carta = this.getCartas(project_id).get(carta_id);
    if (!carta) return { status: 404, error: `Carta "${carta_id}" no encontrada` };

    if (!porcentaje && !precios) {
      return { status: 400, error: 'Se requiere "porcentaje" o "precios" (objeto {producto_id: nuevo_precio})' };
    }

    const cambios = [];

    if (precios && typeof precios === 'object') {
      for (const [prodId, nuevoPrecio] of Object.entries(precios)) {
        const prod = carta.productos.find(p => p.id === prodId);
        if (prod) {
          const anterior = prod.precio;
          prod.precio = Number(nuevoPrecio);
          cambios.push({ id: prodId, nombre: prod.nombre, anterior, nuevo: prod.precio });
        }
      }
    }

    if (typeof porcentaje === 'number') {
      const factor = 1 + porcentaje / 100;
      for (const prod of carta.productos) {
        if (categoria && prod.categoria !== categoria) continue;
        if (precios && precios[prod.id] !== undefined) continue;

        const anterior = prod.precio;
        prod.precio = Math.round(prod.precio * factor * 100) / 100;
        cambios.push({ id: prod.id, nombre: prod.nombre, anterior, nuevo: prod.precio });
      }
    }

    this.metrics?.increment('menu.prices.updated');
    await this.saveCartaToDisk(carta, project_id);

    await this.eventBus.publish('carta.generada', { ...carta, project_id });

    return {
      status: 200,
      data: {
        carta_id,
        productos_actualizados: cambios.length,
        cambios
      }
    };
  }

  async toolAddProduct({ carta_id, project_id, nombre, categoria, precio, ingredientes }) {
    if (!project_id) return { status: 400, error: 'Se requiere project_id' };
    const carta = this.getCartas(project_id).get(carta_id);
    if (!carta) return { status: 404, error: `Carta "${carta_id}" no encontrada` };

    const cat = carta.categorias.find(c => c.id === categoria);
    if (!cat) {
      return { status: 400, error: `Categoría "${categoria}" no existe en la carta. Categorías: ${carta.categorias.map(c => c.id).join(', ')}` };
    }

    const prodId = `${this.slugify(categoria)}_${this.slugify(nombre)}`;

    if (carta.productos.find(p => p.id === prodId)) {
      return { status: 409, error: `Ya existe un producto con ID "${prodId}"` };
    }

    const producto = {
      id: prodId,
      nombre,
      categoria,
      precio: Number(precio),
      ingredientes: this.normalizeIngredientes(ingredientes || [])
    };

    carta.productos.push(producto);
    this.metrics?.increment('menu.product.added');
    await this.saveCartaToDisk(carta, project_id);

    await this.eventBus.publish('carta.generada', { ...carta, project_id });

    return { status: 201, data: producto };
  }

  async toolRemoveProduct({ carta_id, project_id, producto_id }) {
    if (!project_id) return { status: 400, error: 'Se requiere project_id' };
    const carta = this.getCartas(project_id).get(carta_id);
    if (!carta) return { status: 404, error: `Carta "${carta_id}" no encontrada` };

    const idx = carta.productos.findIndex(p => p.id === producto_id);
    if (idx === -1) return { status: 404, error: `Producto "${producto_id}" no encontrado en la carta` };

    const removed = carta.productos.splice(idx, 1)[0];
    this.metrics?.increment('menu.product.removed');
    await this.saveCartaToDisk(carta, project_id);

    await this.eventBus.publish('carta.generada', { ...carta, project_id });

    return { status: 200, data: { removed: removed.nombre, productos_restantes: carta.productos.length } };
  }

  async toolAddCategory({ carta_id, project_id, nombre }) {
    if (!project_id) return { status: 400, error: 'Se requiere project_id' };
    const carta = this.getCartas(project_id).get(carta_id);
    if (!carta) return { status: 404, error: `Carta "${carta_id}" no encontrada` };

    const catId = this.slugify(nombre);
    if (carta.categorias.find(c => c.id === catId)) {
      return { status: 409, error: `Ya existe categoría "${catId}"` };
    }

    const maxOrden = carta.categorias.reduce((max, c) => Math.max(max, c.orden), 0);
    const categoria = { id: catId, nombre, orden: maxOrden + 1 };
    carta.categorias.push(categoria);

    return { status: 201, data: categoria };
  }

  async toolUpdateProduct({ carta_id, project_id, producto_id, nombre, precio, categoria, ingredientes }) {
    if (!project_id) return { status: 400, error: 'Se requiere project_id' };
    const carta = this.getCartas(project_id).get(carta_id);
    if (!carta) return { status: 404, error: `Carta "${carta_id}" no encontrada` };

    const prod = carta.productos.find(p => p.id === producto_id);
    if (!prod) return { status: 404, error: `Producto "${producto_id}" no encontrado` };

    if (nombre !== undefined) prod.nombre = nombre;
    if (precio !== undefined) prod.precio = Number(precio);
    if (categoria !== undefined) {
      if (!carta.categorias.find(c => c.id === categoria)) {
        return { status: 400, error: `Categoría "${categoria}" no existe` };
      }
      prod.categoria = categoria;
    }
    if (ingredientes !== undefined) {
      prod.ingredientes = this.normalizeIngredientes(ingredientes);
    }

    await this.saveCartaToDisk(carta, project_id);
    await this.eventBus.publish('carta.generada', { ...carta, project_id });

    return { status: 200, data: prod };
  }

  async toolUpdateIngredientPrices({ carta_id, project_id, precios, porcentaje, tipo, precio_extra }) {
    if (!project_id) return { status: 400, error: 'Se requiere project_id' };
    const carta = this.getCartas(project_id).get(carta_id);
    if (!carta) return { status: 404, error: `Carta "${carta_id}" no encontrada` };

    if (!precios && porcentaje === undefined && precio_extra === undefined) {
      return { status: 400, error: 'Se requiere "precios" (objeto {nombre: precio}), "precio_extra" (número fijo) o "porcentaje" (número)' };
    }

    const cambios = [];
    const preciosNorm = {};
    if (precios && typeof precios === 'object') {
      for (const [nombre, precio] of Object.entries(precios)) {
        preciosNorm[nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')] = Number(precio);
      }
    }

    for (const prod of carta.productos) {
      for (const ing of (prod.ingredientes || [])) {
        const ingNorm = ing.nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const anterior = ing.precio_extra ?? 0;

        if (preciosNorm[ingNorm] !== undefined) {
          // Precio individual por nombre
          ing.precio_extra = preciosNorm[ingNorm];
          if (ing.precio_extra !== anterior) {
            cambios.push({ ingrediente: ing.nombre, producto: prod.nombre, anterior, nuevo: ing.precio_extra });
          }
        } else if (typeof precio_extra === 'number') {
          // Precio fijo para todos o filtrado por tipo
          if (tipo && ing.tipo !== tipo) continue;
          ing.precio_extra = precio_extra;
          if (precio_extra !== anterior) {
            cambios.push({ ingrediente: ing.nombre, producto: prod.nombre, anterior, nuevo: precio_extra });
          }
        } else if (typeof porcentaje === 'number') {
          // Porcentaje sobre precio actual
          if (tipo && ing.tipo !== tipo) continue;
          const nuevoP = Math.round(anterior * (1 + porcentaje / 100) * 100) / 100;
          ing.precio_extra = nuevoP;
          if (nuevoP !== anterior) {
            cambios.push({ ingrediente: ing.nombre, producto: prod.nombre, anterior, nuevo: nuevoP });
          }
        }
      }
    }

    if (cambios.length === 0) {
      return { status: 200, data: { carta_id, cambios: [], message: 'No se encontraron ingredientes que modificar' } };
    }

    await this.saveCartaToDisk(carta, project_id);
    this.metrics?.increment('menu.ingredient_prices.updated');

    // Publicar cambios individuales para que ingredientes y productos actualicen en tiempo real
    const ingredientesActualizados = new Map();
    for (const c of cambios) {
      const id = `ing_${this.slugify(c.ingrediente)}`;
      if (!ingredientesActualizados.has(id)) {
        ingredientesActualizados.set(id, { nombre: c.ingrediente, precio_extra: c.nuevo, anterior: c.anterior });
      }
    }

    for (const [id, data] of ingredientesActualizados) {
      await this.eventBus.publish('ingrediente.actualizado', {
        ingrediente_id: id,
        cambios: { precio_extra: { anterior: data.anterior, nuevo: data.precio_extra } },
        updated_at: new Date().toISOString()
      });
    }

    return {
      status: 200,
      data: {
        carta_id,
        ingredientes_actualizados: ingredientesActualizados.size,
        cambios_en_productos: cambios.length,
        cambios
      }
    };
  }

  async toolSearchProducts({ carta_id, project_id, query }) {
    if (!project_id) return { status: 400, error: 'Se requiere project_id' };
    const carta = this.getCartas(project_id).get(carta_id);
    if (!carta) return { status: 404, error: `Carta "${carta_id}" no encontrada` };

    if (!query) return { status: 400, error: 'Se requiere "query"' };

    const q = query.toLowerCase();
    const results = carta.productos.filter(p =>
      p.nombre.toLowerCase().includes(q) ||
      p.ingredientes.some(i => i.nombre.toLowerCase().includes(q))
    );

    return {
      status: 200,
      data: {
        query,
        resultados: results.length,
        productos: results
      }
    };
  }

  async toolStats({ carta_id, project_id }) {
    if (!project_id) return { status: 400, error: 'Se requiere project_id' };
    const carta = this.getCartas(project_id).get(carta_id);
    if (!carta) return { status: 404, error: `Carta "${carta_id}" no encontrada` };

    const precios = carta.productos.map(p => p.precio).filter(p => p > 0);
    const porCategoria = {};
    for (const p of carta.productos) {
      porCategoria[p.categoria] = (porCategoria[p.categoria] || 0) + 1;
    }

    return {
      status: 200,
      data: {
        carta_id,
        nombre: carta.meta.nombre,
        total_productos: carta.productos.length,
        total_categorias: carta.categorias.length,
        total_ingredientes: carta.productos.reduce((sum, p) => sum + p.ingredientes.length, 0),
        precio_min: precios.length > 0 ? Math.min(...precios) : 0,
        precio_max: precios.length > 0 ? Math.max(...precios) : 0,
        precio_medio: precios.length > 0 ? Math.round(precios.reduce((a, b) => a + b, 0) / precios.length * 100) / 100 : 0,
        por_categoria: porCategoria
      }
    };
  }

  // ==========================================
  // AI Response Handler
  // ==========================================

  async onAIChatResponse(event) {
    const eventData = event?.data || event?.payload || event;
    const correlationId =
      event?.metadata?.correlationId ||
      eventData?.correlation_id ||
      eventData?.request_id;

    const pendingData = this.pendingAI.get(correlationId);
    if (!pendingData) return;

    this.pendingAI.delete(correlationId);
    const { id: cartaId, nombre, project_id, _enrichment } = pendingData;

    if (!eventData.success && eventData.error) {
      this.logger.error('menu.generate.ai_error', { carta_id: cartaId, project_id, error: eventData.error });
      this.metrics?.increment('menu.generate.errors');
      await this.eventBus.publish('menu.error', {
        carta_id: cartaId,
        project_id,
        error_type: 'ai_processing_failed',
        message: eventData.error
      }, { correlationId });
      return;
    }

    try {
      const content = eventData.content || eventData.text || '';

      // Enrichment response — apply to existing carta
      if (_enrichment) {
        const carta = this.getCartas(project_id).get(cartaId);
        if (!carta) {
          this.logger.warn('menu.enrich.carta_not_found', { carta_id: cartaId, project_id });
          return;
        }

        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('La IA no devolvió un JSON válido para enrichment');

        const enrichmentData = JSON.parse(jsonMatch[0]);
        const enriched = this.applyEnrichment(carta, enrichmentData, project_id);

        await this.saveCartaToDisk(carta, project_id);
        this.metrics?.increment('menu.enrich.completed');

        await this.eventBus.publish('carta.generada', { ...carta, project_id }, { correlationId });

        this.logger.info('menu.enrich.completed', {
          carta_id: cartaId,
          project_id,
          productos_enriched: enriched
        });
        return;
      }

      // Standard generation response
      const carta = this.parseAndStructure(cartaId, nombre, content);

      this.getCartas(project_id).set(cartaId, carta);
      await this.saveCartaToDisk(carta, project_id);
      this.metrics?.increment('menu.generate.completed');

      await this.eventBus.publish('carta.generada', { ...carta, project_id }, { correlationId });

      this.logger.info('menu.generate.completed', {
        carta_id: cartaId,
        project_id,
        productos: carta.productos.length,
        categorias: carta.categorias.length
      });
    } catch (err) {
      this.logger.error('menu.generate.parse_error', { carta_id: cartaId, project_id, error: err.message });
      this.metrics?.increment('menu.generate.errors');
      await this.eventBus.publish('menu.error', {
        carta_id: cartaId,
        project_id,
        error_type: 'parse_failed',
        message: err.message
      }, { correlationId });
    }
  }

  // ==========================================
  // Parsing
  // ==========================================

  parseAndStructure(cartaId, nombre, aiContent) {
    const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('La IA no devolvió un JSON válido');

    const raw = JSON.parse(jsonMatch[0]);

    const categorias = (raw.categorias || []).map((cat, idx) => ({
      id: cat.id || this.slugify(cat.nombre),
      nombre: cat.nombre,
      orden: cat.orden !== undefined ? cat.orden : idx + 1
    }));

    const productos = (raw.productos || []).map(p => ({
      id: p.id || `${this.slugify(p.categoria || 'general')}_${this.slugify(p.nombre)}`,
      nombre: p.nombre,
      categoria: p.categoria || 'general',
      precio: typeof p.precio === 'number' ? p.precio : parseFloat(p.precio) || 0,
      ingredientes: this.normalizeIngredientes(p.ingredientes || [])
    }));

    if (productos.length === 0) throw new Error('La IA no extrajo ningún producto');

    return {
      meta: {
        id: cartaId,
        nombre: raw.nombre_carta || nombre,
        generado_desde: 'texto',
        // precio_extra siempre 0 por defecto — el jefe configura precios via chat
        created_at: new Date().toISOString()
      },
      categorias,
      productos
    };
  }

  normalizeIngredientes(ingredientes) {
    if (typeof ingredientes === 'string') {
      return ingredientes.split(',')
        .map(s => this.parseIngredienteString(s.trim()))
        .filter(i => i.nombre.length > 0);
    }

    if (Array.isArray(ingredientes)) {
      return ingredientes.map(ing => {
        if (typeof ing === 'string') return this.parseIngredienteString(ing);
        const result = { nombre: ing.nombre || ing.name || '', emoji: ing.emoji || '' };
        if (ing.tipo) result.tipo = ing.tipo;
        if (ing.precio_extra != null) result.precio_extra = ing.precio_extra;
        return result;
      }).filter(i => i.nombre.length > 0);
    }

    return [];
  }

  parseIngredienteString(str) {
    const emojiRegex = /([\p{Emoji_Presentation}\p{Extended_Pictographic}])/u;
    const match = str.match(emojiRegex);
    const nombre = str.replace(emojiRegex, '').trim();
    return { nombre, emoji: match ? match[1] : '' };
  }

  // ==========================================
  // Export to POS — bridge carta → menu.generado/menu.validado
  // ==========================================

  /**
   * Transform a carta into the menu.generado event format expected by
   * productos, categorias, and ingredientes modules.
   */
  transformCartaToPOS(carta, projectId) {
    // Build deduplicated ingredientes_catalogo from all products
    // Cada ingrediente acumula grupos[] = categorías de producto donde aparece
    const ingredientesMap = new Map();
    for (const prod of carta.productos) {
      const grupo = prod.categoria || 'otro';
      for (const ing of (prod.ingredientes || [])) {
        const id = `ing_${this.slugify(ing.nombre)}`;
        if (!ingredientesMap.has(id)) {
          const tipo = ing.tipo || this.clasificarIngrediente(ing.nombre);
          ingredientesMap.set(id, {
            id,
            nombre: ing.nombre,
            emoji: ing.emoji || '',
            tipo,
            es_alergeno: false,
            precio_extra: ing.precio_extra ?? 0,
            grupos: [grupo]
          });
        } else {
          // Ingrediente ya existe — añadir grupo si no está
          const existing = ingredientesMap.get(id);
          if (!existing.grupos.includes(grupo)) {
            existing.grupos.push(grupo);
          }
        }
      }
    }

    // Transform productos: ingredientes → ingredientes_base with IDs
    const productos = carta.productos.map(p => {
      const grupo = p.categoria || 'otro';
      return {
        id: p.id,
        nombre: p.nombre,
        categoria: p.categoria,
        precio: p.precio,
        ingredientes_base: (p.ingredientes || []).map(ing => {
          const id = `ing_${this.slugify(ing.nombre)}`;
          const catalogEntry = ingredientesMap.get(id);
          return {
            id,
            nombre: ing.nombre,
            emoji: ing.emoji || '',
            precio_extra: catalogEntry?.precio_extra ?? ing.precio_extra ?? 0,
            grupo
          };
        }),
        activo: true
      };
    });

    return {
      menu_id: carta.meta.id,
      project_id: projectId,
      productos,
      categorias: carta.categorias,
      ingredientes_catalogo: Array.from(ingredientesMap.values())
    };
  }

  async toolExportToPOS({ carta_id, project_id }) {
    if (!carta_id) return { status: 400, error: 'Se requiere carta_id' };
    if (!project_id) return { status: 400, error: 'Se requiere project_id' };

    const carta = this.getCartas(project_id).get(carta_id);
    if (!carta) return { status: 404, error: `Carta "${carta_id}" no encontrada` };

    const correlationId = crypto.randomUUID();
    const payload = this.transformCartaToPOS(carta, project_id);

    this.logger.info('menu.export_to_pos.start', {
      carta_id,
      project_id,
      productos: payload.productos.length,
      categorias: payload.categorias.length,
      ingredientes: payload.ingredientes_catalogo.length,
      correlation_id: correlationId
    });

    // 1) menu.generado → categorias sync + ingredientes sync + productos draft
    await this.eventBus.publish('menu.generado', payload, { correlationId });

    // 2) menu.validado (sin correcciones) → productos sync catalogo
    await this.eventBus.publish('menu.validado', {
      menu_id: carta.meta.id,
      correcciones: []
    }, { correlationId });

    this.logger.info('menu.export_to_pos.completed', {
      carta_id,
      project_id,
      correlation_id: correlationId
    });

    return {
      status: 200,
      data: {
        carta_id,
        project_id,
        exportado: {
          productos: payload.productos.length,
          categorias: payload.categorias.length,
          ingredientes: payload.ingredientes_catalogo.length
        },
        eventos_publicados: ['menu.generado', 'menu.validado'],
        message: `Carta "${carta.meta.nombre}" exportada al POS. ${payload.productos.length} productos, ${payload.categorias.length} categorías, ${payload.ingredientes_catalogo.length} ingredientes sincronizados.`
      }
    };
  }

  async handleExport(data) {
    const result = await this.toolExportToPOS({ carta_id: data.carta_id || data.id, project_id: data.project_id });
    if (result.error) {
      throw { status: result.status || 400, code: 'EXPORT_ERROR', message: result.error };
    }
    return result.data;
  }

  // ==========================================
  // Utils
  // ==========================================

  slugify(text) {
    if (!text) return 'sin_nombre';
    return text.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      || 'sin_nombre';
  }

  /**
   * Clasifica un ingrediente por nombre cuando la IA no proporcionó tipo.
   * Fallback para cartas existentes sin datos enriquecidos.
   */
  clasificarIngrediente(nombre) {
    if (!nombre) return 'otro';
    const n = nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // Quesos
    if (/mozzarella|queso|mezcla de quesos|parmesano|gorgonzola|cheddar|emmental|brie|gouda|provolone|roquefort/.test(n)) return 'queso';
    // Carnes
    if (/bacon|pollo|ternera|carne|york|jamon|pepperoni|peperoni|salchich|chorizo|lomo|cerdo|pavo|salami|anchoa/.test(n)) return 'carne';
    // Mariscos
    if (/gambas|langostino|atun|salmon|marisco|pulpo|calamar|mejillon|surimi/.test(n)) return 'marisco';
    // Salsas
    if (/salsa|nata|pesto|carbonara|boloñesa|bolognesa|ketchup|mayonesa|alioli|mostaza/.test(n)) return 'salsa';
    // Verduras (amplio)
    if (/tomate|cebolla|pimiento|champiñon|champinon|seta|aceituna|oliva|alcachofa|esparrago|espinaca|rucula|albahaca|oregano|ajo|maiz|pina|piña|jalapeño|jalapeno|pepino|lechuga|zanahoria|berenjena|calabacin/.test(n)) return 'verdura';
    // Masas
    if (/masa|harina|levadura/.test(n)) return 'masa';

    return 'otro';
  }

  // ==========================================
  // Content Enrichment — tools para carta digital
  // ==========================================

  /**
   * Enriquece productos de una carta con descripciones, emojis e ingredientes
   * clasificados via AI. Guarda los datos enriquecidos directamente en la carta JSON.
   */
  async toolEnrichProducts({ carta_id, project_id, producto_ids, idioma }) {
    if (!project_id) return { status: 400, error: 'Se requiere project_id' };
    const carta = this.getCartas(project_id).get(carta_id);
    if (!carta) return { status: 404, error: `Carta "${carta_id}" no encontrada` };

    const lang = idioma || 'es';
    const targets = producto_ids
      ? carta.productos.filter(p => producto_ids.includes(p.id))
      : carta.productos;

    if (targets.length === 0) {
      return { status: 400, error: 'No hay productos para enriquecer' };
    }

    const requestId = crypto.randomUUID();

    // Build AI prompt
    const productosTexto = targets.map(p => {
      const ings = (p.ingredientes || []).map(i => i.nombre).join(', ');
      return `- ${p.id}: "${p.nombre}" (${p.precio}€) — Ingredientes: ${ings || 'N/A'}`;
    }).join('\n');

    const prompt = `Eres un copywriter gastronómico experto para cartas digitales de restaurantes.

Para cada producto de la siguiente lista, genera:
1. "descripcion": Una descripción atractiva y breve (máximo 2 frases, ~30 palabras). Destaca los sabores y la experiencia. No repitas el nombre del producto.
2. "emoji": Un único emoji que mejor represente el producto (basándote en su ingrediente principal o personalidad).
3. "tags": Array de 1-3 tags relevantes del producto. Opciones válidas: "picante", "vegetariano", "vegano", "sin_gluten", "popular", "nuevo", "especial", "clasico", "premium".
4. "ingredientes_enriquecidos": Array con cada ingrediente del producto enriquecido:
   - "nombre": nombre original
   - "emoji": emoji representativo del ingrediente
   - "tipo": uno de "queso", "carne", "verdura", "salsa", "masa", "marisco", "otro"

PRODUCTOS:
${productosTexto}

Idioma de las descripciones: ${lang === 'es' ? 'español' : lang}

Devuelve SOLO un JSON con este formato exacto, sin explicaciones:
{
  "productos": [
    {
      "id": "producto_id",
      "descripcion": "Descripción atractiva...",
      "emoji": "🍕",
      "tags": ["clasico"],
      "ingredientes_enriquecidos": [
        { "nombre": "Tomate", "emoji": "🍅", "tipo": "verdura" }
      ]
    }
  ]
}`;

    this.pendingAI.set(requestId, {
      id: carta_id,
      project_id,
      _enrichment: true,
      targets: targets.map(t => t.id),
      created_at: new Date().toISOString()
    });

    await this.eventBus.publish('ai.chat.request', {
      request_id: requestId,
      messages: [
        { role: 'system', content: prompt }
      ],
      provider: 'auto',
      temperature: 0.7,
      max_tokens: 4000,
      stream: false,
      tools: false
    }, { correlationId: requestId });

    this.metrics?.increment('menu.enrich.requested');
    this.logger.info('menu.enrich.requested', {
      carta_id, project_id,
      productos: targets.length
    });

    return {
      status: 202,
      data: {
        carta_id,
        productos_en_proceso: targets.length,
        estado: 'enriqueciendo',
        message: `Enriqueciendo ${targets.length} productos. Usa menu.get_carta para ver el resultado cuando termine.`
      }
    };
  }

  /**
   * Apply AI enrichment results to carta products.
   * Called from onAIChatResponse when the pending entry has _enrichment flag.
   */
  applyEnrichment(carta, enrichmentData, projectId) {
    const productoMap = new Map(carta.productos.map(p => [p.id, p]));
    let enriched = 0;

    for (const item of (enrichmentData.productos || [])) {
      const prod = productoMap.get(item.id);
      if (!prod) continue;

      if (item.descripcion) prod.descripcion = item.descripcion;
      if (item.emoji) prod.emoji = item.emoji;
      if (item.tags) prod.tags = item.tags;

      // Merge enriched ingredient data back
      if (item.ingredientes_enriquecidos && Array.isArray(item.ingredientes_enriquecidos)) {
        const enrichedIngs = new Map(item.ingredientes_enriquecidos.map(i => [
          i.nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
          i
        ]));

        for (const ing of (prod.ingredientes || [])) {
          const key = ing.nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const enrichedIng = enrichedIngs.get(key);
          if (enrichedIng) {
            if (enrichedIng.emoji) ing.emoji = enrichedIng.emoji;
            if (enrichedIng.tipo) ing.tipo = enrichedIng.tipo;
          }
        }
      }

      enriched++;
    }

    // Mark carta as enriched
    if (!carta.meta.enrichment) carta.meta.enrichment = {};
    carta.meta.enrichment.last_enriched_at = new Date().toISOString();
    carta.meta.enrichment.productos_enriched = enriched;

    return enriched;
  }

  /**
   * Asocia una imagen a un producto de la carta.
   * La imagen puede ser una ruta relativa al storage del proyecto,
   * una ruta absoluta local, o una URL externa.
   */
  async toolSetProductImage({ carta_id, project_id, producto_id, imagen, imagen_base64 }) {
    if (!project_id) return { status: 400, error: 'Se requiere project_id' };
    if (!producto_id) return { status: 400, error: 'Se requiere producto_id' };
    const carta = this.getCartas(project_id).get(carta_id);
    if (!carta) return { status: 404, error: `Carta "${carta_id}" no encontrada` };

    const prod = carta.productos.find(p => p.id === producto_id);
    if (!prod) return { status: 404, error: `Producto "${producto_id}" no encontrado` };

    // If base64 image provided, save it to disk
    if (imagen_base64) {
      try {
        const { relativePath } = await this.saveMediaFile(
          imagen_base64, `prod_${this.slugify(prod.nombre)}`, project_id, 'productos', '.jpg'
        );
        prod.imagen = relativePath;
      } catch (err) {
        return { status: 500, error: `Error guardando imagen: ${err.message}` };
      }
    } else if (imagen) {
      prod.imagen = imagen;
    } else {
      return { status: 400, error: 'Se requiere "imagen" (ruta) o "imagen_base64" (base64)' };
    }

    await this.saveCartaToDisk(carta, project_id);
    await this.eventBus.publish('carta.generada', { ...carta, project_id });

    this.logger.info('menu.product_image.set', {
      carta_id, project_id, producto_id,
      imagen: prod.imagen
    });

    return {
      status: 200,
      data: {
        producto_id,
        imagen: prod.imagen,
        message: `Imagen asignada a "${prod.nombre}"`
      }
    };
  }

  /**
   * Asocia una imagen a una categoría de la carta.
   */
  async toolSetCategoryImage({ carta_id, project_id, categoria_id, imagen, imagen_base64, icon }) {
    if (!project_id) return { status: 400, error: 'Se requiere project_id' };
    const carta = this.getCartas(project_id).get(carta_id);
    if (!carta) return { status: 404, error: `Carta "${carta_id}" no encontrada` };

    const cat = carta.categorias.find(c => c.id === categoria_id);
    if (!cat) return { status: 404, error: `Categoría "${categoria_id}" no encontrada` };

    if (imagen_base64) {
      try {
        const { relativePath } = await this.saveMediaFile(
          imagen_base64, `cat_${this.slugify(cat.nombre)}`, project_id, 'categorias', '.jpg'
        );
        cat.imagen = relativePath;
      } catch (err) {
        return { status: 500, error: `Error guardando imagen: ${err.message}` };
      }
    } else if (imagen) {
      cat.imagen = imagen;
    }
    if (icon) cat.icon = icon;

    await this.saveCartaToDisk(carta, project_id);

    return {
      status: 200,
      data: { categoria_id, imagen: cat.imagen, icon: cat.icon }
    };
  }

}

module.exports = MenuGeneratorModule;
