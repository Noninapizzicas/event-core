/**
 * Strategy: Llevar (Para llevar / Takeaway)
 * Tickets con display SSE, numeración diaria, dos fases (listo → entregado)
 *
 * Prefijo cuenta_id: llevar_{YYYYMMDD}_{seq}
 * Dominio uiHandler: 'llevar'
 * Eventos propios: llevar.ticket_creado, llevar.ticket_listo, llevar.ticket_entregado
 * Consume: cocina.pedido_listo
 */

class LlevarStrategy {
  constructor() {
    this.tipo = 'llevar';
    this.prefijo = 'llevar_';
    this.version = '3.0.0';

    this.ticketsActivos = new Map();
    this.ticketsListos = new Map();
    this.displayClients = new Set();

    this.internalMetrics = {
      tickets_creados: 0,
      tickets_listos: 0,
      tickets_entregados: 0
    };

    this.modulo = null;
    this._uiActions = [
      'crear', 'marcar_listo', 'entregar', 'activos',
      'listos', 'get', 'health', 'metrics'
    ];
  }

  // ==========================================
  // Strategy Interface
  // ==========================================

  async init(modulo) {
    this.modulo = modulo;

    modulo.safeAddSchema(require('../schemas/llevar.json'));
    modulo.safeAddSchema(require('../schemas/llevar-events.json'));

    // Restaurar tickets activos desde persistencia
    await this.restaurarDesdeArchivo();
  }

  registerUIHandlers(uiHandler) {
    uiHandler.register('llevar', 'crear', this.handleCrearTicket.bind(this));
    uiHandler.register('llevar', 'marcar_listo', this.handleMarcarListo.bind(this));
    uiHandler.register('llevar', 'entregar', this.handleEntregar.bind(this));
    uiHandler.register('llevar', 'activos', this.handleGetActivos.bind(this));
    uiHandler.register('llevar', 'listos', this.handleGetListos.bind(this));
    uiHandler.register('llevar', 'get', this.handleGetTicket.bind(this));
    uiHandler.register('llevar', 'health', this.handleHealthCheck.bind(this));
    uiHandler.register('llevar', 'metrics', this.handleGetMetrics.bind(this));

    this.modulo.logger.info('canal.llevar.ui_handlers.registered', {
      handlers: this._uiActions
    });
  }

  unregisterUIHandlers(uiHandler) {
    for (const action of this._uiActions) {
      uiHandler.unregister('llevar', action);
    }
  }

  async subscribeToEvents(eventBus) {
    await eventBus.subscribe('cocina.pedido_listo', this.onCocinaPedidoListo.bind(this));
  }

  async onCobroProcesado(cuenta_id, correlationId) {
    const ticket = this.ticketsActivos.get(cuenta_id);
    if (!ticket) return;

    ticket.pagado = true;
    ticket.hora_pago = new Date().toISOString();

    this.modulo.logger.info('llevar.ticket_pagado', {
      correlation_id: correlationId,
      numero_ticket: ticket.numero_ticket,
      estado: ticket.estado
    });

    // Llevar NO cierra al cobrar (a diferencia de mesa).
    // El ticket se mantiene visible hasta que se entregue al cliente.
    // Solo marcamos pagado y esperamos a que se llame a entregar.
  }

  getHealth() {
    return {
      tickets_activos: this.ticketsActivos.size,
      tickets_listos: this.ticketsListos.size,
      display_clients: this.displayClients.size
    };
  }

  getMetrics() {
    return {
      ...this.internalMetrics,
      tickets_activos: this.ticketsActivos.size,
      tickets_listos: this.ticketsListos.size,
      display_clients: this.displayClients.size,
      tiempo_promedio_preparacion: this.modulo.getPromedioTiempo('llevar_preparacion'),
      tiempo_promedio_espera: this.modulo.getPromedioTiempo('llevar_espera')
    };
  }

  getCuentasActivas() {
    return this.ticketsActivos.size;
  }

