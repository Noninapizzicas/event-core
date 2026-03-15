/**
 * Composition Manager Module
 *
 * Generic entity composition service: systems, links, and dependencies.
 * Works with entity IDs — does not know about projects, prompts, or any specific domain.
 * Any module can use it via events (composition.request/composition.response)
 * or the UI can call it directly via ui_handlers.
 *
 * Tables owned: systems, system_members, project_links, project_dependencies
 */

const crypto = require('crypto');

class CompositionManagerModule {
  constructor() {
    this.name = 'composition-manager';
    this.version = '1.0.0';

    this.logger = null;
    this.eventBus = null;
    this.uiHandler = null;
    this.config = null;

    this.pendingDbRequests = new Map();
  }

  async onLoad(core) {
    this.logger = core.logger;
    this.eventBus = core.eventBus;
    this.uiHandler = core.uiHandler;

    // Load config from loader-injected moduleConfig
    this.config = core.moduleConfig || {};

    this.logger.info('composition-manager.loading');

    await this.initializeSchema();

    this.logger.info('composition-manager.loaded');
  }

  async onUnload() {
    for (const [id, pending] of this.pendingDbRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Module unloading'));
    }
    this.pendingDbRequests.clear();
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

  // ==================== Schema ====================

  async initializeSchema() {
    const cid = crypto.randomUUID();

    await this.queryDatabase(`
      CREATE TABLE IF NOT EXISTS systems (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata TEXT
      )
    `, [], false, cid);

    await this.queryDatabase(`
      CREATE TABLE IF NOT EXISTS system_members (
        system_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        role TEXT,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (system_id, entity_id),
        FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
      )
    `, [], false, cid);

    await this.queryDatabase(`
      CREATE TABLE IF NOT EXISTS project_links (
        id TEXT PRIMARY KEY,
        source_project_id TEXT NOT NULL,
        target_project_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL
      )
    `, [], false, cid);

    await this.queryDatabase(`
      CREATE TABLE IF NOT EXISTS project_dependencies (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        depends_on_project_id TEXT NOT NULL,
        dependency_type TEXT,
        description TEXT,
        created_at TEXT NOT NULL
      )
    `, [], false, cid);

    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_sm_system ON system_members(system_id)',
      'CREATE INDEX IF NOT EXISTS idx_sm_entity ON system_members(entity_id)',
      'CREATE INDEX IF NOT EXISTS idx_links_source ON project_links(source_project_id)',
      'CREATE INDEX IF NOT EXISTS idx_links_target ON project_links(target_project_id)',
      'CREATE INDEX IF NOT EXISTS idx_deps_project ON project_dependencies(project_id)',
      'CREATE INDEX IF NOT EXISTS idx_deps_depends ON project_dependencies(depends_on_project_id)'
    ];
    for (const sql of indexes) {
      try { await this.queryDatabase(sql, [], false, cid); } catch (_) {}
    }

    this.logger.info('composition-manager.schema.initialized');
  }

  // ==================== Systems ====================

