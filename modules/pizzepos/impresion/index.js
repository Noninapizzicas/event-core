/**
 * Módulo Impresión v1.1
 * Impresión de comandas de cocina: items, variaciones, ingredientes, mesa, hora
 * Sin precios — solo info relevante para cocina
 * Formato ESC/POS para impresora térmica Bluetooth (58mm NETUM / 80mm)
 *
 * Transporte: Bluetooth vía rfcomm, comando shell, o TCP
 * Entorno principal: Termux en Android
 */

const crypto = require('crypto');
const TransporteBluetooth = require('./transporte');

// ==========================================
// ESC/POS constants
// ==========================================
const ESC = '\x1B';
const GS  = '\x1D';
const CMD = {
  INIT:           `${ESC}@`,
  BOLD_ON:        `${ESC}E\x01`,
  BOLD_OFF:       `${ESC}E\x00`,
  DOUBLE_ON:      `${GS}!\x11`,       // doble ancho + alto
  DOUBLE_OFF:     `${GS}!\x00`,
  ALIGN_CENTER:   `${ESC}a\x01`,
  ALIGN_LEFT:     `${ESC}a\x00`,
  FONT_NORMAL:    `${ESC}M\x00`,
  FONT_SMALL:     `${ESC}M\x01`,
  CUT:            `${GS}V\x00`,
  PARTIAL_CUT:    `${GS}V\x01`,
  FEED_3:         `${ESC}d\x03`,
  FEED_5:         `${ESC}d\x05`,
  UNDERLINE_ON:   `${ESC}-\x01`,
  UNDERLINE_OFF:  `${ESC}-\x00`
};

// Anchos por tipo de impresora
const ANCHOS = {
  '58mm': 32,
  '80mm': 42
};