  cleanup() {
    this.displayClients.clear();
    this.ticketsActivos.clear();
    this.ticketsListos.clear();
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  async onCocinaPedidoListo(event) {
    const eventData = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;
    const { pedido_id } = eventData;

    let ticket = null;
    for (const t of this.ticketsActivos.values()) {
      if (t.pedidos && t.pedidos.includes(pedido_id)) {
        ticket = t;
        break;
      }
    }

    if (!ticket) return;

    await this.marcarListo(ticket.cuenta_id, correlationId);

    this.modulo.logger.info('canal.llevar.ticket_listo_auto', {
      correlation_id: correlationId,
      numero_ticket: ticket.numero_ticket
    });
  }

  // ==========================================
  // UI Handlers
  // ==========================================

  async handleCrearTicket(data) {
    try {
      const validate = this.modulo.ajv.getSchema(
        'https://pizzepos.com/schemas/llevar.json#/definitions/crear_ticket_request'
      );
      if (validate && !validate(data)) {
        return { status: 400, error: 'Request inválido', details: validate.errors };
      }

      const { cliente_nombre, notas, project_id } = data;

      this.modulo.verificarReseoDiario();

      const secuencial = this.modulo.getNextSecuencial('llevar');
      const fecha = this.modulo.getFechaActual();
      const cuenta_id = `llevar_${fecha}_${secuencial.toString().padStart(3, '0')}`;
      const numero_ticket = secuencial;

      const ticket = {
        cuenta_id,
        numero_ticket,
        cliente_nombre: cliente_nombre || `Cliente ${numero_ticket}`,
        estado: 'pendiente',
        pagado: false,
        total: 0,
        hora_creacion: new Date().toISOString(),
        pedidos: [],
        notas: notas || '',
        mostrado_en_display: false
      };

      this.ticketsActivos.set(cuenta_id, ticket);
      this.internalMetrics.tickets_creados++;

      await this.modulo.eventBus.publish('llevar.ticket_creado', {
        cuenta_id: ticket.cuenta_id,
        numero_ticket: ticket.numero_ticket,
        cliente_nombre: ticket.cliente_nombre,
        hora_creacion: ticket.hora_creacion,
        project_id
      });

      await this.modulo.publishCuentaCreada({
        cuenta_id: ticket.cuenta_id,
        tipo: 'llevar',
        total: ticket.total,
        project_id,
        metadata: {
          nombre: String(numero_ticket).padStart(3, '0'),
          cliente_nombre: ticket.cliente_nombre,
          numero_ticket: ticket.numero_ticket
        }
      });

      this.modulo.logger.info('llevar.ticket_creado', {
        cuenta_id,
        numero_ticket
      });

      return { status: 201, data: ticket };

    } catch (error) {
      this.modulo.logger.error('canal.llevar.crear.error', { error: error.message });
      return { status: 500, error: 'Error interno creando ticket' };
    }
  }

  async handleMarcarListo(data) {
    const { cuenta_id } = data;

    try {
      await this.marcarListo(cuenta_id);
      return { status: 200, data: { message: 'Ticket marcado como listo' } };
    } catch (error) {
      this.modulo.logger.error('canal.llevar.marcar_listo.error', { error: error.message });
      return { status: 500, error: error.message };
    }
  }

  async handleEntregar(data) {
    const { cuenta_id } = data;

    try {
      await this.marcarEntregado(cuenta_id);
      return { status: 200, data: { message: 'Ticket entregado' } };
    } catch (error) {
      this.modulo.logger.error('canal.llevar.entregar.error', { error: error.message });
      return { status: 500, error: error.message };
    }
  }

  async handleGetActivos() {
    const activos = Array.from(this.ticketsActivos.values())
      .filter(t => t.estado === 'pendiente' || t.estado === 'preparando')
      .sort((a, b) => new Date(a.hora_creacion) - new Date(b.hora_creacion));

    return {
      status: 200,
      data: { tickets: activos, total: activos.length }
    };
  }

  async handleGetListos() {
    const listos = Array.from(this.ticketsListos.values())
      .sort((a, b) => new Date(b.hora_listo) - new Date(a.hora_listo));

    const config = this.modulo.config;
    const maxMostrar = config.display?.max_numeros_mostrar || 10;
    const paraDisplay = listos.slice(0, maxMostrar);

    return {
      status: 200,
      data: { tickets: paraDisplay, total: listos.length }
    };
  }

  async handleGetTicket(data) {
    const { cuenta_id } = data;

    const ticket = this.ticketsActivos.get(cuenta_id) ||
      this.ticketsListos.get(parseInt(cuenta_id));

    if (!ticket) {
      return { status: 404, error: 'Ticket no encontrado' };
    }

    return { status: 200, data: ticket };
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
      let maxSeq = 0;
      for (const [cuenta_id, cuenta] of Object.entries(datos.cuentas)) {
        if (!cuenta_id.startsWith(this.prefijo)) continue;

        const seqMatch = cuenta_id.match(/_(\d+)$/);
        const seq = seqMatch ? parseInt(seqMatch[1], 10) : (restaurados + 1);
        if (seq > maxSeq) maxSeq = seq;

        const ticket = {
          cuenta_id,
          numero_ticket: seq,
          cliente_nombre: cuenta.datos_especificos?.cliente_nombre
            || cuenta.datos_especificos?.numero_ticket
            || `Cliente ${seq}`,
          estado: 'pendiente',
          pagado: false,
          total: cuenta.total || 0,
          hora_creacion: cuenta.created_at || new Date().toISOString(),
          pedidos: (cuenta.pedidos || []).map(p => p.pedido_id),
          notas: '',
          mostrado_en_display: false
        };

        this.ticketsActivos.set(cuenta_id, ticket);
        restaurados++;
      }

      if (restaurados > 0) {
        this.modulo.logger.info('canal.llevar.estado_restaurado', {
          tickets_restaurados: restaurados
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.modulo?.logger?.warn('canal.llevar.restaurar.error', { error: error.message });
      }
    }
  }

  // ==========================================
  // Business Logic
  // ==========================================

  async marcarListo(cuenta_id, correlationId) {
    const ticket = this.ticketsActivos.get(cuenta_id);
    if (!ticket) {
      throw new Error('Ticket no encontrado');
    }

    ticket.estado = 'listo';
    ticket.hora_listo = new Date().toISOString();
    ticket.tiempo_preparacion = this.modulo.calcularTiempoMinutos(ticket.hora_creacion);
    ticket.mostrado_en_display = true;

    this.internalMetrics.tickets_listos++;
    this.modulo.trackTiempo('llevar_preparacion', ticket.tiempo_preparacion);

    this.ticketsListos.set(ticket.numero_ticket, ticket);

    await this.modulo.eventBus.publish('llevar.ticket_listo', {
      cuenta_id: ticket.cuenta_id,
      numero_ticket: ticket.numero_ticket,
      cliente_nombre: ticket.cliente_nombre,
      hora_listo: ticket.hora_listo,
      tiempo_preparacion: ticket.tiempo_preparacion
    }, { correlationId });

    this.broadcastDisplay({
      type: 'ticket_listo',
      data: {
        numero_ticket: ticket.numero_ticket,
        cliente_nombre: ticket.cliente_nombre
      }
    });

    this.modulo.logger.info('llevar.ticket_listo', {
      correlation_id: correlationId,
      numero_ticket: ticket.numero_ticket
    });
  }

  async marcarEntregado(cuenta_id, correlationId) {
    const ticket = this.ticketsActivos.get(cuenta_id);
    if (!ticket) {
      throw new Error('Ticket no encontrado');
    }

    ticket.estado = 'entregado';
    ticket.hora_entrega = new Date().toISOString();

    if (ticket.hora_listo) {
      ticket.tiempo_espera = this.modulo.calcularTiempoMinutos(ticket.hora_listo);
      this.modulo.trackTiempo('llevar_espera', ticket.tiempo_espera);
    }

    this.internalMetrics.tickets_entregados++;

    await this.modulo.eventBus.publish('llevar.ticket_entregado', {
      cuenta_id: ticket.cuenta_id,
      numero_ticket: ticket.numero_ticket,
      total: ticket.total,
      tiempo_espera: ticket.tiempo_espera,
      hora_entrega: ticket.hora_entrega
    }, { correlationId });

    // Entregar siempre cierra el ticket (es el fin del ciclo de llevar).
    // Si no está pagado, queda pendiente de cobro pero ya no es cuenta activa.
    if (!ticket.pagado) {
      this.modulo.logger.info('llevar.ticket_entregado_pendiente_pago', {
        correlation_id: correlationId,
        numero_ticket: ticket.numero_ticket
      });
    }

    await this.cerrarTicket(cuenta_id, correlationId);
  }

  async cerrarTicket(cuenta_id, correlationId) {
    const ticket = this.ticketsActivos.get(cuenta_id);
    if (!ticket) return;

    await this.modulo.publishCuentaCerrada({
      cuenta_id: ticket.cuenta_id,
      tipo: 'llevar',
      total: ticket.total,
      metadata: {
        numero_ticket: ticket.numero_ticket,
        tiempo_espera: ticket.tiempo_espera
      }
    }, correlationId);

    this.ticketsActivos.delete(cuenta_id);
    this.ticketsListos.delete(ticket.numero_ticket);

    this.broadcastDisplay({
      type: 'ticket_entregado',
      data: { numero_ticket: ticket.numero_ticket }
    });

    this.modulo.logger.info('llevar.ticket_cerrado', {
      correlation_id: correlationId,
      numero_ticket: ticket.numero_ticket
    });
  }

  // ==========================================
  // SSE Display (propio de Llevar)
  // ==========================================

  broadcastDisplay(message) {
    for (const client of this.displayClients) {
      try {
        client.send(message);
      } catch (error) {
        this.modulo.logger.warn('canal.llevar.sse.error', {
          client_id: client.id,
          error: error.message
        });
        this.displayClients.delete(client);
      }
    }
  }
}

module.exports = LlevarStrategy;
