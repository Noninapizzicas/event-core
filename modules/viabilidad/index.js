/**
 * Viabilidad Module v1.0.0
 *
 * Estudio de viabilidad de negocio: punto de equilibrio, proyecciones,
 * escenarios y análisis de rentabilidad.
 *
 * Lee datos de recetas y escandallo para calcular viabilidad.
 *
 * Tools:
 *   viabilidad.estudio             — Estudio completo de viabilidad
 *   viabilidad.punto_equilibrio    — Break-even analysis
 *   viabilidad.escenario           — Calcula un escenario
 *   viabilidad.comparar_escenarios — Compara escenarios lado a lado
 *   viabilidad.proyeccion          — Proyección financiera a N meses
 *   viabilidad.guardar_config      — Guarda config del negocio
 */

const path = require('path');
const fs = require('fs').promises;

class ViabilidadModule {
  constructor() {
    this.name = 'viabilidad';
    this.version = '1.0.0';
    this.eventBus = null;
    this.logger = null;
    this.metrics = null;

    // project_id → config
    this.configs = new Map();
    // project_id → { recetas, ingredientes }
    this.recetasCache = new Map();
    this.projectPaths = new Map();
    // project_id → escenarios[]
    this.escenarios = new Map();
  }

  async onLoad(context) {
    this.eventBus = context.eventBus;
    this.logger = context.logger;
    this.metrics = context.metrics;
    this.logger.info('module.loaded', { module: this.name, version: this.version });
  }

  async onUnload() {
    this.configs.clear();
    this.recetasCache.clear();
    this.projectPaths.clear();
    this.escenarios.clear();
    this.logger.info('module.unloaded', { module: this.name });
  }

  // ==========================================
  // Project resolution

  resolveToActiveProject(projectId) {
    if (projectId && this.projectPaths.has(projectId)) return projectId;
    for (const [pid] of this.projectPaths) return pid;
    return projectId;
  }

  // Data Access
  // ==========================================

  async loadRecetasData(projectId) {
    const paths = this.projectPaths.get(projectId);
    if (!paths) return { recetas: [], ingredientes: [] };

    const dir = path.join(paths.storagePath, 'recetas');
    let recetas = [];
    let ingredientes = [];

    try {
      const content = await fs.readFile(path.join(dir, 'recetas.json'), 'utf-8');
      recetas = JSON.parse(content);
    } catch (e) { /* no data */ }

    try {
      const content = await fs.readFile(path.join(dir, 'ingredientes.json'), 'utf-8');
      ingredientes = JSON.parse(content);
    } catch (e) { /* no data */ }

    this.recetasCache.set(projectId, { recetas, ingredientes });
    return { recetas, ingredientes };
  }

  async getRecetas(projectId) {
    if (this.recetasCache.has(projectId)) return this.recetasCache.get(projectId);
    return await this.loadRecetasData(projectId);
  }

  async loadConfig(projectId) {
    const paths = this.projectPaths.get(projectId);
    if (!paths) return null;
    try {
      const filePath = path.join(paths.storagePath, 'viabilidad', 'config.json');
      const content = await fs.readFile(filePath, 'utf-8');
      const config = JSON.parse(content);
      this.configs.set(projectId, config);
      return config;
    } catch (e) {
      return null;
    }
  }

  async saveConfig(projectId, config) {
    const paths = this.projectPaths.get(projectId);
    if (!paths) return;
    const dir = path.join(paths.storagePath, 'viabilidad');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
    this.configs.set(projectId, config);
  }

  async saveEstudio(projectId, estudio) {
    const paths = this.projectPaths.get(projectId);
    if (!paths) return;
    const dir = path.join(paths.storagePath, 'viabilidad');
    await fs.mkdir(dir, { recursive: true });
    const filename = `estudio_${Date.now().toString(36)}.json`;
    await fs.writeFile(path.join(dir, filename), JSON.stringify(estudio, null, 2), 'utf-8');
  }

  async loadEscenarios(projectId) {
    const paths = this.projectPaths.get(projectId);
    if (!paths) return [];
    try {
      const filePath = path.join(paths.storagePath, 'viabilidad', 'escenarios.json');
      const content = await fs.readFile(filePath, 'utf-8');
      const escenarios = JSON.parse(content);
      this.escenarios.set(projectId, escenarios);
      return escenarios;
    } catch (e) {
      return [];
    }
  }

