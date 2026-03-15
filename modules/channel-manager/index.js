/**
 * Channel Manager Module
 *
 * Registry centralizado de canales externos.
 * Mapea identificadores externos (chat_id, email, telefono)
 * a proyectos y propositos internos.
 *
 * Filosofia:
 *   Canal != Credencial.
 *   - credential-manager: "con que token me autentico" (API keys)
 *   - channel-manager: "a donde va este mensaje" (routing)
 *
 * Un channel binding es:
 *   { channel_type, external_id } → { project_id, purpose, metadata }
 *
 * Ejemplo:
 *   { telegram, "mibot:12345" } → { noninapizza, facturas }
 *   { whatsapp, "+34600123456" } → { noninapizza, pedidos }
 *   { gmail, "facturas@empresa.com" } → { noninapizza, facturas }
 *
 * Storage: SQLite via database-manager (tabla 'channels' en proyecto 'system')
 *
 * @version 1.0.0
 */

class ChannelManagerModule {
  constructor() {
    this.name = 'channel-manager';
    this.version = '1.0.0';

    this.logger = null;
    this.eventBus = null;
    this.config = null;

    // In-memory cache: "channel_type:external_id" → binding
    this.cache = new Map();
    this.dbReady = false;
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(core) {
    this.logger = core.logger;
    this.eventBus = core.eventBus;

    // Load config from loader-injected moduleConfig
    this.config = core.moduleConfig || {};

    // Initialize schema in database-manager
    await this.initSchema();

    // Load all bindings into cache
    await this.loadCache();

    this.logger.info('channel-manager.loaded', {
      bindings: this.cache.size
    });
  }

  async onUnload() {
    this.cache.clear();
    this.dbReady = false;
    this.logger.info('channel-manager.unloaded');
  }

  // ==========================================
  // Database
  // ==========================================

  async initSchema() {
    const sql = `
      CREATE TABLE IF NOT EXISTS ${this.config.table_name} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_type TEXT NOT NULL,
        external_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT 'general',
        label TEXT,
        metadata TEXT DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(channel_type, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_channels_lookup
        ON ${this.config.table_name}(channel_type, external_id);
      CREATE INDEX IF NOT EXISTS idx_channels_project
        ON ${this.config.table_name}(project_id);
    `;

    try {
      await this.dbExec(sql);
      this.dbReady = true;
      this.logger.info('channel-manager.schema.ready');
    } catch (err) {
      this.logger.error('channel-manager.schema.error', { error: err.message });
    }
  }

  async loadCache() {
    try {
      const rows = await this.dbQuery(
        `SELECT * FROM ${this.config.table_name} WHERE enabled = 1`
      );
      this.cache.clear();
      for (const row of rows) {
        const key = this.cacheKey(row.channel_type, row.external_id);
        row.metadata = this.parseJSON(row.metadata);
        this.cache.set(key, row);
      }
    } catch (err) {
      this.logger.warn('channel-manager.cache.load.error', { error: err.message });
    }
  }

  // ==========================================
  // Core: Resolve
  // ==========================================

  /**
   * Resuelve un identificador externo a proyecto + proposito.
   *
   * @param {string} channelType - telegram, gmail, whatsapp, glovo, web
   * @param {string} externalId  - identificador especifico del canal
   * @returns {object|null} - { project_id, purpose, metadata, label } o null
   */
  resolve(channelType, externalId) {
    const key = this.cacheKey(channelType, externalId);
    const binding = this.cache.get(key);

    if (!binding) return null;

    return {
      project_id: binding.project_id,
      purpose: binding.purpose,
      label: binding.label,
      metadata: binding.metadata,
      channel_type: binding.channel_type,
      external_id: binding.external_id
    };
  }

  // ==========================================
  // CRUD
  // ==========================================

  async register({ channel_type, external_id, project_id, purpose, label, metadata }) {
    if (!channel_type || !external_id || !project_id) {
      throw new Error('channel_type, external_id y project_id son requeridos');
    }

    const now = new Date().toISOString();
    const metadataStr = JSON.stringify(metadata || {});

    await this.dbExec(
      `INSERT INTO ${this.config.table_name}
        (channel_type, external_id, project_id, purpose, label, metadata, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(channel_type, external_id) DO UPDATE SET
        project_id = excluded.project_id,
        purpose = excluded.purpose,
        label = excluded.label,
        metadata = excluded.metadata,
        enabled = 1,
        updated_at = excluded.updated_at`,
      [channel_type, external_id, project_id, purpose || 'general', label || null, metadataStr, now, now]
    );

    // Update cache
    const binding = {
      channel_type, external_id, project_id,
      purpose: purpose || 'general',
      label: label || null,
      metadata: metadata || {},
      enabled: 1,
      created_at: now,
      updated_at: now
    };
    this.cache.set(this.cacheKey(channel_type, external_id), binding);

    this.eventBus.publish('channel.registered', {
      channel_type, external_id, project_id,
      purpose: binding.purpose, label: binding.label
    });

    this.logger.info('channel-manager.registered', {
      channel_type, external_id, project_id, purpose: binding.purpose
    });

    return binding;
  }

  async update(channel_type, external_id, updates) {
    const key = this.cacheKey(channel_type, external_id);
    const existing = this.cache.get(key);
    if (!existing) {
      throw new Error(`Canal no encontrado: ${channel_type}:${external_id}`);
    }

    const fields = [];
    const values = [];

    if (updates.project_id !== undefined) {
      fields.push('project_id = ?');
      values.push(updates.project_id);
    }
    if (updates.purpose !== undefined) {
      fields.push('purpose = ?');
      values.push(updates.purpose);
    }
    if (updates.label !== undefined) {
      fields.push('label = ?');
      values.push(updates.label);
    }
    if (updates.metadata !== undefined) {
      fields.push('metadata = ?');
      values.push(JSON.stringify(updates.metadata));
    }
    if (updates.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    values.push(channel_type, external_id);

    await this.dbExec(
      `UPDATE ${this.config.table_name} SET ${fields.join(', ')}
       WHERE channel_type = ? AND external_id = ?`,
      values
    );

    // Update cache
    const updated = { ...existing, ...updates, updated_at: new Date().toISOString() };
    if (updates.metadata !== undefined) {
      updated.metadata = updates.metadata;
    }
    if (updated.enabled === false || updated.enabled === 0) {
      this.cache.delete(key);
    } else {
      this.cache.set(key, updated);
    }

    this.eventBus.publish('channel.updated', {
      channel_type, external_id, updates
    });

    return updated;
  }

  async remove(channel_type, external_id) {
    const key = this.cacheKey(channel_type, external_id);
    const existing = this.cache.get(key);

    await this.dbExec(
      `DELETE FROM ${this.config.table_name} WHERE channel_type = ? AND external_id = ?`,
      [channel_type, external_id]
    );

    this.cache.delete(key);

    this.eventBus.publish('channel.removed', {
      channel_type, external_id,
      project_id: existing?.project_id
    });

    this.logger.info('channel-manager.removed', { channel_type, external_id });
  }

  async list({ channel_type, project_id } = {}) {
    let sql = `SELECT * FROM ${this.config.table_name} WHERE 1=1`;
    const params = [];

    if (channel_type) {
      sql += ' AND channel_type = ?';
      params.push(channel_type);
    }
    if (project_id) {
      sql += ' AND project_id = ?';
      params.push(project_id);
    }

    sql += ' ORDER BY channel_type, external_id';

    const rows = await this.dbQuery(sql, params);
    return rows.map(row => ({
      ...row,
      metadata: this.parseJSON(row.metadata)
    }));
  }

  // ==========================================
  // Event Handlers
  // ==========================================

  async onResolveRequest(event) {
    const data = event.data || event;
    const { channel_type, external_id, request_id } = data;

    const start = Date.now();
    const result = this.resolve(channel_type, external_id);
    const duration = Date.now() - start;

    if (result) {
      this.eventBus.publish('channel.resolved', {
        ...result, duration
      });
      this.eventBus.publish('channel-manager.resolve.response', {
        request_id, success: true, found: true, ...result
      });
    } else {
      this.eventBus.publish('channel-manager.resolve.response', {
        request_id, success: true, found: false, channel_type, external_id
      });
      this.logger.debug('channel-manager.resolve.miss', { channel_type, external_id });
    }
  }

  // ==========================================
  // UI Handlers (mqttRequest)
  // ==========================================

  async handleRegister(data) {
    try {
      const binding = await this.register(data);
      return { status: 200, data: binding };
    } catch (err) {
      return { status: 400, error: err.message };
    }
  }

  async handleUpdate(data) {
    try {
      const { channel_type, external_id, ...updates } = data;
      const binding = await this.update(channel_type, external_id, updates);
      return { status: 200, data: binding };
    } catch (err) {
      return { status: 400, error: err.message };
    }
  }

  async handleRemove(data) {
    try {
      await this.remove(data.channel_type, data.external_id);
      return { status: 200, data: { removed: true } };
    } catch (err) {
      return { status: 400, error: err.message };
    }
  }

  async handleResolve(data) {
    const result = this.resolve(data.channel_type, data.external_id);
    if (result) {
      return { status: 200, data: result };
    }
    return { status: 404, error: 'Canal no registrado' };
  }

  async handleList(data) {
    const channels = await this.list(data);
    return { status: 200, data: channels };
  }

  async handleListByProject(data) {
    if (!data.project_id) {
      return { status: 400, error: 'project_id es requerido' };
    }
    const channels = await this.list({ project_id: data.project_id });
    return { status: 200, data: channels };
  }

  // ==========================================
  // Tool Handlers (AI tools)
  // ==========================================

  async handleToolResolve(params) {
    const result = this.resolve(params.channel_type, params.external_id);
    if (result) {
      return { found: true, ...result };
    }
    return {
      found: false,
      message: `No hay canal registrado para ${params.channel_type}:${params.external_id}`
    };
  }

  async handleToolList(params) {
    const channels = await this.list(params);
    return {
      count: channels.length,
      channels: channels.map(ch => ({
        channel_type: ch.channel_type,
        external_id: ch.external_id,
        project_id: ch.project_id,
        purpose: ch.purpose,
        label: ch.label,
        enabled: ch.enabled
      }))
    };
  }

  // ==========================================
  // DB helpers (via database-manager events)
  // ==========================================

  dbQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
      const correlationId = `chm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const handler = (event) => {
        const data = event.data || event;
        if (data.correlationId !== correlationId) return;
        this.eventBus.unsubscribe('db.query.response', handler);

        if (data.error) {
          reject(new Error(data.error));
        } else {
          resolve(data.rows || []);
        }
      };

      this.eventBus.subscribe('db.query.response', handler);
      this.eventBus.publish('db.query.request', {
        projectId: this.config.db_project_id,
        query: sql,
        params,
        correlationId
      });
    });
  }

  dbExec(sql, params = []) {
    return new Promise((resolve, reject) => {
      const correlationId = `chm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // For schema init, use db.schema.init.request
      // For data mutations, use db.query.request (database-manager handles INSERT/UPDATE/DELETE too)
      const isSchema = sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX');
      const eventType = isSchema ? 'db.schema.init.request' : 'db.query.request';
      const responseType = isSchema ? 'db.schema.init.response' : 'db.query.response';

      const handler = (event) => {
        const data = event.data || event;
        if (data.correlationId !== correlationId) return;
        this.eventBus.unsubscribe(responseType, handler);

        if (data.error) {
          reject(new Error(data.error));
        } else {
          resolve(data);
        }
      };

      this.eventBus.subscribe(responseType, handler);

      if (isSchema) {
        this.eventBus.publish(eventType, {
          projectId: this.config.db_project_id,
          schema: sql,
          correlationId
        });
      } else {
        this.eventBus.publish(eventType, {
          projectId: this.config.db_project_id,
          query: sql,
          params,
          correlationId
        });
      }
    });
  }

  // ==========================================
  // Helpers
  // ==========================================

  cacheKey(channelType, externalId) {
    return `${channelType}:${externalId}`;
  }

  parseJSON(str) {
    if (!str) return {};
    if (typeof str === 'object') return str;
    try { return JSON.parse(str); } catch { return {}; }
  }
}

module.exports = ChannelManagerModule;