  async createSystem(name, description, metadata = {}, correlationId) {
    if (!name || name.trim().length === 0) throw new Error('System name is required');

    const systemId = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.queryDatabase(`
      INSERT INTO systems (id, name, description, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [systemId, name.trim(), description || null, now, now, JSON.stringify(metadata)], false, correlationId);

    await this.eventBus.publish('system.created', {
      system_id: systemId, name: name.trim(), description, created_at: now
    });

    return { id: systemId, name: name.trim(), description: description || '', metadata, createdAt: now, updatedAt: now, projects: [] };
  }

  async getSystem(systemId, correlationId) {
    const systems = await this.queryDatabase(
      'SELECT * FROM systems WHERE id = ?', [systemId], true, correlationId
    );
    if (systems.length === 0) return null;

    const system = systems[0];
    const members = await this.queryDatabase(
      'SELECT entity_id, role, joined_at FROM system_members WHERE system_id = ? ORDER BY role, joined_at',
      [systemId], true, correlationId
    );

    return {
      id: system.id,
      name: system.name,
      description: system.description || '',
      metadata: system.metadata ? JSON.parse(system.metadata) : {},
      createdAt: system.created_at,
      updatedAt: system.updated_at,
      members: members.map(m => ({ entityId: m.entity_id, role: m.role, joinedAt: m.joined_at })),
      // Backward-compat: 'projects' alias used by project-manager & context-manager
      projects: members.map(m => ({ id: m.entity_id, role: m.role }))
    };
  }

  async listSystems(correlationId) {
    const systems = await this.queryDatabase(`
      SELECT s.*, COUNT(sm.entity_id) as member_count
      FROM systems s LEFT JOIN system_members sm ON sm.system_id = s.id
      GROUP BY s.id ORDER BY s.name
    `, [], true, correlationId);

    return systems.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description || '',
      metadata: s.metadata ? JSON.parse(s.metadata) : {},
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      projectCount: s.member_count || 0
    }));
  }

  async updateSystem(systemId, updates, correlationId) {
    const system = await this.getSystem(systemId, correlationId);
    if (!system) throw new Error(`System not found: ${systemId}`);

    const now = new Date().toISOString();
    const parts = ['updated_at = ?'];
    const params = [now];

    if (updates.name !== undefined) { parts.push('name = ?'); params.push(updates.name.trim()); }
    if (updates.description !== undefined) { parts.push('description = ?'); params.push(updates.description); }
    if (updates.metadata !== undefined) { parts.push('metadata = ?'); params.push(JSON.stringify(updates.metadata)); }

    params.push(systemId);
    await this.queryDatabase(`UPDATE systems SET ${parts.join(', ')} WHERE id = ?`, params, false, correlationId);

    await this.eventBus.publish('system.updated', {
      system_id: systemId, updated_fields: Object.keys(updates), updated_at: now
    });

    return await this.getSystem(systemId, correlationId);
  }

  async deleteSystem(systemId, correlationId) {
    const system = await this.getSystem(systemId, correlationId);
    if (!system) throw new Error(`System not found: ${systemId}`);

    await this.queryDatabase('DELETE FROM system_members WHERE system_id = ?', [systemId], false, correlationId);
    await this.queryDatabase('DELETE FROM systems WHERE id = ?', [systemId], false, correlationId);

    await this.eventBus.publish('system.deleted', {
      system_id: systemId, name: system.name,
      affected_members: system.members.length,
      deleted_at: new Date().toISOString()
    });

    return { success: true, systemId, affectedProjects: system.members.length };
  }

  async addEntityToSystem(systemId, entityId, role, correlationId) {
    const system = await this.getSystem(systemId, correlationId);
    if (!system) throw new Error(`System not found: ${systemId}`);

    // Check if entity already in a system
    const existing = await this.queryDatabase(
      'SELECT system_id FROM system_members WHERE entity_id = ?',
      [entityId], true, correlationId
    );
    if (existing.length > 0 && existing[0].system_id !== systemId) {
      throw new Error('Entity is already in another system');
    }
    if (existing.length > 0 && existing[0].system_id === systemId) {
      return { entityId, systemId, systemName: system.name, role };
    }

    const now = new Date().toISOString();
    await this.queryDatabase(
      'INSERT INTO system_members (system_id, entity_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [systemId, entityId, role || null, now], false, correlationId
    );

    await this.eventBus.publish('entity.joined_system', {
      entity_id: entityId, system_id: systemId,
      system_name: system.name, role, joined_at: now
    });

    return { entityId, systemId, systemName: system.name, role };
  }

  async removeEntityFromSystem(entityId, correlationId) {
    const membership = await this.queryDatabase(
      'SELECT system_id, role FROM system_members WHERE entity_id = ?',
      [entityId], true, correlationId
    );
    if (membership.length === 0) throw new Error('Entity is not in any system');

    const { system_id: systemId, role } = membership[0];
    await this.queryDatabase(
      'DELETE FROM system_members WHERE entity_id = ?',
      [entityId], false, correlationId
    );

    await this.eventBus.publish('entity.left_system', {
      entity_id: entityId, system_id: systemId,
      previous_role: role, left_at: new Date().toISOString()
    });

    return { entityId, previousSystemId: systemId, previousRole: role };
  }

  async getEntitySystem(entityId, correlationId) {
    const membership = await this.queryDatabase(
      'SELECT system_id, role FROM system_members WHERE entity_id = ?',
      [entityId], true, correlationId
    );
    if (membership.length === 0) return null;

    const system = await this.getSystem(membership[0].system_id, correlationId);
    return system ? { ...system, entityRole: membership[0].role } : null;
  }

  async getUnassignedEntities(entityIds, correlationId) {
    if (!entityIds || entityIds.length === 0) return [];
    const placeholders = entityIds.map(() => '?').join(',');
    const assigned = await this.queryDatabase(
      `SELECT entity_id FROM system_members WHERE entity_id IN (${placeholders})`,
      entityIds, true, correlationId
    );
    const assignedSet = new Set(assigned.map(r => r.entity_id));
    return entityIds.filter(id => !assignedSet.has(id));
  }

  // ==================== Links ====================

  async linkEntities(sourceId, targetId, linkType, reason, correlationId) {
    if (sourceId === targetId) throw new Error('Cannot link an entity to itself');

    const existing = await this.queryDatabase(
      `SELECT id FROM project_links WHERE source_project_id = ? AND target_project_id = ? AND link_type = ?`,
      [sourceId, targetId, linkType], true, correlationId
    );
    if (existing.length > 0) throw new Error(`Link already exists with type '${linkType}'`);

    const linkId = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.queryDatabase(`
      INSERT INTO project_links (id, source_project_id, target_project_id, link_type, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [linkId, sourceId, targetId, linkType, reason || null, now], false, correlationId);

    await this.eventBus.publish('entity.linked', {
      link_id: linkId, source_id: sourceId, target_id: targetId,
      link_type: linkType, reason, created_at: now
    });

    return { id: linkId, sourceId, targetId, linkType, reason, createdAt: now };
  }

  async unlinkEntities(linkId, correlationId) {
    const links = await this.queryDatabase(
      'SELECT * FROM project_links WHERE id = ?', [linkId], true, correlationId
    );
    if (links.length === 0) throw new Error(`Link not found: ${linkId}`);

    await this.queryDatabase('DELETE FROM project_links WHERE id = ?', [linkId], false, correlationId);

    await this.eventBus.publish('entity.unlinked', {
      link_id: linkId,
      source_id: links[0].source_project_id,
      target_id: links[0].target_project_id,
      unlinked_at: new Date().toISOString()
    });

    return { success: true, linkId };
  }

  async getEntityLinks(entityId, correlationId) {
    const links = await this.queryDatabase(`
      SELECT * FROM project_links
      WHERE source_project_id = ? OR target_project_id = ?
      ORDER BY created_at DESC
    `, [entityId, entityId], true, correlationId);

    return links.map(l => ({
      id: l.id,
      sourceId: l.source_project_id,
      targetId: l.target_project_id,
      linkType: l.link_type,
      reason: l.reason,
      createdAt: l.created_at,
      direction: l.source_project_id === entityId ? 'outgoing' : 'incoming'
    }));
  }

  async getRelatedEntities(entityId, correlationId) {
    const links = await this.getEntityLinks(entityId, correlationId);
    const relatedIds = new Set();
    for (const l of links) {
      if (l.sourceId !== entityId) relatedIds.add(l.sourceId);
      if (l.targetId !== entityId) relatedIds.add(l.targetId);
    }

    const related = [];
    for (const relatedId of relatedIds) {
      const connectingLinks = links.filter(
        l => l.sourceId === relatedId || l.targetId === relatedId
      );
      related.push({
        id: relatedId,
        links: connectingLinks.map(l => ({
          linkType: l.linkType, reason: l.reason,
          direction: l.sourceId === entityId ? 'outgoing' : 'incoming'
        }))
      });
    }
    return related;
  }

  // ==================== Dependencies ====================

  async addDependency(entityId, dependsOnId, dependencyType, description, correlationId) {
    if (entityId === dependsOnId) throw new Error('An entity cannot depend on itself');

    const existing = await this.queryDatabase(
      `SELECT id FROM project_dependencies WHERE project_id = ? AND depends_on_project_id = ?`,
      [entityId, dependsOnId], true, correlationId
    );
    if (existing.length > 0) throw new Error('Dependency already exists');

    const depId = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.queryDatabase(`
      INSERT INTO project_dependencies (id, project_id, depends_on_project_id, dependency_type, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [depId, entityId, dependsOnId, dependencyType || 'data', description || null, now], false, correlationId);

    await this.eventBus.publish('entity.dependency.added', {
      dependency_id: depId, entity_id: entityId,
      depends_on_id: dependsOnId, dependency_type: dependencyType,
      description, created_at: now
    });

    return { id: depId, entityId, dependsOnId, dependencyType: dependencyType || 'data', description, createdAt: now };
  }

  async removeDependency(dependencyId, correlationId) {
    const deps = await this.queryDatabase(
      'SELECT * FROM project_dependencies WHERE id = ?', [dependencyId], true, correlationId
    );
    if (deps.length === 0) throw new Error(`Dependency not found: ${dependencyId}`);

    await this.queryDatabase('DELETE FROM project_dependencies WHERE id = ?', [dependencyId], false, correlationId);

    await this.eventBus.publish('entity.dependency.removed', {
      dependency_id: dependencyId,
      entity_id: deps[0].project_id,
      depends_on_id: deps[0].depends_on_project_id,
      removed_at: new Date().toISOString()
    });

    return { success: true, dependencyId };
  }

  async getDependencies(entityId, correlationId) {
    const deps = await this.queryDatabase(`
      SELECT * FROM project_dependencies WHERE project_id = ? ORDER BY created_at DESC
    `, [entityId], true, correlationId);

    return deps.map(d => ({
      id: d.id,
      entityId: d.project_id,
      dependsOnId: d.depends_on_project_id,
      dependencyType: d.dependency_type,
      description: d.description,
      createdAt: d.created_at
    }));
  }

  async getDependents(entityId, correlationId) {
    const deps = await this.queryDatabase(`
      SELECT * FROM project_dependencies WHERE depends_on_project_id = ? ORDER BY created_at DESC
    `, [entityId], true, correlationId);

    return deps.map(d => ({
      id: d.id,
      dependentId: d.project_id,
      dependencyType: d.dependency_type,
      description: d.description,
      createdAt: d.created_at
    }));
  }

  async hasDependents(entityId, correlationId) {
    const dependents = await this.getDependents(entityId, correlationId);
    return {
      hasDependents: dependents.length > 0,
      count: dependents.length,
      dependents: dependents.map(d => ({ id: d.dependentId }))
    };
  }

  // ==================== Event Handler: composition.request ====================

  async onCompositionRequest(event) {
    const eventData = event.data || event;
    const { request_id, action, correlation_id, ...data } = eventData;

    if (!request_id || !action) return;

    const cid = correlation_id || crypto.randomUUID();

    try {
      let result;
      switch (action) {
        case 'system.create':
          result = await this.createSystem(data.name, data.description, data.metadata, cid);
          break;
        case 'system.get':
          result = await this.getSystem(data.system_id, cid);
          break;
        case 'system.list':
          result = await this.listSystems(cid);
          break;
        case 'system.update':
          result = await this.updateSystem(data.system_id, data.updates, cid);
          break;
        case 'system.delete':
          result = await this.deleteSystem(data.system_id, cid);
          break;
        case 'entity.join':
          result = await this.addEntityToSystem(data.system_id, data.entity_id, data.role, cid);
          break;
        case 'entity.leave':
          result = await this.removeEntityFromSystem(data.entity_id, cid);
          break;
        case 'entity.system':
          result = await this.getEntitySystem(data.entity_id, cid);
          break;
        case 'entity.unassigned':
          result = await this.getUnassignedEntities(data.entity_ids, cid);
          break;
        case 'link':
          result = await this.linkEntities(data.source_id, data.target_id, data.link_type, data.reason, cid);
          break;
        case 'unlink':
          result = await this.unlinkEntities(data.link_id, cid);
          break;
        case 'links.get':
          result = await this.getEntityLinks(data.entity_id, cid);
          break;
        case 'related.get':
          result = await this.getRelatedEntities(data.entity_id, cid);
          break;
        case 'dep.add':
          result = await this.addDependency(data.entity_id, data.depends_on_id, data.dependency_type, data.description, cid);
          break;
        case 'dep.remove':
          result = await this.removeDependency(data.dependency_id, cid);
          break;
        case 'deps.get':
          result = await this.getDependencies(data.entity_id, cid);
          break;
        case 'dependents.get':
          result = await this.getDependents(data.entity_id, cid);
          break;
        case 'dependents.has':
          result = await this.hasDependents(data.entity_id, cid);
          break;
        default:
          throw new Error(`Unknown composition action: ${action}`);
      }

      await this.eventBus.publish('composition.response', {
        request_id, success: true, data: result, correlation_id: cid
      });
    } catch (error) {
      this.logger.warn('composition-manager.request.failed', { action, error: error.message });
      await this.eventBus.publish('composition.response', {
        request_id, success: false, error: error.message, correlation_id: cid
      });
    }
  }

  // ==================== UI Handlers: Systems ====================

  async handleUISystemCreate(data) {
    const { name, description, metadata } = data;
    if (!name || name.trim().length === 0) throw { status: 400, code: 'VALIDATION_ERROR', message: 'System name is required' };
    return { created: true, system: await this.createSystem(name, description, metadata, crypto.randomUUID()) };
  }

  async handleUISystemList() {
    const systems = await this.listSystems(crypto.randomUUID());
    return { systems, count: systems.length };
  }

  async handleUISystemGet(data) {
    const { id } = data;
    if (!id) throw { status: 400, code: 'VALIDATION_ERROR', message: 'System ID is required' };
    const system = await this.getSystem(id, crypto.randomUUID());
    if (!system) throw { status: 404, code: 'NOT_FOUND', message: 'System not found' };
    return { system };
  }

  async handleUISystemUpdate(data) {
    const { id, name, description, metadata } = data;
    if (!id) throw { status: 400, code: 'VALIDATION_ERROR', message: 'System ID is required' };
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (metadata !== undefined) updates.metadata = metadata;
    return { updated: true, system: await this.updateSystem(id, updates, crypto.randomUUID()) };
  }

  async handleUISystemDelete(data) {
    const { id } = data;
    if (!id) throw { status: 400, code: 'VALIDATION_ERROR', message: 'System ID is required' };
    return { deleted: true, ...await this.deleteSystem(id, crypto.randomUUID()) };
  }

  async handleUISystemAddEntity(data) {
    const { systemId, projectId, role } = data;
    if (!systemId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'System ID is required' };
    if (!projectId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    const result = await this.addEntityToSystem(systemId, projectId, role, crypto.randomUUID());
    return { added: true, ...result };
  }

  async handleUISystemRemoveEntity(data) {
    const { projectId } = data;
    if (!projectId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Project ID is required' };
    return { removed: true, ...await this.removeEntityFromSystem(projectId, crypto.randomUUID()) };
  }

  async handleUISystemGetUnassigned(data) {
    const { entityIds } = data;
    const unassigned = await this.getUnassignedEntities(entityIds || [], crypto.randomUUID());
    return { entityIds: unassigned, count: unassigned.length };
  }

  // ==================== UI Handlers: Links ====================

  async handleUILink(data) {
    const { sourceId, targetId, linkType, reason } = data;
    if (!sourceId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Source ID is required' };
    if (!targetId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Target ID is required' };
    if (!linkType) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Link type is required' };

    const validTypes = ['inspired_by', 'related_to', 'evolved_from'];
    if (!validTypes.includes(linkType)) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: `Invalid link type. Must be one of: ${validTypes.join(', ')}` };
    }

    const link = await this.linkEntities(sourceId, targetId, linkType, reason, crypto.randomUUID());
    return { linked: true, link };
  }

  async handleUIUnlink(data) {
    const { linkId } = data;
    if (!linkId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Link ID is required' };
    await this.unlinkEntities(linkId, crypto.randomUUID());
    return { unlinked: true, linkId };
  }

  async handleUIGetLinks(data) {
    const { id } = data;
    if (!id) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Entity ID is required' };
    const links = await this.getEntityLinks(id, crypto.randomUUID());
    return { projectId: id, links, count: links.length };
  }

  async handleUIGetRelated(data) {
    const { id } = data;
    if (!id) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Entity ID is required' };
    const relatedEntities = await this.getRelatedEntities(id, crypto.randomUUID());
    return { projectId: id, relatedProjects: relatedEntities, count: relatedEntities.length };
  }

  // ==================== UI Handlers: Dependencies ====================

  async handleUIAddDependency(data) {
    const { projectId, dependsOnProjectId, dependencyType, description } = data;
    if (!projectId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Entity ID is required' };
    if (!dependsOnProjectId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Depends-on entity ID is required' };

    const validTypes = ['data', 'code', 'api', 'context'];
    if (dependencyType && !validTypes.includes(dependencyType)) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: `Invalid dependency type. Must be one of: ${validTypes.join(', ')}` };
    }

    const dependency = await this.addDependency(projectId, dependsOnProjectId, dependencyType, description, crypto.randomUUID());
    return { added: true, dependency };
  }

  async handleUIRemoveDependency(data) {
    const { dependencyId } = data;
    if (!dependencyId) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Dependency ID is required' };
    await this.removeDependency(dependencyId, crypto.randomUUID());
    return { removed: true, dependencyId };
  }

  async handleUIGetDependencies(data) {
    const { id } = data;
    if (!id) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Entity ID is required' };
    const dependencies = await this.getDependencies(id, crypto.randomUUID());
    return { projectId: id, dependencies, count: dependencies.length };
  }

  async handleUIGetDependents(data) {
    const { id } = data;
    if (!id) throw { status: 400, code: 'VALIDATION_ERROR', message: 'Entity ID is required' };
    const dependents = await this.getDependents(id, crypto.randomUUID());
    return { projectId: id, dependents, count: dependents.length };
  }
}

module.exports = CompositionManagerModule;
