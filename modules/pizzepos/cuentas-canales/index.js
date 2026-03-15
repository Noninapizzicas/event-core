/**
 * Módulo Cuentas Canales v3.0
 * Sistema unificado de canales de venta con patrón Strategy
 * Un solo módulo gestiona: mesa, teléfono, llevar, glovo, whatsapp
 *
 * Cada canal es un Strategy independiente que se registra en este módulo base.
 * El módulo base proporciona:
 *   - Lifecycle común (onLoad/onUnload)
 *   - Gestión de cobro.procesado → delega al canal correcto por prefijo
 *   - Reseteo diario de contadores
 *   - Contadores secuenciales por canal
 *   - Tracking de tiempos con promedios rolling
 *   - Publishers comunes: cuenta.creada, cuenta.cerrada
 *   - Health y métricas agregadas
 *
 * Emite: cuenta.creada, cuenta.cerrada (+ eventos específicos de cada canal)
 * Consume: cobro.procesado (+ eventos específicos de cada canal)
 */

const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const MesaStrategy = require('./strategies/mesa');
const TelefonoStrategy = require('./strategies/telefono');
const LlevarStrategy = require('./strategies/llevar');
const GlovoStrategy = require('./strategies/glovo');
const WhatsAppStrategy = require('./strategies/whatsapp');

class CuentasCanalesModule {
  constructor() {
    this.name = 'cuentas-canales';
    this.version = '3.0.0';

    // Dependencias (inyectadas en onLoad)
    this.eventBus = null;
    this.logger = null;
    this.metrics = null;
    this.uiHandler = null;
    this.config = {};

    // AJV compartido — una sola instancia para todas las strategies
    this.ajv = new Ajv({ allErrors: true, useDefaults: true });
    addFormats(this.ajv);

    // Reseteo diario
    this.fechaActual = this.getFechaActual();
    this.contadores = {};
    this._resetInterval = null;

    // Tracking de tiempos (utilidad compartida)
    this._timeArrays = {};

    // Strategies registradas
    this.strategies = {};
    this.registerStrategy(new MesaStrategy());
    this.registerStrategy(new TelefonoStrategy());
    this.registerStrategy(new LlevarStrategy());
    this.registerStrategy(new GlovoStrategy());
    this.registerStrategy(new WhatsAppStrategy());
  }

  registerStrategy(strategy) {
    this.strategies[strategy.tipo] = strategy;
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

    this.logger.info('module.loading', {
      module: this.name,
      version: this.version,
      canales: Object.keys(this.strategies)
    });

    // Inicializar cada strategy (carga schemas, config)
    for (const strategy of Object.values(this.strategies)) {
      await strategy.init(this);
    }

    // Suscripción COMÚN: cobro procesado → detectar canal → cerrar
    await this.eventBus.subscribe('cobro.procesado', this.onCobroProcesado.bind(this));

    // Suscripciones específicas por canal
    for (const strategy of Object.values(this.strategies)) {
      await strategy.subscribeToEvents(this.eventBus);
    }

    // UI Handlers específicos por canal + agregados
    if (this.uiHandler) {
      for (const strategy of Object.values(this.strategies)) {
        strategy.registerUIHandlers(this.uiHandler);
      }
      this.uiHandler.register('canales', 'health', this.handleHealthCheck.bind(this));
      this.uiHandler.register('canales', 'metrics', this.handleGetMetrics.bind(this));
      this.uiHandler.register('canales', 'list', this.handleGetCanales.bind(this));
    }

    this.iniciarReseoDiario();

    this.logger.info('module.loaded', {
      module: this.name,
      canales_activos: Object.keys(this.strategies).length
    });
  }

  async onUnload() {
    this.logger.info('module.unloading', { module: this.name });

    if (this._resetInterval) {
      clearInterval(this._resetInterval);
      this._resetInterval = null;
    }

    if (this.uiHandler) {
      for (const strategy of Object.values(this.strategies)) {
        strategy.unregisterUIHandlers(this.uiHandler);
      }
      this.uiHandler.unregister('canales', 'health');
      this.uiHandler.unregister('canales', 'metrics');
      this.uiHandler.unregister('canales', 'list');
    }

    for (const strategy of Object.values(this.strategies)) {
      strategy.cleanup();
    }

    this._timeArrays = {};
    this.contadores = {};

    this.logger.info('module.unloaded', { module: this.name });
  }

  // ==========================================
  // Evento Común: cobro.procesado
  // ==========================================

