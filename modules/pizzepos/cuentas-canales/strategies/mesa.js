/**
 * Strategy: Mesa
 * Canal de servicio en mesa — mesas dinámicas creadas en tiempo de ejecución
 *
 * NO hay mesas predefinidas. Cada mesa se crea al vuelo con nombre libre:
 *   "Mesa 1", "Mesa 15", "Mesa de Manolo", lo que sea.
 *
 * Prefijo cuenta_id: mesa_{seq}_{YYYYMMDD}_{subseq}
 * Dominio uiHandler: 'mesa'
 * Eventos propios: mesa.abierta, mesa.cerrada, mesa.camarero_asignado
 * Consume: pedido.creado (actualiza total de la mesa)
 *
 * Métricas: tiempo ocupada, tiempo preparación, ingresos por mesa, por camarero
 */

class MesaStrategy {
  constructor() {
    this.tipo = 'mesa';
    this.prefijo = 'mesa_';
    this.version = '4.0.0';

    // Mesas activas: cuenta_id -> mesa data
    this.mesasActivas = new Map();

    // Contador diario para auto-nombre: "Mesa 1", "Mesa 2"...
    this.contadorDiario = 0;

    // Métricas internas
    this.internalMetrics = {
      mesas_abiertas: 0,
      mesas_cerradas: 0,
      camareros_asignados: 0,
      ingresos_totales: 0
    };

    this.modulo = null;
    this._uiActions = [
      'abrir', 'cerrar', 'renombrar', 'asignar_camarero', 'get',
      'activas', 'list', 'health', 'metrics'
    ];
  }

  // ==========================================
  // Strategy Interface
  // ==========================================

  async init(modulo) {
    this.modulo = modulo;

    modulo.safeAddSchema(require('../schemas/mesa.json'));
    modulo.safeAddSchema(require('../schemas/mesa-events.json'));

    // Restaurar mesas activas desde persistencia (sobrevive reinicio servidor)
    await this.restaurarDesdeArchivo();
  }

  registerUIHandlers(uiHandler) {
    uiHandler.register('mesa', 'abrir', this.handleAbrirMesa.bind(this));
    uiHandler.register('mesa', 'cerrar', this.handleCerrarMesa.bind(this));
    uiHandler.register('mesa', 'renombrar', this.handleRenombrarMesa.bind(this));
    uiHandler.register('mesa', 'asignar_camarero', this.handleAsignarCamarero.bind(this));
    uiHandler.register('mesa', 'get', this.handleGetMesa.bind(this));
    uiHandler.register('mesa', 'activas', this.handleGetActivas.bind(this));
    uiHandler.register('mesa', 'list', this.handleListAll.bind(this));
    uiHandler.register('mesa', 'health', this.handleHealthCheck.bind(this));
    uiHandler.register('mesa', 'metrics', this.handleGetMetrics.bind(this));

    this.modulo.logger.info('canal.mesa.ui_handlers.registered', {
      handlers: this._uiActions
    });
  }

  unregisterUIHandlers(uiHandler) {
    for (const action of this._uiActions) {
      uiHandler.unregister('mesa', action);
    }
  }

  async subscribeToEvents(eventBus) {
    await eventBus.subscribe('pedido.creado', this.onPedidoCreado.bind(this));
  }

  async onCobroProcesado(cuenta_id, correlationId, project_id) {
    // Guardia de idempotencia: si la mesa ya no está activa, ignorar
    if (!this.mesasActivas.has(cuenta_id)) {
      this.modulo.logger.warn('canal.mesa.cobro_procesado.mesa_ya_cerrada', {
        correlation_id: correlationId,
        cuenta_id
      });
      return;
    }
    await this.cerrarMesa(cuenta_id, correlationId, project_id);
  }

  getHealth() {
    return {
      mesas_activas: this.mesasActivas.size
    };
  }

  getMetrics() {
    return {
      ...this.internalMetrics,
      mesas_activas: this.mesasActivas.size,
      tiempo_promedio_ocupacion: this.modulo.getPromedioTiempo('mesa_ocupacion')
    };
  }

  getCuentasActivas() {
    return this.mesasActivas.size;
  }

