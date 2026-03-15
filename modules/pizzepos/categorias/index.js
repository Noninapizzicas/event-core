/**
 * Módulo Categorias v2.1
 * Catálogo de categorías - Multi-tenant por proyecto
 * Alineado con patrones event-core: uiHandler, event envelope, cleanup
 *
 * Emite: categoria.creada, categoria.actualizada, categoria.orden_actualizado
 * Consume: menu.generado
 */

class CategoriasModule {
  constructor() {
    this.name = 'categorias';
    this.version = '2.1.0';

    // Dependencias (inyectadas en onLoad)
    this.eventBus = null;
    this.logger = null;
    this.metrics = null;
    this.uiHandler = null;

    // Estado en memoria - por proyecto
    this.categoriasPerProject = new Map(); // project_id -> Map<categoria_id, categoria>
  }

  // Helpers para obtener/crear maps por proyecto
  getCategorias(projectId) {
    if (!this.categoriasPerProject.has(projectId)) {
      this.categoriasPerProject.set(projectId, new Map());
    }
    return this.categoriasPerProject.get(projectId);
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(core) {
    this.logger = core.logger;
    this.metrics = core.metrics;
    this.eventBus = core.eventBus;
    this.uiHandler = core.uiHandler;

    this.logger.info('module.loading', { module: this.name, version: this.version });

    // Event subscriptions are auto-wired from module.json by the loader.
    // Do NOT subscribe manually here to avoid duplicate handlers.
    this.registerUIHandlers();

    this.logger.info('module.loaded', { module: this.name, version: this.version });
  }

  async onUnload() {
    this.logger.info('module.unloading', { module: this.name });

    if (this.uiHandler) {
      const actions = ['list', 'get', 'create', 'update', 'reorder', 'health', 'metrics'];
      for (const action of actions) {
        this.uiHandler.unregister('categorias', action);
      }
    }

    this.categoriasPerProject.clear();

    this.logger.info('module.unloaded', { module: this.name });
  }

  // ==========================================
  // UI Handler Registration
  // ==========================================

  registerUIHandlers() {
    if (!this.uiHandler) {
      this.logger.warn('categorias.uiHandler.not_available', { module: this.name });
      return;
    }

    this.uiHandler.register('categorias', 'list', this.handleListCategorias.bind(this));
    this.uiHandler.register('categorias', 'get', this.handleGetCategoria.bind(this));
    this.uiHandler.register('categorias', 'create', this.handleCreateCategoria.bind(this));
    this.uiHandler.register('categorias', 'update', this.handleUpdateCategoria.bind(this));
    this.uiHandler.register('categorias', 'reorder', this.handleReorderCategorias.bind(this));
    this.uiHandler.register('categorias', 'health', this.handleHealthCheck.bind(this));
    this.uiHandler.register('categorias', 'metrics', this.handleGetMetrics.bind(this));

    this.logger.info('categorias.ui_handlers.registered', {
      handlers: ['list', 'get', 'create', 'update', 'reorder', 'health', 'metrics']
    });
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  async onMenuGenerado(event) {
    const eventData = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;
    const { project_id, categorias } = eventData;

    if (!categorias || categorias.length === 0) {
      return;
    }

    if (!project_id) {
      this.logger.warn('categorias.menu_generado.no_project_id', {
        categorias_count: categorias.length,
        correlation_id: correlationId
      });
      return;
    }

    this.logger.info('menu.generado.received', {
      project_id,
      categorias_count: categorias.length,
      correlation_id: correlationId
    });

    const categoriasMap = this.getCategorias(project_id);
    let nuevas = 0;
    let actualizadas = 0;

    for (const cat of categorias) {
      const existente = categoriasMap.get(cat.id);

      if (!existente) {
        const categoria = {
          id: cat.id,
          nombre: cat.nombre,
          emoji: cat.emoji || '📋',
          orden: cat.orden !== undefined ? cat.orden : categoriasMap.size,
          activa: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        categoriasMap.set(cat.id, categoria);
        nuevas++;

        this.metrics?.increment('categoria.creada.total');
        await this.publishCategoriaCreada(categoria, correlationId);

      } else {
        const cambios = {};
        if (cat.emoji && cat.emoji !== existente.emoji) {
          cambios.emoji = { anterior: existente.emoji, nuevo: cat.emoji };
          existente.emoji = cat.emoji;
        }
        if (cat.nombre && cat.nombre !== existente.nombre) {
          cambios.nombre = { anterior: existente.nombre, nuevo: cat.nombre };
          existente.nombre = cat.nombre;
        }

        if (Object.keys(cambios).length > 0) {
          existente.updated_at = new Date().toISOString();
          categoriasMap.set(cat.id, existente);
          actualizadas++;

          await this.publishCategoriaActualizada(cat.id, cambios, correlationId);
        }
      }
    }

    this.metrics?.gauge('categoria.total.count', categoriasMap.size);
    this.metrics?.gauge('categoria.activas.count',
      Array.from(categoriasMap.values()).filter(c => c.activa).length);

    this.logger.info('categorias.sincronizadas', {
      project_id,
      nuevas,
      actualizadas,
      total: categoriasMap.size,
      correlation_id: correlationId
    });
  }

  // ==========================================
  // UI Handlers (MQTT Request/Response)
  // ==========================================

  async handleListCategorias(data) {
    const { project_id } = data || {};

    if (!project_id) {
      return { status: 400, error: 'project_id es requerido' };
    }

    const categorias = Array.from(this.getCategorias(project_id).values())
      .filter(c => c.activa)
      .sort((a, b) => a.orden - b.orden);

    return {
      status: 200,
      data: { project_id, categorias, total: categorias.length }
    };
  }

  async handleGetCategoria(data) {
    const { project_id, id } = data || {};

    if (!project_id) {
      return { status: 400, error: 'project_id es requerido' };
    }

    const categoria = this.getCategorias(project_id).get(id);

    if (!categoria) {
      return { status: 404, error: 'Categoría no encontrada' };
    }

    return { status: 200, data: categoria };
  }

  async handleCreateCategoria(data) {
    const { project_id, nombre, emoji, descripcion, color } = data || {};

    if (!project_id) {
      return { status: 400, error: 'project_id es requerido' };
    }

    if (!nombre) {
      return { status: 400, error: 'nombre requerido' };
    }

    const categoriasMap = this.getCategorias(project_id);
    const categoria_id = `cat_${this.slugify(nombre)}`;

    if (categoriasMap.has(categoria_id)) {
      return { status: 409, error: 'Categoría ya existe' };
    }

    const categoria = {
      id: categoria_id,
      nombre,
      emoji: emoji || '📋',
      orden: categoriasMap.size,
      activa: true,
      descripcion,
      color,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    categoriasMap.set(categoria_id, categoria);

    this.metrics?.increment('categoria.creada.total');
    await this.publishCategoriaCreada(categoria);

    this.logger.info('categoria.creada', {
      project_id,
      categoria_id,
      nombre
    });

    return { status: 201, data: categoria };
  }

  async handleUpdateCategoria(data) {
    const { project_id, id, ...updates } = data || {};

    if (!project_id) {
      return { status: 400, error: 'project_id es requerido' };
    }

    const categoriasMap = this.getCategorias(project_id);
    const categoria = categoriasMap.get(id);
    if (!categoria) {
      return { status: 404, error: 'Categoría no encontrada' };
    }

    const cambios = {};
    Object.keys(updates).forEach(key => {
      if (updates[key] !== categoria[key]) {
        cambios[key] = { anterior: categoria[key], nuevo: updates[key] };
        categoria[key] = updates[key];
      }
    });

    categoria.updated_at = new Date().toISOString();
    categoriasMap.set(id, categoria);

    this.metrics?.increment('categoria.actualizada.total');
    await this.publishCategoriaActualizada(id, cambios);

    this.logger.info('categoria.actualizada', {
      project_id,
      categoria_id: id,
      cambios_count: Object.keys(cambios).length
    });

    return { status: 200, data: categoria };
  }

  async handleReorderCategorias(data) {
    const { project_id, orden } = data || {};

    if (!project_id) {
      return { status: 400, error: 'project_id es requerido' };
    }

    if (!orden || !Array.isArray(orden)) {
      return { status: 400, error: 'orden array requerido' };
    }

    const categoriasMap = this.getCategorias(project_id);
    const nuevo_orden = [];

    orden.forEach((item, idx) => {
      const categoria = categoriasMap.get(item.categoria_id);
      if (categoria) {
        categoria.orden = idx;
        categoria.updated_at = new Date().toISOString();
        categoriasMap.set(item.categoria_id, categoria);

        nuevo_orden.push({
          categoria_id: item.categoria_id,
          orden: idx
        });
      }
    });

    await this.publishOrdenActualizado(nuevo_orden);

    this.logger.info('categorias.reordenadas', {
      project_id,
      count: nuevo_orden.length
    });

    return {
      status: 200,
      data: { message: 'Orden actualizado', nuevo_orden }
    };
  }

  async handleHealthCheck() {
    let totalCategorias = 0;
    let totalActivas = 0;

    for (const [, categorias] of this.categoriasPerProject) {
      totalCategorias += categorias.size;
      totalActivas += Array.from(categorias.values()).filter(c => c.activa).length;
    }

    return {
      status: 200,
      data: {
        status: 'healthy',
        module: this.name,
        version: this.version,
        catalogo: {
          proyectos: this.categoriasPerProject.size,
          total: totalCategorias,
          activas: totalActivas
        }
      }
    };
  }

  async handleGetMetrics() {
    let totalCategorias = 0;
    let totalActivas = 0;

    for (const [, categorias] of this.categoriasPerProject) {
      totalCategorias += categorias.size;
      totalActivas += Array.from(categorias.values()).filter(c => c.activa).length;
    }

    return {
      status: 200,
      data: {
        counters: {
          'categoria.creada.total': this.metrics?.getCounter('categoria.creada.total') || 0,
          'categoria.actualizada.total': this.metrics?.getCounter('categoria.actualizada.total') || 0
        },
        gauges: {
          'categoria.total.count': totalCategorias,
          'categoria.activas.count': totalActivas
        }
      }
    };
  }

  // ==========================================
  // Event Publishers
  // ==========================================

  async publishCategoriaCreada(categoria, correlation_id) {
    await this.eventBus.publish('categoria.creada', {
      categoria_id: categoria.id,
      nombre: categoria.nombre,
      emoji: categoria.emoji,
      orden: categoria.orden,
      created_at: categoria.created_at
    }, {
      correlationId: correlation_id
    });
  }

  async publishCategoriaActualizada(categoria_id, cambios, correlation_id) {
    await this.eventBus.publish('categoria.actualizada', {
      categoria_id,
      cambios,
      updated_at: new Date().toISOString()
    }, {
      correlationId: correlation_id
    });
  }

  async publishOrdenActualizado(nuevo_orden, correlation_id) {
    await this.eventBus.publish('categoria.orden_actualizado', {
      nuevo_orden
    }, {
      correlationId: correlation_id
    });
  }

  // ==========================================
  // Helper Methods
  // ==========================================

  slugify(text) {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }
}

module.exports = CategoriasModule;