  async onCobroProcesado(event) {
    const eventData = event?.data || event?.payload || event;
    const correlationId = event?.metadata?.correlationId;
    const { cuenta_id, project_id } = eventData;

    if (!cuenta_id) return;

    const strategy = this.detectarCanal(cuenta_id);
    if (!strategy) return;

    try {
      await strategy.onCobroProcesado(cuenta_id, correlationId, project_id);

      this.logger.info('canales.cobro_procesado', {
        correlation_id: correlationId,
        canal: strategy.tipo,
        cuenta_id
      });
    } catch (error) {
      this.logger.error('canales.cobro.error', {
        correlation_id: correlationId,
        canal: strategy.tipo,
        cuenta_id,
        error: error.message
      });
    }
  }

  detectarCanal(cuenta_id) {
    for (const strategy of Object.values(this.strategies)) {
      if (cuenta_id.startsWith(strategy.prefijo)) {
        return strategy;
      }
    }
    return null;
  }

  // ==========================================
  // UI Handlers Agregados
  // ==========================================

  async handleHealthCheck() {
    const canalHealth = {};
    for (const [tipo, strategy] of Object.entries(this.strategies)) {
      canalHealth[tipo] = strategy.getHealth();
    }

    return {
      status: 200,
      data: {
        status: 'healthy',
        module: this.name,
        version: this.version,
        canales: canalHealth
      }
    };
  }

  async handleGetMetrics() {
    const canalMetrics = {};
    for (const [tipo, strategy] of Object.entries(this.strategies)) {
      canalMetrics[tipo] = strategy.getMetrics();
    }

    return {
      status: 200,
      data: {
        module: this.name,
        canales: canalMetrics
      }
    };
  }

  async handleGetCanales() {
    return {
      status: 200,
      data: {
        canales: Object.entries(this.strategies).map(([tipo, s]) => ({
          tipo,
          prefijo: s.prefijo,
          version: s.version,
          cuentas_activas: s.getCuentasActivas()
        }))
      }
    };
  }

  // ==========================================
  // Publishers Comunes
  // ==========================================

  async publishCuentaCreada(data, correlationId) {
    await this.eventBus.publish('cuenta.creada', {
      cuenta_id: data.cuenta_id,
      tipo: data.tipo,
      origen: `cuentas-canales:${data.tipo}`,
      project_id: data.project_id,
      total: data.total || 0,
      metadata: data.metadata || {}
    }, { correlationId });
  }

  async publishCuentaCerrada(data, correlationId) {
    await this.eventBus.publish('cuenta.cerrada', {
      cuenta_id: data.cuenta_id,
      tipo: data.tipo,
      project_id: data.project_id,
      total: data.total || 0,
      metadata: data.metadata || {}
    }, { correlationId });
  }

  // ==========================================
  // Helpers Comunes
  // ==========================================

  getFechaActual() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  getNextSecuencial(canal, subkey) {
    const key = subkey
      ? `${canal}_${subkey}_${this.fechaActual}`
      : `${canal}_${this.fechaActual}`;

    if (!this.contadores[key]) {
      this.contadores[key] = 1;
    } else {
      this.contadores[key]++;
    }
    return this.contadores[key];
  }

  verificarReseoDiario() {
    const fechaActual = this.getFechaActual();
    if (fechaActual !== this.fechaActual) {
      this.logger.info('canales.reseteo_diario', {
        fecha_anterior: this.fechaActual,
        fecha_nueva: fechaActual
      });
      this.fechaActual = fechaActual;
      this.contadores = {};
    }
  }

  iniciarReseoDiario() {
    this._resetInterval = setInterval(() => {
      this.verificarReseoDiario();
    }, 60 * 60 * 1000);
  }

  calcularTiempoMinutos(desde) {
    const ahora = new Date();
    const inicio = new Date(desde);
    return Math.floor((ahora - inicio) / 1000 / 60);
  }

  trackTiempo(nombre, valor) {
    if (!this._timeArrays[nombre]) {
      this._timeArrays[nombre] = { values: [], avg: 0 };
    }
    const tracker = this._timeArrays[nombre];
    tracker.values.push(valor);
    if (tracker.values.length > 100) {
      tracker.values.shift();
    }
    tracker.avg = tracker.values.reduce((a, b) => a + b, 0) / tracker.values.length;
    return tracker.avg;
  }

  getPromedioTiempo(nombre) {
    return this._timeArrays[nombre]?.avg || 0;
  }

  /**
   * Carga un schema AJV de forma segura (ignora si ya está registrado)
   */
  safeAddSchema(schema) {
    try {
      if (!this.ajv.getSchema(schema.$id)) {
        this.ajv.addSchema(schema);
      }
    } catch (err) {
      this.logger?.warn('canales.schema.error', { id: schema.$id, error: err.message });
    }
  }
}

module.exports = CuentasCanalesModule;