  cleanup() {
    this.mesasActivas.clear();
    this.contadorDiario = 0;
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  async onPedidoCreado(event) {
    const eventData = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;
    const { cuenta_id, total } = eventData;

    if (!cuenta_id || !cuenta_id.startsWith(this.prefijo)) return;

    const mesa = this.mesasActivas.get(cuenta_id);
    if (!mesa) {
      this.modulo.logger.warn('canal.mesa.pedido.mesa_no_activa', {
        correlation_id: correlationId,
        cuenta_id
      });
      return;
    }

    mesa.total += total || 0;
    mesa.pedidos_count = (mesa.pedidos_count || 0) + 1;

    this.modulo.logger.info('canal.mesa.pedido.agregado', {
      correlation_id: correlationId,
      cuenta_id,
      nombre: mesa.nombre,
      total_nuevo: mesa.total
    });
  }

  // ==========================================
  // UI Handlers
  // ==========================================

  async handleAbrirMesa(data) {
    try {
      const { nombre, comensales, camarero, notas, project_id } = data;

      this.modulo.verificarReseoDiario();

      // Auto-incrementar contador diario
      this.contadorDiario++;
      const numero = this.contadorDiario;

      // Nombre libre: lo que pase el usuario, o auto "Mesa N"
      const nombre_mesa = nombre || `Mesa ${numero}`;

      // Generar cuenta_id con prefijo
      const secuencial = this.modulo.getNextSecuencial('mesa', numero);
      const fecha = this.modulo.getFechaActual();
      const cuenta_id = `mesa_${numero}_${fecha}_${secuencial.toString().padStart(3, '0')}`;

      const mesa = {
        cuenta_id,
        nombre: nombre_mesa,
        numero,
        comensales: comensales || null,
        camarero: camarero || null,
        estado: 'ocupada',
        total: 0,
        pedidos_count: 0,
        hora_apertura: new Date().toISOString(),
        notas: notas || ''
      };

      this.mesasActivas.set(cuenta_id, mesa);
      this.internalMetrics.mesas_abiertas++;

      // Publicar eventos
      await this.modulo.eventBus.publish('mesa.abierta', {
        cuenta_id: mesa.cuenta_id,
        nombre: mesa.nombre,
        numero: mesa.numero,
        comensales: mesa.comensales,
        camarero: mesa.camarero,
        hora_apertura: mesa.hora_apertura,
        project_id
      });

      await this.modulo.publishCuentaCreada({
        cuenta_id: mesa.cuenta_id,
        tipo: 'mesa',
        total: mesa.total,
        project_id,
        metadata: {
          nombre: mesa.nombre,
          numero: mesa.numero,
          camarero: mesa.camarero,
          comensales: mesa.comensales
        }
      });

      this.modulo.logger.info('mesa.abierta', {
        cuenta_id,
        nombre: nombre_mesa
      });

      return { status: 201, data: mesa };

    } catch (error) {
      this.modulo.logger.error('canal.mesa.abrir.error', { error: error.message });
      return { status: 500, error: 'Error interno abriendo mesa' };
    }
  }

  async handleRenombrarMesa(data) {
    try {
      const { cuenta_id, nombre } = data;

      if (!nombre || nombre.trim().length === 0) {
        return { status: 400, error: 'nombre es requerido' };
      }

      const mesa = this.mesasActivas.get(cuenta_id);
      if (!mesa) {
        return { status: 404, error: 'Mesa no encontrada o no está activa' };
      }

      const nombre_anterior = mesa.nombre;
      mesa.nombre = nombre.trim();

      await this.modulo.eventBus.publish('mesa.renombrada', {
        cuenta_id: mesa.cuenta_id,
        nombre: mesa.nombre,
        nombre_anterior,
        project_id: data.project_id
      });

      this.modulo.logger.info('mesa.renombrada', {
        cuenta_id,
        nombre: mesa.nombre,
        nombre_anterior
      });

      return { status: 200, data: mesa };

    } catch (error) {
      this.modulo.logger.error('canal.mesa.renombrar.error', { error: error.message });
      return { status: 500, error: 'Error interno renombrando mesa' };
    }
  }

  async handleAsignarCamarero(data) {
    try {
      const { cuenta_id, camarero } = data;

      const mesa = this.mesasActivas.get(cuenta_id);
      if (!mesa) {
        return { status: 404, error: 'Mesa no encontrada o no está activa' };
      }

      const camarero_anterior = mesa.camarero;
      mesa.camarero = camarero;
      this.internalMetrics.camareros_asignados++;

      await this.modulo.eventBus.publish('mesa.camarero_asignado', {
        cuenta_id: mesa.cuenta_id,
        nombre: mesa.nombre,
        camarero: mesa.camarero,
        camarero_anterior
      });

      this.modulo.logger.info('mesa.camarero_asignado', {
        cuenta_id,
        nombre: mesa.nombre,
        camarero
      });

      return { status: 200, data: mesa };

    } catch (error) {
      this.modulo.logger.error('canal.mesa.asignar_camarero.error', { error: error.message });
      return { status: 500, error: 'Error interno asignando camarero' };
    }
  }

  async handleCerrarMesa(data) {
    try {
      const { cuenta_id, project_id } = data;
      await this.cerrarMesa(cuenta_id, null, project_id);
      return { status: 200, data: { message: 'Mesa cerrada correctamente' } };
    } catch (error) {
      this.modulo.logger.error('canal.mesa.cerrar.error', { error: error.message });
      return { status: 500, error: error.message };
    }
  }

  async handleGetMesa(data) {
    const { cuenta_id } = data;
    const mesa = this.mesasActivas.get(cuenta_id);

    if (!mesa) {
      return { status: 404, error: 'Mesa no encontrada o no está activa' };
    }

    return {
      status: 200,
      data: {
        ...mesa,
        tiempo_ocupada: this.modulo.calcularTiempoMinutos(mesa.hora_apertura)
      }
    };
  }

  async handleGetActivas() {
    const activas = Array.from(this.mesasActivas.values()).map(m => ({
      ...m,
      tiempo_ocupada: this.modulo.calcularTiempoMinutos(m.hora_apertura)
    }));

    activas.sort((a, b) => new Date(a.hora_apertura) - new Date(b.hora_apertura));

    return {
      status: 200,
      data: { mesas: activas, total: activas.length }
    };
  }

  async handleListAll() {
    return this.handleGetActivas();
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

      let restauradas = 0;
      let maxNumero = 0;
      for (const [cuenta_id, cuenta] of Object.entries(datos.cuentas)) {
        if (!cuenta_id.startsWith(this.prefijo)) continue;

        // Extraer número de mesa del cuenta_id (mesa_{num}_{fecha}_{seq})
        const numMatch = cuenta_id.match(/^mesa_(\d+)_/);
        const numero = numMatch ? parseInt(numMatch[1], 10) : (restauradas + 1);
        if (numero > maxNumero) maxNumero = numero;

        const mesa = {
          cuenta_id,
          nombre: cuenta.datos_especificos?.nombre || `Mesa ${numero}`,
          numero,
          comensales: cuenta.datos_especificos?.comensales || null,
          camarero: cuenta.datos_especificos?.camarero || null,
          estado: 'ocupada',
          total: cuenta.total || 0,
          pedidos_count: cuenta.pedidos?.length || 0,
          hora_apertura: cuenta.created_at || new Date().toISOString(),
          notas: ''
        };

        this.mesasActivas.set(cuenta_id, mesa);
        restauradas++;
      }

      if (restauradas > 0) {
        this.contadorDiario = maxNumero;
        this.modulo.logger.info('canal.mesa.estado_restaurado', {
          mesas_restauradas: restauradas,
          contador_diario: this.contadorDiario
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.modulo?.logger?.warn('canal.mesa.restaurar.error', { error: error.message });
      }
    }
  }

  // ==========================================
  // Business Logic
  // ==========================================

  async cerrarMesa(cuenta_id, correlationId, project_id) {
    const mesa = this.mesasActivas.get(cuenta_id);
    if (!mesa) {
      throw new Error('Mesa no encontrada o no está activa');
    }

    mesa.hora_cierre = new Date().toISOString();
    mesa.tiempo_ocupada = this.modulo.calcularTiempoMinutos(mesa.hora_apertura);
    mesa.estado = 'cerrada';

    this.internalMetrics.mesas_cerradas++;
    this.internalMetrics.ingresos_totales += mesa.total;
    this.modulo.trackTiempo('mesa_ocupacion', mesa.tiempo_ocupada);

    await this.modulo.eventBus.publish('mesa.cerrada', {
      cuenta_id: mesa.cuenta_id,
      nombre: mesa.nombre,
      total: mesa.total,
      tiempo_ocupada: mesa.tiempo_ocupada,
      pedidos_count: mesa.pedidos_count,
      hora_cierre: mesa.hora_cierre,
      project_id
    }, { correlationId });

    await this.modulo.publishCuentaCerrada({
      cuenta_id: mesa.cuenta_id,
      tipo: 'mesa',
      total: mesa.total,
      project_id,
      metadata: {
        nombre: mesa.nombre,
        tiempo_ocupada: mesa.tiempo_ocupada,
        pedidos_count: mesa.pedidos_count
      }
    }, correlationId);

    this.mesasActivas.delete(cuenta_id);

    this.modulo.logger.info('mesa.cerrada', {
      correlation_id: correlationId,
      cuenta_id,
      nombre: mesa.nombre,
      tiempo_ocupada: mesa.tiempo_ocupada,
      total: mesa.total
    });
  }
}

module.exports = MesaStrategy;
