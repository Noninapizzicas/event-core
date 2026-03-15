/**
 * Módulo Carta Digital v1.1
 * Carta del cliente — configuración, sesiones, pedidos y media serving
 * Alineado con patrones event-core: uiHandler, event envelope, cleanup
 * Multi-tenant: cada proyecto tiene su propia config
 *
 * Emite: carta-digital.sesion_creada, carta-digital.pedido_recibido
 * Consume: project.activated
 *
 * APIs HTTP:
 *   GET /media/:path — Sirve imágenes del storage del proyecto
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class CartaDigitalModule {
  constructor() {
    this.name = 'carta-digital';
    this.version = '1.0.0';

    // Dependencias (inyectadas en onLoad)
    this.eventBus = null;
    this.logger = null;
    this.metrics = null;
    this.uiHandler = null;

    // Estado en memoria — por proyecto
    this.configPerProject = new Map();    // project_id -> CartaConfig
    this.sesionesActivas = new Map();     // session_id -> SessionData
    this.pedidosRegistrados = new Map();  // pedido_id -> PedidoData
    this.ofertasPerProject = new Map();   // project_id -> Map<oferta_id, OfertaData>
    this.funnelEvents = new Map();       // project_id -> Array<FunnelEvent>
    this.resenasPerProject = new Map();  // project_id -> Array<ResenaData>

    // Storage
    this.storageSection = 'pizzepos';
    this.projectPaths = new Map();
  }

  // ==========================================
  // Default config
  // ==========================================

  defaultConfig() {
    return {
      whatsapp_telefono: '',
      nombre_negocio: 'Pizzicas',
      moneda: '€',
      mensaje_header: '¡Hola! Quiero pedir:',
      tema: {
        color_primario: '#f59e0b',
        color_fondo: '#0a0a0a',
        color_texto: '#e5e5e5',
        logo_emoji: '🍕'
      },
      funcionalidades: {
        carrito: true,
        whatsapp: true,
        compartir: true,
        variaciones: true
      },
      updated_at: null
    };
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

    this.registerUIHandlers();

    this.logger.info('module.loaded', { module: this.name, version: this.version });
  }

  async onUnload() {
    this.logger.info('module.unloading', { module: this.name });

    if (this.uiHandler) {
      const actions = ['config', 'update-config', 'create-session', 'register-pedido', 'stats', 'health',
        'ofertas', 'create-oferta', 'update-oferta', 'delete-oferta', 'track-event', 'funnel',
        'resenas', 'create-resena'];
      for (const action of actions) {
        this.uiHandler.unregister('carta-digital', action);
      }
    }

    this.configPerProject.clear();
    this.sesionesActivas.clear();
    this.pedidosRegistrados.clear();
    this.ofertasPerProject.clear();
    this.funnelEvents.clear();
    this.resenasPerProject.clear();
    this.projectPaths.clear();

    this.logger.info('module.unloaded', { module: this.name });
  }

  // ==========================================
  // UI Handler Registration
  // ==========================================

  registerUIHandlers() {
    if (!this.uiHandler) {
      this.logger.warn('carta-digital.uiHandler.not_available', { module: this.name });
      return;
    }

    this.uiHandler.register('carta-digital', 'config', this.handleGetConfig.bind(this));
    this.uiHandler.register('carta-digital', 'update-config', this.handleUpdateConfig.bind(this));
    this.uiHandler.register('carta-digital', 'create-session', this.handleCreateSession.bind(this));
    this.uiHandler.register('carta-digital', 'register-pedido', this.handleRegisterPedido.bind(this));
    this.uiHandler.register('carta-digital', 'stats', this.handleGetStats.bind(this));
    this.uiHandler.register('carta-digital', 'health', this.handleHealthCheck.bind(this));
    this.uiHandler.register('carta-digital', 'export-static', this.handleExportStatic.bind(this));
    this.uiHandler.register('carta-digital', 'deploy-cf-worker', this.handleDeployCFWorker.bind(this));
    this.uiHandler.register('carta-digital', 'ofertas', this.handleGetOfertas.bind(this));
    this.uiHandler.register('carta-digital', 'create-oferta', this.handleCreateOferta.bind(this));
    this.uiHandler.register('carta-digital', 'update-oferta', this.handleUpdateOferta.bind(this));
    this.uiHandler.register('carta-digital', 'delete-oferta', this.handleDeleteOferta.bind(this));
    this.uiHandler.register('carta-digital', 'track-event', this.handleTrackEvent.bind(this));
    this.uiHandler.register('carta-digital', 'funnel', this.handleGetFunnel.bind(this));
    this.uiHandler.register('carta-digital', 'resenas', this.handleGetResenas.bind(this));
    this.uiHandler.register('carta-digital', 'create-resena', this.handleCreateResena.bind(this));

    this.logger.info('carta-digital.ui_handlers.registered', {
      handlers: ['config', 'update-config', 'create-session', 'register-pedido', 'stats', 'health', 'export-static', 'deploy-cf-worker', 'ofertas', 'create-oferta', 'update-oferta', 'delete-oferta', 'track-event', 'funnel', 'resenas', 'create-resena']
    });
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  async onProjectActivated(event) {
    const data = event.data || event;
    const { project_id, base_path } = data;
    if (!project_id || !base_path) return;

    this.projectPaths.set(project_id, path.join(base_path, 'storage', this.storageSection));

    // Cargar config de disco
    try {
      await this.loadConfig(project_id);
      this.logger.info('carta-digital.config.loaded', { project_id });
    } catch (err) {
      // Primera vez — crear config default
      this.configPerProject.set(project_id, this.defaultConfig());
      this.logger.info('carta-digital.config.default_created', { project_id });
    }

    // Cargar ofertas de disco
    try {
      await this.loadOfertas(project_id);
      this.logger.info('carta-digital.ofertas.loaded', { project_id });
    } catch (err) {
      this.ofertasPerProject.set(project_id, new Map());
    }

    // Init funnel events
    if (!this.funnelEvents.has(project_id)) {
      this.funnelEvents.set(project_id, []);
    }

    // Cargar reseñas de disco
    try {
      await this.loadResenas(project_id);
      this.logger.info('carta-digital.resenas.loaded', { project_id });
    } catch (err) {
      this.resenasPerProject.set(project_id, []);
    }
  }

  // ==========================================
  // Config persistence
  // ==========================================

  async loadConfig(project_id) {
    const storagePath = this.projectPaths.get(project_id);
    if (!storagePath) throw new Error('No storage path for project');

    const configPath = path.join(storagePath, 'carta-digital.json');
    const raw = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(raw);

    this.configPerProject.set(project_id, { ...this.defaultConfig(), ...config });
  }

  async saveConfig(project_id) {
    const storagePath = this.projectPaths.get(project_id);
    if (!storagePath) return;

    const configPath = path.join(storagePath, 'carta-digital.json');
    const config = this.configPerProject.get(project_id);
    if (!config) return;

    try {
      await fs.mkdir(storagePath, { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
      this.logger.info('carta-digital.config.saved', { project_id });
    } catch (err) {
      this.logger.error('carta-digital.config.save_failed', { project_id, error: err.message });
    }
  }

  // ==========================================
  // Ofertas persistence
  // ==========================================

  async loadOfertas(project_id) {
    const storagePath = this.projectPaths.get(project_id);
    if (!storagePath) throw new Error('No storage path for project');

    const ofertasPath = path.join(storagePath, 'carta-digital-ofertas.json');
    const raw = await fs.readFile(ofertasPath, 'utf8');
    const arr = JSON.parse(raw);

    const map = new Map();
    for (const o of arr) { map.set(o.id, o); }
    this.ofertasPerProject.set(project_id, map);
  }

  async saveOfertas(project_id) {
    const storagePath = this.projectPaths.get(project_id);
    if (!storagePath) return;

    const ofertasPath = path.join(storagePath, 'carta-digital-ofertas.json');
    const map = this.ofertasPerProject.get(project_id);
    if (!map) return;

    try {
      await fs.mkdir(storagePath, { recursive: true });
      await fs.writeFile(ofertasPath, JSON.stringify(Array.from(map.values()), null, 2), 'utf-8');
      this.logger.info('carta-digital.ofertas.saved', { project_id });
    } catch (err) {
      this.logger.error('carta-digital.ofertas.save_failed', { project_id, error: err.message });
    }
  }

  /**
   * Devuelve ofertas activas (filtra por fecha si tienen fecha_inicio/fecha_fin)
   */
  getOfertasActivas(project_id) {
    const map = this.ofertasPerProject.get(project_id);
    if (!map) return [];

    const now = new Date();
    return Array.from(map.values()).filter(o => {
      if (!o.activa) return false;
      if (o.fecha_inicio && new Date(o.fecha_inicio) > now) return false;
      if (o.fecha_fin && new Date(o.fecha_fin) < now) return false;
      return true;
    });
  }

  // ==========================================
  // Resolve project (fallback al primero con config)
  // ==========================================

  resolveProject(projectId) {
    if (this.configPerProject.has(projectId)) return projectId;
    for (const [pid] of this.configPerProject) {
      return pid;
    }
    return projectId;
  }

  // ==========================================
  // UI Handlers
  // ==========================================

  async handleGetConfig(data) {
    const projectId = this.resolveProject(data?.project_id);
    const config = this.configPerProject.get(projectId) || this.defaultConfig();

    return {
      status: 200,
      data: {
        project_id: projectId,
        ...config
      }
    };
  }

  async handleUpdateConfig(data) {
    const { project_id, ...updates } = data || {};
    const projectId = this.resolveProject(project_id);

    let config = this.configPerProject.get(projectId);
    if (!config) {
      config = this.defaultConfig();
    }

    // Merge updates (shallow para campos directos, deep para tema/funcionalidades)
    if (updates.whatsapp_telefono !== undefined) config.whatsapp_telefono = updates.whatsapp_telefono;
    if (updates.nombre_negocio !== undefined) config.nombre_negocio = updates.nombre_negocio;
    if (updates.moneda !== undefined) config.moneda = updates.moneda;
    if (updates.mensaje_header !== undefined) config.mensaje_header = updates.mensaje_header;

    if (updates.tema && typeof updates.tema === 'object') {
      config.tema = { ...config.tema, ...updates.tema };
    }
    if (updates.funcionalidades && typeof updates.funcionalidades === 'object') {
      config.funcionalidades = { ...config.funcionalidades, ...updates.funcionalidades };
    }

    config.updated_at = new Date().toISOString();
    this.configPerProject.set(projectId, config);

    await this.saveConfig(projectId);

    this.logger.info('carta-digital.config.updated', {
      project_id: projectId,
      campos: Object.keys(updates)
    });

    return {
      status: 200,
      data: { project_id: projectId, ...config }
    };
  }

  async handleCreateSession(data) {
    const { project_id, user_agent, referrer } = data || {};
    const projectId = this.resolveProject(project_id);

    const session_id = `ses_${crypto.randomBytes(8).toString('hex')}`;
    const session = {
      session_id,
      project_id: projectId,
      started_at: new Date().toISOString(),
      user_agent: user_agent || null,
      referrer: referrer || null,
      productos_vistos: [],
      last_activity: new Date().toISOString()
    };

    this.sesionesActivas.set(session_id, session);
    this.metrics?.increment?.('carta-digital.sesion.total');
    this.metrics?.gauge?.('carta-digital.sesiones_activas.count', this.sesionesActivas.size);

    await this.eventBus.publish('carta-digital.sesion_creada', {
      project_id: projectId,
      session_id,
      started_at: session.started_at
    });

    this.logger.info('carta-digital.sesion.created', {
      project_id: projectId,
      session_id
    });

    return {
      status: 201,
      data: { session_id, project_id: projectId }
    };
  }

  async handleRegisterPedido(data) {
    const { project_id, session_id, items, total, notas } = data || {};
    const projectId = this.resolveProject(project_id);

    if (!items || items.length === 0) {
      return { status: 400, error: 'El pedido debe tener al menos un item' };
    }

    const pedido_id = `ped_cd_${crypto.randomBytes(6).toString('hex')}`;
    const pedido = {
      pedido_id,
      project_id: projectId,
      session_id: session_id || null,
      items,
      total: total || 0,
      notas: notas || '',
      estado: 'recibido',
      canal: 'carta-digital',
      created_at: new Date().toISOString()
    };

    this.pedidosRegistrados.set(pedido_id, pedido);
    this.metrics?.increment?.('carta-digital.pedido.total');

    await this.eventBus.publish('carta-digital.pedido_recibido', {
      project_id: projectId,
      pedido_id,
      items_count: items.length,
      total,
      canal: 'carta-digital',
      created_at: pedido.created_at
    });

    this.logger.info('carta-digital.pedido.registered', {
      project_id: projectId,
      pedido_id,
      items_count: items.length,
      total
    });

    return {
      status: 201,
      data: { pedido_id, estado: 'recibido' }
    };
  }

  async handleGetStats(data) {
    const projectId = this.resolveProject(data?.project_id);

    // Limpiar sesiones inactivas (más de 30 min)
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, session] of this.sesionesActivas) {
      if (new Date(session.last_activity).getTime() < cutoff) {
        this.sesionesActivas.delete(id);
      }
    }

    const sesionesProject = Array.from(this.sesionesActivas.values())
      .filter(s => s.project_id === projectId);

    const pedidosProject = Array.from(this.pedidosRegistrados.values())
      .filter(p => p.project_id === projectId);

    return {
      status: 200,
      data: {
        project_id: projectId,
        sesiones_activas: sesionesProject.length,
        total_sesiones: this.metrics?.getCounter?.('carta-digital.sesion.total') || 0,
        pedidos_hoy: pedidosProject.filter(p => {
          const hoy = new Date().toISOString().slice(0, 10);
          return p.created_at.startsWith(hoy);
        }).length,
        total_pedidos: pedidosProject.length
      }
    };
  }

  async handleHealthCheck() {
    return {
      status: 200,
      data: {
        module: this.name,
        version: this.version,
        status: 'healthy',
        proyectos_configurados: this.configPerProject.size,
        sesiones_activas: this.sesionesActivas.size
      }
    };
  }

  // ==========================================
  // Ofertas Handlers — CRUD
  // ==========================================

  async handleGetOfertas(data) {
    const projectId = this.resolveProject(data?.project_id);
    const includeInactive = data?.include_inactive === true;

    const map = this.ofertasPerProject.get(projectId);
    if (!map) {
      return { status: 200, data: { project_id: projectId, ofertas: [] } };
    }

    const ofertas = includeInactive
      ? Array.from(map.values())
      : this.getOfertasActivas(projectId);

    return {
      status: 200,
      data: {
        project_id: projectId,
        ofertas,
        total: ofertas.length
      }
    };
  }

  async handleCreateOferta(data) {
    const { project_id, nombre, descripcion, tipo, productos, precio_oferta, emoji, imagen, fecha_inicio, fecha_fin } = data || {};
    const projectId = this.resolveProject(project_id);

    if (!nombre || !productos || !Array.isArray(productos) || productos.length === 0) {
      return { status: 400, error: 'Se requiere nombre y al menos un producto' };
    }
    if (precio_oferta == null || precio_oferta < 0) {
      return { status: 400, error: 'Se requiere precio_oferta válido' };
    }

    const oferta_id = `oferta_${crypto.randomBytes(6).toString('hex')}`;

    // Calcular precio original sumando precios individuales de productos
    // (se hará en el frontend con los datos reales, aquí solo guardamos)
    const oferta = {
      id: oferta_id,
      nombre,
      descripcion: descripcion || '',
      tipo: tipo || 'combo',  // combo | descuento | 2x1 | especial
      productos,               // [{ id: "prod_x", qty: 1 }]
      precio_oferta,
      emoji: emoji || '🔥',
      imagen: imagen || null,
      activa: true,
      fecha_inicio: fecha_inicio || null,
      fecha_fin: fecha_fin || null,
      created_at: new Date().toISOString()
    };

    let map = this.ofertasPerProject.get(projectId);
    if (!map) {
      map = new Map();
      this.ofertasPerProject.set(projectId, map);
    }
    map.set(oferta_id, oferta);

    await this.saveOfertas(projectId);

    this.logger.info('carta-digital.oferta.created', {
      project_id: projectId,
      oferta_id,
      nombre,
      tipo: oferta.tipo,
      productos_count: productos.length
    });

    return { status: 201, data: oferta };
  }

  async handleUpdateOferta(data) {
    const { project_id, oferta_id, ...updates } = data || {};
    const projectId = this.resolveProject(project_id);

    if (!oferta_id) {
      return { status: 400, error: 'Se requiere oferta_id' };
    }

    const map = this.ofertasPerProject.get(projectId);
    if (!map || !map.has(oferta_id)) {
      return { status: 404, error: 'Oferta no encontrada' };
    }

    const oferta = map.get(oferta_id);
    const allowed = ['nombre', 'descripcion', 'tipo', 'productos', 'precio_oferta', 'emoji', 'imagen', 'activa', 'fecha_inicio', 'fecha_fin'];
    for (const key of allowed) {
      if (updates[key] !== undefined) oferta[key] = updates[key];
    }
    oferta.updated_at = new Date().toISOString();

    map.set(oferta_id, oferta);
    await this.saveOfertas(projectId);

    this.logger.info('carta-digital.oferta.updated', {
      project_id: projectId,
      oferta_id,
      campos: Object.keys(updates).filter(k => allowed.includes(k))
    });

    return { status: 200, data: oferta };
  }

  async handleDeleteOferta(data) {
    const { project_id, oferta_id } = data || {};
    const projectId = this.resolveProject(project_id);

    if (!oferta_id) {
      return { status: 400, error: 'Se requiere oferta_id' };
    }

    const map = this.ofertasPerProject.get(projectId);
    if (!map || !map.has(oferta_id)) {
      return { status: 404, error: 'Oferta no encontrada' };
    }

    map.delete(oferta_id);
    await this.saveOfertas(projectId);

    this.logger.info('carta-digital.oferta.deleted', { project_id: projectId, oferta_id });

    return { status: 200, data: { oferta_id, deleted: true } };
  }

  // ==========================================
  // Funnel Tracking
  // ==========================================

  /**
   * Recibe eventos de tracking desde la PWA.
   * Eventos válidos del funnel:
   *   page_view    — usuario abre la carta
   *   product_view — usuario ve detalle de un producto
   *   add_to_cart  — usuario añade producto al carrito
   *   order_sent   — usuario envía pedido por WhatsApp
   *   chat_open    — usuario abre el chat AI
   *
   * Request: { project_id?, session_id?, event, product_id?, data? }
   */
  async handleTrackEvent(data) {
    const { project_id, session_id, event, product_id, data: eventData } = data || {};
    const projectId = this.resolveProject(project_id);

    const VALID_EVENTS = ['page_view', 'product_view', 'add_to_cart', 'order_sent', 'chat_open'];
    if (!event || !VALID_EVENTS.includes(event)) {
      return { status: 400, error: `Evento inválido. Válidos: ${VALID_EVENTS.join(', ')}` };
    }

    const funnelEvent = {
      event,
      project_id: projectId,
      session_id: session_id || null,
      product_id: product_id || null,
      data: eventData || null,
      timestamp: new Date().toISOString()
    };

    // Store in memory (capped per project)
    let events = this.funnelEvents.get(projectId);
    if (!events) {
      events = [];
      this.funnelEvents.set(projectId, events);
    }
    events.push(funnelEvent);

    // Cap at 10000 events per project (FIFO)
    if (events.length > 10000) {
      events.splice(0, events.length - 10000);
    }

    // Update session if exists
    if (session_id && this.sesionesActivas.has(session_id)) {
      const session = this.sesionesActivas.get(session_id);
      session.last_activity = new Date().toISOString();
      if (event === 'product_view' && product_id) {
        if (!session.productos_vistos.includes(product_id)) {
          session.productos_vistos.push(product_id);
        }
      }
    }

    // Increment metrics
    this.metrics?.increment?.(`carta-digital.${event}.total`);

    return { status: 200, data: { tracked: true } };
  }

  /**
   * Devuelve análisis del funnel de conversión.
   * Filtra por día (default: hoy).
   *
   * Request: { project_id?, date? }
   * Response: { funnel: { page_view, product_view, add_to_cart, order_sent },
   *             conversion_rates: {...}, top_products: [...] }
   */
  async handleGetFunnel(data) {
    const projectId = this.resolveProject(data?.project_id);
    const targetDate = data?.date || new Date().toISOString().slice(0, 10);

    const events = (this.funnelEvents.get(projectId) || [])
      .filter(e => e.timestamp.startsWith(targetDate));

    // Count by event type
    const counts = { page_view: 0, product_view: 0, add_to_cart: 0, order_sent: 0, chat_open: 0 };
    const productViews = {};   // product_id -> count
    const productCarts = {};   // product_id -> count
    const uniqueSessions = { page_view: new Set(), product_view: new Set(), add_to_cart: new Set(), order_sent: new Set() };

    for (const e of events) {
      if (counts[e.event] !== undefined) {
        counts[e.event]++;
        if (e.session_id) uniqueSessions[e.event]?.add(e.session_id);
      }
      if (e.event === 'product_view' && e.product_id) {
        productViews[e.product_id] = (productViews[e.product_id] || 0) + 1;
      }
      if (e.event === 'add_to_cart' && e.product_id) {
        productCarts[e.product_id] = (productCarts[e.product_id] || 0) + 1;
      }
    }

    // Conversion rates
    const rates = {
      view_to_detail: counts.page_view > 0
        ? ((counts.product_view / counts.page_view) * 100).toFixed(1) + '%'
        : '0%',
      detail_to_cart: counts.product_view > 0
        ? ((counts.add_to_cart / counts.product_view) * 100).toFixed(1) + '%'
        : '0%',
      cart_to_order: counts.add_to_cart > 0
        ? ((counts.order_sent / counts.add_to_cart) * 100).toFixed(1) + '%'
        : '0%',
      overall: counts.page_view > 0
        ? ((counts.order_sent / counts.page_view) * 100).toFixed(1) + '%'
        : '0%'
    };

    // Top viewed products
    const topViewed = Object.entries(productViews)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, views]) => ({ product_id: id, views, cart_adds: productCarts[id] || 0 }));

    return {
      status: 200,
      data: {
        project_id: projectId,
        date: targetDate,
        funnel: counts,
        unique_sessions: {
          page_view: uniqueSessions.page_view.size,
          product_view: uniqueSessions.product_view.size,
          add_to_cart: uniqueSessions.add_to_cart.size,
          order_sent: uniqueSessions.order_sent.size
        },
        conversion_rates: rates,
        top_products: topViewed,
        total_events: events.length
      }
    };
  }

  // ==========================================
  // Reseñas persistence
  // ==========================================

  async loadResenas(project_id) {
    const storagePath = this.projectPaths.get(project_id);
    if (!storagePath) throw new Error('No storage path for project');

    const resenasPath = path.join(storagePath, 'carta-digital-resenas.json');
    const raw = await fs.readFile(resenasPath, 'utf8');
    this.resenasPerProject.set(project_id, JSON.parse(raw));
  }

  async saveResenas(project_id) {
    const storagePath = this.projectPaths.get(project_id);
    if (!storagePath) return;

    const resenasPath = path.join(storagePath, 'carta-digital-resenas.json');
    const resenas = this.resenasPerProject.get(project_id);
    if (!resenas) return;

    try {
      await fs.mkdir(storagePath, { recursive: true });
      await fs.writeFile(resenasPath, JSON.stringify(resenas, null, 2), 'utf-8');
      this.logger.info('carta-digital.resenas.saved', { project_id });
    } catch (err) {
      this.logger.error('carta-digital.resenas.save_failed', { project_id, error: err.message });
    }
  }

  // ==========================================
  // Reseñas Handlers
  // ==========================================

  /**
   * Devuelve las reseñas aprobadas, ordenadas por fecha.
   * Incluye resumen: media de estrellas, total, distribución.
   *
   * Request: { project_id?, limit?, offset? }
   */
  async handleGetResenas(data) {
    const projectId = this.resolveProject(data?.project_id);
    const limit = data?.limit || 50;
    const offset = data?.offset || 0;

    const all = (this.resenasPerProject.get(projectId) || [])
      .filter(r => r.aprobada !== false);

    // Summary
    const total = all.length;
    const avgRating = total > 0
      ? parseFloat((all.reduce((s, r) => s + r.rating, 0) / total).toFixed(1))
      : 0;

    const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    for (const r of all) {
      if (distribution[r.rating] !== undefined) distribution[r.rating]++;
    }

    // Paginate (newest first)
    const sorted = all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const page = sorted.slice(offset, offset + limit);

    return {
      status: 200,
      data: {
        project_id: projectId,
        resenas: page,
        summary: { total, avg_rating: avgRating, distribution },
        pagination: { offset, limit, has_more: offset + limit < total }
      }
    };
  }

  /**
   * Crea una nueva reseña.
   * Anti-spam: max 1 reseña por session_id.
   *
   * Request: { project_id?, session_id, nombre, rating (1-5), comentario?, producto_id? }
   */
  async handleCreateResena(data) {
    const { project_id, session_id, nombre, rating, comentario, producto_id } = data || {};
    const projectId = this.resolveProject(project_id);

    if (!nombre || typeof nombre !== 'string' || nombre.trim().length === 0) {
      return { status: 400, error: 'Se requiere un nombre' };
    }
    if (!rating || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      return { status: 400, error: 'Rating debe ser un entero entre 1 y 5' };
    }

    let resenas = this.resenasPerProject.get(projectId);
    if (!resenas) {
      resenas = [];
      this.resenasPerProject.set(projectId, resenas);
    }

    // Anti-spam: una reseña por session
    if (session_id) {
      const existing = resenas.find(r => r.session_id === session_id);
      if (existing) {
        return { status: 409, error: 'Ya has dejado una reseña. ¡Gracias!' };
      }
    }

    const resena_id = `res_${crypto.randomBytes(6).toString('hex')}`;
    const resena = {
      id: resena_id,
      nombre: nombre.trim().slice(0, 50),
      rating,
      comentario: comentario ? comentario.trim().slice(0, 500) : '',
      producto_id: producto_id || null,
      session_id: session_id || null,
      aprobada: true,  // auto-approve (puede cambiar a moderación)
      created_at: new Date().toISOString()
    };

    resenas.push(resena);

    // Cap at 1000 reviews per project
    if (resenas.length > 1000) {
      resenas.splice(0, resenas.length - 1000);
    }

    await this.saveResenas(projectId);
    this.metrics?.increment?.('carta-digital.resena.total');

    this.logger.info('carta-digital.resena.created', {
      project_id: projectId,
      resena_id,
      rating
    });

    return { status: 201, data: resena };
  }

  // ==========================================
  // Media Serving — HTTP endpoint for images
  // ==========================================

  /**
   * Sirve archivos estáticos (imágenes) desde el storage del proyecto.
   * Ruta: GET /modules/carta-digital/media/*
   *
   * El path del archivo se pasa como parámetro de query o en la ruta.
   * Solo sirve archivos de imagen permitidos.
   * Soporta Cache-Control y Content-Type apropiado.
   */
  async handleServeMedia(req, context) {
    // Extract file path from URL: /modules/carta-digital/media/pizzepos/preprocesadas/img.jpg
    const url = req?.url || context?.url || '';
    const mediaPrefix = '/modules/carta-digital/media/';
    let relativePath = '';

    if (url.includes(mediaPrefix)) {
      relativePath = decodeURIComponent(url.split(mediaPrefix)[1] || '');
    } else if (req?.params?.path) {
      relativePath = req.params.path;
    } else if (context?.path) {
      relativePath = context.path;
    }

    if (!relativePath) {
      return { status: 400, error: 'Se requiere ruta del archivo' };
    }

    // Security: prevent directory traversal
    const normalized = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
    if (normalized.includes('..')) {
      return { status: 403, error: 'Ruta no permitida' };
    }

    // Allowed extensions
    const ext = path.extname(normalized).toLowerCase();
    const MIME_TYPES = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };

    const contentType = MIME_TYPES[ext];
    if (!contentType) {
      return { status: 415, error: `Tipo de archivo no soportado: ${ext}` };
    }

    // Resolve to project storage — try each project path
    let absolutePath = null;
    for (const [, storagePath] of this.projectPaths) {
      const candidate = path.join(storagePath, '..', normalized);
      try {
        await fs.access(candidate);
        absolutePath = candidate;
        break;
      } catch {}
    }

    // Fallback: try from cwd/storage
    if (!absolutePath) {
      const fallback = path.join(process.cwd(), 'storage', normalized);
      try {
        await fs.access(fallback);
        absolutePath = fallback;
      } catch {}
    }

    if (!absolutePath) {
      return { status: 404, error: 'Archivo no encontrado' };
    }

    try {
      const data = await fs.readFile(absolutePath);

      return {
        status: 200,
        body: data,
        headers: {
          'Content-Type': contentType,
          'Content-Length': data.length.toString(),
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*'
        }
      };
    } catch (err) {
      this.logger.error('carta-digital.media.read_failed', {
        path: relativePath,
        error: err.message
      });
      return { status: 500, error: 'Error leyendo archivo' };
    }
  }

  /**
   * Devuelve la carta completa con datos enriquecidos para la carta digital.
   * Combina datos de productos (via carta_completa) con la carta JSON original
   * que contiene descripciones, emojis e imágenes enriquecidas.
   */
  async handleCartaDigitalCompleta(data) {
    const projectId = this.resolveProject(data?.project_id);
    const cartaId = data?.carta_id;

    // Load carta JSON from disk (contains enriched data)
    const storagePath = this.projectPaths.get(projectId);
    if (!storagePath) {
      return { status: 404, error: 'Proyecto no encontrado' };
    }

    const cartasDir = path.join(storagePath, 'cartas');

    try {
      // If specific carta_id provided, load that one
      if (cartaId) {
        const cartaPath = path.join(cartasDir, `${cartaId}.json`);
        const raw = await fs.readFile(cartaPath, 'utf8');
        const carta = JSON.parse(raw);
        return this.formatCartaDigitalResponse(carta, projectId);
      }

      // Otherwise, find the first carta available
      const files = await fs.readdir(cartasDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      if (jsonFiles.length === 0) {
        return { status: 404, error: 'No hay cartas disponibles' };
      }

      const raw = await fs.readFile(path.join(cartasDir, jsonFiles[0]), 'utf8');
      const carta = JSON.parse(raw);
      return this.formatCartaDigitalResponse(carta, projectId);
    } catch (err) {
      this.logger.error('carta-digital.carta_completa.error', {
        project_id: projectId,
        error: err.message
      });
      return { status: 500, error: 'Error cargando carta' };
    }
  }

  /**
   * Formatea la carta para la respuesta de carta digital,
   * añadiendo URLs de media resueltas.
   */
  formatCartaDigitalResponse(carta, projectId) {
    const config = this.configPerProject.get(projectId) || this.defaultConfig();

    // Map products with resolved image URLs
    const productos = (carta.productos || []).map(p => ({
      id: p.id,
      nombre: p.nombre,
      categoria: p.categoria,
      precio: p.precio,
      descripcion: p.descripcion || null,
      emoji: p.emoji || null,
      tags: p.tags || [],
      imagen: p.imagen ? this.resolveMediaUrl(p.imagen) : null,
      ingredientes: (p.ingredientes || []).map(ing => ({
        nombre: ing.nombre,
        emoji: ing.emoji || null,
        tipo: ing.tipo || null,
        precio_extra: ing.precio_extra ?? null
      })),
      tiene_variaciones: (p.ingredientes && p.ingredientes.length > 0)
    }));

    const categorias = (carta.categorias || []).map(c => ({
      id: c.id,
      nombre: c.nombre,
      orden: c.orden,
      icon: c.icon || null,
      imagen: c.imagen ? this.resolveMediaUrl(c.imagen) : null
    }));

    // Include active ofertas
    const ofertas = this.getOfertasActivas(projectId);

    // Include recent reviews (last 20, approved)
    const allResenas = (this.resenasPerProject.get(projectId) || [])
      .filter(r => r.aprobada !== false);
    const resenasRecent = allResenas
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 20);
    const avgRating = allResenas.length > 0
      ? parseFloat((allResenas.reduce((s, r) => s + r.rating, 0) / allResenas.length).toFixed(1))
      : 0;

    return {
      status: 200,
      data: {
        project_id: projectId,
        carta_id: carta.meta?.id,
        nombre: carta.meta?.nombre || config.nombre_negocio,
        config: {
          whatsapp_telefono: config.whatsapp_telefono,
          nombre_negocio: config.nombre_negocio,
          moneda: config.moneda,
          mensaje_header: config.mensaje_header,
          tema: config.tema
        },
        categorias,
        productos,
        ofertas,
        resenas: { items: resenasRecent, total: allResenas.length, avg_rating: avgRating },
        total_categorias: categorias.length,
        total_productos: productos.length,
        total_ofertas: ofertas.length,
        enrichment: carta.meta?.enrichment || null
      }
    };
  }

  /**
   * Resuelve una ruta de imagen relativa al storage a una URL de media serving.
   * Ejemplo: "/pizzepos/preprocesadas/prod_country.jpg"
   *   → "/modules/carta-digital/media/pizzepos/preprocesadas/prod_country.jpg"
   */
  resolveMediaUrl(imagePath) {
    if (!imagePath) return null;
    // If already a full URL, return as-is
    if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) return imagePath;
    // If already points to media endpoint, return as-is
    if (imagePath.startsWith('/modules/carta-digital/media/')) return imagePath;
    // Resolve relative storage path to media URL
    const clean = imagePath.replace(/^\/+/, '');
    return `/modules/carta-digital/media/${clean}`;
  }

  // ==========================================
  // Static Export — generate deployable static site
  // ==========================================

  /**
   * Genera un sitio estático auto-contenido de la carta digital.
   * Produce: index.html, sw.js, manifest.json en un directorio de output.
   *
   * El HTML tiene todos los datos, CSS y JS inline — no necesita backend.
   * Listo para desplegar en GitHub Pages, Netlify, o cualquier hosting estático.
   */
  async handleExportStatic(data) {
    const projectId = this.resolveProject(data?.project_id);
    const cartaId = data?.carta_id;

    const storagePath = this.projectPaths.get(projectId);
    if (!storagePath) {
      return { status: 404, error: 'Proyecto no encontrado' };
    }

    // Load carta
    const cartasDir = path.join(storagePath, 'cartas');
    let carta;
    try {
      if (cartaId) {
        const raw = await fs.readFile(path.join(cartasDir, `${cartaId}.json`), 'utf8');
        carta = JSON.parse(raw);
      } else {
        const files = (await fs.readdir(cartasDir)).filter(f => f.endsWith('.json'));
        if (files.length === 0) return { status: 404, error: 'No hay cartas disponibles' };
        const raw = await fs.readFile(path.join(cartasDir, files[0]), 'utf8');
        carta = JSON.parse(raw);
      }
    } catch (err) {
      return { status: 500, error: `Error leyendo carta: ${err.message}` };
    }

    const config = this.configPerProject.get(projectId) || this.defaultConfig();
    const tema = config.tema || {};

    // Copy images: resolve relative paths to actual file contents
    // For static export, images need to be relative paths in the output dir
    const imagesToCopy = [];
    for (const p of carta.productos) {
      if (p.imagen && !p.imagen.startsWith('http')) {
        const clean = p.imagen.replace(/^\/+/, '');
        const srcPath = path.join(storagePath, '..', clean);
        try {
          await fs.access(srcPath);
          const destName = 'img/' + path.basename(clean);
          imagesToCopy.push({ src: srcPath, dest: destName });
          p.imagen = destName;
        } catch {
          // Image not found, clear reference
          p.imagen = null;
        }
      }
    }

    // Include active ofertas in carta for static export
    const ofertas = this.getOfertasActivas(projectId);
    carta.ofertas = ofertas;

    // Include recent reviews
    const allResenas = (this.resenasPerProject.get(projectId) || [])
      .filter(r => r.aprobada !== false);
    carta.resenas = allResenas
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 20);
    carta.resenas_avg = allResenas.length > 0
      ? parseFloat((allResenas.reduce((s, r) => s + r.rating, 0) / allResenas.length).toFixed(1))
      : 0;
    carta.resenas_total = allResenas.length;

    // Generate static files
    const { generateStaticHTML, generateServiceWorker, generateManifest, generateIcon, slugify } = require('./static-template');

    const html = generateStaticHTML(carta, config);
    const sw = generateServiceWorker(config.nombre_negocio);
    const manifest = generateManifest(
      config.nombre_negocio,
      tema.color_primario,
      tema.color_fondo
    );

    // Output directory
    const slug = slugify(config.nombre_negocio);
    const outputDir = path.join(storagePath, 'carta-static', slug);
    const imgDir = path.join(outputDir, 'img');

    try {
      await fs.mkdir(imgDir, { recursive: true });
      await fs.writeFile(path.join(outputDir, 'index.html'), html, 'utf8');
      await fs.writeFile(path.join(outputDir, 'sw.js'), sw, 'utf8');
      await fs.writeFile(path.join(outputDir, 'manifest.json'), manifest, 'utf8');

      // Generate PWA icons (SVG — no dependencies needed)
      const logoEmoji = tema.logo_emoji || '\u{1F355}';
      await fs.writeFile(path.join(outputDir, 'icon-192.svg'),
        generateIcon(192, logoEmoji, tema.color_primario, tema.color_fondo), 'utf8');
      await fs.writeFile(path.join(outputDir, 'icon-512.svg'),
        generateIcon(512, logoEmoji, tema.color_primario, tema.color_fondo), 'utf8');

      // Copy images
      let imagesCopied = 0;
      for (const img of imagesToCopy) {
        try {
          const data = await fs.readFile(img.src);
          await fs.writeFile(path.join(outputDir, img.dest), data);
          imagesCopied++;
        } catch (err) {
          this.logger.warn('carta-digital.export.image_failed', {
            src: img.src, error: err.message
          });
        }
      }

      this.logger.info('carta-digital.export.completed', {
        project_id: projectId,
        output_dir: outputDir,
        productos: carta.productos.length,
        images: imagesCopied
      });

      return {
        status: 200,
        data: {
          output_dir: outputDir,
          files: ['index.html', 'sw.js', 'manifest.json'],
          productos: carta.productos.length,
          categorias: carta.categorias.length,
          images_copied: imagesCopied,
          message: `Carta estática generada en ${outputDir}. Lista para desplegar en GitHub Pages o cualquier hosting estático.`,
          deploy_instructions: {
            github_pages: [
              `1. Crear repositorio en GitHub (ej: ${slug})`,
              `2. Copiar contenido de ${outputDir} al repositorio`,
              `3. Activar GitHub Pages en Settings > Pages > Source: main`,
              `4. La carta estará en https://tu-usuario.github.io/${slug}/`
            ],
            netlify: [
              `1. Arrastrar la carpeta ${outputDir} a app.netlify.com/drop`,
              `2. Recibirás un URL con HTTPS automáticamente`
            ]
          }
        }
      };
    } catch (err) {
      this.logger.error('carta-digital.export.failed', {
        project_id: projectId,
        error: err.message
      });
      return { status: 500, error: `Error generando export: ${err.message}` };
    }
  }

  /**
   * Deploy Cloudflare Worker as AI chat proxy for the carta digital.
   *
   * Resolves credentials from credential-manager (CLOUDFLARE + DEEPSEEK),
   * generates system prompt from carta data, and deploys via wrangler.
   *
   * Request: { project_id?, carta_id?, allowed_origin?, max_tokens?, worker_name?, dry_run? }
   */
  async handleDeployCFWorker(data) {
    const projectId = this.resolveProject(data?.project_id);

    this.logger.info('carta-digital.deploy-cf-worker.start', { projectId });

    const storagePath = this.projectPaths.get(projectId);
    if (!storagePath) {
      return { status: 404, error: 'Proyecto no encontrado' };
    }

    // Step 1: Resolve Cloudflare credential via credential-manager
    let cfToken = null;
    try {
      const resolveResult = await this.eventBus.request('credential.resolve.request', {
        provider: 'CLOUDFLARE',
        projectId,
        timeout: 5000
      });
      if (resolveResult?.found) {
        cfToken = resolveResult.apiKey;
      }
    } catch {
      // Fallback to environment
      cfToken = process.env[`CLOUDFLARE_API_KEY_PROJECT_${projectId}`]
             || process.env.CLOUDFLARE_API_KEY_GLOBAL
             || process.env.CLOUDFLARE_API_TOKEN
             || null;
    }

    if (!cfToken) {
      return {
        status: 400,
        error: 'No se encontró credencial de Cloudflare. Configura CLOUDFLARE en el Credential Manager (nivel GLOBAL o PROJECT).'
      };
    }

    // Step 2: Resolve DeepSeek credential
    let deepseekKey = null;
    try {
      const resolveResult = await this.eventBus.request('credential.resolve.request', {
        provider: 'DEEPSEEK',
        projectId,
        timeout: 5000
      });
      if (resolveResult?.found) {
        deepseekKey = resolveResult.apiKey;
      }
    } catch {
      deepseekKey = process.env[`DEEPSEEK_API_KEY_PROJECT_${projectId}`]
                 || process.env.DEEPSEEK_API_KEY_GLOBAL
                 || process.env.DEEPSEEK_API_KEY
                 || null;
    }

    if (!deepseekKey) {
      return {
        status: 400,
        error: 'No se encontró credencial de DeepSeek. Configura DEEPSEEK en el Credential Manager.'
      };
    }

    // Step 3: Load carta for system prompt
    const cartasDir = path.join(storagePath, 'cartas');
    let carta;
    try {
      const cartaId = data?.carta_id;
      if (cartaId) {
        const raw = await fs.readFile(path.join(cartasDir, `${cartaId}.json`), 'utf8');
        carta = JSON.parse(raw);
      } else {
        const files = (await fs.readdir(cartasDir)).filter(f => f.endsWith('.json'));
        if (files.length === 0) return { status: 404, error: 'No hay cartas disponibles' };
        const raw = await fs.readFile(path.join(cartasDir, files[0]), 'utf8');
        carta = JSON.parse(raw);
      }
    } catch (err) {
      return { status: 500, error: `Error leyendo carta: ${err.message}` };
    }

    // Step 4: Build system prompt
    const config = this.configPerProject.get(projectId) || this.defaultConfig();
    const nombre = config.nombre_negocio || 'Restaurante';
    const moneda = config.moneda || '€';

    const menuResumen = (carta.productos || []).map(p => {
      const ings = (p.ingredientes || []).map(i => i.nombre).join(', ');
      const tags = (p.tags || []).join(', ');
      return `- ${p.nombre}: ${p.precio.toFixed(2)}${moneda}${ings ? ' (' + ings + ')' : ''}${tags ? ' [' + tags + ']' : ''}`;
    }).join('\n');

    const systemPrompt =
      `Eres el asistente virtual de ${nombre}. Ayudas a los clientes a elegir y hacer su pedido.\n\n` +
      `REGLAS:\n` +
      `- Responde SIEMPRE en español, breve y amable (max 2-3 frases)\n` +
      `- Recomienda platos segun preferencias del cliente\n` +
      `- Si el cliente quiere pedir, confirma los items y cantidades\n` +
      `- Cuando el pedido este listo, responde con un JSON al final: {"pedido":[{"id":"ID","nombre":"NOMBRE","qty":N}]}\n` +
      `- Si no sabes algo, di que el cliente puede contactar por WhatsApp\n` +
      `- NO inventes productos que no estan en el menu\n\n` +
      `MENU DE ${nombre.toUpperCase()}:\n${menuResumen}`;

    // Step 5: Execute deploy
    const allowedOrigin = data?.allowed_origin || '*';
    const maxTokens = String(data?.max_tokens || 300);
    const workerName = data?.worker_name || `${require('./static-template').slugify(nombre)}-chat`;
    const dryRun = data?.dry_run === true;

    const workerDir = path.join(__dirname, 'cf-worker');
    const { execSync } = require('child_process');

    try {
      // Update wrangler.toml with worker name and vars
      const tomlPath = path.join(workerDir, 'wrangler.toml');
      const tomlContent = `name = "${workerName}"\nmain = "worker.js"\ncompatibility_date = "2024-01-01"\n\n[vars]\nALLOWED_ORIGIN = "${allowedOrigin}"\nMAX_TOKENS = "${maxTokens}"\n`;
      await fs.writeFile(tomlPath, tomlContent, 'utf8');

      if (dryRun) {
        this.logger.info('carta-digital.deploy-cf-worker.dry-run', { projectId, workerName });
        return {
          status: 200,
          data: {
            dry_run: true,
            worker_name: workerName,
            allowed_origin: allowedOrigin,
            max_tokens: maxTokens,
            system_prompt_length: systemPrompt.length,
            productos: (carta.productos || []).length,
            message: 'Dry run — todo listo para desplegar. Ejecuta sin dry_run para deploy real.'
          }
        };
      }

      const execOpts = {
        cwd: workerDir,
        env: { ...process.env, CLOUDFLARE_API_TOKEN: cfToken },
        encoding: 'utf8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe']
      };

      // Deploy worker code
      const deployOutput = execSync('wrangler deploy', execOpts);

      // Set secrets
      execSync('wrangler secret put DEEPSEEK_API_KEY', { ...execOpts, input: deepseekKey });
      execSync('wrangler secret put SYSTEM_PROMPT', { ...execOpts, input: systemPrompt });

      // Extract worker URL from deploy output
      const urlMatch = deployOutput.match(/https:\/\/[^\s]+\.workers\.dev/);
      const workerUrl = urlMatch ? urlMatch[0] : `https://${workerName}.workers.dev`;

      this.logger.info('carta-digital.deploy-cf-worker.success', {
        projectId,
        workerName,
        workerUrl
      });

      return {
        status: 200,
        data: {
          success: true,
          worker_name: workerName,
          worker_url: workerUrl,
          allowed_origin: allowedOrigin,
          max_tokens: maxTokens,
          productos: (carta.productos || []).length,
          message: `Worker desplegado en ${workerUrl}`,
          pwa_config: {
            ai_endpoint: workerUrl,
            ai_chat_path: '/chat'
          }
        }
      };
    } catch (err) {
      const errorMsg = err.stderr || err.message || String(err);
      this.logger.error('carta-digital.deploy-cf-worker.failed', {
        projectId,
        error: errorMsg
      });
      return {
        status: 500,
        error: `Error desplegando Worker: ${errorMsg}`
      };
    }
  }
}

module.exports = CartaDigitalModule;
