/**
 * Strategy: Teléfono
 * Gestión de pedidos telefónicos con caller ID, CRM y WhatsApp
 *
 * Prefijo cuenta_id: tel_{YYYYMMDD}_{seq}
 * Dominio uiHandler: 'telefono'
 * Eventos propios: telefono.llamada_detectada, telefono.contacto_identificado,
 *                  telefono.pedido_creado, telefono.listo_para_recoger
 * Consume: cocina.pedido_listo
 */

class TelefonoStrategy {
  constructor() {
    this.tipo = 'telefono';
    this.prefijo = 'tel_';
    this.version = '3.0.0';

    this.pedidosActivos = new Map();
    this.contactos = new Map();

    this.internalMetrics = {
      llamadas_recibidas: 0,
      contactos_identificados: 0,
      pedidos_creados: 0,
      whatsapp_enviados: 0
    };

    this.modulo = null;
    this._uiActions = [
      'llamada', 'crear_pedido', 'pendientes', 'get',
      'marcar_listo', 'marcar_recogido', 'contactos', 'guardar_contacto',
      'health', 'metrics'
    ];
  }

  // ==========================================
  // Strategy Interface
  // ==========================================

  async init(modulo) {
    this.modulo = modulo;

    modulo.safeAddSchema(require('../schemas/telefono.json'));
    modulo.safeAddSchema(require('../schemas/telefono-events.json'));

    // Restaurar pedidos telefónicos activos desde persistencia
    await this.restaurarDesdeArchivo();
  }

  registerUIHandlers(uiHandler) {
    uiHandler.register('telefono', 'llamada', this.handleLlamadaEntrante.bind(this));
    uiHandler.register('telefono', 'crear_pedido', this.handleCrearPedido.bind(this));
    uiHandler.register('telefono', 'pendientes', this.handleGetPendientes.bind(this));
    uiHandler.register('telefono', 'get', this.handleGetPedido.bind(this));
    uiHandler.register('telefono', 'marcar_listo', this.handleMarcarListo.bind(this));
    uiHandler.register('telefono', 'marcar_recogido', this.handleMarcarRecogido.bind(this));
    uiHandler.register('telefono', 'contactos', this.handleGetContactos.bind(this));
    uiHandler.register('telefono', 'guardar_contacto', this.handleGuardarContacto.bind(this));
    uiHandler.register('telefono', 'health', this.handleHealthCheck.bind(this));
    uiHandler.register('telefono', 'metrics', this.handleGetMetrics.bind(this));

    this.modulo.logger.info('canal.telefono.ui_handlers.registered', {
      handlers: this._uiActions
    });
  }

  unregisterUIHandlers(uiHandler) {
    for (const action of this._uiActions) {
      uiHandler.unregister('telefono', action);
    }
  }

  async subscribeToEvents(eventBus) {
    await eventBus.subscribe('cocina.pedido_listo', this.onCocinaPedidoListo.bind(this));
  }

  async onCobroProcesado(cuenta_id, correlationId) {
    const pedido = this.pedidosActivos.get(cuenta_id);
    if (!pedido) return;

    pedido.pagado = true;
    pedido.hora_pago = new Date().toISOString();

    this.modulo.logger.info('telefono.pedido_pagado', {
      correlation_id: correlationId,
      cuenta_id,
      estado: pedido.estado
    });

    // Si ya fue recogido físicamente, cerrar la cuenta
    if (pedido.estado === 'recogido') {
      await this.cerrarCuenta(cuenta_id, correlationId);
    }
  }

  getHealth() {
    return {
      pedidos_activos: this.pedidosActivos.size,
      contactos_guardados: this.contactos.size
    };
  }

  getMetrics() {
    return {
      ...this.internalMetrics,
      pedidos_activos: this.pedidosActivos.size,
      contactos_guardados: this.contactos.size,
      tiempo_promedio_preparacion: this.modulo.getPromedioTiempo('telefono_preparacion')
    };
  }

  getCuentasActivas() {
    return this.pedidosActivos.size;
  }

