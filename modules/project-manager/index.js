/**
 * Project Manager Module
 *
 * Project lifecycle management: CRUD, session, features/blueprints, directories.
 * Consumes composition-manager and context-manager via events for
 * relationships, systems, and shared context.
 *
 * Table owned: projects
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EVENTS } = require('../../core/constants');

class ProjectManagerModule {
  constructor() {
    this.name = 'project-manager';
    this.version = '3.0.0';

    // Dependencies (injected in onLoad)
    this.logger = null;
    this.metrics = null;
    this.eventBus = null;
    this.uiHandler = null;
    this.config = null;

    // State
    this.projects = new Map();
    this.activeProjectIds = new Set();
    this.pendingDbRequests = new Map();
    this.pendingCompositionRequests = new Map();
    this.projectsBasePath = path.join(process.cwd(), 'data', 'projects');
  }

  async onLoad(core) {
    this.logger = core.logger;
    this.metrics = core.metrics;
    this.eventBus = core.eventBus;
    this.uiHandler = core.uiHandler;

    // Load config from loader-injected moduleConfig
    this.config = core.moduleConfig || {};

    this.logger.info('project-manager.loading', { module: this.name });

    await this.initializeSystemSchema();
    await this.loadExistingProjects();
    await this.ensureSystemProject();

    this.logger.info('project-manager.loaded', { module: this.name });
  }

  async onUnload() {
    this.logger.info('project-manager.unloading');
    for (const [, pending] of this.pendingDbRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Module unloading'));
    }
    this.pendingDbRequests.clear();
    for (const [, pending] of this.pendingCompositionRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Module unloading'));
    }
    this.pendingCompositionRequests.clear();
    this.logger.info('project-manager.unloaded');
  }

  // ==================== Database Access ====================

  async queryDatabase(query, params = [], readOnly = true, correlationId) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingDbRequests.delete(requestId);
        reject(new Error(`Database query timeout: ${query.substring(0, 100)}`));
      }, this.config.dbTimeout || 10000);

      this.pendingDbRequests.set(requestId, { resolve, reject, timeout });

      this.eventBus.publish('db.query.request', {
        request_id: requestId, query, params, read_only: readOnly,
        project_id: 'system', correlation_id: correlationId
      }).catch(err => {
        clearTimeout(timeout);
        this.pendingDbRequests.delete(requestId);
        reject(err);
      });
    });
  }

  async onDbQueryResponse(event) {
    const { request_id, success, data, error } = event.data || event;
    const pending = this.pendingDbRequests.get(request_id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingDbRequests.delete(request_id);
    if (success) pending.resolve(data || []);
    else pending.reject(new Error(error || 'Database query failed'));
  }

  // ==================== Composition RPC ====================

  async requestComposition(action, data) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCompositionRequests.delete(requestId);
        reject(new Error(`Composition timeout: ${action}`));
      }, this.config.compositionTimeout || 10000);

      this.pendingCompositionRequests.set(requestId, { resolve, reject, timeout: timer });

      this.eventBus.publish('composition.request', {
        request_id: requestId, action, ...data
      }).catch(err => {
        clearTimeout(timer);
        this.pendingCompositionRequests.delete(requestId);
        reject(err);
      });
    });
  }

  async onCompositionResponse(event) {
    const { request_id, success, data, error } = event.data || event;
    const pending = this.pendingCompositionRequests.get(request_id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingCompositionRequests.delete(request_id);
    if (success) pending.resolve(data);
    else pending.reject(new Error(error || 'Composition request failed'));
  }

  // ==================== Schema ====================

  async initializeSystemSchema() {
    const cid = crypto.randomUUID();
    this.logger.info('project-manager.schema.initializing', { correlationId: cid });

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
    `, [], false, cid);

    this.logger.info('project-manager.schema.initialized', { correlationId: cid });
  }

  async loadExistingProjects() {
    const cid = crypto.randomUUID();
    try {
      const projects = await this.queryDatabase('SELECT * FROM projects ORDER BY created_at', [], true, cid);
      for (const row of projects) {
        const project = {
          id: row.id, name: row.name, description: row.description,
          created_at: row.created_at, updated_at: row.updated_at,
          is_active: row.is_active === 1,
          metadata: row.metadata ? JSON.parse(row.metadata) : {},
          last_conversation_id: row.last_conversation_id,
          provider: row.provider, model: row.model, prompt_id: row.prompt_id,
          base_path: row.base_path,
          session_state: row.session_state ? JSON.parse(row.session_state) : {},
          system_id: row.system_id || null,
          system_role: row.system_role || null,
          parent_project_id: row.parent_project_id || null
        };
        this.projects.set(project.id, project);
        if (project.is_active) this.activeProjectIds.add(project.id);
      }
      this.logger.info('project-manager.db.loaded', { count: projects.length, activeProjectIds: [...this.activeProjectIds] });
    } catch (error) {
      this.logger.error('project-manager.db.load.failed', { error: error.message });
    }
  }

  /**
   * Re-emits project.activated for all projects with is_active=1.
   * Called from root index.js after all modules are loaded so they receive the events.
   */
  async reactivateExistingProjects() {
    if (this.activeProjectIds.size === 0) return;

    for (const projectId of this.activeProjectIds) {
      const project = this.projects.get(projectId);
      if (!project) continue;

      await this.eventBus.publish(EVENTS.PROJECT.ACTIVATED, {
        project_id: projectId,
        name: project.name,
        base_path: project.base_path,
        metadata: project.metadata || {},
        activated_at: new Date().toISOString()
      });
    }

    this.logger.info('project-manager.reactivated', {
      count: this.activeProjectIds.size,
      projects: [...this.activeProjectIds]
    });
  }

  async ensureSystemProject() {
    const cid = crypto.randomUUID();
    const SYSTEM_PROJECT_NAME = 'Sistema';

    const existingSystem = Array.from(this.projects.values()).find(
      p => p.name === SYSTEM_PROJECT_NAME || p.metadata?.is_system
    );
    if (existingSystem) {
      // Ensure System Project is always active
      if (!existingSystem.is_active) {
        existingSystem.is_active = true;
        this.projects.set(existingSystem.id, existingSystem);
        this.activeProjectIds.add(existingSystem.id);
        await this.queryDatabase('UPDATE projects SET is_active = 1 WHERE id = ?', [existingSystem.id], false, cid);
        this.logger.info('project-manager.system.activated', { projectId: existingSystem.id });
      }
      return existingSystem;
    }

    try {
      const projectId = crypto.randomUUID();
      const now = new Date().toISOString();
      const basePath = process.cwd();
      const metadata = { is_system: true, color: 'gray', icon: '⚙️', workspaceType: 'system', features: [] };

      if (await this.projectNameExists(SYSTEM_PROJECT_NAME)) return;

      await this.queryDatabase(`
        INSERT INTO projects (
          id, name, description, created_at, updated_at, is_active, metadata,
          last_conversation_id, provider, model, prompt_id, base_path, session_state, system_role
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        projectId, SYSTEM_PROJECT_NAME,
        'Proyecto padre del sistema. Gestiona la configuración, módulos, logs y todos los directorios del sistema event-core.',
        now, now, JSON.stringify(metadata),
        null, null, null, null, basePath, JSON.stringify({}), 'root'
      ], false, cid);

      const project = {
        id: projectId, name: SYSTEM_PROJECT_NAME,
        description: 'Proyecto padre del sistema. Gestiona la configuración, módulos, logs y todos los directorios del sistema event-core.',
        created_at: now, updated_at: now, is_active: true, metadata,
        last_conversation_id: null, provider: null, model: null, prompt_id: null,
        base_path: basePath, session_state: {},
        system_id: null, system_role: 'root', parent_project_id: null
      };
      this.projects.set(projectId, project);
      this.activeProjectIds.add(projectId);
      await this.initializeProjectSchema(projectId, cid);

      // Create root system via composition-manager
      try {
        const system = await this.requestComposition('system.create', {
          name: 'Event-Core System',
          description: 'Sistema raíz que engloba todos los proyectos',
          metadata: { root_project_id: projectId }
        });
        await this.requestComposition('entity.join', {
          system_id: system.id, entity_id: projectId, role: 'root'
        });
        await this.queryDatabase(
          'UPDATE projects SET system_id = ?, system_role = ? WHERE id = ?',
          [system.id, 'root', projectId], false, cid
        );
        project.system_id = system.id;
      } catch (err) {
        this.logger.warn('project-manager.system.composition-failed', { error: err.message });
      }

      this.logger.info('project-manager.system.created', { projectId, basePath });
      return project;
    } catch (error) {
      if (error.code === 'PROJECT_NAME_EXISTS' || error.message?.includes('UNIQUE constraint')) return;
      this.logger.error('project-manager.system.ensure-failed', { error: error.message });
    }
  }

  // ==================== Helpers ====================

  slugify(name) {
    return name.toLowerCase().trim()
      .replace(/[áàäâã]/g, 'a').replace(/[éèëê]/g, 'e')
      .replace(/[íìïî]/g, 'i').replace(/[óòöôõ]/g, 'o')
      .replace(/[úùüû]/g, 'u').replace(/ñ/g, 'n')
      .replace(/[^a-z0-9\s-]/g, '').replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  toUIFormat(p) {
    return {
      id: p.id, name: p.name, slug: this.slugify(p.name),
      description: p.description || '',
      color: p.metadata?.color || 'blue', icon: p.metadata?.icon || '📁',
      workspaceType: p.metadata?.workspaceType || 'general',
      metadata: p.metadata || {},
      isActive: p.is_active === true || p.is_active === 1,
      createdAt: p.created_at, updatedAt: p.updated_at,
      systemId: p.system_id || null, systemRole: p.system_role || null,
      parentProjectId: p.parent_project_id || null
    };
  }

  async publishUIState() {
    const projects = this.listProjects().map(p => this.toUIFormat(p));
    await this.eventBus.emit('project/state', {
      projects, activeProjectIds: [...this.activeProjectIds], count: projects.length
    });
  }

  // ==================== Directories ====================

  async createProjectDirectories(projectId, name) {
    const slug = this.slugify(name);
    const basePath = path.join(this.projectsBasePath, slug);
    await fs.promises.mkdir(path.join(basePath, 'db'), { recursive: true });
    await fs.promises.mkdir(path.join(basePath, 'storage'), { recursive: true });
    // Persistencia: eventos, ventas, current, backups
    const persistenciaBase = path.join(basePath, 'persistencia');
    await fs.promises.mkdir(path.join(persistenciaBase, 'eventos'), { recursive: true });
    await fs.promises.mkdir(path.join(persistenciaBase, 'ventas'), { recursive: true });
    await fs.promises.mkdir(path.join(persistenciaBase, 'current'), { recursive: true });
    await fs.promises.mkdir(path.join(persistenciaBase, 'backups'), { recursive: true });
    // Contabilidad: cierres diarios y acumulados
    await fs.promises.mkdir(path.join(basePath, 'contabilidad', 'cierres'), { recursive: true });
    return basePath;
  }

  async deleteProjectDirectories(basePath) {
    try {
      await fs.promises.rm(basePath, { recursive: true, force: true });
    } catch (error) {
      this.logger.warn('project.directories.delete.failed', { basePath, error: error.message });
    }
  }

  async projectNameExists(name) {
    const slug = this.slugify(name);
    const basePath = path.join(this.projectsBasePath, slug);
    try { await fs.promises.access(basePath); return true; } catch { return false; }
  }

  async initializeProjectSchema(projectId, correlationId) {
    try {
      await this.eventBus.publish('db.schema.init.request', {
        project_id: projectId, schema: this.config.defaultSchema, correlation_id: correlationId
      });
    } catch (err) {
      this.logger.warn('project.schema.init.failed', { projectId, error: err.message });
    }
  }

  async initializeFromBlueprint(basePath, featureId, projectDef) {
    const dirs = projectDef.directories || [];
    for (const dir of dirs) {
      // Prefix storage paths with feature namespace: storage/X -> storage/{featureId}/X
      const namespacedDir = dir.startsWith('storage/')
        ? dir.replace('storage/', `storage/${featureId}/`)
        : dir;
      await fs.promises.mkdir(path.join(basePath, namespacedDir), { recursive: true });
    }

    // Merge config into project's existing config
    if (projectDef.config && Object.keys(projectDef.config).length > 0) {
      const configDir = path.join(basePath, 'config');
      await fs.promises.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, 'config.json');

      let existingConfig = {};
      try {
        existingConfig = JSON.parse(await fs.promises.readFile(configPath, 'utf-8'));
      } catch (_) { /* no existing config */ }

      const newConfig = JSON.parse(JSON.stringify(projectDef.config).replace(/\{\{slug\}\}/g, featureId));
      const mergedConfig = { ...existingConfig, ...newConfig };
      await fs.promises.writeFile(configPath, JSON.stringify(mergedConfig, null, 2), 'utf-8');
    }

    if (projectDef.copyHandlersFrom) {
      const sourcePath = path.join(this.projectsBasePath, projectDef.copyHandlersFrom, 'handlers');
      const targetPath = path.join(basePath, 'handlers');
      try {
        await fs.promises.mkdir(targetPath, { recursive: true });
        const files = await fs.promises.readdir(sourcePath);
        for (const file of files) {
          if (!file.endsWith('.js')) continue;
          const srcFile = path.join(sourcePath, file);
          const stat = await fs.promises.stat(srcFile);
          if (stat.isFile()) await fs.promises.copyFile(srcFile, path.join(targetPath, file));
        }
      } catch (error) {
        this.logger.warn('project.blueprint.handlers.copy.failed', { source: projectDef.copyHandlersFrom, error: error.message });
      }
    }

    if (projectDef.initialFiles) {
      for (const [filePath, content] of Object.entries(projectDef.initialFiles)) {
        // Prefix storage paths: storage/X.json -> storage/{featureId}/X.json
        const namespacedPath = filePath.startsWith('storage/')
          ? filePath.replace('storage/', `storage/${featureId}/`)
          : filePath;
        const fullPath = path.join(basePath, namespacedPath);
        await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.promises.writeFile(fullPath, JSON.stringify(content, null, 2), 'utf-8');
      }
    }
  }

  // ==================== CRUD ====================

  async createProject(name, description = '', metadata = {}, correlationId, options = {}) {
    const projectId = crypto.randomUUID();
    const now = new Date().toISOString();

    if (await this.projectNameExists(name)) {
      const error = new Error(`Project with name "${name}" already exists`);
      error.code = 'PROJECT_NAME_EXISTS';
      throw error;
    }

    const basePath = await this.createProjectDirectories(projectId, name);
    const { provider = null, model = null, prompt_id = null, parent_project_id = null } = options;

    // Validate parent exists and resolve its system_id
    let parentSystemId = null;
    if (parent_project_id) {
      const parent = this.projects.get(parent_project_id);
      if (!parent) {
        const error = new Error(`Parent project not found: ${parent_project_id}`);
        error.code = 'PARENT_NOT_FOUND';
        throw error;
      }
      parentSystemId = parent.system_id || null;
    }

    await this.queryDatabase(`
      INSERT INTO projects (
        id, name, description, created_at, updated_at, is_active, metadata,
        last_conversation_id, provider, model, prompt_id, base_path, session_state,
        parent_project_id, system_id
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      projectId, name, description, now, now,
      JSON.stringify(metadata), null, provider, model, prompt_id, basePath, JSON.stringify({}),
      parent_project_id, parentSystemId
    ], false, correlationId);

    const project = {
      id: projectId, name, description, created_at: now, updated_at: now,
      is_active: false, metadata, last_conversation_id: null,
      provider, model, prompt_id, base_path: basePath, session_state: {},
      parent_project_id: parent_project_id || null,
      system_id: parentSystemId, system_role: null
    };
    this.projects.set(projectId, project);

    // Join parent's composition system if available
    if (parentSystemId) {
      try {
        await this.requestComposition('entity.join', {
          system_id: parentSystemId, entity_id: projectId, role: 'member'
        });
        project.system_role = 'member';
        await this.queryDatabase(
          'UPDATE projects SET system_role = ? WHERE id = ?',
          ['member', projectId], false, correlationId
        );
      } catch (err) {
        this.logger.warn('project-manager.create.system-join-failed', { projectId, parentSystemId, error: err.message });
      }
    }

    await this.initializeProjectSchema(projectId, correlationId);
    await this.eventBus.publish(EVENTS.PROJECT.CREATED, {
      project_id: projectId, name, description, parent_project_id: parent_project_id || null, created_at: now
    });

    return project;
  }

  async updateProject(projectId, updates, correlationId) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const now = new Date().toISOString();
    const updatedFields = [];
    const parts = [];
    const params = [];

    if (updates.name !== undefined) { parts.push('name = ?'); params.push(updates.name); project.name = updates.name; updatedFields.push('name'); }
    if (updates.description !== undefined) { parts.push('description = ?'); params.push(updates.description); project.description = updates.description; updatedFields.push('description'); }
    if (updates.metadata !== undefined) { parts.push('metadata = ?'); params.push(JSON.stringify(updates.metadata)); project.metadata = updates.metadata; updatedFields.push('metadata'); }

    if (parts.length === 0) return project;

    parts.push('updated_at = ?');
    params.push(now);
    params.push(projectId);

    await this.queryDatabase(`UPDATE projects SET ${parts.join(', ')} WHERE id = ?`, params, false, correlationId);
    project.updated_at = now;
    this.projects.set(projectId, project);

    await this.eventBus.publish(EVENTS.PROJECT.UPDATED, {
      project_id: projectId, updated_fields: updatedFields, updated_at: now
    });

    return project;
  }

  async deleteProject(projectId, correlationId, options = {}) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (project.is_active) throw new Error('Cannot delete active project. Deactivate first.');

    // Check dependents via composition-manager
    try {
      const depInfo = await this.requestComposition('dependents.has', { entity_id: projectId });
      if (depInfo.hasDependents && !options.force) {
        const error = new Error(`Cannot delete project: ${depInfo.count} project(s) depend on it. Use force=true to delete anyway.`);
        error.code = 'HAS_DEPENDENTS';
        error.dependents = depInfo.dependents;
        throw error;
      }
    } catch (err) {
      if (err.code === 'HAS_DEPENDENTS') throw err;
      this.logger.warn('project-manager.delete.dependents-check-failed', { error: err.message });
    }

    await this.queryDatabase('DELETE FROM projects WHERE id = ?', [projectId], false, correlationId);
    if (project.base_path) await this.deleteProjectDirectories(project.base_path);
    this.projects.delete(projectId);

    await this.eventBus.publish(EVENTS.PROJECT.DELETED, {
      project_id: projectId, name: project.name, deleted_at: new Date().toISOString()
    });

    return { success: true, id: projectId };
  }

  async activateProject(projectId, correlationId) {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    // Usar siempre el UUID real
    const realId = project.id;

    if (!this.activeProjectIds.has(realId)) {
      await this.queryDatabase('UPDATE projects SET is_active = 1 WHERE id = ?', [realId], false, correlationId);
      project.is_active = true;
      this.projects.set(realId, project);
      this.activeProjectIds.add(realId);
    }

    await this.eventBus.publish(EVENTS.PROJECT.ACTIVATED, {
      project_id: realId, name: project.name, base_path: project.base_path,
      metadata: project.metadata || {}, activated_at: new Date().toISOString()
    });

    return project;
  }

  getProject(projectId) {
    // Búsqueda directa por UUID
    const direct = this.projects.get(projectId);
    if (direct) return direct;

    // Búsqueda por slug (nombre slugificado)
    const slugInput = this.slugify(projectId);
    if (!slugInput) return undefined;

    for (const project of this.projects.values()) {
      if (this.slugify(project.name) === slugInput) return project;
    }

    return undefined;
  }
  listProjects() { return Array.from(this.projects.values()); }
  getActiveProjectIds() { return [...this.activeProjectIds]; }
  getActiveProjectId() { return this.activeProjectIds.size > 0 ? [...this.activeProjectIds][0] : null; }

  // ==================== Session ====================

  async saveSession(projectId, sessionData, correlationId) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const now = new Date().toISOString();
    const sessionState = { ...project.session_state, ...sessionData, saved_at: now };

    await this.queryDatabase(
      'UPDATE projects SET session_state = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(sessionState), now, projectId], false, correlationId
    );

    project.session_state = sessionState;
    project.updated_at = now;
    return sessionState;
  }

  async restoreSession(projectId) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return {
      last_conversation_id: project.last_conversation_id,
      session_state: project.session_state || {},
      provider: project.provider, model: project.model, prompt_id: project.prompt_id
    };
  }

  async setLastConversation(projectId, conversationId, correlationId) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const now = new Date().toISOString();
    await this.queryDatabase(
      'UPDATE projects SET last_conversation_id = ?, updated_at = ? WHERE id = ?',
      [conversationId, now, projectId], false, correlationId
    );
    project.last_conversation_id = conversationId;
    project.updated_at = now;
    return project;
  }

  async setProjectAIConfig(projectId, aiConfig, correlationId) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const now = new Date().toISOString();
    const { provider, model, prompt_id } = aiConfig;
    const parts = ['updated_at = ?'];
    const params = [now];

    if (provider !== undefined) { parts.push('provider = ?'); params.push(provider); project.provider = provider; }
    if (model !== undefined) { parts.push('model = ?'); params.push(model); project.model = model; }
    if (prompt_id !== undefined) { parts.push('prompt_id = ?'); params.push(prompt_id); project.prompt_id = prompt_id; }

    params.push(projectId);
    await this.queryDatabase(`UPDATE projects SET ${parts.join(', ')} WHERE id = ?`, params, false, correlationId);
    project.updated_at = now;

    await this.eventBus.publish(EVENTS.PROJECT.UPDATED, {
      project_id: projectId,
      updated_fields: ['provider', 'model', 'prompt_id'].filter(f => aiConfig[f] !== undefined),
      updated_at: now
    });

    return { provider: project.provider, model: project.model, prompt_id: project.prompt_id };
  }

  // ==================== Features / Blueprints ====================

  async handleUIListFeatures(data) {
    const bpDir = path.join(process.cwd(), 'blueprints', 'project-types');
    const { projectId } = data || {};

    let installedFeatures = [];
    if (projectId) {
      const project = this.getProject(projectId);
      if (project) {
        installedFeatures = project.metadata?.features || [];
      }
    }

    try {
      const files = await fs.promises.readdir(bpDir);
      const features = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = JSON.parse(await fs.promises.readFile(path.join(bpDir, file), 'utf-8'));
          const featureId = content.id || file.replace('.json', '');

          let handlersAvailable = true;
          if (content.copyHandlersFrom) {
            const sourcePath = path.join(this.projectsBasePath, content.copyHandlersFrom, 'handlers');
            try { await fs.promises.access(sourcePath); } catch { handlersAvailable = false; }
          }

          features.push({
            id: featureId, label: content.label || featureId,
            icon: content.icon || '', description: content.description || '',
            dependencies: content.dependencies || [],
            installed: installedFeatures.includes(featureId),
            handlersAvailable
          });
        } catch (err) {
          this.logger.warn({ file, error: err.message }, 'Invalid blueprint file');
        }
      }

      return { features, projectId: projectId || null };
    } catch (err) {
      return { features: [], projectId: projectId || null };
    }
  }

  async handleUIAddFeatures(data) {
    const { id, features } = data;
    const correlationId = crypto.randomUUID();

    if (!id) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    const project = this.getProject(id);
    if (!project) throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };

    const selectedFeatures = Array.isArray(features) ? features : [];
    if (selectedFeatures.length === 0) throw { status: 400, code: 'VALIDATION_ERROR', message: 'At least one feature is required' };

    const existingFeatures = project.metadata?.features || [];
    const newFeatures = selectedFeatures.filter(f => !existingFeatures.includes(f));
    if (newFeatures.length === 0) {
      return { applied: [], skipped: selectedFeatures, reason: 'all_already_installed' };
    }

    // Load blueprints
    const bpDir = path.join(process.cwd(), 'blueprints', 'project-types');
    const blueprints = new Map();
    const loadErrors = [];

    for (const featureId of newFeatures) {
      try {
        const bpPath = path.join(bpDir, `${featureId}.json`);
        blueprints.set(featureId, JSON.parse(await fs.promises.readFile(bpPath, 'utf-8')));
      } catch (err) {
        loadErrors.push({ featureId, error: err.message });
      }
    }

    // Validate dependencies
    const missingDeps = [];
    for (const [featureId, blueprint] of blueprints) {
      for (const dep of (blueprint.dependencies || [])) {
        if (!existingFeatures.includes(dep) && !newFeatures.includes(dep)) {
          missingDeps.push({ feature: featureId, requires: dep });
        }
      }
    }
    if (missingDeps.length > 0) {
      throw {
        status: 400, code: 'MISSING_DEPENDENCIES',
        message: `Dependencias no satisfechas: ${missingDeps.map(d => `${d.feature} requiere ${d.requires}`).join(', ')}`,
        missingDeps
      };
    }

    // Install features as sections inside the root project
    const basePath = project.base_path;
    const applied = [];
    const warnings = [];

    for (const [featureId, blueprint] of blueprints) {
      try {
        await this.initializeFromBlueprint(basePath, featureId, blueprint);
        applied.push(featureId);
        this.logger.info('project-manager.feature.installed', {
          projectId: id, featureId, basePath
        });
      } catch (err) {
        this.logger.error({ featureId, error: err.message }, 'Feature install failed');
        warnings.push({ featureId, warning: `Error: ${err.message}` });
      }
    }

    // Update project metadata with installed features
    const updatedFeatures = [...new Set([...existingFeatures, ...applied])];
    await this.updateProject(id, {
      metadata: { ...(project.metadata || {}), features: updatedFeatures }
    }, correlationId);

    // Reload handlers for the project (new handlers may have been copied)
    if (applied.length > 0) {
      try {
        const handlerLoader = this.core?.handlerLoader;
        if (handlerLoader) {
          handlerLoader.reloadProject(this.slugify(project.name));
        }
      } catch (err) {
        this.logger.warn('project-manager.handlers.reload.failed', { error: err.message });
      }
    }

    return {
      applied, projectId: id,
      skipped: selectedFeatures.filter(f => existingFeatures.includes(f)),
      warnings: warnings.length > 0 ? warnings : undefined,
      loadErrors: loadErrors.length > 0 ? loadErrors : undefined
    };
  }

  // ==================== Event Handlers ====================

  async onGetProjectRequest(event) {
    const { request_id, project_id } = event.data || event;
    const project = this.getProject(project_id);
    await this.eventBus.publish(EVENTS.PROJECT.GET_RESPONSE, {
      request_id, success: !!project, project: project || null,
      error: project ? null : 'Project not found'
    });
  }

  async onListProjectsRequest(event) {
    const { request_id } = event.data || event;
    const projects = this.listProjects();
    await this.eventBus.publish(EVENTS.PROJECT.LIST_RESPONSE, {
      request_id, success: true, projects, count: projects.length,
      active_project_ids: [...this.activeProjectIds]
    });
  }

  async onGetActiveProjectRequest(event) {
    const { request_id } = event.data || event;
    await this.eventBus.publish('project.active.response', {
      request_id, success: true, active_project_ids: [...this.activeProjectIds]
    });
  }

  async onProjectStateRequest() { await this.publishUIState(); }

  async onProjectCreate(event) {
    const { name, description, color, icon, workspaceType } = event.data || event;
    if (!name || name.trim().length === 0) return;
    try {
      await this.createProject(name.trim(), description?.trim() || '',
        { color: color || 'blue', icon: icon || '📁', workspaceType: workspaceType || 'general' },
        crypto.randomUUID()
      );
      await this.publishUIState();
    } catch (error) {
      this.logger.error('mqtt.project.create.failed', { error: error.message });
    }
  }

  async onProjectUpdate(event) {
    const { id, name, description, color, icon, workspaceType } = event.data || event;
    if (!id) return;
    try {
      const updates = {};
      if (name !== undefined) updates.name = name.trim();
      if (description !== undefined) updates.description = description.trim();
      const project = this.getProject(id);
      if (project) {
        const metadata = { ...(project.metadata || {}) };
        if (color !== undefined) metadata.color = color;
        if (icon !== undefined) metadata.icon = icon;
        if (workspaceType !== undefined) metadata.workspaceType = workspaceType;
        updates.metadata = metadata;
      }
      await this.updateProject(id, updates, crypto.randomUUID());
      await this.publishUIState();
    } catch (error) {
      this.logger.error('mqtt.project.update.failed', { id, error: error.message });
    }
  }

  async onProjectDelete(event) {
    const { id } = event.data || event;
    if (!id) return;
    try {
      await this.deleteProject(id, crypto.randomUUID());
      await this.publishUIState();
    } catch (error) {
      this.logger.error('mqtt.project.delete.failed', { id, error: error.message });
    }
  }

  async onProjectActivate(event) {
    const { id } = event.data || event;
    if (!id) return;
    try {
      await this.activateProject(id, crypto.randomUUID());
      await this.publishUIState();
    } catch (error) {
      this.logger.error('mqtt.project.activate.failed', { id, error: error.message });
    }
  }

  // ==================== HTTP Handlers ====================

  async handleCreateProject(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    const { name, description, metadata, parent_project_id } = req.body || {};
    if (!name || name.trim().length === 0) return { status: 400, data: { success: false, error: 'Project name is required' } };
    try {
      const project = await this.createProject(name, description, metadata, correlationId, { parent_project_id });
      return { status: 201, data: { success: true, project } };
    } catch (error) {
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleListProjects() {
    const projects = this.listProjects();
    return { status: 200, data: { success: true, projects, count: projects.length, active_project_ids: [...this.activeProjectIds] } };
  }

  async handleGetProject(req) {
    const project = this.getProject(req.params?.id);
    if (!project) return { status: 404, data: { success: false, error: 'Project not found' } };
    return { status: 200, data: { success: true, project } };
  }

  async handleUpdateProject(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    try {
      const project = await this.updateProject(req.params?.id, req.body || {}, correlationId);
      return { status: 200, data: { success: true, project } };
    } catch (error) {
      if (error.message.includes('not found')) return { status: 404, data: { success: false, error: error.message } };
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleDeleteProject(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    try {
      const result = await this.deleteProject(req.params?.id, correlationId);
      return { status: 200, data: { success: true, id: result.id } };
    } catch (error) {
      if (error.message.includes('not found')) return { status: 404, data: { success: false, error: error.message } };
      if (error.message.includes('Cannot delete active')) return { status: 400, data: { success: false, error: error.message } };
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleActivateProject(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    try {
      const project = await this.activateProject(req.params?.id, correlationId);
      return { status: 200, data: { success: true, project } };
    } catch (error) {
      if (error.message.includes('not found')) return { status: 404, data: { success: false, error: error.message } };
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleGetActiveProject() {
    if (this.activeProjectIds.size === 0) return { status: 404, data: { success: false, error: 'No active projects' } };
    const projects = [...this.activeProjectIds].map(id => this.getProject(id)).filter(Boolean);
    return { status: 200, data: { success: true, projects, active_project_ids: [...this.activeProjectIds] } };
  }

  async handleSaveSession(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    try {
      const session = await this.saveSession(req.params?.id, req.body || {}, correlationId);
      return { status: 200, data: { success: true, session } };
    } catch (error) {
      if (error.message.includes('not found')) return { status: 404, data: { success: false, error: error.message } };
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleRestoreSession(req) {
    try {
      const session = await this.restoreSession(req.params?.id);
      return { status: 200, data: { success: true, ...session } };
    } catch (error) {
      if (error.message.includes('not found')) return { status: 404, data: { success: false, error: error.message } };
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleSetAIConfig(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    try {
      const config = await this.setProjectAIConfig(req.params?.id, req.body || {}, correlationId);
      return { status: 200, data: { success: true, ...config } };
    } catch (error) {
      if (error.message.includes('not found')) return { status: 404, data: { success: false, error: error.message } };
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleSetLastConversation(req, context) {
    const correlationId = context?.correlationId || crypto.randomUUID();
    const { conversation_id } = req.body || {};
    if (!conversation_id) return { status: 400, data: { success: false, error: 'conversation_id is required' } };
    try {
      const project = await this.setLastConversation(req.params?.id, conversation_id, correlationId);
      return { status: 200, data: { success: true, last_conversation_id: project.last_conversation_id } };
    } catch (error) {
      if (error.message.includes('not found')) return { status: 404, data: { success: false, error: error.message } };
      return { status: 500, data: { success: false, error: error.message } };
    }
  }

  async handleHealthCheck() {
    return { status: 200, data: { status: 'healthy', module: 'project-manager', projects_count: this.projects.size, active_projects: [...this.activeProjectIds], uptime: process.uptime() } };
  }

  async handleGetMetrics() {
    return { status: 200, data: { module: 'project-manager', metrics: { total_projects: this.projects.size, active_project_ids: [...this.activeProjectIds], pending_db_requests: this.pendingDbRequests.size } } };
  }

  // ==================== UI Handlers ====================

  async handleUIList() {
    const projects = this.listProjects().map(p => this.toUIFormat(p));
    return { projects, activeProjectIds: [...this.activeProjectIds], count: projects.length };
  }


  async handleUIGet(data) {
    const { id } = data;
    if (!id) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    const project = this.getProject(id);
    if (!project) throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    return { project: this.toUIFormat(project) };
  }

  async handleUICreate(data) {
    const { name, description, color, icon, workspaceType, parentProjectId } = data;
    if (!name || name.trim().length === 0) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project name is required' };

    const project = await this.createProject(name.trim(), description?.trim() || '',
      { color: color || 'blue', icon: icon || '📁', workspaceType: workspaceType || 'general' }, crypto.randomUUID(),
      { parent_project_id: parentProjectId || null }
    );

    const basePath = project.base_path;
    await fs.promises.mkdir(path.join(basePath, 'config'), { recursive: true });
    await fs.promises.mkdir(path.join(basePath, 'handlers'), { recursive: true });

    return { project: this.toUIFormat(project), created: true };
  }

  async handleUIUpdate(data) {
    const { id, name, description, color, icon, workspaceType } = data;
    if (!id) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };

    const existing = this.getProject(id);
    if (!existing) throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };

    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (description !== undefined) updates.description = description.trim();
    const metadata = { ...(existing.metadata || {}) };
    if (color !== undefined) metadata.color = color;
    if (icon !== undefined) metadata.icon = icon;
    if (workspaceType !== undefined) metadata.workspaceType = workspaceType;
    updates.metadata = metadata;

    const project = await this.updateProject(id, updates, crypto.randomUUID());
    return { project: this.toUIFormat(project), updated: true };
  }

  async handleUIDelete(data) {
    const { id, force } = data;
    if (!id) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    if (!this.getProject(id)) throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };

    try {
      await this.deleteProject(id, crypto.randomUUID(), { force: !!force });
      return { deleted: true, id };
    } catch (error) {
      if (error.code === 'HAS_DEPENDENTS') throw { status: 409, code: 'HAS_DEPENDENTS', message: error.message, dependents: error.dependents };
      throw { status: 500, code: 'INTERNAL_ERROR', message: error.message };
    }
  }

  async handleUIActivate(data) {
    const { id } = data;
    if (!id) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    const project = this.getProject(id);
    if (!project) throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    await this.activateProject(project.id, crypto.randomUUID());
    return { activated: true, id: project.id, slug: this.slugify(project.name), activeProjectIds: [...this.activeProjectIds] };
  }

  async handleUIDeactivate(data) {
    const { id } = data || {};
    if (!id || !this.activeProjectIds.has(id)) return { deactivated: false, error: 'Project not active' };

    const project = this.projects.get(id);

    await this.queryDatabase('UPDATE projects SET is_active = 0 WHERE id = ?', [id], false, crypto.randomUUID());
    if (project) { project.is_active = false; this.projects.set(id, project); }
    this.activeProjectIds.delete(id);

    await this.eventBus.publish('project.deactivated', {
      project_id: id, name: project?.name, deactivated_at: new Date().toISOString()
    });
    await this.publishUIState();
    return { deactivated: true, activeProjectIds: [...this.activeProjectIds] };
  }

  async handleUISaveSession(data) {
    const { id, ...sessionData } = data;
    if (!id) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    if (!this.getProject(id)) throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    const session = await this.saveSession(id, sessionData, crypto.randomUUID());
    return { saved: true, session };
  }

  async handleUIRestoreSession(data) {
    const { id } = data;
    if (!id) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    if (!this.getProject(id)) throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    return await this.restoreSession(id);
  }

  async handleUISetAIConfig(data) {
    const { id, provider, model, prompt_id } = data;
    if (!id) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    if (!this.getProject(id)) throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    const config = await this.setProjectAIConfig(id, { provider, model, prompt_id }, crypto.randomUUID());
    return { updated: true, ...config };
  }

  async handleUIGetUnassigned() {
    const allProjectIds = Array.from(this.projects.keys());
    try {
      const unassignedIds = await this.requestComposition('entity.unassigned', { entity_ids: allProjectIds });
      const projects = (unassignedIds || []).map(id => {
        const project = this.projects.get(id);
        return project
          ? { id, name: project.name, description: project.description }
          : { id };
      });
      return { projects, count: projects.length };
    } catch (err) {
      // Fallback: use local cache to find projects without system_id
      const projects = Array.from(this.projects.values())
        .filter(p => !p.system_id)
        .map(p => ({ id: p.id, name: p.name, description: p.description }));
      return { projects, count: projects.length };
    }
  }

  async handleUISetLastConversation(data) {
    const { id, conversationId } = data;
    if (!id) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    if (!conversationId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Conversation ID is required' };
    if (!this.getProject(id)) throw { status: 404, code: 'NOT_FOUND', message: 'Project not found' };
    await this.setLastConversation(id, conversationId, crypto.randomUUID());
    return { updated: true, lastConversationId: conversationId };
  }
}

module.exports = ProjectManagerModule;
