/**
 * Módulo Persistencia Comandero v3.0
 * Event sourcing local: guarda todos los eventos y genera registros de ventas
 * Alineado con patrones event-core: uiHandler, event envelope, cleanup
 *
 * v3.0: Persistencia multi-proyecto
 *   - Datos globales en ./data/ (backward compatible)
 *   - Datos por proyecto en data/projects/{project_id}/persistencia/
 *   - Cierres archivados en data/projects/{project_id}/contabilidad/cierres/
 *
 * Emite: caja.cerrada, dia.iniciado
 * Consume: boton.pulsado, ui.accion, cuenta.creada, cuenta.cerrada, cobro.*, pedido.*, mesa.*, telefono.*, llevar.*
 */

const fs = require('fs').promises;
const path = require('path');

class PersistenciaComanderoModule {
  constructor() {
    this.name = 'persistencia-comandero';
    this.version = '3.0.0';

    // Dependencias (inyectadas en onLoad)
    this.eventBus = null;
    this.logger = null;
    this.metrics = null;
    this.uiHandler = null;
    this.config = {};

    // Directorios globales (se configuran en onLoad)
    this.dataDir = './data';
    this.eventosDir = './data/eventos';
    this.ventasDir = './data/ventas';
    this.currentDir = './data/current';
    this.backupDir = './data/backups';

    // Base para datos por proyecto
    this.projectsBasePath = path.join(process.cwd(), 'data', 'projects');

    // Cache en memoria (global - contiene datos de todos los proyectos)
    this.eventosCache = [];
    this.ventasCache = [];
    this.cuentasActivasCache = new Map();
    this.fechaJornada = null;
    this.horaInicioJornada = null;

    // Métricas internas
    this.internalMetrics = {
      eventos_guardados: 0,
      ventas_guardadas: 0,
      errores_escritura: 0
    };

    // Cola de escrituras (evita perder writes por lock booleano)
    this._writeQueue = Promise.resolve();
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(core) {
    this.logger = core.logger;
    this.metrics = core.metrics;
    this.eventBus = core.eventBus;
    this.uiHandler = core.uiHandler;
    this.config = core.config || {};

    this.dataDir = this.config.data_dir || './data';
    this.eventosDir = this.config.eventos_dir || './data/eventos';
    this.ventasDir = this.config.ventas_dir || './data/ventas';
    this.currentDir = this.config.current_dir || './data/current';
    this.backupDir = this.config.backup_dir || './data/backups';

    this.logger.info('module.loading', { module: this.name, version: this.version });

    await this.crearDirectorios();
    await this.cargarJornada();
    await this.cargarDatosActuales();
    // Event subscriptions are auto-wired from module.json by the loader.
    // Do NOT subscribe manually here to avoid duplicate handlers.
    this.registerUIHandlers();

    this.logger.info('module.loaded', {
      module: this.name,
      eventos_cargados: this.eventosCache.length,
      ventas_cargadas: this.ventasCache.length,
      cuentas_activas: this.cuentasActivasCache.size
    });
  }

  async onUnload() {
    this.logger.info('module.unloading', { module: this.name });

    if (this.uiHandler) {
      const actions = [
        'cuentas_activas', 'eventos', 'eventos_fecha', 'ventas', 'ventas_fecha',
        'cuadre', 'cuadre_fecha', 'cierre', 'iniciar_dia', 'backup',
        'health', 'metrics'
      ];
      for (const action of actions) {
        this.uiHandler.unregister('persistencia', action);
      }
    }

    this.cuentasActivasCache.clear();

    this.logger.info('module.unloaded', { module: this.name });
  }

  // ==========================================
  // UI Handler Registration
  // ==========================================

  registerUIHandlers() {
    if (!this.uiHandler) {
      this.logger.warn('persistencia.uiHandler.not_available', { module: this.name });
      return;
    }

    this.uiHandler.register('persistencia', 'cuentas_activas', this.handleGetCuentasActivas.bind(this));
    this.uiHandler.register('persistencia', 'eventos', this.handleGetEventos.bind(this));
    this.uiHandler.register('persistencia', 'eventos_fecha', this.handleGetEventosFecha.bind(this));
    this.uiHandler.register('persistencia', 'ventas', this.handleGetVentas.bind(this));
    this.uiHandler.register('persistencia', 'ventas_fecha', this.handleGetVentasFecha.bind(this));
    this.uiHandler.register('persistencia', 'cuadre', this.handleCuadreCaja.bind(this));
    this.uiHandler.register('persistencia', 'cuadre_fecha', this.handleCuadreCajaFecha.bind(this));
    this.uiHandler.register('persistencia', 'cierre', this.handleCierreCaja.bind(this));
    this.uiHandler.register('persistencia', 'iniciar_dia', this.handleIniciarDia.bind(this));
    this.uiHandler.register('persistencia', 'backup', this.handleBackup.bind(this));
    this.uiHandler.register('persistencia', 'health', this.handleHealthCheck.bind(this));
    this.uiHandler.register('persistencia', 'metrics', this.handleGetMetrics.bind(this));

    this.logger.info('persistencia.ui_handlers.registered', {
      handlers: ['cuentas_activas', 'eventos', 'eventos_fecha', 'ventas', 'ventas_fecha', 'cuadre', 'cuadre_fecha', 'cierre', 'iniciar_dia', 'backup', 'health', 'metrics']
    });
  }

  // ==========================================
  // Setup
  // ==========================================

  async crearDirectorios() {
    const dirs = [this.dataDir, this.eventosDir, this.ventasDir, this.currentDir, this.backupDir];

    for (const dir of dirs) {
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (error) {
        this.logger.error('persistencia.dir.error', {
          dir,
          error: error.message
        });
      }
    }
  }

  // NOTE: Event subscriptions are auto-wired from module.json.
  // See module.json "subscribes" array for the complete list.

  // ==========================================
  // Per-Project Directory Helpers
  // ==========================================

  /**
   * Devuelve los paths de persistencia para un proyecto.
   * Crea los directorios si no existen.
   */
  async getProjectDirs(projectId) {
    if (!projectId) return null;

    const base = path.join(this.projectsBasePath, projectId, 'persistencia');
    const dirs = {
      base,
      current: path.join(base, 'current'),
      eventos: path.join(base, 'eventos'),
      ventas: path.join(base, 'ventas'),
      backups: path.join(base, 'backups'),
      contabilidad: path.join(this.projectsBasePath, projectId, 'contabilidad', 'cierres')
    };

    // Crear dirs si no existen (lazy)
    for (const dir of Object.values(dirs)) {
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (error) {
        // Silenciar - se reportara en la escritura si falla
      }
    }

    return dirs;
  }

  /**
   * Extrae project_id de un evento, buscando en el payload o en la cuenta asociada.
   */
  resolveProjectId(event) {
    const eventData = event?.data || event?.payload || event;
    if (eventData?.project_id) return eventData.project_id;
    if (eventData?.cuenta_id) {
      const cuenta = this.cuentasActivasCache.get(eventData.cuenta_id);
      if (cuenta?.project_id) return cuenta.project_id;
    }
    return null;
  }

  /**
   * Obtiene todos los project_ids activos en las caches.
   */
  getActiveProjectIds() {
    const ids = new Set();
    for (const cuenta of this.cuentasActivasCache.values()) {
      if (cuenta.project_id) ids.add(cuenta.project_id);
    }
    for (const venta of this.ventasCache) {
      if (venta.project_id) ids.add(venta.project_id);
    }
    for (const evento of this.eventosCache) {
      if (evento.payload?.project_id) ids.add(evento.payload.project_id);
    }
    return ids;
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  async onEvento(event) {
    const eventData = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;
    const eventType = event?.type || event?.event_type || 'unknown';

    const eventoRegistro = {
      timestamp: new Date().toISOString(),
      event_type: eventType,
      correlation_id: correlationId,
      payload: eventData
    };

    this.eventosCache.push(eventoRegistro);
    this.internalMetrics.eventos_guardados++;
    this.metrics.increment('persistencia.eventos.total');

    await this.guardarEventos();

    this.logger.debug('persistencia.evento.guardado', {
      correlation_id: correlationId,
      event_type: eventType
    });
  }

  async onCuentaCerrada(event) {
    const eventData = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;

    await this.onEvento(event);

    const { cuenta_id, tipo, total, metadata } = eventData;

    // Obtener project_id de la cuenta activa en cache antes de borrarla
    const cuentaActiva = this.cuentasActivasCache.get(cuenta_id);
    const project_id = eventData.project_id || cuentaActiva?.project_id || null;

    // Buscar cobro asociado para crear registro de venta
    const cobroEvento = this.eventosCache
      .filter(e => e.event_type === 'cobro.procesado')
      .find(e => e.payload?.cuenta_id === cuenta_id);

    if (cobroEvento) {
      const cuentaCreadaEvento = this.eventosCache
        .filter(e => e.event_type === 'cuenta.creada')
        .find(e => e.payload?.cuenta_id === cuenta_id);

      const pedidosEventos = this.eventosCache
        .filter(e => e.event_type === 'pedido.creado')
        .filter(e => e.payload?.cuenta_id === cuenta_id);

      const venta = {
        venta_id: `venta_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: new Date().toISOString(),
        project_id,
        cuenta: {
          cuenta_id,
          tipo,
          origen: cuentaCreadaEvento?.payload?.origen || 'desconocido',
          hora_apertura: cuentaCreadaEvento?.timestamp || null,
          hora_cierre: new Date().toISOString(),
          metadata: metadata || {}
        },
        cobro: {
          cobro_id: cobroEvento.payload.cobro_id,
          monto: cobroEvento.payload.monto || total,
          propina: cobroEvento.payload.propina || 0,
          monto_total: cobroEvento.payload.monto_total || total,
          metodo_pago: cobroEvento.payload.metodo_pago,
          referencia_pago: cobroEvento.payload.referencia_pago
        },
        pedidos: pedidosEventos.map(p => ({
          pedido_id: p.payload.pedido_id,
          items: p.payload.items || [],
          total: p.payload.total || 0
        })),
        resumen: {
          subtotal: total,
          propina: cobroEvento.payload.propina || 0,
          total_final: cobroEvento.payload.monto_total || total
        }
      };

      this.ventasCache.push(venta);
      this.internalMetrics.ventas_guardadas++;
      this.metrics.increment('persistencia.ventas.total');

      await this.guardarVentas();

      this.logger.info('persistencia.venta.registrada', {
        correlation_id: correlationId,
        venta_id: venta.venta_id,
        total: venta.resumen.total_final
      });
    } else {
      this.logger.warn('persistencia.cuenta_sin_cobro', {
        correlation_id: correlationId,
        cuenta_id
      });
    }

    // SIEMPRE eliminar cuenta de cache (independiente de si hay cobro o no)
    this.cuentasActivasCache.delete(cuenta_id);
    await this.guardarCuentasActivas();
  }

  async onCuentaCreada(event) {
    const eventData = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;

    await this.onEvento(event);

    const { cuenta_id, project_id, tipo, origen, metadata } = eventData;

    const cuentaActiva = {
      cuenta_id,
      project_id: project_id || null,
      tipo,
      origen,
      estado: 'abierta',
      datos_especificos: metadata || {},
      pedidos: [],
      total: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    this.cuentasActivasCache.set(cuenta_id, cuentaActiva);
    await this.guardarCuentasActivas();

    this.logger.info('persistencia.cuenta_activa.agregada', {
      correlation_id: correlationId,
      project_id,
      cuenta_id,
      tipo
    });
  }

  async onCuentaEstadoCambiado(event) {
    const eventData = event?.data || event?.payload || event;
    const { cuenta_id, estado_nuevo } = eventData;
    if (!cuenta_id || !estado_nuevo) return;

    await this.onEvento(event);

    const cuenta = this.cuentasActivasCache.get(cuenta_id);
    if (cuenta) {
      cuenta.estado = estado_nuevo;
      cuenta.updated_at = eventData.changed_at || new Date().toISOString();
      await this.guardarCuentasActivas();

      this.logger.info('persistencia.cuenta_activa.estado_actualizado', {
        cuenta_id,
        estado: estado_nuevo
      });
    }
  }

  async onCuentaActualizada(event) {
    const eventData = event?.data || event?.payload || event;
    const { cuenta_id, cambios } = eventData;
    if (!cuenta_id || !cambios) return;

    await this.onEvento(event);

    const cuenta = this.cuentasActivasCache.get(cuenta_id);
    if (cuenta) {
      // Persistir campos relevantes: pagado, servido, total, items, estado, nombre
      if (cambios.pagado !== undefined) cuenta.pagado = cambios.pagado;
      if (cambios.servido !== undefined) cuenta.servido = cambios.servido;
      if (cambios.total !== undefined) cuenta.total = cambios.total;
      if (cambios.items !== undefined) cuenta.items = cambios.items;
      if (cambios.estado !== undefined) cuenta.estado = cambios.estado;
      if (cambios.nombre !== undefined) {
        cuenta.datos_especificos = cuenta.datos_especificos || {};
        cuenta.datos_especificos.nombre = cambios.nombre;
      }
      cuenta.updated_at = eventData.updated_at || new Date().toISOString();
      await this.guardarCuentasActivas();

      this.logger.info('persistencia.cuenta_activa.actualizada', {
        cuenta_id,
        cambios: Object.keys(cambios)
      });
    }
  }

  async onCuentaEliminada(event) {
    const eventData = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;

    await this.onEvento(event);

    const { cuenta_id } = eventData;
    if (!cuenta_id) return;

    // Safety net: si la cuenta sigue en cache (por race condition o fallo previo), eliminarla
    if (this.cuentasActivasCache.has(cuenta_id)) {
      this.cuentasActivasCache.delete(cuenta_id);
      await this.guardarCuentasActivas();

      this.logger.info('persistencia.cuenta_eliminada.limpieza', {
        correlation_id: correlationId,
        cuenta_id
      });
    }
  }

  async onPedidoCreado(event) {
    const eventData = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;

    await this.onEvento(event);

    const { cuenta_id, pedido_id, items, total } = eventData;

    const cuenta = this.cuentasActivasCache.get(cuenta_id);
    if (!cuenta) {
      this.logger.warn('persistencia.pedido_sin_cuenta', {
        correlation_id: correlationId,
        cuenta_id
      });
      return;
    }

    cuenta.pedidos.push({
      pedido_id,
      items: items || [],
      total: total || 0
    });

    // NO sumar total aquí — ya se acumula via onCuentaActualizada
    // en cada comandero.item_agregado
    cuenta.updated_at = new Date().toISOString();

    await this.guardarCuentasActivas();

    this.logger.debug('persistencia.cuenta_actualizada', {
      correlation_id: correlationId,
      cuenta_id,
      nuevo_total: cuenta.total
    });
  }

  async onMesaRenombrada(event) {
    const eventData = event?.data || event?.payload || event;

    await this.onEvento(event);

    const { cuenta_id, nombre } = eventData;
    if (!cuenta_id || !nombre) return;

    const cuenta = this.cuentasActivasCache.get(cuenta_id);
    if (!cuenta) return;

    if (!cuenta.datos_especificos) cuenta.datos_especificos = {};
    cuenta.datos_especificos.nombre = nombre;
    cuenta.updated_at = new Date().toISOString();

    await this.guardarCuentasActivas();

    this.logger.info('persistencia.mesa_renombrada', { cuenta_id, nombre });
  }

  // ==========================================
  // File Operations
  // ==========================================

  _enqueueWrite(label, fn) {
    this._writeQueue = this._writeQueue.then(fn).catch(error => {
      this.internalMetrics.errores_escritura++;
      this.metrics.increment('persistencia.errores.total');
      this.logger.error(`persistencia.${label}.error`, { error: error.message });
    });
    return this._writeQueue;
  }

  async guardarEventos() {
    return this._enqueueWrite('guardar_eventos', async () => {
      // 1. Guardar global (backward compatible)
      const archivo = path.join(this.currentDir, 'eventos.json');
      const data = {
        fecha: this.fechaJornada,
        eventos: this.eventosCache,
        total_eventos: this.eventosCache.length,
        ultima_actualizacion: new Date().toISOString()
      };
      await fs.writeFile(archivo, JSON.stringify(data, null, 2), 'utf8');

      // 2. Guardar por proyecto
      await this._guardarEventosPorProyecto();
    });
  }

  async _guardarEventosPorProyecto() {
    const porProyecto = new Map();

    for (const evento of this.eventosCache) {
      const pid = evento.payload?.project_id;
      if (!pid) continue;
      if (!porProyecto.has(pid)) porProyecto.set(pid, []);
      porProyecto.get(pid).push(evento);
    }

    for (const [projectId, eventos] of porProyecto) {
      try {
        const dirs = await this.getProjectDirs(projectId);
        if (!dirs) continue;

        const archivo = path.join(dirs.current, 'eventos.json');
        const data = {
          fecha: this.fechaJornada,
          project_id: projectId,
          eventos,
          total_eventos: eventos.length,
          ultima_actualizacion: new Date().toISOString()
        };
        await fs.writeFile(archivo, JSON.stringify(data, null, 2), 'utf8');
      } catch (error) {
        this.logger.warn('persistencia.proyecto.eventos.error', {
          project_id: projectId,
          error: error.message
        });
      }
    }
  }

  async guardarVentas() {
    return this._enqueueWrite('guardar_ventas', async () => {
      // 1. Guardar global
      const archivo = path.join(this.currentDir, 'ventas.json');
      const resumen = this.calcularResumenDia();
      const data = {
        fecha: this.fechaJornada,
        ventas: this.ventasCache,
        resumen_dia: resumen,
        ultima_actualizacion: new Date().toISOString()
      };
      await fs.writeFile(archivo, JSON.stringify(data, null, 2), 'utf8');

      // 2. Guardar por proyecto
      await this._guardarVentasPorProyecto();
    });
  }

  async _guardarVentasPorProyecto() {
    const porProyecto = new Map();

    for (const venta of this.ventasCache) {
      const pid = venta.project_id;
      if (!pid) continue;
      if (!porProyecto.has(pid)) porProyecto.set(pid, []);
      porProyecto.get(pid).push(venta);
    }

    for (const [projectId, ventas] of porProyecto) {
      try {
        const dirs = await this.getProjectDirs(projectId);
        if (!dirs) continue;

        const resumen = this.calcularResumenDia(ventas);
        const archivo = path.join(dirs.current, 'ventas.json');
        const data = {
          fecha: this.fechaJornada,
          project_id: projectId,
          ventas,
          resumen_dia: resumen,
          ultima_actualizacion: new Date().toISOString()
        };
        await fs.writeFile(archivo, JSON.stringify(data, null, 2), 'utf8');
      } catch (error) {
        this.logger.warn('persistencia.proyecto.ventas.error', {
          project_id: projectId,
          error: error.message
        });
      }
    }
  }

  async guardarCuentasActivas() {
    return this._enqueueWrite('guardar_cuentas', async () => {
      // 1. Guardar global
      const archivo = path.join(this.currentDir, 'cuentas_activas.json');
      const cuentasObj = {};
      for (const [cuenta_id, cuenta] of this.cuentasActivasCache.entries()) {
        cuentasObj[cuenta_id] = cuenta;
      }
      const data = {
        fecha: this.fechaJornada,
        cuentas: cuentasObj,
        total_cuentas: this.cuentasActivasCache.size,
        ultima_actualizacion: new Date().toISOString()
      };
      await fs.writeFile(archivo, JSON.stringify(data, null, 2), 'utf8');

      // 2. Guardar por proyecto
      await this._guardarCuentasActivasPorProyecto();
    });
  }

  async _guardarCuentasActivasPorProyecto() {
    const porProyecto = new Map();

    for (const [cuenta_id, cuenta] of this.cuentasActivasCache.entries()) {
      const pid = cuenta.project_id;
      if (!pid) continue;
      if (!porProyecto.has(pid)) porProyecto.set(pid, new Map());
      porProyecto.get(pid).set(cuenta_id, cuenta);
    }

    for (const [projectId, cuentasMap] of porProyecto) {
      try {
        const dirs = await this.getProjectDirs(projectId);
        if (!dirs) continue;

        const cuentasObj = {};
        for (const [cuenta_id, cuenta] of cuentasMap.entries()) {
          cuentasObj[cuenta_id] = cuenta;
        }

        const archivo = path.join(dirs.current, 'cuentas_activas.json');
        const data = {
          fecha: this.fechaJornada,
          project_id: projectId,
          cuentas: cuentasObj,
          total_cuentas: cuentasMap.size,
          ultima_actualizacion: new Date().toISOString()
        };
        await fs.writeFile(archivo, JSON.stringify(data, null, 2), 'utf8');
      } catch (error) {
        this.logger.warn('persistencia.proyecto.cuentas.error', {
          project_id: projectId,
          error: error.message
        });
      }
    }
  }

  /**
   * Carga la jornada activa desde disco.
   * La jornada se fija al iniciar día y NO cambia hasta el cierre,
   * aunque cruce medianoche (ej: jornada del martes de 18:00 a 00:30).
   */
  async cargarJornada() {
    try {
      const archivoJornada = path.join(this.currentDir, 'jornada.json');
      const contenido = await fs.readFile(archivoJornada, 'utf8');
      const datos = JSON.parse(contenido);
      this.fechaJornada = datos.fecha_jornada;
      this.horaInicioJornada = datos.hora_inicio || null;
      this.logger.info('persistencia.jornada_cargada', {
        fecha_jornada: this.fechaJornada,
        hora_inicio: this.horaInicioJornada
      });
    } catch (error) {
      // Sin jornada previa: usar fecha calendario como primera jornada
      this.fechaJornada = this.getFechaCalendario();
      this.horaInicioJornada = new Date().toISOString();
      await this.guardarJornada();
      this.logger.info('persistencia.jornada_nueva', {
        fecha_jornada: this.fechaJornada
      });
    }
  }

  async guardarJornada() {
    return this._enqueueWrite('guardar_jornada', async () => {
      const archivo = path.join(this.currentDir, 'jornada.json');
      const data = {
        fecha_jornada: this.fechaJornada,
        hora_inicio: this.horaInicioJornada,
        guardado_at: new Date().toISOString()
      };
      await fs.writeFile(archivo, JSON.stringify(data, null, 2), 'utf8');

      // Guardar jornada en cada proyecto activo
      for (const projectId of this.getActiveProjectIds()) {
        try {
          const dirs = await this.getProjectDirs(projectId);
          if (!dirs) continue;
          const archivoProj = path.join(dirs.current, 'jornada.json');
          await fs.writeFile(archivoProj, JSON.stringify(data, null, 2), 'utf8');
        } catch (error) {
          // No critico
        }
      }
    });
  }

  async cargarDatosActuales() {
    try {
      const archivoEventos = path.join(this.currentDir, 'eventos.json');
      const dataEventos = await fs.readFile(archivoEventos, 'utf8');
      const eventosData = JSON.parse(dataEventos);
      this.eventosCache = eventosData.eventos || [];

      const archivoVentas = path.join(this.currentDir, 'ventas.json');
      const dataVentas = await fs.readFile(archivoVentas, 'utf8');
      const ventasData = JSON.parse(dataVentas);
      this.ventasCache = ventasData.ventas || [];

      const archivoCuentas = path.join(this.currentDir, 'cuentas_activas.json');
      const dataCuentas = await fs.readFile(archivoCuentas, 'utf8');
      const cuentasData = JSON.parse(dataCuentas);

      this.cuentasActivasCache.clear();
      if (cuentasData.cuentas) {
        for (const [cuenta_id, cuenta] of Object.entries(cuentasData.cuentas)) {
          this.cuentasActivasCache.set(cuenta_id, cuenta);
        }
      }

      this.logger.info('persistencia.datos_cargados', {
        eventos: this.eventosCache.length,
        ventas: this.ventasCache.length,
        cuentas_activas: this.cuentasActivasCache.size
      });

    } catch (error) {
      this.logger.info('persistencia.sin_datos_previos');
      this.eventosCache = [];
      this.ventasCache = [];
      this.cuentasActivasCache.clear();
    }
  }

  // ==========================================
  // Rotación Diaria
  // ==========================================

  // Rotación automática eliminada: la jornada se controla manualmente
  // con cierre_caja + iniciar_dia. No hay rotación a medianoche.

  // ==========================================
  // UI Handlers (MQTT Request/Response)
  // ==========================================

  async handleGetCuentasActivas(data) {
    const { project_id, tipo } = data || {};

    let cuentas = Array.from(this.cuentasActivasCache.values());

    // Filtrar por proyecto
    if (project_id) {
      cuentas = cuentas.filter(c => c.project_id === project_id);
    }

    if (tipo) {
      cuentas = cuentas.filter(c => c.tipo === tipo);
    }

    return {
      status: 200,
      data: {
        fecha: this.fechaJornada,
        project_id: project_id || null,
        cuentas,
        total: cuentas.length
      }
    };
  }

  async handleGetEventos(data) {
    const { project_id } = data || {};

    let eventos = this.eventosCache;

    // Filtrar por proyecto si se especifica
    if (project_id) {
      eventos = eventos.filter(e => e.payload?.project_id === project_id);
    }

    return {
      status: 200,
      data: {
        fecha: this.fechaJornada,
        project_id: project_id || null,
        eventos,
        total: eventos.length
      }
    };
  }

  async handleGetEventosFecha(data) {
    const { fecha, project_id } = data;

    try {
      // Si hay project_id, buscar primero en persistencia del proyecto
      if (project_id) {
        const dirs = await this.getProjectDirs(project_id);
        if (dirs) {
          try {
            const archivoProj = path.join(dirs.eventos, `${fecha}.json`);
            const content = await fs.readFile(archivoProj, 'utf8');
            return { status: 200, data: JSON.parse(content) };
          } catch (e) {
            // Fallback a global
          }
        }
      }

      const archivo = path.join(this.eventosDir, `${fecha}.json`);
      const content = await fs.readFile(archivo, 'utf8');
      const eventos = JSON.parse(content);

      return { status: 200, data: eventos };
    } catch (error) {
      return { status: 404, error: 'No hay eventos para esa fecha' };
    }
  }

  async handleGetVentas(data) {
    const { project_id } = data || {};

    let ventas = this.ventasCache;

    // Filtrar por proyecto
    if (project_id) {
      ventas = ventas.filter(v => v.project_id === project_id);
    }

    const resumen = this.calcularResumenDia(ventas);

    return {
      status: 200,
      data: {
        fecha: this.fechaJornada,
        project_id: project_id || null,
        ventas,
        resumen_dia: resumen,
        total: ventas.length
      }
    };
  }

  async handleGetVentasFecha(data) {
    const { fecha, project_id } = data;

    try {
      // Si hay project_id, buscar en persistencia del proyecto
      if (project_id) {
        const dirs = await this.getProjectDirs(project_id);
        if (dirs) {
          try {
            const archivoProj = path.join(dirs.ventas, `${fecha}.json`);
            const content = await fs.readFile(archivoProj, 'utf8');
            return { status: 200, data: JSON.parse(content) };
          } catch (e) {
            // Fallback a global
          }
        }
      }

      const archivo = path.join(this.ventasDir, `${fecha}.json`);
      const content = await fs.readFile(archivo, 'utf8');
      const ventas = JSON.parse(content);

      return { status: 200, data: ventas };
    } catch (error) {
      return { status: 404, error: 'No hay ventas para esa fecha' };
    }
  }

  async handleCuadreCaja(data) {
    const { project_id } = data || {};

    let ventas = this.ventasCache;
    if (project_id) {
      ventas = ventas.filter(v => v.project_id === project_id);
    }

    const resumen = this.calcularResumenDia(ventas);

    return {
      status: 200,
      data: {
        fecha: this.fechaJornada,
        project_id: project_id || null,
        timestamp: new Date().toISOString(),
        cuadre: resumen
      }
    };
  }

  async handleCuadreCajaFecha(data) {
    const { fecha, project_id } = data;

    try {
      // Si hay project_id, buscar en persistencia del proyecto
      if (project_id) {
        const dirs = await this.getProjectDirs(project_id);
        if (dirs) {
          try {
            const archivoProj = path.join(dirs.ventas, `${fecha}.json`);
            const content = await fs.readFile(archivoProj, 'utf8');
            const ventas = JSON.parse(content);
            return { status: 200, data: { fecha, project_id, cuadre: ventas.resumen_dia || {} } };
          } catch (e) {
            // Fallback a global
          }
        }
      }

      const archivo = path.join(this.ventasDir, `${fecha}.json`);
      const content = await fs.readFile(archivo, 'utf8');
      const ventas = JSON.parse(content);

      return {
        status: 200,
        data: { fecha, cuadre: ventas.resumen_dia || {} }
      };
    } catch (error) {
      return { status: 404, error: 'No hay datos para esa fecha' };
    }
  }

  async handleCierreCaja(data) {
    const { arqueo, project_id } = data;

    if (!arqueo) {
      return { status: 400, error: 'Se requiere arqueo con el dinero contado' };
    }

    try {
      // Filtrar cuentas y ventas por proyecto si se especifica
      let cuentasAbiertas = Array.from(this.cuentasActivasCache.values());
      let ventasParaCierre = this.ventasCache;

      if (project_id) {
        cuentasAbiertas = cuentasAbiertas.filter(c => c.project_id === project_id);
        ventasParaCierre = ventasParaCierre.filter(v => v.project_id === project_id);
      }

      // 1. Recopilar informe de cuentas abiertas antes de cerrarlas
      const informeCuentasAbiertas = cuentasAbiertas.map(c => ({
        cuenta_id: c.cuenta_id || c.id,
        tipo: c.tipo,
        nombre: c.datos_especificos?.nombre || c.nombre || 'Sin nombre',
        estado: c.estado,
        total: c.total || 0,
        items: c.items || 0,
        hora_apertura: c.created_at,
        pedidos: c.pedidos || []
      }));

      // 2. Cerrar automáticamente cuentas abiertas
      if (cuentasAbiertas.length > 0) {
        this.logger.info('persistencia.cierre_caja.cerrando_cuentas', {
          cuentas_abiertas: cuentasAbiertas.length,
          project_id: project_id || 'global'
        });

        for (const cuenta of cuentasAbiertas) {
          const cuentaId = cuenta.cuenta_id || cuenta.id;

          // Emitir evento de cierre forzado para cada cuenta
          await this.eventBus.publish('cuenta.cerrada_forzada', {
            cuenta_id: cuentaId,
            project_id: cuenta.project_id,
            motivo: 'cierre_de_caja',
            cuenta_snapshot: cuenta
          });

          // Eliminar de cache
          this.cuentasActivasCache.delete(cuentaId);
        }

        await this.guardarCuentasActivas();
      }

      // 3. Calcular resumen del día
      const resumen = this.calcularResumenDia(ventasParaCierre);
      const totalEsperadoEfectivo = resumen.por_metodo_pago.efectivo || 0;
      const totalArqueado = arqueo.total_contado || ((arqueo.efectivo || 0) + (arqueo.monedas || 0));
      const diferencia = totalArqueado - totalEsperadoEfectivo;

      const horaCierre = new Date().toISOString();
      const cierre = {
        cierre_id: `cierre_${Date.now()}`,
        project_id: project_id || null,
        fecha_jornada: this.fechaJornada,
        hora_inicio: this.horaInicioJornada,
        hora_cierre: horaCierre,
        arqueo,
        totales: resumen,
        diferencia,
        estado: diferencia === 0 ? 'cuadrado' : (diferencia > 0 ? 'sobrante' : 'faltante'),
        cuentas_cerradas_forzadas: informeCuentasAbiertas
      };

      // 4. Calcular desglose de productos y generar informe
      const desglose_productos = this.calcularDesgloseProductos(ventasParaCierre);
      cierre.desglose_productos = desglose_productos;
      const informe = this.generarInformeCierre(cierre, ventasParaCierre);

      // 5. Guardar cierre global
      const archivoCierre = path.join(this.ventasDir, `cierre_${this.fechaJornada}.json`);
      await fs.writeFile(archivoCierre, JSON.stringify(cierre, null, 2), 'utf8');

      // 6. Guardar cierre en proyecto (persistencia + contabilidad)
      if (project_id) {
        const dirs = await this.getProjectDirs(project_id);
        if (dirs) {
          // Cierre en persistencia/ventas/
          const archivoCierreProj = path.join(dirs.ventas, `cierre_${this.fechaJornada}.json`);
          await fs.writeFile(archivoCierreProj, JSON.stringify(cierre, null, 2), 'utf8');

          // Cierre en contabilidad/cierres/
          const archivoCierreContab = path.join(dirs.contabilidad, `cierre_${this.fechaJornada}.json`);
          await fs.writeFile(archivoCierreContab, JSON.stringify({
            ...cierre,
            informe,
            ventas: ventasParaCierre
          }, null, 2), 'utf8');

          this.logger.info('persistencia.cierre_proyecto.guardado', {
            project_id,
            contabilidad: archivoCierreContab
          });
        }
      }

      await this.archivarDia(project_id);

      // 7. Publicar evento con informe completo para notificación
      await this.eventBus.publish('caja.cerrada', {
        fecha: this.fechaJornada,
        project_id: project_id || null,
        arqueo,
        totales: resumen,
        diferencia,
        cierre,
        informe
      });

      this.logger.info('persistencia.cierre_caja', {
        fecha: this.fechaJornada,
        project_id: project_id || 'global',
        diferencia,
        estado: cierre.estado,
        cuentas_forzadas: informeCuentasAbiertas.length
      });

      return { status: 200, data: { message: 'Cierre de caja completado', cierre } };

    } catch (error) {
      this.logger.error('persistencia.cierre_caja.error', { error: error.message });
      return { status: 500, error: 'Error realizando cierre de caja' };
    }
  }

  /**
   * Genera informe de cierre en texto plano para envío por mensajería.
   * Incluye desglose por método de pago, por familia/categoría y por producto individual.
   */
  generarInformeCierre(cierre, ventasOverride = null) {
    const { fecha_jornada, hora_inicio, hora_cierre, totales, arqueo, diferencia, estado, cuentas_cerradas_forzadas, project_id } = cierre;
    const ventas = ventasOverride || this.ventasCache;

    const lineas = [];
    lineas.push(`📊 INFORME DE CIERRE DE CAJA`);
    lineas.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    if (project_id) lineas.push(`🏪 Proyecto: ${project_id}`);
    lineas.push(`📅 Jornada: ${fecha_jornada}`);
    lineas.push(`🕐 Inicio: ${hora_inicio ? new Date(hora_inicio).toLocaleTimeString('es-ES') : '—'}`);
    lineas.push(`🕐 Cierre: ${hora_cierre ? new Date(hora_cierre).toLocaleTimeString('es-ES') : '—'}`);
    lineas.push(``);

    // Resumen de ventas
    lineas.push(`💰 RESUMEN DE VENTAS`);
    lineas.push(`─────────────────────`);
    lineas.push(`Total ventas: ${totales.total_ventas}`);
    lineas.push(`Ingresos: ${(totales.total_ingresos || 0).toFixed(2)} €`);
    lineas.push(`Propinas: ${(totales.total_propinas || 0).toFixed(2)} €`);
    lineas.push(``);

    // Por método de pago
    lineas.push(`💳 POR MÉTODO DE PAGO`);
    lineas.push(`─────────────────────`);
    for (const [metodo, total] of Object.entries(totales.por_metodo_pago || {})) {
      if (Number(total) > 0) {
        lineas.push(`  ${metodo}: ${Number(total).toFixed(2)} €`);
      }
    }
    lineas.push(``);

    // Por tipo de cuenta
    lineas.push(`📋 POR TIPO DE CUENTA`);
    lineas.push(`─────────────────────`);
    for (const [tipo, total] of Object.entries(totales.por_tipo_cuenta || {})) {
      if (Number(total) > 0) {
        lineas.push(`  ${tipo}: ${Number(total).toFixed(2)} €`);
      }
    }
    lineas.push(``);

    // ==========================================
    // DESGLOSE POR FAMILIA Y PRODUCTO
    // ==========================================
    const { porFamilia, porProducto, totalUnidades } = this.calcularDesgloseProductos(ventas);

    if (totalUnidades > 0) {
      lineas.push(`🍕 PRODUCTOS VENDIDOS (${totalUnidades} uds)`);
      lineas.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━`);

      // Por familia: total global de cada familia + detalle individual
      const familiasOrdenadas = Object.entries(porFamilia)
        .sort((a, b) => b[1].importe - a[1].importe);

      for (const [familia, datosFamilia] of familiasOrdenadas) {
        lineas.push(``);
        lineas.push(`📦 ${familia} — ${datosFamilia.cantidad} uds | ${datosFamilia.importe.toFixed(2)} €`);
        lineas.push(`─────────────────────`);

        // Productos individuales de esta familia
        const productosEnFamilia = Object.entries(porProducto)
          .filter(([, p]) => p.familia === familia)
          .sort((a, b) => b[1].cantidad - a[1].cantidad);

        for (const [nombre, datos] of productosEnFamilia) {
          lineas.push(`  ${nombre}: ${datos.cantidad} uds | ${datos.importe.toFixed(2)} €`);
        }
      }
      lineas.push(``);
    }

    // Arqueo
    lineas.push(`🔢 ARQUEO DE CAJA`);
    lineas.push(`─────────────────────`);
    const totalContado = arqueo.total_contado || ((arqueo.efectivo || 0) + (arqueo.monedas || 0));
    lineas.push(`Efectivo contado: ${totalContado.toFixed(2)} €`);
    lineas.push(`Efectivo esperado: ${(totales.por_metodo_pago?.efectivo || 0).toFixed(2)} €`);
    lineas.push(`Diferencia: ${diferencia >= 0 ? '+' : ''}${diferencia.toFixed(2)} €`);
    lineas.push(`Estado: ${estado === 'cuadrado' ? '✅ Cuadrado' : estado === 'sobrante' ? '⬆️ Sobrante' : '⬇️ Faltante'}`);
    lineas.push(``);

    // Detalle de ventas cerradas
    if (ventas.length > 0) {
      lineas.push(`📝 DETALLE DE VENTAS (${ventas.length})`);
      lineas.push(`─────────────────────`);
      for (const venta of ventas) {
        const nombre = venta.cuenta?.nombre || venta.cuenta?.tipo || '—';
        const metodo = venta.cobro?.metodo_pago || '—';
        const total = (venta.resumen?.total_final || 0).toFixed(2);
        const items = venta.pedidos?.reduce((sum, p) => sum + (p.items?.length || 0), 0) || 0;
        lineas.push(`  • ${nombre} | ${items} items | ${total} € (${metodo})`);
      }
      lineas.push(``);
    }

    // Cuentas cerradas forzadamente
    if (cuentas_cerradas_forzadas && cuentas_cerradas_forzadas.length > 0) {
      lineas.push(`⚠️ CUENTAS CERRADAS AL CIERRE (${cuentas_cerradas_forzadas.length})`);
      lineas.push(`─────────────────────`);
      for (const c of cuentas_cerradas_forzadas) {
        lineas.push(`  • ${c.nombre} | Estado: ${c.estado} | ${(c.total || 0).toFixed(2)} € | ${c.items} items`);
      }
      lineas.push(``);
    }

    // Por camarero
    if (totales.por_camarero && Object.keys(totales.por_camarero).length > 0) {
      lineas.push(`👤 POR CAMARERO`);
      lineas.push(`─────────────────────`);
      for (const [camarero, total] of Object.entries(totales.por_camarero)) {
        lineas.push(`  ${camarero}: ${Number(total).toFixed(2)} €`);
      }
      lineas.push(``);
    }

    lineas.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lineas.push(`Generado: ${new Date().toLocaleString('es-ES')}`);

    return lineas.join('\n');
  }

  /**
   * Calcula desglose de productos vendidos agrupados por familia/categoría.
   * Recorre los items de todos los pedidos de las ventas del día.
   * Devuelve totales por familia (global) y por producto (individual).
   */
  calcularDesgloseProductos(ventas = null) {
    const ventasToProcess = ventas || this.ventasCache;

    const porFamilia = {};   // { familia: { cantidad, importe } }
    const porProducto = {};  // { nombre: { cantidad, importe, familia } }
    let totalUnidades = 0;

    for (const venta of ventasToProcess) {
      for (const pedido of (venta.pedidos || [])) {
        for (const item of (pedido.items || [])) {
          const nombre = item.nombre || item.producto_id || 'Desconocido';
          const familia = item.categoria || item.familia || 'Sin categoría';
          const cantidad = item.cantidad || 1;
          const importe = item.precio_total || item.subtotal || (item.precio_unitario || item.precio || 0) * cantidad;

          totalUnidades += cantidad;

          // Acumular por familia
          if (!porFamilia[familia]) {
            porFamilia[familia] = { cantidad: 0, importe: 0 };
          }
          porFamilia[familia].cantidad += cantidad;
          porFamilia[familia].importe += importe;

          // Acumular por producto individual
          if (!porProducto[nombre]) {
            porProducto[nombre] = { cantidad: 0, importe: 0, familia };
          }
          porProducto[nombre].cantidad += cantidad;
          porProducto[nombre].importe += importe;
        }
      }
    }

    return { porFamilia, porProducto, totalUnidades };
  }

  async handleIniciarDia() {
    try {
      // Fijar fecha de jornada = día calendario en que se inicia
      // Esta fecha NO cambia aunque cruce medianoche
      const horaInicio = new Date().toISOString();
      this.fechaJornada = this.getFechaCalendario();
      this.horaInicioJornada = horaInicio;

      // Limpiar caches del día anterior
      this.eventosCache = [];
      this.ventasCache = [];
      this.cuentasActivasCache.clear();

      await this.guardarJornada();
      await this.guardarEventos();
      await this.guardarVentas();
      await this.guardarCuentasActivas();

      await this.eventBus.publish('dia.iniciado', {
        fecha: this.fechaJornada,
        hora_inicio: horaInicio
      });

      this.logger.info('persistencia.jornada_iniciada', {
        fecha_jornada: this.fechaJornada,
        hora_inicio: horaInicio
      });

      return {
        status: 200,
        data: {
          message: 'Jornada iniciada',
          fecha_jornada: this.fechaJornada,
          hora_inicio: horaInicio
        }
      };

    } catch (error) {
      this.logger.error('persistencia.iniciar_dia.error', { error: error.message });
      return { status: 500, error: 'Error iniciando nuevo día' };
    }
  }

  async handleBackup() {
    try {
      const timestamp = Date.now();
      const backupName = `backup_${this.fechaJornada}_${timestamp}`;
      const backupPath = path.join(this.backupDir, backupName);

      await fs.mkdir(backupPath, { recursive: true });

      const eventosActual = path.join(this.currentDir, 'eventos.json');
      await fs.copyFile(eventosActual, path.join(backupPath, 'eventos.json'));

      const ventasActual = path.join(this.currentDir, 'ventas.json');
      await fs.copyFile(ventasActual, path.join(backupPath, 'ventas.json'));

      // Backup por proyecto
      for (const projectId of this.getActiveProjectIds()) {
        try {
          const dirs = await this.getProjectDirs(projectId);
          if (!dirs) continue;
          const projBackup = path.join(dirs.backups, backupName);
          await fs.mkdir(projBackup, { recursive: true });

          const evProj = path.join(dirs.current, 'eventos.json');
          const vtProj = path.join(dirs.current, 'ventas.json');
          try { await fs.copyFile(evProj, path.join(projBackup, 'eventos.json')); } catch (e) { /* ok */ }
          try { await fs.copyFile(vtProj, path.join(projBackup, 'ventas.json')); } catch (e) { /* ok */ }
        } catch (error) {
          // No critico
        }
      }

      this.logger.info('persistencia.backup.creado', { backup_name: backupName });

      return {
        status: 200,
        data: {
          message: 'Backup creado exitosamente',
          backup_name: backupName,
          backup_path: backupPath
        }
      };

    } catch (error) {
      this.logger.error('persistencia.backup.error', { error: error.message });
      return { status: 500, error: 'Error creando backup' };
    }
  }

  async handleHealthCheck() {
    return {
      status: 200,
      data: {
        status: 'healthy',
        module: this.name,
        version: this.version,
        fecha_jornada: this.fechaJornada,
        eventos_cache: this.eventosCache.length,
        ventas_cache: this.ventasCache.length,
        cuentas_activas: this.cuentasActivasCache.size,
        proyectos_activos: [...this.getActiveProjectIds()]
      }
    };
  }

  async handleGetMetrics() {
    return {
      status: 200,
      data: {
        ...this.internalMetrics,
        eventos_dia: this.eventosCache.length,
        ventas_dia: this.ventasCache.length,
        cuentas_activas: this.cuentasActivasCache.size,
        proyectos_activos: this.getActiveProjectIds().size
      }
    };
  }

  // ==========================================
  // Business Logic
  // ==========================================

  async archivarDia(projectId = null) {
    try {
      // Archivar global
      const eventosActual = path.join(this.currentDir, 'eventos.json');
      const eventosArchivo = path.join(this.eventosDir, `${this.fechaJornada}.json`);
      await fs.copyFile(eventosActual, eventosArchivo);

      const ventasActual = path.join(this.currentDir, 'ventas.json');
      const ventasArchivo = path.join(this.ventasDir, `${this.fechaJornada}.json`);
      await fs.copyFile(ventasActual, ventasArchivo);

      this.logger.info('persistencia.dia_archivado', { fecha: this.fechaJornada });

      // Archivar por proyecto
      const projectIds = projectId ? [projectId] : [...this.getActiveProjectIds()];
      for (const pid of projectIds) {
        try {
          const dirs = await this.getProjectDirs(pid);
          if (!dirs) continue;

          const evCurrent = path.join(dirs.current, 'eventos.json');
          const evArchivo = path.join(dirs.eventos, `${this.fechaJornada}.json`);
          try { await fs.copyFile(evCurrent, evArchivo); } catch (e) { /* ok */ }

          const vtCurrent = path.join(dirs.current, 'ventas.json');
          const vtArchivo = path.join(dirs.ventas, `${this.fechaJornada}.json`);
          try { await fs.copyFile(vtCurrent, vtArchivo); } catch (e) { /* ok */ }

          this.logger.info('persistencia.proyecto.dia_archivado', {
            project_id: pid,
            fecha: this.fechaJornada
          });
        } catch (error) {
          this.logger.warn('persistencia.proyecto.archivar.error', {
            project_id: pid,
            error: error.message
          });
        }
      }
    } catch (error) {
      this.logger.error('persistencia.archivar_dia.error', { error: error.message });
    }
  }

  calcularResumenDia(ventas = null) {
    const ventasToProcess = ventas || this.ventasCache;

    const resumen = {
      total_ventas: ventasToProcess.length,
      total_ingresos: 0,
      total_propinas: 0,
      por_metodo_pago: {
        efectivo: 0,
        tarjeta: 0,
        bizum: 0,
        transferencia: 0
      },
      por_tipo_cuenta: {
        mesa: 0,
        telefono: 0,
        llevar: 0
      },
      por_camarero: {}
    };

    for (const venta of ventasToProcess) {
      resumen.total_ingresos += venta.resumen.total_final;
      resumen.total_propinas += venta.resumen.propina;

      const metodo = venta.cobro.metodo_pago;
      if (resumen.por_metodo_pago[metodo] !== undefined) {
        resumen.por_metodo_pago[metodo] += venta.resumen.total_final;
      }

      const tipo = venta.cuenta.tipo;
      if (resumen.por_tipo_cuenta[tipo] !== undefined) {
        resumen.por_tipo_cuenta[tipo] += venta.resumen.total_final;
      }

      const camarero = venta.cuenta.metadata?.camarero;
      if (camarero) {
        if (!resumen.por_camarero[camarero]) {
          resumen.por_camarero[camarero] = 0;
        }
        resumen.por_camarero[camarero] += venta.resumen.total_final;
      }
    }

    return resumen;
  }

  // ==========================================
  // Helper Methods
  // ==========================================

  getFechaCalendario() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

module.exports = PersistenciaComanderoModule;