  async saveEscenarios(projectId) {
    const paths = this.projectPaths.get(projectId);
    if (!paths) return;
    const lista = this.escenarios.get(projectId) || [];
    const dir = path.join(paths.storagePath, 'viabilidad');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'escenarios.json'), JSON.stringify(lista, null, 2), 'utf-8');
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  async onProjectActivated(event) {
    const data = event.data || event;
    const { project_id, base_path, metadata } = data;
    const resolvedBase = (metadata?.is_system === true) ? process.cwd() : base_path;
    if (resolvedBase) {
      this.projectPaths.set(project_id, {
        storagePath: path.join(resolvedBase, 'storage')
      });
    }
    await this.loadRecetasData(project_id);
    await this.loadConfig(project_id);
    await this.loadEscenarios(project_id);
    this.logger.info('viabilidad.project.activated', { project_id });
  }

  async onProjectDeactivated() {}

  async onRecetaChanged(event) {
    const data = event.data || event;
    if (data.proyecto_id) this.recetasCache.delete(data.proyecto_id);
  }

  async onEscandalloCalculado() {
    // Could trigger auto-update of viabilidad studies
  }

  // ==========================================
  // Helpers
  // ==========================================

  round(n, decimals = 2) {
    const f = Math.pow(10, decimals);
    return Math.round(n * f) / f;
  }

  getConfig(projectId) {
    return this.configs.get(projectId) || {};
  }

  calcularFoodCostMedio(recetas) {
    if (recetas.length === 0) return 30; // default estimate
    const costeMedio = recetas.reduce((s, r) => s + (r.coste_porcion || 0), 0) / recetas.length;
    return costeMedio;
  }

  calcularEscenario(params) {
    const {
      nombre,
      gastos_fijos_mensuales,
      comensales_dia,
      ticket_medio,
      food_cost_porcentaje,
      dias_operacion_mes = 25
    } = params;

    const ingresos_dia = comensales_dia * ticket_medio;
    const ingresos_mes = ingresos_dia * dias_operacion_mes;
    const coste_materia_prima_mes = ingresos_mes * (food_cost_porcentaje / 100);
    const gastos_totales_mes = gastos_fijos_mensuales + coste_materia_prima_mes;
    const beneficio_mes = ingresos_mes - gastos_totales_mes;
    const beneficio_dia = beneficio_mes / dias_operacion_mes;

    // Break-even
    const margen_contribucion_por_comensal = ticket_medio * (1 - food_cost_porcentaje / 100);
    const comensales_break_even_mes = margen_contribucion_por_comensal > 0
      ? Math.ceil(gastos_fijos_mensuales / margen_contribucion_por_comensal)
      : Infinity;
    const comensales_break_even_dia = Math.ceil(comensales_break_even_mes / dias_operacion_mes);

    return {
      nombre: nombre || 'Sin nombre',
      parametros: {
        gastos_fijos_mensuales,
        comensales_dia,
        ticket_medio,
        food_cost_porcentaje,
        dias_operacion_mes
      },
      ingresos: {
        dia: this.round(ingresos_dia),
        mes: this.round(ingresos_mes),
        anual: this.round(ingresos_mes * 12)
      },
      gastos: {
        fijos_mes: gastos_fijos_mensuales,
        materia_prima_mes: this.round(coste_materia_prima_mes),
        total_mes: this.round(gastos_totales_mes)
      },
      beneficio: {
        dia: this.round(beneficio_dia),
        mes: this.round(beneficio_mes),
        anual: this.round(beneficio_mes * 12),
        es_rentable: beneficio_mes > 0
      },
      punto_equilibrio: {
        comensales_dia: comensales_break_even_dia,
        comensales_mes: comensales_break_even_mes,
        margen_sobre_equilibrio: comensales_dia - comensales_break_even_dia,
        porcentaje_ocupacion_necesaria: this.round((comensales_break_even_dia / comensales_dia) * 100)
      }
    };
  }

  // ==========================================
  // UI Handlers
  // ==========================================

  async handleEstudio(data) {
    const project_id = this.resolveToActiveProject(data?.project_id);
    const result = await this.toolEstudio({ ...data, project_id });
    if (result.error) throw { status: result.status || 400, code: 'VIABILIDAD_ERROR', message: result.error };
    return result.data;
  }

  async handleEscenario(data) {
    const project_id = this.resolveToActiveProject(data?.project_id);
    const result = await this.toolEscenario({ ...data, project_id });
    if (result.error) throw { status: result.status || 400, code: 'ESCENARIO_ERROR', message: result.error };
    return result.data;
  }

  async handleConfig(data) {
    const project_id = this.resolveToActiveProject(data?.project_id);
    if (data.action === 'get') return this.getConfig(project_id);
    const result = await this.toolGuardarConfig({ ...data, project_id });
    return result.data;
  }

  // ==========================================
  // Tools
  // ==========================================

  async toolEstudio({ nombre_negocio, tipo_negocio, gastos_fijos_mensuales, dias_operacion_mes, comensales_dia_estimados, ticket_medio, precios_venta, project_id }) {
    if (!gastos_fijos_mensuales) return { status: 400, error: 'Se requiere "gastos_fijos_mensuales"' };
    if (!project_id) return { status: 400, error: 'Se requiere "project_id"' };

    const config = this.getConfig(project_id);
    const { recetas } = await this.getRecetas(project_id);

    // Use config defaults where params not provided
    const gf = gastos_fijos_mensuales || config.gastos_fijos_mensuales || 0;
    const dias = dias_operacion_mes || config.dias_operacion_mes || 25;
    const comensales = comensales_dia_estimados || config.comensales_dia_estimados || 50;

    // Calculate food cost from recipes if we have them
    let foodCostPct = 30; // default
    let ticketMedio = ticket_medio || config.ticket_medio;

    if (recetas.length > 0) {
      const costeMedio = recetas.reduce((s, r) => s + (r.coste_porcion || 0), 0) / recetas.length;
      if (ticketMedio) {
        foodCostPct = this.round((costeMedio / ticketMedio) * 100);
      } else {
        // Estimate ticket medio as 3x food cost (33% food cost target)
        ticketMedio = this.round(costeMedio * 3);
        foodCostPct = 33;
      }
    } else if (!ticketMedio) {
      ticketMedio = 15; // default
    }

    // Main scenario
    const escenarioPrincipal = this.calcularEscenario({
      nombre: 'Principal',
      gastos_fijos_mensuales: gf,
      comensales_dia: comensales,
      ticket_medio: ticketMedio,
      food_cost_porcentaje: foodCostPct,
      dias_operacion_mes: dias
    });

    // Conservative scenario (-20% comensales)
    const escenarioConservador = this.calcularEscenario({
      nombre: 'Conservador (-20% comensales)',
      gastos_fijos_mensuales: gf,
      comensales_dia: Math.floor(comensales * 0.8),
      ticket_medio: ticketMedio,
      food_cost_porcentaje: foodCostPct,
      dias_operacion_mes: dias
    });

    // Optimistic scenario (+30% comensales)
    const escenarioOptimista = this.calcularEscenario({
      nombre: 'Optimista (+30% comensales)',
      gastos_fijos_mensuales: gf,
      comensales_dia: Math.ceil(comensales * 1.3),
      ticket_medio: ticketMedio,
      food_cost_porcentaje: foodCostPct,
      dias_operacion_mes: dias
    });

    // Recipe analysis
    let analisisRecetas = null;
    if (recetas.length > 0) {
      const preciosMap = precios_venta || {};
      analisisRecetas = recetas.map(r => {
        const pv = preciosMap[r.id] || this.round((r.coste_porcion || 0) * 3);
        const margen = pv - (r.coste_porcion || 0);
        return {
          nombre: r.nombre,
          coste_porcion: r.coste_porcion || 0,
          precio_venta_sugerido: pv,
          margen: this.round(margen),
          food_cost: pv > 0 ? this.round(((r.coste_porcion || 0) / pv) * 100) : 0
        };
      });
    }

    const estudio = {
      negocio: {
        nombre: nombre_negocio || config.nombre_negocio || 'Nuevo negocio',
        tipo: tipo_negocio || config.tipo_negocio || 'No especificado'
      },
      fecha: new Date().toISOString(),
      recetas_analizadas: recetas.length,
      food_cost_medio: foodCostPct,
      ticket_medio: ticketMedio,
      escenarios: {
        principal: escenarioPrincipal,
        conservador: escenarioConservador,
        optimista: escenarioOptimista
      },
      recetas: analisisRecetas,
      conclusiones: []
    };

    // Generate conclusions
    const ep = escenarioPrincipal;
    if (ep.beneficio.es_rentable) {
      estudio.conclusiones.push(`El negocio es rentable con ${comensales} comensales/día: beneficio estimado ${ep.beneficio.mes}€/mes.`);
    } else {
      estudio.conclusiones.push(`El negocio NO es rentable con ${comensales} comensales/día. Pérdida estimada: ${Math.abs(ep.beneficio.mes)}€/mes.`);
    }
    estudio.conclusiones.push(`Punto de equilibrio: ${ep.punto_equilibrio.comensales_dia} comensales/día (${ep.punto_equilibrio.porcentaje_ocupacion_necesaria}% de ocupación).`);

    if (escenarioConservador.beneficio.es_rentable) {
      estudio.conclusiones.push(`Incluso en escenario conservador (-20%), el negocio sería rentable.`);
    } else {
      estudio.conclusiones.push(`En escenario conservador (-20%), el negocio entraría en pérdidas. Margen de seguridad bajo.`);
    }

    if (foodCostPct > 35) {
      estudio.conclusiones.push(`Food cost alto (${foodCostPct}%). Conviene optimizar costes o subir precios. Objetivo: < 33%.`);
    }

    // Save
    await this.saveEstudio(project_id, estudio);
    await this.eventBus.publish('viabilidad.estudio.generado', estudio);
    this.metrics?.increment('viabilidad.estudio.generated');

    return { status: 200, data: estudio };
  }

  async toolPuntoEquilibrio({ gastos_fijos_mensuales, ticket_medio, food_cost_porcentaje, dias_operacion_mes, project_id }) {
    if (!gastos_fijos_mensuales) return { status: 400, error: 'Se requiere "gastos_fijos_mensuales"' };
    if (!project_id) return { status: 400, error: 'Se requiere "project_id"' };

    const config = this.getConfig(project_id);
    const { recetas } = await this.getRecetas(project_id);

    const gf = gastos_fijos_mensuales;
    const dias = dias_operacion_mes || config.dias_operacion_mes || 25;
    let tm = ticket_medio || config.ticket_medio;
    let fc = food_cost_porcentaje;

    // Calculate from recipes if not provided
    if (recetas.length > 0 && (!tm || !fc)) {
      const costeMedio = recetas.reduce((s, r) => s + (r.coste_porcion || 0), 0) / recetas.length;
      if (!tm) tm = this.round(costeMedio * 3);
      if (!fc) fc = tm > 0 ? this.round((costeMedio / tm) * 100) : 33;
    }
    if (!tm) tm = 15;
    if (!fc) fc = 33;

    const margen_por_comensal = tm * (1 - fc / 100);
    const comensales_mes = margen_por_comensal > 0 ? Math.ceil(gf / margen_por_comensal) : Infinity;
    const comensales_dia = Math.ceil(comensales_mes / dias);
    const facturacion_necesaria_mes = comensales_mes * tm;

    // Various scenarios
    const escenarios = [20, 30, 40, 50, 60, 80, 100].map(n => {
      const ingresos = n * tm * dias;
      const costeMP = ingresos * (fc / 100);
      const beneficio = ingresos - gf - costeMP;
      return {
        comensales_dia: n,
        ingresos_mes: this.round(ingresos),
        beneficio_mes: this.round(beneficio),
        rentable: beneficio > 0
      };
    });

    this.metrics?.increment('viabilidad.punto_equilibrio.calculated');

    return {
      status: 200,
      data: {
        gastos_fijos_mensuales: gf,
        ticket_medio: tm,
        food_cost_porcentaje: fc,
        margen_contribucion_por_comensal: this.round(margen_por_comensal),
        punto_equilibrio: {
          comensales_dia: comensales_dia,
          comensales_mes: comensales_mes,
          facturacion_necesaria_mes: this.round(facturacion_necesaria_mes),
          facturacion_necesaria_dia: this.round(facturacion_necesaria_mes / dias)
        },
        tabla_escenarios: escenarios,
        message: `Necesitas ${comensales_dia} comensales/día (${comensales_mes}/mes) para cubrir los ${gf}€ de gastos fijos.`
      }
    };
  }

  async toolEscenario({ nombre, gastos_fijos_mensuales, comensales_dia, ticket_medio, food_cost_porcentaje, dias_operacion_mes, project_id }) {
    if (!nombre) return { status: 400, error: 'Se requiere "nombre"' };
    if (!gastos_fijos_mensuales) return { status: 400, error: 'Se requiere "gastos_fijos_mensuales"' };
    if (!project_id) return { status: 400, error: 'Se requiere "project_id"' };

    const { recetas } = await this.getRecetas(project_id);
    let fc = food_cost_porcentaje;
    if (!fc && recetas.length > 0) {
      const costeMedio = recetas.reduce((s, r) => s + (r.coste_porcion || 0), 0) / recetas.length;
      fc = ticket_medio > 0 ? this.round((costeMedio / ticket_medio) * 100) : 33;
    }
    if (!fc) fc = 33;

    const result = this.calcularEscenario({
      nombre,
      gastos_fijos_mensuales,
      comensales_dia,
      ticket_medio,
      food_cost_porcentaje: fc,
      dias_operacion_mes: dias_operacion_mes || 25
    });

    // Store and persist scenario
    if (!this.escenarios.has(project_id)) this.escenarios.set(project_id, []);
    const lista = this.escenarios.get(project_id);
    const idx = lista.findIndex(e => e.nombre === nombre);
    if (idx >= 0) lista[idx] = result;
    else lista.push(result);
    await this.saveEscenarios(project_id);

    await this.eventBus.publish('viabilidad.escenario.calculado', result);
    this.metrics?.increment('viabilidad.escenario.calculated');

    return { status: 200, data: result };
  }

  async toolCompararEscenarios({ escenarios, project_id }) {
    if (!escenarios || escenarios.length < 2) return { status: 400, error: 'Se necesitan al menos 2 escenarios para comparar' };
    if (!project_id) return { status: 400, error: 'Se requiere "project_id"' };

    const { recetas } = await this.getRecetas(project_id);

    const resultados = escenarios.map(e => {
      let fc = e.food_cost_porcentaje;
      if (!fc && recetas.length > 0) {
        const costeMedio = recetas.reduce((s, r) => s + (r.coste_porcion || 0), 0) / recetas.length;
        fc = e.ticket_medio > 0 ? this.round((costeMedio / e.ticket_medio) * 100) : 33;
      }
      if (!fc) fc = 33;

      return this.calcularEscenario({
        ...e,
        food_cost_porcentaje: fc,
        dias_operacion_mes: e.dias_operacion_mes || 25
      });
    });

    // Find best scenario
    const mejor = resultados.reduce((best, r) => r.beneficio.mes > best.beneficio.mes ? r : best);
    const peor = resultados.reduce((worst, r) => r.beneficio.mes < worst.beneficio.mes ? r : worst);

    return {
      status: 200,
      data: {
        escenarios: resultados,
        comparativa: {
          mejor_escenario: mejor.nombre,
          mejor_beneficio_mes: mejor.beneficio.mes,
          peor_escenario: peor.nombre,
          peor_beneficio_mes: peor.beneficio.mes,
          diferencia: this.round(mejor.beneficio.mes - peor.beneficio.mes)
        }
      }
    };
  }

  async toolProyeccion({ meses, gastos_fijos_mensuales, comensales_dia_inicial, comensales_dia_objetivo, ticket_medio, food_cost_porcentaje, dias_operacion_mes, inversion_inicial, project_id }) {
    if (!gastos_fijos_mensuales) return { status: 400, error: 'Se requiere "gastos_fijos_mensuales"' };
    if (!comensales_dia_inicial) return { status: 400, error: 'Se requiere "comensales_dia_inicial"' };
    if (!ticket_medio) return { status: 400, error: 'Se requiere "ticket_medio"' };
    if (!project_id) return { status: 400, error: 'Se requiere "project_id"' };

    const config = this.getConfig(project_id);
    const { recetas } = await this.getRecetas(project_id);

    const totalMeses = meses || 12;
    const dias = dias_operacion_mes || config.dias_operacion_mes || 25;
    const objetivo = comensales_dia_objetivo || comensales_dia_inicial;
    const inversion = inversion_inicial || config.inversion_inicial || 0;

    let fc = food_cost_porcentaje;
    if (!fc && recetas.length > 0) {
      const costeMedio = recetas.reduce((s, r) => s + (r.coste_porcion || 0), 0) / recetas.length;
      fc = ticket_medio > 0 ? this.round((costeMedio / ticket_medio) * 100) : 33;
    }
    if (!fc) fc = 33;

    // Monthly progression
    const proyeccion = [];
    let acumulado = -inversion;

    for (let mes = 1; mes <= totalMeses; mes++) {
      // Linear growth from initial to target
      const progreso = totalMeses > 1 ? (mes - 1) / (totalMeses - 1) : 1;
      const comensalesDia = Math.round(comensales_dia_inicial + (objetivo - comensales_dia_inicial) * progreso);

      const ingresos = comensalesDia * ticket_medio * dias;
      const costeMP = ingresos * (fc / 100);
      const gastosTotales = gastos_fijos_mensuales + costeMP;
      const beneficio = ingresos - gastosTotales;
      acumulado += beneficio;

      proyeccion.push({
        mes,
        comensales_dia: comensalesDia,
        ingresos: this.round(ingresos),
        gastos_fijos: gastos_fijos_mensuales,
        materia_prima: this.round(costeMP),
        gastos_totales: this.round(gastosTotales),
        beneficio: this.round(beneficio),
        acumulado: this.round(acumulado),
        rentable: beneficio > 0
      });
    }

    // When does it become profitable?
    const primerMesRentable = proyeccion.find(p => p.rentable);
    const mesRecuperacion = inversion > 0 ? proyeccion.find(p => p.acumulado >= 0) : null;

    const resultado = {
      parametros: {
        meses: totalMeses,
        gastos_fijos_mensuales: gastos_fijos_mensuales,
        comensales_dia_inicial,
        comensales_dia_objetivo: objetivo,
        ticket_medio,
        food_cost_porcentaje: fc,
        dias_operacion_mes: dias,
        inversion_inicial: inversion
      },
      proyeccion,
      resumen: {
        beneficio_total_periodo: this.round(proyeccion.reduce((s, p) => s + p.beneficio, 0)),
        beneficio_medio_mensual: this.round(proyeccion.reduce((s, p) => s + p.beneficio, 0) / totalMeses),
        ingresos_total_periodo: this.round(proyeccion.reduce((s, p) => s + p.ingresos, 0)),
        primer_mes_rentable: primerMesRentable ? primerMesRentable.mes : null,
        mes_recuperacion_inversion: mesRecuperacion ? mesRecuperacion.mes : null,
        acumulado_final: this.round(acumulado)
      }
    };

    if (inversion > 0 && mesRecuperacion) {
      resultado.resumen.roi = this.round(((acumulado / inversion) * 100));
      resultado.resumen.roi_mensaje = `ROI: ${resultado.resumen.roi}% en ${totalMeses} meses. Inversión recuperada en mes ${mesRecuperacion.mes}.`;
    } else if (inversion > 0) {
      resultado.resumen.roi_mensaje = `La inversión de ${inversion}€ NO se recupera en ${totalMeses} meses. Acumulado: ${this.round(acumulado)}€.`;
    }

    this.metrics?.increment('viabilidad.proyeccion.generated');

    return { status: 200, data: resultado };
  }

  async toolGuardarConfig({ project_id, ...configData }) {
    if (!project_id) return { status: 400, error: 'Se requiere "project_id"' };

    const existing = this.getConfig(project_id);
    const newConfig = { ...existing, ...configData, updated_at: new Date().toISOString() };

    // Remove undefined values
    for (const key of Object.keys(newConfig)) {
      if (newConfig[key] === undefined) delete newConfig[key];
    }

    await this.saveConfig(project_id, newConfig);

    return {
      status: 200,
      data: {
        config: newConfig,
        message: 'Configuración del negocio guardada. Se usará como valores por defecto en los cálculos.'
      }
    };
  }
}

module.exports = ViabilidadModule;
