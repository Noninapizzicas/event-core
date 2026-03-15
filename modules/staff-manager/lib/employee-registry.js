/**
 * EmployeeRegistry - CRUD de empleados (SQLite via sql.js)
 *
 * Almacena empleados en un archivo SQLite independiente (data/staff/staff.db).
 * Cada empleado tiene id, nombre, rol, pin opcional y estado activo/inactivo.
 *
 * La baja es lógica (active = 0), no se borran registros para mantener
 * el histórico de jornadas.
 */

const fs   = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class EmployeeRegistry {
  /**
   * @param {object} opts
   * @param {string} opts.dataPath  - Directorio donde guardar staff.db
   * @param {object} [opts.logger]  - Logger del core
   */
  constructor({ dataPath, logger }) {
    this.dataPath = dataPath;
    this.logger   = logger;
    this.db       = null;
    this.SQL      = null;
    this._saveTimer = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async initialize(SQL) {
    this.SQL = SQL;
    await this._loadOrCreate();
    this._startAutoSave();
  }

  async close() {
    if (this._saveTimer) clearInterval(this._saveTimer);
    await this._persist();
    if (this.db) this.db.close();
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Crea un nuevo empleado.
   * @param {object} opts
   * @param {string} opts.name  - Nombre completo
   * @param {string} opts.role  - Rol: "camarero" | "cocina" | "admin" | cualquier string
   * @param {string} [opts.pin] - PIN numérico opcional (almacenado como SHA-256)
   * @returns {object} Empleado creado (sin pin_hash)
   */
  createEmployee({ name, role, pin } = {}) {
    if (!name || !role) throw new Error('name y role son requeridos');

    const id  = `emp-${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const pin_hash = pin ? this._hashPin(pin) : null;

    this.db.run(
      `INSERT INTO employees (id, name, role, pin_hash, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [id, name, role, pin_hash, now, now]
    );

    this.logger?.debug('staff.employee.created', { id, name, role });
    return this.getEmployee(id);
  }

  /**
   * Obtiene un empleado por ID.
   * @returns {object|null}
   */
  getEmployee(id) {
    const stmt = this.db.prepare('SELECT * FROM employees WHERE id = ?');
    stmt.bind([id]);
    const exists = stmt.step();
    const row = exists ? stmt.getAsObject() : null;
    stmt.free();
    return row ? this._sanitize(row) : null;
  }

  /**
   * Lista empleados.
   * @param {object} [opts]
   * @param {boolean} [opts.active_only=true] - Solo empleados activos
   */
  listEmployees({ active_only = true } = {}) {
    const sql  = active_only
      ? 'SELECT * FROM employees WHERE active = 1 ORDER BY name COLLATE NOCASE'
      : 'SELECT * FROM employees ORDER BY name COLLATE NOCASE';
    const stmt = this.db.prepare(sql);
    const rows = [];
    while (stmt.step()) rows.push(this._sanitize(stmt.getAsObject()));
    stmt.free();
    return rows;
  }

  /**
   * Actualiza campos de un empleado.
   * Solo actualiza los campos presentes en el objeto (patch parcial).
   * @param {string} id
   * @param {object} fields  - Campos a actualizar: name, role, pin, active
   * @returns {object} Empleado actualizado
   */
  updateEmployee(id, fields = {}) {
    if (!this.getEmployee(id)) throw new Error(`Empleado no encontrado: ${id}`);

    const sets   = [];
    const values = [];

    if (fields.name   !== undefined) { sets.push('name = ?');     values.push(fields.name); }
    if (fields.role   !== undefined) { sets.push('role = ?');     values.push(fields.role); }
    if (fields.pin    !== undefined) { sets.push('pin_hash = ?'); values.push(this._hashPin(fields.pin)); }
    if (fields.active !== undefined) { sets.push('active = ?');   values.push(fields.active ? 1 : 0); }

    if (sets.length === 0) return this.getEmployee(id); // nada que actualizar

    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.db.run(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`, values);
    return this.getEmployee(id);
  }

  /**
   * Baja lógica de un empleado (active = 0).
   * @returns {boolean} false si no existía
   */
  deleteEmployee(id) {
    if (!this.getEmployee(id)) return false;
    this.db.run(
      'UPDATE employees SET active = 0, updated_at = ? WHERE id = ?',
      [new Date().toISOString(), id]
    );
    return true;
  }

  /**
   * Verifica el PIN de un empleado.
   * Si el empleado no tiene PIN configurado, retorna true (sin restricción).
   * @returns {boolean}
   */
  verifyPin(id, pin) {
    const stmt = this.db.prepare('SELECT pin_hash FROM employees WHERE id = ? AND active = 1');
    stmt.bind([id]);
    if (!stmt.step()) { stmt.free(); return false; }
    const { pin_hash } = stmt.getAsObject();
    stmt.free();
    if (!pin_hash) return true;
    return pin_hash === this._hashPin(pin);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _hashPin(pin) {
    return crypto.createHash('sha256').update(String(pin)).digest('hex');
  }

  _sanitize(row) {
    const { pin_hash, ...safe } = row; // nunca exponer el hash
    safe.active = safe.active === 1 || safe.active === '1';
    return safe;
  }

  async _loadOrCreate() {
    const dbPath = path.join(this.dataPath, 'staff.db');
    try {
      const data = await fs.readFile(dbPath);
      this.db = new this.SQL.Database(data);
      this.logger?.debug('staff.registry.db.loaded', { path: dbPath });
    } catch {
      this.db = new this.SQL.Database();
      this._createSchema();
      this.logger?.debug('staff.registry.db.created', { path: dbPath });
    }
  }

  _createSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS employees (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        role       TEXT NOT NULL,
        pin_hash   TEXT,
        active     INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  _startAutoSave(intervalMs = 30000) {
    this._saveTimer = setInterval(() => this._persist().catch(() => {}), intervalMs);
  }

  async _persist() {
    const dbPath = path.join(this.dataPath, 'staff.db');
    await fs.mkdir(this.dataPath, { recursive: true });
    await fs.writeFile(dbPath, Buffer.from(this.db.export()));
  }
}

module.exports = EmployeeRegistry;
