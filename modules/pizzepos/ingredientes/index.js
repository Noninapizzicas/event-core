/**
 * Módulo Ingredientes v4.0
 * Catálogo de ingredientes organizado por GRUPO (categoría de producto).
 * FUENTE ÚNICA de precios de ingredientes (precio_extra).
 *
 * Concepto clave:
 *   - Cada ingrediente pertenece a uno o más GRUPOS (= categorías de producto: pizzas, bocadillos, etc.)
 *   - Los ingredientes de un grupo solo se ofrecen a productos de ese grupo
 *   - El campo "tipo" (queso, carne, verdura...) es para agrupación visual en la UI
 *   - Precios los controla el jefe: por tipo, por grupo, individual, o por porcentaje
 *   - Persiste a disco en {storagePath}/ingredientes.json
 *
 * Emite: ingrediente.creado, ingrediente.actualizado
 * Consume: menu.generado, producto.creado, project.activated
 */

const fs = require('fs').promises;
const path = require('path');

class IngredientesModule {
  constructor() {
    this.name = 'ingredientes';
    this.version = '4.0.0';

    // Dependencias (inyectadas en onLoad)
    this.eventBus = null;
    this.logger = null;
    this.metrics = null;
    this.uiHandler = null;

    // Estado en memoria
    this.ingredientes = new Map(); // ingrediente_id -> ingrediente

    // Storage
    this.storageSection = 'pizzepos';
    this.storagePath = null; // resolved on project.activated
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
    this.registerUIHandlers();

    this.logger.info('module.loaded', { module: this.name, version: this.version });
  }

  async onUnload() {
    this.logger.info('module.unloading', { module: this.name });

    if (this.uiHandler) {
      const actions = ['list', 'get', 'get_precio', 'search', 'alergenos', 'update', 'update_precios', 'health', 'metrics'];
      for (const action of actions) {
        this.uiHandler.unregister('ingredientes', action);
      }
    }

    this.ingredientes.clear();

    this.logger.info('module.unloaded', { module: this.name });
  }

  // ==========================================
  // UI Handler Registration
  // ==========================================

  registerUIHandlers() {
    if (!this.uiHandler) {
      this.logger.warn('ingredientes.uiHandler.not_available', { module: this.name });
      return;
    }

    this.uiHandler.register('ingredientes', 'list', this.handleListIngredientes.bind(this));
    this.uiHandler.register('ingredientes', 'get', this.handleGetIngrediente.bind(this));
    this.uiHandler.register('ingredientes', 'get_precio', this.handleGetPrecio.bind(this));
    this.uiHandler.register('ingredientes', 'search', this.handleSearchIngredientes.bind(this));
    this.uiHandler.register('ingredientes', 'alergenos', this.handleListAlergenos.bind(this));
    this.uiHandler.register('ingredientes', 'update', this.handleUpdateIngrediente.bind(this));
    this.uiHandler.register('ingredientes', 'update_precios', this.handleUpdatePrecios.bind(this));
    this.uiHandler.register('ingredientes', 'health', this.handleHealthCheck.bind(this));
    this.uiHandler.register('ingredientes', 'metrics', this.handleGetMetrics.bind(this));

    this.logger.info('ingredientes.ui_handlers.registered', {
      handlers: ['list', 'get', 'get_precio', 'search', 'alergenos', 'update', 'update_precios', 'health', 'metrics']
    });
  }

  // ==========================================
  // Event Subscriptions
  // ==========================================

