/**
 * Módulo Productos v2.3
 * Catálogo de productos - Actualizado desde menús generados por IA
 * Alineado con patrones event-core: uiHandler, event envelope, cleanup
 * Multi-tenant: cada proyecto tiene su propio catálogo
 * Persiste cambios a disco en cartas JSON
 *
 * Emite: producto.creado, producto.actualizado, producto.eliminado, catalogo.actualizado
 * Consume: carta.generada, menu.generado, menu.validado
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class ProductosModule {
  constructor() {
    this.name = 'productos';
    this.version = '2.3.0';

    // Dependencias (inyectadas en onLoad)
    this.eventBus = null;
    this.logger = null;
    this.metrics = null;
    this.uiHandler = null;
    this.config = {};

    // Estado en memoria - por proyecto
    this.productosPerProject = new Map(); // project_id -> Map<producto_id, producto>
    this.categoriasPerProject = new Map(); // project_id -> Map<categoria_id, categoria>
    this.menusPendientes = new Map(); // menu_id -> { project_id, productos_draft }

    // Rutas de storage por proyecto (project_id -> base_path/storage/pizzepos)
    this.storageSection = 'pizzepos';
    this.projectPaths = new Map();
    this.pendingProjectRequests = new Map();
  }

  // Helpers para obtener/crear maps por proyecto
  getProductos(projectId) {
    if (!this.productosPerProject.has(projectId)) {
      this.productosPerProject.set(projectId, new Map());
    }
    return this.productosPerProject.get(projectId);
  }

  getCategorias(projectId) {
    if (!this.categoriasPerProject.has(projectId)) {
      this.categoriasPerProject.set(projectId, new Map());
    }
    return this.categoriasPerProject.get(projectId);
  }

  /**
   * Resuelve un project_id al proyecto activo con datos.
   * Si el project_id dado tiene productos cargados, lo usa.
   * Si no, busca el primer proyecto que sí tenga datos.
   * Esto permite que el frontend envíe aliases ("a") sin romper nada.
   */
  resolveToActiveProject(projectId) {
    // Si este proyecto ya tiene datos, usarlo
    if (this.productosPerProject.has(projectId) && this.productosPerProject.get(projectId).size > 0) {
      return projectId;
    }
    // Buscar el primer proyecto con productos cargados
    for (const [pid, prods] of this.productosPerProject) {
      if (prods.size > 0) {
        this.logger.debug('productos.resolve_fallback', { requested: projectId, resolved: pid });
        return pid;
      }
    }
    // No hay datos en ningún proyecto, devolver el original
    return projectId;
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(core) {
    this.logger = core.logger;
    this.metrics = core.metrics;
    this.eventBus = core.eventBus;
    this.uiHandler = core.uiHandler;
    this.config = core.config || {};

    this.logger.info('module.loading', { module: this.name, version: this.version });

    // Event subscriptions are auto-wired from module.json by the loader.
    // Do NOT subscribe manually here to avoid duplicate handlers.
    this.registerUIHandlers();

    this.logger.info('module.loaded', { module: this.name, version: this.version });
  }

  async onUnload() {
    this.logger.info('module.unloading', { module: this.name });

    if (this.uiHandler) {
      const actions = [
        'list', 'get', 'search', 'update', 'delete',
        'categorias', 'ingredientes', 'pizzas',
        'stats', 'health', 'metrics', 'load_carta'
      ];
      for (const action of actions) {
        this.uiHandler.unregister('productos', action);
      }
    }

    this.productosPerProject.clear();
    this.categoriasPerProject.clear();
    this.menusPendientes.clear();
    this.projectPaths.clear();
    for (const [, pending] of this.pendingProjectRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Module unloading'));
    }
    this.pendingProjectRequests.clear();

    this.logger.info('module.unloaded', { module: this.name });
  }

  // ==========================================
  // UI Handler Registration
  // ==========================================

  registerUIHandlers() {
    if (!this.uiHandler) {
      this.logger.warn('productos.uiHandler.not_available', { module: this.name });
      return;
    }

    this.uiHandler.register('productos', 'list', this.handleListProductos.bind(this));
    this.uiHandler.register('productos', 'get', this.handleGetProducto.bind(this));
    this.uiHandler.register('productos', 'search', this.handleSearchProductos.bind(this));
    this.uiHandler.register('productos', 'update', this.handleUpdateProducto.bind(this));
    this.uiHandler.register('productos', 'delete', this.handleDeleteProducto.bind(this));
    this.uiHandler.register('productos', 'categorias', this.handleListCategorias.bind(this));
    this.uiHandler.register('productos', 'ingredientes', this.handleListIngredientes.bind(this));
    this.uiHandler.register('productos', 'pizzas', this.handleListPizzas.bind(this));
    this.uiHandler.register('productos', 'stats', this.handleGetStats.bind(this));
    this.uiHandler.register('productos', 'health', this.handleHealthCheck.bind(this));
    this.uiHandler.register('productos', 'metrics', this.handleGetMetrics.bind(this));
    this.uiHandler.register('productos', 'load_carta', this.handleLoadCarta.bind(this));
    this.uiHandler.register('productos', 'carta_completa', this.handleCartaCompleta.bind(this));

    this.logger.info('productos.ui_handlers.registered', {
      handlers: ['list', 'get', 'search', 'update', 'delete', 'categorias', 'ingredientes', 'pizzas', 'stats', 'health', 'metrics', 'load_carta', 'carta_completa']
    });
  }

  // ==========================================
  // Project Path Resolution
  // ==========================================

  async onProjectActivated(event) {
    const data = event.data || event;
    const { project_id, base_path } = data;
    if (project_id && base_path) {
      this.projectPaths.set(project_id, path.join(base_path, 'storage', this.storageSection));

      // Auto-load cartas from disk so productos/categorias are available immediately
      try {
        const result = await this.loadCartaFromProject(project_id);
        this.logger.info('productos.auto_loaded', { project_id, ...result });

        // Emitir catalogo.actualizado para que comandero (y otros) llenen su cache
        if (result.productos > 0) {
          const productos = Array.from(this.getProductos(project_id).values())
            .filter(p => p.activo !== false)
            .map(p => ({ id: p.id, nombre: p.nombre, precio: p.precio, categoria: p.categoria || null }));

          await this.eventBus.publish('catalogo.actualizado', {
            project_id,
            productos,
            source: 'disk_load'
          });
        }
      } catch (err) {
        this.logger.warn('productos.auto_load.failed', { project_id, error: err.message });
      }
    }
  }

  async onProjectGetResponse(event) {
    const { request_id, success, project } = event.data || event;
    const pending = this.pendingProjectRequests.get(request_id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingProjectRequests.delete(request_id);
    if (success && project) {
      if (project.base_path) {
        this.projectPaths.set(project.id, path.join(project.base_path, 'storage', this.storageSection));
      }
      pending.resolve(project);
    } else {
      pending.reject(new Error('Project not found'));
    }
  }

  /**
   * Resolve the storage path for a project.
   * Uses cached path from project.activated, or requests from project-manager.
   */
  async resolveStoragePath(projectId) {
    if (this.projectPaths.has(projectId)) {
      return this.projectPaths.get(projectId);
    }

    // Request project info from project-manager
    const requestId = crypto.randomUUID();

    const project = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingProjectRequests.delete(requestId);
        reject(new Error(`Project path resolve timeout: ${projectId}`));
      }, 5000);

      this.pendingProjectRequests.set(requestId, { resolve, reject, timeout });

      this.eventBus.publish('project.get.request', {
        request_id: requestId, project_id: projectId
      }).catch(err => {
        clearTimeout(timeout);
        this.pendingProjectRequests.delete(requestId);
        reject(err);
      });
    });

    return this.projectPaths.get(projectId) || path.join(project.base_path, 'storage', this.storageSection);
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  async onMenuGenerado(event) {
    const eventData = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;
    const { menu_id, project_id, productos, categorias, ingredientes_catalogo, source } = eventData;
    const start_time = Date.now();

    // Skip events from disk_load (we already loaded products directly)
    if (source === 'disk_load') {
      this.logger.debug('menu.generado.skipped_disk_load', { project_id, menu_id });
      return;
    }

    this.logger.info('menu.generado.received', {
      menu_id,
      project_id,
      productos_count: productos?.length || 0,
      categorias_count: categorias?.length || 0,
      ingredientes_count: ingredientes_catalogo?.length || 0,
      correlation_id: correlationId
    });

    try {
      this.menusPendientes.set(menu_id, {
        project_id: project_id || null,
        productos: productos || [],
        categorias: categorias || [],
        received_at: new Date().toISOString()
      });

      this.logger.info('menu.productos_guardados', {
        menu_id,
        project_id,
        productos_count: productos?.length || 0,
        estado: 'pendiente_validacion',
        correlation_id: correlationId,
        duration: Date.now() - start_time
      });

    } catch (error) {
      this.logger.error('menu.generado.error', {
        menu_id,
        project_id,
        error: error.message,
        correlation_id: correlationId
      });

      this.metrics?.increment?.('producto.errors.total', 1, { operation: 'menu_generado' });
    }
  }

  async onMenuValidado(event) {
    const eventData = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;
    const { menu_id, correcciones } = eventData;
    const start_time = Date.now();

    this.logger.info('menu.validado.received', {
      menu_id,
      correcciones_count: correcciones ? correcciones.length : 0,
      correlation_id: correlationId
    });

    try {
      const menuPendiente = this.menusPendientes.get(menu_id);
      if (!menuPendiente) {
        this.logger.warn('menu.validado.not_found', {
          menu_id,
          correlation_id: correlationId
        });
        return;
      }

      let { project_id, productos, categorias } = menuPendiente;

      if (correcciones && correcciones.length > 0) {
        productos = this.applyCorrections(productos, correcciones);
      }

      const stats = await this.syncCatalogo(project_id, menu_id, productos, categorias, correlationId);

      this.menusPendientes.delete(menu_id);

      this.metrics?.increment?.('catalogo.actualizado.total');
      this.metrics?.timing?.('catalogo.sync.duration', Date.now() - start_time);
      this.metrics?.gauge?.('producto.activos.count', this.getProductos(project_id).size);

      await this.publishCatalogoActualizado(project_id, menu_id, stats, Date.now() - start_time, correlationId);

      // Persist updated catalog to disk
      await this.persistCatalog(project_id);

      this.logger.info('catalogo.sincronizado', {
        menu_id,
        project_id,
        estadisticas: stats,
        correlation_id: correlationId,
        duration: Date.now() - start_time
      });

    } catch (error) {
      this.logger.error('menu.validado.error', {
        menu_id,
        error: error.message,
        stack: error.stack,
        correlation_id: correlationId
      });

      this.metrics?.increment?.('producto.errors.total', 1, { operation: 'menu_validado' });
    }
  }


  // ==========================================
  // carta.generada auto-sync
  // ==========================================

  /**
   * Recibe carta.generada del menu-generator (cambios incrementales:
   * precios, productos, ingredientes) y sincroniza directamente al catálogo.
   * Esto cierra la brecha: antes solo toolExportToPOS propagaba cambios.
   */
  async onCartaGenerada(event) {
    const carta = event?.data || event?.payload || event;
    if (!carta?.meta?.id || !carta?.productos) {
      this.logger.debug('carta.generada.ignored', { reason: 'no meta.id or productos' });
      return;
    }

    const project_id = carta.project_id;
    if (!project_id) {
      this.logger.warn('carta.generada.no_project', { carta_id: carta.meta.id });
      return;
    }

    const correlationId = event?.metadata?.correlationId || crypto.randomUUID();
    const start_time = Date.now();

    this.logger.info('carta.generada.received', {
      carta_id: carta.meta.id,
      project_id,
      productos_count: carta.productos.length,
      categorias_count: carta.categorias?.length || 0,
      correlation_id: correlationId
    });

    try {
      // Transformar carta RAW a formato POS (ingredientes → ingredientes_base con IDs)
      const productos = carta.productos.map(p => {
        const prod = {
          id: p.id,
          nombre: p.nombre,
          categoria: p.categoria,
          precio: p.precio,
          activo: true
        };
        if (p.ingredientes_base) {
          prod.ingredientes_base = p.ingredientes_base;
        } else if (p.ingredientes && p.ingredientes.length > 0) {
          prod.ingredientes_base = p.ingredientes.map(ing => ({
            id: ing.id || `ing_${this.slugify(ing.nombre)}`,
            nombre: ing.nombre,
            emoji: ing.emoji || '',
            precio_extra: ing.precio_extra ?? 0,
            grupo: p.categoria || 'otro'
          }));
        }
        if (p.imagen) prod.imagen = p.imagen;
        if (p.descripcion) prod.descripcion = p.descripcion;
        return prod;
      });

      const categorias = (carta.categorias || []).map(c => ({
        ...c,
        activa: true
      }));

      // Sincronizar directamente al catálogo en memoria
      const stats = await this.syncCatalogo(project_id, carta.meta.id, productos, categorias, correlationId);

      // Publicar catalogo.actualizado para que comandero refresque su cache
      await this.publishCatalogoActualizado(project_id, carta.meta.id, stats, Date.now() - start_time, correlationId);

      // Persistir a disco
      await this.persistCatalog(project_id);

      this.logger.info('carta.generada.synced', {
        carta_id: carta.meta.id,
        project_id,
        estadisticas: stats,
        correlation_id: correlationId,
        duration: Date.now() - start_time
      });
    } catch (error) {
      this.logger.error('carta.generada.sync_error', {
        carta_id: carta.meta.id,
        project_id,
        error: error.message,
        correlation_id: correlationId
      });
    }
  }

  // ==========================================
  // UI Handlers (MQTT Request/Response)
  // ==========================================

  async handleListProductos(data) {
    const start_time = Date.now();
    const { project_id: raw_pid, categoria, categoria_id, activo } = data || {};

    if (!raw_pid) {
      return { status: 400, error: 'project_id es requerido' };
    }

    const project_id = this.resolveToActiveProject(raw_pid);

    // Intentar cargar desde archivo si no hay productos en memoria
    const productosMap = this.getProductos(project_id);
    if (productosMap.size === 0) {
      await this.loadCartaFromProject(project_id);
    }

    let productos = Array.from(this.getProductos(project_id).values());

    // Filtrar por categoria (nombre o id)
    if (categoria) {
      productos = productos.filter(p => p.categoria === categoria);
    }
    if (categoria_id) {
      productos = productos.filter(p => p.categoria_id === categoria_id || p.categoria === categoria_id);
    }

    if (activo !== undefined) {
      const activoBoolean = activo === 'true' || activo === true;
      productos = productos.filter(p => p.activo === activoBoolean);
    }

    productos.sort((a, b) => {
      if (a.categoria !== b.categoria) {
        return (a.categoria || '').localeCompare(b.categoria || '');
      }
      return (a.nombre || '').localeCompare(b.nombre || '');
    });

    this.metrics?.timing?.('producto.list.duration', Date.now() - start_time);

    return {
      status: 200,
      data: { project_id, productos, total: productos.length }
    };
  }

  async handleGetProducto(data) {
    const { project_id: raw_pid, id } = data || {};

    if (!raw_pid) {
      return { status: 400, error: 'project_id es requerido' };
    }

    const project_id = this.resolveToActiveProject(raw_pid);
    const producto = this.getProductos(project_id).get(id);

    if (!producto) {
      return { status: 404, error: 'Producto no encontrado' };
    }

    return { status: 200, data: producto };
  }

  async handleSearchProductos(data) {
    const start_time = Date.now();
    const { project_id: raw_pid, q } = data || {};

    if (!raw_pid) {
      return { status: 400, error: 'project_id es requerido' };
    }

    if (!q) {
      return { status: 400, error: 'Parámetro "q" requerido' };
    }

    const project_id = this.resolveToActiveProject(raw_pid);
    const searchTerm = q.toLowerCase();
    const resultados = Array.from(this.getProductos(project_id).values())
      .filter(p =>
        p.activo &&
        ((p.nombre || '').toLowerCase().includes(searchTerm) ||
         (p.descripcion && p.descripcion.toLowerCase().includes(searchTerm)))
      );

    this.metrics?.timing?.('producto.search.duration', Date.now() - start_time);

    return {
      status: 200,
      data: { project_id, resultados, total: resultados.length, query: q }
    };
  }

  async handleListCategorias(data) {
    const { project_id: raw_pid } = data || {};

    if (!raw_pid) {
      return { status: 400, error: 'project_id es requerido' };
    }

    const project_id = this.resolveToActiveProject(raw_pid);

    // Intentar cargar desde archivo si no hay categorías en memoria
    const categoriasMap = this.getCategorias(project_id);
    if (categoriasMap.size === 0) {
      await this.loadCartaFromProject(project_id);
    }

    const categorias = Array.from(this.getCategorias(project_id).values())
      .sort((a, b) => (a.orden || 0) - (b.orden || 0));

    const categoriasConConteo = categorias.map(cat => ({
      ...cat,
      productos_count: Array.from(this.getProductos(project_id).values())
        .filter(p => (p.categoria === cat.nombre || p.categoria_id === cat.id) && p.activo !== false).length
    }));

    return {
      status: 200,
      data: { project_id, categorias: categoriasConConteo, total: categorias.length }
    };
  }

  /**
   * Delega al módulo ingredientes (fuente única de ingredientes).
   * Mantiene el endpoint productos/ingredientes por compatibilidad con el frontend.
   */
  async handleListIngredientes(data) {
    const { project_id: raw_pid, tipo, grupo } = data || {};

    if (!raw_pid) {
      return { status: 400, error: 'project_id es requerido' };
    }

    const result = await this.uiHandler.handle('ingredientes', 'list', { tipo, grupo });
    return result;
  }

  async handleListPizzas(data) {
    const { project_id: raw_pid } = data || {};

    if (!raw_pid) {
      return { status: 400, error: 'project_id es requerido' };
    }

    const project_id = this.resolveToActiveProject(raw_pid);

    // Cargar desde archivo si no hay productos en memoria
    const productosMap = this.getProductos(project_id);
    if (productosMap.size === 0) {
      await this.loadCartaFromProject(project_id);
    }

    const pizzas = Array.from(this.getProductos(project_id).values())
      .filter(p =>
        p.activo !== false && (
          (p.categoria && p.categoria.toLowerCase().startsWith('pizz')) ||
          (p.categoria_id && p.categoria_id.toLowerCase().startsWith('pizz')) ||
          p.tipo === 'pizza'
        )
      )
      .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));

    this.logger.debug('productos.pizzas.list', {
      project_id, raw_pid, total: pizzas.length,
      all_products: this.getProductos(project_id).size
    });

    return {
      status: 200,
      data: { project_id, pizzas, total: pizzas.length }
    };
  }

  async handleUpdateProducto(data) {
    const { project_id, id, ...updates } = data || {};

    if (!project_id) {
      return { status: 400, error: 'project_id es requerido' };
    }

    const productosMap = this.getProductos(project_id);
    const producto = productosMap.get(id);
    if (!producto) {
      return { status: 404, error: 'Producto no encontrado' };
    }

    const cambios = {};
    Object.keys(updates).forEach(key => {
      if (updates[key] !== producto[key]) {
        cambios[key] = { anterior: producto[key], nuevo: updates[key] };
        producto[key] = updates[key];
      }
    });

    producto.updated_at = new Date().toISOString();
    productosMap.set(id, producto);

    this.metrics?.increment?.('producto.actualizado.total');

    await this.publishProductoActualizado(project_id, id, cambios);

    // Persist to disk
    await this.persistCatalog(project_id);

    this.logger.info('producto.actualizado', {
      project_id,
      producto_id: id,
      cambios_count: Object.keys(cambios).length
    });

    return { status: 200, data: producto };
  }

  async handleDeleteProducto(data) {
    const { project_id, id } = data || {};

    if (!project_id) {
      return { status: 400, error: 'project_id es requerido' };
    }

    const productosMap = this.getProductos(project_id);
    const producto = productosMap.get(id);
    if (!producto) {
      return { status: 404, error: 'Producto no encontrado' };
    }

    productosMap.delete(id);

    this.metrics?.increment?.('producto.eliminado.total');
    this.metrics?.gauge?.('producto.activos.count', productosMap.size);

    await this.publishProductoEliminado(project_id, id, 'manual');

    // Persist to disk
    await this.persistCatalog(project_id);

    this.logger.info('producto.eliminado', { project_id, producto_id: id });

    return {
      status: 200,
      data: { message: 'Producto eliminado', project_id, producto_id: id }
    };
  }

  async handleGetStats(data) {
    const { project_id } = data || {};

    if (!project_id) {
      // Stats globales de todos los proyectos
      let totalProductos = 0;
      let totalCategorias = 0;

      for (const [, productos] of this.productosPerProject) {
        totalProductos += productos.size;
      }
      for (const [, categorias] of this.categoriasPerProject) {
        totalCategorias += categorias.size;
      }

      return {
        status: 200,
        data: {
          proyectos_cargados: this.productosPerProject.size,
          total_productos: totalProductos,
          total_categorias: totalCategorias,
          menus_pendientes_validacion: this.menusPendientes.size
        }
      };
    }

    const productosMap = this.getProductos(project_id);
    const categoriasMap = this.getCategorias(project_id);

    const productosPorCategoria = {};
    const productosActivos = Array.from(productosMap.values()).filter(p => p.activo !== false);

    productosActivos.forEach(p => {
      const cat = p.categoria || 'Sin categoría';
      productosPorCategoria[cat] = (productosPorCategoria[cat] || 0) + 1;
    });

    const productosConAlergenos = productosActivos.filter(p => p.alergenos && p.alergenos.length > 0).length;

    return {
      status: 200,
      data: {
        project_id,
        total_productos: productosMap.size,
        productos_activos: productosActivos.length,
        productos_inactivos: productosMap.size - productosActivos.length,
        total_categorias: categoriasMap.size,
        productos_por_categoria: productosPorCategoria,
        productos_con_alergenos: productosConAlergenos,
        menus_pendientes_validacion: this.menusPendientes.size
      }
    };
  }

  async handleHealthCheck() {
    let totalProductos = 0;
    let totalCategorias = 0;

    for (const [, productos] of this.productosPerProject) {
      totalProductos += productos.size;
    }
    for (const [, categorias] of this.categoriasPerProject) {
      totalCategorias += categorias.size;
    }

    return {
      status: 200,
      data: {
        status: 'healthy',
        module: this.name,
        version: this.version,
        catalogo: {
          proyectos: this.productosPerProject.size,
          productos: totalProductos,
          categorias: totalCategorias,
          menus_pendientes: this.menusPendientes.size
        }
      }
    };
  }

  async handleGetMetrics() {
    let totalProductos = 0;
    let totalCategorias = 0;

    for (const [, productos] of this.productosPerProject) {
      totalProductos += productos.size;
    }
    for (const [, categorias] of this.categoriasPerProject) {
      totalCategorias += categorias.size;
    }

    return {
      status: 200,
      data: {
        counters: {
          'producto.creado.total': this.metrics?.getCounter?.('producto.creado.total') || 0,
          'producto.actualizado.total': this.metrics?.getCounter?.('producto.actualizado.total') || 0,
          'producto.eliminado.total': this.metrics?.getCounter?.('producto.eliminado.total') || 0,
          'catalogo.actualizado.total': this.metrics?.getCounter?.('catalogo.actualizado.total') || 0
        },
        gauges: {
          'proyectos.count': this.productosPerProject.size,
          'producto.activos.count': totalProductos,
          'categorias.count': totalCategorias
        }
      }
    };
  }

  /**
   * Carga la carta desde archivo del proyecto
   */
  async handleLoadCarta(data) {
    const { project_id } = data || {};

    if (!project_id) {
      return { status: 400, error: 'project_id es requerido' };
    }

    try {
      const result = await this.loadCartaFromProject(project_id);
      return {
        status: 200,
        data: {
          project_id,
          productos: result.productos,
          categorias: result.categorias,
          message: 'Carta cargada exitosamente'
        }
      };
    } catch (error) {
      this.logger.error('productos.load_carta.error', {
        project_id,
        error: error.message
      });
      return { status: 500, error: error.message };
    }
  }

  /**
   * Devuelve la carta COMPLETA (categorías + productos + ingredientes) de golpe.
   * NO requiere project_id — busca el primer proyecto que tenga datos cargados.
   * Si se pasa project_id, lo usa; si no, usa el primero disponible.
   * Pensado para que el comandero cargue todo de un solo golpe.
   */
  async handleCartaCompleta(data) {
    let projectId = data?.project_id;

    // Si no hay project_id o no tiene datos, buscar el primer proyecto con datos
    if (!projectId || !this.productosPerProject.has(projectId) || this.productosPerProject.get(projectId).size === 0) {
      for (const [pid, prods] of this.productosPerProject) {
        if (prods.size > 0) {
          projectId = pid;
          break;
        }
      }
    }

    if (!projectId) {
      return { status: 404, error: 'No hay carta cargada en ningún proyecto' };
    }

    const categoriasMap = this.categoriasPerProject.get(projectId) || new Map();
    const productosMap = this.productosPerProject.get(projectId) || new Map();

    const categorias = Array.from(categoriasMap.values())
      .filter(c => c.activa !== false)
      .sort((a, b) => (a.orden || 0) - (b.orden || 0));

    const productos = Array.from(productosMap.values())
      .filter(p => p.activo !== false)
      .map(p => ({
        ...p,
        tiene_variaciones: (p.ingredientes && p.ingredientes.length > 0) ||
                           (p.ingredientes_base && p.ingredientes_base.length > 0)
      }));

    // Ingredientes: pedir al módulo ingredientes (fuente única)
    let ingredientes = [];
    const ingResult = await this.uiHandler.handle('ingredientes', 'list', {});
    if (ingResult?.status === 200 && ingResult?.data?.ingredientes) {
      ingredientes = ingResult.data.ingredientes;
    }

    return {
      status: 200,
      data: {
        project_id: projectId,
        categorias,
        productos,
        ingredientes,
        total_categorias: categorias.length,
        total_productos: productos.length,
        total_ingredientes: ingredientes.length
      }
    };
  }

  // ==========================================
  // Event Publishers
  // ==========================================

  async publishProductoCreado(project_id, producto, correlation_id) {
    await this.eventBus.publish('producto.creado', {
      project_id,
      id: producto.id,
      producto_id: producto.id,
      nombre: producto.nombre,
      emoji: producto.emoji,
      categoria: producto.categoria,
      precio: producto.precio,
      ingredientes_base: producto.ingredientes_base,
      alergenos: producto.alergenos,
      menu_source_id: producto.menu_source_id,
      created_at: producto.created_at
    }, {
      correlationId: correlation_id
    });
  }

  async publishProductoActualizado(project_id, producto_id, cambios, correlation_id) {
    const producto = this.getProductos(project_id).get(producto_id);
    await this.eventBus.publish('producto.actualizado', {
      project_id,
      id: producto_id,
      producto_id,
      nombre: producto?.nombre || producto_id,
      precio: producto?.precio,
      cambios,
      updated_at: new Date().toISOString()
    }, {
      correlationId: correlation_id
    });
  }

  async publishProductoEliminado(project_id, producto_id, motivo, correlation_id) {
    await this.eventBus.publish('producto.eliminado', {
      project_id,
      producto_id,
      motivo
    }, {
      correlationId: correlation_id
    });
  }

  async publishCatalogoActualizado(project_id, menu_id, estadisticas, sync_duration, correlation_id) {
    const productos = Array.from(this.getProductos(project_id).values())
      .filter(p => p.activo !== false)
      .map(p => ({ id: p.id, nombre: p.nombre, precio: p.precio, categoria: p.categoria || null }));

    await this.eventBus.publish('catalogo.actualizado', {
      project_id,
      menu_id,
      estadisticas,
      sync_duration,
      productos
    }, {
      correlationId: correlation_id
    });
  }

  // ==========================================
  // Helper Methods
  // ==========================================

  /**
   * Persiste el catálogo actual a disco como carta JSON.
   * Guarda productos y categorías en {storagePath}/cartas/catalogo_activo.json
   */
  async persistCatalog(project_id) {
    let storagePath;
    try {
      storagePath = await this.resolveStoragePath(project_id);
    } catch (err) {
      this.logger.warn('productos.persist.path_failed', { project_id, error: err.message });
      return;
    }

    const cartasDir = path.join(storagePath, 'cartas');
    const catalogPath = path.join(cartasDir, 'catalogo_activo.json');

    try {
      await fs.mkdir(cartasDir, { recursive: true });

      const productosMap = this.getProductos(project_id);
      const categoriasMap = this.getCategorias(project_id);

      const catalog = {
        meta: {
          id: 'catalogo_activo',
          nombre: 'Catálogo Activo',
          updated_at: new Date().toISOString()
        },
        categorias: Array.from(categoriasMap.values()),
        productos: Array.from(productosMap.values())
      };

      await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2), 'utf-8');

      this.logger.info('productos.persisted', {
        project_id,
        productos: catalog.productos.length,
        categorias: catalog.categorias.length,
        path: catalogPath
      });
    } catch (err) {
      this.logger.error('productos.persist.failed', {
        project_id,
        error: err.message
      });
    }
  }

  async syncCatalogo(project_id, menu_id, productos, categorias, correlation_id) {
    const stats = {
      productos_nuevos: 0,
      productos_actualizados: 0,
      productos_desactivados: 0,
      categorias_nuevas: 0
    };

    const categoriasMap = this.getCategorias(project_id);
    const productosMap = this.getProductos(project_id);

    for (const cat of categorias) {
      if (!categoriasMap.has(cat.id)) {
        categoriasMap.set(cat.id, { ...cat, activa: true });
        stats.categorias_nuevas++;
      }
    }

    const productosExistentes = new Set(productosMap.keys());

    for (const prod of productos) {
      const productoExistente = productosMap.get(prod.id);

      if (productoExistente) {
        const productoActualizado = {
          ...productoExistente,
          ...prod,
          activo: true,
          menu_source_id: menu_id,
          updated_at: new Date().toISOString()
        };
        productosMap.set(prod.id, productoActualizado);
        stats.productos_actualizados++;

        await this.publishProductoActualizado(project_id, prod.id, { menu_source_id: menu_id }, correlation_id);

      } else {
        const nuevoProducto = {
          ...prod,
          activo: true,
          menu_source_id: menu_id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        productosMap.set(prod.id, nuevoProducto);
        stats.productos_nuevos++;

        this.metrics?.increment?.('producto.creado.total');
        await this.publishProductoCreado(project_id, nuevoProducto, correlation_id);
      }

      productosExistentes.delete(prod.id);
    }

    for (const prod_id of productosExistentes) {
      const producto = productosMap.get(prod_id);
      if (producto && producto.activo) {
        producto.activo = false;
        producto.updated_at = new Date().toISOString();
        productosMap.set(prod_id, producto);
        stats.productos_desactivados++;

        await this.publishProductoActualizado(project_id, prod_id, { activo: false }, correlation_id);
      }
    }

    return stats;
  }

  /**
   * Carga carta desde el sistema de archivos del proyecto
   * Resuelve base_path via project-manager (no asume UUID como directorio)
   */
  async loadCartaFromProject(project_id) {
    let storagePath;
    try {
      storagePath = await this.resolveStoragePath(project_id);
    } catch (err) {
      this.logger.warn('productos.resolve_path.failed', { project_id, error: err.message });
      return { productos: 0, categorias: 0 };
    }
    const cartasDir = path.join(storagePath, 'cartas');

    const result = {
      productos: 0,
      categorias: 0
    };

    try {
      // Cargar cartas
      try {
        const files = await fs.readdir(cartasDir);
        const jsonFiles = files.filter(f => f.endsWith('.json'));

        for (const file of jsonFiles) {
          const cartaPath = path.join(cartasDir, file);
          const cartaData = await fs.readFile(cartaPath, 'utf8');
          const carta = JSON.parse(cartaData);

          // Cargar categorías de la carta
          if (carta.categorias) {
            const categoriasMap = this.getCategorias(project_id);
            for (const cat of carta.categorias) {
              categoriasMap.set(cat.id, { ...cat, activa: true });
              result.categorias++;
            }
          }

          // Cargar productos de la carta (normalizar RAW → POS si falta ingredientes_base)
          if (carta.productos) {
            const productosMap = this.getProductos(project_id);
            for (const prod of carta.productos) {
              this.normalizeProductoPOS(prod);
              productosMap.set(prod.id, {
                ...prod,
                activo: true,
                carta_source: carta.meta?.id || file.replace('.json', ''),
                loaded_at: new Date().toISOString()
              });
              result.productos++;
            }
          }
        }
      } catch (e) {
        // No hay directorio de cartas
        this.logger.debug('productos.no_cartas_dir', { project_id, path: cartasDir });
      }

      this.logger.info('productos.carta_loaded', {
        project_id,
        productos: result.productos,
        categorias: result.categorias
      });

      // Emit menu.generado so categorias module gets populated from disk data
      if (result.categorias > 0 || result.productos > 0) {
        const allCategorias = Array.from(this.getCategorias(project_id).values());
        const allProductos = Array.from(this.getProductos(project_id).values());
        await this.eventBus.publish('menu.generado', {
          project_id,
          categorias: allCategorias,
          productos: allProductos,
          source: 'disk_load'
        });
      }

      return result;
    } catch (error) {
      this.logger.warn('productos.load_carta.error', {
        project_id,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Slugify — misma lógica que menu-generator para generar IDs deterministas
   */
  slugify(text) {
    if (!text) return 'sin_nombre';
    return text.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      || 'sin_nombre';
  }

  /**
   * Normaliza un producto RAW de carta (ingredientes sin ID)
   * al formato POS (ingredientes_base con IDs).
   * Conserva tipo y precio_extra si vienen del menu-generator.
   * Si ya tiene ingredientes_base, no toca nada.
   */
  normalizeProductoPOS(prod) {
    if (prod.ingredientes_base) return prod;
    if (!prod.ingredientes || prod.ingredientes.length === 0) return prod;

    prod.ingredientes_base = prod.ingredientes.map(ing => {
      const result = {
        id: ing.id || `ing_${this.slugify(ing.nombre)}`,
        nombre: ing.nombre,
        emoji: ing.emoji || ''
      };
      if (ing.tipo) result.tipo = ing.tipo;
      if (ing.precio_extra != null) result.precio_extra = ing.precio_extra;
      return result;
    });

    return prod;
  }

  applyCorrections(productos, correcciones) {
    const productosMap = new Map(productos.map(p => [p.id, p]));

    correcciones.forEach(corr => {
      const producto = productosMap.get(corr.producto_id);
      if (producto && corr.campo) {
        producto[corr.campo] = corr.valor_nuevo;
      }
    });

    return Array.from(productosMap.values());
  }
}

module.exports = ProductosModule;
