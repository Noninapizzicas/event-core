/**
 * Context Manager Module
 *
 * Shared knowledge between entities: import/export conversations,
 * discover context sources, and assemble full context for AI.
 *
 * Consumes composition-manager via events for relationship data
 * (related entities, dependencies, system membership).
 *
 * Table owned: shared_context
 */

const crypto = require('crypto');

class ContextManagerModule {
  constructor() {
    this.name = 'context-manager';
    this.version = '1.0.0';

    this.logger = null;
    this.eventBus = null;
    this.uiHandler = null;
    this.config = null;

    this.pendingDbRequests = new Map();
    this.pendingCompositionRequests = new Map();
  }

  async onLoad(core) {
    this.logger = core.logger;
    this.eventBus = core.eventBus;
    this.uiHandler = core.uiHandler;

    // Load config from loader-injected moduleConfig
    this.config = core.moduleConfig || {};

    this.logger.info('context-manager.loading');

    await this.initializeSchema();

    this.logger.info('context-manager.loaded');
  }

  async onUnload() {
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
  }

  // ==================== Database Access ====================

  async queryDatabase(query, params = [], readOnly = true, correlationId) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingDbRequests.delete(requestId);
        reject(new Error(`DB timeout: ${query.substring(0, 80)}`));
      }, this.config.dbTimeout || 10000);

      this.pendingDbRequests.set(requestId, { resolve, reject, timeout });

      this.eventBus.publish('db.query.request', {
        request_id: requestId,
        query, params, read_only: readOnly,
        project_id: 'system',
        correlation_id: correlationId
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
    const timeout = this.config.compositionTimeout || 10000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCompositionRequests.delete(requestId);
        reject(new Error(`Composition timeout: ${action}`));
      }, timeout);

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

  async initializeSchema() {
    const cid = crypto.randomUUID();

    await this.queryDatabase(`
      CREATE TABLE IF NOT EXISTS shared_context (
        id TEXT PRIMARY KEY,
        from_project_id TEXT NOT NULL,
        to_project_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        reason TEXT,
        imported_at TEXT NOT NULL
      )
    `, [], false, cid);

    try {
      await this.queryDatabase('CREATE INDEX IF NOT EXISTS idx_shared_from ON shared_context(from_project_id)', [], false, cid);
      await this.queryDatabase('CREATE INDEX IF NOT EXISTS idx_shared_to ON shared_context(to_project_id)', [], false, cid);
    } catch (_) {}

    this.logger.info('context-manager.schema.initialized');
  }

  // ==================== Shared Context CRUD ====================

  async importContext(toEntityId, fromEntityId, conversationId, reason, correlationId) {
    if (toEntityId === fromEntityId) throw new Error('Cannot import context from same entity');

    const existing = await this.queryDatabase(
      `SELECT id FROM shared_context WHERE to_project_id = ? AND from_project_id = ? AND conversation_id = ?`,
      [toEntityId, fromEntityId, conversationId], true, correlationId
    );
    if (existing.length > 0) throw new Error('This conversation is already shared with this entity');

    const shareId = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.queryDatabase(`
      INSERT INTO shared_context (id, from_project_id, to_project_id, conversation_id, reason, imported_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [shareId, fromEntityId, toEntityId, conversationId, reason || null, now], false, correlationId);

    await this.eventBus.publish('context.imported', {
      share_id: shareId,
      from_entity_id: fromEntityId, to_entity_id: toEntityId,
      conversation_id: conversationId, reason, imported_at: now
    });

    return {
      id: shareId, fromEntityId, toEntityId,
      conversationId, reason, importedAt: now
    };
  }

  async removeSharedContext(shareId, correlationId) {
    const shares = await this.queryDatabase(
      'SELECT * FROM shared_context WHERE id = ?', [shareId], true, correlationId
    );
    if (shares.length === 0) throw new Error(`Shared context not found: ${shareId}`);

    await this.queryDatabase('DELETE FROM shared_context WHERE id = ?', [shareId], false, correlationId);

    await this.eventBus.publish('context.removed', {
      share_id: shareId,
      from_entity_id: shares[0].from_project_id,
      to_entity_id: shares[0].to_project_id,
      removed_at: new Date().toISOString()
    });

    return { success: true, shareId };
  }

  async getSharedContext(entityId, correlationId) {
    const shares = await this.queryDatabase(`
      SELECT * FROM shared_context WHERE to_project_id = ? ORDER BY imported_at DESC
    `, [entityId], true, correlationId);

    return shares.map(s => ({
      id: s.id,
      fromEntityId: s.from_project_id,
      toEntityId: s.to_project_id,
      conversationId: s.conversation_id,
      reason: s.reason,
      importedAt: s.imported_at
    }));
  }

  async getExportedContext(entityId, correlationId) {
    const shares = await this.queryDatabase(`
      SELECT * FROM shared_context WHERE from_project_id = ? ORDER BY imported_at DESC
    `, [entityId], true, correlationId);

    return shares.map(s => ({
      id: s.id,
      fromEntityId: s.from_project_id,
      toEntityId: s.to_project_id,
      conversationId: s.conversation_id,
      reason: s.reason,
      importedAt: s.imported_at
    }));
  }

  // ==================== Entity Name Resolution ====================

  /**
   * Resolve entity IDs to names/descriptions by querying the projects table.
   * Returns Map<entityId, { name, description }>.
   */
  async resolveEntityNames(entityIds, correlationId) {
    if (!entityIds || entityIds.length === 0) return new Map();
    const unique = [...new Set(entityIds)];
    const placeholders = unique.map(() => '?').join(',');
    try {
      const rows = await this.queryDatabase(
        `SELECT id, name, description FROM projects WHERE id IN (${placeholders})`,
        unique, true, correlationId
      );
      const map = new Map();
      for (const row of rows) {
        map.set(row.id, { name: row.name, description: row.description });
      }
      return map;
    } catch (err) {
      this.logger.warn('context-manager.resolve-names.failed', { error: err.message });
      return new Map();
    }
  }

  // ==================== Parent Chain Resolution ====================

  /**
   * Walk up parent_project_id chain to build project hierarchy.
   * Returns [{id, name, description, metadata}, ...] from immediate parent to root.
   */
  async getParentChain(entityId, correlationId) {
    const chain = [];
    const visited = new Set();
    const MAX_DEPTH = 10;
    let currentId = entityId;

    while (currentId && chain.length < MAX_DEPTH) {
      if (visited.has(currentId)) break;
      visited.add(currentId);

      try {
        const rows = await this.queryDatabase(
          'SELECT id, name, description, parent_project_id, metadata FROM projects WHERE id = ?',
          [currentId], true, correlationId
        );
        if (rows.length === 0) break;

        const row = rows[0];
        if (!row.parent_project_id) break;

        // Fetch parent
        const parentRows = await this.queryDatabase(
          'SELECT id, name, description, parent_project_id, metadata FROM projects WHERE id = ?',
          [row.parent_project_id], true, correlationId
        );
        if (parentRows.length === 0) break;

        const parent = parentRows[0];
        let metadata = {};
        try { metadata = parent.metadata ? JSON.parse(parent.metadata) : {}; } catch (_) {}

        chain.push({
          id: parent.id,
          name: parent.name,
          description: parent.description,
          metadata
        });

        currentId = parent.id;
      } catch (err) {
        this.logger.warn('context-manager.parent-chain.error', { entityId: currentId, error: err.message });
        break;
      }
    }

    return chain;
  }

  // ==================== Context Discovery ====================

  async getAvailableContextSources(entityId, correlationId) {
    // Fetch relationship data from composition-manager in parallel
    const [related, deps, systemInfo] = await Promise.all([
      this.requestComposition('related.get', { entity_id: entityId }).catch(() => []),
      this.requestComposition('deps.get', { entity_id: entityId }).catch(() => []),
      this.requestComposition('entity.system', { entity_id: entityId }).catch(() => null)
    ]);

    const alreadyImported = await this.getSharedContext(entityId, correlationId);
    const importedMap = new Map(alreadyImported.map(s => [s.fromEntityId, s]));

    // Collect all entity IDs that need name resolution
    const idsToResolve = new Set();
    for (const rel of (related || [])) idsToResolve.add(rel.id);
    for (const dep of (deps || [])) idsToResolve.add(dep.dependsOnId);
    if (systemInfo?.members) {
      for (const m of systemInfo.members) {
        if (m.entityId !== entityId) idsToResolve.add(m.entityId);
      }
    }
    const names = await this.resolveEntityNames([...idsToResolve], correlationId);

    const sourceMap = new Map();

    // Sources from links
    for (const rel of (related || [])) {
      if (!sourceMap.has(rel.id)) {
        const info = names.get(rel.id) || {};
        sourceMap.set(rel.id, {
          id: rel.id, name: info.name, description: info.description,
          source: 'link', linkType: rel.links?.[0]?.linkType,
          hasImportedContext: importedMap.has(rel.id)
        });
      }
    }

    // Sources from dependencies
    for (const dep of (deps || [])) {
      if (!sourceMap.has(dep.dependsOnId)) {
        const info = names.get(dep.dependsOnId) || {};
        sourceMap.set(dep.dependsOnId, {
          id: dep.dependsOnId, name: info.name, description: info.description,
          source: 'dependency', dependencyType: dep.dependencyType,
          hasImportedContext: importedMap.has(dep.dependsOnId)
        });
      }
    }

    // Sources from same system
    if (systemInfo && systemInfo.members) {
      for (const member of systemInfo.members) {
        if (member.entityId !== entityId && !sourceMap.has(member.entityId)) {
          const info = names.get(member.entityId) || {};
          sourceMap.set(member.entityId, {
            id: member.entityId, name: info.name, description: info.description,
            source: 'system', role: member.role, systemName: systemInfo.name,
            hasImportedContext: importedMap.has(member.entityId)
          });
        }
      }
    }

    return {
      entityId,
      sources: Array.from(sourceMap.values()),
      importedCount: alreadyImported.length
    };
  }

  // ==================== Full Context Assembly ====================

  async getFullEntityContext(entityId, correlationId) {
    const sharedContext = await this.getSharedContext(entityId, correlationId);

    // Fetch relationship data from composition-manager + parent chain in parallel
    const [deps, related, systemInfo, parentChain] = await Promise.all([
      this.requestComposition('deps.get', { entity_id: entityId }).catch(() => []),
      this.requestComposition('related.get', { entity_id: entityId }).catch(() => []),
      this.requestComposition('entity.system', { entity_id: entityId }).catch(() => null),
      this.getParentChain(entityId, correlationId).catch(() => [])
    ]);

    // Collect all entity IDs that need name resolution
    const idsToResolve = new Set([entityId]);
    if (systemInfo?.members) {
      for (const m of systemInfo.members) idsToResolve.add(m.entityId);
    }
    for (const d of (deps || [])) idsToResolve.add(d.dependsOnId);
    for (const r of (related || [])) idsToResolve.add(r.id);
    for (const s of sharedContext) idsToResolve.add(s.fromEntityId);
    const names = await this.resolveEntityNames([...idsToResolve], correlationId);

    const entityInfo = names.get(entityId) || {};

    let systemSection = null;
    if (systemInfo) {
      systemSection = {
        id: systemInfo.id,
        name: systemInfo.name,
        description: systemInfo.description,
        role: systemInfo.entityRole,
        siblingProjects: (systemInfo.members || [])
          .filter(m => m.entityId !== entityId)
          .map(m => {
            const info = names.get(m.entityId) || {};
            return { id: m.entityId, name: info.name || m.entityId, role: m.role };
          })
      };
    }

    return {
      project: { id: entityId, name: entityInfo.name, description: entityInfo.description },
      parentChain,
      system: systemSection,
      dependencies: (deps || []).map(d => {
        const info = names.get(d.dependsOnId) || {};
        return {
          projectId: d.dependsOnId,
          projectName: info.name || d.dependsOnId,
          type: d.dependencyType,
          description: d.description
        };
      }),
      relatedProjects: (related || []).map(r => {
        const info = names.get(r.id) || {};
        return { id: r.id, name: info.name || r.id, links: r.links };
      }),
      sharedContext: sharedContext.map(s => {
        const info = names.get(s.fromEntityId) || {};
        return {
          fromProject: info.name || s.fromEntityId,
          conversationId: s.conversationId,
          reason: s.reason
        };
      }),
      inheritedContextCount: sharedContext.length
    };
  }

  // ==================== Event Handlers ====================

  /**
   * Generic request/response for other modules
   */
  async onContextRequest(event) {
    const eventData = event.data || event;
    const { request_id, action, correlation_id, ...data } = eventData;

    if (!request_id || !action) return;
    const cid = correlation_id || crypto.randomUUID();

    try {
      let result;
      switch (action) {
        case 'import':
          result = await this.importContext(data.to_entity_id, data.from_entity_id, data.conversation_id, data.reason, cid);
          break;
        case 'remove':
          result = await this.removeSharedContext(data.share_id, cid);
          break;
        case 'shared.get':
          result = await this.getSharedContext(data.entity_id, cid);
          break;
        case 'exported.get':
          result = await this.getExportedContext(data.entity_id, cid);
          break;
        case 'sources.get':
          result = await this.getAvailableContextSources(data.entity_id, cid);
          break;
        case 'full.get':
          result = await this.getFullEntityContext(data.entity_id, cid);
          break;
        default:
          throw new Error(`Unknown context action: ${action}`);
      }

      await this.eventBus.publish('context.response', {
        request_id, success: true, data: result, correlation_id: cid
      });
    } catch (error) {
      this.logger.warn('context-manager.request.failed', { action, error: error.message });
      await this.eventBus.publish('context.response', {
        request_id, success: false, error: error.message, correlation_id: cid
      });
    }
  }

  /**
   * Backward-compatible handler for prompt-composer's context.full.request
   * Maintains the exact same interface: request_id, project_id → context.full.response
   */
  async onContextFullRequest(event) {
    const eventData = event.data || event;
    const { request_id, project_id, correlation_id } = eventData;

    if (!request_id) return;
    const cid = correlation_id || crypto.randomUUID();

    try {
      const fullContext = await this.getFullEntityContext(project_id, cid);

      await this.eventBus.publish('context.full.response', {
        request_id, success: true, context: fullContext, correlation_id: cid
      });
    } catch (error) {
      this.logger.warn('context-manager.full.request.failed', { error: error.message });
      await this.eventBus.publish('context.full.response', {
        request_id, success: false, context: null, error: error.message, correlation_id: cid
      });
    }
  }

  // ==================== UI Handlers ====================

  async handleUIContextImport(data) {
    const { toProjectId, fromProjectId, conversationId, reason } = data;
    if (!toProjectId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Target entity ID is required' };
    if (!fromProjectId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Source entity ID is required' };
    if (!conversationId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Conversation ID is required' };

    const result = await this.importContext(toProjectId, fromProjectId, conversationId, reason, crypto.randomUUID());
    return { imported: true, ...result };
  }

  async handleUIContextRemove(data) {
    const { shareId } = data;
    if (!shareId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Share ID is required' };
    await this.removeSharedContext(shareId, crypto.randomUUID());
    return { removed: true, shareId };
  }

  async handleUIContextGetShared(data) {
    const { projectId } = data;
    if (!projectId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Entity ID is required' };
    const sharedContext = await this.getSharedContext(projectId, crypto.randomUUID());
    return { projectId, sharedContext, count: sharedContext.length };
  }

  async handleUIContextGetExported(data) {
    const { projectId } = data;
    if (!projectId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Entity ID is required' };
    const exportedContext = await this.getExportedContext(projectId, crypto.randomUUID());
    return { projectId, exportedContext, count: exportedContext.length };
  }

  async handleUIContextGetSources(data) {
    const { projectId } = data;
    if (!projectId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Entity ID is required' };
    return await this.getAvailableContextSources(projectId, crypto.randomUUID());
  }

  async handleUIContextGetFull(data) {
    const { projectId } = data;
    if (!projectId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Entity ID is required' };
    return await this.getFullEntityContext(projectId, crypto.randomUUID());
  }
}

module.exports = ContextManagerModule;