  async subscribeToEvents() {
    await this.eventBus.subscribe('menu.generado', this.onMenuGenerado.bind(this));
    await this.eventBus.subscribe('producto.creado', this.onProductoCreado.bind(this));
    await this.eventBus.subscribe('project.activated', this.onProjectActivated.bind(this));
    await this.eventBus.subscribe('ingrediente.actualizado', this.onIngredienteActualizadoExterno.bind(this));

    this.logger.info('ingredientes.events.subscribed', {
      events: ['menu.generado', 'producto.creado', 'project.activated', 'ingrediente.actualizado']
    });
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  async onProjectActivated(event) {
    const data = event?.data || event?.payload || event;
    const { project_id, base_path } = data;

    if (!base_path) return;

    this.storagePath = path.join(base_path, 'storage', this.storageSection);

    // Cargar ingredientes desde disco
    try {
      await this.loadFromDisk();
      this.logger.info('ingredientes.loaded_from_disk', {
        project_id,
        total: this.ingredientes.size
      });
    } catch (err) {
      this.logger.debug('ingredientes.no_disk_data', { project_id, error: err.message });
    }
  }

  async onMenuGenerado(event) {
    const eventData = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;
    const { ingredientes_catalogo, productos, source } = eventData;

    const start_time = Date.now();
    let nuevos = 0;
    let actualizados = 0;

    // Procesar ingredientes_catalogo si viene
    if (ingredientes_catalogo && ingredientes_catalogo.length > 0) {
      this.logger.info('menu.generado.received', {
        ingredientes_count: ingredientes_catalogo.length,
        correlation_id: correlationId
      });

      for (const ing of ingredientes_catalogo) {
        const existente = this.ingredientes.get(ing.id);

        if (!existente) {
          const ingrediente = {
            ...ing,
            tipo: ing.tipo || this.clasificarIngrediente(ing.nombre),
            grupos: ing.grupos || [],
            disponible: true,
            precio_extra: ing.precio_extra || 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };

          this.ingredientes.set(ing.id, ingrediente);
          nuevos++;

          this.metrics.increment('ingrediente.creado.total');
          await this.publishIngredienteCreado(ingrediente, correlationId);

        } else {
          // Merge grupos: acumular sin duplicar
          const gruposMerged = [...new Set([...(existente.grupos || []), ...(ing.grupos || [])])];
          const actualizado = {
            ...existente,
            ...ing,
            grupos: gruposMerged,
            updated_at: new Date().toISOString()
          };

          this.ingredientes.set(ing.id, actualizado);
          actualizados++;

          await this.publishIngredienteActualizado(ing.id, { emoji: ing.emoji, grupos: gruposMerged }, correlationId);
        }
      }
    }

    // Construir catálogo desde ingredientes_base de productos (disk_load o menus sin ingredientes_catalogo)
    if (productos && productos.length > 0) {
      for (const prod of productos) {
        const grupo = prod.categoria || 'otro';
        const base = prod.ingredientes_base || prod.ingredientes || [];
        for (const ing of base) {
          if (!ing.id && !ing.nombre) continue;
          const id = ing.id || `ing_${this.slugify(ing.nombre)}`;
          const existente = this.ingredientes.get(id);
          if (!existente) {
            const ingrediente = {
              id,
              nombre: ing.nombre,
              emoji: ing.emoji || '',
              tipo: ing.tipo || this.clasificarIngrediente(ing.nombre),
              es_alergeno: false,
              precio_extra: ing.precio_extra ?? 0,
              grupos: [grupo],
              disponible: true,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            };
            this.ingredientes.set(id, ingrediente);
            nuevos++;
            this.metrics.increment('ingrediente.creado.total');
            await this.publishIngredienteCreado(ingrediente, correlationId);
          } else {
            if (!existente.grupos) existente.grupos = [];
            if (!existente.grupos.includes(grupo)) {
              existente.grupos.push(grupo);
              existente.updated_at = new Date().toISOString();
              this.ingredientes.set(id, existente);
            }
          }
        }
      }
    }

    if (nuevos > 0 || actualizados > 0) {
      this.metrics.gauge('ingrediente.total.count', this.ingredientes.size);
      this.metrics.gauge('ingrediente.alergenos.count',
        Array.from(this.ingredientes.values()).filter(i => i.es_alergeno).length
      );
      this.metrics.timing('ingrediente.sync.duration', Date.now() - start_time);

      // Persistir a disco
      await this.saveToDisk();

      this.logger.info('ingredientes.sincronizados', {
        nuevos,
        actualizados,
        total: this.ingredientes.size,
        correlation_id: correlationId,
        duration: Date.now() - start_time
      });
    }
  }

  async onProductoCreado(event) {
    const eventData = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;
    const { ingredientes_base, producto_id, categoria } = eventData;

    if (!ingredientes_base || ingredientes_base.length === 0) {
      return;
    }

    const grupo = categoria || 'otro';
    let changed = false;

    for (const ing of ingredientes_base) {
      const existente = this.ingredientes.get(ing.id);
      if (!existente) {
        const ingrediente = {
          ...ing,
          tipo: ing.tipo || this.clasificarIngrediente(ing.nombre),
          grupos: [grupo],
          disponible: true,
          precio_extra: ing.precio_extra ?? 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        this.ingredientes.set(ing.id, ingrediente);
        changed = true;

        this.metrics.increment('ingrediente.creado.total');
        await this.publishIngredienteCreado(ingrediente, correlationId);

        this.logger.info('ingrediente.creado', {
          ingrediente_id: ing.id,
          nombre: ing.nombre,
          grupo,
          from_producto: producto_id,
          correlation_id: correlationId
        });
      } else {
        // Añadir grupo si no está
        if (!existente.grupos) existente.grupos = [];
        if (!existente.grupos.includes(grupo)) {
          existente.grupos.push(grupo);
          existente.updated_at = new Date().toISOString();
          this.ingredientes.set(ing.id, existente);
          changed = true;
        }
      }
    }

    if (changed) {
      await this.saveToDisk();
    }
  }

  /**
   * Recibe ingrediente.actualizado de fuentes externas (ej: menu-generator toolUpdateIngredientPrices).
   * Aplica los cambios en memoria y persiste a disco.
   * Evita loops: si el cambio ya está aplicado, no re-publica.
   */
  async onIngredienteActualizadoExterno(event) {
    const eventData = event?.data || event?.payload || event;
    const { ingrediente_id, cambios } = eventData;

    if (!ingrediente_id || !cambios) return;

    const existente = this.ingredientes.get(ingrediente_id);
    if (!existente) return;

    let changed = false;
    for (const [campo, valores] of Object.entries(cambios)) {
      const nuevoValor = valores?.nuevo !== undefined ? valores.nuevo : valores;
      if (existente[campo] !== nuevoValor) {
        existente[campo] = nuevoValor;
        changed = true;
      }
    }

    if (changed) {
      existente.updated_at = new Date().toISOString();
      this.ingredientes.set(ingrediente_id, existente);
      await this.saveToDisk();

      this.logger.info('ingredientes.synced_from_external', {
        ingrediente_id,
        campos: Object.keys(cambios)
      });
    }
  }

  // ==========================================
  // UI Handlers (MQTT Request/Response)
  // ==========================================

  async handleListIngredientes(data) {
    const { tipo, grupo, alergeno } = data || {};

    let ingredientes = Array.from(this.ingredientes.values())
      .filter(i => i.disponible !== false);

    // Filtrar por grupo (categoría de producto)
    if (grupo) {
      ingredientes = ingredientes.filter(i =>
        i.grupos && i.grupos.includes(grupo)
      );
    }

    if (tipo) {
      ingredientes = ingredientes.filter(i => i.tipo === tipo);
    }

    if (alergeno === 'true' || alergeno === true) {
      ingredientes = ingredientes.filter(i => i.es_alergeno === true);
    }

    ingredientes.sort((a, b) => {
      if (a.tipo !== b.tipo) {
        return (a.tipo || '').localeCompare(b.tipo || '');
      }
      return a.nombre.localeCompare(b.nombre);
    });

    return {
      status: 200,
      data: { ingredientes, total: ingredientes.length }
    };
  }

  async handleGetIngrediente(data) {
    const { id } = data;
    const ingrediente = this.ingredientes.get(id);

    if (!ingrediente) {
      return { status: 404, error: 'Ingrediente no encontrado' };
    }

    return { status: 200, data: ingrediente };
  }

  /**
   * Devuelve el precio_extra de un ingrediente por ID.
   * Usado internamente por variaciones para calcular precios.
   */
  async handleGetPrecio(data) {
    const { ingrediente_id } = data;
    const ingrediente = this.ingredientes.get(ingrediente_id);

    if (!ingrediente) {
      return { status: 404, error: 'Ingrediente no encontrado' };
    }

    return {
      status: 200,
      data: {
        ingrediente_id,
        precio_extra: ingrediente.precio_extra || 0,
        disponible: ingrediente.disponible !== false
      }
    };
  }

  async handleSearchIngredientes(data) {
    const { q, grupo } = data || {};

    if (!q) {
      return { status: 400, error: 'Parámetro "q" requerido' };
    }

    const searchTerm = q.toLowerCase();
    let resultados = Array.from(this.ingredientes.values())
      .filter(i => i.nombre.toLowerCase().includes(searchTerm));

    if (grupo) {
      resultados = resultados.filter(i => i.grupos && i.grupos.includes(grupo));
    }

    return {
      status: 200,
      data: { resultados, total: resultados.length, query: q }
    };
  }

  async handleListAlergenos() {
    const alergenos = Array.from(this.ingredientes.values())
      .filter(i => i.es_alergeno === true);

    const porTipo = {};
    alergenos.forEach(ing => {
      if (ing.alergenos && ing.alergenos.length > 0) {
        ing.alergenos.forEach(alergeno => {
          if (!porTipo[alergeno]) {
            porTipo[alergeno] = [];
          }
          porTipo[alergeno].push({
            id: ing.id,
            nombre: ing.nombre,
            emoji: ing.emoji
          });
        });
      }
    });

    return {
      status: 200,
      data: { alergenos, total: alergenos.length, por_tipo: porTipo }
    };
  }

  async handleUpdateIngrediente(data) {
    const { id, ...updates } = data;

    const ingrediente = this.ingredientes.get(id);
    if (!ingrediente) {
      return { status: 404, error: 'Ingrediente no encontrado' };
    }

    const cambios = {};
    Object.keys(updates).forEach(key => {
      if (updates[key] !== ingrediente[key]) {
        cambios[key] = { anterior: ingrediente[key], nuevo: updates[key] };
        ingrediente[key] = updates[key];
      }
    });

    ingrediente.updated_at = new Date().toISOString();
    this.ingredientes.set(id, ingrediente);

    this.metrics.increment('ingrediente.actualizado.total');
    await this.publishIngredienteActualizado(id, cambios);
    await this.saveToDisk();

    this.logger.info('ingrediente.actualizado', {
      ingrediente_id: id,
      cambios_count: Object.keys(cambios).length
    });

    return { status: 200, data: ingrediente };
  }

  /**
   * Cambiar precios de ingredientes en bloque.
   * Modos:
   *   { id, precio_extra }                 → individual
   *   { tipo, precio_extra }               → todos los de un tipo (carne, queso...)
   *   { grupo, precio_extra }              → todos los de un grupo (pizzas, bocadillos...)
   *   { tipo, porcentaje }                 → subir/bajar % a un tipo
   *   { grupo, tipo, precio_extra }        → tipo dentro de un grupo
   */
  async handleUpdatePrecios(data) {
    const { id, tipo, grupo, precio_extra, porcentaje } = data || {};

    if (precio_extra == null && porcentaje == null) {
      return { status: 400, error: 'Se requiere precio_extra o porcentaje' };
    }

    let afectados = [];

    if (id) {
      // Individual
      const ing = this.ingredientes.get(id);
      if (!ing) return { status: 404, error: 'Ingrediente no encontrado' };
      afectados = [ing];
    } else {
      // Filtrar por tipo y/o grupo
      afectados = Array.from(this.ingredientes.values());
      if (grupo) {
        afectados = afectados.filter(i => i.grupos && i.grupos.includes(grupo));
      }
      if (tipo) {
        afectados = afectados.filter(i => i.tipo === tipo);
      }
    }

    if (afectados.length === 0) {
      return { status: 404, error: 'No se encontraron ingredientes con ese filtro' };
    }

    const actualizados = [];
    for (const ing of afectados) {
      const anterior = ing.precio_extra || 0;
      if (porcentaje != null) {
        ing.precio_extra = Math.round(anterior * (1 + porcentaje / 100) * 100) / 100;
      } else {
        ing.precio_extra = precio_extra;
      }
      ing.updated_at = new Date().toISOString();
      this.ingredientes.set(ing.id, ing);
      actualizados.push({ id: ing.id, nombre: ing.nombre, anterior, nuevo: ing.precio_extra });

      await this.publishIngredienteActualizado(ing.id, {
        precio_extra: { anterior, nuevo: ing.precio_extra }
      });
    }

    // Persistir cambios de precios a disco
    await this.saveToDisk();

    this.logger.info('ingredientes.precios_actualizados', {
      filtro: { id, tipo, grupo, precio_extra, porcentaje },
      afectados: actualizados.length
    });

    return {
      status: 200,
      data: { actualizados, total: actualizados.length }
    };
  }

  async handleHealthCheck() {
    return {
      status: 200,
      data: {
        status: 'healthy',
        module: this.name,
        version: this.version,
        catalogo: {
          total: this.ingredientes.size,
          alergenos: Array.from(this.ingredientes.values()).filter(i => i.es_alergeno).length,
          por_tipo: this.countByType(),
          por_grupo: this.countByGroup()
        }
      }
    };
  }

  async handleGetMetrics() {
    return {
      status: 200,
      data: {
        counters: {
          'ingrediente.creado.total': this.metrics.getCounter('ingrediente.creado.total') || 0,
          'ingrediente.actualizado.total': this.metrics.getCounter('ingrediente.actualizado.total') || 0
        },
        gauges: {
          'ingrediente.total.count': this.ingredientes.size,
          'ingrediente.alergenos.count': Array.from(this.ingredientes.values()).filter(i => i.es_alergeno).length
        }
      }
    };
  }

  // ==========================================
  // Persistence
  // ==========================================

  async loadFromDisk() {
    if (!this.storagePath) return;

    const filePath = path.join(this.storagePath, 'ingredientes.json');
    const data = await fs.readFile(filePath, 'utf8');
    const json = JSON.parse(data);

    if (json.ingredientes && json.ingredientes.length > 0) {
      for (const ing of json.ingredientes) {
        this.ingredientes.set(ing.id, { ...ing, disponible: ing.disponible !== false });
      }
      this.logger.info('ingredientes.disk.loaded', { count: json.ingredientes.length });
    }
  }

  async saveToDisk() {
    if (!this.storagePath) return;

    try {
      await fs.mkdir(this.storagePath, { recursive: true });

      const filePath = path.join(this.storagePath, 'ingredientes.json');
      const data = {
        ingredientes: Array.from(this.ingredientes.values()),
        updated_at: new Date().toISOString()
      };

      await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');

      this.logger.debug('ingredientes.disk.saved', { count: this.ingredientes.size });
    } catch (err) {
      this.logger.warn('ingredientes.disk.save_failed', { error: err.message });
    }
  }

  // ==========================================
  // Event Publishers
  // ==========================================

  async publishIngredienteCreado(ingrediente, correlation_id) {
    await this.eventBus.publish('ingrediente.creado', {
      ingrediente_id: ingrediente.id,
      nombre: ingrediente.nombre,
      emoji: ingrediente.emoji,
      tipo: ingrediente.tipo,
      grupos: ingrediente.grupos,
      es_alergeno: ingrediente.es_alergeno,
      alergenos: ingrediente.alergenos,
      created_at: ingrediente.created_at
    }, {
      correlationId: correlation_id
    });
  }

  async publishIngredienteActualizado(ingrediente_id, cambios, correlation_id) {
    await this.eventBus.publish('ingrediente.actualizado', {
      ingrediente_id,
      cambios,
      updated_at: new Date().toISOString()
    }, {
      correlationId: correlation_id
    });
  }

  // ==========================================
  // Helper Methods
  // ==========================================

  /**
   * Clasifica un ingrediente por nombre (fallback para cartas sin tipo).
   */
  clasificarIngrediente(nombre) {
    if (!nombre) return 'otro';
    const n = nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/mozzarella|queso|mezcla de quesos|parmesano|gorgonzola|cheddar|emmental|brie|gouda|provolone|roquefort/.test(n)) return 'queso';
    if (/bacon|pollo|ternera|carne|york|jamon|pepperoni|peperoni|salchich|chorizo|lomo|cerdo|pavo|salami|anchoa/.test(n)) return 'carne';
    if (/gambas|langostino|atun|salmon|marisco|pulpo|calamar|mejillon|surimi/.test(n)) return 'marisco';
    if (/salsa|nata|pesto|carbonara|ketchup|mayonesa|alioli|mostaza/.test(n)) return 'salsa';
    if (/tomate|cebolla|pimiento|champi[nñ]on|seta|aceituna|oliva|alcachofa|esparrago|espinaca|rucula|albahaca|oregano|ajo|maiz|pi[nñ]a|jalape[nñ]o|pepino|lechuga|zanahoria|berenjena|calabacin/.test(n)) return 'verdura';
    if (/masa|harina|levadura/.test(n)) return 'masa';
    return 'otro';
  }

  slugify(text) {
    if (!text) return 'sin_nombre';
    return text.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      || 'sin_nombre';
  }

  countByType() {
    const counts = {};
    Array.from(this.ingredientes.values()).forEach(ing => {
      counts[ing.tipo] = (counts[ing.tipo] || 0) + 1;
    });
    return counts;
  }

  countByGroup() {
    const counts = {};
    Array.from(this.ingredientes.values()).forEach(ing => {
      (ing.grupos || []).forEach(g => {
        counts[g] = (counts[g] || 0) + 1;
      });
    });
    return counts;
  }
}

module.exports = IngredientesModule;
