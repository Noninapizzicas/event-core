/**
 * Carta Impresion v1.0.0
 *
 * Renderiza cartas del restaurante en HTML listo para imprimir desde el navegador.
 * El LLM llama a las tools desde el chat; sin UI propia, sin llamadas AI.
 *
 * Tools:
 *   carta.render            — Genera HTML de una carta con la plantilla elegida
 *   carta.plantillas        — Lista plantillas disponibles (globales + proyecto)
 *   carta.plantilla_crear   — Crea plantilla personalizada para el proyecto
 *   carta.plantilla_eliminar— Elimina plantilla del proyecto
 *
 * Flujo:
 *   usuario pide imprimir → LLM llama carta.render(carta_id, plantilla_id)
 *   → lee carta del disco → aplica plantilla → guarda .html
 *   → devuelve ruta → usuario abre en navegador → Ctrl+P
 *
 * Plantillas built-in: templates/*.html (siempre disponibles)
 * Plantillas proyecto: storage/pizzepos/carta-templates/{id}.json + .html
 * HTML generados:      storage/pizzepos/cartas-html/{carta_id}_{plantilla_id}_{ts}.html
 */

const path = require('path');
const fs = require('fs').promises;

// Plantillas built-in incluidas con el módulo
const PLANTILLAS_GLOBALES = [
  {
    id: 'a4-clasica',
    nombre: 'A4 Clásica',
    descripcion: 'Carta completa en A4 vertical. Ideal para cartas con muchos productos y categorías.',
    formato: 'A4',
    orientacion: 'portrait',
    global: true
  },
  {
    id: 'a5-menu-dia',
    nombre: 'A5 Menú del Día',
    descripcion: 'Formato A5 compacto. Perfecto para menú del día o cartas cortas.',
    formato: 'A5',
    orientacion: 'portrait',
    global: true
  },
  {
    id: 'a4-cuadruple',
    nombre: 'A4 Cuádruple (4 por hoja)',
    descripcion: 'Cuatro cartas en un A4 para recortar. Óptimo para cartas muy cortas (hasta 2 categorías).',
    formato: 'A4',
    orientacion: 'portrait',
    global: true
  },
  {
    id: 'a4-diptico',
    nombre: 'A4 Díptico',
    descripcion: 'Dos páginas A5 en un A4 que se dobla por la mitad. Formato clásico de carta de restaurante.',
    formato: 'A4',
    orientacion: 'landscape',
    global: true
  },
  {
    id: 'a4-paisaje-5col',
    nombre: 'A4 Apaisado 5 Columnas',
    descripcion: 'A4 horizontal con 5 columnas CSS. Ideal para muchas categorías en una sola hoja.',
    formato: 'A4',
    orientacion: 'landscape',
    global: true
  }
];

