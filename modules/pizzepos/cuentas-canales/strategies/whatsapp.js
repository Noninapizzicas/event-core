/**
 * Strategy: WhatsApp (Pedidos directos por WhatsApp)
 * Canal de pedidos vía WhatsApp Business API — conversación asíncrona
 * Distinto de teléfono: aquí no hay llamada, sino mensajes de texto/multimedia
 *
 * Flujo: mensaje entrante → parseo → creación pedido → confirmación → listo → entrega/recogida
 *
 * Prefijo cuenta_id: wa_{YYYYMMDD}_{seq}
 * Dominio uiHandler: 'whatsapp'
 * Eventos propios: whatsapp.mensaje_recibido, whatsapp.pedido_creado,
 *                  whatsapp.pedido_confirmado, whatsapp.pedido_listo
 * Consume: cocina.pedido_listo
 */

class WhatsAppStrategy {
  constructor() {
    this.tipo = 'whatsapp';
    this.prefijo = 'wa_';
    this.version = '3.0.0';

    // Pedidos activos por WhatsApp
    this.pedidosActivos = new Map();

    // Conversaciones activas: telefono → { estado, mensajes[], cuenta_id? }
    this.conversaciones = new Map();

    // Contactos conocidos (compartido con TelefonoStrategy idealmente, por ahora independiente)
    this.contactos = new Map();

    this.internalMetrics = {
      mensajes_recibidos: 0,
      pedidos_creados: 0,
      pedidos_confirmados: 0,
      pedidos_listos: 0,
      pedidos_entregados: 0,
      mensajes_enviados: 0
    };

    this.modulo = null;
    this._uiActions = [
      'mensaje', 'crear_pedido', 'confirmar', 'marcar_listo',
      'activos', 'get', 'conversaciones', 'enviar',
      'health', 'metrics'
    ];
  }

  // ==========================================
  // Strategy Interface
  // ==========================================

  async init(modulo) {
    this.modulo = modulo;

    modulo.safeAddSchema(require('../schemas/whatsapp.json'));
    modulo.safeAddSchema(require('../schemas/whatsapp-events.json'));
  }

  registerUIHandlers(uiHandler) {
    uiHandler.register('whatsapp', 'mensaje', this.handleMensajeRecibido.bind(this));
    uiHandler.register('whatsapp', 'crear_pedido', this.handleCrearPedido.bind(this));
    uiHandler.register('whatsapp', 'confirmar', this.handleConfirmarPedido.bind(this));
    uiHandler.register('whatsapp', 'marcar_listo', this.handleMarcarListo.bind(this));
    uiHandler.register('whatsapp', 'activos', this.handleGetActivos.bind(this));
    uiHandler.register('whatsapp', 'get', this.handleGetPedido.bind(this));
    uiHandler.register('whatsapp', 'conversaciones', this.handleGetConversaciones.bind(this));
    uiHandler.register('whatsapp', 'enviar', this.handleEnviarMensaje.bind(this));
    uiHandler.register('whatsapp', 'health', this.handleHealthCheck.bind(this));
    uiHandler.register('whatsapp', 'metrics', this.handleGetMetrics.bind(this));

    this.modulo.logger.info('canal.whatsapp.ui_handlers.registered', {
      handlers: this._uiActions
    });
  }

  unregisterUIHandlers(uiHandler) {
    for (const action of this._uiActions) {
      uiHandler.unregister('whatsapp', action);
    }
  }

  async subscribeToEvents(eventBus) {
    await eventBus.subscribe('cocina.pedido_listo', this.onCocinaPedidoListo.bind(this));
  }

  async onCobroProcesado(cuenta_id, correlationId) {
    await this.cerrarPedido(cuenta_id, correlationId);
  }

  getHealth() {
    return {
      pedidos_activos: this.pedidosActivos.size,
      conversaciones_activas: this.conversaciones.size,
      contactos: this.contactos.size
    };
  }

  getMetrics() {
    return {
      ...this.internalMetrics,
      pedidos_activos: this.pedidosActivos.size,
      conversaciones_activas: this.conversaciones.size,
      tiempo_promedio_preparacion: this.modulo.getPromedioTiempo('whatsapp_preparacion')
    };
  }

  getCuentasActivas() {
    return this.pedidosActivos.size;
  }

