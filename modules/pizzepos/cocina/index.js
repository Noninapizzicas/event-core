/**
 * Módulo Cocina v2.2
 * Display de cocina en tiempo real con tracking item a item
 * Estados item: pendiente → preparando → listo
 *
 * Multi-dispositivo:
 *   - Cada dispositivo se registra con register-device y recibe un color único
 *   - Cada dispositivo puede filtrar por familias/categorías (client-side)
 *   - Al preparar un item, se registra device_id → color en el item
 *   - Todos los dispositivos ven el pedido completo para coordinación
 *
 * Alineado con patrones event-core: uiHandler, event envelope, cleanup
 */

class CocinaModule {
  constructor() {
    this.name = 'cocina';
    this.version = '2.2.0';

    // Dependencias (inyectadas en onLoad)
    this.eventBus = null;
    this.logger = null;
    this.metrics = null;
    this.uiHandler = null;
    this.validator = null;

    // Estado en memoria
    this.pedidosActivos = new Map(); // pedido_id -> pedido_cocina
    this.historial = []; // últimos 50 pedidos completados
    this.maxHistorial = 50;

    // Rolling average tiempos preparación (últimos 100)
    this.tiemposPreparacion = [];

    // Dispositivos de cocina registrados: device_id -> { nombre, color, filtros, connected_at, last_seen }
    this.devices = new Map();

    // Paleta de colores para dispositivos (alta visibilidad sobre fondo oscuro)
    this.DEVICE_COLORS = [
      '#3b82f6', // blue
      '#f97316', // orange
      '#a855f7', // purple
      '#14b8a6', // teal
      '#f43f5e', // rose
      '#84cc16', // lime
      '#06b6d4', // cyan
      '#e879f9', // fuchsia
    ];
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(core) {
    this.logger = core.logger;
    this.metrics = core.metrics;
    this.eventBus = core.eventBus;
    this.uiHandler = core.uiHandler;
    this.validator = core.validationManager || null;

    this.logger.info('module.loading', { module: this.name, version: this.version });

    // Registrar schemas de validación
    this.registerSchemas();

    // Event subscriptions are auto-wired from module.json by the loader.
    this.registerUIHandlers();

    // Restaurar pedidos activos en cocina desde persistencia
    await this.restaurarDesdeArchivo();

    this.logger.info('module.loaded', { module: this.name, version: this.version });
  }

  async onUnload() {
    this.logger.info('module.unloading', { module: this.name });

    // Desregistrar UI handlers
    if (this.uiHandler) {
      const actions = [
        'list-active', 'get', 'history', 'prepare-item',
        'mark-ready', 'health', 'metrics',
        'register-device', 'unregister-device', 'list-devices'
      ];
      for (const action of actions) {
        this.uiHandler.unregister('cocina', action);
      }
    }

    // Limpiar estado
    this.pedidosActivos.clear();
    this.historial = [];
    this.tiemposPreparacion = [];
    this.devices.clear();

    this.logger.info('module.unloaded', { module: this.name });
  }

  // ==========================================
  // Validation Schemas
  // ==========================================

  registerSchemas() {
    if (!this.validator) return;

    this.validator.registerSchema('cocina.register-device', {
      type: 'object',
      required: ['device_id'],
      properties: {
        device_id: { type: 'string', minLength: 1 },
        nombre: { type: 'string' },
        filtros: {
          type: 'object',
          properties: {
            familias: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    });

    this.validator.registerSchema('cocina.prepare-item', {
      type: 'object',
      required: ['item_id'],
      properties: {
        item_id: { type: 'string', minLength: 1 },
        device_id: { type: 'string' }
      }
    });

    this.validator.registerSchema('cocina.mark-ready', {
      type: 'object',
      required: ['pedido_id'],
      properties: {
        pedido_id: { type: 'string', minLength: 1 }
      }
    });

    this.validator.registerSchema('cocina.get', {
      type: 'object',
      required: ['pedido_id'],
      properties: {
        pedido_id: { type: 'string', minLength: 1 }
      }
    });

    this.logger.info('cocina.schemas.registered', { count: 4 });
  }

  validateInput(schemaId, data) {
    if (!this.validator) return null;
    const result = this.validator.validate(schemaId, data);
    if (!result.valid) {
      return { status: 400, error: 'Validación fallida', validation_errors: result.errors };
    }
    return null;
  }

  // ==========================================
  // UI Handler Registration
  // ==========================================

  registerUIHandlers() {
    if (!this.uiHandler) {
      this.logger.warn('cocina.uiHandler.not_available', { module: this.name });
      return;
    }

    this.uiHandler.register('cocina', 'list-active', this.handleGetActivos.bind(this));
    this.uiHandler.register('cocina', 'get', this.handleGetPedido.bind(this));
    this.uiHandler.register('cocina', 'history', this.handleGetHistorial.bind(this));
    this.uiHandler.register('cocina', 'prepare-item', this.handlePrepararItem.bind(this));
    this.uiHandler.register('cocina', 'mark-ready', this.handleMarcarListo.bind(this));
    this.uiHandler.register('cocina', 'health', this.handleHealthCheck.bind(this));
    this.uiHandler.register('cocina', 'metrics', this.handleGetMetrics.bind(this));
    this.uiHandler.register('cocina', 'register-device', this.handleRegisterDevice.bind(this));
    this.uiHandler.register('cocina', 'unregister-device', this.handleUnregisterDevice.bind(this));
    this.uiHandler.register('cocina', 'list-devices', this.handleListDevices.bind(this));

    this.logger.info('cocina.ui_handlers.registered', {
      handlers: ['list-active', 'get', 'history', 'prepare-item', 'mark-ready', 'health', 'metrics', 'register-device', 'unregister-device', 'list-devices']
    });
  }

  // ==========================================
  // Event Handlers (auto-wired from module.json)
  // ==========================================

  async onPedidoEnviadoCocina(event) {
    const data = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;
    const { pedido_id, items, cuenta_id, canal, notas_generales, metadata } = data;

    this.logger.info('cocina.pedido.recibido', {
      correlation_id: correlationId,
      pedido_id,
      canal: canal || 'directo',
      items_count: items?.length || 0
    });

    const pedidoCocina = {
      pedido_id,
      cuenta_id,
      canal: canal || null,
      items: (items || []).map(item => {
        const cocinaItem = {
          item_id: item.item_id,
          producto_id: item.producto_id,
          nombre: item.nombre,
          categoria: item.categoria || null,
          cantidad: item.cantidad,
          variaciones: item.variaciones || null,
          notas: item.notas || '',
          estado: 'pendiente'
        };
        // Metadata especial: mitad-mitad, al gusto, ingredientes_base, etc.
        if (item.tipo) cocinaItem.tipo = item.tipo;
        if (item.pizza_izquierda) cocinaItem.pizza_izquierda = item.pizza_izquierda;
        if (item.pizza_derecha) cocinaItem.pizza_derecha = item.pizza_derecha;
        if (item.ingredientes) cocinaItem.ingredientes = item.ingredientes;
        if (item.ingredientes_base) cocinaItem.ingredientes_base = item.ingredientes_base;
        return cocinaItem;
      }),
      estado: 'activo',
      notas_generales: notas_generales || '',
      recibido_at: new Date().toISOString(),
      metadata: metadata || null
    };

    this.pedidosActivos.set(pedido_id, pedidoCocina);

    this.metrics?.increment?.('cocina.pedido_recibido.total');
    this.metrics?.gauge?.('cocina.pedidos_activos.count', this.pedidosActivos.size);
  }

  async onPedidoCancelado(event) {
    const data = event?.data || event?.payload || event;
    const { pedido_id } = data;

    if (!this.pedidosActivos.has(pedido_id)) return;

    this.pedidosActivos.delete(pedido_id);

    this.metrics?.increment?.('cocina.pedido_cancelado.total');
    this.metrics?.gauge?.('cocina.pedidos_activos.count', this.pedidosActivos.size);

    this.logger.info('cocina.pedido.cancelado', { pedido_id });
  }

  // ==========================================
  // UI Handlers (MQTT Request/Response)
  // ==========================================

  async handleGetActivos() {
    const activos = Array.from(this.pedidosActivos.values());
    activos.sort((a, b) => new Date(a.recibido_at) - new Date(b.recibido_at));

    let itemsPendientes = 0;
    let itemsPreparando = 0;
    for (const p of activos) {
      for (const i of p.items) {
        if (i.estado === 'pendiente') itemsPendientes++;
        else if (i.estado === 'preparando') itemsPreparando++;
      }
    }

    return {
      status: 200,
      data: { pedidos: activos, total: activos.length, items_pendientes: itemsPendientes, items_preparando: itemsPreparando, devices: this.getDeviceList() }
    };
  }

  async handleGetHistorial(data) {
    const { limit } = data || {};
    const historial = this.historial.slice(0, parseInt(limit) || 20);

    return {
      status: 200,
      data: { pedidos: historial, total: historial.length }
    };
  }

  async handleGetPedido(data) {
    const invalid = this.validateInput('cocina.get', data);
    if (invalid) return invalid;

    const { pedido_id } = data;
    const pedido = this.pedidosActivos.get(pedido_id);

    if (!pedido) {
      return { status: 404, error: 'Pedido no encontrado en cocina' };
    }

    return { status: 200, data: pedido };
  }

  /**
   * Tap toggle para items:
   *   pendiente → preparando (cocinero empieza a preparar)
   *   preparando → listo (cocinero termina de preparar)
   * Si todos los items quedan listo → auto-completa el pedido.
   */
  async handlePrepararItem(data) {
    const invalid = this.validateInput('cocina.prepare-item', data);
    if (invalid) return invalid;

    const { item_id, device_id } = data;

    // Resolver color del dispositivo si lo hay
    const device = device_id ? this.devices.get(device_id) : null;
    if (device) device.last_seen = new Date().toISOString();

    // Buscar item en pedidos activos
    let pedidoEncontrado = null;
    let itemEncontrado = null;

    for (const pedido of this.pedidosActivos.values()) {
      const item = pedido.items.find(i => i.item_id === item_id);
      if (item) {
        pedidoEncontrado = pedido;
        itemEncontrado = item;
        break;
      }
    }

    if (!itemEncontrado) {
      return { status: 404, error: 'Item no encontrado en cocina' };
    }

    if (itemEncontrado.estado === 'listo') {
      return { status: 400, error: 'Item ya está listo' };
    }

    const now = new Date().toISOString();

    if (itemEncontrado.estado === 'pendiente') {
      // Primer tap: empezar a preparar
      itemEncontrado.estado = 'preparando';
      itemEncontrado.preparando_at = now;
      if (device) {
        itemEncontrado.device_id = device_id;
        itemEncontrado.device_color = device.color;
        itemEncontrado.device_nombre = device.nombre;
      }

      await this.publishItemPreparando(pedidoEncontrado, itemEncontrado);

      this.logger.info('cocina.item.preparando', {
        pedido_id: pedidoEncontrado.pedido_id, item_id, device_id: device_id || null
      });

      return {
        status: 200,
        data: { item: itemEncontrado, pedido_completo: false }
      };
    }

    // Segundo tap (preparando → listo): terminar
    itemEncontrado.estado = 'listo';
    itemEncontrado.preparado_at = now;

    this.metrics?.increment?.('cocina.item_preparado.total');

    await this.publishItemPreparado(pedidoEncontrado, itemEncontrado);

    // Auto-completar si todos listos
    const todosListos = pedidoEncontrado.items.every(i => i.estado === 'listo');
    if (todosListos) {
      await this.marcarPedidoListo(pedidoEncontrado);
    }

    this.logger.info('cocina.item.preparado', {
      pedido_id: pedidoEncontrado.pedido_id, item_id, device_id: device_id || null, pedido_completo: todosListos
    });

    return {
      status: 200,
      data: { item: itemEncontrado, pedido_completo: todosListos }
    };
  }

  /**
   * Marca el pedido entero como listo de golpe (atajo rápido).
   * Todos los items pendientes/preparando pasan a listo.
   */
  async handleMarcarListo(data) {
    const invalid = this.validateInput('cocina.mark-ready', data);
    if (invalid) return invalid;

    const { pedido_id } = data;

    const pedido = this.pedidosActivos.get(pedido_id);
    if (!pedido) {
      return { status: 404, error: 'Pedido no encontrado en cocina' };
    }

    const now = new Date().toISOString();
    pedido.items.forEach(item => {
      if (item.estado !== 'listo') {
        item.estado = 'listo';
        item.preparado_at = now;
        this.metrics?.increment?.('cocina.item_preparado.total');
      }
    });

    await this.marcarPedidoListo(pedido);

    return { status: 200, data: pedido };
  }

  // ==========================================
  // Device Management
  // ==========================================

  /**
   * Registra un dispositivo de cocina. Asigna color único automáticamente.
   * Si el device_id ya existe, actualiza sus datos (re-connect).
   */
  async handleRegisterDevice(data) {
    const invalid = this.validateInput('cocina.register-device', data);
    if (invalid) return invalid;

    const { device_id, nombre, filtros } = data;
    const existing = this.devices.get(device_id);

    if (existing) {
      // Re-registro: actualizar filtros y nombre, mantener color
      existing.nombre = nombre || existing.nombre;
      existing.filtros = filtros || existing.filtros;
      existing.last_seen = new Date().toISOString();

      await this.eventBus.publish('cocina.device_updated', {
        device_id, nombre: existing.nombre, color: existing.color, filtros: existing.filtros
      });

      return {
        status: 200,
        data: {
          device_id,
          color: existing.color,
          nombre: existing.nombre,
          filtros: existing.filtros,
          devices: this.getDeviceList()
        }
      };
    }

    // Nuevo dispositivo: asignar color
    const colorIndex = this.devices.size % this.DEVICE_COLORS.length;
    const color = this.DEVICE_COLORS[colorIndex];

    const device = {
      device_id,
      nombre: nombre || `Estación ${this.devices.size + 1}`,
      color,
      filtros: filtros || { familias: [] },
      connected_at: new Date().toISOString(),
      last_seen: new Date().toISOString()
    };

    this.devices.set(device_id, device);

    await this.eventBus.publish('cocina.device_registered', {
      device_id, nombre: device.nombre, color, filtros: device.filtros
    });

    this.logger.info('cocina.device.registered', {
      device_id, nombre: device.nombre, color, total_devices: this.devices.size
    });

    return {
      status: 201,
      data: {
        device_id,
        color,
        nombre: device.nombre,
        filtros: device.filtros,
        devices: this.getDeviceList()
      }
    };
  }

  async handleUnregisterDevice(data) {
    const { device_id } = data;
    if (!device_id) return { status: 400, error: 'device_id requerido' };

    const existed = this.devices.delete(device_id);

    if (existed) {
      await this.eventBus.publish('cocina.device_unregistered', { device_id });
      this.logger.info('cocina.device.unregistered', { device_id, total_devices: this.devices.size });
    }

    return { status: 200, data: { removed: existed, devices: this.getDeviceList() } };
  }

  async handleListDevices() {
    return { status: 200, data: { devices: this.getDeviceList() } };
  }

  getDeviceList() {
    return Array.from(this.devices.values()).map(d => ({
      device_id: d.device_id,
      nombre: d.nombre,
      color: d.color,
      filtros: d.filtros,
      connected_at: d.connected_at,
      last_seen: d.last_seen
    }));
  }

  async handleHealthCheck() {
    return {
      status: 200,
      data: {
        status: 'healthy',
        module: this.name,
        version: this.version,
        pedidos_activos: this.pedidosActivos.size,
        devices_count: this.devices.size
      }
    };
  }

  async handleGetMetrics() {
    const itemsPendientes = Array.from(this.pedidosActivos.values())
      .reduce((sum, p) => sum + p.items.filter(i => i.estado === 'pendiente').length, 0);
    const itemsPreparando = Array.from(this.pedidosActivos.values())
      .reduce((sum, p) => sum + p.items.filter(i => i.estado === 'preparando').length, 0);

    const tiempoPromedio = this.tiemposPreparacion.length > 0
      ? this.tiemposPreparacion.reduce((a, b) => a + b, 0) / this.tiemposPreparacion.length
      : 0;

    return {
      status: 200,
      data: {
        pedidos_activos: this.pedidosActivos.size,
        items_pendientes: itemsPendientes,
        items_preparando: itemsPreparando,
        historial_count: this.historial.length,
        tiempo_promedio_preparacion: Math.round(tiempoPromedio),
        timestamp: new Date().toISOString()
      }
    };
  }

  // ==========================================
  // Restauración desde persistencia
  // ==========================================

  /**
   * Reconstruye pedidos activos de cocina desde cuentas_activas.json.
   * Los pedidos que tenían estado en_preparacion/con_pedido se restauran
   * como pendientes en cocina.
   */
  async restaurarDesdeArchivo() {
    try {
      const fs = require('fs').promises;
      const path = require('path');
      const archivo = path.join('./data/current', 'cuentas_activas.json');
      const contenido = await fs.readFile(archivo, 'utf8');
      const datos = JSON.parse(contenido);

      if (!datos.cuentas) return;

      let restaurados = 0;
      // Estados que indican que el pedido ya salió de cocina
      const ESTADOS_POST_COCINA = new Set(['listo', 'entregado', 'para_cobrar', 'cobrado']);

      for (const [cuenta_id, cuenta] of Object.entries(datos.cuentas)) {
        if (!cuenta.pedidos || cuenta.pedidos.length === 0) continue;

        // Si la cuenta ya pasó por cocina, no restaurar sus pedidos
        if (ESTADOS_POST_COCINA.has(cuenta.estado)) continue;

        for (const pedidoData of cuenta.pedidos) {
          const pedido_id = pedidoData.pedido_id;
          if (!pedido_id || this.pedidosActivos.has(pedido_id)) continue;

          const items = (pedidoData.items || []).map((item, idx) => {
            const cocinaItem = {
              item_id: item.item_id || item.id || `${pedido_id}_item_${idx + 1}`,
              producto_id: item.producto_id,
              nombre: item.nombre,
              cantidad: item.cantidad || 1,
              variaciones: item.variaciones || null,
              notas: item.notas || '',
              estado: 'pendiente'
            };
            if (item.tipo) cocinaItem.tipo = item.tipo;
            if (item.pizza_izquierda) cocinaItem.pizza_izquierda = item.pizza_izquierda;
            if (item.pizza_derecha) cocinaItem.pizza_derecha = item.pizza_derecha;
            if (item.ingredientes) cocinaItem.ingredientes = item.ingredientes;
            if (item.ingredientes_base) cocinaItem.ingredientes_base = item.ingredientes_base;
            return cocinaItem;
          });

          if (items.length === 0) continue;

          // Detectar canal por prefijo del cuenta_id
          let canal = null;
          if (cuenta_id.startsWith('mesa_')) canal = 'mesa';
          else if (cuenta_id.startsWith('tel_')) canal = 'telefono';
          else if (cuenta_id.startsWith('llevar_')) canal = 'llevar';
          else if (cuenta_id.startsWith('glovo_')) canal = 'glovo';

          const pedidoCocina = {
            pedido_id,
            cuenta_id,
            canal,
            items,
            estado: 'activo',
            notas_generales: '',
            recibido_at: cuenta.created_at || new Date().toISOString(),
            metadata: null
          };

          this.pedidosActivos.set(pedido_id, pedidoCocina);
          restaurados++;
        }
      }

      if (restaurados > 0) {
        this.metrics?.gauge?.('cocina.pedidos_activos.count', this.pedidosActivos.size);
        this.logger.info('cocina.estado_restaurado', {
          pedidos_restaurados: restaurados
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn('cocina.restaurar.error', { error: error.message });
      }
    }
  }

  // ==========================================
  // Lógica interna
  // ==========================================

  async marcarPedidoListo(pedido) {
    pedido.estado = 'listo';
    pedido.listo_at = new Date().toISOString();

    // Tiempo de preparación (segundos)
    const tiempoPreparacion = (new Date(pedido.listo_at) - new Date(pedido.recibido_at)) / 1000;
    pedido.tiempo_preparacion = tiempoPreparacion;

    // Rolling average (últimos 100)
    this.tiemposPreparacion.push(tiempoPreparacion);
    if (this.tiemposPreparacion.length > 100) {
      this.tiemposPreparacion.shift();
    }

    // Métricas via core
    this.metrics?.increment?.('cocina.pedido_listo.total');
    this.metrics?.timing?.('cocina.preparacion_pedido.duration', tiempoPreparacion * 1000);
    this.metrics?.gauge?.('cocina.pedidos_activos.count', this.pedidosActivos.size - 1);

    // Historial (últimos 50)
    this.historial.unshift(pedido);
    if (this.historial.length > this.maxHistorial) {
      this.historial.pop();
    }

    this.pedidosActivos.delete(pedido.pedido_id);

    await this.publishPedidoListo(pedido);

    this.logger.info('cocina.pedido.listo', {
      pedido_id: pedido.pedido_id,
      canal: pedido.canal || null,
      tiempo_preparacion: tiempoPreparacion
    });
  }

  // ==========================================
  // Event Publishers
  // ==========================================

  async publishItemPreparando(pedidoCocina, item) {
    const payload = {
      pedido_id: pedidoCocina.pedido_id,
      cuenta_id: pedidoCocina.cuenta_id,
      canal: pedidoCocina.canal || null,
      item_id: item.item_id,
      producto_id: item.producto_id,
      nombre: item.nombre,
      cantidad: item.cantidad,
      preparando_at: item.preparando_at
    };
    if (item.device_id) payload.device_id = item.device_id;
    if (item.device_color) payload.device_color = item.device_color;
    if (item.device_nombre) payload.device_nombre = item.device_nombre;
    await this.eventBus.publish('cocina.item_preparando', payload);
  }

  async publishItemPreparado(pedidoCocina, item) {
    const payload = {
      pedido_id: pedidoCocina.pedido_id,
      cuenta_id: pedidoCocina.cuenta_id,
      canal: pedidoCocina.canal || null,
      item_id: item.item_id,
      producto_id: item.producto_id,
      nombre: item.nombre,
      cantidad: item.cantidad,
      preparado_at: item.preparado_at
    };
    if (item.device_id) payload.device_id = item.device_id;
    if (item.device_color) payload.device_color = item.device_color;
    if (item.device_nombre) payload.device_nombre = item.device_nombre;
    await this.eventBus.publish('cocina.item_preparado', payload);
  }

  async publishPedidoListo(pedido) {
    await this.eventBus.publish('cocina.pedido_listo', {
      pedido_id: pedido.pedido_id,
      cuenta_id: pedido.cuenta_id,
      canal: pedido.canal || null,
      items_count: pedido.items.length,
      tiempo_preparacion: pedido.tiempo_preparacion,
      listo_at: pedido.listo_at
    });
  }
}

module.exports = CocinaModule;