class CartaImpresionModule {
  constructor() {
    this.name = 'carta-impresion';
    this.version = '1.0.0';
    this.eventBus = null;
    this.logger = null;
    this.metrics = null;

    // project_id → { featurePath, storagePath }
    this.projectPaths = new Map();

    // Cache de plantillas globales (HTML cargado en memoria)
    this.globalTemplates = new Map();
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(context) {
    this.eventBus = context.eventBus;
    this.logger = context.logger;
    this.metrics = context.metrics;

    await this.loadGlobalTemplates();

    this.logger.info('module.loaded', { module: this.name, version: this.version });
  }

  async onUnload() {
    this.projectPaths.clear();
    this.globalTemplates.clear();
    this.logger.info('module.unloaded', { module: this.name });
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

    this.logger.info('carta-impresion.project.activated', { project_id });
  }

  async onProjectDeactivated(event) {
    // No-op
  }

  // ==========================================
  // Template Loading (globales desde disco)
  // ==========================================

  async loadGlobalTemplates() {
    const templatesDir = path.join(__dirname, 'templates');
    for (const plantilla of PLANTILLAS_GLOBALES) {
      try {
        const htmlPath = path.join(templatesDir, `${plantilla.id}.html`);
        const html = await fs.readFile(htmlPath, 'utf-8');
        this.globalTemplates.set(plantilla.id, html);
      } catch (err) {
        this.logger.warn('carta-impresion.template.load_failed', { id: plantilla.id, error: err.message });
      }
    }
    this.logger.info('carta-impresion.templates.loaded', { count: this.globalTemplates.size });
  }

  // ==========================================
  // Paths helpers
  // ==========================================

  getPaths(projectId) {
    return this.projectPaths.get(projectId);
  }

  cartasDir(projectId) {
    const p = this.getPaths(projectId);
    return p ? path.join(p.featurePath, 'cartas') : null;
  }

  cartasHtmlDir(projectId) {
    const p = this.getPaths(projectId);
    return p ? path.join(p.featurePath, 'cartas-html') : null;
  }

  cartaTemplatesDir(projectId) {
    const p = this.getPaths(projectId);
    return p ? path.join(p.featurePath, 'carta-templates') : null;
  }

  // ==========================================
  // Tools — expuestos al LLM via agentic loop
  // ==========================================

  async toolRender({ carta_id, plantilla_id = 'a4-clasica', project_id }) {
    if (!carta_id) return { status: 400, error: 'Se requiere carta_id' };
    if (!project_id) return { status: 400, error: 'Se requiere project_id' };

    // 1. Leer la carta del disco (misma ruta que menu-generator guarda)
    const cartaPath = path.join(this.cartasDir(project_id) || '', `${carta_id}.json`);
    let carta;
    try {
      const raw = await fs.readFile(cartaPath, 'utf-8');
      carta = JSON.parse(raw);
    } catch (err) {
      return { status: 404, error: `Carta "${carta_id}" no encontrada en disco. Asegúrate de que existe y está guardada.` };
    }

    // 2. Obtener HTML de la plantilla (global o del proyecto)
    let templateHtml = this.globalTemplates.get(plantilla_id);

    if (!templateHtml) {
      // Buscar en plantillas del proyecto
      const projectTemplate = await this.loadProjectTemplate(plantilla_id, project_id);
      if (!projectTemplate) {
        return { status: 404, error: `Plantilla "${plantilla_id}" no encontrada. Usa carta.plantillas para ver las disponibles.` };
      }
      templateHtml = projectTemplate.html;
    }

    // 3. Renderizar: sustituir marcadores + generar bloques de categorías/productos
    const html = this.render(templateHtml, carta);

    // 4. Guardar HTML generado en disco
    const dir = this.cartasHtmlDir(project_id);
    let htmlPath = null;
    let relativePath = null;

    if (dir) {
      await fs.mkdir(dir, { recursive: true });
      const filename = `${carta_id}_${plantilla_id}_${Date.now().toString(36)}.html`;
      const absolutePath = path.join(dir, filename);
      await fs.writeFile(absolutePath, html, 'utf-8');
      htmlPath = absolutePath;

      const paths = this.getPaths(project_id);
      relativePath = '/' + path.relative(paths.storagePath, absolutePath).replace(/\\/g, '/');
    }

    this.metrics?.increment('carta.render.completed');
    this.logger.info('carta.render.completed', { carta_id, plantilla_id, project_id, path: relativePath });

    const cartaNombre = carta.meta?.nombre || 'Carta';
    const filename = `${cartaNombre}_${plantilla_id}.html`.replace(/[^a-z0-9._-]/gi, '_');

    await this.eventBus.publish('carta.html.generada', {
      carta_id,
      plantilla_id,
      project_id,
      html_path: relativePath,
      // HTML completo incluido para que el frontend pueda mostrar preview inline
      // sin necesidad de leer el fichero desde disco
      html,
      title: cartaNombre,
      filename
    });

    return {
      status: 200,
      data: {
        carta_id,
        carta_nombre: cartaNombre,
        plantilla_id,
        html_path: relativePath,
        productos: carta.productos?.length || 0,
        categorias: carta.categorias?.length || 0,
        message: `Carta "${cartaNombre}" renderizada. El preview se ha abierto en pantalla — usa el botón Imprimir para exportar a PDF.`
      }
    };
  }

  async toolPlantillas({ project_id }) {
    const globales = PLANTILLAS_GLOBALES.map(p => ({
      ...p,
      disponible: this.globalTemplates.has(p.id)
    }));

    let proyecto = [];
    if (project_id) {
      proyecto = await this.listProjectTemplates(project_id);
    }

    return {
      status: 200,
      data: {
        globales,
        proyecto,
        total: globales.length + proyecto.length,
        uso: 'Usa el campo "id" en carta.render como plantilla_id'
      }
    };
  }

  async toolPlantillaCrear({ nombre, html, formato = 'A4', descripcion = '', project_id }) {
    if (!nombre) return { status: 400, error: 'Se requiere "nombre" para la plantilla' };
    if (!html) return { status: 400, error: 'Se requiere "html" con el contenido de la plantilla' };
    if (!project_id) return { status: 400, error: 'Se requiere project_id' };

    const id = `custom_${this.slugify(nombre)}_${Date.now().toString(36)}`;
    const dir = this.cartaTemplatesDir(project_id);
    if (!dir) return { status: 400, error: 'Proyecto sin paths configurados. ¿Está el proyecto activado?' };

    await fs.mkdir(dir, { recursive: true });

    const meta = { id, nombre, formato, descripcion, global: false, created_at: new Date().toISOString() };

    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(meta, null, 2), 'utf-8');
    await fs.writeFile(path.join(dir, `${id}.html`), html, 'utf-8');

    this.metrics?.increment('carta.plantilla.creada');
    this.logger.info('carta.plantilla.creada', { id, nombre, project_id });

    return {
      status: 201,
      data: { ...meta, message: `Plantilla "${nombre}" creada con ID "${id}". Úsala con carta.render(carta_id, "${id}")` }
    };
  }

