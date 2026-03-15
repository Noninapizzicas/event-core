/**
 * Database Manager Module
 * SQLite database management using sql.js (JavaScript-only)
 *
 * Follows event-driven architecture - NO HTTP internal calls
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const { EVENTS, FIELDS, HELPERS, CONFIG, ERRORS } = require('../../core/constants');

class DatabaseManagerModule {
  constructor() {
    this.name = 'database-manager';
    this.version = '2.0.0';

    // State
    this.databases = new Map(); // projectId -> db instance
    this.projectPaths = new Map(); // projectId -> { basePath, slug } cache
    this.SQL = null;
    this.projectsPath = null;

    // Special projects that use legacy path structure
    this.systemProjects = new Set(['system', '_prompts']);

    // Dependencies (injected)
    this.logger = null;
    this.metrics = null;
    this.eventBus = null;
    this.config = null;
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(core) {
    this.logger = core.logger;
    this.metrics = core.metrics;
    this.eventBus = core.eventBus;
    this.activity = core.activity?.forModule('database-manager');

    this.activity?.action('module.loading', {});

    // Load config from loader-injected moduleConfig
    this.config = core.moduleConfig || {};

    this.logger.info('module.loading', {
      module: this.name,
      version: this.version,
      configLoaded: !!this.config.projectsPath
    });

    // Configure projects path
    this.projectsPath = path.resolve(
      this.config.projectsPath || './data/projects'
    );

    // Initialize sql.js
    await this.initializeSqlJs();

    // Create projects directory
    await this.ensureProjectsDirectory();

    // Event subscriptions are auto-wired by the loader from module.json

    // Update metrics
    // REMOVED (migrate-to-event-metrics): this.metrics.gauge('db.loaded.count', this.databases.size);
    // → Emit db.loaded event with `count: this.databases.size`
    // REMOVED (migrate-to-event-metrics): this.metrics.gauge('db.projects.count', await this.countProjects()
    // → Add `projects_count` to db events);

    this.logger.info('module.loaded', {
      module: this.name,
      version: this.version,
      projects_path: this.projectsPath
    });
  }

  async onUnload() {
    this.logger.info('module.unloading', { module: this.name });

    // Close all database connections
    for (const [projectId, db] of this.databases.entries()) {
      try {
        db.close();
        this.logger.info('db.closed', { project_id: projectId });
      } catch (error) {
        this.logger.error('db.close.error', {
          project_id: projectId,
          error: error?.message || String(error)
        });
      }
    }

    this.databases.clear();

    this.logger.info('module.unloaded', { module: this.name });
  }

  // ==========================================
  // Initialization Helpers
  // ==========================================

  async initializeSqlJs() {
    try {
      this.SQL = await initSqlJs();
      this.logger.info('sql.js.initialized', {
        version: this.SQL.version || 'unknown'
      });
    } catch (error) {
      this.logger.error('sql.js.init.failed', {
        error: error?.message || String(error),
        stack: error?.stack
      });
      throw error;
    }
  }

  async ensureProjectsDirectory() {
    if (!fsSync.existsSync(this.projectsPath)) {
      await fs.mkdir(this.projectsPath, { recursive: true });
      this.logger.info('projects.directory.created', {
        path: this.projectsPath
      });
    }
  }

  async countProjects() {
    try {
      if (!fsSync.existsSync(this.projectsPath)) return 0;
      const entries = await fs.readdir(this.projectsPath, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).length;
    } catch {
      return 0;
    }
  }

  // ==========================================
  // Event Handlers (wired by loader from module.json)
  // ==========================================

  async onQueryRequest(event) {
    // Debug: log raw event structure
    this.logger.info('query.request.raw', {
      event_keys: Object.keys(event || {}),
      has_data: !!event?.data,
      data_keys: event?.data ? Object.keys(event.data) : []
    });

    const {
      project_id,
      query,
      params = [],
      read_only = false,
      request_id,
      correlation_id
    } = event.data || event;

    const endTimer = this.activity?.timer('query');
    this.activity?.action('query.received', {
      project_id,
      query_preview: query ? query.substring(0, 50) : null,
      read_only,
      request_id
    });

    this.logger.info('query.request.received', {
      project_id,
      query: query ? query.substring(0, 100) : '(no query)',
      read_only,
      request_id,
      correlation_id
    });

    const startTime = Date.now();

    try {
      const db = await this.getDatabase(project_id);
      const results = [];

      const stmt = db.prepare(query);
      if (params.length > 0) {
        stmt.bind(params);
      }

      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();

      if (!read_only && this.config.autoSave !== false) {
        await this.saveDatabase(project_id);
      }

      const duration = Date.now() - startTime;

      endTimer?.({ success: true, project_id, result_count: results.length });
      this.activity?.action('query.success', {
        project_id,
        request_id,
        result_count: results.length,
        duration,
        read_only
      });

      this.logger.info('query.request.success', {
        project_id,
        result_count: results.length,
        duration,
        correlation_id
      });

      // REMOVED (migrate-to-event-metrics): // REMOVED (migrate-to-event-metrics): this.metrics.increment('db.query.total');
    // → Counter extracted from events
    // → Counter from db.query.completed events
      // REMOVED: this.metrics.timing('db.query.duration', duration);

      // Publish response event
      await this.publishQueryResponse(
        project_id,
        request_id,
        true,
        results,
        null,
        correlation_id
      );
    } catch (error) {
      const errorMsg = error?.message || String(error) || 'Unknown database error';

      endTimer?.({ success: false, project_id, error: errorMsg });
      this.activity?.error('query', new Error(errorMsg), { project_id, request_id });

      this.logger.error('query.request.error', {
        project_id,
        error: errorMsg,
        correlation_id
      });

      // REMOVED (migrate-to-event-metrics): // REMOVED (migrate-to-event-metrics): this.metrics.increment('db.query.errors');
    // → Counter extracted from events
    // → Use error field in db.query.completed

      await this.publishQueryResponse(
        project_id,
        request_id,
        false,
        null,
        errorMsg,
        correlation_id
      );
    }
  }

  async onSchemaInitRequest(event) {
    // Debug: log raw event structure
    this.logger.info('schema.init.request.raw', {
      event_keys: Object.keys(event || {}),
      has_data: !!event?.data,
      data_keys: event?.data ? Object.keys(event.data) : []
    });

    const {
      project_id,
      schema,
      request_id,
      correlation_id
    } = event.data || event;

    this.logger.info('schema.init.request.received', {
      project_id,
      request_id,
      correlation_id,
      has_schema: !!schema,
      schema_length: schema ? schema.length : 0
    });

    // Validate schema before attempting to execute
    if (!schema || typeof schema !== 'string' || schema.trim().length === 0) {
      const errorMsg = 'Schema is required and must be a non-empty string';
      this.logger.error('schema.init.request.invalid', {
        project_id,
        error: errorMsg,
        schema_type: typeof schema,
        correlation_id
      });

      await this.publishSchemaInitResponse(
        project_id,
        request_id,
        false,
        errorMsg,
        correlation_id
      );
      return;
    }

    try {
      const db = await this.getDatabase(project_id);
      db.exec(schema);
      await this.saveDatabase(project_id);

      this.logger.info('schema.init.request.success', {
        project_id,
        correlation_id
      });

      // REMOVED (migrate-to-event-metrics): this.metrics.increment('db.schema.init.total');
    // → Counter extracted from events

      // Publish response event
      await this.publishSchemaInitResponse(
        project_id,
        request_id,
        true,
        null,
        correlation_id
      );

      // Publish schema initialized event
      await this.eventBus.publish(EVENTS.DB.SCHEMA_INITIALIZED, {
        project_id,
        initialized_at: new Date().toISOString()
      }, { correlationId: correlation_id });
    } catch (error) {
      const errorMsg = error?.message || String(error) || 'Unknown database error';
      this.logger.error('schema.init.request.error', {
        project_id,
        error: errorMsg,
        correlation_id
      });

      // REMOVED (migrate-to-event-metrics): this.metrics.increment('db.schema.init.errors');
    // → Counter extracted from events

      await this.publishSchemaInitResponse(
        project_id,
        request_id,
        false,
        errorMsg,
        correlation_id
      );
    }
  }

  // ==========================================
  // HTTP API Handlers
  // ==========================================

  async handleListDatabases(req, context) {
    this.logger.info('databases.list.start', {
      correlation_id: context.correlationId
    });

    try {
      const databases = [];

      if (fsSync.existsSync(this.projectsPath)) {
        const entries = await fs.readdir(this.projectsPath, {
          withFileTypes: true
        });

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const dirName = entry.name;

            // Check both legacy and new structure
            const legacyPath = path.join(this.projectsPath, dirName, 'db.sqlite');
            const newPath = path.join(this.projectsPath, dirName, 'db', `${dirName}.sqlite`);

            let dbPath = null;
            if (fsSync.existsSync(newPath)) {
              dbPath = newPath;
            } else if (fsSync.existsSync(legacyPath)) {
              dbPath = legacyPath;
            }

            const dbInfo = {
              project_id: dirName,
              loaded: this.databases.has(dirName),
              exists: !!dbPath
            };

            if (dbPath) {
              const stats = await fs.stat(dbPath);
              dbInfo.size = stats.size;
              dbInfo.last_modified = stats.mtime.toISOString();
              dbInfo.path = dbPath;
            }

            databases.push(dbInfo);
          }
        }
      }

      this.logger.info('databases.listed', {
        count: databases.length,
        correlation_id: context.correlationId
      });

      // REMOVED (migrate-to-event-metrics): this.metrics.gauge('db.projects.count', databases.length);
    // → Add `projects_count` to db events

      return {
        status: 200,
        data: {
          success: true,
          databases,
          total: databases.length,
          projects_path: this.projectsPath
        }
      };
    } catch (error) {
      const errorMsg = error?.message || String(error) || 'Unknown database error';
      this.logger.error('databases.list.error', {
        error: errorMsg,
        correlation_id: context.correlationId
      });

      return {
        status: 500,
        data: {
          success: false,
          error: 'Failed to list databases',
          message: errorMsg
        }
      };
    }
  }

  async handleExecuteQuery(req, context) {
    const startTime = Date.now();
    const { projectId } = context.params;
    const { query, params = [], read_only = false } = context.body;

    this.logger.info('query.execute.start', {
      project_id: projectId,
      query: query.substring(0, 100),
      read_only,
      correlation_id: context.correlationId
    });

    try {
      const db = await this.getDatabase(projectId);
      const results = [];

      const stmt = db.prepare(query);
      if (params.length > 0) {
        stmt.bind(params);
      }

      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();

      if (!read_only && this.config.autoSave !== false) {
        await this.saveDatabase(projectId);
      }

      const duration = Date.now() - startTime;

      // Metrics
      // REMOVED (migrate-to-event-metrics): // REMOVED (migrate-to-event-metrics): this.metrics.increment('db.query.total');
    // → Counter extracted from events
    // → Counter from db.query.completed events
      // REMOVED: this.metrics.timing('db.query.duration', duration);

      // Publish event
      await this.publishQueryExecuted(projectId, results.length, read_only, duration, context.correlationId);

      this.logger.info('query.executed', {
        project_id: projectId,
        result_count: results.length,
        duration,
        correlation_id: context.correlationId
      });

      return {
        status: 200,
        data: {
          success: true,
          project_id: projectId,
          results,
          count: results.length,
          duration
        }
      };
    } catch (error) {
      // REMOVED (migrate-to-event-metrics): // REMOVED (migrate-to-event-metrics): this.metrics.increment('db.query.errors');
    // → Counter extracted from events
    // → Use error field in db.query.completed

      const errorMsg = error?.message || String(error) || 'Unknown database error';
      this.logger.error('query.execute.error', {
        project_id: projectId,
        error: errorMsg,
        correlation_id: context.correlationId
      });

      return {
        status: 500,
        data: {
          success: false,
          project_id: projectId,
          error: 'Query execution failed',
          message: errorMsg
        }
      };
    }
  }

  async handleGetSchema(req, context) {
    const { projectId } = context.params;

    this.logger.info('schema.get.start', {
      project_id: projectId,
      correlation_id: context.correlationId
    });

    try {
      const db = await this.getDatabase(projectId);

      const stmt = db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      );
      const tables = [];

      while (stmt.step()) {
        tables.push(stmt.getAsObject());
      }
      stmt.free();

      this.logger.info('schema.retrieved', {
        project_id: projectId,
        table_count: tables.length,
        correlation_id: context.correlationId
      });

      return {
        status: 200,
        data: {
          success: true,
          project_id: projectId,
          tables,
          table_count: tables.length
        }
      };
    } catch (error) {
      const errorMsg = error?.message || String(error) || 'Unknown database error';
      this.logger.error('schema.get.error', {
        project_id: projectId,
        error: errorMsg,
        correlation_id: context.correlationId
      });

      return {
        status: 500,
        data: {
          success: false,
          project_id: projectId,
          error: 'Failed to retrieve schema',
          message: errorMsg
        }
      };
    }
  }

  async handleInitSchema(req, context) {
    const { projectId } = context.params;
    const { schema } = context.body;

    this.logger.info('schema.init.start', {
      project_id: projectId,
      correlation_id: context.correlationId
    });

    try {
      const db = await this.getDatabase(projectId);
      db.exec(schema);
      await this.saveDatabase(projectId);

      // Metrics
      // REMOVED (migrate-to-event-metrics): this.metrics.increment('db.schema.init.total');
    // → Counter extracted from events

      // Publish event
      await this.eventBus.publish('db.schema.initialized', {
        project_id: projectId,
        initialized_at: new Date().toISOString()
      }, { correlationId: context.correlationId });

      this.logger.info('schema.initialized', {
        project_id: projectId,
        correlation_id: context.correlationId
      });

      return {
        status: 200,
        data: {
          success: true,
          project_id: projectId,
          message: 'Schema initialized successfully'
        }
      };
    } catch (error) {
      // REMOVED (migrate-to-event-metrics): this.metrics.increment('db.schema.init.errors');
    // → Counter extracted from events

      const errorMsg = error?.message || String(error) || 'Unknown database error';
      this.logger.error('schema.init.error', {
        project_id: projectId,
        error: errorMsg,
        correlation_id: context.correlationId
      });

      return {
        status: 500,
        data: {
          success: false,
          project_id: projectId,
          error: 'Schema initialization failed',
          message: errorMsg
        }
      };
    }
  }

  async handleDeleteDatabase(req, context) {
    const { projectId } = context.params;

    this.logger.info('db.delete.start', {
      project_id: projectId,
      correlation_id: context.correlationId
    });

    try {
      // Close connection if open
      if (this.databases.has(projectId)) {
        const db = this.databases.get(projectId);
        db.close();
        this.databases.delete(projectId);
      }

      // Clear path cache
      this.projectPaths.delete(projectId);

      const { dbPath } = await this.resolveDatabasePath(projectId);

      if (fsSync.existsSync(dbPath)) {
        await fs.unlink(dbPath);

        // Metrics
        // REMOVED (migrate-to-event-metrics): this.metrics.increment('db.deleted.total');
    // → Counter extracted from events
        // REMOVED (migrate-to-event-metrics): this.metrics.gauge('db.loaded.count', this.databases.size);
    // → Emit db.loaded event with `count: this.databases.size`

        // Publish event
        await this.eventBus.publish('db.deleted', {
          project_id: projectId,
          deleted_at: new Date().toISOString()
        }, { correlationId: context.correlationId });

        this.logger.info('db.deleted', {
          project_id: projectId,
          correlation_id: context.correlationId
        });

        return {
          status: 200,
          data: {
            success: true,
            project_id: projectId,
            message: 'Database deleted successfully'
          }
        };
      } else {
        return {
          status: 404,
          data: {
            success: false,
            project_id: projectId,
            error: 'Database not found'
          }
        };
      }
    } catch (error) {
      const errorMsg = error?.message || String(error) || 'Unknown database error';
      this.logger.error('db.delete.error', {
        project_id: projectId,
        error: errorMsg,
        correlation_id: context.correlationId
      });

      return {
        status: 500,
        data: {
          success: false,
          project_id: projectId,
          error: 'Failed to delete database',
          message: errorMsg
        }
      };
    }
  }

  async handleListTables(req, context) {
    const { projectId } = context.params;

    this.logger.info('tables.list.start', {
      project_id: projectId,
      correlation_id: context.correlationId
    });

    try {
      const db = await this.getDatabase(projectId);

      const stmt = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );
      const tables = [];

      while (stmt.step()) {
        const row = stmt.getAsObject();
        tables.push(row.name);
      }
      stmt.free();

      this.logger.info('tables.listed', {
        project_id: projectId,
        count: tables.length,
        correlation_id: context.correlationId
      });

      return {
        status: 200,
        data: {
          success: true,
          project_id: projectId,
          tables,
          count: tables.length
        }
      };
    } catch (error) {
      const errorMsg = error?.message || String(error) || 'Unknown database error';
      this.logger.error('tables.list.error', {
        project_id: projectId,
        error: errorMsg,
        correlation_id: context.correlationId
      });

      return {
        status: 500,
        data: {
          success: false,
          project_id: projectId,
          error: 'Failed to list tables',
          message: errorMsg
        }
      };
    }
  }

  async handleHealthCheck(req, context) {
    return {
      status: 200,
      data: {
        status: 'healthy',
        module: this.name,
        version: this.version,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        loaded_databases: this.databases.size,
        projects_path: this.projectsPath
      }
    };
  }

  async handleGetMetrics(req, context) {
    return {
      status: 200,
      data: {
        counters: {
          'db.created.total': this.metrics.getCounter('db.created.total') || 0,
          'db.deleted.total': this.metrics.getCounter('db.deleted.total') || 0,
          'db.query.total': this.metrics.getCounter('db.query.total') || 0,
          'db.query.errors': this.metrics.getCounter('db.query.errors') || 0,
          'db.schema.init.total': this.metrics.getCounter('db.schema.init.total') || 0,
          'db.schema.init.errors': this.metrics.getCounter('db.schema.init.errors') || 0
        },
        gauges: {
          'db.loaded.count': this.databases.size,
          'db.projects.count': await this.countProjects()
        }
      }
    };
  }

  // ==========================================
  // AI Tool Handlers
  // ==========================================

  /**
   * db.query - Execute read-only SELECT query
   * Only allows SELECT statements for safety
   */
  async handleToolQuery(args) {
    const { projectId, query, params = [] } = args || {};

    // Validate required parameters
    if (!projectId) {
      return {
        status: 400,
        data: { error: 'projectId is required' }
      };
    }

    if (!query) {
      return {
        status: 400,
        data: { error: 'query is required' }
      };
    }

    // Security: Only allow SELECT statements
    const normalizedQuery = query.trim().toUpperCase();
    if (!normalizedQuery.startsWith('SELECT')) {
      return {
        status: 403,
        data: {
          error: 'Only SELECT queries allowed',
          hint: 'Use db.execute for INSERT, UPDATE, DELETE operations'
        }
      };
    }

    const startTime = Date.now();

    this.logger.info('tool.query.start', {
      project_id: projectId,
      query_preview: query.substring(0, 100)
    });

    try {
      const db = await this.getDatabase(projectId);
      const results = [];

      const stmt = db.prepare(query);
      if (params.length > 0) {
        stmt.bind(params);
      }

      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();

      const duration = Date.now() - startTime;

      this.logger.info('tool.query.success', {
        project_id: projectId,
        result_count: results.length,
        duration
      });

      return {
        status: 200,
        data: {
          success: true,
          projectId,
          results,
          count: results.length,
          duration
        }
      };
    } catch (error) {
      const errorMsg = error?.message || String(error);
      this.logger.error('tool.query.error', {
        project_id: projectId,
        error: errorMsg
      });

      return {
        status: 500,
        data: {
          success: false,
          projectId,
          error: errorMsg
        }
      };
    }
  }

  /**
   * db.tables - List all tables in project database
   */
  async handleToolTables(args) {
    const { projectId } = args || {};

    if (!projectId) {
      return {
        status: 400,
        data: { error: 'projectId is required' }
      };
    }

    this.logger.info('tool.tables.start', { project_id: projectId });

    try {
      const db = await this.getDatabase(projectId);

      const stmt = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );
      const tables = [];

      while (stmt.step()) {
        const row = stmt.getAsObject();
        tables.push(row.name);
      }
      stmt.free();

      this.logger.info('tool.tables.success', {
        project_id: projectId,
        count: tables.length
      });

      return {
        status: 200,
        data: {
          success: true,
          projectId,
          tables,
          count: tables.length
        }
      };
    } catch (error) {
      const errorMsg = error?.message || String(error);
      this.logger.error('tool.tables.error', {
        project_id: projectId,
        error: errorMsg
      });

      return {
        status: 500,
        data: {
          success: false,
          projectId,
          error: errorMsg
        }
      };
    }
  }

  /**
   * db.schema - Get schema for a specific table
   */
  async handleToolSchema(args) {
    const { projectId, tableName } = args || {};

    if (!projectId) {
      return {
        status: 400,
        data: { error: 'projectId is required' }
      };
    }

    if (!tableName) {
      return {
        status: 400,
        data: { error: 'tableName is required' }
      };
    }

    this.logger.info('tool.schema.start', {
      project_id: projectId,
      table_name: tableName
    });

    try {
      const db = await this.getDatabase(projectId);

      // Get table info (columns)
      const stmt = db.prepare(`PRAGMA table_info("${tableName}")`);
      const columns = [];

      while (stmt.step()) {
        const row = stmt.getAsObject();
        columns.push({
          name: row.name,
          type: row.type,
          notnull: row.notnull === 1,
          default_value: row.dflt_value,
          primary_key: row.pk === 1
        });
      }
      stmt.free();

      if (columns.length === 0) {
        return {
          status: 404,
          data: {
            success: false,
            projectId,
            tableName,
            error: `Table '${tableName}' not found`
          }
        };
      }

      // Get foreign keys
      const fkStmt = db.prepare(`PRAGMA foreign_key_list("${tableName}")`);
      const foreignKeys = [];

      while (fkStmt.step()) {
        const row = fkStmt.getAsObject();
        foreignKeys.push({
          column: row.from,
          references_table: row.table,
          references_column: row.to,
          on_update: row.on_update,
          on_delete: row.on_delete
        });
      }
      fkStmt.free();

      // Get indexes
      const idxStmt = db.prepare(`PRAGMA index_list("${tableName}")`);
      const indexes = [];

      while (idxStmt.step()) {
        const row = idxStmt.getAsObject();
        indexes.push({
          name: row.name,
          unique: row.unique === 1
        });
      }
      idxStmt.free();

      // Get CREATE TABLE statement
      const sqlStmt = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?"
      );
      sqlStmt.bind([tableName]);
      let createStatement = null;
      if (sqlStmt.step()) {
        createStatement = sqlStmt.getAsObject().sql;
      }
      sqlStmt.free();

      this.logger.info('tool.schema.success', {
        project_id: projectId,
        table_name: tableName,
        column_count: columns.length
      });

      return {
        status: 200,
        data: {
          success: true,
          projectId,
          tableName,
          columns,
          foreignKeys,
          indexes,
          createStatement
        }
      };
    } catch (error) {
      const errorMsg = error?.message || String(error);
      this.logger.error('tool.schema.error', {
        project_id: projectId,
        table_name: tableName,
        error: errorMsg
      });

      return {
        status: 500,
        data: {
          success: false,
          projectId,
          tableName,
          error: errorMsg
        }
      };
    }
  }

  /**
   * db.execute - Execute modifying query (INSERT, UPDATE, DELETE, etc.)
   * Requires user confirmation (requires_confirmation: true in module.json)
   */
  async handleToolExecute(args) {
    const { projectId, query, params = [] } = args || {};

    if (!projectId) {
      return {
        status: 400,
        data: { error: 'projectId is required' }
      };
    }

    if (!query) {
      return {
        status: 400,
        data: { error: 'query is required' }
      };
    }

    // Security: Block SELECT (should use db.query instead)
    const normalizedQuery = query.trim().toUpperCase();
    if (normalizedQuery.startsWith('SELECT')) {
      return {
        status: 400,
        data: {
          error: 'Use db.query for SELECT statements',
          hint: 'db.execute is for INSERT, UPDATE, DELETE, CREATE, ALTER, DROP'
        }
      };
    }

    const startTime = Date.now();

    this.logger.info('tool.execute.start', {
      project_id: projectId,
      query_preview: query.substring(0, 100)
    });

    try {
      const db = await this.getDatabase(projectId);

      // For modifying queries, use run() to get changes count
      const stmt = db.prepare(query);
      if (params.length > 0) {
        stmt.bind(params);
      }
      stmt.step();
      stmt.free();

      // Get number of affected rows
      const changesStmt = db.prepare('SELECT changes() as affected_rows');
      changesStmt.step();
      const affectedRows = changesStmt.getAsObject().affected_rows;
      changesStmt.free();

      // Get last insert rowid for INSERT statements
      let lastInsertId = null;
      if (normalizedQuery.startsWith('INSERT')) {
        const lastIdStmt = db.prepare('SELECT last_insert_rowid() as last_id');
        lastIdStmt.step();
        lastInsertId = lastIdStmt.getAsObject().last_id;
        lastIdStmt.free();
      }

      // Auto-save
      if (this.config.autoSave !== false) {
        await this.saveDatabase(projectId);
      }

      const duration = Date.now() - startTime;

      // Publish event
      await this.publishQueryExecuted(projectId, affectedRows, false, duration, null);

      this.logger.info('tool.execute.success', {
        project_id: projectId,
        affected_rows: affectedRows,
        duration
      });

      return {
        status: 200,
        data: {
          success: true,
          projectId,
          affectedRows,
          lastInsertId,
          duration
        }
      };
    } catch (error) {
      const errorMsg = error?.message || String(error);
      this.logger.error('tool.execute.error', {
        project_id: projectId,
        error: errorMsg
      });

      return {
        status: 500,
        data: {
          success: false,
          projectId,
          error: errorMsg
        }
      };
    }
  }

  // ==========================================
  // Database Operations
  // ==========================================

  /**
   * Resolve database path for a project
   * - System projects: /projects/{name}/db.sqlite (legacy)
   * - User projects: /projects/{slug}/db/{slug}.sqlite (new structure)
   */
  async resolveDatabasePath(projectId) {
    // System projects use legacy structure
    if (this.systemProjects.has(projectId)) {
      const projectDir = path.join(this.projectsPath, projectId);
      return {
        projectDir,
        dbPath: path.join(projectDir, 'db.sqlite'),
        isSystem: true
      };
    }

    // Check cache first
    if (this.projectPaths.has(projectId)) {
      const cached = this.projectPaths.get(projectId);
      return {
        projectDir: cached.basePath,
        dbPath: path.join(cached.basePath, 'db', `${cached.slug}.sqlite`),
        isSystem: false
      };
    }

    // Query system database for project info
    try {
      const systemDb = await this.getDatabase('system');
      const result = systemDb.exec(`SELECT base_path, name FROM projects WHERE id = ?`, [projectId]);

      if (result.length > 0 && result[0].values.length > 0) {
        const [basePath, name] = result[0].values[0];

        if (basePath) {
          // Create slug from name for db filename
          const slug = name.toLowerCase()
            .replace(/[áàäâã]/g, 'a')
            .replace(/[éèëê]/g, 'e')
            .replace(/[íìïî]/g, 'i')
            .replace(/[óòöôõ]/g, 'o')
            .replace(/[úùüû]/g, 'u')
            .replace(/ñ/g, 'n')
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/[\s_]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '') || projectId.slice(0, 8);

          // Cache the result
          this.projectPaths.set(projectId, { basePath, slug });

          return {
            projectDir: basePath,
            dbPath: path.join(basePath, 'db', `${slug}.sqlite`),
            isSystem: false
          };
        }
      }
    } catch (err) {
      // System DB might not have the project yet, fall back to legacy
      this.logger.debug('db.resolve.fallback', { project_id: projectId, error: err.message });
    }

    // Fallback to legacy structure for unknown projects
    const projectDir = path.join(this.projectsPath, projectId);
    return {
      projectDir,
      dbPath: path.join(projectDir, 'db.sqlite'),
      isSystem: true
    };
  }

  async getDatabase(projectId) {
    if (this.databases.has(projectId)) {
      return this.databases.get(projectId);
    }

    const startTime = Date.now();
    const { projectDir, dbPath, isSystem } = await this.resolveDatabasePath(projectId);
    const dbDir = path.dirname(dbPath);

    this.logger.info('db.loading', {
      project_id: projectId,
      db_path: dbPath,
      is_system: isSystem
    });

    try {
      let db;

      if (fsSync.existsSync(dbPath)) {
        const fileBuffer = await fs.readFile(dbPath);
        db = new this.SQL.Database(fileBuffer);
        this.logger.info('db.loaded.existing', { project_id: projectId });
      } else {
        // Create db directory if needed
        if (!fsSync.existsSync(dbDir)) {
          await fs.mkdir(dbDir, { recursive: true });
        }
        db = new this.SQL.Database();

        // Publish event
        await this.eventBus.publish('db.created', {
          project_id: projectId,
          created_at: new Date().toISOString()
        });

        this.logger.info('db.created.new', { project_id: projectId, db_path: dbPath });
      }

      this.databases.set(projectId, db);

      const duration = Date.now() - startTime;

      return db;
    } catch (error) {
      this.logger.error('db.load.error', {
        project_id: projectId,
        error: error?.message || String(error)
      });
      throw error;
    }
  }

  async saveDatabase(projectId) {
    if (!this.databases.has(projectId)) {
      this.logger.warn('db.save.not_loaded', { project_id: projectId });
      return false;
    }

    const startTime = Date.now();
    const db = this.databases.get(projectId);
    const { dbPath } = await this.resolveDatabasePath(projectId);
    const dbDir = path.dirname(dbPath);

    try {
      if (!fsSync.existsSync(dbDir)) {
        await fs.mkdir(dbDir, { recursive: true });
      }

      const data = db.export();
      const buffer = Buffer.from(data);
      await fs.writeFile(dbPath, buffer);

      const duration = Date.now() - startTime;

      this.logger.info('db.saved', {
        project_id: projectId,
        duration
      });

      // REMOVED (migrate-to-event-metrics): this.metrics.increment('db.saved.total');
    // → Counter extracted from events
      // REMOVED: this.metrics.timing('db.save.duration', duration);

      return true;
    } catch (error) {
      this.logger.error('db.save.error', {
        project_id: projectId,
        error: error?.message || String(error)
      });

      // REMOVED (migrate-to-event-metrics): this.metrics.increment('db.save.errors');
    // → Counter extracted from events
      throw error;
    }
  }

  // ==========================================
  // Event Publishers
  // ==========================================

  async publishQueryExecuted(projectId, resultCount, readOnly, duration, correlationId) {
    await this.eventBus.publish('db.query.executed', {
      project_id: projectId,
      result_count: resultCount,
      read_only: readOnly,
      duration
    }, { correlationId });
  }

  async publishQueryResponse(projectId, requestId, success, data, error, correlationId) {
    await this.eventBus.publish(EVENTS.DB.QUERY_RESPONSE, {
      project_id: projectId,
      request_id: requestId,
      success,
      data: data || [],
      error: error || null
    }, { correlationId });
  }

  async publishSchemaInitResponse(projectId, requestId, success, error, correlationId) {
    await this.eventBus.publish(EVENTS.DB.SCHEMA_INIT_RESPONSE, {
      project_id: projectId,
      request_id: requestId,
      success,
      error: error || null
    }, { correlationId });
  }
}

module.exports = DatabaseManagerModule;
