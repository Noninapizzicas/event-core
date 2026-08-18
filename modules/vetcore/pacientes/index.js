let db, eventBus, logger;

const store = {
  pacientes: new Map()
};

async function onLoad(ctx) {
  db = ctx.db;
  eventBus = ctx.eventBus;
  logger = ctx.logger.child({ module: 'pacientes' });

  await db.run(`CREATE TABLE IF NOT EXISTS vet_pacientes (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    especie TEXT NOT NULL,
    raza TEXT,
    sexo TEXT DEFAULT 'desconocido',
    fecha_nacimiento TEXT,
    color TEXT,
    peso_kg REAL,
    microchip TEXT UNIQUE,
    esterilizado INTEGER DEFAULT 0,
    propietario_id TEXT NOT NULL,
    foto_url TEXT,
    notas TEXT,
    activo INTEGER DEFAULT 1,
    ultimo_chequeo TEXT,
    creado_en TEXT DEFAULT (datetime('now')),
    actualizado_en TEXT DEFAULT (datetime('now'))
  )`);

  logger.info('Módulo pacientes iniciado');
}

function newId() {
  return crypto.randomUUID();
}

async function handleListPacientes(req, res) {
  const { especie, propietario_id, activo = '1' } = req.query;
  let sql = 'SELECT * FROM vet_pacientes WHERE activo = ?';
  const params = [activo === '0' ? 0 : 1];

  if (especie) { sql += ' AND especie = ?'; params.push(especie); }
  if (propietario_id) { sql += ' AND propietario_id = ?'; params.push(propietario_id); }
  sql += ' ORDER BY nombre ASC';

  const pacientes = await db.all(sql, params);
  return res.json({ pacientes, total: pacientes.length });
}

async function handleCreatePaciente(req, res) {
  const { nombre, especie, propietario_id, raza, sexo, fecha_nacimiento, microchip, peso_kg, esterilizado, notas } = req.body;
  if (!nombre || !especie || !propietario_id) {
    return res.status(400).json({ error: 'nombre, especie y propietario_id son obligatorios' });
  }

  const id = newId();
  await db.run(
    `INSERT INTO vet_pacientes (id, nombre, especie, propietario_id, raza, sexo, fecha_nacimiento, microchip, peso_kg, esterilizado, notas)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, nombre, especie, propietario_id, raza || null, sexo || 'desconocido', fecha_nacimiento || null, microchip || null, peso_kg || null, esterilizado ? 1 : 0, notas || null]
  );

  const paciente = await db.get('SELECT * FROM vet_pacientes WHERE id = ?', [id]);
  await eventBus.publish('paciente.registrado', { paciente });
  logger.info({ paciente_id: id }, 'Paciente registrado');
  return res.status(201).json(paciente);
}

async function handleGetPaciente(req, res) {
  const paciente = await db.get('SELECT * FROM vet_pacientes WHERE id = ?', [req.params.id]);
  if (!paciente) return res.status(404).json({ error: 'Paciente no encontrado' });
  return res.json(paciente);
}

async function handleUpdatePaciente(req, res) {
  const { id } = req.params;
  const fields = ['nombre', 'raza', 'sexo', 'fecha_nacimiento', 'color', 'peso_kg', 'microchip', 'esterilizado', 'notas', 'foto_url'];
  const updates = [];
  const params = [];

  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nada que actualizar' });

  updates.push("actualizado_en = datetime('now')");
  params.push(id);
  await db.run(`UPDATE vet_pacientes SET ${updates.join(', ')} WHERE id = ?`, params);

  const paciente = await db.get('SELECT * FROM vet_pacientes WHERE id = ?', [id]);
  await eventBus.publish('paciente.actualizado', { paciente });
  return res.json(paciente);
}

async function handleArchivarPaciente(req, res) {
  await db.run("UPDATE vet_pacientes SET activo = 0, actualizado_en = datetime('now') WHERE id = ?", [req.params.id]);
  await eventBus.publish('paciente.archivado', { paciente_id: req.params.id });
  return res.json({ ok: true });
}

async function handleSearchPacientes(req, res) {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Parámetro q requerido' });
  const term = `%${q}%`;
  const pacientes = await db.all(
    'SELECT * FROM vet_pacientes WHERE activo = 1 AND (nombre LIKE ? OR microchip LIKE ? OR raza LIKE ?) ORDER BY nombre LIMIT 20',
    [term, term, term]
  );
  return res.json({ pacientes, total: pacientes.length });
}

async function handleGetHistoria(req, res) {
  return res.json({ paciente_id: req.params.id, message: 'Ver módulo historia-clinica' });
}

async function handleProximasVacunas(req, res) {
  return res.json({ paciente_id: req.params.id, message: 'Ver módulo recordatorios' });
}

async function onConsultaRegistrada(envelope) {
  const { paciente_id } = envelope.data;
  if (!paciente_id) return;
  await db.run("UPDATE vet_pacientes SET ultimo_chequeo = datetime('now') WHERE id = ?", [paciente_id]);
}

module.exports = {
  onLoad,
  handleListPacientes,
  handleCreatePaciente,
  handleGetPaciente,
  handleUpdatePaciente,
  handleArchivarPaciente,
  handleSearchPacientes,
  handleGetHistoria,
  handleProximasVacunas,
  onConsultaRegistrada
};
