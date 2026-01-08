const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { EVENTS, FIELDS, HELPERS, CONFIG, ERRORS } = require('../../core/constants');

/**
 * Project Manager Module
 *
 * Event-driven project lifecycle management with database integration.
 * - 100% event-driven (no HTTP interno)
 * - Uses database-manager via events for all persistence
 * - Tracks active project
 * - Publishes lifecycle events (created, updated, deleted, activated)
 */
class ProjectManagerModule {
  constructor() {
    this.name = 'project-manager';
    this.version = '1.0.0';

    // Dependencies (injected)
    this.logger = null;
    this.metrics = null;
    this.eventBus = null;
    this.uiHandler = null;  // UI Request/Response handler
    this.config = null;

    // State
    this.projects = new Map(); // In-memory cache: projectId -> project
    this.activeProjectId = null;

    // Pending database requests
    this.pendingDbRequests = new Map(); // requestId -> {resolve, reject, timeout}

    // Unsubscribe functions
    this.unsubscribes = [];

    // Active project event subscriptions (from event_subscriptions field)
    this.activeProjectSubscriptions = [];

    // Base path for project directories
    this.projectsBasePath = path.join(process.cwd(), 'data', 'projects');
  }

  // ==================== HELPERS ====================

  /**
   * Create a URL-safe slug from a name
   */
  slugify(name) {
    return name
      .toLowerCase()
      .trim()
      .replace(/[áàäâã]/g, 'a')
      .replace(/[éèëê]/g, 'e')
      .replace(/[íìïî]/g, 'i')
      .replace(/[óòöôõ]/g, 'o')
      .replace(/[úùüû]/g, 'u')
      .replace(/ñ/g, 'n')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Create project directory structure
   * Structure: /projects/{slug}/
   *   ├── db/       # SQLite database
   *   └── storage/  # Project files
   */
  async createProjectDirectories(projectId, name, correlationId) {
    const slug = this.slugify(name);
    const basePath = path.join(this.projectsBasePath, slug);

    this.logger.debug({ correlationId, projectId, basePath }, 'Creating project directories');

    try {
      // Create base directory and subdirectories
      const dirs = [
        basePath,
        path.join(basePath, 'db'),
        path.join(basePath, 'storage')
      ];

      for (const dir of dirs) {
        await fs.promises.mkdir(dir, { recursive: true });
      }

      this.logger.info({ correlationId, projectId, basePath }, 'Project directories created');
      return basePath;
    } catch (error) {
      this.logger.error({ correlationId, projectId, error: error.message }, 'Failed to create project directories');
      throw error;
    }
  }

  /**
   * Check if a project name already exists
   */
  async projectNameExists(name, correlationId) {
    const slug = this.slugify(name);
    const basePath = path.join(this.projectsBasePath, slug);

    try {
      await fs.promises.access(basePath);
      return true; // Directory exists
    } catch {
      return false; // Directory doesn't exist
    }
  }

  /**
   * Delete project directory structure
   */
  async deleteProjectDirectories(basePath, correlationId) {
    if (!basePath || !basePath.startsWith(this.projectsBasePath)) {
      this.logger.warn({ correlationId, basePath }, 'Invalid base path, skipping directory deletion');
      return;
    }

    this.logger.debug({ correlationId, basePath }, 'Deleting project directories');

    try {
      await fs.promises.rm(basePath, { recursive: true, force: true });
      this.logger.info({ correlationId, basePath }, 'Project directories deleted');
    } catch (error) {
      this.logger.warn({ correlationId, basePath, error: error.message }, 'Failed to delete project directories');
      // Don't throw - directory deletion is not critical
    }
  }

  async onLoad(core) {
    this.logger = core.logger;
    this.metrics = core.metrics;
    this.eventBus = core.eventBus;
    this.uiHandler = core.uiHandler;

    // Load config from module.json (core.config may not include module-specific config)
    try {
      const moduleJsonPath = path.join(__dirname, 'module.json');
      const moduleJson = JSON.parse(fs.readFileSync(moduleJsonPath, 'utf-8'));
      const moduleConfig = moduleJson.config || {};

      // Merge configs, but only use core.config values that are actually defined
      // This prevents undefined values from overwriting module.json defaults
      const coreConfig = core.config || {};
      this.config = { ...moduleConfig };
      for (const [key, value] of Object.entries(coreConfig)) {
        if (value !== undefined && value !== null) {
          this.config[key] = value;
        }
      }
    } catch (err) {
      this.logger.warn('project-manager.config.load.error', { error: err.message });
      this.config = core.config || {};
    }

    this.logger.info('project-manager.loading', { module: this.name, configLoaded: !!this.config.defaultSchema });

    // Subscribe to database responses
    const unsubDbResponse = await this.eventBus.subscribe(EVENTS.DB.QUERY_RESPONSE,
      this.onDbQueryResponse.bind(this));
    this.unsubscribes.push(unsubDbResponse);

    // Subscribe to query events
    const unsubGet = await this.eventBus.subscribe(EVENTS.PROJECT.GET_REQUEST,
      this.onGetProjectRequest.bind(this));
    this.unsubscribes.push(unsubGet);

    const unsubList = await this.eventBus.subscribe(EVENTS.PROJECT.LIST_REQUEST,
      this.onListProjectsRequest.bind(this));
    this.unsubscribes.push(unsubList);

    const unsubActive = await this.eventBus.subscribe('project.active.request',
      this.onGetActiveProjectRequest.bind(this));
    this.unsubscribes.push(unsubActive);

    // ==================== UI EVENT HANDLERS ====================
    // Comunicación via eventBus (que usa MQTT internamente con topics transformados)
    // Frontend suscribe a core/*/events/project/state, etc.

    const unsubStateReq = await this.eventBus.subscribe('project/state/request',
      this.onProjectStateRequest.bind(this));
    this.unsubscribes.push(unsubStateReq);

    const unsubCreate = await this.eventBus.subscribe('project/create',
      this.onProjectCreate.bind(this));
    this.unsubscribes.push(unsubCreate);

    const unsubUpdate = await this.eventBus.subscribe('project/update',
      this.onProjectUpdate.bind(this));
    this.unsubscribes.push(unsubUpdate);

    const unsubDelete = await this.eventBus.subscribe('project/delete',
      this.onProjectDelete.bind(this));
    this.unsubscribes.push(unsubDelete);

    const unsubActivate = await this.eventBus.subscribe('project/activate',
      this.onProjectActivate.bind(this));
    this.unsubscribes.push(unsubActivate);

    // Phase 5: Subscribe to context requests from prompt-composer
    const unsubContextFull = await this.eventBus.subscribe('context.full.request',
      this.onContextFullRequest.bind(this));
    this.unsubscribes.push(unsubContextFull);

    this.logger.info('project-manager.eventbus.subscribed', {
      topics: ['project/state/request', 'project/create', 'project/update', 'project/delete', 'project/activate', 'context.full.request']
    });

    // ==================== UI REQUEST/RESPONSE HANDLERS ====================
    // Patrón Request/Response sobre MQTT para comunicación frontend
    // Frontend usa: await mqttRequest('project', 'list')
    if (this.uiHandler) {
      this.uiHandler.register('project', 'list', this.handleUIList.bind(this));
      this.uiHandler.register('project', 'get', this.handleUIGet.bind(this));
      this.uiHandler.register('project', 'create', this.handleUICreate.bind(this));
      this.uiHandler.register('project', 'update', this.handleUIUpdate.bind(this));
      this.uiHandler.register('project', 'delete', this.handleUIDelete.bind(this));
      this.uiHandler.register('project', 'activate', this.handleUIActivate.bind(this));
      // Session & AI Config handlers
      this.uiHandler.register('project', 'saveSession', this.handleUISaveSession.bind(this));
      this.uiHandler.register('project', 'restoreSession', this.handleUIRestoreSession.bind(this));
      this.uiHandler.register('project', 'setAIConfig', this.handleUISetAIConfig.bind(this));
      this.uiHandler.register('project', 'setLastConversation', this.handleUISetLastConversation.bind(this));
      // Project Composition handlers (Phase 1)
      this.uiHandler.register('project', 'link', this.handleUILink.bind(this));
      this.uiHandler.register('project', 'unlink', this.handleUIUnlink.bind(this));
      this.uiHandler.register('project', 'getLinks', this.handleUIGetLinks.bind(this));
      this.uiHandler.register('project', 'getRelated', this.handleUIGetRelated.bind(this));
      // Project Dependencies handlers (Phase 2)
      this.uiHandler.register('project', 'addDependency', this.handleUIAddDependency.bind(this));
      this.uiHandler.register('project', 'removeDependency', this.handleUIRemoveDependency.bind(this));
      this.uiHandler.register('project', 'getDependencies', this.handleUIGetDependencies.bind(this));
      this.uiHandler.register('project', 'getDependents', this.handleUIGetDependents.bind(this));
      // Event Subscriptions handlers
      this.uiHandler.register('project', 'addSubscription', this.handleUIAddSubscription.bind(this));
      this.uiHandler.register('project', 'removeSubscription', this.handleUIRemoveSubscription.bind(this));
      this.uiHandler.register('project', 'getSubscriptions', this.handleUIGetSubscriptions.bind(this));
      // System handlers (Phase 3)
      this.uiHandler.register('system', 'create', this.handleUISystemCreate.bind(this));
      this.uiHandler.register('system', 'list', this.handleUISystemList.bind(this));
      this.uiHandler.register('system', 'get', this.handleUISystemGet.bind(this));
      this.uiHandler.register('system', 'update', this.handleUISystemUpdate.bind(this));
      this.uiHandler.register('system', 'delete', this.handleUISystemDelete.bind(this));
      this.uiHandler.register('system', 'addProject', this.handleUISystemAddProject.bind(this));
      this.uiHandler.register('system', 'removeProject', this.handleUISystemRemoveProject.bind(this));
      this.uiHandler.register('system', 'getUnassigned', this.handleUISystemGetUnassigned.bind(this));
      // Context handlers (Phase 4)
      this.uiHandler.register('context', 'import', this.handleUIContextImport.bind(this));
      this.uiHandler.register('context', 'remove', this.handleUIContextRemove.bind(this));
      this.uiHandler.register('context', 'getShared', this.handleUIContextGetShared.bind(this));
      this.uiHandler.register('context', 'getExported', this.handleUIContextGetExported.bind(this));
      this.uiHandler.register('context', 'getSources', this.handleUIContextGetSources.bind(this));
      this.uiHandler.register('context', 'getFull', this.handleUIContextGetFull.bind(this));

      this.logger.info('project-manager.ui_handlers.registered', {
        projectHandlers: ['list', 'get', 'create', 'update', 'delete', 'activate', 'saveSession', 'restoreSession', 'setAIConfig', 'setLastConversation', 'link', 'unlink', 'getLinks', 'getRelated', 'addDependency', 'removeDependency', 'getDependencies', 'getDependents'],
        systemHandlers: ['create', 'list', 'get', 'update', 'delete', 'addProject', 'removeProject', 'getUnassigned'],
        contextHandlers: ['import', 'remove', 'getShared', 'getExported', 'getSources', 'getFull']
      });
    }

    // Load existing projects from database
    await this.loadExistingProjects();

    this.logger.info('project-manager.loaded', { module: this.name });
  }

  async onUnload() {
    this.logger.info({ correlationId: 'system' }, 'Project Manager module unloading');

    // Unregister UI handlers
    if (this.uiHandler) {
      this.uiHandler.unregister('project', 'list');
      this.uiHandler.unregister('project', 'get');
      this.uiHandler.unregister('project', 'create');
      this.uiHandler.unregister('project', 'update');
      this.uiHandler.unregister('project', 'delete');
      this.uiHandler.unregister('project', 'activate');
      this.uiHandler.unregister('project', 'saveSession');
      this.uiHandler.unregister('project', 'restoreSession');
      this.uiHandler.unregister('project', 'setAIConfig');
      this.uiHandler.unregister('project', 'setLastConversation');
      // Project Composition handlers (Phase 1)
      this.uiHandler.unregister('project', 'link');
      this.uiHandler.unregister('project', 'unlink');
      this.uiHandler.unregister('project', 'getLinks');
      this.uiHandler.unregister('project', 'getRelated');
      // Project Dependencies handlers (Phase 2)
      this.uiHandler.unregister('project', 'addDependency');
      this.uiHandler.unregister('project', 'removeDependency');
      this.uiHandler.unregister('project', 'getDependencies');
      this.uiHandler.unregister('project', 'getDependents');
      // System handlers (Phase 3)
      this.uiHandler.unregister('system', 'create');
      this.uiHandler.unregister('system', 'list');
      this.uiHandler.unregister('system', 'get');
      this.uiHandler.unregister('system', 'update');
      this.uiHandler.unregister('system', 'delete');
      this.uiHandler.unregister('system', 'addProject');
      this.uiHandler.unregister('system', 'removeProject');
      this.uiHandler.unregister('system', 'getUnassigned');
      // Context handlers (Phase 4)
      this.uiHandler.unregister('context', 'import');
      this.uiHandler.unregister('context', 'remove');
      this.uiHandler.unregister('context', 'getShared');
      this.uiHandler.unregister('context', 'getExported');
      this.uiHandler.unregister('context', 'getSources');
      this.uiHandler.unregister('context', 'getFull');
    }

    // Unsubscribe all eventBus subscriptions
    for (const unsub of this.unsubscribes) {
      await unsub();
    }
    this.unsubscribes = [];

    // Clear pending requests
    for (const [requestId, pending] of this.pendingDbRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Module unloading'));
    }
    this.pendingDbRequests.clear();

    this.logger.info({ correlationId: 'system' }, 'Project Manager module unloaded');
  }

  // ==================== DATABASE HELPERS ====================

  /**
   * Query database via events
   */
  async queryDatabase(query, params = [], readOnly = false, correlationId) {
    const requestId = crypto.randomUUID();

    const dbPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingDbRequests.delete(requestId);
        reject(new Error('Database query timeout'));
      }, this.config.dbTimeout || 10000);

