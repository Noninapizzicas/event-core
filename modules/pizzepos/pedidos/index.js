/**
 * Módulo Pedidos v2.0
 * Gestión completa de pedidos - 100% event-driven
 * Alineado con patrones event-core: uiHandler, event envelope, credential cascade
 */

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class PedidosModule {
  constructor() {
    this.name = 'pedidos';
    this.version = '2.0.0';

    // Estado
    this.pedidos = new Map(); // pedido_id -> pedido
    this.pedidosPorCuenta = new Map(); // cuenta_id -> Set(pedido_ids)

    // Caché de productos (resuelve precio dinámicamente)
    this.productosCache = new Map(); // producto_id -> { nombre, precio, ... }

    // Dependencias (inyectadas en onLoad)
    this.logger = null;
    this.metrics = null;
    this.eventBus = null;
    this.uiHandler = null;
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

    // Restaurar pedidos activos desde persistencia (sobrevive reinicio servidor)
    await this.restaurarDesdeArchivo();

    this.logger.info('module.loaded', { module: this.name, version: this.version });
  }

  async onUnload() {
    this.logger.info('module.unloading', { module: this.name });

    // Desregistrar UI handlers
    if (this.uiHandler) {
      const actions = [
        'list', 'get', 'create', 'add-item', 'update-item',
        'delete-item', 'send-kitchen', 'complete', 'cancel', 'total', 'health'
      ];
      for (const action of actions) {
        this.uiHandler.unregister('pedido', action);
      }
    }

    // Limpiar estado
    this.pedidos.clear();
    this.pedidosPorCuenta.clear();
    this.productosCache.clear();

    this.logger.info('module.unloaded', { module: this.name });
  }

  // ==========================================
  // UI Handler Registration
  // ==========================================

  registerUIHandlers() {
    if (!this.uiHandler) {
      this.logger.warn('pedidos.uiHandler.not_available', { module: this.name });
      return;
    }

    this.uiHandler.register('pedido', 'list', this.handleListPedidos.bind(this));
    this.uiHandler.register('pedido', 'get', this.handleGetPedido.bind(this));
    this.uiHandler.register('pedido', 'create', this.handleCreatePedido.bind(this));
    this.uiHandler.register('pedido', 'add-item', this.handleAgregarItem.bind(this));
    this.uiHandler.register('pedido', 'update-item', this.handleActualizarItem.bind(this));
    this.uiHandler.register('pedido', 'delete-item', this.handleEliminarItem.bind(this));
    this.uiHandler.register('pedido', 'send-kitchen', this.handleEnviarCocina.bind(this));
    this.uiHandler.register('pedido', 'complete', this.handleCompletarPedido.bind(this));
    this.uiHandler.register('pedido', 'cancel', this.handleCancelarPedido.bind(this));
    this.uiHandler.register('pedido', 'total', this.handleCalcularTotal.bind(this));
    this.uiHandler.register('pedido', 'health', this.handleHealthCheck.bind(this));

    this.logger.info('pedidos.ui_handlers.registered', {
      handlers: ['list', 'get', 'create', 'add-item', 'update-item', 'delete-item', 'send-kitchen', 'complete', 'cancel', 'total', 'health']
    });
  }

  // ==========================================
  // Event Subscriptions
  // ==========================================

  async subscribeToEvents() {
    // Eventos de otros módulos
    await this.eventBus.subscribe('variacion.validada', this.onVariacionValidada.bind(this));
    await this.eventBus.subscribe('variacion.rechazada', this.onVariacionRechazada.bind(this));
    await this.eventBus.subscribe('cuenta.creada', this.onCuentaCreada.bind(this));

    // Caché de productos — sync desde catálogo
    await this.eventBus.subscribe('catalogo.actualizado', this.onCatalogoActualizado.bind(this));
    await this.eventBus.subscribe('producto.creado', this.onProductoActualizado.bind(this));
    await this.eventBus.subscribe('producto.actualizado', this.onProductoActualizado.bind(this));

    this.logger.info('pedidos.events.subscribed', {
      events: [
        'variacion.validada', 'variacion.rechazada', 'cuenta.creada',
        'catalogo.actualizado', 'producto.creado', 'producto.actualizado'
      ]
    });
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  async onVariacionValidada(event) {
    const data = event?.data || event?.payload || event;
    const { producto_id, precio_total, ingredientes_finales } = data;

    this.logger.info('variacion.validada.received', {
      producto_id,
      precio_total,
      correlation_id: event?.metadata?.correlationId
    });
  }

  async onVariacionRechazada(event) {
    const data = event?.data || event?.payload || event;
    const { producto_id, motivo } = data;

    this.logger.warn('variacion.rechazada.received', {
      producto_id,
      motivo,
      correlation_id: event?.metadata?.correlationId
    });
  }

  async onCuentaCreada(event) {
    const data = event?.data || event?.payload || event;
    const { cuenta_id } = data;

    this.logger.info('cuenta.creada.received', {
      cuenta_id,
      correlation_id: event?.metadata?.correlationId
    });

    if (!this.pedidosPorCuenta.has(cuenta_id)) {
      this.pedidosPorCuenta.set(cuenta_id, new Set());
    }
  }

  // ==========================================
  // Bridge: Comandero → Pedidos
  // ==========================================

  async onComanderoEnviarCocina(event) {
    const data = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;
    const { cuenta_id, pedido_id: comandero_pedido_id, items, total, notas_generales, created_at, project_id } = data;

    if (!cuenta_id || !items || items.length === 0) {
      this.logger.warn('pedidos.bridge.datos_incompletos', { cuenta_id, correlation_id: correlationId });
      return;
    }

    this.logger.info('pedidos.bridge.recibido', {
      cuenta_id,
      items_count: items.length,
      total,
      correlation_id: correlationId
    });

    try {
      const pedido_id = comandero_pedido_id || require('crypto').randomUUID();

      // Detectar canal por prefijo del cuenta_id
      const canal = this.detectarCanal(cuenta_id);

      const pedido = {
        id: pedido_id,
        cuenta_id,
        canal,
        project_id: project_id || null,
        items: items.map(item => ({
          item_id: item.id || item.item_id || require('crypto').randomUUID(),
          producto_id: item.producto_id,
          nombre: item.nombre,
          categoria: item.categoria || null,
          cantidad: item.cantidad || 1,
          precio_unitario: item.precio || 0,
          precio_total: item.subtotal || (item.precio || 0) * (item.cantidad || 1),
          variaciones: item.variaciones || null,
          notas: item.notas || null,
          estado: 'en_cocina',
          // Metadata especial: mitad-mitad, al gusto, ingredientes_base, etc.
          ...(item.tipo && { tipo: item.tipo }),
          ...(item.pizza_izquierda && { pizza_izquierda: item.pizza_izquierda }),
          ...(item.pizza_derecha && { pizza_derecha: item.pizza_derecha }),
          ...(item.ingredientes && { ingredientes: item.ingredientes }),
          ...(item.ingredientes_base && { ingredientes_base: item.ingredientes_base }),
          created_at: item.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString()
        })),
        estado: 'en_cocina',
        subtotal: total || 0,
        total: total || 0,
        notas_generales: notas_generales || null,
        created_at: created_at || new Date().toISOString(),
        enviado_cocina_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      // Registrar pedido formal
      this.pedidos.set(pedido_id, pedido);

      if (!this.pedidosPorCuenta.has(cuenta_id)) {
        this.pedidosPorCuenta.set(cuenta_id, new Set());
      }
      this.pedidosPorCuenta.get(cuenta_id).add(pedido_id);

      // Métricas
      this.metrics.increment('pedido.creado.total');
      this.metrics.increment('pedido.enviado_cocina.total');
      this.metrics.gauge('pedido.activos.count', this.pedidos.size);

      // Publicar eventos formales que el resto del sistema escucha
      await this.publishPedidoCreado(pedido);
      await this.publishEnviadoCocina(pedido);

      this.logger.info('pedidos.bridge.pedido_formal_creado', {
        pedido_id,
        cuenta_id,
        items_count: pedido.items.length,
        total: pedido.total,
        correlation_id: correlationId
      });

    } catch (error) {
      this.metrics.increment('pedido.errors.total', 1, { operation: 'bridge_enviar_cocina' });
      this.logger.error('pedidos.bridge.error', { error: error.message, correlation_id: correlationId });
    }
  }

  async onCatalogoActualizado(event) {
    const data = event?.data || event?.payload || event;
    const productos = data?.productos || [];

    for (const producto of productos) {
      if (producto.id && producto.precio !== undefined) {
        this.productosCache.set(producto.id, {
          nombre: producto.nombre || producto.id,
          precio: producto.precio,
          categoria: producto.categoria
        });
      }
    }

    this.logger.info('pedidos.catalogo.synced', {
      productos_en_cache: this.productosCache.size
    });
  }

  async onProductoActualizado(event) {
    const data = event?.data || event?.payload || event;
    const { id, nombre, precio, categoria } = data;

    if (id && precio !== undefined) {
      this.productosCache.set(id, { nombre: nombre || id, precio, categoria });

      this.logger.info('pedidos.producto.cache_updated', { producto_id: id, precio });
    }
  }

  // ==========================================
  // UI Handlers (MQTT Request/Response)
  // ==========================================

  async handleCreatePedido(data) {
    const start_time = Date.now();

    try {
      const { cuenta_id, project_id, notas_generales } = data;

      if (!cuenta_id) {
        return { status: 400, error: 'cuenta_id es requerido' };
      }

      const pedido_id = crypto.randomUUID();
      const canal = this.detectarCanal(cuenta_id);

      const pedido = {
        id: pedido_id,
        cuenta_id,
        canal,
        project_id: project_id || null,
        items: [],
        estado: 'borrador',
        subtotal: 0,
        total: 0,
        notas_generales: notas_generales || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      this.pedidos.set(pedido_id, pedido);

      // Índice por cuenta
      if (!this.pedidosPorCuenta.has(cuenta_id)) {
        this.pedidosPorCuenta.set(cuenta_id, new Set());
      }
      this.pedidosPorCuenta.get(cuenta_id).add(pedido_id);

      // Métricas
      this.metrics.increment('pedido.creado.total');
      this.metrics.gauge('pedido.activos.count', this.pedidos.size);
      this.metrics.timing('pedido.create.duration', Date.now() - start_time);

      // Evento
      await this.publishPedidoCreado(pedido);

      this.logger.info('pedido.creado', {
        pedido_id, cuenta_id, duration: Date.now() - start_time
      });

      return { status: 201, data: pedido };

    } catch (error) {
      this.metrics.increment('pedido.errors.total', 1, { operation: 'create' });
      this.logger.error('pedido.create.error', { error: error.message });
      return { status: 500, error: error.message };
    }
  }

  async handleListPedidos(data) {
    const { cuenta_id, estado } = data || {};

    let pedidos = Array.from(this.pedidos.values());

    if (cuenta_id) {
      pedidos = pedidos.filter(p => p.cuenta_id === cuenta_id);
    }
    if (estado) {
      pedidos = pedidos.filter(p => p.estado === estado);
    }

    pedidos.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return { status: 200, data: { pedidos, total: pedidos.length } };
  }

  async handleGetPedido(data) {
    const { id } = data;
    const pedido = this.pedidos.get(id);

    if (!pedido) {
      return { status: 404, error: 'Pedido no encontrado' };
    }

    return { status: 200, data: pedido };
  }

  async handleAgregarItem(data) {
    const start_time = Date.now();
    const { pedido_id, producto_id, cantidad, variaciones, notas } = data;

    const pedido = this.pedidos.get(pedido_id);
    if (!pedido) {
      return { status: 404, error: 'Pedido no encontrado' };
    }

    if (pedido.estado !== 'borrador' && pedido.estado !== 'confirmado') {
      return { status: 400, error: `No se pueden agregar items a un pedido en estado ${pedido.estado}` };
    }

    if (!producto_id) {
      return { status: 400, error: 'producto_id es requerido' };
    }

    try {
      const item_id = crypto.randomUUID();

      // Resolver precio y nombre desde caché de productos
      const producto = this.productosCache.get(producto_id);
      const precio_unitario = producto?.precio ?? 0;
      const nombre_producto = producto?.nombre ?? producto_id;

      if (!producto) {
        this.logger.warn('pedido.producto.not_in_cache', {
          producto_id,
          cache_size: this.productosCache.size
        });
      }

      const cantidadFinal = cantidad || 1;

      const item = {
        item_id,
        producto_id,
        nombre: nombre_producto,
        cantidad: cantidadFinal,
        precio_unitario,
        precio_total: precio_unitario * cantidadFinal,
        variaciones: variaciones || null,
        notas: notas || null,
        estado: 'pendiente',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      pedido.items.push(item);
      pedido.subtotal = this.calcularSubtotal(pedido);
      pedido.total = pedido.subtotal;
      pedido.updated_at = new Date().toISOString();

      // Métricas
      this.metrics.increment('pedido.item_agregado.total');
      this.metrics.gauge('pedido.items_total.count',
        Array.from(this.pedidos.values()).reduce((sum, p) => sum + p.items.length, 0)
      );

      // Evento
      await this.publishItemAgregado(pedido, item);

      this.logger.info('pedido.item_agregado', {
        pedido_id, item_id, producto_id, cantidad: cantidadFinal, precio_unitario
      });

      return {
        status: 201,
        data: { pedido_id, item, total: pedido.total }
      };

    } catch (error) {
      this.metrics.increment('pedido.errors.total', 1, { operation: 'agregar_item' });
      this.logger.error('pedido.agregar_item.error', { error: error.message });
      return { status: 500, error: error.message };
    }
  }

  async handleActualizarItem(data) {
    const { pedido_id, item_id, cantidad, variaciones, notas } = data;

    const pedido = this.pedidos.get(pedido_id);
    if (!pedido) {
      return { status: 404, error: 'Pedido no encontrado' };
    }

    const itemIndex = pedido.items.findIndex(i => i.item_id === item_id);
    if (itemIndex === -1) {
      return { status: 404, error: 'Item no encontrado' };
    }

    const item = pedido.items[itemIndex];
    const cambios = {};

    if (cantidad !== undefined && cantidad !== item.cantidad) {
      cambios.cantidad = { anterior: item.cantidad, nuevo: cantidad };
      item.cantidad = cantidad;
      item.precio_total = item.precio_unitario * item.cantidad;
    }

    if (variaciones !== undefined) {
      cambios.variaciones = { anterior: item.variaciones, nuevo: variaciones };
      item.variaciones = variaciones;
    }

    if (notas !== undefined) {
      cambios.notas = { anterior: item.notas, nuevo: notas };
      item.notas = notas;
    }

    item.updated_at = new Date().toISOString();
    pedido.subtotal = this.calcularSubtotal(pedido);
    pedido.total = pedido.subtotal;
    pedido.updated_at = new Date().toISOString();

    await this.publishItemActualizado(pedido.id, item_id, cambios);

    this.logger.info('pedido.item_actualizado', { pedido_id, item_id, cambios });

    return {
      status: 200,
      data: { pedido_id, item, total: pedido.total }
    };
  }

  async handleEliminarItem(data) {
    const { pedido_id, item_id } = data;

    const pedido = this.pedidos.get(pedido_id);
    if (!pedido) {
      return { status: 404, error: 'Pedido no encontrado' };
    }

    const itemIndex = pedido.items.findIndex(i => i.item_id === item_id);
    if (itemIndex === -1) {
      return { status: 404, error: 'Item no encontrado' };
    }

    pedido.items.splice(itemIndex, 1);
    pedido.subtotal = this.calcularSubtotal(pedido);
    pedido.total = pedido.subtotal;
    pedido.updated_at = new Date().toISOString();

    await this.publishItemEliminado(pedido.id, item_id);

    this.logger.info('pedido.item_eliminado', { pedido_id, item_id });

    return {
      status: 200,
      data: { pedido_id, item_id, total: pedido.total }
    };
  }

  async handleEnviarCocina(data) {
    const start_time = Date.now();
    const { id } = data;

    const pedido = this.pedidos.get(id);
    if (!pedido) {
      return { status: 404, error: 'Pedido no encontrado' };
    }

    if (pedido.items.length === 0) {
      return { status: 400, error: 'No se puede enviar un pedido vacío a cocina' };
    }

    if (pedido.estado === 'en_cocina') {
      return { status: 400, error: 'Pedido ya está en cocina' };
    }

    pedido.estado = 'en_cocina';
    pedido.enviado_cocina_at = new Date().toISOString();
    pedido.updated_at = new Date().toISOString();

    pedido.items.forEach(item => {
      if (item.estado === 'pendiente') {
        item.estado = 'en_cocina';
      }
    });

    // Métricas
    this.metrics.increment('pedido.enviado_cocina.total');
    this.metrics.gauge('pedido.en_cocina.count',
      Array.from(this.pedidos.values()).filter(p => p.estado === 'en_cocina').length
    );
    this.metrics.timing('pedido.envio_cocina.duration', Date.now() - start_time);

    await this.publishEnviadoCocina(pedido);

    this.logger.info('pedido.enviado_cocina', {
      pedido_id: id, items_count: pedido.items.length, duration: Date.now() - start_time
    });

    return {
      status: 200,
      data: {
        pedido_id: id,
        estado: pedido.estado,
        items_count: pedido.items.length,
        enviado_at: pedido.enviado_cocina_at
      }
    };
  }

  async handleCompletarPedido(data) {
    const { id } = data;

    const pedido = this.pedidos.get(id);
    if (!pedido) {
      return { status: 404, error: 'Pedido no encontrado' };
    }

    pedido.estado = 'completado';
    pedido.completado_at = new Date().toISOString();
    pedido.updated_at = new Date().toISOString();

    const duracion = Math.floor((new Date(pedido.completado_at) - new Date(pedido.created_at)) / 1000 / 60);

    this.metrics.increment('pedido.completado.total');

    await this.publishPedidoCompletado(pedido, duracion);

    this.logger.info('pedido.completado', { pedido_id: id, duracion_minutos: duracion });

    return {
      status: 200,
      data: {
        pedido_id: id,
        estado: pedido.estado,
        completado_at: pedido.completado_at,
        duracion_minutos: duracion
      }
    };
  }

  async handleCancelarPedido(data) {
    const { id, motivo } = data;

    const pedido = this.pedidos.get(id);
    if (!pedido) {
      return { status: 404, error: 'Pedido no encontrado' };
    }

    pedido.estado = 'cancelado';
    pedido.cancelado_at = new Date().toISOString();
    pedido.updated_at = new Date().toISOString();

    this.metrics.increment('pedido.cancelado.total');

    await this.publishPedidoCancelado(pedido, motivo);

    this.logger.info('pedido.cancelado', { pedido_id: id, motivo });

    return {
      status: 200,
      data: {
        pedido_id: id,
        estado: pedido.estado,
        motivo: motivo || null,
        cancelado_at: pedido.cancelado_at
      }
    };
  }

  async handleCalcularTotal(data) {
    const { id } = data;

    const pedido = this.pedidos.get(id);
    if (!pedido) {
      return { status: 404, error: 'Pedido no encontrado' };
    }

    return {
      status: 200,
      data: {
        pedido_id: id,
        subtotal: pedido.subtotal,
        total: pedido.total,
        items_count: pedido.items.length
      }
    };
  }

  async handleHealthCheck() {
    return {
      status: 200,
      data: {
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        version: this.version,
        productos_en_cache: this.productosCache.size,
        pedidos: {
          total: this.pedidos.size,
          borrador: Array.from(this.pedidos.values()).filter(p => p.estado === 'borrador').length,
          en_cocina: Array.from(this.pedidos.values()).filter(p => p.estado === 'en_cocina').length,
          completado: Array.from(this.pedidos.values()).filter(p => p.estado === 'completado').length
        }
      }
    };
  }

  // ==========================================
  // Event Publishers
  // ==========================================

  async publishPedidoCreado(pedido) {
    await this.eventBus.publish('pedido.creado', {
      pedido_id: pedido.id,
      cuenta_id: pedido.cuenta_id,
      canal: pedido.canal || null,
      project_id: pedido.project_id || null,
      estado: pedido.estado,
      total: pedido.total,
      items: pedido.items || [],
      created_at: pedido.created_at
    });
  }

  async publishItemAgregado(pedido, item) {
    await this.eventBus.publish('pedido.item_agregado', {
      pedido_id: pedido.id,
      cuenta_id: pedido.cuenta_id,
      item_id: item.item_id,
      producto_id: item.producto_id,
      nombre: item.nombre,
      cantidad: item.cantidad,
      precio_unitario: item.precio_unitario,
      precio_total: item.precio_total,
      variaciones: item.variaciones,
      notas: item.notas
    });
  }

  async publishItemActualizado(pedido_id, item_id, cambios) {
    await this.eventBus.publish('pedido.item_actualizado', {
      pedido_id,
      item_id,
      cambios
    });
  }

  async publishItemEliminado(pedido_id, item_id) {
    await this.eventBus.publish('pedido.item_eliminado', {
      pedido_id,
      item_id,
      motivo: 'eliminado_por_usuario'
    });
  }

  async publishEnviadoCocina(pedido) {
    await this.eventBus.publish('pedido.enviado_cocina', {
      pedido_id: pedido.id,
      cuenta_id: pedido.cuenta_id,
      canal: pedido.canal || null,
      items: pedido.items.map(item => {
        const mapped = {
          item_id: item.item_id,
          producto_id: item.producto_id,
          nombre: item.nombre,
          categoria: item.categoria || null,
          cantidad: item.cantidad,
          variaciones: item.variaciones,
          notas: item.notas
        };
        // Incluir metadata especial para cocina
        if (item.tipo) mapped.tipo = item.tipo;
        if (item.pizza_izquierda) mapped.pizza_izquierda = item.pizza_izquierda;
        if (item.pizza_derecha) mapped.pizza_derecha = item.pizza_derecha;
        if (item.ingredientes) mapped.ingredientes = item.ingredientes;
        if (item.ingredientes_base) mapped.ingredientes_base = item.ingredientes_base;
        return mapped;
      }),
      items_count: pedido.items.length,
      notas_generales: pedido.notas_generales,
      enviado_at: pedido.enviado_cocina_at
    });
  }

  async publishPedidoCompletado(pedido, duracion_minutos) {
    await this.eventBus.publish('pedido.completado', {
      pedido_id: pedido.id,
      cuenta_id: pedido.cuenta_id,
      total: pedido.total,
      items_count: pedido.items.length,
      completado_at: pedido.completado_at,
      duracion_minutos
    });
  }

  async publishPedidoCancelado(pedido, motivo) {
    await this.eventBus.publish('pedido.cancelado', {
      pedido_id: pedido.id,
      cuenta_id: pedido.cuenta_id,
      motivo: motivo || 'sin_especificar',
      cancelado_at: pedido.cancelado_at
    });
  }

  // ==========================================
  // Restauración desde persistencia
  // ==========================================

  /**
   * Lee cuentas_activas.json y reconstruye pedidos formales desde los pedidos
   * almacenados en cada cuenta activa.
   */
  async restaurarDesdeArchivo() {
    try {
      const archivo = path.join('./data/current', 'cuentas_activas.json');
      const contenido = await fs.readFile(archivo, 'utf8');
      const datos = JSON.parse(contenido);

      if (!datos.cuentas) return;

      let restaurados = 0;
      for (const [cuenta_id, cuenta] of Object.entries(datos.cuentas)) {
        if (!cuenta.pedidos || cuenta.pedidos.length === 0) continue;

        if (!this.pedidosPorCuenta.has(cuenta_id)) {
          this.pedidosPorCuenta.set(cuenta_id, new Set());
        }

        const canal = this.detectarCanal(cuenta_id);

        for (const pedidoData of cuenta.pedidos) {
          const pedido_id = pedidoData.pedido_id;
          if (!pedido_id || this.pedidos.has(pedido_id)) continue;

          const pedido = {
            id: pedido_id,
            cuenta_id,
            canal,
            project_id: cuenta.project_id || null,
            items: (pedidoData.items || []).map(item => ({
              item_id: item.item_id || item.id || crypto.randomUUID(),
              producto_id: item.producto_id,
              nombre: item.nombre,
              categoria: item.categoria || null,
              cantidad: item.cantidad || 1,
              precio_unitario: item.precio || item.precio_unitario || 0,
              precio_total: item.subtotal || item.precio_total || (item.precio || 0) * (item.cantidad || 1),
              variaciones: item.variaciones || null,
              notas: item.notas || null,
              estado: 'en_cocina',
              created_at: item.created_at || cuenta.created_at || new Date().toISOString(),
              updated_at: cuenta.updated_at || new Date().toISOString()
            })),
            estado: 'en_cocina',
            subtotal: pedidoData.total || 0,
            total: pedidoData.total || 0,
            notas_generales: null,
            created_at: cuenta.created_at || new Date().toISOString(),
            updated_at: cuenta.updated_at || new Date().toISOString()
          };

          this.pedidos.set(pedido_id, pedido);
          this.pedidosPorCuenta.get(cuenta_id).add(pedido_id);
          restaurados++;
        }
      }

      if (restaurados > 0) {
        this.metrics?.gauge?.('pedido.activos.count', this.pedidos.size);
        this.logger.info('pedidos.estado_restaurado', {
          pedidos_restaurados: restaurados,
          cuentas_con_pedidos: this.pedidosPorCuenta.size
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn('pedidos.restaurar.error', { error: error.message });
      }
    }
  }

  // ==========================================
  // Helpers
  // ==========================================

  calcularSubtotal(pedido) {
    return pedido.items.reduce((sum, item) => sum + item.precio_total, 0);
  }

  /**
   * Detecta el canal de venta por el prefijo del cuenta_id
   * mesa_ → mesa, tel_ → telefono, llevar_ → llevar, glovo_ → glovo, wa_ → whatsapp
   * Sin prefijo conocido → genérico (cuenta simple)
   */
  detectarCanal(cuenta_id) {
    if (!cuenta_id) return null;
    if (cuenta_id.startsWith('mesa_')) return 'mesa';
    if (cuenta_id.startsWith('tel_')) return 'telefono';
    if (cuenta_id.startsWith('llevar_')) return 'llevar';
    if (cuenta_id.startsWith('glovo_')) return 'glovo';
    if (cuenta_id.startsWith('wa_')) return 'whatsapp';
    return null;
  }
}

module.exports = PedidosModule;