  cleanup() {
    this.pedidosActivos.clear();
    this.contactos.clear();
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  async onCocinaPedidoListo(event) {
    const eventData = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;
    const { pedido_id } = eventData;

    let pedidoTelefono = null;
    for (const pedido of this.pedidosActivos.values()) {
      if (pedido.pedidos && pedido.pedidos.includes(pedido_id)) {
        pedidoTelefono = pedido;
        break;
      }
    }

    if (!pedidoTelefono) return;

    await this.marcarListo(pedidoTelefono.cuenta_id, correlationId);

    this.modulo.logger.info('canal.telefono.pedido_listo_auto', {
      correlation_id: correlationId,
      cuenta_id: pedidoTelefono.cuenta_id
    });
  }

  // ==========================================
  // UI Handlers
  // ==========================================

  async handleLlamadaEntrante(data) {
    try {
      const validate = this.modulo.ajv.getSchema(
        'https://pizzepos.com/schemas/telefono.json#/definitions/llamada_entrante_request'
      );
      if (validate && !validate(data)) {
        return { status: 400, error: 'Request inválido', details: validate.errors };
      }

      const { telefono, caller_name } = data;

      this.internalMetrics.llamadas_recibidas++;

      await this.modulo.eventBus.publish('telefono.llamada_detectada', {
        telefono,
        caller_name,
        timestamp: new Date().toISOString()
      });

      const contacto = this.contactos.get(telefono);
      if (contacto) {
        this.internalMetrics.contactos_identificados++;

        await this.modulo.eventBus.publish('telefono.contacto_identificado', {
          telefono: contacto.telefono,
          nombre: contacto.nombre,
          pedidos_anteriores: contacto.pedidos_anteriores,
          ultima_compra: contacto.ultima_compra
        });

        this.modulo.logger.info('canal.telefono.contacto_identificado', {
          telefono,
          nombre: contacto.nombre
        });

        return { status: 200, data: { identificado: true, contacto } };
      }

      return { status: 200, data: { identificado: false, telefono } };

    } catch (error) {
      this.modulo.logger.error('canal.telefono.llamada.error', { error: error.message });
      return { status: 500, error: 'Error interno procesando llamada' };
    }
  }

  async handleCrearPedido(data) {
    try {
      const validate = this.modulo.ajv.getSchema(
        'https://pizzepos.com/schemas/telefono.json#/definitions/crear_pedido_request'
      );
      if (validate && !validate(data)) {
        return { status: 400, error: 'Request inválido', details: validate.errors };
      }

      const { telefono, nombre, hora_recogida_estimada, tiempo_preparacion, notas } = data;

      this.modulo.verificarReseoDiario();

      const secuencial = this.modulo.getNextSecuencial('telefono');
      const fecha = this.modulo.getFechaActual();
      const cuenta_id = `tel_${fecha}_${secuencial.toString().padStart(3, '0')}`;
      const numero_pedido = secuencial;

      let horaRecogida = hora_recogida_estimada;
      if (!horaRecogida) {
        const minutos = tiempo_preparacion || 20;
        const now = new Date();
        now.setMinutes(now.getMinutes() + minutos);
        horaRecogida = now.toISOString();
      }

      const contacto = this.contactos.get(telefono);

      const pedido = {
        cuenta_id,
        numero_pedido,
        telefono,
        caller_id_detectado: !!contacto,
        contacto: contacto || {
          telefono,
          nombre: nombre || 'Cliente',
          pedidos_anteriores: 0
        },
        estado: 'pendiente',
        pagado: false,
        total: 0,
        hora_pedido: new Date().toISOString(),
        hora_recogida_estimada: horaRecogida,
        whatsapp_enviado: false,
        pedidos: [],
        notas: notas || ''
      };

      this.pedidosActivos.set(cuenta_id, pedido);
      this.internalMetrics.pedidos_creados++;

      await this.modulo.eventBus.publish('telefono.pedido_creado', {
        cuenta_id: pedido.cuenta_id,
        numero_pedido: pedido.numero_pedido,
        telefono: pedido.telefono,
        nombre: pedido.contacto.nombre,
        hora_recogida_estimada: pedido.hora_recogida_estimada
      });

      await this.modulo.publishCuentaCreada({
        cuenta_id: pedido.cuenta_id,
        tipo: 'telefono',
        total: pedido.total,
        metadata: {
          nombre: pedido.contacto.nombre,
          telefono: pedido.telefono,
          hora_recogida_estimada: pedido.hora_recogida_estimada
        }
      });

      this.modulo.logger.info('telefono.pedido_creado', {
        cuenta_id,
        numero_pedido,
        telefono
      });

      return { status: 201, data: pedido };

    } catch (error) {
      this.modulo.logger.error('canal.telefono.crear_pedido.error', { error: error.message });
      return { status: 500, error: 'Error interno creando pedido' };
    }
  }

  async handleGetPendientes() {
    const pendientes = Array.from(this.pedidosActivos.values())
      .filter(p => p.estado === 'pendiente' || p.estado === 'preparando')
      .sort((a, b) => new Date(a.hora_pedido) - new Date(b.hora_pedido));

    return {
      status: 200,
      data: { pedidos: pendientes, total: pendientes.length }
    };
  }

  async handleGetPedido(data) {
    const { cuenta_id } = data;
    const pedido = this.pedidosActivos.get(cuenta_id);

    if (!pedido) {
      return { status: 404, error: 'Pedido no encontrado' };
    }

    return { status: 200, data: pedido };
  }

  async handleMarcarListo(data) {
    const { cuenta_id } = data;

    try {
      await this.marcarListo(cuenta_id);
      return { status: 200, data: { message: 'Pedido marcado como listo y WhatsApp enviado' } };
    } catch (error) {
      this.modulo.logger.error('canal.telefono.marcar_listo.error', { error: error.message });
      return { status: 500, error: error.message };
    }
  }

  async handleMarcarRecogido(data) {
    const { cuenta_id } = data;

    try {
      await this.marcarRecogido(cuenta_id);
      return { status: 200, data: { message: 'Pedido marcado como recogido' } };
    } catch (error) {
      this.modulo.logger.error('canal.telefono.marcar_recogido.error', { error: error.message });
      return { status: 500, error: error.message };
    }
  }

  async handleGetContactos(data) {
    const { buscar } = data || {};
    let contactos = Array.from(this.contactos.values());

    if (buscar) {
      const term = buscar.toLowerCase();
      contactos = contactos.filter(c =>
        c.nombre.toLowerCase().includes(term) ||
        c.telefono.includes(term)
      );
    }

    contactos.sort((a, b) => {
      if (!a.ultima_compra) return 1;
      if (!b.ultima_compra) return -1;
      return new Date(b.ultima_compra) - new Date(a.ultima_compra);
    });

    return {
      status: 200,
      data: { contactos, total: contactos.length }
    };
  }

  async handleGuardarContacto(data) {
    try {
      const validate = this.modulo.ajv.getSchema(
        'https://pizzepos.com/schemas/telefono.json#/definitions/guardar_contacto_request'
      );
      if (validate && !validate(data)) {
        return { status: 400, error: 'Request inválido', details: validate.errors };
      }

      const { telefono, nombre, direccion, email, notas } = data;
      const existente = this.contactos.get(telefono);

      const contacto = {
        telefono,
        nombre,
        direccion: direccion || existente?.direccion || '',
        email: email || existente?.email || '',
        notas: notas || existente?.notas || '',
        pedidos_anteriores: existente?.pedidos_anteriores || 0,
        ultima_compra: existente?.ultima_compra
      };

      this.contactos.set(telefono, contacto);

      this.modulo.logger.info('telefono.contacto_guardado', { telefono, nombre });

      return { status: 200, data: contacto };

    } catch (error) {
      this.modulo.logger.error('canal.telefono.guardar_contacto.error', { error: error.message });
      return { status: 500, error: 'Error interno guardando contacto' };
    }
  }

  async handleHealthCheck() {
    return { status: 200, data: this.getHealth() };
  }

  async handleGetMetrics() {
    return { status: 200, data: this.getMetrics() };
  }

  // ==========================================
  // Restauración desde persistencia
  // ==========================================

  async restaurarDesdeArchivo() {
    try {
      const fs = require('fs').promises;
      const path = require('path');
      const archivo = path.join('./data/current', 'cuentas_activas.json');
      const contenido = await fs.readFile(archivo, 'utf8');
      const datos = JSON.parse(contenido);

      if (!datos.cuentas) return;

      let restaurados = 0;
      for (const [cuenta_id, cuenta] of Object.entries(datos.cuentas)) {
        if (!cuenta_id.startsWith(this.prefijo)) continue;

        const numMatch = cuenta_id.match(/_(\d+)$/);
        const numero = numMatch ? parseInt(numMatch[1], 10) : (restaurados + 1);

        const pedido = {
          cuenta_id,
          numero_pedido: numero,
          telefono: cuenta.datos_especificos?.telefono || '',
          caller_id_detectado: false,
          contacto: {
            telefono: cuenta.datos_especificos?.telefono || '',
            nombre: cuenta.datos_especificos?.nombre || 'Cliente',
            pedidos_anteriores: 0
          },
          estado: 'pendiente',
          pagado: false,
          total: cuenta.total || 0,
          hora_pedido: cuenta.created_at || new Date().toISOString(),
          hora_recogida_estimada: null,
          whatsapp_enviado: false,
          pedidos: (cuenta.pedidos || []).map(p => p.pedido_id),
          notas: ''
        };

        this.pedidosActivos.set(cuenta_id, pedido);
        restaurados++;
      }

      if (restaurados > 0) {
        this.modulo.logger.info('canal.telefono.estado_restaurado', {
          pedidos_restaurados: restaurados
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.modulo?.logger?.warn('canal.telefono.restaurar.error', { error: error.message });
      }
    }
  }

  // ==========================================
  // Business Logic
  // ==========================================

  async marcarListo(cuenta_id, correlationId) {
    const pedido = this.pedidosActivos.get(cuenta_id);
    if (!pedido) {
      throw new Error('Pedido no encontrado');
    }

    pedido.estado = 'listo';

    const config = this.modulo.config;
    if (config.whatsapp?.enabled && !pedido.whatsapp_enviado) {
      const mensaje = this.generarMensajeWhatsApp(pedido);
      await this.enviarWhatsApp(pedido.telefono, mensaje, correlationId);
      pedido.whatsapp_enviado = true;
      pedido.whatsapp_enviado_at = new Date().toISOString();
      this.internalMetrics.whatsapp_enviados++;
    }

    const mensaje = this.generarMensajeWhatsApp(pedido);

    await this.modulo.eventBus.publish('telefono.listo_para_recoger', {
      cuenta_id: pedido.cuenta_id,
      numero_pedido: pedido.numero_pedido,
      telefono: pedido.telefono,
      nombre: pedido.contacto.nombre,
      total: pedido.total,
      whatsapp_message: mensaje
    }, { correlationId });

    const contacto = this.contactos.get(pedido.telefono);
    if (contacto) {
      contacto.pedidos_anteriores++;
      contacto.ultima_compra = new Date().toISOString();
    }

    this.modulo.logger.info('telefono.pedido_listo', {
      correlation_id: correlationId,
      cuenta_id,
      whatsapp_enviado: pedido.whatsapp_enviado
    });
  }

  async marcarRecogido(cuenta_id, correlationId) {
    const pedido = this.pedidosActivos.get(cuenta_id);
    if (!pedido) {
      throw new Error('Pedido no encontrado');
    }

    pedido.estado = 'recogido';
    pedido.hora_recogida_real = new Date().toISOString();

    const tiempoPreparacion = (new Date(pedido.hora_recogida_real) - new Date(pedido.hora_pedido)) / 1000 / 60;
    this.modulo.trackTiempo('telefono_preparacion', tiempoPreparacion);

    this.modulo.logger.info('telefono.pedido_recogido', {
      correlation_id: correlationId,
      cuenta_id,
      pagado: pedido.pagado
    });

    // Solo cerrar si ya pagado; si no, esperar el cobro
    if (pedido.pagado) {
      await this.cerrarCuenta(cuenta_id, correlationId);
    }
  }

  async cerrarCuenta(cuenta_id, correlationId) {
    const pedido = this.pedidosActivos.get(cuenta_id);
    if (!pedido) return;

    await this.modulo.publishCuentaCerrada({
      cuenta_id: pedido.cuenta_id,
      tipo: 'telefono',
      total: pedido.total,
      metadata: {
        numero_pedido: pedido.numero_pedido,
        telefono: pedido.telefono
      }
    }, correlationId);

    this.pedidosActivos.delete(cuenta_id);

    this.modulo.logger.info('telefono.cuenta_cerrada', {
      correlation_id: correlationId,
      cuenta_id,
      total: pedido.total
    });
  }

  // ==========================================
  // Helpers propios de Teléfono
  // ==========================================

  generarMensajeWhatsApp(pedido) {
    const config = this.modulo.config;
    const template = config.whatsapp?.template_listo ||
      '¡Hola {{nombre}}! Tu pedido #{{numero}} está listo para recoger. Te esperamos.';

    return template
      .replace('{{nombre}}', pedido.contacto.nombre)
      .replace('{{numero}}', pedido.numero_pedido);
  }

  async enviarWhatsApp(telefono, mensaje, correlationId) {
    // TODO: Integrar con Twilio/WhatsApp Business API
    this.modulo.logger.info('telefono.whatsapp_enviado', {
      correlation_id: correlationId,
      telefono,
      mensaje
    });
  }
}

module.exports = TelefonoStrategy;