  cleanup() {
    this.pedidosActivos.clear();
    this.conversaciones.clear();
    this.contactos.clear();
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  async onCocinaPedidoListo(event) {
    const eventData = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;
    const { pedido_id } = eventData;

    let pedidoWA = null;
    for (const pedido of this.pedidosActivos.values()) {
      if (pedido.pedidos && pedido.pedidos.includes(pedido_id)) {
        pedidoWA = pedido;
        break;
      }
    }

    if (!pedidoWA) return;

    await this.notificarListo(pedidoWA.cuenta_id, correlationId);

    this.modulo.logger.info('canal.whatsapp.pedido_listo_auto', {
      correlation_id: correlationId,
      cuenta_id: pedidoWA.cuenta_id
    });
  }

  // ==========================================
  // UI Handlers
  // ==========================================

  async handleMensajeRecibido(data) {
    try {
      const validate = this.modulo.ajv.getSchema(
        'https://pizzepos.com/schemas/whatsapp.json#/definitions/mensaje_recibido_request'
      );
      if (validate && !validate(data)) {
        return { status: 400, error: 'Request inválido', details: validate.errors };
      }

      const { telefono, nombre, mensaje, tipo_mensaje, media_url } = data;

      this.internalMetrics.mensajes_recibidos++;

      // Obtener o crear conversación
      let conversacion = this.conversaciones.get(telefono);
      if (!conversacion) {
        conversacion = {
          telefono,
          nombre: nombre || 'Cliente WhatsApp',
          estado: 'nueva',
          mensajes: [],
          cuenta_id: null,
          inicio: new Date().toISOString()
        };
        this.conversaciones.set(telefono, conversacion);
      }

      // Registrar mensaje en la conversación
      conversacion.mensajes.push({
        direccion: 'entrante',
        tipo: tipo_mensaje || 'text',
        contenido: mensaje,
        media_url: media_url || null,
        timestamp: new Date().toISOString()
      });

      // Actualizar contacto
      if (!this.contactos.has(telefono)) {
        this.contactos.set(telefono, {
          telefono,
          nombre: nombre || 'Cliente WhatsApp',
          pedidos_anteriores: 0,
          primera_interaccion: new Date().toISOString()
        });
      }

      await this.modulo.eventBus.publish('whatsapp.mensaje_recibido', {
        telefono,
        nombre: conversacion.nombre,
        mensaje,
        tipo_mensaje: tipo_mensaje || 'text',
        conversacion_estado: conversacion.estado
      });

      // Auto-respuesta si está configurada
      const autoReply = this.generarAutoRespuesta(conversacion, mensaje);

      this.modulo.logger.info('whatsapp.mensaje_recibido', {
        telefono,
        tipo: tipo_mensaje || 'text',
        conversacion_estado: conversacion.estado
      });

      return {
        status: 200,
        data: {
          conversacion_id: telefono,
          estado: conversacion.estado,
          auto_reply: autoReply,
          contacto: this.contactos.get(telefono)
        }
      };

    } catch (error) {
      this.modulo.logger.error('canal.whatsapp.mensaje.error', { error: error.message });
      return { status: 500, error: 'Error interno procesando mensaje' };
    }
  }

  async handleCrearPedido(data) {
    try {
      const validate = this.modulo.ajv.getSchema(
        'https://pizzepos.com/schemas/whatsapp.json#/definitions/crear_pedido_request'
      );
      if (validate && !validate(data)) {
        return { status: 400, error: 'Request inválido', details: validate.errors };
      }

      const { telefono, nombre, items, notas, modo_entrega } = data;

      this.modulo.verificarReseoDiario();

      const secuencial = this.modulo.getNextSecuencial('whatsapp');
      const fecha = this.modulo.getFechaActual();
      const cuenta_id = `wa_${fecha}_${secuencial.toString().padStart(3, '0')}`;
      const numero_pedido = secuencial;

      const contacto = this.contactos.get(telefono);

      const pedido = {
        cuenta_id,
        numero_pedido,
        telefono,
        nombre: nombre || contacto?.nombre || 'Cliente WhatsApp',
        estado: 'pendiente_confirmacion',
        items: items || [],
        total: 0,
        modo_entrega: modo_entrega || 'recogida',
        hora_pedido: new Date().toISOString(),
        confirmado: false,
        whatsapp_confirmacion_enviada: false,
        whatsapp_listo_enviado: false,
        pedidos: [],
        notas: notas || ''
      };

      // Calcular total de items si tienen precio
      if (pedido.items.length > 0) {
        pedido.total = pedido.items.reduce((sum, item) => {
          return sum + ((item.precio || 0) * (item.cantidad || 1));
        }, 0);
      }

      this.pedidosActivos.set(cuenta_id, pedido);
      this.internalMetrics.pedidos_creados++;

      // Vincular conversación con pedido
      const conversacion = this.conversaciones.get(telefono);
      if (conversacion) {
        conversacion.cuenta_id = cuenta_id;
        conversacion.estado = 'pedido_creado';
      }

      // Publicar cuenta.creada al crear pedido (no esperar a confirmar),
      // para que cuentas registre la cuenta y el comandero/cocina puedan operar.
      await this.modulo.publishCuentaCreada({
        cuenta_id: pedido.cuenta_id,
        tipo: 'whatsapp',
        total: pedido.total,
        metadata: {
          telefono: pedido.telefono,
          nombre: pedido.nombre,
          modo_entrega: pedido.modo_entrega
        }
      });

      await this.modulo.eventBus.publish('whatsapp.pedido_creado', {
        cuenta_id,
        numero_pedido,
        telefono,
        nombre: pedido.nombre,
        items: pedido.items,
        total: pedido.total,
        modo_entrega: pedido.modo_entrega
      });

      // Enviar confirmación por WhatsApp
      const msgConfirmacion = this.generarMensajeConfirmacion(pedido);
      await this.enviarMensajeWA(telefono, msgConfirmacion);

      this.modulo.logger.info('whatsapp.pedido_creado', {
        cuenta_id,
        numero_pedido,
        telefono,
        total: pedido.total
      });

      return { status: 201, data: pedido };

    } catch (error) {
      this.modulo.logger.error('canal.whatsapp.crear_pedido.error', { error: error.message });
      return { status: 500, error: 'Error interno creando pedido' };
    }
  }

  async handleConfirmarPedido(data) {
    try {
      const { cuenta_id } = data;
      const pedido = this.pedidosActivos.get(cuenta_id);

      if (!pedido) {
        return { status: 404, error: 'Pedido no encontrado' };
      }

      if (pedido.confirmado) {
        return { status: 409, error: 'Pedido ya confirmado' };
      }

      pedido.confirmado = true;
      pedido.estado = 'confirmado';
      pedido.hora_confirmado = new Date().toISOString();
      this.internalMetrics.pedidos_confirmados++;

      // cuenta.creada ya se publicó en handleCrearPedido (dedup en cuentas)

      await this.modulo.eventBus.publish('whatsapp.pedido_confirmado', {
        cuenta_id: pedido.cuenta_id,
        numero_pedido: pedido.numero_pedido,
        telefono: pedido.telefono,
        total: pedido.total
      });

      const msgConfirmado = this.generarMensajeConfirmado(pedido);
      await this.enviarMensajeWA(pedido.telefono, msgConfirmado);

      this.modulo.logger.info('whatsapp.pedido_confirmado', {
        cuenta_id,
        telefono: pedido.telefono
      });

      return { status: 200, data: pedido };

    } catch (error) {
      this.modulo.logger.error('canal.whatsapp.confirmar.error', { error: error.message });
      return { status: 500, error: 'Error interno confirmando pedido' };
    }
  }

  async handleMarcarListo(data) {
    const { cuenta_id } = data;

    try {
      await this.notificarListo(cuenta_id);
      return { status: 200, data: { message: 'Cliente notificado por WhatsApp' } };
    } catch (error) {
      this.modulo.logger.error('canal.whatsapp.marcar_listo.error', { error: error.message });
      return { status: 500, error: error.message };
    }
  }

  async handleGetActivos() {
    const activos = Array.from(this.pedidosActivos.values())
      .filter(p => p.estado !== 'entregado' && p.estado !== 'cancelado')
      .sort((a, b) => new Date(a.hora_pedido) - new Date(b.hora_pedido));

    return {
      status: 200,
      data: { pedidos: activos, total: activos.length }
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

  async handleGetConversaciones(data) {
    const { estado } = data || {};

    let convs = Array.from(this.conversaciones.values());

    if (estado) {
      convs = convs.filter(c => c.estado === estado);
    }

    convs.sort((a, b) => {
      const lastA = a.mensajes[a.mensajes.length - 1]?.timestamp || a.inicio;
      const lastB = b.mensajes[b.mensajes.length - 1]?.timestamp || b.inicio;
      return new Date(lastB) - new Date(lastA);
    });

    // Devolver resumen (sin todos los mensajes para no saturar)
    const resumen = convs.map(c => ({
      telefono: c.telefono,
      nombre: c.nombre,
      estado: c.estado,
      cuenta_id: c.cuenta_id,
      total_mensajes: c.mensajes.length,
      ultimo_mensaje: c.mensajes[c.mensajes.length - 1]?.contenido || '',
      ultimo_timestamp: c.mensajes[c.mensajes.length - 1]?.timestamp || c.inicio
    }));

    return {
      status: 200,
      data: { conversaciones: resumen, total: resumen.length }
    };
  }

  async handleEnviarMensaje(data) {
    try {
      const { telefono, mensaje } = data;

      if (!telefono || !mensaje) {
        return { status: 400, error: 'telefono y mensaje son requeridos' };
      }

      await this.enviarMensajeWA(telefono, mensaje);

      // Registrar en conversación
      const conversacion = this.conversaciones.get(telefono);
      if (conversacion) {
        conversacion.mensajes.push({
          direccion: 'saliente',
          tipo: 'text',
          contenido: mensaje,
          timestamp: new Date().toISOString()
        });
      }

      return { status: 200, data: { message: 'Mensaje enviado' } };

    } catch (error) {
      this.modulo.logger.error('canal.whatsapp.enviar.error', { error: error.message });
      return { status: 500, error: 'Error enviando mensaje' };
    }
  }

  async handleHealthCheck() {
    return { status: 200, data: this.getHealth() };
  }

  async handleGetMetrics() {
    return { status: 200, data: this.getMetrics() };
  }

  // ==========================================
  // Business Logic
  // ==========================================

  async notificarListo(cuenta_id, correlationId) {
    const pedido = this.pedidosActivos.get(cuenta_id);
    if (!pedido) {
      throw new Error('Pedido WhatsApp no encontrado');
    }

    pedido.estado = 'listo';
    pedido.hora_listo = new Date().toISOString();
    this.internalMetrics.pedidos_listos++;

    const tiempoPreparacion = this.modulo.calcularTiempoMinutos(pedido.hora_pedido);
    this.modulo.trackTiempo('whatsapp_preparacion', tiempoPreparacion);

    await this.modulo.eventBus.publish('whatsapp.pedido_listo', {
      cuenta_id: pedido.cuenta_id,
      numero_pedido: pedido.numero_pedido,
      telefono: pedido.telefono,
      nombre: pedido.nombre,
      total: pedido.total
    }, { correlationId });

    // Enviar notificación por WhatsApp
    const msgListo = this.generarMensajeListo(pedido);
    await this.enviarMensajeWA(pedido.telefono, msgListo);
    pedido.whatsapp_listo_enviado = true;

    // Actualizar contacto
    const contacto = this.contactos.get(pedido.telefono);
    if (contacto) {
      contacto.pedidos_anteriores++;
      contacto.ultima_compra = new Date().toISOString();
    }

    this.modulo.logger.info('whatsapp.pedido_listo', {
      correlation_id: correlationId,
      cuenta_id,
      telefono: pedido.telefono
    });
  }

  async cerrarPedido(cuenta_id, correlationId) {
    const pedido = this.pedidosActivos.get(cuenta_id);
    if (!pedido) {
      throw new Error('Pedido WhatsApp no encontrado');
    }

    pedido.estado = 'entregado';
    pedido.hora_entrega = new Date().toISOString();
    this.internalMetrics.pedidos_entregados++;

    await this.modulo.publishCuentaCerrada({
      cuenta_id: pedido.cuenta_id,
      tipo: 'whatsapp',
      total: pedido.total,
      metadata: {
        telefono: pedido.telefono,
        nombre: pedido.nombre,
        modo_entrega: pedido.modo_entrega
      }
    }, correlationId);

    // Limpiar conversación
    const conversacion = this.conversaciones.get(pedido.telefono);
    if (conversacion && conversacion.cuenta_id === cuenta_id) {
      conversacion.estado = 'completada';
      conversacion.cuenta_id = null;
    }

    this.pedidosActivos.delete(cuenta_id);

    // Enviar agradecimiento
    const msgGracias = this.generarMensajeGracias(pedido);
    await this.enviarMensajeWA(pedido.telefono, msgGracias);

    this.modulo.logger.info('whatsapp.pedido_entregado', {
      correlation_id: correlationId,
      cuenta_id,
      total: pedido.total
    });
  }

  // ==========================================
  // Mensajería WhatsApp
  // ==========================================

  generarAutoRespuesta(conversacion, mensaje) {
    const config = this.modulo.config;
    if (!config.whatsapp_bot?.auto_reply) return null;

    // Si la conversación es nueva, enviar saludo + menú
    if (conversacion.estado === 'nueva') {
      return config.whatsapp_bot?.saludo ||
        'Hola! Bienvenido a nuestra pizzería. Puedes hacernos tu pedido por aquí. Escribe MENU para ver nuestra carta.';
    }

    // Respuestas a keywords
    const lower = mensaje.toLowerCase().trim();
    if (lower === 'menu' || lower === 'carta') {
      return config.whatsapp_bot?.menu_message ||
        'Puedes ver nuestra carta en: [enlace carta]. Para hacer un pedido, dinos qué quieres y te lo preparamos.';
    }

    if (lower === 'estado' || lower === 'mi pedido') {
      if (conversacion.cuenta_id) {
        const pedido = this.pedidosActivos.get(conversacion.cuenta_id);
        if (pedido) {
          return `Tu pedido #${pedido.numero_pedido} está en estado: ${pedido.estado}. Total: ${pedido.total.toFixed(2)}EUR`;
        }
      }
      return 'No tienes ningún pedido activo. Escribe lo que quieras pedir.';
    }

    return null;
  }

  generarMensajeConfirmacion(pedido) {
    const config = this.modulo.config;
    const template = config.whatsapp_bot?.template_confirmacion ||
      'Hemos recibido tu pedido #{{numero}}. Total estimado: {{total}}EUR. Te confirmaremos en breve.';

    return template
      .replace('{{numero}}', pedido.numero_pedido)
      .replace('{{total}}', pedido.total.toFixed(2))
      .replace('{{nombre}}', pedido.nombre);
  }

  generarMensajeConfirmado(pedido) {
    const config = this.modulo.config;
    const template = config.whatsapp_bot?.template_confirmado ||
      'Tu pedido #{{numero}} ha sido confirmado! Total: {{total}}EUR. Te avisamos cuando esté listo.';

    return template
      .replace('{{numero}}', pedido.numero_pedido)
      .replace('{{total}}', pedido.total.toFixed(2));
  }

  generarMensajeListo(pedido) {
    const config = this.modulo.config;
    const modoMsg = pedido.modo_entrega === 'delivery'
      ? 'El repartidor sale en breve.'
      : 'Puedes pasar a recogerlo.';

    const template = config.whatsapp_bot?.template_listo ||
      'Tu pedido #{{numero}} está listo! {{modo}} Total: {{total}}EUR';

    return template
      .replace('{{numero}}', pedido.numero_pedido)
      .replace('{{total}}', pedido.total.toFixed(2))
      .replace('{{modo}}', modoMsg);
  }

  generarMensajeGracias(pedido) {
    const config = this.modulo.config;
    return config.whatsapp_bot?.template_gracias ||
      'Gracias por tu pedido! Esperamos que lo disfrutes. Escríbenos cuando quieras para repetir.';
  }

  async enviarMensajeWA(telefono, mensaje) {
    // TODO: Integrar con WhatsApp Business API (Cloud API)
    // https://developers.facebook.com/docs/whatsapp/cloud-api/
    //
    // POST https://graph.facebook.com/v17.0/{phone_number_id}/messages
    // Headers: Authorization: Bearer {access_token}
    // Body: { messaging_product: "whatsapp", to: telefono, type: "text", text: { body: mensaje } }
    //
    // Credenciales en: this.modulo.config.whatsapp_bot?.phone_number_id
    //                  this.modulo.config.whatsapp_bot?.access_token

    this.internalMetrics.mensajes_enviados++;

    this.modulo.logger.info('whatsapp.mensaje_enviado', {
      telefono,
      mensaje,
      nota: 'Pendiente integración con WhatsApp Cloud API'
    });
  }
}

module.exports = WhatsAppStrategy;