  async toolPlantillaEliminar({ plantilla_id, project_id }) {
    if (!plantilla_id) return { status: 400, error: 'Se requiere plantilla_id' };
    if (!project_id) return { status: 400, error: 'Se requiere project_id' };

    if (PLANTILLAS_GLOBALES.find(p => p.id === plantilla_id)) {
      return { status: 403, error: `"${plantilla_id}" es una plantilla global y no se puede eliminar` };
    }

    const dir = this.cartaTemplatesDir(project_id);
    if (!dir) return { status: 400, error: 'Proyecto sin paths configurados' };

    const jsonFile = path.join(dir, `${plantilla_id}.json`);
    const htmlFile = path.join(dir, `${plantilla_id}.html`);

    try {
      await fs.unlink(jsonFile);
    } catch (_) { /* ya no existía */ }

    try {
      await fs.unlink(htmlFile);
    } catch (_) {
      return { status: 404, error: `Plantilla "${plantilla_id}" no encontrada en el proyecto` };
    }

    this.metrics?.increment('carta.plantilla.eliminada');
    this.logger.info('carta.plantilla.eliminada', { plantilla_id, project_id });

    return { status: 200, data: { plantilla_id, message: `Plantilla "${plantilla_id}" eliminada` } };
  }

  // ==========================================
  // Plantillas del proyecto — helpers
  // ==========================================

  async loadProjectTemplate(plantillaId, projectId) {
    const dir = this.cartaTemplatesDir(projectId);
    if (!dir) return null;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, `${plantillaId}.json`), 'utf-8'));
      const html = await fs.readFile(path.join(dir, `${plantillaId}.html`), 'utf-8');
      return { ...meta, html };
    } catch (_) {
      return null;
    }
  }

  async listProjectTemplates(projectId) {
    const dir = this.cartaTemplatesDir(projectId);
    if (!dir) return [];
    try {
      const files = await fs.readdir(dir);
      const metas = [];
      for (const file of files.filter(f => f.endsWith('.json'))) {
        try {
          const meta = JSON.parse(await fs.readFile(path.join(dir, file), 'utf-8'));
          metas.push(meta);
        } catch (_) { /* skip */ }
      }
      return metas;
    } catch (_) {
      return [];
    }
  }

  // ==========================================
  // Motor de renderizado de plantillas
  // ==========================================

  /**
   * Sustituye marcadores en el HTML de la plantilla con datos reales de la carta.
   *
   * Marcadores disponibles:
   *   {{nombre_carta}}      — nombre de la carta/restaurante
   *   {{fecha}}             — fecha actual formateada (dd/mm/aaaa)
   *   {{total_productos}}   — número total de productos
   *   {{total_categorias}}  — número total de categorías
   *   {{categorias_html}}   — bloque HTML completo de categorías + productos (generado)
   */
  render(templateHtml, carta) {
    const fecha = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const vars = {
      '{{nombre_carta}}': carta.meta?.nombre || 'Carta',
      '{{fecha}}': fecha,
      '{{total_productos}}': String(carta.productos?.length || 0),
      '{{total_categorias}}': String(carta.categorias?.length || 0),
      '{{categorias_html}}': this.renderCategoriasHtml(carta)
    };

    let html = templateHtml;
    for (const [marker, value] of Object.entries(vars)) {
      html = html.split(marker).join(value);
    }
    return html;
  }

  renderCategoriasHtml(carta) {
    const categorias = carta.categorias || [];
    const productos = carta.productos || [];

    return categorias
      .sort((a, b) => a.orden - b.orden)
      .map(cat => {
        const prods = productos.filter(p => p.categoria === cat.id);
        if (prods.length === 0) return '';

        const productosHtml = prods.map(p => {
          const precio = p.precio > 0
            ? `<span class="precio">${p.precio.toFixed(2).replace('.', ',')} €</span>`
            : '';

          const ingredientes = p.ingredientes?.length
            ? `<span class="ingredientes">${p.ingredientes.map(i => `${i.emoji || ''} ${i.nombre}`.trim()).join(', ')}</span>`
            : '';

          return `
        <div class="producto">
          <div class="producto-header">
            <span class="producto-nombre">${this.escapeHtml(p.nombre)}</span>
            ${precio}
          </div>
          ${ingredientes ? `<div class="producto-ingredientes">${ingredientes}</div>` : ''}
        </div>`.trim();
        }).join('\n        ');

        return `
      <div class="categoria">
        <h2 class="categoria-nombre">${this.escapeHtml(cat.nombre)}</h2>
        <div class="categoria-productos">
          ${productosHtml}
        </div>
      </div>`.trim();
      })
      .filter(Boolean)
      .join('\n      ');
  }

  // ==========================================
  // Utils
  // ==========================================

  escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  slugify(text) {
    if (!text) return 'sin_nombre';
    return text.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      || 'sin_nombre';
  }
}

module.exports = CartaImpresionModule;
