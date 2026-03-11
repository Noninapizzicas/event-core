/**
 * Módulo Comandero v2.0
 * Puerta de entrada del camarero - Buffer de pedido por cuenta
 * Alineado con patrones event-core: uiHandler, event envelope, cleanup
 *
 * Flujo: cuenta abierta → comandero (add/remove items) → enviar cocina → cobrar
 */

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class ComanderoModule {
  constructor() {
    this.name = 'comandero';
    this.version = '2.0.0';

    // Dependencias (inyectadas en onLoad)
    this.eventBus = null;
    this.logger = null;
    this.metrics = null;
    this.uiHandler = null;
    this.validator = null;

    // Buffer de pedidos por cuenta: cuenta_id -> { items: [], notas: '', total: 0 }
    this.pedidos = new Map();

    // Caché de productos (para resolver nombre/precio)
    this.productosCache = new Map();

    // Persistencia del buffer (debounced)
    this._bufferFile = path.join('./data/current', 'comandero_buffers.json');
    this._saveTimer = null;
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

    // Registrar schemas de validación para los handlers
    this.registerSchemas();

    // Event subscriptions are auto-wired from module.json by the loader.
    this.registerUIHandlers();

    // Restaurar buffers desde persistencia
    await this.restaurarBuffers();

    this.logger.info('module.loaded', { module: this.name, version: this.version });
  }

  async onUnload() {
    this.logger.info('module.unloading', { module: this.name });

    if (this.uiHandler) {
      const actions = ['get', 'add-item', 'remove-item', 'update-item', 'send-kitchen', 'health', 'buffers'];
      for (const action of actions) {
        this.uiHandler.unregister('comandero', action);
      }
    }

    this.pedidos.clear();
    this.productosCache.clear();

    this.logger.info('module.unloaded', { module: this.name });
  }

  // ==========================================
  // Validation Schemas
  // ==========================================

  registerSchemas() {
    if (!this.validator) return;

    this.validator.registerSchema('comandero.add-item', {
      type: 'object',
      required: ['cuenta_id', 'producto_id'],
      properties: {
        cuenta_id: { type: 'string', minLength: 1 },
        producto_id: { type: 'string', minLength: 1 },
        nombre: { type: 'string' },
        precio: { type: 'number', minimum: 0 },
        cantidad: { type: 'integer', minimum: 1 },
        notas: { type: 'string' },
        tipo: { type: 'string', enum: ['mitad_mitad', 'al_gusto'] },
        variaciones: { type: 'array' }
      }
    });

    this.validator.registerSchema('comandero.update-item', {
      type: 'object',
      required: ['cuenta_id', 'item_id'],
      properties: {
        cuenta_id: { type: 'string', minLength: 1 },
        item_id: { type: 'string', minLength: 1 },
        cantidad: { type: 'integer' },
        notas: { type: 'string' }
      }
    });

    this.validator.registerSchema('comandero.remove-item', {
      type: 'object',
      required: ['cuenta_id', 'item_id'],
      properties: {
        cuenta_id: { type: 'string', minLength: 1 },
        item_id: { type: 'string', minLength: 1 }
      }
    });

    this.validator.registerSchema('comandero.send-kitchen', {
      type: 'object',
      required: ['cuenta_id'],
      properties: {
        cuenta_id: { type: 'string', minLength: 1 },
        project_id: { type: 'string' }
      }
    });

    this.logger.info('comandero.schemas.registered', { count: 4 });
  }

  // ==========================================
  // Validation Helper
  // ==========================================

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
      this.logger.warn('comandero.uiHandler.not_available', { module: this.name });
      return;
    }

    this.uiHandler.register('comandero', 'get', this.handleGetPedido.bind(this));
    this.uiHandler.register('comandero', 'add-item', this.handleAddItem.bind(this));
    this.uiHandler.register('comandero', 'remove-item', this.handleRemoveItem.bind(this));
    this.uiHandler.register('comandero', 'update-item', this.handleUpdateItem.bind(this));
    this.uiHandler.register('comandero', 'send-kitchen', this.handleEnviarCocina.bind(this));
    this.uiHandler.register('comandero', 'health', this.handleHealthCheck.bind(this));
    this.uiHandler.register('comandero', 'buffers', this.handleListBuffers.bind(this));

    this.logger.info('comandero.ui_handlers.registered', {
      handlers: ['get', 'add-item', 'remove-item', 'update-item', 'send-kitchen', 'health', 'buffers']
    });
  }

  // ==========================================
  // Event Subscriptions
  // ==========================================

  async subscribeToEvents() {
    await this.eventBus.subscribe('cuenta.actualizada', this.onCuentaActualizada.bind(this));
    await this.eventBus.subscribe('caja.cerrada', this.onCajaCerrada.bind(this));
    await this.eventBus.subscribe('dia.iniciado', this.onDiaIniciado.bind(this));

    // Caché de productos
    await this.eventBus.subscribe('catalogo.actualizado', this.onCatalogoActualizado.bind(this));
    await this.eventBus.subscribe('producto.creado', this.onProductoActualizado.bind(this));
    await this.eventBus.subscribe('producto.actualizado', this.onProductoActualizado.bind(this));

    this.logger.info('comandero.events.subscribed', {
      events: [
        'cuenta.actualizada', 'caja.cerrada', 'dia.iniciado',
        'catalogo.actualizado', 'producto.creado', 'producto.actualizado'
      ]
    });
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  async onCuentaActualizada(event) {
    const data = event?.data || event?.payload || event;
    const { cuenta_id } = data;

    this.logger.debug('cuenta.actualizada.received', {
      cuenta_id,
      correlation_id: event?.metadata?.correlationId
    });
  }

  async onCajaCerrada(event) {
    const size = this.pedidos.size;
    this.pedidos.clear();
    this.guardarBuffers();

    this.logger.info('comandero.reset.caja_cerrada', {
      pedidos_limpiados: size,
      correlation_id: event?.metadata?.correlationId
    });
  }

  async onDiaIniciado(event) {
    const size = this.pedidos.size;
    this.pedidos.clear();
    this.guardarBuffers();

    this.logger.info('comandero.reset.dia_iniciado', {
      pedidos_limpiados: size,
      correlation_id: event?.metadata?.correlationId
    });
  }

  async onCatalogoActualizado(event) {
    const data = event?.data || event?.payload || event;
    const productos = data?.productos || [];

    for (const producto of productos) {
      if (producto.id && producto.precio !== undefined) {
        this.productosCache.set(producto.id, {
          nombre: producto.nombre || producto.id,
          precio: producto.precio,
          categoria: producto.categoria || null
        });
      }
    }

    this.logger.info('comandero.catalogo.synced', {
      productos_en_cache: this.productosCache.size
    });
  }

  async onProductoActualizado(event) {
    const data = event?.data || event?.payload || event;
    const { id, nombre, precio, categoria } = data;

    if (id && precio !== undefined) {
      const existing = this.productosCache.get(id);
      this.productosCache.set(id, {
        nombre: nombre || id,
        precio,
        categoria: categoria || existing?.categoria || null
      });
    }
  }

  // ==========================================
  // UI Handlers (MQTT Request/Response)
  // ==========================================

  async handleGetPedido(data) {
    const { cuenta_id } = data;

    if (!cuenta_id) {
      return { status: 400, error: 'cuenta_id es requerido' };
    }

    let pedido = this.pedidos.get(cuenta_id);
    if (!pedido) {
      pedido = { items: [], notas: '', total: 0 };
      this.pedidos.set(cuenta_id, pedido);
    }

    return {
      status: 200,
      data: { cuenta_id, ...pedido }
    };
  }

  async handleAddItem(data) {
    const invalid = this.validateInput('comandero.add-item', data);
    if (invalid) return invalid;

    const { cuenta_id, producto_id, nombre, precio, cantidad, categoria, variaciones, notas,
            tipo, pizza_izquierda, pizza_derecha, ingredientes: metaIngredientes,
            ingredientes_base } = data;

    // Obtener o crear buffer de pedido
    let pedido = this.pedidos.get(cuenta_id);
    if (!pedido) {
      pedido = { items: [], notas: '', total: 0 };
      this.pedidos.set(cuenta_id, pedido);
    }

    // Resolver nombre/precio: prioridad data > cache > fallback
    const cached = this.productosCache.get(producto_id);
    const itemNombre = nombre || cached?.nombre || producto_id;
    const itemPrecio = precio ?? cached?.precio ?? 0;
    const itemCantidad = cantidad || 1;

    if (!cached && precio === undefined) {
      this.logger.warn('comandero.producto.not_in_cache', { producto_id });
    }

    const item_id = crypto.randomUUID();
    const item = {
      id: item_id,
      producto_id,
      nombre: itemNombre,
      precio: itemPrecio,
      cantidad: itemCantidad,
      categoria: categoria || cached?.categoria || null,
      variaciones: variaciones || [],
      notas: notas || '',
      subtotal: itemPrecio * itemCantidad,
      created_at: new Date().toISOString()
    };

    // Metadata especial: mitad_mitad, al_gusto, etc.
    if (tipo) {
      item.tipo = tipo;
    }
    if (pizza_izquierda) {
      item.pizza_izquierda = pizza_izquierda;
    }
    if (pizza_derecha) {
      item.pizza_derecha = pizza_derecha;
    }
    if (metaIngredientes) {
      item.ingredientes = metaIngredientes;
    }
    if (ingredientes_base) {
      item.ingredientes_base = ingredientes_base;
    }

    pedido.items.push(item);
    pedido.total = this.calcularTotal(pedido.items);

    this.metrics.increment('comandero.item_agregado.total');

    const eventPayload = {
      cuenta_id,
      item_id,
      producto_id,
      nombre: itemNombre,
      precio_unitario: itemPrecio,
      precio_total: item.subtotal,
      cantidad: itemCantidad,
      pedido_total: pedido.total,
      pedido_items: pedido.items.reduce((s, i) => s + i.cantidad, 0)
    };
    if (tipo) eventPayload.tipo = tipo;
    if (pizza_izquierda) eventPayload.pizza_izquierda = pizza_izquierda;
    if (pizza_derecha) eventPayload.pizza_derecha = pizza_derecha;
    if (item.variaciones) eventPayload.variaciones = item.variaciones;
    if (item.ingredientes_base) eventPayload.ingredientes_base = item.ingredientes_base;
    if (metaIngredientes) eventPayload.ingredientes = metaIngredientes;

    await this.eventBus.publish('comandero.item_agregado', eventPayload);

    // Persistir buffer a disco (debounced)
    this.guardarBuffers();

    this.logger.info('comandero.item.agregado', {
      cuenta_id, item_id, producto_id, precio: itemPrecio, cantidad: itemCantidad
    });

    return {
      status: 201,
      data: {
        item,
        pedido: { cuenta_id, items: pedido.items, total: pedido.total }
      }
    };
  }

  async handleRemoveItem(data) {
    const invalid = this.validateInput('comandero.remove-item', data);
    if (invalid) return invalid;

    const { cuenta_id, item_id } = data;

    const pedido = this.pedidos.get(cuenta_id);
    if (!pedido) {
      return { status: 404, error: 'Pedido no encontrado' };
    }

    const itemIndex = pedido.items.findIndex(i => i.id === item_id);
    if (itemIndex === -1) {
      return { status: 404, error: 'Item no encontrado en pedido' };
    }

    const removedItem = pedido.items.splice(itemIndex, 1)[0];
    pedido.total = this.calcularTotal(pedido.items);

    this.metrics.increment('comandero.item_eliminado.total');

    await this.eventBus.publish('comandero.item_eliminado', {
      cuenta_id,
      item_id,
      producto_id: removedItem.producto_id,
      cantidad: removedItem.cantidad || 1,
      precio_total: removedItem.subtotal,
      pedido_total: pedido.total,
      pedido_items: pedido.items.reduce((s, i) => s + i.cantidad, 0)
    });

    // Persistir buffer a disco (debounced)
    this.guardarBuffers();

    this.logger.info('comandero.item.eliminado', { cuenta_id, item_id });

    return {
      status: 200,
      data: {
        pedido: { cuenta_id, items: pedido.items, total: pedido.total }
      }
    };
  }

  async handleUpdateItem(data) {
    const invalid = this.validateInput('comandero.update-item', data);
    if (invalid) return invalid;

    const { cuenta_id, item_id, cantidad, notas } = data;

    const pedido = this.pedidos.get(cuenta_id);
    if (!pedido) {
      return { status: 404, error: 'Pedido no encontrado' };
    }

    const item = pedido.items.find(i => i.id === item_id);
    if (!item) {
      return { status: 404, error: 'Item no encontrado en pedido' };
    }

    if (cantidad !== undefined) {
      if (cantidad <= 0) {
        // cantidad 0 o negativa → eliminar item
        const idx = pedido.items.indexOf(item);
        pedido.items.splice(idx, 1);
        pedido.total = this.calcularTotal(pedido.items);

        await this.eventBus.publish('comandero.item_eliminado', {
          cuenta_id, item_id, producto_id: item.producto_id,
          cantidad: item.cantidad || 1,
          precio_total: item.subtotal,
          pedido_total: pedido.total,
          pedido_items: pedido.items.reduce((s, i) => s + i.cantidad, 0)
        });

        return {
          status: 200,
          data: { pedido: { cuenta_id, items: pedido.items, total: pedido.total } }
        };
      }
      const cantidadAnterior = item.cantidad;
      const subtotalAnterior = item.subtotal;
      item.cantidad = cantidad;
      item.subtotal = item.precio * cantidad;

      pedido.total = this.calcularTotal(pedido.items);

      // Notificar cambio de cantidad para que cuentas actualice items/total
      const diffCantidad = cantidad - cantidadAnterior;
      const diffPrecio = item.subtotal - subtotalAnterior;
      await this.eventBus.publish('comandero.item_actualizado', {
        cuenta_id, item_id, producto_id: item.producto_id,
        nombre: item.nombre,
        cantidad_anterior: cantidadAnterior,
        cantidad_nueva: cantidad,
        diff_cantidad: diffCantidad,
        diff_precio: diffPrecio,
        pedido_total: pedido.total,
        pedido_items: pedido.items.reduce((s, i) => s + i.cantidad, 0)
      });

      // Persistir buffer a disco (debounced)
      this.guardarBuffers();

      this.logger.info('comandero.item.actualizado', { cuenta_id, item_id, cantidad, notas });

      return {
        status: 200,
        data: {
          item,
          pedido: { cuenta_id, items: pedido.items, total: pedido.total }
        }
      };
    }

    if (notas !== undefined) {
      item.notas = notas;
    }

    // Persistir buffer a disco (debounced)
    this.guardarBuffers();

    this.logger.info('comandero.item.actualizado', { cuenta_id, item_id, cantidad, notas });

    return {
      status: 200,
      data: {
        item,
        pedido: { cuenta_id, items: pedido.items, total: pedido.total }
      }
    };
  }

  async handleEnviarCocina(data) {
    const invalid = this.validateInput('comandero.send-kitchen', data);
    if (invalid) return invalid;

    const { cuenta_id, project_id } = data;

    const pedido = this.pedidos.get(cuenta_id);
    if (!pedido || pedido.items.length === 0) {
      return { status: 400, error: 'No hay items en el pedido para enviar' };
    }

    // Solo enviar items que no se hayan enviado aún
    const itemsParaEnviar = pedido.items.filter(i => !i.enviado);
    if (itemsParaEnviar.length === 0) {
      return { status: 400, error: 'Todos los items ya fueron enviados a cocina' };
    }

    const pedido_id = `ped_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const ahora = new Date().toISOString();

    // Marcar items como enviados
    for (const item of itemsParaEnviar) {
      item.enviado = true;
      item.enviado_at = ahora;
      item.pedido_id = pedido_id;
    }

    const totalEnviado = this.calcularTotal(itemsParaEnviar);

    this.metrics.increment('comandero.enviado.total');

    // comandero.enviar_cocina → Pedidos recoge, crea pedido formal, envía a cocina
    await this.eventBus.publish('comandero.enviar_cocina', {
      cuenta_id,
      pedido_id,
      project_id,
      items: itemsParaEnviar,
      total: totalEnviado,
      notas_generales: pedido.notas,
      created_at: ahora
    });

    // Persistir buffer a disco (items enviados ya no se guardan)
    this.guardarBuffers();

    this.logger.info('comandero.enviado_cocina', {
      cuenta_id, pedido_id, items_enviados: itemsParaEnviar.length, total_enviado: totalEnviado
    });

    return {
      status: 200,
      data: {
        cuenta_id,
        pedido_id,
        items_enviados: itemsParaEnviar.length,
        total_enviado: totalEnviado,
        pedido: { cuenta_id, items: pedido.items, total: pedido.total }
      }
    };
  }

  async handleListBuffers() {
    const buffers = [];
    for (const [cuenta_id, pedido] of this.pedidos.entries()) {
      // Solo items NO enviados a cocina (los enviados ya están en persistencia.pedidos[])
      const pendientes = pedido.items.filter(i => !i.enviado);
      if (pendientes.length === 0) continue;

      buffers.push({
        cuenta_id,
        total: this.calcularTotal(pendientes),
        items_count: pendientes.reduce((s, i) => s + i.cantidad, 0),
        items: pendientes.map(i => ({
          item_id: i.id,
          producto_id: i.producto_id,
          nombre: i.nombre,
          cantidad: i.cantidad,
          precio: i.precio,
          subtotal: i.subtotal
        }))
      });
    }

    return {
      status: 200,
      data: { buffers }
    };
  }

  async handleHealthCheck() {
    return {
      status: 200,
      data: {
        status: 'healthy',
        module: this.name,
        version: this.version,
        pedidos_activos: this.pedidos.size,
        productos_en_cache: this.productosCache.size,
        timestamp: new Date().toISOString()
      }
    };
  }

  // ==========================================
  // Persistencia transitoria del buffer
  // ==========================================

  /**
   * Restaura buffers del comandero desde disco.
   * Items no enviados a cocina sobreviven reinicio del servidor.
   */
  async restaurarBuffers() {
    try {
      const contenido = await fs.readFile(this._bufferFile, 'utf8');
      const datos = JSON.parse(contenido);

      if (!datos.buffers) return;

      let restaurados = 0;
      for (const [cuenta_id, buffer] of Object.entries(datos.buffers)) {
        if (!buffer.items || buffer.items.length === 0) continue;

        this.pedidos.set(cuenta_id, {
          items: buffer.items,
          notas: buffer.notas || '',
          total: this.calcularTotal(buffer.items)
        });
        restaurados++;
      }

      if (restaurados > 0) {
        this.logger.info('comandero.buffers_restaurados', {
          buffers_restaurados: restaurados,
          items_total: Array.from(this.pedidos.values()).reduce((s, p) => s + p.items.length, 0)
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn('comandero.restaurar.error', { error: error.message });
      }
    }
  }

  /**
   * Guarda buffers a disco (debounced 1s para no escribir en cada item).
   */
  guardarBuffers() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(async () => {
      try {
        const buffers = {};
        for (const [cuenta_id, pedido] of this.pedidos.entries()) {
          // Solo persistir items no enviados (los enviados ya están en persistencia-comandero)
          const itemsNoEnviados = pedido.items.filter(i => !i.enviado);
          if (itemsNoEnviados.length > 0) {
            buffers[cuenta_id] = {
              items: itemsNoEnviados,
              notas: pedido.notas,
              total: this.calcularTotal(itemsNoEnviados)
            };
          }
        }

        await fs.mkdir(path.dirname(this._bufferFile), { recursive: true });
        await fs.writeFile(this._bufferFile, JSON.stringify({ buffers, updated_at: new Date().toISOString() }, null, 2));
      } catch (error) {
        this.logger?.warn('comandero.guardar_buffers.error', { error: error.message });
      }
    }, 1000);
  }

  // ==========================================
  // Helpers
  // ==========================================

  calcularTotal(items) {
    return items.reduce((total, item) => total + item.subtotal, 0);
  }
}

module.exports = ComanderoModule;