      this.pendingDbRequests.set(requestId, { resolve, reject, timeout });
    });

    await this.eventBus.publish(EVENTS.DB.QUERY_REQUEST, {
      project_id: 'system', // Project metadata stored in system DB
      query,
      params,
      read_only: readOnly,
      request_id: requestId,
      correlation_id: correlationId
    });

    return await dbPromise;
  }

  /**
   * Handle database query responses
   */
  async onDbQueryResponse(event) {
    // El EventBus envía un envelope, los datos están en event.data
    const eventData = event.data || event;
    const { request_id, success, data, error } = eventData;

    const pending = this.pendingDbRequests.get(request_id);
    if (!pending) {
      return; // Response for unknown/expired request
    }

    clearTimeout(pending.timeout);
    this.pendingDbRequests.delete(request_id);

    if (success) {
      pending.resolve(data || []);
    } else {
      pending.reject(new Error(error || 'Database query failed'));
    }
  }

  // ==================== INITIALIZATION ====================

  /**
   * Load existing projects from database
   */
  async loadExistingProjects() {
    const correlationId = crypto.randomUUID();
    this.logger.debug({ correlationId }, 'Loading existing projects from database');

    try {
      // Ensure projects table exists with all required fields
      await this.queryDatabase(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          is_active INTEGER DEFAULT 0,
          metadata TEXT,
          last_conversation_id TEXT,
          provider TEXT,
          model TEXT,
          prompt_id TEXT,
          base_path TEXT,
          session_state TEXT,
          system_id TEXT,
          system_role TEXT,
          parent_project_id TEXT
        )
      `, [], false, correlationId);

      // Migrate existing databases: add composition columns if missing
      await this.migrateCompositionColumns(correlationId);

      // Initialize composition tables (systems, links, dependencies, shared_context)
      await this.initializeCompositionTables(correlationId);

      // Load all projects
      const rows = await this.queryDatabase(
        'SELECT * FROM projects ORDER BY created_at DESC',
        [],
        true,
        correlationId
      );

      for (const row of rows) {
        const project = {
          id: row.id,
          name: row.name,
          description: row.description || '',
          created_at: row.created_at,
          updated_at: row.updated_at,
          is_active: row.is_active === 1,
          metadata: row.metadata ? JSON.parse(row.metadata) : {},
          // Session/config fields
          last_conversation_id: row.last_conversation_id || null,
          provider: row.provider || null,
          model: row.model || null,
          prompt_id: row.prompt_id || null,
          base_path: row.base_path || null,
          session_state: row.session_state ? JSON.parse(row.session_state) : {},
          // Composition fields (Fase 0)
          system_id: row.system_id || null,
          system_role: row.system_role || null,
          parent_project_id: row.parent_project_id || null,
          // Event subscriptions (auto-subscribe when project activates)
          event_subscriptions: row.event_subscriptions ? JSON.parse(row.event_subscriptions) : []
        };

        this.projects.set(project.id, project);

        if (project.is_active) {
          this.activeProjectId = project.id;
        }
      }

      this.logger.info({ correlationId, count: this.projects.size }, 'Loaded existing projects');
      // REMOVED: this.metrics.gauge('project.total.count', this.projects.size);

      if (this.activeProjectId) {
        // REMOVED: this.metrics.gauge('project.active.count', 1);
      }
    } catch (error) {
      this.logger.error({ correlationId, error: error.message }, 'Failed to load projects');
    }
  }

  /**
   * Migrate existing databases: add composition columns if missing
   * Safe to run multiple times - uses ALTER TABLE with error handling
   */
  async migrateCompositionColumns(correlationId) {
    const columnsToAdd = [
      { name: 'system_id', type: 'TEXT' },
      { name: 'system_role', type: 'TEXT' },
      { name: 'parent_project_id', type: 'TEXT' },
      { name: 'event_subscriptions', type: 'TEXT' }  // JSON array of event subscriptions
    ];

    for (const col of columnsToAdd) {
      try {
        await this.queryDatabase(
          `ALTER TABLE projects ADD COLUMN ${col.name} ${col.type}`,
          [], false, correlationId
        );
        this.logger.info({ correlationId, column: col.name }, 'Added composition column');
      } catch (error) {
        // Column already exists - this is expected for existing installations
        if (!error.message?.includes('duplicate column')) {
          this.logger.debug({ correlationId, column: col.name }, 'Composition column already exists');
        }
      }
    }
  }

  /**
   * Initialize composition tables for project relationships
   * Creates: systems, project_links, project_dependencies, shared_context
   */
  async initializeCompositionTables(correlationId) {
    this.logger.debug({ correlationId }, 'Initializing composition tables');

    // Table: systems - Logical containers for related projects
    await this.queryDatabase(`
      CREATE TABLE IF NOT EXISTS systems (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata TEXT
      )
    `, [], false, correlationId);

    // Table: project_links - Relationships between projects
    await this.queryDatabase(`
      CREATE TABLE IF NOT EXISTS project_links (
        id TEXT PRIMARY KEY,
        source_project_id TEXT NOT NULL,
        target_project_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (source_project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (target_project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `, [], false, correlationId);

    // Table: project_dependencies - Explicit dependencies between projects
    await this.queryDatabase(`
      CREATE TABLE IF NOT EXISTS project_dependencies (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        depends_on_project_id TEXT NOT NULL,
        dependency_type TEXT,
        description TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (depends_on_project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `, [], false, correlationId);

    // Table: shared_context - Conversations shared between projects
    await this.queryDatabase(`
      CREATE TABLE IF NOT EXISTS shared_context (
        id TEXT PRIMARY KEY,
        from_project_id TEXT NOT NULL,
        to_project_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        reason TEXT,
        imported_at TEXT NOT NULL,
        FOREIGN KEY (from_project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (to_project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `, [], false, correlationId);

    // Create indexes for performance
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_projects_system ON projects(system_id)',
      'CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects(parent_project_id)',
      'CREATE INDEX IF NOT EXISTS idx_links_source ON project_links(source_project_id)',
      'CREATE INDEX IF NOT EXISTS idx_links_target ON project_links(target_project_id)',
      'CREATE INDEX IF NOT EXISTS idx_deps_project ON project_dependencies(project_id)',
      'CREATE INDEX IF NOT EXISTS idx_deps_depends ON project_dependencies(depends_on_project_id)',
      'CREATE INDEX IF NOT EXISTS idx_shared_from ON shared_context(from_project_id)',
      'CREATE INDEX IF NOT EXISTS idx_shared_to ON shared_context(to_project_id)'
    ];

    for (const indexSql of indexes) {
      try {
        await this.queryDatabase(indexSql, [], false, correlationId);
      } catch (error) {
        // Index might already exist - not a problem
        this.logger.debug({ correlationId, error: error.message }, 'Index creation skipped');
      }
    }

    this.logger.info({ correlationId }, 'Composition tables initialized');
  }

  // ==================== PROJECT CRUD ====================

  /**
   * Create new project
   * @param {string} name - Project name
   * @param {string} description - Project description
   * @param {object} metadata - Additional metadata (color, icon, workspaceType)
   * @param {string} correlationId - Correlation ID for tracing
   * @param {object} options - Optional: { provider, model, prompt_id }
   */
  async createProject(name, description = '', metadata = {}, correlationId, options = {}) {
    const startTime = Date.now();
    const projectId = crypto.randomUUID();
    const now = new Date().toISOString();

    this.logger.info({ correlationId, projectId, name }, 'Creating project');

    try {
      // Check if project name already exists
      if (await this.projectNameExists(name, correlationId)) {
        const error = new Error(`Project with name "${name}" already exists`);
        error.code = 'PROJECT_NAME_EXISTS';
        throw error;
      }

      // Create project directories
      const basePath = await this.createProjectDirectories(projectId, name, correlationId);

      // Extract optional AI config
      const { provider = null, model = null, prompt_id = null } = options;

      // Insert into database with all fields
      await this.queryDatabase(`
        INSERT INTO projects (
          id, name, description, created_at, updated_at, is_active, metadata,
          last_conversation_id, provider, model, prompt_id, base_path, session_state
        )
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
      `, [
        projectId,
        name,
        description,
        now,
        now,
        JSON.stringify(metadata),
        null,  // last_conversation_id
        provider,
        model,
        prompt_id,
        basePath,
        JSON.stringify({})  // session_state
      ], false, correlationId);

      // Create project object with all fields
      const project = {
        id: projectId,
        name,
        description,
        created_at: now,
        updated_at: now,
        is_active: false,
        metadata,
        // New fields
        last_conversation_id: null,
        provider,
        model,
        prompt_id,
        base_path: basePath,
        session_state: {}
      };

      // Store in cache
      this.projects.set(projectId, project);

      // Initialize project database schema
      await this.initializeProjectSchema(projectId, correlationId);

      // Update metrics
      // REMOVED (migrate-to-event-metrics): this.metrics.increment('project.created.total');
    // → Counter extracted from events
      // REMOVED: this.metrics.gauge('project.total.count', this.projects.size);
      // REMOVED: this.metrics.timing('project.creation.duration', Date.now() - startTime);

      // Publish event
      await this.eventBus.publish(EVENTS.PROJECT.CREATED, {
        project_id: projectId,
        name,
        description,
        created_at: now
      });

      this.logger.info({ correlationId, projectId, name }, 'Project created successfully');

      return project;
    } catch (error) {
      // REMOVED (migrate-to-event-metrics): this.metrics.increment('project.error.total', 1, { operation: 'create' });
    // → Counter extracted from events
      this.logger.error({ correlationId, projectId, name, error: error.message }, 'Failed to create project');
      throw error;
    }
  }

  /**
   * Initialize database schema for new project
   * Note: This is fire-and-forget - we don't wait for completion
   * since the project can be used immediately with default schema
   */
  async initializeProjectSchema(projectId, correlationId) {
    this.logger.debug({ correlationId, projectId }, 'Initializing project database schema');

    // Fire-and-forget: publish schema init request without waiting
    // The database manager will handle it asynchronously
    try {
      await this.eventBus.publish('db.schema.init.request', {
        project_id: projectId,
        schema: this.config.defaultSchema,
        correlation_id: correlationId
      });
      this.logger.debug({ correlationId, projectId }, 'Project schema initialization requested');
    } catch (err) {
      // Log but don't fail - schema init is optional
      this.logger.warn({ correlationId, projectId, error: err.message }, 'Schema init request failed (non-fatal)');
    }
  }

  /**
   * Update project
   */
  async updateProject(projectId, updates, correlationId) {
    this.logger.info({ correlationId, projectId, updates }, 'Updating project');

    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const now = new Date().toISOString();
    const updatedFields = [];
    const queryParts = [];
    const params = [];

    if (updates.name !== undefined) {
      queryParts.push('name = ?');
      params.push(updates.name);
      project.name = updates.name;
      updatedFields.push('name');
    }

    if (updates.description !== undefined) {
      queryParts.push('description = ?');
      params.push(updates.description);
      project.description = updates.description;
      updatedFields.push('description');
    }

    if (updates.metadata !== undefined) {
      queryParts.push('metadata = ?');
      params.push(JSON.stringify(updates.metadata));
      project.metadata = updates.metadata;
      updatedFields.push('metadata');
    }

    if (queryParts.length === 0) {
      this.logger.warn({ correlationId, projectId }, 'No fields to update');
      return project;
    }

    queryParts.push('updated_at = ?');
    params.push(now);
    params.push(projectId);

    try {
      await this.queryDatabase(
        `UPDATE projects SET ${queryParts.join(', ')} WHERE id = ?`,
        params,
        false,
        correlationId
      );

      project.updated_at = now;
      this.projects.set(projectId, project);

      // REMOVED (migrate-to-event-metrics): this.metrics.increment('project.updated.total');
    // → Counter extracted from events

      await this.eventBus.publish(EVENTS.PROJECT.UPDATED, {
        project_id: projectId,
        updated_fields: updatedFields,
        updated_at: now
      });

      this.logger.info({ correlationId, projectId }, 'Project updated successfully');

      return project;
    } catch (error) {
      // REMOVED (migrate-to-event-metrics): this.metrics.increment('project.error.total', 1, { operation: 'update' });
    // → Counter extracted from events
      this.logger.error({ correlationId, projectId, error: error.message }, 'Failed to update project');
      throw error;
    }
  }

  /**
   * Delete project
   * @param {string} projectId - Project ID
   * @param {string} correlationId - Correlation ID for tracing
   * @param {object} options - Optional: { force: boolean } - Force delete even with dependents
   */
  async deleteProject(projectId, correlationId, options = {}) {
    this.logger.info({ correlationId, projectId }, 'Deleting project');

    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Cannot delete active project
    if (project.is_active) {
      throw new Error('Cannot delete active project. Deactivate first.');
    }

    // Check for dependents (Phase 2)
    const dependentsInfo = await this.hasDependents(projectId, correlationId);
    if (dependentsInfo.hasDependents && !options.force) {
      const dependentNames = dependentsInfo.dependents.map(d => d.name).join(', ');
      const error = new Error(`Cannot delete project: ${dependentsInfo.count} project(s) depend on it: ${dependentNames}. Use force=true to delete anyway.`);
      error.code = 'HAS_DEPENDENTS';
      error.dependents = dependentsInfo.dependents;
      throw error;
    }

    try {
      await this.queryDatabase(
        'DELETE FROM projects WHERE id = ?',
        [projectId],
        false,
        correlationId
      );

      // Delete project directories
      if (project.base_path) {
        await this.deleteProjectDirectories(project.base_path, correlationId);
      }

      this.projects.delete(projectId);

      // REMOVED (migrate-to-event-metrics): this.metrics.increment('project.deleted.total');
    // → Counter extracted from events
      // REMOVED: this.metrics.gauge('project.total.count', this.projects.size);

      await this.eventBus.publish(EVENTS.PROJECT.DELETED, {
        project_id: projectId,
        name: project.name,
        deleted_at: new Date().toISOString()
      });

      this.logger.info({ correlationId, projectId }, 'Project deleted successfully');

      return { success: true, id: projectId };
    } catch (error) {
      // REMOVED (migrate-to-event-metrics): this.metrics.increment('project.error.total', 1, { operation: 'delete' });
    // → Counter extracted from events
      this.logger.error({ correlationId, projectId, error: error.message }, 'Failed to delete project');
      throw error;
    }
  }

  // ==================== SESSION & AI CONFIG ====================

  /**
   * Save session state for a project
   * @param {string} projectId - Project ID
   * @param {object} sessionData - Session data: { scroll_position, context_config, ui_state }
   * @param {string} correlationId - Correlation ID for tracing
   */
  async saveSession(projectId, sessionData, correlationId) {
    this.logger.debug({ correlationId, projectId }, 'Saving project session');

    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const now = new Date().toISOString();
    const sessionState = {
      ...project.session_state,
      ...sessionData,
      saved_at: now
    };

    try {
      await this.queryDatabase(
        'UPDATE projects SET session_state = ?, updated_at = ? WHERE id = ?',
        [JSON.stringify(sessionState), now, projectId],
        false,
        correlationId
      );

      project.session_state = sessionState;
      project.updated_at = now;
      this.projects.set(projectId, project);

      this.logger.info({ correlationId, projectId }, 'Project session saved');

      return sessionState;
    } catch (error) {
      this.logger.error({ correlationId, projectId, error: error.message }, 'Failed to save session');
      throw error;
    }
  }

  /**
   * Restore session state for a project
   * @param {string} projectId - Project ID
   * @param {string} correlationId - Correlation ID for tracing
   */
  async restoreSession(projectId, correlationId) {
    this.logger.debug({ correlationId, projectId }, 'Restoring project session');

    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    return {
      last_conversation_id: project.last_conversation_id,
      session_state: project.session_state || {},
      provider: project.provider,
      model: project.model,
      prompt_id: project.prompt_id
    };
  }

  /**
   * Update last conversation ID for a project
   * @param {string} projectId - Project ID
   * @param {string} conversationId - Last active conversation ID
   * @param {string} correlationId - Correlation ID for tracing
   */
  async setLastConversation(projectId, conversationId, correlationId) {
    this.logger.debug({ correlationId, projectId, conversationId }, 'Setting last conversation');

    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const now = new Date().toISOString();

    try {
      await this.queryDatabase(
        'UPDATE projects SET last_conversation_id = ?, updated_at = ? WHERE id = ?',
        [conversationId, now, projectId],
        false,
        correlationId
      );

      project.last_conversation_id = conversationId;
      project.updated_at = now;
      this.projects.set(projectId, project);

      this.logger.info({ correlationId, projectId, conversationId }, 'Last conversation updated');

      return project;
    } catch (error) {
      this.logger.error({ correlationId, projectId, error: error.message }, 'Failed to set last conversation');
      throw error;
    }
  }

  /**
   * Set AI configuration override for a project
   * @param {string} projectId - Project ID
   * @param {object} aiConfig - AI config: { provider, model, prompt_id }
   * @param {string} correlationId - Correlation ID for tracing
   */
  async setProjectAIConfig(projectId, aiConfig, correlationId) {
    this.logger.info({ correlationId, projectId, aiConfig }, 'Setting project AI config');

    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const now = new Date().toISOString();
    const { provider, model, prompt_id } = aiConfig;

    const queryParts = ['updated_at = ?'];
    const params = [now];

    if (provider !== undefined) {
      queryParts.push('provider = ?');
      params.push(provider);
      project.provider = provider;
    }

    if (model !== undefined) {
      queryParts.push('model = ?');
      params.push(model);
      project.model = model;
    }

    if (prompt_id !== undefined) {
      queryParts.push('prompt_id = ?');
      params.push(prompt_id);
      project.prompt_id = prompt_id;
    }

    params.push(projectId);

    try {
      await this.queryDatabase(
        `UPDATE projects SET ${queryParts.join(', ')} WHERE id = ?`,
        params,
        false,
        correlationId
      );

      project.updated_at = now;
      this.projects.set(projectId, project);

      await this.eventBus.publish(EVENTS.PROJECT.UPDATED, {
        project_id: projectId,
        updated_fields: ['provider', 'model', 'prompt_id'].filter(f => aiConfig[f] !== undefined),
        updated_at: now
      });

      this.logger.info({ correlationId, projectId }, 'Project AI config updated');

      return {
        provider: project.provider,
        model: project.model,
        prompt_id: project.prompt_id
      };
    } catch (error) {
      this.logger.error({ correlationId, projectId, error: error.message }, 'Failed to set AI config');
      throw error;
    }
  }

  /**
   * Activate project
   */
  async activateProject(projectId, correlationId) {
    this.logger.info({ correlationId, projectId }, 'Activating project');

    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Si ya está activo, solo re-emitir el evento (útil para que módulos reciban el contexto al reconectar)
    if (this.activeProjectId === projectId) {
      this.logger.info({ correlationId, projectId }, 'Project already active, re-emitting event');

      await this.eventBus.publish(EVENTS.PROJECT.ACTIVATED, {
        project_id: projectId,
        name: project.name,
        base_path: project.base_path,
        activated_at: new Date().toISOString()
      });

      return project;
    }

    try {
      // Deactivate all projects
      await this.queryDatabase(
        'UPDATE projects SET is_active = 0',
        [],
        false,
        correlationId
      );

      // Activate target project
      await this.queryDatabase(
        'UPDATE projects SET is_active = 1 WHERE id = ?',
        [projectId],
        false,
        correlationId
      );

      // Update cache
      const previousActiveId = this.activeProjectId;

      // Unsubscribe from previous project's events
      if (previousActiveId) {
        await this.unsubscribeFromProjectEvents(correlationId);

        const prevProject = this.projects.get(previousActiveId);
        if (prevProject) {
          prevProject.is_active = false;
          this.projects.set(previousActiveId, prevProject);
        }

        await this.eventBus.publish('project.deactivated', {
          project_id: previousActiveId,
          name: prevProject?.name,
          deactivated_at: new Date().toISOString()
        });
      }

      project.is_active = true;
      this.projects.set(projectId, project);
      this.activeProjectId = projectId;

      // REMOVED (migrate-to-event-metrics): this.metrics.increment('project.activated.total');
    // → Counter extracted from events
      // REMOVED: this.metrics.gauge('project.active.count', 1);

      await this.eventBus.publish(EVENTS.PROJECT.ACTIVATED, {
        project_id: projectId,
        name: project.name,
        base_path: project.base_path,
        activated_at: new Date().toISOString()
      });

      // Subscribe to project's configured events
      await this.subscribeToProjectEvents(project, correlationId);

      this.logger.info({ correlationId, projectId }, 'Project activated successfully');

      return project;
    } catch (error) {
      // REMOVED (migrate-to-event-metrics): this.metrics.increment('project.error.total', 1, { operation: 'activate' });
    // → Counter extracted from events
      this.logger.error({ correlationId, projectId, error: error.message }, 'Failed to activate project');
      throw error;
    }
  }

  /**
   * Get project by ID
   */
  getProject(projectId) {
    return this.projects.get(projectId);
  }

  /**
   * List all projects
   */
  listProjects() {
    return Array.from(this.projects.values());
  }

  /**
   * Get active project ID
   */
  getActiveProjectId() {
    return this.activeProjectId;
  }

  // ==================== PROJECT EVENT SUBSCRIPTIONS ====================

  /**
   * Subscribe to project's configured events
   * Called when a project is activated
   */
  async subscribeToProjectEvents(project, correlationId) {
    const subscriptions = project.event_subscriptions || [];

    if (subscriptions.length === 0) {
      return;
    }

    this.logger.info({
      correlationId,
      projectId: project.id,
      subscriptionCount: subscriptions.length
    }, 'Subscribing to project events');

    for (const sub of subscriptions) {
      try {
        const handler = this.createSubscriptionHandler(project, sub, correlationId);
        const unsub = await this.eventBus.subscribe(sub.event, handler);
        this.activeProjectSubscriptions.push(unsub);

        this.logger.debug({
          correlationId,
          projectId: project.id,
          event: sub.event,
          action: sub.action
        }, 'Subscribed to project event');
      } catch (error) {
        this.logger.error({
          correlationId,
          projectId: project.id,
          event: sub.event,
          error: error.message
        }, 'Failed to subscribe to project event');
      }
    }
  }

  /**
   * Unsubscribe from all active project events
   * Called when a project is deactivated
   */
  async unsubscribeFromProjectEvents(correlationId) {
    if (this.activeProjectSubscriptions.length === 0) {
      return;
    }

    this.logger.info({
      correlationId,
      count: this.activeProjectSubscriptions.length
    }, 'Unsubscribing from project events');

    for (const unsub of this.activeProjectSubscriptions) {
      try {
        if (typeof unsub === 'function') {
          await unsub();
        }
      } catch (error) {
        this.logger.warn({ correlationId, error: error.message }, 'Error unsubscribing from project event');
      }
    }

    this.activeProjectSubscriptions = [];
  }

  /**
   * Create a handler function for a subscription
   */
  createSubscriptionHandler(project, subscription, correlationId) {
    return async (event) => {
      const data = event?.data || event?.payload || event;

      // Apply filter if configured
      if (subscription.filter) {
        const matches = this.matchesFilter(data, subscription.filter);
        if (!matches) {
          return; // Skip - doesn't match filter
        }
      }

      this.logger.info({
        correlationId,
        projectId: project.id,
        event: subscription.event,
        action: subscription.action
      }, 'Project event triggered');

      // Execute the configured action
      await this.executeSubscriptionAction(project, subscription, data, correlationId);
    };
  }

  /**
   * Check if event data matches the configured filter
   */
  matchesFilter(data, filter) {
    for (const [key, value] of Object.entries(filter)) {
      if (data[key] !== value) {
        return false;
      }
    }
    return true;
  }

  /**
   * Execute the action configured for a subscription
   */
  async executeSubscriptionAction(project, subscription, eventData, correlationId) {
    const { action, config = {} } = subscription;
    const requestId = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      switch (action) {
        case 'save_file':
          await this.actionSaveFile(project, config, eventData, requestId, correlationId);
          break;

        case 'send_message':
          await this.actionSendMessage(project, config, eventData, requestId, correlationId);
          break;

        case 'publish_event':
          await this.actionPublishEvent(project, config, eventData, requestId, correlationId);
          break;

        default:
          this.logger.warn({
            correlationId,
            projectId: project.id,
            action
          }, 'Unknown subscription action');
      }
    } catch (error) {
      this.logger.error({
        correlationId,
        projectId: project.id,
        action,
        error: error.message
      }, 'Failed to execute subscription action');
    }
  }

  /**
   * Action: Save file from Telegram to project storage
   */
  async actionSaveFile(project, config, eventData, requestId, correlationId) {
    const { botName, fileId, fileName, chatId } = eventData;
    const destination = config.destination || '/received';

    this.logger.info({
      correlationId,
      projectId: project.id,
      fileId,
      fileName,
      destination
    }, 'Executing save_file action');

    // Step 1: Get file from Telegram
    await this.eventBus.publish('telegram.get_file.request', {
      request_id: requestId,
      botName,
      fileId,
      download: false
    });

    // Set up response handler for the file download chain
    const handleFileResponse = async (response) => {
      const respData = response?.data || response;
      if (respData.request_id !== requestId) return;

      if (!respData.success) {
        this.logger.error({ correlationId, error: respData.error }, 'Failed to get file info');
        return;
      }

      try {
        // Download file content
        const fileContent = await this.downloadFile(respData.downloadUrl);

        // Generate filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const safeName = (fileName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
        const destPath = `${destination}/${timestamp}_${safeName}`;

        // Save to project storage
        await this.eventBus.publish('fs.write.request', {
          request_id: `${requestId}-write`,
          path: destPath,
          content: fileContent.toString('base64'),
          encoding: 'base64'
        });

        this.logger.info({
          correlationId,
          projectId: project.id,
          path: destPath
        }, 'File saved to project storage');

        // Send confirmation if configured
        if (config.sendConfirmation !== false && chatId) {
          const message = config.confirmationMessage ||
            `✅ Archivo recibido y guardado:\n📄 ${fileName || 'archivo'}\n📁 ${destPath}`;

          await this.eventBus.publish('telegram.send_message.request', {
            request_id: `${requestId}-confirm`,
            botName,
            chatId,
            text: message
          });
        }
      } catch (error) {
        this.logger.error({
          correlationId,
          projectId: project.id,
          error: error.message
        }, 'Failed to save file');
      }
    };

    // Subscribe temporarily to get the response
    const unsub = await this.eventBus.subscribe('telegram.get_file.response', handleFileResponse);

    // Auto-unsubscribe after 30 seconds
    setTimeout(async () => {
      if (typeof unsub === 'function') await unsub();
    }, 30000);
  }

  /**
   * Action: Send a message via Telegram
   */
  async actionSendMessage(project, config, eventData, requestId, correlationId) {
    const { botName, chatId } = eventData;
    const message = this.interpolateTemplate(config.message || 'Evento recibido', eventData);

    await this.eventBus.publish('telegram.send_message.request', {
      request_id: requestId,
      botName: config.botName || botName,
      chatId: config.chatId || chatId,
      text: message
    });

    this.logger.info({
      correlationId,
      projectId: project.id,
      chatId: config.chatId || chatId
    }, 'Message sent');
  }

  /**
   * Action: Publish a custom event
   */
  async actionPublishEvent(project, config, eventData, requestId, correlationId) {
    const payload = {
      ...eventData,
      project_id: project.id,
      project_name: project.name,
      triggered_at: new Date().toISOString()
    };

    await this.eventBus.publish(config.eventName, payload);

    this.logger.info({
      correlationId,
      projectId: project.id,
      eventName: config.eventName
    }, 'Custom event published');
  }

  /**
   * Download file from URL (helper for save_file action)
   */
  async downloadFile(url) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const http = require('http');
      const client = url.startsWith('https') ? https : http;

      client.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          this.downloadFile(res.headers.location).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  /**
   * Interpolate template variables like {{fileName}}
   */
  interpolateTemplate(template, data) {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return data[key] !== undefined ? data[key] : match;
    });
  }

  // ==================== PROJECT COMPOSITION (PHASE 1) ====================

  /**
   * Create a link between two projects
   * @param {string} sourceProjectId - Source project ID
   * @param {string} targetProjectId - Target project ID
   * @param {string} linkType - Type: 'inspired_by' | 'related_to' | 'evolved_from'
   * @param {string} reason - Reason for the link
   * @param {string} correlationId - Correlation ID for tracing
   */
  async linkProjects(sourceProjectId, targetProjectId, linkType, reason, correlationId) {
    this.logger.info({ correlationId, sourceProjectId, targetProjectId, linkType }, 'Linking projects');

    // Validate projects exist
    const sourceProject = this.projects.get(sourceProjectId);
    const targetProject = this.projects.get(targetProjectId);

    if (!sourceProject) {
      throw new Error(`Source project not found: ${sourceProjectId}`);
    }
    if (!targetProject) {
      throw new Error(`Target project not found: ${targetProjectId}`);
    }
    if (sourceProjectId === targetProjectId) {
      throw new Error('Cannot link a project to itself');
    }

    // Check if link already exists
    const existingLinks = await this.queryDatabase(
      `SELECT id FROM project_links
       WHERE source_project_id = ? AND target_project_id = ? AND link_type = ?`,
      [sourceProjectId, targetProjectId, linkType],
      true,
      correlationId
    );

    if (existingLinks.length > 0) {
      throw new Error(`Link already exists between these projects with type '${linkType}'`);
    }

    const linkId = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.queryDatabase(`
      INSERT INTO project_links (id, source_project_id, target_project_id, link_type, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [linkId, sourceProjectId, targetProjectId, linkType, reason || null, now], false, correlationId);

    // Emit event
    await this.eventBus.publish('project.linked', {
      link_id: linkId,
      source_project_id: sourceProjectId,
      source_project_name: sourceProject.name,
      target_project_id: targetProjectId,
      target_project_name: targetProject.name,
      link_type: linkType,
      reason,
      created_at: now
    });

    this.logger.info({ correlationId, linkId, sourceProjectId, targetProjectId }, 'Projects linked successfully');

    return {
      id: linkId,
      sourceProjectId,
      targetProjectId,
      linkType,
      reason,
      createdAt: now
    };
  }

  /**
   * Remove a link between projects
   * @param {string} linkId - Link ID to remove
   * @param {string} correlationId - Correlation ID for tracing
   */
  async unlinkProjects(linkId, correlationId) {
    this.logger.info({ correlationId, linkId }, 'Unlinking projects');

    // Get link info before deleting
    const links = await this.queryDatabase(
      'SELECT * FROM project_links WHERE id = ?',
      [linkId],
      true,
      correlationId
    );

    if (links.length === 0) {
      throw new Error(`Link not found: ${linkId}`);
    }

    const link = links[0];

    await this.queryDatabase(
      'DELETE FROM project_links WHERE id = ?',
      [linkId],
      false,
      correlationId
    );

    // Emit event
    await this.eventBus.publish('project.unlinked', {
      link_id: linkId,
      source_project_id: link.source_project_id,
      target_project_id: link.target_project_id,
      link_type: link.link_type,
      unlinked_at: new Date().toISOString()
    });

    this.logger.info({ correlationId, linkId }, 'Projects unlinked successfully');

    return { success: true, linkId };
  }

  /**
   * Get all links for a project (both as source and target)
   * @param {string} projectId - Project ID
   * @param {string} correlationId - Correlation ID for tracing
   */
  async getProjectLinks(projectId, correlationId) {
    this.logger.debug({ correlationId, projectId }, 'Getting project links');

    const links = await this.queryDatabase(`
      SELECT
        pl.*,
        sp.name as source_project_name,
        tp.name as target_project_name
      FROM project_links pl
      LEFT JOIN projects sp ON pl.source_project_id = sp.id
      LEFT JOIN projects tp ON pl.target_project_id = tp.id
      WHERE pl.source_project_id = ? OR pl.target_project_id = ?
      ORDER BY pl.created_at DESC
    `, [projectId, projectId], true, correlationId);

    return links.map(link => ({
      id: link.id,
      sourceProjectId: link.source_project_id,
      sourceProjectName: link.source_project_name,
      targetProjectId: link.target_project_id,
      targetProjectName: link.target_project_name,
      linkType: link.link_type,
      reason: link.reason,
      createdAt: link.created_at,
      direction: link.source_project_id === projectId ? 'outgoing' : 'incoming'
    }));
  }

  /**
   * Get related projects (projects connected via links)
   * @param {string} projectId - Project ID
   * @param {string} correlationId - Correlation ID for tracing
   */
  async getRelatedProjects(projectId, correlationId) {
    this.logger.debug({ correlationId, projectId }, 'Getting related projects');

    const links = await this.getProjectLinks(projectId, correlationId);

    // Get unique related project IDs
    const relatedIds = new Set();
    for (const link of links) {
      if (link.sourceProjectId !== projectId) {
        relatedIds.add(link.sourceProjectId);
      }
      if (link.targetProjectId !== projectId) {
        relatedIds.add(link.targetProjectId);
      }
    }

    // Get full project info for related projects
    const relatedProjects = [];
    for (const relatedId of relatedIds) {
      const project = this.projects.get(relatedId);
      if (project) {
        // Find the link(s) connecting to this project
        const connectingLinks = links.filter(
          l => l.sourceProjectId === relatedId || l.targetProjectId === relatedId
        );

        relatedProjects.push({
          id: project.id,
          name: project.name,
          description: project.description,
          color: project.metadata?.color || 'blue',
          icon: project.metadata?.icon || '📁',
          links: connectingLinks.map(l => ({
            linkType: l.linkType,
            reason: l.reason,
            direction: l.sourceProjectId === projectId ? 'outgoing' : 'incoming'
          }))
        });
      }
    }

    return relatedProjects;
  }

  // ==================== PROJECT DEPENDENCIES (PHASE 2) ====================

  /**
   * Add a dependency between projects
   * @param {string} projectId - Project that has the dependency
   * @param {string} dependsOnProjectId - Project that is depended upon
   * @param {string} dependencyType - Type: 'data' | 'code' | 'api' | 'context'
   * @param {string} description - Description of the dependency
   * @param {string} correlationId - Correlation ID for tracing
   */
  async addDependency(projectId, dependsOnProjectId, dependencyType, description, correlationId) {
    this.logger.info({ correlationId, projectId, dependsOnProjectId, dependencyType }, 'Adding dependency');

    // Validate projects exist
    const project = this.projects.get(projectId);
    const dependsOnProject = this.projects.get(dependsOnProjectId);

    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    if (!dependsOnProject) {
      throw new Error(`Dependency project not found: ${dependsOnProjectId}`);
    }
    if (projectId === dependsOnProjectId) {
      throw new Error('A project cannot depend on itself');
    }

    // Check if dependency already exists
    const existingDeps = await this.queryDatabase(
      `SELECT id FROM project_dependencies
       WHERE project_id = ? AND depends_on_project_id = ?`,
      [projectId, dependsOnProjectId],
      true,
      correlationId
    );

    if (existingDeps.length > 0) {
      throw new Error(`Dependency already exists: ${project.name} → ${dependsOnProject.name}`);
    }

    const depId = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.queryDatabase(`
      INSERT INTO project_dependencies (id, project_id, depends_on_project_id, dependency_type, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [depId, projectId, dependsOnProjectId, dependencyType || 'data', description || null, now], false, correlationId);

    // Emit event
    await this.eventBus.publish('project.dependency.added', {
      dependency_id: depId,
      project_id: projectId,
      project_name: project.name,
      depends_on_project_id: dependsOnProjectId,
      depends_on_project_name: dependsOnProject.name,
      dependency_type: dependencyType,
      description,
      created_at: now
    });

    this.logger.info({ correlationId, depId, projectId, dependsOnProjectId }, 'Dependency added successfully');

    return {
      id: depId,
      projectId,
      dependsOnProjectId,
      dependencyType: dependencyType || 'data',
      description,
      createdAt: now
    };
  }

  /**
   * Remove a dependency
   * @param {string} dependencyId - Dependency ID to remove
   * @param {string} correlationId - Correlation ID for tracing
   */
  async removeDependency(dependencyId, correlationId) {
    this.logger.info({ correlationId, dependencyId }, 'Removing dependency');

    // Get dependency info before deleting
    const deps = await this.queryDatabase(
      'SELECT * FROM project_dependencies WHERE id = ?',
      [dependencyId],
      true,
      correlationId
    );

    if (deps.length === 0) {
      throw new Error(`Dependency not found: ${dependencyId}`);
    }

    const dep = deps[0];

    await this.queryDatabase(
      'DELETE FROM project_dependencies WHERE id = ?',
      [dependencyId],
      false,
      correlationId
    );

    // Emit event
    await this.eventBus.publish('project.dependency.removed', {
      dependency_id: dependencyId,
      project_id: dep.project_id,
      depends_on_project_id: dep.depends_on_project_id,
      removed_at: new Date().toISOString()
    });

    this.logger.info({ correlationId, dependencyId }, 'Dependency removed successfully');

    return { success: true, dependencyId };
  }

  /**
   * Get all dependencies of a project (what this project depends on)
   * @param {string} projectId - Project ID
   * @param {string} correlationId - Correlation ID for tracing
   */
  async getDependencies(projectId, correlationId) {
    this.logger.debug({ correlationId, projectId }, 'Getting project dependencies');

    const deps = await this.queryDatabase(`
      SELECT
        pd.*,
        p.name as depends_on_project_name,
        p.description as depends_on_project_description
      FROM project_dependencies pd
      LEFT JOIN projects p ON pd.depends_on_project_id = p.id
      WHERE pd.project_id = ?
      ORDER BY pd.created_at DESC
    `, [projectId], true, correlationId);

    return deps.map(dep => ({
      id: dep.id,
      projectId: dep.project_id,
      dependsOnProjectId: dep.depends_on_project_id,
      dependsOnProjectName: dep.depends_on_project_name,
      dependsOnProjectDescription: dep.depends_on_project_description,
      dependencyType: dep.dependency_type,
      description: dep.description,
      createdAt: dep.created_at
    }));
  }

  /**
   * Get all dependents of a project (projects that depend on this one)
   * @param {string} projectId - Project ID
   * @param {string} correlationId - Correlation ID for tracing
   */
  async getDependents(projectId, correlationId) {
    this.logger.debug({ correlationId, projectId }, 'Getting project dependents');

    const deps = await this.queryDatabase(`
      SELECT
        pd.*,
        p.name as dependent_project_name,
        p.description as dependent_project_description
      FROM project_dependencies pd
      LEFT JOIN projects p ON pd.project_id = p.id
      WHERE pd.depends_on_project_id = ?
      ORDER BY pd.created_at DESC
    `, [projectId], true, correlationId);

    return deps.map(dep => ({
      id: dep.id,
      dependentProjectId: dep.project_id,
      dependentProjectName: dep.dependent_project_name,
      dependentProjectDescription: dep.dependent_project_description,
      dependencyType: dep.dependency_type,
      description: dep.description,
      createdAt: dep.created_at
    }));
  }

  /**
   * Check if a project has dependents (used before deletion)
   * @param {string} projectId - Project ID
   * @param {string} correlationId - Correlation ID for tracing
   */
  async hasDependents(projectId, correlationId) {
    const dependents = await this.getDependents(projectId, correlationId);
    return {
      hasDependents: dependents.length > 0,
      count: dependents.length,
      dependents: dependents.map(d => ({
        id: d.dependentProjectId,
        name: d.dependentProjectName
      }))
    };
  }

  // ==================== SYSTEMS (PHASE 3) ====================

  /**
   * Create a new system (logical container for related projects)
   * @param {string} name - System name
   * @param {string} description - System description
   * @param {object} metadata - Additional metadata
   * @param {string} correlationId - Correlation ID for tracing
   */
  async createSystem(name, description, metadata = {}, correlationId) {
    this.logger.info({ correlationId, name }, 'Creating system');

    if (!name || name.trim().length === 0) {
      throw new Error('System name is required');
    }

    const systemId = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.queryDatabase(`
      INSERT INTO systems (id, name, description, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [systemId, name.trim(), description || null, now, now, JSON.stringify(metadata)], false, correlationId);

    // Emit event
    await this.eventBus.publish('system.created', {
      system_id: systemId,
      name: name.trim(),
      description,
      created_at: now
    });

    this.logger.info({ correlationId, systemId, name }, 'System created successfully');

    return {
      id: systemId,
      name: name.trim(),
      description: description || '',
      metadata,
      createdAt: now,
      updatedAt: now,
      projects: []
    };
  }

  /**
   * Get a system by ID with its associated projects
   * @param {string} systemId - System ID
   * @param {string} correlationId - Correlation ID for tracing
   */
  async getSystem(systemId, correlationId) {
    this.logger.debug({ correlationId, systemId }, 'Getting system');

    const systems = await this.queryDatabase(
      'SELECT * FROM systems WHERE id = ?',
      [systemId],
      true,
      correlationId
    );

    if (systems.length === 0) {
      return null;
    }

    const system = systems[0];

    // Get associated projects
    const projects = await this.queryDatabase(`
      SELECT id, name, description, system_role, created_at, updated_at, metadata
      FROM projects
      WHERE system_id = ?
      ORDER BY system_role, name
    `, [systemId], true, correlationId);

    return {
      id: system.id,
      name: system.name,
      description: system.description || '',
      metadata: system.metadata ? JSON.parse(system.metadata) : {},
      createdAt: system.created_at,
      updatedAt: system.updated_at,
      projects: projects.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description || '',
        role: p.system_role,
        metadata: p.metadata ? JSON.parse(p.metadata) : {},
        createdAt: p.created_at,
        updatedAt: p.updated_at
      }))
    };
  }

  /**
   * List all systems
   * @param {string} correlationId - Correlation ID for tracing
   */
  async listSystems(correlationId) {
    this.logger.debug({ correlationId }, 'Listing systems');

    const systems = await this.queryDatabase(
      'SELECT * FROM systems ORDER BY name',
      [],
      true,
      correlationId
    );

    // Get project counts for each system
    const result = [];
    for (const system of systems) {
      const projectCount = await this.queryDatabase(
        'SELECT COUNT(*) as count FROM projects WHERE system_id = ?',
        [system.id],
        true,
        correlationId
      );

      result.push({
        id: system.id,
        name: system.name,
        description: system.description || '',
        metadata: system.metadata ? JSON.parse(system.metadata) : {},
        createdAt: system.created_at,
        updatedAt: system.updated_at,
        projectCount: projectCount[0]?.count || 0
      });
    }

    return result;
  }

  /**
   * Update a system
   * @param {string} systemId - System ID
   * @param {object} updates - Fields to update: { name?, description?, metadata? }
   * @param {string} correlationId - Correlation ID for tracing
   */
  async updateSystem(systemId, updates, correlationId) {
    this.logger.info({ correlationId, systemId, updates }, 'Updating system');

    const system = await this.getSystem(systemId, correlationId);
    if (!system) {
      throw new Error(`System not found: ${systemId}`);
    }

    const now = new Date().toISOString();
    const queryParts = ['updated_at = ?'];
    const params = [now];

    if (updates.name !== undefined) {
      queryParts.push('name = ?');
      params.push(updates.name.trim());
    }

    if (updates.description !== undefined) {
      queryParts.push('description = ?');
      params.push(updates.description);
    }

    if (updates.metadata !== undefined) {
      queryParts.push('metadata = ?');
      params.push(JSON.stringify(updates.metadata));
    }

    params.push(systemId);

    await this.queryDatabase(
      `UPDATE systems SET ${queryParts.join(', ')} WHERE id = ?`,
      params,
      false,
      correlationId
    );

    // Emit event
    await this.eventBus.publish('system.updated', {
      system_id: systemId,
      updated_fields: Object.keys(updates),
      updated_at: now
    });

    this.logger.info({ correlationId, systemId }, 'System updated successfully');

    return await this.getSystem(systemId, correlationId);
  }

  /**
   * Delete a system (does not delete projects, just removes their system_id)
   * @param {string} systemId - System ID
   * @param {string} correlationId - Correlation ID for tracing
   */
  async deleteSystem(systemId, correlationId) {
    this.logger.info({ correlationId, systemId }, 'Deleting system');

    const system = await this.getSystem(systemId, correlationId);
    if (!system) {
      throw new Error(`System not found: ${systemId}`);
    }

    // Remove system_id from all associated projects
    await this.queryDatabase(
      'UPDATE projects SET system_id = NULL, system_role = NULL WHERE system_id = ?',
      [systemId],
      false,
      correlationId
    );

    // Update in-memory cache for affected projects
    for (const project of this.projects.values()) {
      if (project.system_id === systemId) {
        project.system_id = null;
        project.system_role = null;
      }
    }

    // Delete the system
    await this.queryDatabase(
      'DELETE FROM systems WHERE id = ?',
      [systemId],
      false,
      correlationId
    );

    // Emit event
    await this.eventBus.publish('system.deleted', {
      system_id: systemId,
      name: system.name,
      affected_projects: system.projects.length,
      deleted_at: new Date().toISOString()
    });

    this.logger.info({ correlationId, systemId }, 'System deleted successfully');

    return { success: true, systemId, affectedProjects: system.projects.length };
  }

  /**
   * Add a project to a system
   * @param {string} systemId - System ID
   * @param {string} projectId - Project ID
   * @param {string} role - Role within the system (e.g., 'billing', 'purchasing', 'order-entry')
   * @param {string} correlationId - Correlation ID for tracing
   */
  async addProjectToSystem(systemId, projectId, role, correlationId) {
    this.logger.info({ correlationId, systemId, projectId, role }, 'Adding project to system');

    // Validate system exists
    const system = await this.getSystem(systemId, correlationId);
    if (!system) {
      throw new Error(`System not found: ${systemId}`);
    }

    // Validate project exists
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Check if project is already in a system
    if (project.system_id && project.system_id !== systemId) {
      throw new Error(`Project '${project.name}' is already in another system`);
    }

    const now = new Date().toISOString();

    await this.queryDatabase(
      'UPDATE projects SET system_id = ?, system_role = ?, updated_at = ? WHERE id = ?',
      [systemId, role || null, now, projectId],
      false,
      correlationId
    );

    // Update in-memory cache
    project.system_id = systemId;
    project.system_role = role || null;
    project.updated_at = now;

    // Emit event
    await this.eventBus.publish('project.joined_system', {
      project_id: projectId,
      project_name: project.name,
      system_id: systemId,
      system_name: system.name,
      role,
      joined_at: now
    });

    this.logger.info({ correlationId, systemId, projectId }, 'Project added to system successfully');

    return {
      projectId,
      projectName: project.name,
      systemId,
      systemName: system.name,
      role
    };
  }

  /**
   * Remove a project from its system
   * @param {string} projectId - Project ID
   * @param {string} correlationId - Correlation ID for tracing
   */
  async removeProjectFromSystem(projectId, correlationId) {
    this.logger.info({ correlationId, projectId }, 'Removing project from system');

    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (!project.system_id) {
      throw new Error(`Project '${project.name}' is not in any system`);
    }

    const previousSystemId = project.system_id;
    const previousRole = project.system_role;
    const now = new Date().toISOString();

    await this.queryDatabase(
      'UPDATE projects SET system_id = NULL, system_role = NULL, updated_at = ? WHERE id = ?',
      [now, projectId],
      false,
      correlationId
    );

    // Update in-memory cache
    project.system_id = null;
    project.system_role = null;
    project.updated_at = now;

    // Emit event
    await this.eventBus.publish('project.left_system', {
      project_id: projectId,
      project_name: project.name,
      system_id: previousSystemId,
      previous_role: previousRole,
      left_at: now
    });

    this.logger.info({ correlationId, projectId, previousSystemId }, 'Project removed from system successfully');

    return {
      projectId,
      projectName: project.name,
      previousSystemId,
      previousRole
    };
  }

  /**
   * Get projects not assigned to any system
   * @param {string} correlationId - Correlation ID for tracing
   */
  async getUnassignedProjects(correlationId) {
    this.logger.debug({ correlationId }, 'Getting unassigned projects');

    return Array.from(this.projects.values())
      .filter(p => !p.system_id)
      .map(p => ({
        id: p.id,
        name: p.name,
        description: p.description || '',
        metadata: p.metadata || {},
        createdAt: p.created_at,
        updatedAt: p.updated_at
      }));
  }

  // ==================== SHARED CONTEXT (PHASE 4) ====================

  /**
   * Import a conversation from one project to another (share context)
   * @param {string} toProjectId - Project receiving the context
   * @param {string} fromProjectId - Project sharing the context
   * @param {string} conversationId - Conversation ID to share
   * @param {string} reason - Reason for sharing
   * @param {string} correlationId - Correlation ID for tracing
   */
  async importContext(toProjectId, fromProjectId, conversationId, reason, correlationId) {
    this.logger.info({ correlationId, toProjectId, fromProjectId, conversationId }, 'Importing context');

    // Validate projects exist
    const toProject = this.projects.get(toProjectId);
    const fromProject = this.projects.get(fromProjectId);

    if (!toProject) {
      throw new Error(`Target project not found: ${toProjectId}`);
    }
    if (!fromProject) {
      throw new Error(`Source project not found: ${fromProjectId}`);
    }
    if (toProjectId === fromProjectId) {
      throw new Error('Cannot import context from same project');
    }

    // Check if already imported
    const existing = await this.queryDatabase(
      `SELECT id FROM shared_context
       WHERE to_project_id = ? AND from_project_id = ? AND conversation_id = ?`,
      [toProjectId, fromProjectId, conversationId],
      true,
      correlationId
    );

    if (existing.length > 0) {
      throw new Error('This conversation is already shared with this project');
    }

    const shareId = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.queryDatabase(`
      INSERT INTO shared_context (id, from_project_id, to_project_id, conversation_id, reason, imported_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [shareId, fromProjectId, toProjectId, conversationId, reason || null, now], false, correlationId);

    // Emit event
    await this.eventBus.publish('context.imported', {
      share_id: shareId,
      from_project_id: fromProjectId,
      from_project_name: fromProject.name,
      to_project_id: toProjectId,
      to_project_name: toProject.name,
      conversation_id: conversationId,
      reason,
      imported_at: now
    });

    this.logger.info({ correlationId, shareId, toProjectId, fromProjectId }, 'Context imported successfully');

    return {
      id: shareId,
      fromProjectId,
      fromProjectName: fromProject.name,
      toProjectId,
      toProjectName: toProject.name,
      conversationId,
      reason,
      importedAt: now
    };
  }

  /**
   * Remove shared context
   * @param {string} shareId - Shared context ID to remove
   * @param {string} correlationId - Correlation ID for tracing
   */
  async removeSharedContext(shareId, correlationId) {
    this.logger.info({ correlationId, shareId }, 'Removing shared context');

    // Get share info before deleting
    const shares = await this.queryDatabase(
      'SELECT * FROM shared_context WHERE id = ?',
      [shareId],
      true,
      correlationId
    );

    if (shares.length === 0) {
      throw new Error(`Shared context not found: ${shareId}`);
    }

    const share = shares[0];

    await this.queryDatabase(
      'DELETE FROM shared_context WHERE id = ?',
      [shareId],
      false,
      correlationId
    );

    // Emit event
    await this.eventBus.publish('context.removed', {
      share_id: shareId,
      from_project_id: share.from_project_id,
      to_project_id: share.to_project_id,
      conversation_id: share.conversation_id,
      removed_at: new Date().toISOString()
    });

    this.logger.info({ correlationId, shareId }, 'Shared context removed successfully');

    return { success: true, shareId };
  }

  /**
   * Get all shared context for a project (imported from other projects)
   * @param {string} projectId - Project ID
   * @param {string} correlationId - Correlation ID for tracing
   */
  async getSharedContext(projectId, correlationId) {
    this.logger.debug({ correlationId, projectId }, 'Getting shared context');

    const shares = await this.queryDatabase(`
      SELECT
        sc.*,
        p.name as from_project_name,
        p.description as from_project_description
      FROM shared_context sc
      LEFT JOIN projects p ON sc.from_project_id = p.id
      WHERE sc.to_project_id = ?
      ORDER BY sc.imported_at DESC
    `, [projectId], true, correlationId);

    return shares.map(share => ({
      id: share.id,
      fromProjectId: share.from_project_id,
      fromProjectName: share.from_project_name,
      fromProjectDescription: share.from_project_description,
      toProjectId: share.to_project_id,
      conversationId: share.conversation_id,
      reason: share.reason,
      importedAt: share.imported_at
    }));
  }

  /**
   * Get context that this project has shared with others
   * @param {string} projectId - Project ID
   * @param {string} correlationId - Correlation ID for tracing
   */
  async getExportedContext(projectId, correlationId) {
    this.logger.debug({ correlationId, projectId }, 'Getting exported context');

    const shares = await this.queryDatabase(`
      SELECT
        sc.*,
        p.name as to_project_name,
        p.description as to_project_description
      FROM shared_context sc
      LEFT JOIN projects p ON sc.to_project_id = p.id
      WHERE sc.from_project_id = ?
      ORDER BY sc.imported_at DESC
    `, [projectId], true, correlationId);

    return shares.map(share => ({
      id: share.id,
      fromProjectId: share.from_project_id,
      toProjectId: share.to_project_id,
      toProjectName: share.to_project_name,
      toProjectDescription: share.to_project_description,
      conversationId: share.conversation_id,
      reason: share.reason,
      importedAt: share.imported_at
    }));
  }

  /**
   * Get available context for a project (own + from related projects via links/dependencies)
   * This is used to show what conversations CAN be imported
   * @param {string} projectId - Project ID
   * @param {string} correlationId - Correlation ID for tracing
   */
  async getAvailableContextSources(projectId, correlationId) {
    this.logger.debug({ correlationId, projectId }, 'Getting available context sources');

    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Get related projects (via links)
    const relatedProjects = await this.getRelatedProjects(projectId, correlationId);

    // Get dependencies (projects this one depends on)
    const dependencies = await this.getDependencies(projectId, correlationId);

    // Get projects in the same system
    let systemProjects = [];
    if (project.system_id) {
      const system = await this.getSystem(project.system_id, correlationId);
      if (system) {
        systemProjects = system.projects
          .filter(p => p.id !== projectId)
          .map(p => ({
            id: p.id,
            name: p.name,
            description: p.description,
            role: p.role,
            source: 'system',
            systemName: system.name
          }));
      }
    }

    // Get already imported context
    const alreadyImported = await this.getSharedContext(projectId, correlationId);
    const importedMap = new Map(alreadyImported.map(s => [s.fromProjectId, s]));

    // Combine sources (avoid duplicates)
    const sourceMap = new Map();

    // Add related projects
    for (const rel of relatedProjects) {
      if (!sourceMap.has(rel.id)) {
        sourceMap.set(rel.id, {
          id: rel.id,
          name: rel.name,
          description: rel.description,
          source: 'link',
          linkType: rel.links?.[0]?.linkType,
          hasImportedContext: importedMap.has(rel.id)
        });
      }
    }

    // Add dependencies
    for (const dep of dependencies) {
      if (!sourceMap.has(dep.dependsOnProjectId)) {
        sourceMap.set(dep.dependsOnProjectId, {
          id: dep.dependsOnProjectId,
          name: dep.dependsOnProjectName,
          description: dep.dependsOnProjectDescription,
          source: 'dependency',
          dependencyType: dep.dependencyType,
          hasImportedContext: importedMap.has(dep.dependsOnProjectId)
        });
      }
    }

    // Add system projects
    for (const sp of systemProjects) {
      if (!sourceMap.has(sp.id)) {
        sourceMap.set(sp.id, {
          ...sp,
          hasImportedContext: importedMap.has(sp.id)
        });
      }
    }

    return {
      projectId,
      projectName: project.name,
      sources: Array.from(sourceMap.values()),
      importedCount: alreadyImported.length
    };
  }

  /**
   * Get full context for a project (for AI/agent use)
   * Returns own context + inherited context from shared sources
   * @param {string} projectId - Project ID
   * @param {string} correlationId - Correlation ID for tracing
   */
  async getFullProjectContext(projectId, correlationId) {
    this.logger.debug({ correlationId, projectId }, 'Getting full project context');

    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Get shared context (imported from other projects)
    const sharedContext = await this.getSharedContext(projectId, correlationId);

    // Get dependencies
    const dependencies = await this.getDependencies(projectId, correlationId);

    // Get system info if applicable
    let systemInfo = null;
    if (project.system_id) {
      const system = await this.getSystem(project.system_id, correlationId);
      if (system) {
        systemInfo = {
          id: system.id,
          name: system.name,
          description: system.description,
          role: project.system_role,
          siblingProjects: system.projects
            .filter(p => p.id !== projectId)
            .map(p => ({ id: p.id, name: p.name, role: p.role }))
        };
      }
    }

    // Get related projects
    const relatedProjects = await this.getRelatedProjects(projectId, correlationId);

    return {
      project: {
        id: project.id,
        name: project.name,
        description: project.description
      },
      system: systemInfo,
      dependencies: dependencies.map(d => ({
        projectId: d.dependsOnProjectId,
        projectName: d.dependsOnProjectName,
        type: d.dependencyType,
        description: d.description
      })),
      relatedProjects: relatedProjects.map(r => ({
        id: r.id,
        name: r.name,
        links: r.links
      })),
      sharedContext: sharedContext.map(s => ({
        fromProject: s.fromProjectName,
        conversationId: s.conversationId,
        reason: s.reason
      })),
      inheritedContextCount: sharedContext.length
    };
  }

  // ==================== EVENT HANDLERS ====================

  /**
   * Handle project.get.request
   */
  async onGetProjectRequest(event) {
    // Handle wrapped event format: event.data contains the actual payload
    const eventData = event.data || event;
    const { request_id, project_id, correlation_id } = eventData;
    this.logger.debug({ correlationId: correlation_id, requestId: request_id, projectId: project_id },
      'Received project.get.request');

    const project = this.getProject(project_id);

    await this.eventBus.publish(EVENTS.PROJECT.GET_RESPONSE, {
      request_id,
      success: !!project,
      project: project || null,
      error: project ? null : 'Project not found'
    });
  }

  /**
   * Handle project.list.request
   */
  async onListProjectsRequest(event) {
    // Handle wrapped event format: event.data contains the actual payload
    const eventData = event.data || event;
    const { request_id, correlation_id } = eventData;
    this.logger.debug({ correlationId: correlation_id, requestId: request_id },
      'Received project.list.request');

    const projects = this.listProjects();

    await this.eventBus.publish(EVENTS.PROJECT.LIST_RESPONSE, {
      request_id,
      success: true,
      projects,
      count: projects.length,
      active_project_id: this.activeProjectId
    });
  }

  /**
   * Handle project.active.request
   */
  async onGetActiveProjectRequest(event) {
    // Handle wrapped event format: event.data contains the actual payload
    const eventData = event.data || event;
    const { request_id, correlation_id } = eventData;
    this.logger.debug({ correlationId: correlation_id, requestId: request_id },
      'Received project.active.request');

    await this.eventBus.publish('project.active.response', {
      request_id,
      success: true,
      active_project_id: this.activeProjectId
    });
  }

  /**
   * Handle context.full.request (Phase 5)
   * Returns full project context for prompt-composer inherited context
   */
  async onContextFullRequest(event) {
    const eventData = event.data || event;
    const { request_id, project_id, correlation_id } = eventData;

    this.logger.debug({ correlationId: correlation_id, requestId: request_id, projectId: project_id },
      'Received context.full.request');

    try {
      const fullContext = await this.getFullProjectContext(project_id, correlation_id || crypto.randomUUID());

      await this.eventBus.publish('context.full.response', {
        request_id,
        success: true,
        context: fullContext,
        correlation_id
      });
    } catch (error) {
      this.logger.warn({ correlationId: correlation_id, error: error.message },
        'Failed to get full project context');

      await this.eventBus.publish('context.full.response', {
        request_id,
        success: false,
        context: null,
        error: error.message,
        correlation_id
      });
    }
  }

  // ==================== UI EVENT HANDLERS (via EventBus) ====================
  // Comunicación frontend ↔ backend via eventBus
  // EventBus transforma topics: 'project.state' → 'core/*/events/project/state'

  /**
   * Publica estado completo para UI via eventBus
   * EventBus transforma 'project.state' → 'core/{coreId}/events/project/state'
   * Frontend suscribe a 'core/{coreId}/events/project/state'
   * @private
   */
  async publishUIState() {
    const projects = this.listProjects().map(p => ({
      id: p.id,
      name: p.name,
      description: p.description || '',
      color: p.metadata?.color || 'blue',
      icon: p.metadata?.icon || '📁',
      workspaceType: p.metadata?.workspaceType || 'general',
      isActive: p.is_active === true || p.is_active === 1,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      // Composition fields (Fase 0)
      systemId: p.system_id || null,
      systemRole: p.system_role || null,
      parentProjectId: p.parent_project_id || null
    }));

    const state = {
      projects,
      activeProjectId: this.activeProjectId,
      count: projects.length
    };

    // Publicar via eventBus → MQTT topic: core/*/events/project/state
    await this.eventBus.emit('project/state', state);
    this.logger.debug('project-manager.state.published', { count: projects.length });
  }

  /**
   * Handle project/state/request - UI solicita estado
   */
  async onProjectStateRequest(event) {
    this.logger.debug('MQTT: project/state/request received');
    await this.publishUIState();
  }

  /**
   * Handle project/create - UI crea proyecto
   */
  async onProjectCreate(event) {
    const eventData = event.data || event;
    const { name, description, color, icon, workspaceType } = eventData;
    const correlationId = crypto.randomUUID();

    this.logger.info({ correlationId, name }, 'MQTT: project/create');

    if (!name || name.trim().length === 0) {
      this.logger.warn({ correlationId }, 'MQTT: project/create - name required');
      return;
    }

    try {
      await this.createProject(
        name.trim(),
        description?.trim() || '',
        {
          color: color || 'blue',
          icon: icon || '📁',
          workspaceType: workspaceType || 'general'
        },
        correlationId
      );

      // Publicar estado actualizado
      await this.publishUIState();
    } catch (error) {
      this.logger.error({ correlationId, error: error.message }, 'MQTT: project/create failed');
    }
  }

  /**
   * Handle project/update - UI actualiza proyecto
   */
  async onProjectUpdate(event) {
    const eventData = event.data || event;
    const { id, name, description, color, icon, workspaceType } = eventData;
    const correlationId = crypto.randomUUID();

    this.logger.info({ correlationId, id }, 'MQTT: project/update');

    if (!id) {
      this.logger.warn({ correlationId }, 'MQTT: project/update - id required');
      return;
    }

    try {
      const updates = {};
      if (name !== undefined) updates.name = name.trim();
      if (description !== undefined) updates.description = description.trim();

      // Metadata updates
      const project = this.getProject(id);
      if (project) {
        const metadata = { ...(project.metadata || {}) };
        if (color !== undefined) metadata.color = color;
        if (icon !== undefined) metadata.icon = icon;
        if (workspaceType !== undefined) metadata.workspaceType = workspaceType;
        updates.metadata = metadata;
      }

      await this.updateProject(id, updates, correlationId);

      // Publicar estado actualizado
      await this.publishUIState();
    } catch (error) {
      this.logger.error({ correlationId, id, error: error.message }, 'MQTT: project/update failed');
    }
  }

  /**
   * Handle project/delete - UI elimina proyecto
   */
  async onProjectDelete(event) {
    const eventData = event.data || event;
    const { id } = eventData;
    const correlationId = crypto.randomUUID();

    this.logger.info({ correlationId, id }, 'MQTT: project/delete');

    if (!id) {
      this.logger.warn({ correlationId }, 'MQTT: project/delete - id required');
      return;
    }

    try {
      await this.deleteProject(id, correlationId);

      // Publicar estado actualizado
      await this.publishUIState();
    } catch (error) {
      this.logger.error({ correlationId, id, error: error.message }, 'MQTT: project/delete failed');
    }
  }

  /**
   * Handle project/activate - UI activa proyecto
   */
  async onProjectActivate(event) {
    const eventData = event.data || event;
    const { id } = eventData;
    const correlationId = crypto.randomUUID();

    this.logger.info({ correlationId, id }, 'MQTT: project/activate');

    if (!id) {
      this.logger.warn({ correlationId }, 'MQTT: project/activate - id required');
      return;
    }

    try {
      await this.activateProject(id, correlationId);

      // Publicar estado actualizado
      await this.publishUIState();
    } catch (error) {
      this.logger.error({ correlationId, id, error: error.message }, 'MQTT: project/activate failed');
    }
  }

  // ==================== UI REQUEST/RESPONSE HANDLERS ====================
  // Patrón Request/Response sobre MQTT
  // Frontend usa: await mqttRequest('project', 'list')
  // Retornan datos directamente, errores via throw { status, code, message }

  /**
   * UI Handler: Listar proyectos
   * Request: mqttRequest('project', 'list')
   */
  async handleUIList(data, request) {
    const projects = this.listProjects().map(p => ({
      id: p.id,
      name: p.name,
      description: p.description || '',
      color: p.metadata?.color || 'blue',
      icon: p.metadata?.icon || '📁',
      workspaceType: p.metadata?.workspaceType || 'general',
      isActive: p.is_active === true || p.is_active === 1,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      // Composition fields (Fase 0)
      systemId: p.system_id || null,
      systemRole: p.system_role || null,
      parentProjectId: p.parent_project_id || null
    }));

    return {
      projects,
      activeProjectId: this.activeProjectId,
      count: projects.length
    };
  }

  /**
   * UI Handler: Obtener proyecto por ID
   * Request: mqttRequest('project', 'get', { id: '...' })
   */
  async handleUIGet(data, request) {
    const { id } = data;

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    const project = this.getProject(id);
    if (!project) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    }

    return {
      project: {
        id: project.id,
        name: project.name,
        description: project.description || '',
        color: project.metadata?.color || 'blue',
        icon: project.metadata?.icon || '📁',
        workspaceType: project.metadata?.workspaceType || 'general',
        isActive: project.is_active === true || project.is_active === 1,
        createdAt: project.created_at,
        updatedAt: project.updated_at,
        // Composition fields (Fase 0)
        systemId: project.system_id || null,
        systemRole: project.system_role || null,
        parentProjectId: project.parent_project_id || null
      }
    };
  }

  /**
   * UI Handler: Crear proyecto
   * Request: mqttRequest('project', 'create', { name, description, color, icon, workspaceType })
   */
  async handleUICreate(data, request) {
    const { name, description, color, icon, workspaceType } = data;
    const correlationId = crypto.randomUUID();

    if (!name || name.trim().length === 0) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project name is required' };
    }

    const project = await this.createProject(
      name.trim(),
      description?.trim() || '',
      {
        color: color || 'blue',
        icon: icon || '📁',
        workspaceType: workspaceType || 'general'
      },
      correlationId
    );

    return {
      project: {
        id: project.id,
        name: project.name,
        description: project.description || '',
        color: project.metadata?.color || 'blue',
        icon: project.metadata?.icon || '📁',
        workspaceType: project.metadata?.workspaceType || 'general',
        isActive: project.is_active === true || project.is_active === 1,
        createdAt: project.created_at,
        updatedAt: project.updated_at,
        // Composition fields (Fase 0)
        systemId: project.system_id || null,
        systemRole: project.system_role || null,
        parentProjectId: project.parent_project_id || null
      },
      created: true
    };
  }

  /**
   * UI Handler: Actualizar proyecto
   * Request: mqttRequest('project', 'update', { id, name?, description?, color?, icon?, workspaceType? })
   */
  async handleUIUpdate(data, request) {
    const { id, name, description, color, icon, workspaceType } = data;
    const correlationId = crypto.randomUUID();

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    const existing = this.getProject(id);
    if (!existing) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    }

    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (description !== undefined) updates.description = description.trim();

    // Metadata updates
    const metadata = { ...(existing.metadata || {}) };
    if (color !== undefined) metadata.color = color;
    if (icon !== undefined) metadata.icon = icon;
    if (workspaceType !== undefined) metadata.workspaceType = workspaceType;
    updates.metadata = metadata;

    const project = await this.updateProject(id, updates, correlationId);

    return {
      project: {
        id: project.id,
        name: project.name,
        description: project.description || '',
        color: project.metadata?.color || 'blue',
        icon: project.metadata?.icon || '📁',
        workspaceType: project.metadata?.workspaceType || 'general',
        isActive: project.is_active === true || project.is_active === 1,
        createdAt: project.created_at,
        updatedAt: project.updated_at,
        // Composition fields (Fase 0)
        systemId: project.system_id || null,
        systemRole: project.system_role || null,
        parentProjectId: project.parent_project_id || null
      },
      updated: true
    };
  }

  /**
   * UI Handler: Eliminar proyecto
   * Request: mqttRequest('project', 'delete', { id, force? })
   */
  async handleUIDelete(data, request) {
    const { id, force } = data;
    const correlationId = crypto.randomUUID();

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    const existing = this.getProject(id);
    if (!existing) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    }

    try {
      await this.deleteProject(id, correlationId, { force: !!force });
      return { deleted: true, id };
    } catch (error) {
      if (error.code === 'HAS_DEPENDENTS') {
        throw { status: 409, code: 'HAS_DEPENDENTS', message: error.message, dependents: error.dependents };
      }
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Activar proyecto
   * Request: mqttRequest('project', 'activate', { id })
   */
  async handleUIActivate(data, request) {
    const { id } = data;
    const correlationId = crypto.randomUUID();

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    const existing = this.getProject(id);
    if (!existing) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    }

    await this.activateProject(id, correlationId);

    return {
      activated: true,
      activeProjectId: id
    };
  }

  // ==================== UI COMPOSITION HANDLERS (Phase 1) ====================

  /**
   * UI Handler: Link two projects
   * Request: mqttRequest('project', 'link', { sourceId, targetId, linkType, reason })
   */
  async handleUILink(data, request) {
    const { sourceId, targetId, linkType, reason } = data;
    const correlationId = crypto.randomUUID();

    if (!sourceId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Source project ID is required' };
    }
    if (!targetId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Target project ID is required' };
    }
    if (!linkType) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Link type is required (inspired_by, related_to, evolved_from)' };
    }

    const validTypes = ['inspired_by', 'related_to', 'evolved_from'];
    if (!validTypes.includes(linkType)) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: `Invalid link type. Must be one of: ${validTypes.join(', ')}` };
    }

    try {
      const link = await this.linkProjects(sourceId, targetId, linkType, reason, correlationId);
      return { linked: true, link };
    } catch (error) {
      if (error.message.includes('not found')) {
        throw { status: 404, code: 'NOT_FOUND', message: error.message };
      }
      if (error.message.includes('already exists')) {
        throw { status: 409, code: 'CONFLICT', message: error.message };
      }
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Unlink projects
   * Request: mqttRequest('project', 'unlink', { linkId })
   */
  async handleUIUnlink(data, request) {
    const { linkId } = data;
    const correlationId = crypto.randomUUID();

    if (!linkId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Link ID is required' };
    }

    try {
      await this.unlinkProjects(linkId, correlationId);
      return { unlinked: true, linkId };
    } catch (error) {
      if (error.message.includes('not found')) {
        throw { status: 404, code: 'NOT_FOUND', message: error.message };
      }
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Get all links for a project
   * Request: mqttRequest('project', 'getLinks', { id })
   */
  async handleUIGetLinks(data, request) {
    const { id } = data;
    const correlationId = crypto.randomUUID();

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    const project = this.getProject(id);
    if (!project) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    }

    const links = await this.getProjectLinks(id, correlationId);
    return { projectId: id, links, count: links.length };
  }

  /**
   * UI Handler: Get related projects
   * Request: mqttRequest('project', 'getRelated', { id })
   */
  async handleUIGetRelated(data, request) {
    const { id } = data;
    const correlationId = crypto.randomUUID();

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    const project = this.getProject(id);
    if (!project) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    }

    const relatedProjects = await this.getRelatedProjects(id, correlationId);
    return { projectId: id, relatedProjects, count: relatedProjects.length };
  }

  // ==================== UI DEPENDENCY HANDLERS (Phase 2) ====================

  /**
   * UI Handler: Add dependency between projects
   * Request: mqttRequest('project', 'addDependency', { projectId, dependsOnProjectId, dependencyType, description })
   */
  async handleUIAddDependency(data, request) {
    const { projectId, dependsOnProjectId, dependencyType, description } = data;
    const correlationId = crypto.randomUUID();

    if (!projectId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }
    if (!dependsOnProjectId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Depends on project ID is required' };
    }

    const validTypes = ['data', 'code', 'api', 'context'];
    if (dependencyType && !validTypes.includes(dependencyType)) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: `Invalid dependency type. Must be one of: ${validTypes.join(', ')}` };
    }

    try {
      const dependency = await this.addDependency(projectId, dependsOnProjectId, dependencyType, description, correlationId);
      return { added: true, dependency };
    } catch (error) {
      if (error.message.includes('not found')) {
        throw { status: 404, code: 'NOT_FOUND', message: error.message };
      }
      if (error.message.includes('already exists')) {
        throw { status: 409, code: 'CONFLICT', message: error.message };
      }
      if (error.message.includes('cannot depend on itself')) {
        throw { status: 400, code: 'VALIDATION_ERROR', message: error.message };
      }
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Remove dependency
   * Request: mqttRequest('project', 'removeDependency', { dependencyId })
   */
  async handleUIRemoveDependency(data, request) {
    const { dependencyId } = data;
    const correlationId = crypto.randomUUID();

    if (!dependencyId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Dependency ID is required' };
    }

    try {
      await this.removeDependency(dependencyId, correlationId);
      return { removed: true, dependencyId };
    } catch (error) {
      if (error.message.includes('not found')) {
        throw { status: 404, code: 'NOT_FOUND', message: error.message };
      }
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Get all dependencies of a project
   * Request: mqttRequest('project', 'getDependencies', { id })
   */
  async handleUIGetDependencies(data, request) {
    const { id } = data;
    const correlationId = crypto.randomUUID();

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    const project = this.getProject(id);
    if (!project) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    }

    const dependencies = await this.getDependencies(id, correlationId);
    return { projectId: id, dependencies, count: dependencies.length };
  }

  /**
   * UI Handler: Get all dependents of a project (projects that depend on this one)
   * Request: mqttRequest('project', 'getDependents', { id })
   */
  async handleUIGetDependents(data, request) {
    const { id } = data;
    const correlationId = crypto.randomUUID();

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    const project = this.getProject(id);
    if (!project) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    }

    const dependents = await this.getDependents(id, correlationId);
    return { projectId: id, dependents, count: dependents.length };
  }

  // ==================== UI EVENT SUBSCRIPTION HANDLERS ====================

  /**
   * UI Handler: Add an event subscription to a project
   * @param {Object} data - { id, event, filter?, action, config? }
   */
  async handleUIAddSubscription(data, request) {
    const { id, event, filter, action, config } = data;
    const correlationId = crypto.randomUUID();

    if (!id || !event || !action) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'id, event, and action are required' };
    }

    const project = this.getProject(id);
    if (!project) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    }

    // Validate action
    const validActions = ['save_file', 'send_message', 'publish_event'];
    if (!validActions.includes(action)) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: `Invalid action. Must be one of: ${validActions.join(', ')}` };
    }

    // Build subscription
    const subscription = {
      id: crypto.randomUUID(),
      event,
      action,
      filter: filter || null,
      config: config || {},
      created_at: new Date().toISOString()
    };

    // Add to project
    const subscriptions = project.event_subscriptions || [];
    subscriptions.push(subscription);

    // Persist to database
    await this.queryDatabase(
      'UPDATE projects SET event_subscriptions = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(subscriptions), new Date().toISOString(), id],
      false,
      correlationId
    );

    // Update cache
    project.event_subscriptions = subscriptions;
    this.projects.set(id, project);

    // If this is the active project, subscribe immediately
    if (this.activeProjectId === id) {
      const handler = this.createSubscriptionHandler(project, subscription, correlationId);
      const unsub = await this.eventBus.subscribe(subscription.event, handler);
      this.activeProjectSubscriptions.push(unsub);
    }

    this.logger.info({ correlationId, projectId: id, event, action }, 'Event subscription added');

    return { subscription, total: subscriptions.length };
  }

  /**
   * UI Handler: Remove an event subscription from a project
   * @param {Object} data - { id, subscriptionId }
   */
  async handleUIRemoveSubscription(data, request) {
    const { id, subscriptionId } = data;
    const correlationId = crypto.randomUUID();

    if (!id || !subscriptionId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'id and subscriptionId are required' };
    }

    const project = this.getProject(id);
    if (!project) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    }

    const subscriptions = project.event_subscriptions || [];
    const index = subscriptions.findIndex(s => s.id === subscriptionId);

    if (index === -1) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Subscription not found' };
    }

    const removed = subscriptions.splice(index, 1)[0];

    // Persist to database
    await this.queryDatabase(
      'UPDATE projects SET event_subscriptions = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(subscriptions), new Date().toISOString(), id],
      false,
      correlationId
    );

    // Update cache
    project.event_subscriptions = subscriptions;
    this.projects.set(id, project);

    // Note: Active subscriptions will be refreshed on next activation
    // For immediate effect, user should deactivate and reactivate the project

    this.logger.info({ correlationId, projectId: id, subscriptionId }, 'Event subscription removed');

    return { removed, remaining: subscriptions.length };
  }

  /**
   * UI Handler: Get all event subscriptions for a project
   * @param {Object} data - { id }
   */
  async handleUIGetSubscriptions(data, request) {
    const { id } = data;

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    const project = this.getProject(id);
    if (!project) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    }

    const subscriptions = project.event_subscriptions || [];
    const isActive = this.activeProjectId === id;

    return {
      projectId: id,
      subscriptions,
      count: subscriptions.length,
      active: isActive,
      activeSubscriptionCount: isActive ? this.activeProjectSubscriptions.length : 0
    };
  }

  // ==================== UI SYSTEM HANDLERS (Phase 3) ====================

  /**
   * UI Handler: Create a new system
   * Request: mqttRequest('system', 'create', { name, description?, metadata? })
   */
  async handleUISystemCreate(data, request) {
    const { name, description, metadata } = data;
    const correlationId = crypto.randomUUID();

    if (!name || name.trim().length === 0) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'System name is required' };
    }

    try {
      const system = await this.createSystem(name, description, metadata, correlationId);
      return { created: true, system };
    } catch (error) {
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: List all systems
   * Request: mqttRequest('system', 'list')
   */
  async handleUISystemList(data, request) {
    const correlationId = crypto.randomUUID();

    try {
      const systems = await this.listSystems(correlationId);
      return { systems, count: systems.length };
    } catch (error) {
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Get a system by ID with projects
   * Request: mqttRequest('system', 'get', { id })
   */
  async handleUISystemGet(data, request) {
    const { id } = data;
    const correlationId = crypto.randomUUID();

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'System ID is required' };
    }

    try {
      const system = await this.getSystem(id, correlationId);
      if (!system) {
        throw { status: 404, code: 'NOT_FOUND', message: 'System not found' };
      }
      return { system };
    } catch (error) {
      if (error.status) throw error;
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Update a system
   * Request: mqttRequest('system', 'update', { id, name?, description?, metadata? })
   */
  async handleUISystemUpdate(data, request) {
    const { id, name, description, metadata } = data;
    const correlationId = crypto.randomUUID();

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'System ID is required' };
    }

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (metadata !== undefined) updates.metadata = metadata;

    try {
      const system = await this.updateSystem(id, updates, correlationId);
      return { updated: true, system };
    } catch (error) {
      if (error.message.includes('not found')) {
        throw { status: 404, code: 'NOT_FOUND', message: error.message };
      }
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Delete a system
   * Request: mqttRequest('system', 'delete', { id })
   */
  async handleUISystemDelete(data, request) {
    const { id } = data;
    const correlationId = crypto.randomUUID();

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'System ID is required' };
    }

    try {
      const result = await this.deleteSystem(id, correlationId);
      return { deleted: true, ...result };
    } catch (error) {
      if (error.message.includes('not found')) {
        throw { status: 404, code: 'NOT_FOUND', message: error.message };
      }
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Add a project to a system
   * Request: mqttRequest('system', 'addProject', { systemId, projectId, role? })
   */
  async handleUISystemAddProject(data, request) {
    const { systemId, projectId, role } = data;
    const correlationId = crypto.randomUUID();

    if (!systemId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'System ID is required' };
    }
    if (!projectId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    try {
      const result = await this.addProjectToSystem(systemId, projectId, role, correlationId);
      return { added: true, ...result };
    } catch (error) {
      if (error.message.includes('not found')) {
        throw { status: 404, code: 'NOT_FOUND', message: error.message };
      }
      if (error.message.includes('already in another system')) {
        throw { status: 409, code: 'CONFLICT', message: error.message };
      }
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Remove a project from its system
   * Request: mqttRequest('system', 'removeProject', { projectId })
   */
  async handleUISystemRemoveProject(data, request) {
    const { projectId } = data;
    const correlationId = crypto.randomUUID();

    if (!projectId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    try {
      const result = await this.removeProjectFromSystem(projectId, correlationId);
      return { removed: true, ...result };
    } catch (error) {
      if (error.message.includes('not found')) {
        throw { status: 404, code: 'NOT_FOUND', message: error.message };
      }
      if (error.message.includes('not in any system')) {
        throw { status: 400, code: 'VALIDATION_ERROR', message: error.message };
      }
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Get projects not assigned to any system
   * Request: mqttRequest('system', 'getUnassigned')
   */
  async handleUISystemGetUnassigned(data, request) {
    const correlationId = crypto.randomUUID();

    try {
      const projects = await this.getUnassignedProjects(correlationId);
      return { projects, count: projects.length };
    } catch (error) {
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  // ==================== UI CONTEXT HANDLERS (Phase 4) ====================

  /**
   * UI Handler: Import context (share conversation from another project)
   * Request: mqttRequest('context', 'import', { toProjectId, fromProjectId, conversationId, reason? })
   */
  async handleUIContextImport(data, request) {
    const { toProjectId, fromProjectId, conversationId, reason } = data;
    const correlationId = crypto.randomUUID();

    if (!toProjectId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Target project ID is required' };
    }
    if (!fromProjectId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Source project ID is required' };
    }
    if (!conversationId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Conversation ID is required' };
    }

    try {
      const result = await this.importContext(toProjectId, fromProjectId, conversationId, reason, correlationId);
      return { imported: true, ...result };
    } catch (error) {
      if (error.message.includes('not found')) {
        throw { status: 404, code: 'NOT_FOUND', message: error.message };
      }
      if (error.message.includes('already shared')) {
        throw { status: 409, code: 'CONFLICT', message: error.message };
      }
      if (error.message.includes('same project')) {
        throw { status: 400, code: 'VALIDATION_ERROR', message: error.message };
      }
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Remove shared context
   * Request: mqttRequest('context', 'remove', { shareId })
   */
  async handleUIContextRemove(data, request) {
    const { shareId } = data;
    const correlationId = crypto.randomUUID();

    if (!shareId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Share ID is required' };
    }

    try {
      await this.removeSharedContext(shareId, correlationId);
      return { removed: true, shareId };
    } catch (error) {
      if (error.message.includes('not found')) {
        throw { status: 404, code: 'NOT_FOUND', message: error.message };
      }
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Get shared context for a project (imported from others)
   * Request: mqttRequest('context', 'getShared', { projectId })
   */
  async handleUIContextGetShared(data, request) {
    const { projectId } = data;
    const correlationId = crypto.randomUUID();

    if (!projectId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    const project = this.getProject(projectId);
    if (!project) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    }

    try {
      const sharedContext = await this.getSharedContext(projectId, correlationId);
      return { projectId, sharedContext, count: sharedContext.length };
    } catch (error) {
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Get exported context (shared to other projects)
   * Request: mqttRequest('context', 'getExported', { projectId })
   */
  async handleUIContextGetExported(data, request) {
    const { projectId } = data;
    const correlationId = crypto.randomUUID();

    if (!projectId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    const project = this.getProject(projectId);
    if (!project) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    }

    try {
      const exportedContext = await this.getExportedContext(projectId, correlationId);
      return { projectId, exportedContext, count: exportedContext.length };
    } catch (error) {
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Get available context sources (related projects that can share context)
   * Request: mqttRequest('context', 'getSources', { projectId })
   */
  async handleUIContextGetSources(data, request) {
    const { projectId } = data;
    const correlationId = crypto.randomUUID();

    if (!projectId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    try {
      const result = await this.getAvailableContextSources(projectId, correlationId);
      return result;
    } catch (error) {
      if (error.message.includes('not found')) {
        throw { status: 404, code: 'NOT_FOUND', message: error.message };
      }
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  /**
   * UI Handler: Get full project context (for AI/agent use)
   * Request: mqttRequest('context', 'getFull', { projectId })
   */
  async handleUIContextGetFull(data, request) {
    const { projectId } = data;
    const correlationId = crypto.randomUUID();

    if (!projectId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    try {
      const fullContext = await this.getFullProjectContext(projectId, correlationId);
      return fullContext;
    } catch (error) {
      if (error.message.includes('not found')) {
        throw { status: 404, code: 'NOT_FOUND', message: error.message };
      }
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  // ==================== UI SESSION & AI CONFIG HANDLERS ====================

  /**
   * UI Handler: Save session state
   * Request: mqttRequest('project', 'saveSession', { id, scroll_position, context_config, ui_state })
   */
  async handleUISaveSession(data, request) {
    const { id, ...sessionData } = data;
    const correlationId = crypto.randomUUID();

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    const existing = this.getProject(id);
    if (!existing) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    }

    const session = await this.saveSession(id, sessionData, correlationId);

    return { saved: true, session };
  }

  /**
   * UI Handler: Restore session state
   * Request: mqttRequest('project', 'restoreSession', { id })
   */
  async handleUIRestoreSession(data, request) {
    const { id } = data;
    const correlationId = crypto.randomUUID();

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    const existing = this.getProject(id);
    if (!existing) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    }

    const session = await this.restoreSession(id, correlationId);

    return session;
  }

  /**
   * UI Handler: Set AI configuration
   * Request: mqttRequest('project', 'setAIConfig', { id, provider?, model?, prompt_id? })
   */
  async handleUISetAIConfig(data, request) {
    const { id, provider, model, prompt_id } = data;
    const correlationId = crypto.randomUUID();

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    const existing = this.getProject(id);
    if (!existing) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    }

    const config = await this.setProjectAIConfig(id, { provider, model, prompt_id }, correlationId);

    return { updated: true, ...config };
  }

  /**
   * UI Handler: Set last conversation
   * Request: mqttRequest('project', 'setLastConversation', { id, conversationId })
   */
  async handleUISetLastConversation(data, request) {
    const { id, conversationId } = data;
    const correlationId = crypto.randomUUID();

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    }

    if (!conversationId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Conversation ID is required' };
    }

    const existing = this.getProject(id);
    if (!existing) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    }

    await this.setLastConversation(id, conversationId, correlationId);

    return { updated: true, lastConversationId: conversationId };
  }

  // ==================== HTTP API HANDLERS ====================
  // Handlers use new gateway API style: return { status, data } instead of res.json()

  async handleCreateProject(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    const { name, description, metadata } = req.body || {};

    this.logger.info({ correlationId, name }, 'HTTP: Create project');

    if (!name || name.trim().length === 0) {
      return { status: 400, data: { success: false, error: 'Project name is required' } };
    }

    try {
      const project = await this.createProject(name, description, metadata, correlationId);
      return { status: 201, data: { success: true, project } };
    } catch (error) {
      this.logger.error({ correlationId, error: error.message }, 'HTTP: Failed to create project');
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleListProjects(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    this.logger.debug({ correlationId }, 'HTTP: List projects');

    try {
      const projects = this.listProjects();
      return {
        status: 200,
        data: {
          success: true,
          projects,
          count: projects.length,
          active_project_id: this.activeProjectId
        }
      };
    } catch (error) {
      this.logger.error({ correlationId, error: error.message }, 'HTTP: Failed to list projects');
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleGetProject(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    const { id } = req.params || {};

    this.logger.debug({ correlationId, projectId: id }, 'HTTP: Get project');

    try {
      const project = this.getProject(id);
      if (!project) {
        return { status: 404, data: { success: false, error: 'Project not found' } };
      }
      return { status: 200, data: { success: true, project } };
    } catch (error) {
      this.logger.error({ correlationId, projectId: id, error: error.message }, 'HTTP: Failed to get project');
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleUpdateProject(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    const { id } = req.params || {};
    const updates = req.body || {};

    this.logger.info({ correlationId, projectId: id, updates }, 'HTTP: Update project');

    try {
      const project = await this.updateProject(id, updates, correlationId);
      return { status: 200, data: { success: true, project } };
    } catch (error) {
      this.logger.error({ correlationId, projectId: id, error: error.message }, 'HTTP: Failed to update project');

      if (error.message.includes('not found')) {
        return { status: 404, data: { success: false, error: error.message } };
      }
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleDeleteProject(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    const { id } = req.params || {};

    this.logger.info({ correlationId, projectId: id }, 'HTTP: Delete project');

    try {
      const result = await this.deleteProject(id, correlationId);
      return { status: 200, data: { success: true, id: result.id, message: 'Project deleted successfully' } };
    } catch (error) {
      this.logger.error({ correlationId, projectId: id, error: error.message }, 'HTTP: Failed to delete project');

      if (error.message.includes('not found')) {
        return { status: 404, data: { success: false, error: error.message } };
      }
      if (error.message.includes('Cannot delete active')) {
        return { status: 400, data: { success: false, error: error.message } };
      }
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleActivateProject(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    const { id } = req.params || {};

    this.logger.info({ correlationId, projectId: id }, 'HTTP: Activate project');

    try {
      const project = await this.activateProject(id, correlationId);
      return { status: 200, data: { success: true, project } };
    } catch (error) {
      this.logger.error({ correlationId, projectId: id, error: error.message }, 'HTTP: Failed to activate project');

      if (error.message.includes('not found')) {
        return { status: 404, data: { success: false, error: error.message } };
      }
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleGetActiveProject(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    this.logger.debug({ correlationId }, 'HTTP: Get active project');

    try {
      if (!this.activeProjectId) {
        return { status: 404, data: { success: false, error: 'No active project' } };
      }

      const project = this.getProject(this.activeProjectId);
      return { status: 200, data: { success: true, project } };
    } catch (error) {
      this.logger.error({ correlationId, error: error.message }, 'HTTP: Failed to get active project');
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  // ==================== SESSION & AI CONFIG HTTP HANDLERS ====================

  async handleSaveSession(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    const { id } = req.params || {};
    const sessionData = req.body || {};

    this.logger.info({ correlationId, projectId: id }, 'HTTP: Save session');

    try {
      const session = await this.saveSession(id, sessionData, correlationId);
      return { status: 200, data: { success: true, session } };
    } catch (error) {
      this.logger.error({ correlationId, projectId: id, error: error.message }, 'HTTP: Failed to save session');

      if (error.message.includes('not found')) {
        return { status: 404, data: { success: false, error: error.message } };
      }
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleRestoreSession(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    const { id } = req.params || {};

    this.logger.debug({ correlationId, projectId: id }, 'HTTP: Restore session');

    try {
      const session = await this.restoreSession(id, correlationId);
      return { status: 200, data: { success: true, ...session } };
    } catch (error) {
      this.logger.error({ correlationId, projectId: id, error: error.message }, 'HTTP: Failed to restore session');

      if (error.message.includes('not found')) {
        return { status: 404, data: { success: false, error: error.message } };
      }
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleSetAIConfig(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    const { id } = req.params || {};
    const aiConfig = req.body || {};

    this.logger.info({ correlationId, projectId: id, aiConfig }, 'HTTP: Set AI config');

    try {
      const config = await this.setProjectAIConfig(id, aiConfig, correlationId);
      return { status: 200, data: { success: true, ...config } };
    } catch (error) {
      this.logger.error({ correlationId, projectId: id, error: error.message }, 'HTTP: Failed to set AI config');

      if (error.message.includes('not found')) {
        return { status: 404, data: { success: false, error: error.message } };
      }
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleSetLastConversation(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    const { id } = req.params || {};
    const { conversation_id } = req.body || {};

    this.logger.info({ correlationId, projectId: id, conversationId: conversation_id }, 'HTTP: Set last conversation');

    if (!conversation_id) {
      return { status: 400, data: { success: false, error: 'conversation_id is required' } };
    }

    try {
      const project = await this.setLastConversation(id, conversation_id, correlationId);
      return { status: 200, data: { success: true, last_conversation_id: project.last_conversation_id } };
    } catch (error) {
      this.logger.error({ correlationId, projectId: id, error: error.message }, 'HTTP: Failed to set last conversation');

      if (error.message.includes('not found')) {
        return { status: 404, data: { success: false, error: error.message } };
      }
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  // ==================== HEALTH & METRICS ====================

  async handleHealthCheck(req, context) {
    return {
      status: 200,
      data: {
        status: 'healthy',
        module: 'project-manager',
        projects_count: this.projects.size,
        active_project: this.activeProjectId,
        uptime: process.uptime()
      }
    };
  }

  async handleGetMetrics(req, context) {
    return {
      status: 200,
      data: {
        module: 'project-manager',
        metrics: {
          total_projects: this.projects.size,
          active_project_id: this.activeProjectId,
          pending_db_requests: this.pendingDbRequests.size
        }
      }
    };
  }
}

module.exports = ProjectManagerModule;
