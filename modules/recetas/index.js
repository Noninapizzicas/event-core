/**
 * Recetas Module v1.0.0
 *
 * Gestión de recetas con ingredientes, cantidades y precios de mercado.
 * Base para escandallo y estudio de viabilidad de cualquier negocio alimentario.
 *
 * Tools (expuestos al chat IA):
 *   recetas.crear          — Crea receta con ingredientes y precios
 *   recetas.listar         — Lista recetas del proyecto
 *   recetas.obtener        — Obtiene receta completa por ID
 *   recetas.actualizar     — Modifica receta existente
 *   recetas.eliminar       — Elimina receta
 *   recetas.buscar         — Busca por nombre/ingrediente/categoría
 *   recetas.investigar     — IA propone receta investigada (no guarda)
 *   recetas.ingredientes   — Catálogo de ingredientes del proyecto
 *   recetas.precio_mercado — Actualiza precio de mercado de ingrediente
 *   recetas.duplicar       — Duplica receta para variante
 *   recetas.escandallo     — Calcula desglose de costes
 *   recetas.resumen        — Resumen global de todas las recetas
 *
 * Storage: data/projects/{proyecto}/recetas/
 *   recetas.json       — Array de recetas
 *   ingredientes.json  — Catálogo de ingredientes
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

class RecetasModule {
  constructor() {
    this.name = 'recetas';
    this.version = '1.0.0';
    this.eventBus = null;
    this.logger = null;
    this.metrics = null;

    // Multi-tenant: project_id → { recetas: Map, ingredientes: Map }
    this.dataPerProject = new Map();
    // project_id → { storagePath }
    this.projectPaths = new Map();
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(context) {
    this.eventBus = context.eventBus;
    this.logger = context.logger;
    this.metrics = context.metrics;
    this.logger.info('module.loaded', { module: this.name, version: this.version });
  }

  async onUnload() {
    this.dataPerProject.clear();
    this.projectPaths.clear();
    this.logger.info('module.unloaded', { module: this.name });
  }

  // ==========================================
  // Per-project data access
  // ==========================================

  resolveToActiveProject(projectId) {
    if (projectId && this.dataPerProject.has(projectId) && this.dataPerProject.get(projectId).recetas.size > 0) {
      return projectId;
    }
    for (const [pid, data] of this.dataPerProject) {
      if (data.recetas.size > 0) return pid;
    }
    return projectId;
  }

  getData(projectId) {
    if (!this.dataPerProject.has(projectId)) {
      this.dataPerProject.set(projectId, {
        recetas: new Map(),
        ingredientes: new Map()
      });
    }
    return this.dataPerProject.get(projectId);
  }

  storageDirFor(projectId) {
    const paths = this.projectPaths.get(projectId);
    return paths ? path.join(paths.storagePath, 'recetas') : null;
  }

  // ==========================================
  // Persistence
  // ==========================================

  async saveRecetasToDisk(projectId) {
    const dir = this.storageDirFor(projectId);
    if (!dir) return;
    try {
      await fs.mkdir(dir, { recursive: true });
      const data = this.getData(projectId);
      const recetas = Array.from(data.recetas.values());
      await fs.writeFile(path.join(dir, 'recetas.json'), JSON.stringify(recetas, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn('recetas.save_failed', { project_id: projectId, error: err.message });
    }
  }

  async saveIngredientesToDisk(projectId) {
    const dir = this.storageDirFor(projectId);
    if (!dir) return;
    try {
      await fs.mkdir(dir, { recursive: true });
      const data = this.getData(projectId);
      const ingredientes = Array.from(data.ingredientes.values());
      await fs.writeFile(path.join(dir, 'ingredientes.json'), JSON.stringify(ingredientes, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn('recetas.ingredientes.save_failed', { project_id: projectId, error: err.message });
    }
  }

  async loadFromDisk(projectId) {
    const dir = this.storageDirFor(projectId);
    if (!dir) return;
    try {
      await fs.mkdir(dir, { recursive: true });
      const data = this.getData(projectId);

      // Load recetas
      try {
        const content = await fs.readFile(path.join(dir, 'recetas.json'), 'utf-8');
        const recetas = JSON.parse(content);
        for (const receta of recetas) {
          if (receta.id) data.recetas.set(receta.id, receta);
        }
      } catch (e) { /* file doesn't exist yet */ }

      // Load ingredientes
      try {
        const content = await fs.readFile(path.join(dir, 'ingredientes.json'), 'utf-8');
        const ingredientes = JSON.parse(content);
        for (const ing of ingredientes) {
          if (ing.id) data.ingredientes.set(ing.id, ing);
        }
      } catch (e) { /* file doesn't exist yet */ }

      this.logger.info('recetas.loaded', {
        project_id: projectId,
        recetas: data.recetas.size,
        ingredientes: data.ingredientes.size
      });
    } catch (err) {
      this.logger.warn('recetas.load_failed', { project_id: projectId, error: err.message });
    }
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  async onProjectActivated(event) {
    const data = event.data || event;
    const { project_id, base_path, metadata } = data;

    const resolvedBase = (metadata?.is_system === true) ? process.cwd() : base_path;
    if (resolvedBase) {
      this.projectPaths.set(project_id, {
        storagePath: path.join(resolvedBase, 'storage')
      });
    }

    this.logger.info('recetas.project.activated', { project_id });
    await this.loadFromDisk(project_id);
  }

  async onProjectDeactivated(event) {
    // Keep data in memory for multi-tenant
  }

  async onFacturaProcesada(event) {
    // Futuro: cuando llega una factura procesada, actualizar precios de compra
    // de los ingredientes que coincidan con las líneas de la factura
    const data = event.data || event;
    this.logger.info('recetas.factura.received', {
      factura_id: data?.factura_id,
      message: 'Preparado para enlazar precios de compra (futuro)'
    });
  }

  // ==========================================
  // Helpers
  // ==========================================

  slugify(text) {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 40);
  }

  calcularCostes(receta) {
    const coste_total = receta.ingredientes.reduce((sum, ing) => {
      return sum + (ing.precio_mercado || 0);
    }, 0);
    const coste_porcion = receta.porciones > 0 ? coste_total / receta.porciones : 0;
    return {
      coste_total: Math.round(coste_total * 100) / 100,
      coste_porcion: Math.round(coste_porcion * 100) / 100
    };
  }

  actualizarCatalogoIngredientes(receta, projectId) {
    const data = this.getData(projectId);
    for (const ing of receta.ingredientes) {
      const ingId = ing.ingrediente_id || `ing_${this.slugify(ing.nombre)}`;
      ing.ingrediente_id = ingId;

      const existing = data.ingredientes.get(ingId);
      if (!existing) {
        data.ingredientes.set(ingId, {
          id: ingId,
          nombre: ing.nombre,
          categoria: this.inferCategoria(ing.nombre),
          unidad_base: this.inferUnidadBase(ing.unidad),
          precio_mercado_kg: this.inferPrecioKg(ing),
          precio_compra_kg: null,
          fuente_precio: 'Estimación de mercado',
          alergenos: [],
          proveedor: null,
          notas: '',
          recetas_count: 1,
          updated_at: new Date().toISOString()
        });
      } else {
        // Update recetas_count
        existing.recetas_count = this.countIngredienteUsage(ingId, projectId);
        existing.updated_at = new Date().toISOString();
      }
    }
  }

  countIngredienteUsage(ingredienteId, projectId) {
    const data = this.getData(projectId);
    let count = 0;
    for (const receta of data.recetas.values()) {
      if (receta.ingredientes.some(i => i.ingrediente_id === ingredienteId)) count++;
    }
    return count;
  }

  inferCategoria(nombre) {
    const n = nombre.toLowerCase();
    const map = {
      'Carnes': ['pollo', 'ternera', 'cerdo', 'cordero', 'pato', 'conejo', 'carne', 'bacon', 'panceta', 'guanciale', 'jamón', 'chorizo', 'salchich'],
      'Pescados': ['pescado', 'salmón', 'atún', 'merluza', 'bacalao', 'gambas', 'langostino', 'marisco', 'camarón', 'pulpo', 'calamar', 'mejillón'],
      'Verduras': ['tomate', 'cebolla', 'ajo', 'pimiento', 'lechuga', 'espinaca', 'zanahoria', 'patata', 'calabacín', 'berenjena', 'champiñón', 'seta', 'pepino', 'judía'],
      'Frutas': ['manzana', 'naranja', 'limón', 'fresa', 'plátano', 'fruta'],
      'Lácteos': ['leche', 'nata', 'queso', 'mozzarella', 'parmesano', 'pecorino', 'mascarpone', 'yogur', 'mantequilla', 'crema'],
      'Huevos': ['huevo'],
      'Cereales': ['harina', 'pan', 'pasta', 'arroz', 'spaghetti', 'macarrón', 'tallarín', 'rigatoni', 'penne', 'fideo', 'cuscús'],
      'Aceites': ['aceite', 'oliva', 'girasol', 'vinagre'],
      'Especias': ['sal', 'pimienta', 'orégano', 'albahaca', 'tomillo', 'romero', 'pimentón', 'comino', 'canela', 'nuez moscada', 'perejil', 'cilantro', 'curry', 'azafrán'],
      'Salsas': ['salsa', 'ketchup', 'mayonesa', 'mostaza', 'soja'],
      'Endulzantes': ['azúcar', 'miel', 'chocolate', 'cacao'],
      'Legumbres': ['lenteja', 'garbanzo', 'alubia', 'judión'],
      'Frutos secos': ['almendra', 'nuez', 'pistacho', 'avellana', 'cacahuete', 'piñón']
    };
    for (const [cat, keywords] of Object.entries(map)) {
      if (keywords.some(k => n.includes(k))) return cat;
    }
    return 'Otros';
  }

  inferUnidadBase(unidad) {
    const u = (unidad || '').toLowerCase();
    if (['g', 'kg', 'gramos'].includes(u)) return 'kg';
    if (['ml', 'l', 'litro', 'litros'].includes(u)) return 'l';
    if (['ud', 'unidad', 'unidades', 'pieza'].includes(u)) return 'ud';
    if (['cucharada', 'cucharadita', 'pizca'].includes(u)) return 'kg'; // small measures normalize to kg
    return 'kg';
  }

  inferPrecioKg(ingrediente) {
    // Estimate price per kg/l/ud from the recipe quantity and price
    const cantidad = ingrediente.cantidad || 0;
    const unidad = (ingrediente.unidad || '').toLowerCase();
    const precio = ingrediente.precio_mercado || 0;

    if (cantidad <= 0 || precio <= 0) return 0;

    let cantidadKg = cantidad;
    if (['g', 'gramos', 'ml'].includes(unidad)) cantidadKg = cantidad / 1000;
    else if (['kg', 'l', 'litro'].includes(unidad)) cantidadKg = cantidad;
    else if (['ud', 'unidad', 'unidades', 'pieza'].includes(unidad)) return precio / cantidad;
    else if (['cucharada'].includes(unidad)) cantidadKg = cantidad * 0.015 / 1; // ~15g per tbsp
    else if (['cucharadita'].includes(unidad)) cantidadKg = cantidad * 0.005 / 1;
    else if (['pizca'].includes(unidad)) cantidadKg = cantidad * 0.001;

    if (cantidadKg <= 0) return 0;
    return Math.round((precio / cantidadKg) * 100) / 100;
  }

  // ==========================================
  // UI Handlers (frontend panels)
  // ==========================================

  async handleList(data) {
    const project_id = this.resolveToActiveProject(data?.project_id);
    const result = await this.toolListar({ project_id, categoria: data?.categoria });
    if (result.error) throw { status: result.status || 400, code: 'LIST_ERROR', message: result.error };
    return result.data;
  }

  async handleGet(data) {
    const project_id = this.resolveToActiveProject(data?.project_id);
    const result = await this.toolObtener({ receta_id: data.id || data.receta_id, project_id });
    if (result.error) throw { status: result.status || 404, code: 'NOT_FOUND', message: result.error };
    return result.data;
  }

  async handleCreate(data) {
    const project_id = this.resolveToActiveProject(data?.project_id);
    const result = await this.toolCrear({ ...data, project_id });
    if (result.error) throw { status: result.status || 400, code: 'CREATE_ERROR', message: result.error };
    return result.data;
  }

  async handleUpdate(data) {
    const project_id = this.resolveToActiveProject(data?.project_id);
    const result = await this.toolActualizar({ ...data, project_id });
    if (result.error) throw { status: result.status || 400, code: 'UPDATE_ERROR', message: result.error };
    return result.data;
  }

  async handleDelete(data) {
    const project_id = this.resolveToActiveProject(data?.project_id);
    const result = await this.toolEliminar({ ...data, project_id });
    if (result.error) throw { status: result.status || 400, code: 'DELETE_ERROR', message: result.error };
    return result.data;
  }

  async handleIngredientes(data) {
    const project_id = this.resolveToActiveProject(data?.project_id);
    const result = await this.toolIngredientes({ project_id, categoria: data?.categoria });
    return result.data;
  }

  async handleStats(data) {
    const project_id = this.resolveToActiveProject(data?.project_id);
    const result = await this.toolResumen({ project_id });
    return result.data;
  }

  // ==========================================
  // Tools — expuestos al LLM via agentic loop
  // ==========================================

  async toolCrear({ nombre, descripcion, categoria, porciones, tiempo_preparacion, dificultad, ingredientes, elaboracion, tags, fuente, notas, project_id }) {
    if (!nombre) return { status: 400, error: 'Se requiere "nombre"' };
    if (!ingredientes || ingredientes.length === 0) return { status: 400, error: 'Se requiere al menos un ingrediente' };
    if (!porciones || porciones < 1) return { status: 400, error: 'Se requiere "porciones" (mínimo 1)' };
    if (!project_id) return { status: 400, error: 'Se requiere "project_id"' };

    const id = `rec_${this.slugify(nombre)}_${Date.now().toString(36)}`;
    const now = new Date().toISOString();

    // Assign ingredient IDs
    const processedIngredients = ingredientes.map(ing => ({
      ingrediente_id: `ing_${this.slugify(ing.nombre)}`,
      nombre: ing.nombre,
      cantidad: ing.cantidad,
      unidad: ing.unidad,
      precio_mercado: ing.precio_mercado,
      precio_compra: null,
      notas: ing.notas || ''
    }));

    const receta = {
      id,
      nombre,
      descripcion: descripcion || '',
      categoria: categoria || 'General',
      tags: tags || [],
      porciones,
      tiempo_preparacion: tiempo_preparacion || null,
      dificultad: dificultad || 'media',
      ingredientes: processedIngredients,
      elaboracion: elaboracion || [],
      notas: notas || '',
      fuente: fuente || '',
      proyecto_id: project_id,
      created_at: now,
      updated_at: now
    };

    // Calculate costs
    const costes = this.calcularCostes(receta);
    receta.coste_total = costes.coste_total;
    receta.coste_porcion = costes.coste_porcion;

    // Store
    const data = this.getData(project_id);
    data.recetas.set(id, receta);

    // Update ingredient catalog
    this.actualizarCatalogoIngredientes(receta, project_id);

    // Persist
    await this.saveRecetasToDisk(project_id);
    await this.saveIngredientesToDisk(project_id);

    // Publish event
    await this.eventBus.publish('receta.creada', receta);
    this.metrics?.increment('recetas.created');
    this.logger.info('receta.creada', { id, nombre, project_id, coste_total: receta.coste_total });

    return {
      status: 201,
      data: {
        receta_id: id,
        nombre,
        coste_total: receta.coste_total,
        coste_porcion: receta.coste_porcion,
        porciones,
        ingredientes_count: processedIngredients.length,
        message: `Receta "${nombre}" creada. Coste total: ${receta.coste_total}€, coste/porción: ${receta.coste_porcion}€`
      }
    };
  }

  async toolListar({ project_id, categoria }) {
    if (!project_id) return { status: 400, error: 'Se requiere "project_id"' };

    const data = this.getData(project_id);
    let recetas = Array.from(data.recetas.values());

    if (categoria) {
      recetas = recetas.filter(r => r.categoria.toLowerCase() === categoria.toLowerCase());
    }

    const resumen = recetas.map(r => ({
      id: r.id,
      nombre: r.nombre,
      categoria: r.categoria,
      porciones: r.porciones,
      ingredientes_count: r.ingredientes.length,
      coste_total: r.coste_total,
      coste_porcion: r.coste_porcion,
      created_at: r.created_at
    }));

    return {
      status: 200,
      data: {
        recetas: resumen,
        total: resumen.length,
        categorias: [...new Set(recetas.map(r => r.categoria))]
      }
    };
  }

  async toolObtener({ receta_id, project_id }) {
    if (!receta_id) return { status: 400, error: 'Se requiere "receta_id"' };

    // Search across projects if project_id not specified
    const projects = project_id ? [project_id] : Array.from(this.dataPerProject.keys());
    for (const pid of projects) {
      const data = this.getData(pid);
      const receta = data.recetas.get(receta_id);
      if (receta) return { status: 200, data: receta };
    }
    return { status: 404, error: `Receta "${receta_id}" no encontrada` };
  }

  async toolActualizar({ receta_id, project_id, ...updates }) {
    if (!receta_id) return { status: 400, error: 'Se requiere "receta_id"' };

    // Find the receta
    const projects = project_id ? [project_id] : Array.from(this.dataPerProject.keys());
    let found = null;
    let foundProject = null;

    for (const pid of projects) {
      const data = this.getData(pid);
      if (data.recetas.has(receta_id)) {
        found = data.recetas.get(receta_id);
        foundProject = pid;
        break;
      }
    }

    if (!found) return { status: 404, error: `Receta "${receta_id}" no encontrada` };

    // Apply updates
    const updatable = ['nombre', 'descripcion', 'categoria', 'porciones', 'tiempo_preparacion', 'dificultad', 'ingredientes', 'elaboracion', 'tags', 'fuente', 'notas'];
    for (const key of updatable) {
      if (updates[key] !== undefined) {
        if (key === 'ingredientes') {
          found.ingredientes = updates.ingredientes.map(ing => ({
            ingrediente_id: ing.ingrediente_id || `ing_${this.slugify(ing.nombre)}`,
            nombre: ing.nombre,
            cantidad: ing.cantidad,
            unidad: ing.unidad,
            precio_mercado: ing.precio_mercado,
            precio_compra: ing.precio_compra || null,
            notas: ing.notas || ''
          }));
        } else {
          found[key] = updates[key];
        }
      }
    }
    found.updated_at = new Date().toISOString();

    // Recalculate costs
    const costes = this.calcularCostes(found);
    found.coste_total = costes.coste_total;
    found.coste_porcion = costes.coste_porcion;

    // Update catalog
    this.actualizarCatalogoIngredientes(found, foundProject);

    // Persist
    await this.saveRecetasToDisk(foundProject);
    await this.saveIngredientesToDisk(foundProject);

    // Publish
    await this.eventBus.publish('receta.actualizada', found);
    this.metrics?.increment('recetas.updated');

    return {
      status: 200,
      data: {
        receta_id,
        nombre: found.nombre,
        coste_total: found.coste_total,
        coste_porcion: found.coste_porcion,
        message: `Receta "${found.nombre}" actualizada. Coste: ${found.coste_total}€ (${found.coste_porcion}€/porción)`
      }
    };
  }

  async toolEliminar({ receta_id, project_id }) {
    if (!receta_id) return { status: 400, error: 'Se requiere "receta_id"' };

    const projects = project_id ? [project_id] : Array.from(this.dataPerProject.keys());
    for (const pid of projects) {
      const data = this.getData(pid);
      const receta = data.recetas.get(receta_id);
      if (receta) {
        data.recetas.delete(receta_id);
        await this.saveRecetasToDisk(pid);

        // Update ingredient counts
        for (const ing of receta.ingredientes) {
          const catIng = data.ingredientes.get(ing.ingrediente_id);
          if (catIng) {
            catIng.recetas_count = this.countIngredienteUsage(ing.ingrediente_id, pid);
          }
        }
        await this.saveIngredientesToDisk(pid);

        await this.eventBus.publish('receta.eliminada', { receta_id, nombre: receta.nombre });
        this.metrics?.increment('recetas.deleted');

        return {
          status: 200,
          data: { receta_id, nombre: receta.nombre, message: `Receta "${receta.nombre}" eliminada` }
        };
      }
    }
    return { status: 404, error: `Receta "${receta_id}" no encontrada` };
  }

  async toolBuscar({ query, project_id }) {
    if (!query) return { status: 400, error: 'Se requiere "query"' };

    const q = query.toLowerCase();
    const results = [];

    const projects = project_id ? [project_id] : Array.from(this.dataPerProject.keys());
    for (const pid of projects) {
      const data = this.getData(pid);
      for (const receta of data.recetas.values()) {
        const matches =
          receta.nombre.toLowerCase().includes(q) ||
          receta.categoria.toLowerCase().includes(q) ||
          (receta.tags || []).some(t => t.toLowerCase().includes(q)) ||
          receta.ingredientes.some(i => i.nombre.toLowerCase().includes(q));

        if (matches) {
          results.push({
            id: receta.id,
            nombre: receta.nombre,
            categoria: receta.categoria,
            coste_porcion: receta.coste_porcion,
            porciones: receta.porciones,
            match: receta.nombre.toLowerCase().includes(q) ? 'nombre' :
              receta.ingredientes.some(i => i.nombre.toLowerCase().includes(q)) ? 'ingrediente' : 'otro'
          });
        }
      }
    }

    return {
      status: 200,
      data: { resultados: results, total: results.length, query }
    };
  }

  async toolInvestigar({ nombre, porciones, estilo, project_id }) {
    if (!nombre) return { status: 400, error: 'Se requiere "nombre" de la receta a investigar' };

    this.metrics?.increment('recetas.investigated');

    // This tool returns a structured prompt-response for the AI to use
    // The AI itself will research the recipe using its knowledge and present it to the user
    const porcionesTarget = porciones || 4;
    const estiloText = estilo ? ` estilo ${estilo}` : '';

    return {
      status: 200,
      data: {
        instruccion: `Investiga la receta "${nombre}"${estiloText} para ${porcionesTarget} porciones. Proporciona:
1. Descripción breve
2. Lista completa de ingredientes con cantidades EXACTAS en gramos/ml/unidades
3. Precio de mercado ESTIMADO de cada ingrediente (España, precio de supermercado). ESTIMA POR ALTO.
4. Pasos de elaboración
5. Tiempo de preparación y dificultad
6. Coste total y coste por porción

IMPORTANTE: Los precios deben ser estimaciones ALTAS de mercado español (supermercado).
Es preferible pasarse por arriba que quedarse corto.

Cuando tengas toda la información, usa la herramienta recetas.crear para guardarla (si el usuario lo confirma).`,
        nombre,
        porciones: porcionesTarget,
        estilo: estilo || null,
        message: `Investigando receta: "${nombre}"${estiloText} para ${porcionesTarget} porciones. Te presento la propuesta y si te gusta la guardamos.`
      }
    };
  }

  async toolIngredientes({ project_id, categoria }) {
    if (!project_id) return { status: 400, error: 'Se requiere "project_id"' };

    const data = this.getData(project_id);
    let ingredientes = Array.from(data.ingredientes.values());

    if (categoria) {
      ingredientes = ingredientes.filter(i => i.categoria.toLowerCase() === categoria.toLowerCase());
    }

    // Sort by recetas_count descending
    ingredientes.sort((a, b) => (b.recetas_count || 0) - (a.recetas_count || 0));

    return {
      status: 200,
      data: {
        ingredientes,
        total: ingredientes.length,
        categorias: [...new Set(ingredientes.map(i => i.categoria))]
      }
    };
  }

  async toolPrecioMercado({ ingrediente_id, nombre, precio_mercado_kg, unidad_base, fuente_precio, project_id }) {
    if (!project_id) return { status: 400, error: 'Se requiere "project_id"' };

    const data = this.getData(project_id);
    let ingrediente = null;

    if (ingrediente_id) {
      ingrediente = data.ingredientes.get(ingrediente_id);
    } else if (nombre) {
      const id = `ing_${this.slugify(nombre)}`;
      ingrediente = data.ingredientes.get(id);
    }

    if (!ingrediente) {
      return { status: 404, error: `Ingrediente no encontrado. Usa recetas.ingredientes para ver el catálogo.` };
    }

    if (precio_mercado_kg !== undefined) ingrediente.precio_mercado_kg = precio_mercado_kg;
    if (unidad_base) ingrediente.unidad_base = unidad_base;
    if (fuente_precio) ingrediente.fuente_precio = fuente_precio;
    ingrediente.updated_at = new Date().toISOString();

    await this.saveIngredientesToDisk(project_id);
    await this.eventBus.publish('ingrediente.precio.actualizado', ingrediente);

    return {
      status: 200,
      data: {
        ingrediente_id: ingrediente.id,
        nombre: ingrediente.nombre,
        precio_mercado_kg: ingrediente.precio_mercado_kg,
        fuente_precio: ingrediente.fuente_precio,
        message: `Precio de "${ingrediente.nombre}" actualizado a ${ingrediente.precio_mercado_kg}€/${ingrediente.unidad_base}`
      }
    };
  }

  async toolDuplicar({ receta_id, nuevo_nombre, project_id }) {
    if (!receta_id) return { status: 400, error: 'Se requiere "receta_id"' };
    if (!nuevo_nombre) return { status: 400, error: 'Se requiere "nuevo_nombre"' };

    const projects = project_id ? [project_id] : Array.from(this.dataPerProject.keys());
    for (const pid of projects) {
      const data = this.getData(pid);
      const original = data.recetas.get(receta_id);
      if (original) {
        const newId = `rec_${this.slugify(nuevo_nombre)}_${Date.now().toString(36)}`;
        const now = new Date().toISOString();

        const copia = JSON.parse(JSON.stringify(original));
        copia.id = newId;
        copia.nombre = nuevo_nombre;
        copia.created_at = now;
        copia.updated_at = now;
        copia.fuente = `Duplicada de "${original.nombre}" (${original.id})`;

        data.recetas.set(newId, copia);
        await this.saveRecetasToDisk(pid);

        await this.eventBus.publish('receta.creada', copia);
        this.metrics?.increment('recetas.created');

        return {
          status: 201,
          data: {
            receta_id: newId,
            nombre: nuevo_nombre,
            original_id: receta_id,
            message: `Receta duplicada: "${nuevo_nombre}" (basada en "${original.nombre}")`
          }
        };
      }
    }
    return { status: 404, error: `Receta "${receta_id}" no encontrada` };
  }

  async toolEscandallo({ receta_id, precio_venta, usar_precio_compra, project_id }) {
    if (!receta_id) return { status: 400, error: 'Se requiere "receta_id"' };

    const projects = project_id ? [project_id] : Array.from(this.dataPerProject.keys());
    for (const pid of projects) {
      const data = this.getData(pid);
      const receta = data.recetas.get(receta_id);
      if (receta) {
        const desglose = receta.ingredientes.map(ing => {
          const precio = (usar_precio_compra && ing.precio_compra !== null)
            ? ing.precio_compra
            : ing.precio_mercado;
          return {
            nombre: ing.nombre,
            cantidad: ing.cantidad,
            unidad: ing.unidad,
            precio,
            tipo_precio: (usar_precio_compra && ing.precio_compra !== null) ? 'compra' : 'mercado'
          };
        });

        const coste_total = desglose.reduce((sum, d) => sum + (d.precio || 0), 0);
        const coste_porcion = receta.porciones > 0 ? coste_total / receta.porciones : 0;

        // Percentage per ingredient
        const desglose_porcentaje = desglose.map(d => ({
          ...d,
          porcentaje: coste_total > 0 ? Math.round((d.precio / coste_total) * 10000) / 100 : 0
        }));

        // Sort by cost descending
        desglose_porcentaje.sort((a, b) => (b.precio || 0) - (a.precio || 0));

        const result = {
          receta_id,
          nombre: receta.nombre,
          porciones: receta.porciones,
          coste_total: Math.round(coste_total * 100) / 100,
          coste_porcion: Math.round(coste_porcion * 100) / 100,
          desglose: desglose_porcentaje
        };

        if (precio_venta) {
          const margen = precio_venta - coste_porcion;
          const margen_porcentaje = precio_venta > 0 ? (margen / precio_venta) * 100 : 0;
          result.precio_venta = precio_venta;
          result.margen = Math.round(margen * 100) / 100;
          result.margen_porcentaje = Math.round(margen_porcentaje * 100) / 100;
          result.food_cost_porcentaje = Math.round((coste_porcion / precio_venta) * 10000) / 100;
          result.multiplicador = Math.round((precio_venta / coste_porcion) * 100) / 100;
        }

        this.metrics?.increment('recetas.escandallo.calculated');

        return { status: 200, data: result };
      }
    }
    return { status: 404, error: `Receta "${receta_id}" no encontrada` };
  }

  async toolResumen({ project_id }) {
    if (!project_id) return { status: 400, error: 'Se requiere "project_id"' };

    const data = this.getData(project_id);
    const recetas = Array.from(data.recetas.values());

    if (recetas.length === 0) {
      return {
        status: 200,
        data: {
          total_recetas: 0,
          total_ingredientes: data.ingredientes.size,
          message: 'No hay recetas todavía. Usa recetas.crear o recetas.investigar para empezar.'
        }
      };
    }

    const costes = recetas.map(r => r.coste_porcion || 0);
    const totalCostes = recetas.map(r => r.coste_total || 0);

    // Most used ingredients
    const ingredienteCount = {};
    for (const r of recetas) {
      for (const ing of r.ingredientes) {
        ingredienteCount[ing.nombre] = (ingredienteCount[ing.nombre] || 0) + 1;
      }
    }
    const topIngredientes = Object.entries(ingredienteCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([nombre, count]) => ({ nombre, recetas: count }));

    // By category
    const porCategoria = {};
    for (const r of recetas) {
      if (!porCategoria[r.categoria]) {
        porCategoria[r.categoria] = { count: 0, coste_medio: 0, total: 0 };
      }
      porCategoria[r.categoria].count++;
      porCategoria[r.categoria].total += r.coste_porcion || 0;
    }
    for (const cat of Object.values(porCategoria)) {
      cat.coste_medio = Math.round((cat.total / cat.count) * 100) / 100;
      delete cat.total;
    }

    const recetaMasCara = recetas.reduce((max, r) => (r.coste_porcion || 0) > (max.coste_porcion || 0) ? r : max);
    const recetaMasBarata = recetas.reduce((min, r) => (r.coste_porcion || 0) < (min.coste_porcion || 0) ? r : min);

    return {
      status: 200,
      data: {
        total_recetas: recetas.length,
        total_ingredientes: data.ingredientes.size,
        coste_porcion: {
          medio: Math.round((costes.reduce((a, b) => a + b, 0) / costes.length) * 100) / 100,
          minimo: Math.round(Math.min(...costes) * 100) / 100,
          maximo: Math.round(Math.max(...costes) * 100) / 100
        },
        coste_total: {
          medio: Math.round((totalCostes.reduce((a, b) => a + b, 0) / totalCostes.length) * 100) / 100,
          total_global: Math.round(totalCostes.reduce((a, b) => a + b, 0) * 100) / 100
        },
        receta_mas_cara: { nombre: recetaMasCara.nombre, coste_porcion: recetaMasCara.coste_porcion },
        receta_mas_barata: { nombre: recetaMasBarata.nombre, coste_porcion: recetaMasBarata.coste_porcion },
        por_categoria: porCategoria,
        top_ingredientes: topIngredientes,
        categorias: [...new Set(recetas.map(r => r.categoria))]
      }
    };
  }
}

module.exports = RecetasModule;
