/**
 * Staff Manager Module v1.0.0
 *
 * Control de personal mediante tarjetas NFC (NTAG215).
 *
 * Funcionalidades:
 *   1. Registro de empleados (CRUD con SQLite)
 *   2. Control de jornada: tap in / tap out con tarjeta NFC personal
 *   3. Generación de payloads NFC:
 *        - Tarjeta de empleado (para jornada)
 *        - Tag de core (Opción A: onboarding de tablets nuevas)
 *   4. Cierre automático de jornadas a medianoche
 *
 * Emite:
 *   staff.session.tap_in      → empleado inicia jornada
 *   staff.session.tap_out     → empleado finaliza jornada
 *   staff.session.auto_closed → jornada cerrada automáticamente
 *   staff.session.manager_close → manager cierra jornada
 */

const path = require('path');
const initSqlJs = require('sql.js');

const EmployeeRegistry = require('./lib/employee-registry');
const SessionManager   = require('./lib/session-manager');
const NFCCard          = require('./lib/nfc-card');

class StaffManagerModule {
  constructor() {
    this.name    = 'staff-manager';
    this.version = '1.0.0';

    this.registry = null;
    this.sessions = null;
    this.core     = null;
    this.logger   = null;
    this.metrics  = null;
    this.dataPath = path.resolve('./data/staff');
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(core) {
    this.core    = core;
    this.logger  = core.logger;
    this.metrics = core.metrics;

    if (core.config?.staff?.dataPath) {
      this.dataPath = path.resolve(core.config.staff.dataPath);
    }

    const SQL = await initSqlJs();

    const maxShiftHours = core.config?.staff?.maxShiftHours ?? 16;

    this.registry = new EmployeeRegistry({ dataPath: this.dataPath, logger: this.logger });
    this.sessions = new SessionManager({
      dataPath:       this.dataPath,
      logger:         this.logger,
      maxShiftHours,
      onSessionEvent: this._emitSessionEvent.bind(this)
    });

    await this.registry.initialize(SQL);
    await this.sessions.initialize(SQL);

    if (core.uiHandler) {
      this._registerUIHandlers(core.uiHandler);
    }

    this.logger?.info('module.loaded', {
      module:   this.name,
      version:  this.version,
      dataPath: this.dataPath
    });
  }

  async onUnload() {
    await this.registry?.close();
    await this.sessions?.close();

    if (this.core?.uiHandler) {
      for (const action of this._uiActions()) {
        this.core.uiHandler.unregister(this.name, action);
      }
    }

    this.logger?.info('module.unloaded', { module: this.name });
  }

  // ==========================================
  // Handlers — Estado
  // ==========================================

  async handleStatus() {
    const employees       = this.registry.listEmployees({ active_only: true });
    const active_sessions = this.sessions.listActiveSessions();

    return {
      status: 200,
      data: {
        module:           this.name,
        version:          this.version,
        employees_active: employees.length,
        sessions_open:    active_sessions.length
      }
    };
  }

  // ==========================================
  // Handlers — Empleados
  // ==========================================

  async handleEmployeeCreate({ body }) {
    try {
      const { name, role, pin } = body || {};
      if (!name || !role) return { status: 400, error: 'name y role son requeridos' };

      const employee = this.registry.createEmployee({ name, role, pin });
      return { status: 201, data: employee };
    } catch (err) {
      return { status: 500, error: err.message };
    }
  }

  async handleEmployeeList({ query } = {}) {
    const active_only = (query?.active_only ?? 'true') !== 'false';
    return { status: 200, data: { employees: this.registry.listEmployees({ active_only }) } };
  }

  async handleEmployeeGet({ params } = {}) {
    const employee = this.registry.getEmployee(params?.id);
    if (!employee) return { status: 404, error: 'Empleado no encontrado' };
    return { status: 200, data: employee };
  }

  async handleEmployeeUpdate({ params, body } = {}) {
    try {
      const employee = this.registry.updateEmployee(params?.id, body || {});
      return { status: 200, data: employee };
    } catch (err) {
      return { status: err.message.includes('no encontrado') ? 404 : 500, error: err.message };
    }
  }

  async handleEmployeeDelete({ params } = {}) {
    const ok = this.registry.deleteEmployee(params?.id);
    if (!ok) return { status: 404, error: 'Empleado no encontrado' };
    return { status: 200, data: { deleted: true } };
  }

  // ==========================================
  // Handlers — Sesiones de jornada
  // ==========================================

  async handleTapIn({ body } = {}) {
    try {
      const { employee_id, device_id } = body || {};
      if (!employee_id) return { status: 400, error: 'employee_id requerido' };

      const emp = this.registry.getEmployee(employee_id);
      if (!emp || !emp.active) return { status: 404, error: 'Empleado no encontrado o inactivo' };

      const result = this.sessions.tapIn({ employee_id, device_id });
      return { status: 200, data: { employee: emp, ...result } };
    } catch (err) {
      return { status: 500, error: err.message };
    }
  }

  async handleTapOut({ body } = {}) {
    try {
      const { employee_id } = body || {};
      if (!employee_id) return { status: 400, error: 'employee_id requerido' };

      const emp = this.registry.getEmployee(employee_id);
      if (!emp) return { status: 404, error: 'Empleado no encontrado' };

      const result = this.sessions.tapOut({ employee_id });
      return { status: 200, data: { employee: emp, ...result } };
    } catch (err) {
      return { status: 500, error: err.message };
    }
  }

  async handleActiveSessions() {
    const sessions = this.sessions.listActiveSessions().map(s => ({
      ...s,
      employee: this.registry.getEmployee(s.employee_id)
    }));
    return { status: 200, data: { sessions } };
  }

  async handleSessionHistory({ query } = {}) {
    const { employee_id, date } = query || {};
    let sessions;

    if (employee_id) {
      sessions = this.sessions.listSessionsByEmployee(employee_id);
    } else {
      const day = date || new Date().toISOString().split('T')[0];
      sessions  = this.sessions.listSessionsByDate(day).map(s => ({
        ...s,
        employee: this.registry.getEmployee(s.employee_id)
      }));
    }

    return { status: 200, data: { sessions } };
  }

  async handleManagerClose({ body } = {}) {
    const { employee_id } = body || {};
    if (!employee_id) return { status: 400, error: 'employee_id requerido' };

    const session = this.sessions.managerClose(employee_id);
    if (!session) return { status: 404, error: 'No hay sesión activa para este empleado' };
    return { status: 200, data: { session } };
  }

  /**
   * Lista sesiones que llevan abiertas más de maxShiftHours horas.
   * El manager puede revisarlas y cerrarlas manualmente o dejar que el monitor
   * las cierre automáticamente en la próxima comprobación (cada 15 min).
   */
  async handleStaleSessions() {
    const stale = this.sessions.listStaleSessions().map(s => ({
      ...s,
      employee: this.registry.getEmployee(s.employee_id)
    }));
    return {
      status: 200,
      data: {
        max_shift_hours: this.sessions.maxShiftHours,
        stale_count:     stale.length,
        sessions:        stale
      }
    };
  }

  // ==========================================
  // Handlers — NFC
  // ==========================================

  /**
   * Genera el payload JSON para escribir en la NTAG215 personal del empleado.
   * El admin llama a este endpoint, escribe el resultado con la Web NFC API
   * (o cualquier escritor NFC) en la tarjeta física del empleado.
   */
  async handleNFCEmployeeCard({ body } = {}) {
    try {
      const { employee_id } = body || {};
      if (!employee_id) return { status: 400, error: 'employee_id requerido' };

      const emp = this.registry.getEmployee(employee_id);
      if (!emp) return { status: 404, error: 'Empleado no encontrado' };

      const payload = NFCCard.generateEmployeeCard(emp);
      return {
        status: 200,
        data: {
          payload,
          json_string:     NFCCard.serialize(payload),
          byte_size:       NFCCard.byteSize(payload),
          ntag215_capacity: 504,
          fits:            NFCCard.byteSize(payload) <= 504
        }
      };
    } catch (err) {
      return { status: 500, error: err.message };
    }
  }

  /**
   * Genera el payload JSON para el tag de core (Opción A).
   * Este tag se escribe una sola vez; las tablets nuevas lo leen para
   * obtener el endpoint MQTT y la clave pública del core y conectarse solas.
   *
   * Requiere que el módulo security-p2p esté cargado (necesita su clave pública).
   */
  async handleNFCCoreTag() {
    try {
      const publicKeyPEM = this._getSecurityP2PPublicKey();
      if (!publicKeyPEM) {
        return {
          status: 503,
          error:  'security-p2p no disponible — carga ese módulo primero o proporciona public_key en el body'
        };
      }

      const coreId   = this.core?.config?.core?.id || 'event-core';
      const host     = this.core?.config?.http?.host || '127.0.0.1';
      const mqttPort = this.core?.config?.mqtt?.broker?.port || 1883;

      const payload = NFCCard.generateCoreInfoTag({
        core_id:      coreId,
        endpoint:     `mqtt://${host}:${mqttPort}`,
        publicKeyPEM
      });

      return {
        status: 200,
        data: {
          payload,
          json_string:     NFCCard.serialize(payload),
          byte_size:       NFCCard.byteSize(payload),
          ntag215_capacity: 504,
          fits:            NFCCard.byteSize(payload) <= 504
        }
      };
    } catch (err) {
      return { status: 500, error: err.message };
    }
  }

  /**
   * Parsea y valida un payload leído desde una NTAG215.
   * Útil para que la tablet verifique el contenido antes de actuar.
   */
  async handleNFCParse({ body } = {}) {
    try {
      const { raw } = body || {};
      if (!raw) return { status: 400, error: 'raw (JSON string o objeto) requerido' };

      const parsed = NFCCard.parsePayload(raw);
      return { status: 200, data: parsed };
    } catch (err) {
      return { status: 400, error: err.message };
    }
  }

  // ==========================================
  // Internal
  // ==========================================

  /**
   * Accede al KeyManager de security-p2p a través del loader de módulos.
   * No lanza error: retorna null si security-p2p no está disponible.
   */
  _getSecurityP2PPublicKey() {
    try {
      const data = this.core?.moduleLoader?.loadedModules?.get('security-p2p');
      return data?.instance?.keyManager?.getPublicKey() || null;
    } catch {
      return null;
    }
  }

  _emitSessionEvent(type, data) {
    if (!this.core?.eventBus) return;
    try {
      this.core.eventBus.emit(`staff.session.${type}`, {
        module:    this.name,
        timestamp: new Date().toISOString(),
        ...data
      });
    } catch {
      // No bloquear si el bus no está disponible
    }
  }

  _uiActions() {
    return [
      'status',
      'employee.create', 'employee.list', 'employee.get',
      'employee.update', 'employee.delete',
      'session.tap_in', 'session.tap_out',
      'session.active', 'session.history', 'session.stale', 'session.manager_close',
      'nfc.employee_card', 'nfc.core_tag', 'nfc.parse'
    ];
  }

  _registerUIHandlers(uiHandler) {
    uiHandler.register(this.name, 'status',                 this.handleStatus.bind(this));
    uiHandler.register(this.name, 'employee.create',        this.handleEmployeeCreate.bind(this));
    uiHandler.register(this.name, 'employee.list',          this.handleEmployeeList.bind(this));
    uiHandler.register(this.name, 'employee.get',           this.handleEmployeeGet.bind(this));
    uiHandler.register(this.name, 'employee.update',        this.handleEmployeeUpdate.bind(this));
    uiHandler.register(this.name, 'employee.delete',        this.handleEmployeeDelete.bind(this));
    uiHandler.register(this.name, 'session.tap_in',         this.handleTapIn.bind(this));
    uiHandler.register(this.name, 'session.tap_out',        this.handleTapOut.bind(this));
    uiHandler.register(this.name, 'session.active',         this.handleActiveSessions.bind(this));
    uiHandler.register(this.name, 'session.history',        this.handleSessionHistory.bind(this));
    uiHandler.register(this.name, 'session.stale',          this.handleStaleSessions.bind(this));
    uiHandler.register(this.name, 'session.manager_close',  this.handleManagerClose.bind(this));
    uiHandler.register(this.name, 'nfc.employee_card',      this.handleNFCEmployeeCard.bind(this));
    uiHandler.register(this.name, 'nfc.core_tag',           this.handleNFCCoreTag.bind(this));
    uiHandler.register(this.name, 'nfc.parse',              this.handleNFCParse.bind(this));
  }
}

module.exports = StaffManagerModule;