class ImpresionModule {
  constructor() {
    this.name = 'impresion';
    this.version = '1.1.0';

    // Dependencias (inyectadas en onLoad)
    this.eventBus = null;
    this.logger = null;
    this.metrics = null;
    this.uiHandler = null;

    // Transporte Bluetooth
    this.transporte = null;

    // Config (defaults para NETUM 58mm en Termux)
    this.config = {
      ancho: '58mm',
      transporte: {
        modo: 'dispositivo',
        mac: null,
        dispositivo: '/dev/rfcomm0',
        rfcomm_canal: 1,
        comando: null,
        tcp_host: '127.0.0.1',
        tcp_puerto: 9100
      }
    };

    // Ancho de línea calculado
    this.lineWidth = ANCHOS['58mm'];
    this.separator = '';
    this.doubleSep = '';

    // Historial de comandas (últimas 100)
    this.historial = [];
    this.maxHistorial = 100;

    // Métricas internas
    this.internalMetrics = {
      comandas_generadas: 0,
      reimpresiones: 0,
      errores: 0,
      errores_transporte: 0
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

    // Merge config del módulo si existe
    if (core.config?.impresion) {
      this.config = { ...this.config, ...core.config.impresion };
      if (core.config.impresion.transporte) {
        this.config.transporte = { ...this.config.transporte, ...core.config.impresion.transporte };
      }
    }

    // Calcular ancho de línea
    this.lineWidth = ANCHOS[this.config.ancho] || 32;
    this.separator = '-'.repeat(this.lineWidth);
    this.doubleSep = '='.repeat(this.lineWidth);

    // Inicializar transporte Bluetooth
    this.transporte = new TransporteBluetooth(this.config.transporte, this.logger);

    try {
      await this.transporte.conectar();
      this.logger.info('impresion.transporte.conectado', this.transporte.getEstado());
    } catch (error) {
      // No falla el módulo — permite arrancar sin impresora y conectar después
      this.logger.warn('impresion.transporte.no_disponible', {
        error: error.message,
        nota: 'Módulo arrancado sin impresora. Usa POST /conectar para reintentar.'
      });
    }

    // ui_handlers se registran declarativamente desde module.json (auto-wire del loader)

    this.logger.info('module.loaded', {
      module: this.name,
      version: this.version,
      ancho: this.config.ancho,
      chars: this.lineWidth,
      transporte: this.transporte.getEstado()
    });
  }

  async onUnload() {
    this.logger.info('module.unloading', { module: this.name });

    if (this.transporte) {
      await this.transporte.desconectar();
    }

    this.historial = [];
    this.logger.info('module.unloaded', { module: this.name });
  }

  // ==========================================
  // Event Handler: pedido.enviado_cocina
  // ==========================================

  async onPedidoEnviadoCocina(event) {
    const data = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;
    const { pedido_id, cuenta_id, canal, items, notas_generales } = data;

    this.logger.info('impresion.comanda.generando', {
      correlation_id: correlationId,
      pedido_id,
      items_count: items?.length || 0
    });

    try {
      const comanda = this.formatearComanda({
        pedido_id,
        cuenta_id,
        canal,
        items: items || [],
        notas_generales,
        reimpresion: false
      });

      await this.enviarImpresora(comanda);

      const registro = {
        comanda_id: `cmd_${crypto.randomUUID().slice(0, 8)}`,
        pedido_id,
        cuenta_id,
        canal: canal || null,
        items_count: items?.length || 0,
        reimpresion: false,
        generada_at: new Date().toISOString()
      };

      this.guardarHistorial(registro);
      this.internalMetrics.comandas_generadas++;

      await this.eventBus.publish('impresion.comanda_generada', registro);

      this.logger.info('impresion.comanda.enviada', {
        correlation_id: correlationId,
        pedido_id,
        comanda_id: registro.comanda_id
      });
    } catch (error) {
      this.internalMetrics.errores++;

      await this.eventBus.publish('impresion.error', {
        error: error.message,
        pedido_id,
        fase: error.message.includes('transporte') ? 'envio' : 'formato'
      });

      this.logger.error('impresion.comanda.error', {
        correlation_id: correlationId,
        pedido_id,
        error: error.message
      });
    }
  }

  // ==========================================
  // UI Handlers
  // ==========================================

  /**
   * POST /modules/impresion/ticket
   * Reimprimir comanda manualmente
   * Body: { cuenta_id, pedido_id?, items, canal?, notas_generales? }
   */
  async handleImprimirComanda(data) {
    const { cuenta_id, pedido_id, items, canal, notas_generales } = data;

    if (!cuenta_id && !pedido_id) {
      return { status: 400, error: 'Se requiere cuenta_id o pedido_id' };
    }

    if (!items || items.length === 0) {
      return { status: 400, error: 'Se requiere al menos un item' };
    }

    try {
      const comanda = this.formatearComanda({
        pedido_id: pedido_id || cuenta_id,
        cuenta_id,
        canal,
        items,
        notas_generales,
        reimpresion: true
      });

      await this.enviarImpresora(comanda);

      const registro = {
        comanda_id: `cmd_${crypto.randomUUID().slice(0, 8)}`,
        pedido_id: pedido_id || cuenta_id,
        cuenta_id,
        canal: canal || null,
        items_count: items.length,
        reimpresion: true,
        generada_at: new Date().toISOString()
      };

      this.guardarHistorial(registro);
      this.internalMetrics.reimpresiones++;

      await this.eventBus.publish('impresion.comanda_generada', registro);

      return { status: 200, data: registro };
    } catch (error) {
      this.internalMetrics.errores++;
      this.logger.error('impresion.reimpresion.error', {
        pedido_id, cuenta_id, error: error.message
      });
      return { status: 500, error: error.message };
    }
  }

  /**
   * POST /modules/impresion/conectar
   * (Re)conectar impresora Bluetooth
   * Body: { mac?, modo?, dispositivo?, tcp_host?, tcp_puerto?, comando? }
   */
  async handleConectar(data) {
    // Actualizar config si se pasan parámetros nuevos
    if (data && Object.keys(data).length > 0) {
      const campos = ['mac', 'modo', 'dispositivo', 'rfcomm_canal', 'comando', 'tcp_host', 'tcp_puerto'];
      for (const campo of campos) {
        if (data[campo] !== undefined) {
          this.config.transporte[campo] = data[campo];
        }
      }
      // Recrear transporte con nueva config
      if (this.transporte) {
        await this.transporte.desconectar();
      }
      this.transporte = new TransporteBluetooth(this.config.transporte, this.logger);
    }

    try {
      await this.transporte.conectar();
      return { status: 200, data: this.transporte.getEstado() };
    } catch (error) {
      return { status: 500, error: error.message, data: this.transporte.getEstado() };
    }
  }

  /**
   * GET /modules/impresion/estado
   * Estado actual del transporte e impresora
   */
  async handleGetEstado() {
    return {
      status: 200,
      data: {
        modulo: { name: this.name, version: this.version },
        impresora: {
          ancho: this.config.ancho,
          chars_linea: this.lineWidth
        },
        transporte: this.transporte ? this.transporte.getEstado() : { estado: 'no_inicializado' }
      }
    };
  }

  async handleGetHistorial(data) {
    const limit = parseInt(data?.limit) || 20;
    return {
      status: 200,
      data: { comandas: this.historial.slice(0, limit), total: this.historial.length }
    };
  }

  async handleHealthCheck() {
    const transporteEstado = this.transporte ? this.transporte.getEstado() : null;
    return {
      status: 200,
      data: {
        status: transporteEstado?.estado === 'conectado' ? 'healthy' : 'degraded',
        module: this.name,
        version: this.version,
        transporte: transporteEstado
      }
    };
  }

  async handleGetMetrics() {
    return {
      status: 200,
      data: {
        ...this.internalMetrics,
        historial_size: this.historial.length,
        transporte_estado: this.transporte ? this.transporte.estado : 'n/a'
      }
    };
  }

  // ==========================================
  // Formateador de Comandas (ESC/POS)
  // ==========================================

  /**
   * Genera el texto ESC/POS para una comanda de cocina.
   * Adapta al ancho configurado (58mm=32 chars, 80mm=42 chars).
   * Sin precios — solo items, variaciones, ingredientes, mesa, hora.
   */
  formatearComanda({ pedido_id, cuenta_id, canal, items, notas_generales, reimpresion }) {
    const lineas = [];

    // -- Init impresora
    lineas.push(CMD.INIT);

    // -- Header: COMANDA
    lineas.push(CMD.ALIGN_CENTER);
    lineas.push(CMD.DOUBLE_ON);
    lineas.push(reimpresion ? '** REIMPRESION **' : 'COMANDA');
    lineas.push(CMD.DOUBLE_OFF);

    // -- Referencia mesa/pedido y hora
    lineas.push(CMD.FONT_NORMAL);
    lineas.push(this.doubleSep);

    const refMesa = this.extraerRefMesa(cuenta_id, canal);
    if (refMesa) {
      lineas.push(CMD.BOLD_ON);
      lineas.push(CMD.DOUBLE_ON);
      lineas.push(refMesa);
      lineas.push(CMD.DOUBLE_OFF);
      lineas.push(CMD.BOLD_OFF);
    }

    lineas.push(CMD.ALIGN_LEFT);

    const ahora = new Date();
    const hora = ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const fecha = ahora.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });

    // En 58mm optimizamos espacio
    if (this.lineWidth <= 32) {
      lineas.push(`${hora} ${fecha}  #${pedido_id || '-'}`);
    } else {
      lineas.push(`Hora: ${hora}  Fecha: ${fecha}`);
      lineas.push(`Pedido: ${pedido_id || '-'}`);
    }
    if (canal) lineas.push(`Canal: ${canal}`);

    lineas.push(this.doubleSep);

    // -- Items
    for (const item of items) {
      this.formatearItem(lineas, item);
      lineas.push(this.separator);
    }

    // -- Notas generales
    if (notas_generales) {
      lineas.push(CMD.BOLD_ON);
      lineas.push('NOTAS:');
      lineas.push(CMD.BOLD_OFF);
      lineas.push(this.truncar(notas_generales));
      lineas.push(this.separator);
    }

    // -- Footer
    lineas.push(CMD.ALIGN_CENTER);
    lineas.push(CMD.FONT_SMALL);
    lineas.push(`${items.length} item(s)`);
    lineas.push(CMD.FONT_NORMAL);

    // -- Corte
    lineas.push(CMD.FEED_5);
    lineas.push(CMD.PARTIAL_CUT);

    return lineas.join('\n');
  }

  /**
   * Formatea un item individual.
   * En 58mm: más compacto, abreviaciones.
   */
  formatearItem(lineas, item) {
    const qty = item.cantidad > 1 ? `${item.cantidad}x ` : '';
    lineas.push(CMD.BOLD_ON);
    lineas.push(this.truncar(`${qty}${item.nombre}`));
    lineas.push(CMD.BOLD_OFF);

    // Mitad-mitad
    if (item.tipo === 'mitad-mitad' || item.pizza_izquierda || item.pizza_derecha) {
      if (item.pizza_izquierda) {
        lineas.push(this.truncar(` IZQ: ${item.pizza_izquierda}`));
      }
      if (item.pizza_derecha) {
        lineas.push(this.truncar(` DER: ${item.pizza_derecha}`));
      }
    }

    // Ingredientes
    if (item.ingredientes && item.ingredientes.length > 0) {
      for (const ing of item.ingredientes) {
        const nombre = typeof ing === 'string' ? ing : ing.nombre || String(ing);
        lineas.push(this.truncar(` + ${nombre}`));
      }
    }

    // Variaciones
    if (item.variaciones && Object.keys(item.variaciones).length > 0) {
      const v = item.variaciones;

      if (v.ingredientes_quitar && v.ingredientes_quitar.length > 0) {
        lineas.push(CMD.BOLD_ON);
        for (const ing of v.ingredientes_quitar) {
          lineas.push(this.truncar(` SIN ${ing.toUpperCase()}`));
        }
        lineas.push(CMD.BOLD_OFF);
      }

      if (v.ingredientes_anadir && v.ingredientes_anadir.length > 0) {
        for (const ing of v.ingredientes_anadir) {
          const nombre = typeof ing === 'string' ? ing : ing.nombre || String(ing);
          lineas.push(this.truncar(` CON ${nombre}`));
        }
      }

      for (const [key, val] of Object.entries(v)) {
        if (key === 'ingredientes_quitar' || key === 'ingredientes_anadir') continue;
        if (val === true) {
          lineas.push(` ${key.toUpperCase()}`);
        } else if (val && val !== false) {
          lineas.push(this.truncar(` ${key}: ${val}`));
        }
      }
    }

    // Notas del item
    if (item.notas) {
      lineas.push(CMD.UNDERLINE_ON);
      lineas.push(this.truncar(` >> ${item.notas}`));
      lineas.push(CMD.UNDERLINE_OFF);
    }
  }

  /**
   * Extrae referencia de mesa del cuenta_id o canal.
   */
  extraerRefMesa(cuenta_id, canal) {
    if (!cuenta_id) return null;

    const prefijos = {
      mesa: 'MESA',
      telefono: 'TEL',
      llevar: 'LLEVAR',
      glovo: 'GLOVO',
      whatsapp: 'WHATSAPP'
    };

    for (const [prefijo, label] of Object.entries(prefijos)) {
      if (cuenta_id.startsWith(`${prefijo}_`)) {
        const ref = cuenta_id.slice(prefijo.length + 1);
        return `${label} ${ref}`;
      }
    }

    if (canal && prefijos[canal]) {
      return `${prefijos[canal]} - ${cuenta_id}`;
    }

    return `REF: ${cuenta_id}`;
  }

  // ==========================================
  // Envío a impresora
  // ==========================================

  /**
   * Envía ESC/POS a la impresora vía transporte Bluetooth.
   * Si el transporte no está conectado, intenta reconectar una vez.
   * También publica impresion.raw al eventBus (para monitoreo/logging).
   */
  async enviarImpresora(contenido) {
    // Publicar al bus para monitoreo
    await this.eventBus.publish('impresion.raw', {
      tipo: 'comanda',
      contenido,
      timestamp: new Date().toISOString()
    });

    // Enviar por transporte Bluetooth
    if (this.transporte) {
      try {
        if (this.transporte.estado !== 'conectado') {
          this.logger.info('impresion.transporte.reconectando');
          await this.transporte.conectar();
        }
        await this.transporte.enviar(contenido);
      } catch (error) {
        this.internalMetrics.errores_transporte++;
        this.logger.error('impresion.transporte.envio_fallido', { error: error.message });
        throw new Error(`transporte: ${error.message}`);
      }
    } else {
      this.logger.warn('impresion.sin_transporte', { bytes: contenido.length });
    }
  }

  // ==========================================
  // Utilidades
  // ==========================================

  /** Trunca texto al ancho de línea */
  truncar(texto) {
    return texto.length > this.lineWidth ? texto.slice(0, this.lineWidth - 1) + '…' : texto;
  }

  guardarHistorial(registro) {
    this.historial.unshift(registro);
    if (this.historial.length > this.maxHistorial) {
      this.historial.pop();
    }
  }
}

module.exports = ImpresionModule;
