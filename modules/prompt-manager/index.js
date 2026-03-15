const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { EVENTS } = require('../../core/constants');

/**
 * Prompt Manager Module
 *
 * Manages AI prompts with versioning, templates, slots, and presets
 * Uses database-manager via events for persistence
 * Supports GLOBAL (_prompts) and PROJECT-specific prompts
 */
class PromptManagerModule {
  constructor() {
    // In-memory cache
    this.prompts = new Map();
    this.presets = new Map();
    this.analytics = new Map();

    // Pending DB requests
    this.pendingRequests = new Map();

    // Config
    this.config = null;
    this.logger = null;
    this.eventBus = null;
    this.uiHandler = null;
    this.schemaInitialized = false;

    // Constants
    this.GLOBAL_PROJECT_ID = '_prompts';
    this.SLOT_TYPES = ['system', 'context', 'prefix', 'suffix', 'format'];
    this.SLOT_ICONS = {
      system: '🧠',
      context: '📋',
      prefix: '⬆️',
      suffix: '⬇️',
      format: '📄'
    };
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(context) {
    this.logger = context.logger;
    this.eventBus = context.eventBus;
    this.uiHandler = context.uiHandler;
    this.config = context.moduleConfig || {};
    this.activity = context.activity?.forModule('prompt-manager');

    this.activity?.action('module.loading', {});

    // Event subscriptions and UI handlers are auto-wired by the loader from module.json

    // Initialize schema in global DB
    await this.initializeSchema();

    // Load prompts and presets into cache
    await this.loadFromDatabase();

    this.logger.info('prompt-manager.loaded', {
      prompts_count: this.prompts.size,
      presets_count: this.presets.size,
      using: 'database-manager'
    });
  }

  async onUnload() {
    this.logger.info('prompt-manager.unloaded', {
      prompts_count: this.prompts.size
    });
  }

  // ==========================================
  // Event Handlers (wired by loader from module.json)
  // ==========================================

  onQueryResponse(event) {
    const { request_id, success, data, error } = event.data || event;

    if (this.pendingRequests.has(request_id)) {
      const { resolve, reject } = this.pendingRequests.get(request_id);
      this.pendingRequests.delete(request_id);

      if (success) {
        resolve(data);
      } else {
        reject(new Error(error || 'Query failed'));
      }
    }
  }

  onSchemaInitResponse(event) {
    const { request_id, success, error } = event.data || event;

    if (this.pendingRequests.has(request_id)) {
      const { resolve, reject } = this.pendingRequests.get(request_id);
      this.pendingRequests.delete(request_id);

      if (success) {
        this.schemaInitialized = true;
        resolve(true);
      } else {
        reject(new Error(error || 'Schema init failed'));
      }
    }
  }

  // ==========================================
  // Database Operations (via events)
  // ==========================================

  async dbQuery(query, params = [], projectId = null) {
    const request_id = this.generateId();
    const project_id = projectId || this.GLOBAL_PROJECT_ID;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(request_id, { resolve, reject });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(request_id)) {
          this.pendingRequests.delete(request_id);
          reject(new Error('Query timeout'));
        }
      }, 10000);

      this.eventBus.publish(EVENTS.DB.QUERY_REQUEST, {
        project_id,
        query,
        params,
        request_id
      });
    });
  }

  async initializeSchema() {
    const request_id = this.generateId();
    const schemaPath = path.join(__dirname, 'schema.sql');

    try {
      const schema = await fs.readFile(schemaPath, 'utf8');

      return new Promise((resolve, reject) => {
        this.pendingRequests.set(request_id, { resolve, reject });

        setTimeout(() => {
          if (this.pendingRequests.has(request_id)) {
            this.pendingRequests.delete(request_id);
            // Don't reject, just log - schema might already exist
            this.logger.warn('prompt-manager.schema.timeout');
            resolve(false);
          }
        }, 5000);

        this.eventBus.publish(EVENTS.DB.SCHEMA_INIT_REQUEST, {
          project_id: this.GLOBAL_PROJECT_ID,
          schema,
          request_id
        });
      });
    } catch (error) {
      this.logger.error('prompt-manager.schema.read.error', { error: error.message });
      return false;
    }
  }

  async loadFromDatabase() {
    try {
      // Load prompts
      const prompts = await this.dbQuery('SELECT * FROM prompts ORDER BY name');
      for (const p of prompts) {
        const prompt = {
          ...p,
          variables: JSON.parse(p.variables || '[]'),
          tags: JSON.parse(p.tags || '[]'),
          metadata: JSON.parse(p.metadata || '{}')
        };
        this.prompts.set(p.id, prompt);
      }

      // Load presets
      const presets = await this.dbQuery('SELECT * FROM slot_presets ORDER BY name');
      for (const preset of presets) {
        this.presets.set(preset.id, preset);
      }

      this.logger.info('prompt-manager.cache.loaded', {
        prompts: this.prompts.size,
        presets: this.presets.size
      });
    } catch (error) {
      this.logger.warn('prompt-manager.cache.load.error', { error: error.message });
      // Not fatal - might be first run
    }
  }

  // ==========================================
  // API Handlers: Prompts CRUD
  // ==========================================

  async handleCreatePrompt(req, context) {
    try {
      const {
        name, title, description, content, slot_type,
        variables, tags, metadata, project_id
      } = req.body || {};

      if (!name || !content) {
        return {
          status: 400,
          data: { error: 'INVALID_REQUEST', message: 'name and content are required' }
        };
      }

      // Validate slot_type
      const validSlotType = this.SLOT_TYPES.includes(slot_type) ? slot_type : 'system';

      const id = this.generateId();
      const now = new Date().toISOString();

      const prompt = {
        id,
        name,
        title: title || name,
        description: description || '',
        slot_type: validSlotType,
        content,
        variables: JSON.stringify(variables || []),
        tags: JSON.stringify(tags || []),
        metadata: JSON.stringify(metadata || {}),
        current_version: '1.0.0',
        created_at: now,
        updated_at: now
      };

      // Insert into DB
      const targetProject = project_id || this.GLOBAL_PROJECT_ID;
      await this.dbQuery(
        `INSERT INTO prompts (id, name, title, description, slot_type, content, variables, tags, metadata, current_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [prompt.id, prompt.name, prompt.title, prompt.description, prompt.slot_type,
         prompt.content, prompt.variables, prompt.tags, prompt.metadata,
         prompt.current_version, prompt.created_at, prompt.updated_at],
        targetProject
      );

      // Insert first version
      await this.dbQuery(
        `INSERT INTO prompt_versions (prompt_id, version, content, variables, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, '1.0.0', content, prompt.variables, now, 'system'],
        targetProject
      );

      // Update cache
      const cachePrompt = {
        ...prompt,
        variables: variables || [],
        tags: tags || [],
        metadata: metadata || {},
        level: targetProject === this.GLOBAL_PROJECT_ID ? 'GLOBAL' : 'PROJECT',
        project_id: targetProject
      };
      this.prompts.set(id, cachePrompt);

      // Publish event
      await this.eventBus.publish('prompt.created', {
        id,
        name,
        slot_type: validSlotType,
        project_id: targetProject
      });

      this.logger.info('prompt-manager.prompt.created', { id, name, slot_type: validSlotType });

      return { status: 201, data: { success: true, prompt: cachePrompt } };
    } catch (error) {
      this.logger.error('prompt-manager.create.error', { error: error.message });
      return {
        status: 500,
        data: { error: 'CREATE_FAILED', message: error.message }
      };
    }
  }

  async handleListPrompts(req, context) {
    try {
      const { tag, search, slot_type, project_id } = req.query || {};

      let prompts = Array.from(this.prompts.values());

      // Filter by slot_type
      if (slot_type && this.SLOT_TYPES.includes(slot_type)) {
        prompts = prompts.filter(p => p.slot_type === slot_type);
      }

      // Filter by tag
      if (tag) {
        prompts = prompts.filter(p => p.tags && p.tags.includes(tag));
      }

      // Filter by project
      if (project_id) {
        prompts = prompts.filter(p =>
          p.project_id === project_id || p.project_id === this.GLOBAL_PROJECT_ID
        );
      }

      // Search
      if (search) {
        const s = search.toLowerCase();
        prompts = prompts.filter(p =>
          p.name.toLowerCase().includes(s) ||
          (p.title && p.title.toLowerCase().includes(s)) ||
          (p.description && p.description.toLowerCase().includes(s))
        );
      }

      return {
        status: 200,
        data: {
          success: true,
          prompts: prompts.map(p => ({
            id: p.id,
            name: p.name,
            title: p.title,
            description: p.description,
            slot_type: p.slot_type,
            slot_icon: this.SLOT_ICONS[p.slot_type] || '📝',
            tags: p.tags,
            level: p.level || 'GLOBAL',
            current_version: p.current_version,
            created_at: p.created_at,
            updated_at: p.updated_at
          })),
          total: prompts.length
        }
      };
    } catch (error) {
      this.logger.error('prompt-manager.list.error', { error: error.message });
      return {
        status: 500,
        data: { error: 'LIST_FAILED', message: error.message }
      };
    }
  }

  async handleGetPrompt(req, context) {
    try {
      const { id } = req.params || context.params || {};
      const prompt = this.prompts.get(id);

      if (!prompt) {
        return {
          status: 404,
          data: { error: 'PROMPT_NOT_FOUND', message: `Prompt '${id}' not found` }
        };
      }

      return { status: 200, data: { success: true, prompt } };
    } catch (error) {
      this.logger.error('prompt-manager.get.error', { error: error.message });
      return {
        status: 500,
        data: { error: 'GET_FAILED', message: error.message }
      };
    }
  }

  async handleUpdatePrompt(req, context) {
    try {
      const { id } = req.params || context.params || {};
      const updates = req.body || {};

      const prompt = this.prompts.get(id);
      if (!prompt) {
        return {
          status: 404,
          data: { error: 'PROMPT_NOT_FOUND', message: `Prompt '${id}' not found` }
        };
      }

      const now = new Date().toISOString();
      const projectId = prompt.project_id || this.GLOBAL_PROJECT_ID;

      // Check if content changed (new version)
      if (updates.content && updates.content !== prompt.content) {
        const newVersion = this.bumpVersion(prompt.current_version);

        await this.dbQuery(
          `INSERT INTO prompt_versions (prompt_id, version, content, variables, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, newVersion, updates.content, JSON.stringify(updates.variables || prompt.variables), now, 'system'],
          projectId
        );

        prompt.current_version = newVersion;
        prompt.content = updates.content;
      }

      // Update fields
      if (updates.title) prompt.title = updates.title;
      if (updates.description !== undefined) prompt.description = updates.description;
      if (updates.slot_type && this.SLOT_TYPES.includes(updates.slot_type)) {
        prompt.slot_type = updates.slot_type;
      }
      if (updates.variables) prompt.variables = updates.variables;
      if (updates.tags) prompt.tags = updates.tags;
      if (updates.metadata) prompt.metadata = { ...prompt.metadata, ...updates.metadata };

      prompt.updated_at = now;

      // Update DB
      await this.dbQuery(
        `UPDATE prompts SET title=?, description=?, slot_type=?, content=?, variables=?, tags=?, metadata=?, current_version=?, updated_at=?
         WHERE id=?`,
        [prompt.title, prompt.description, prompt.slot_type, prompt.content,
         JSON.stringify(prompt.variables), JSON.stringify(prompt.tags), JSON.stringify(prompt.metadata),
         prompt.current_version, prompt.updated_at, id],
        projectId
      );

      // Publish event
      await this.eventBus.publish('prompt.updated', { id, version: prompt.current_version });

      this.logger.info('prompt-manager.prompt.updated', { id, version: prompt.current_version });

      return { status: 200, data: { success: true, prompt } };
    } catch (error) {
      this.logger.error('prompt-manager.update.error', { error: error.message });
      return {
        status: 500,
        data: { error: 'UPDATE_FAILED', message: error.message }
      };
    }
  }

  async handleDeletePrompt(req, context) {
    try {
      const { id } = req.params || context.params || {};

      const prompt = this.prompts.get(id);
      if (!prompt) {
        return {
          status: 404,
          data: { error: 'PROMPT_NOT_FOUND', message: `Prompt '${id}' not found` }
        };
      }

      const projectId = prompt.project_id || this.GLOBAL_PROJECT_ID;

      // Delete from DB (cascade will delete versions)
      await this.dbQuery('DELETE FROM prompts WHERE id = ?', [id], projectId);

      // Update cache
      this.prompts.delete(id);

      // Publish event
      await this.eventBus.publish('prompt.deleted', { id });

      this.logger.info('prompt-manager.prompt.deleted', { id });

      return { status: 200, data: { success: true, message: 'Prompt deleted' } };
    } catch (error) {
      this.logger.error('prompt-manager.delete.error', { error: error.message });
      return {
        status: 500,
        data: { error: 'DELETE_FAILED', message: error.message }
      };
    }
  }

  // ==========================================
  // API Handlers: Presets CRUD
  // ==========================================

  async handleCreatePreset(req, context) {
    try {
      const { name, description, slots } = req.body || {};

      if (!name) {
        return {
          status: 400,
          data: { error: 'INVALID_REQUEST', message: 'name is required' }
        };
      }

      const id = this.generateId();
      const now = new Date().toISOString();

      // Insert preset
      await this.dbQuery(
        `INSERT INTO slot_presets (id, name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [id, name, description || '', now, now]
      );

      // Insert slot-prompt relationships
      if (slots) {
        for (const [slotType, promptIds] of Object.entries(slots)) {
          if (!this.SLOT_TYPES.includes(slotType)) continue;

          const ids = Array.isArray(promptIds) ? promptIds : [promptIds];
          for (let i = 0; i < ids.length; i++) {
            await this.dbQuery(
              `INSERT INTO slot_preset_prompts (preset_id, slot_type, prompt_id, position, created_at)
               VALUES (?, ?, ?, ?, ?)`,
              [id, slotType, ids[i], i, now]
            );
          }
        }
      }

      const preset = { id, name, description: description || '', slots, created_at: now, updated_at: now };
      this.presets.set(id, preset);

      // Publish event
      await this.eventBus.publish('preset.created', { id, name });

      this.logger.info('prompt-manager.preset.created', { id, name });

      return { status: 201, data: { success: true, preset } };
    } catch (error) {
      this.logger.error('prompt-manager.preset.create.error', { error: error.message });
      return {
        status: 500,
        data: { error: 'CREATE_FAILED', message: error.message }
      };
    }
  }

  async handleListPresets(req, context) {
    try {
      const presets = Array.from(this.presets.values());

      return {
        status: 200,
        data: {
          success: true,
          presets,
          total: presets.length
        }
      };
    } catch (error) {
      this.logger.error('prompt-manager.presets.list.error', { error: error.message });
      return {
        status: 500,
        data: { error: 'LIST_FAILED', message: error.message }
      };
    }
  }

  async handleGetPreset(req, context) {
    try {
      const { id } = req.params || context.params || {};
      const preset = this.presets.get(id);

      if (!preset) {
        return {
          status: 404,
          data: { error: 'PRESET_NOT_FOUND', message: `Preset '${id}' not found` }
        };
      }

      // Load slot-prompt relationships
      const relations = await this.dbQuery(
        `SELECT slot_type, prompt_id, position FROM slot_preset_prompts
         WHERE preset_id = ? ORDER BY slot_type, position`,
        [id]
      );

      const slots = {};
      for (const rel of relations) {
        if (!slots[rel.slot_type]) slots[rel.slot_type] = [];
        slots[rel.slot_type].push(rel.prompt_id);
      }

      return {
        status: 200,
        data: { success: true, preset: { ...preset, slots } }
      };
    } catch (error) {
      this.logger.error('prompt-manager.preset.get.error', { error: error.message });
      return {
        status: 500,
        data: { error: 'GET_FAILED', message: error.message }
      };
    }
  }

  async handleDeletePreset(req, context) {
    try {
      const { id } = req.params || context.params || {};

      if (!this.presets.has(id)) {
        return {
          status: 404,
          data: { error: 'PRESET_NOT_FOUND', message: `Preset '${id}' not found` }
        };
      }

      await this.dbQuery('DELETE FROM slot_presets WHERE id = ?', [id]);
      this.presets.delete(id);

      await this.eventBus.publish('preset.deleted', { id });

      this.logger.info('prompt-manager.preset.deleted', { id });

      return { status: 200, data: { success: true, message: 'Preset deleted' } };
    } catch (error) {
      this.logger.error('prompt-manager.preset.delete.error', { error: error.message });
      return {
        status: 500,
        data: { error: 'DELETE_FAILED', message: error.message }
      };
    }
  }

  // ==========================================
  // UI Request/Response Handlers (wired by loader from module.json)
  // ==========================================

  // --- Prompt UI Handlers ---

  async handleUIList(data) {
    const { slot_type, tag, search, project_id } = data || {};

    let prompts = Array.from(this.prompts.values());

    // Filter by slot_type
    if (slot_type && this.SLOT_TYPES.includes(slot_type)) {
      prompts = prompts.filter(p => p.slot_type === slot_type);
    }

    // Filter by tag
    if (tag) {
      prompts = prompts.filter(p => p.tags && p.tags.includes(tag));
    }

    // Filter by project
    if (project_id) {
      prompts = prompts.filter(p =>
        p.project_id === project_id || p.project_id === this.GLOBAL_PROJECT_ID
      );
    }

    // Search
    if (search) {
      const s = search.toLowerCase();
      prompts = prompts.filter(p =>
        p.name.toLowerCase().includes(s) ||
        (p.title && p.title.toLowerCase().includes(s)) ||
        (p.description && p.description.toLowerCase().includes(s))
      );
    }

    // Group by slot_type for UI
    const promptsBySlot = {};
    for (const slotType of this.SLOT_TYPES) {
      promptsBySlot[slotType] = [];
    }

    const promptsList = prompts.map(p => ({
      id: p.id,
      name: p.name,
      title: p.title,
      description: p.description,
      content: p.content,
      slot_type: p.slot_type,
      slot_icon: this.SLOT_ICONS[p.slot_type] || '📝',
      variables: p.variables,
      tags: p.tags,
      level: p.level || 'GLOBAL',
      level_icon: p.level === 'PROJECT' ? '🔵' : '🟢',
      current_version: p.current_version,
      created_at: p.created_at,
      updated_at: p.updated_at
    }));

    for (const prompt of promptsList) {
      if (promptsBySlot[prompt.slot_type]) {
        promptsBySlot[prompt.slot_type].push(prompt);
      }
    }

    // Slot types metadata
    const slotTypes = this.SLOT_TYPES.map(type => ({
      id: type,
      name: type.charAt(0).toUpperCase() + type.slice(1),
      icon: this.SLOT_ICONS[type],
      count: promptsBySlot[type].length
    }));

    // Stats
    const stats = {
      total: prompts.length,
      by_slot: Object.fromEntries(
        this.SLOT_TYPES.map(type => [type, promptsBySlot[type].length])
      )
    };

    return { prompts: promptsList, promptsBySlot, slotTypes, stats };
  }

  async handleUIGet(data) {
    const { id } = data || {};

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'id is required' };
    }

    const prompt = this.prompts.get(id);
    if (!prompt) {
      throw { status: 404, code: 'NOT_FOUND', message: `Prompt '${id}' not found` };
    }

    return { prompt };
  }

  async handleUICreate(data) {
    const { name, title, description, content, slot_type, variables, tags, metadata, project_id } = data || {};

    if (!name || !content) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'name and content are required' };
    }

    const validSlotType = this.SLOT_TYPES.includes(slot_type) ? slot_type : 'system';
    const id = this.generateId();
    const now = new Date().toISOString();
    const targetProject = project_id || this.GLOBAL_PROJECT_ID;

    const prompt = {
      id,
      name,
      title: title || name,
      description: description || '',
      slot_type: validSlotType,
      content,
      variables: variables || [],
      tags: tags || [],
      metadata: metadata || {},
      current_version: '1.0.0',
      level: targetProject === this.GLOBAL_PROJECT_ID ? 'GLOBAL' : 'PROJECT',
      project_id: targetProject,
      created_at: now,
      updated_at: now
    };

    // Insert into DB
    await this.dbQuery(
      `INSERT INTO prompts (id, name, title, description, slot_type, content, variables, tags, metadata, current_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, prompt.title, prompt.description, validSlotType, content,
       JSON.stringify(prompt.variables), JSON.stringify(prompt.tags), JSON.stringify(prompt.metadata),
       '1.0.0', now, now],
      targetProject
    );

    // Insert first version
    await this.dbQuery(
      `INSERT INTO prompt_versions (prompt_id, version, content, variables, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, '1.0.0', content, JSON.stringify(prompt.variables), now, 'user'],
      targetProject
    );

    // Update cache
    this.prompts.set(id, prompt);

    // Publish event
    await this.eventBus.publish('prompt.created', { id, name, slot_type: validSlotType });

    this.logger.info('prompt-manager.ui.created', { id, name, slot_type: validSlotType });

    return { prompt };
  }

  async handleUIUpdate(data) {
    const { id, ...updates } = data || {};

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'id is required' };
    }

    const prompt = this.prompts.get(id);
    if (!prompt) {
      throw { status: 404, code: 'NOT_FOUND', message: `Prompt '${id}' not found` };
    }

    const now = new Date().toISOString();
    const projectId = prompt.project_id || this.GLOBAL_PROJECT_ID;

    // Check if content changed (new version)
    if (updates.content && updates.content !== prompt.content) {
      const newVersion = this.bumpVersion(prompt.current_version);

      await this.dbQuery(
        `INSERT INTO prompt_versions (prompt_id, version, content, variables, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, newVersion, updates.content, JSON.stringify(updates.variables || prompt.variables), now, 'user'],
        projectId
      );

      prompt.current_version = newVersion;
      prompt.content = updates.content;
    }

    // Update fields
    if (updates.title !== undefined) prompt.title = updates.title;
    if (updates.description !== undefined) prompt.description = updates.description;
    if (updates.slot_type && this.SLOT_TYPES.includes(updates.slot_type)) {
      prompt.slot_type = updates.slot_type;
    }
    if (updates.variables) prompt.variables = updates.variables;
    if (updates.tags) prompt.tags = updates.tags;
    if (updates.metadata) prompt.metadata = { ...prompt.metadata, ...updates.metadata };

    prompt.updated_at = now;

    // Update DB
    await this.dbQuery(
      `UPDATE prompts SET title=?, description=?, slot_type=?, content=?, variables=?, tags=?, metadata=?, current_version=?, updated_at=?
       WHERE id=?`,
      [prompt.title, prompt.description, prompt.slot_type, prompt.content,
       JSON.stringify(prompt.variables), JSON.stringify(prompt.tags), JSON.stringify(prompt.metadata),
       prompt.current_version, prompt.updated_at, id],
      projectId
    );

    // Publish event
    await this.eventBus.publish('prompt.updated', { id, version: prompt.current_version });

    this.logger.info('prompt-manager.ui.updated', { id, version: prompt.current_version });

    return { prompt };
  }

  async handleUIDelete(data) {
    const { id } = data || {};

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'id is required' };
    }

    const prompt = this.prompts.get(id);
    if (!prompt) {
      throw { status: 404, code: 'NOT_FOUND', message: `Prompt '${id}' not found` };
    }

    const projectId = prompt.project_id || this.GLOBAL_PROJECT_ID;

    // Delete from DB
    await this.dbQuery('DELETE FROM prompts WHERE id = ?', [id], projectId);

    // Update cache
    this.prompts.delete(id);

    // Publish event
    await this.eventBus.publish('prompt.deleted', { id });

    this.logger.info('prompt-manager.ui.deleted', { id });

    return { deleted: true };
  }

  async handleUIVersions(data) {
    const { id } = data || {};

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'id is required' };
    }

    const prompt = this.prompts.get(id);
    if (!prompt) {
      throw { status: 404, code: 'NOT_FOUND', message: `Prompt '${id}' not found` };
    }

    const projectId = prompt.project_id || this.GLOBAL_PROJECT_ID;
    const versions = await this.dbQuery(
      'SELECT version, content, variables, created_at, created_by FROM prompt_versions WHERE prompt_id = ? ORDER BY created_at DESC',
      [id],
      projectId
    );

    return {
      prompt_id: id,
      current_version: prompt.current_version,
      versions
    };
  }

  // --- Preset UI Handlers ---

  async handleUIPresetList(data) {
    const presets = Array.from(this.presets.values()).map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      created_at: p.created_at,
      updated_at: p.updated_at
    }));

    return { presets, total: presets.length };
  }

  async handleUIPresetGet(data) {
    const { id } = data || {};

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'id is required' };
    }

    const preset = this.presets.get(id);
    if (!preset) {
      throw { status: 404, code: 'NOT_FOUND', message: `Preset '${id}' not found` };
    }

    // Load slot-prompt relationships
    const relations = await this.dbQuery(
      `SELECT slot_type, prompt_id, position FROM slot_preset_prompts
       WHERE preset_id = ? ORDER BY slot_type, position`,
      [id]
    );

    const slots = {};
    for (const rel of relations) {
      if (!slots[rel.slot_type]) slots[rel.slot_type] = [];
      slots[rel.slot_type].push(rel.prompt_id);
    }

    return { preset: { ...preset, slots } };
  }

  async handleUIPresetCreate(data) {
    const { name, description, slots } = data || {};

    if (!name) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'name is required' };
    }

    const id = this.generateId();
    const now = new Date().toISOString();

    // Insert preset
    await this.dbQuery(
      `INSERT INTO slot_presets (id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, name, description || '', now, now]
    );

    // Insert slot-prompt relationships
    if (slots) {
      for (const [slotType, promptIds] of Object.entries(slots)) {
        if (!this.SLOT_TYPES.includes(slotType)) continue;

        const ids = Array.isArray(promptIds) ? promptIds : [promptIds];
        for (let i = 0; i < ids.length; i++) {
          await this.dbQuery(
            `INSERT INTO slot_preset_prompts (preset_id, slot_type, prompt_id, position, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [id, slotType, ids[i], i, now]
          );
        }
      }
    }

    const preset = { id, name, description: description || '', slots, created_at: now, updated_at: now };
    this.presets.set(id, preset);

    // Publish event
    await this.eventBus.publish('preset.created', { id, name });

    this.logger.info('prompt-manager.ui.preset.created', { id, name });

    return { preset };
  }

  async handleUIPresetDelete(data) {
    const { id } = data || {};

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'id is required' };
    }

    if (!this.presets.has(id)) {
      throw { status: 404, code: 'NOT_FOUND', message: `Preset '${id}' not found` };
    }

    await this.dbQuery('DELETE FROM slot_presets WHERE id = ?', [id]);
    this.presets.delete(id);

    await this.eventBus.publish('preset.deleted', { id });

    this.logger.info('prompt-manager.ui.preset.deleted', { id });

    return { deleted: true };
  }

  async handleUIPresetApply(data) {
    const { id } = data || {};

    if (!id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'id is required' };
    }

    const preset = this.presets.get(id);
    if (!preset) {
      throw { status: 404, code: 'NOT_FOUND', message: `Preset '${id}' not found` };
    }

    // Load slot-prompt relationships with full prompt data
    const relations = await this.dbQuery(
      `SELECT slot_type, prompt_id, position FROM slot_preset_prompts
       WHERE preset_id = ? ORDER BY slot_type, position`,
      [id]
    );

    const composerState = {};
    for (const slotType of this.SLOT_TYPES) {
      composerState[slotType] = [];
    }

    for (const rel of relations) {
      const prompt = this.prompts.get(rel.prompt_id);
      if (prompt && composerState[rel.slot_type]) {
        composerState[rel.slot_type].push({
          id: prompt.id,
          name: prompt.name,
          title: prompt.title,
          content: prompt.content,
          variables: prompt.variables
        });
      }
    }

    return { preset: { id, name: preset.name }, composerState };
  }

  // --- Composer UI Handlers ---

  async handleUIComposerRender(data) {
    const { slots, variables } = data || {};

    if (!slots) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'slots is required' };
    }

    // Build final prompt from slots
    const parts = [];
    let totalVariables = new Set();

    for (const slotType of this.SLOT_TYPES) {
      const slotPromptIds = slots[slotType] || [];
      for (const promptId of slotPromptIds) {
        const prompt = this.prompts.get(promptId);
        if (prompt) {
          // Collect variables
          if (prompt.variables) {
            prompt.variables.forEach(v => totalVariables.add(v.name || v));
          }

          // Render template with provided variables
          let content = prompt.content;
          if (variables) {
            content = this.renderTemplateString(content, variables);
          }

          parts.push({
            slot_type: slotType,
            slot_icon: this.SLOT_ICONS[slotType],
            prompt_id: prompt.id,
            prompt_name: prompt.name,
            content
          });
        }
      }
    }

    // Combine all parts
    const finalPrompt = parts.map(p => p.content).join('\n\n');

    // Estimate tokens (rough: ~4 chars per token)
    const estimatedTokens = Math.ceil(finalPrompt.length / 4);

    return {
      parts,
      finalPrompt,
      estimatedTokens,
      variables: Array.from(totalVariables),
      variablesProvided: variables || {}
    };
  }

  // --- Analytics UI Handler ---

  async handleUIAnalytics(data) {
    const { prompt_id } = data || {};

    let analytics = await this.dbQuery(
      'SELECT * FROM prompt_analytics' + (prompt_id ? ' WHERE prompt_id = ?' : ''),
      prompt_id ? [prompt_id] : []
    );

    // Get top prompts by usage
    const topPrompts = [...analytics]
      .sort((a, b) => (b.usage_count || 0) - (a.usage_count || 0))
      .slice(0, 10)
      .map(a => {
        const prompt = this.prompts.get(a.prompt_id);
        return {
          prompt_id: a.prompt_id,
          prompt_name: prompt?.name || 'Unknown',
          slot_type: prompt?.slot_type || 'system',
          slot_icon: this.SLOT_ICONS[prompt?.slot_type] || '📝',
          usage_count: a.usage_count || 0,
          last_used: a.last_used
        };
      });

    // Stats by slot
    const bySlot = {};
    for (const slotType of this.SLOT_TYPES) {
      const slotPromptIds = Array.from(this.prompts.values())
        .filter(p => p.slot_type === slotType)
        .map(p => p.id);

      const slotAnalytics = analytics.filter(a => slotPromptIds.includes(a.prompt_id));
      bySlot[slotType] = {
        count: slotPromptIds.length,
        total_usage: slotAnalytics.reduce((sum, a) => sum + (a.usage_count || 0), 0)
      };
    }

    return {
      total_prompts: this.prompts.size,
      total_presets: this.presets.size,
      topPrompts,
      bySlot,
      analytics
    };
  }

  // ==========================================
  // API Handlers: Render & Other
  // ==========================================

  async handleRenderTemplate(req, context) {
    try {
      const { id } = req.params || context.params || {};
      const { variables, version } = req.body || {};

      const prompt = this.prompts.get(id);
      if (!prompt) {
        return {
          status: 404,
          data: { error: 'PROMPT_NOT_FOUND', message: `Prompt '${id}' not found` }
        };
      }

      let content = prompt.content;

      // Get specific version if requested
      if (version && version !== prompt.current_version) {
        const projectId = prompt.project_id || this.GLOBAL_PROJECT_ID;
        const versions = await this.dbQuery(
          'SELECT content FROM prompt_versions WHERE prompt_id = ? AND version = ?',
          [id, version],
          projectId
        );
        if (versions.length > 0) {
          content = versions[0].content;
        }
      }

      // Render template
      const rendered = this.renderTemplateString(content, variables || {});

      // Record analytics
      await this.recordUsage(id, version || prompt.current_version);

      return {
        status: 200,
        data: {
          success: true,
          prompt_id: id,
          version: version || prompt.current_version,
          rendered,
          variables_used: variables || {}
        }
      };
    } catch (error) {
      this.logger.error('prompt-manager.render.error', { error: error.message });
      return {
        status: 500,
        data: { error: 'RENDER_FAILED', message: error.message }
      };
    }
  }

  async handleListVersions(req, context) {
    try {
      const { id } = req.params || context.params || {};

      const prompt = this.prompts.get(id);
      if (!prompt) {
        return {
          status: 404,
          data: { error: 'PROMPT_NOT_FOUND', message: `Prompt '${id}' not found` }
        };
      }

      const projectId = prompt.project_id || this.GLOBAL_PROJECT_ID;
      const versions = await this.dbQuery(
        'SELECT version, content, variables, created_at, created_by FROM prompt_versions WHERE prompt_id = ? ORDER BY created_at DESC',
        [id],
        projectId
      );

      return {
        status: 200,
        data: {
          success: true,
          prompt_id: id,
          current_version: prompt.current_version,
          versions
        }
      };
    } catch (error) {
      this.logger.error('prompt-manager.versions.error', { error: error.message });
      return {
        status: 500,
        data: { error: 'LIST_VERSIONS_FAILED', message: error.message }
      };
    }
  }

  async handleGetAnalytics(req, context) {
    try {
      const { prompt_id } = req.query || {};

      let analytics = await this.dbQuery(
        'SELECT * FROM prompt_analytics' + (prompt_id ? ' WHERE prompt_id = ?' : ''),
        prompt_id ? [prompt_id] : []
      );

      return {
        status: 200,
        data: { success: true, analytics, total: analytics.length }
      };
    } catch (error) {
      this.logger.error('prompt-manager.analytics.error', { error: error.message });
      return {
        status: 500,
        data: { error: 'ANALYTICS_FAILED', message: error.message }
      };
    }
  }

  // ==========================================
  // UI Endpoint - UI-Ready State
  // ==========================================

  async handleGetUIState(req, context) {
    try {
      const { project_id } = req.query || {};

      // Group prompts by slot_type
      const promptsBySlot = {};
      for (const slotType of this.SLOT_TYPES) {
        promptsBySlot[slotType] = [];
      }

      for (const prompt of this.prompts.values()) {
        const slot = prompt.slot_type || 'system';
        if (promptsBySlot[slot]) {
          promptsBySlot[slot].push({
            id: prompt.id,
            name: prompt.name,
            title: prompt.title,
            description: prompt.description,
            tags: prompt.tags || [],
            level: prompt.level || 'GLOBAL',
            levelIcon: prompt.level === 'PROJECT' ? '🔵' : '🟢'
          });
        }
      }

      // Slot types with icons
      const slotTypes = this.SLOT_TYPES.map(type => ({
        id: type,
        name: type.charAt(0).toUpperCase() + type.slice(1),
        icon: this.SLOT_ICONS[type],
        count: promptsBySlot[type].length
      }));

      // Presets for quick selection
      const presets = Array.from(this.presets.values()).map(p => ({
        id: p.id,
        name: p.name,
        description: p.description
      }));

      // Stats
      const stats = {
        total_prompts: this.prompts.size,
        total_presets: this.presets.size,
        by_slot: {}
      };
      for (const [slot, prompts] of Object.entries(promptsBySlot)) {
        stats.by_slot[slot] = prompts.length;
      }

      return {
        status: 200,
        data: {
          success: true,
          slotTypes,
          promptsBySlot,
          presets,
          stats
        }
      };
    } catch (error) {
      this.logger.error('prompt-manager.ui.state.error', { error: error.message });
      return {
        status: 500,
        data: { error: 'UI_STATE_FAILED', message: error.message }
      };
    }
  }

  // ==========================================
  // AI Tool Handlers
  // ==========================================

  /**
   * Tool handler: Lista prompts disponibles para AI
   * @param {Object} args - Tool arguments
   * @param {string} [args.slot_type] - Filter by slot type
   * @param {string} [args.tag] - Filter by tag
   * @param {string} [args.search] - Search in name/description
   * @returns {Object} List of prompts (metadata only, not full content)
   */
  async handleToolPromptList(args) {
    const { slot_type, tag, search } = args || {};

    this.logger.info('prompt.tool.list.called', { slot_type, tag, search });

    let prompts = Array.from(this.prompts.values());

    // Filter by slot_type
    if (slot_type && this.SLOT_TYPES.includes(slot_type)) {
      prompts = prompts.filter(p => p.slot_type === slot_type);
    }

    // Filter by tag
    if (tag) {
      prompts = prompts.filter(p => p.tags && p.tags.includes(tag));
    }

    // Search
    if (search) {
      const s = search.toLowerCase();
      prompts = prompts.filter(p =>
        p.name.toLowerCase().includes(s) ||
        (p.title && p.title.toLowerCase().includes(s)) ||
        (p.description && p.description.toLowerCase().includes(s))
      );
    }

    // Return metadata only (not full content to avoid large responses)
    const results = prompts.map(p => ({
      id: p.id,
      name: p.name,
      title: p.title,
      description: p.description,
      slot_type: p.slot_type,
      tags: p.tags,
      variables: p.variables,
      level: p.level || 'GLOBAL',
      current_version: p.current_version
    }));

    this.logger.info('prompt.tool.list.result', { count: results.length });

    return {
      status: 200,
      data: {
        prompts: results,
        total: results.length,
        filters: { slot_type, tag, search }
      }
    };
  }

  /**
   * Tool handler: Obtiene un prompt específico para AI
   * @param {Object} args - Tool arguments
   * @param {string} [args.id] - Prompt ID
   * @param {string} [args.name] - Prompt name (alternative to ID)
   * @returns {Object} Prompt with full content
   */
  async handleToolPromptGet(args) {
    const { id, name } = args || {};

    this.logger.info('prompt.tool.get.called', { id, name });

    if (!id && !name) {
      return {
        status: 400,
        data: { error: 'Either id or name is required' }
      };
    }

    let prompt = null;

    if (id) {
      prompt = this.prompts.get(id);
    } else if (name) {
      // Find by name (case-insensitive)
      const nameLower = name.toLowerCase();
      for (const p of this.prompts.values()) {
        if (p.name.toLowerCase() === nameLower) {
          prompt = p;
          break;
        }
      }
    }

    if (!prompt) {
      return {
        status: 404,
        data: { error: `Prompt not found: ${id || name}` }
      };
    }

    // Record usage
    await this.recordUsage(prompt.id, prompt.current_version);

    return {
      status: 200,
      data: {
        prompt: {
          id: prompt.id,
          name: prompt.name,
          title: prompt.title,
          description: prompt.description,
          content: prompt.content,
          slot_type: prompt.slot_type,
          variables: prompt.variables,
          tags: prompt.tags,
          level: prompt.level || 'GLOBAL',
          current_version: prompt.current_version
        }
      }
    };
  }

  /**
   * Tool handler: Renderiza un prompt con variables para AI
   * @param {Object} args - Tool arguments
   * @param {string} [args.id] - Prompt ID
   * @param {string} [args.name] - Prompt name (alternative to ID)
   * @param {Object} [args.variables] - Variables to interpolate
   * @returns {Object} Rendered prompt content
   */
  async handleToolPromptRender(args) {
    const { id, name, variables } = args || {};

    this.logger.info('prompt.tool.render.called', { id, name, variables });

    if (!id && !name) {
      return {
        status: 400,
        data: { error: 'Either id or name is required' }
      };
    }

    let prompt = null;

    if (id) {
      prompt = this.prompts.get(id);
    } else if (name) {
      const nameLower = name.toLowerCase();
      for (const p of this.prompts.values()) {
        if (p.name.toLowerCase() === nameLower) {
          prompt = p;
          break;
        }
      }
    }

    if (!prompt) {
      return {
        status: 404,
        data: { error: `Prompt not found: ${id || name}` }
      };
    }

    // Render template with variables
    const rendered = this.renderTemplateString(prompt.content, variables || {});

    // Identify missing variables
    const missingVars = [];
    if (prompt.variables && prompt.variables.length > 0) {
      for (const v of prompt.variables) {
        const varName = v.name || v;
        if (!variables || variables[varName] === undefined) {
          missingVars.push(varName);
        }
      }
    }

    // Record usage
    await this.recordUsage(prompt.id, prompt.current_version);

    return {
      status: 200,
      data: {
        prompt_id: prompt.id,
        prompt_name: prompt.name,
        rendered,
        variables_used: variables || {},
        missing_variables: missingVars.length > 0 ? missingVars : undefined
      }
    };
  }

  // ==========================================
  // Helper Methods
  // ==========================================

  generateId() {
    return crypto.randomBytes(16).toString('hex');
  }

  bumpVersion(version) {
    const [major, minor, patch] = version.split('.').map(Number);
    return `${major}.${minor}.${patch + 1}`;
  }

  renderTemplateString(template, variables) {
    let rendered = template;
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
      rendered = rendered.replace(regex, String(value));
    }
    return rendered;
  }

  async recordUsage(promptId, version) {
    try {
      const now = new Date().toISOString();

      // Check if exists
      const existing = await this.dbQuery(
        'SELECT id, usage_count FROM prompt_analytics WHERE prompt_id = ? AND version = ?',
        [promptId, version]
      );

      if (existing.length > 0) {
        await this.dbQuery(
          'UPDATE prompt_analytics SET usage_count = usage_count + 1, last_used = ? WHERE id = ?',
          [now, existing[0].id]
        );
      } else {
        await this.dbQuery(
          `INSERT INTO prompt_analytics (prompt_id, version, usage_count, first_used, last_used)
           VALUES (?, ?, 1, ?, ?)`,
          [promptId, version, now, now]
        );
      }
    } catch (error) {
      this.logger.warn('prompt-manager.analytics.record.error', { error: error.message });
    }
  }

  // ==========================================
  // Health & Metrics
  // ==========================================

  async handleHealthCheck(req, context) {
    return {
      status: 200,
      data: {
        status: 'healthy',
        module: 'prompt-manager',
        prompts_count: this.prompts.size,
        presets_count: this.presets.size,
        schema_initialized: this.schemaInitialized,
        using: 'database-manager'
      }
    };
  }

  // ==========================================
  // Event Bus Handlers (inter-module communication)
  // ==========================================

  /**
   * Handle prompt.get.request from other modules (e.g. prompt-composer).
   * Responds with prompt.get.response containing the prompt data.
   */
  async onPromptGetRequest(event) {
    const data = event.data || event;
    const { request_id, name, id, correlation_id } = data;

    let prompt = null;

    if (id) {
      prompt = this.prompts.get(id);
    } else if (name) {
      const nameLower = name.toLowerCase();
      for (const p of this.prompts.values()) {
        if (p.name.toLowerCase() === nameLower) {
          prompt = p;
          break;
        }
      }
    }

    if (prompt) {
      await this.eventBus.publish('prompt.get.response', {
        request_id,
        success: true,
        data: {
          prompt: {
            id: prompt.id,
            name: prompt.name,
            title: prompt.title,
            description: prompt.description,
            content: prompt.content,
            slot_type: prompt.slot_type,
            variables: prompt.variables,
            tags: prompt.tags,
            level: prompt.level || 'GLOBAL',
            current_version: prompt.current_version
          }
        },
        correlation_id
      });
    } else {
      await this.eventBus.publish('prompt.get.response', {
        request_id,
        success: false,
        error: `Prompt not found: ${id || name}`,
        correlation_id
      });
    }
  }

  /**
   * Handle prompt.list.request from other modules (e.g. prompt-composer).
   * Responds with prompt.list.response containing all prompts.
   */
  async onPromptListRequest(event) {
    const data = event.data || event;
    const { request_id, correlation_id } = data;

    const prompts = Array.from(this.prompts.values()).map(p => ({
      id: p.id,
      name: p.name,
      title: p.title,
      description: p.description,
      slot_type: p.slot_type,
      tags: p.tags,
      level: p.level || 'GLOBAL',
      current_version: p.current_version
    }));

    await this.eventBus.publish('prompt.list.response', {
      request_id,
      success: true,
      data: { prompts },
      correlation_id
    });
  }

  async handleGetMetrics(req, context) {
    return {
      status: 200,
      data: {
        counters: {
          prompts: this.prompts.size,
          presets: this.presets.size
        },
        by_slot_type: Object.fromEntries(
          this.SLOT_TYPES.map(type => [
            type,
            Array.from(this.prompts.values()).filter(p => p.slot_type === type).length
          ])
        )
      }
    };
  }
}

module.exports = PromptManagerModule;
