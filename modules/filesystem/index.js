/**
 * Filesystem Module
 * Core filesystem operations for the entire system
 *
 * Provides unified access for:
 * - UI (via mqttRequest)
 * - AI (via tools/function calling)
 * - Other modules (via eventBus)
 */

const fs = require('fs').promises;
const path = require('path');

class FilesystemModule {
  constructor() {
    this.name = 'filesystem';
    this.version = '1.0.0';
    this.basePath = path.join(process.cwd(), 'data');

    // Dependencies (injected)
    this.logger = null;
    this.eventBus = null;
    this.uiHandler = null;

    // Active project context
    this.activeProjectId = null;
    this.activeProjectPath = null;  // /data/projects/paco/storage
    this.workingDirectory = null;   // Current working dir (defaults to project storage)
    this.systemMode = false;        // true when "Sistema" project is active (full system access)

    // Unsubscribe functions
    this.unsubscribes = [];
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(context) {
    this.logger = context.logger;
    this.eventBus = context.eventBus;
    this.uiHandler = context.uiHandler;

    // Ensure base data directory exists
    await this.ensureDataDirectory();

    // Event subscriptions and UI handlers are auto-wired by the loader from module.json

    this.logger.info('filesystem.loaded', {
      basePath: this.basePath
    });
  }

  async onUnload() {
    // Event subscriptions and UI handlers are auto-cleaned by the loader
    this.logger.info('filesystem.unloaded');
  }

  // ==========================================
  // Project Context
  // ==========================================

  /**
   * Handle project activation - set working directory to project storage
   */
  async onProjectActivated(event) {
    const data = event.data || event;
    const { project_id, base_path, name, metadata } = data;

    this.logger.debug('filesystem.project.activating', {
      project_id,
      base_path,
      name,
      is_system: metadata?.is_system,
      raw_event: JSON.stringify(data).slice(0, 200)
    });

    this.activeProjectId = project_id;

    // Detect system project: gets access to the entire event-core root
    if (metadata?.is_system === true) {
      this.systemMode = true;
      this.activeProjectPath = process.cwd(); // Full system root
      this.workingDirectory = process.cwd();

      this.logger.info('filesystem.project.activated.system_mode', {
        project_id,
        project_name: name,
        system_root: process.cwd()
      });
      return;
    }

    this.systemMode = false;

    if (base_path) {
      // New structure: use storage subdirectory
      this.activeProjectPath = path.join(base_path, 'storage');
    } else {
      // Legacy structure - try to find by project ID
      this.activeProjectPath = path.join(this.basePath, 'projects', project_id);
      this.logger.warn('filesystem.project.no_base_path', {
        project_id,
        fallback_path: this.activeProjectPath
      });
    }

    // Set working directory to project storage by default
    this.workingDirectory = this.activeProjectPath;

    // Ensure directory exists
    await fs.mkdir(this.activeProjectPath, { recursive: true }).catch(() => {});

    this.logger.info('filesystem.project.activated', {
      project_id,
      project_name: name,
      active_project_path: this.activeProjectPath,
      working_directory: this.workingDirectory
    });
  }

  /**
   * Handle project deactivation - reset to global data directory
   */
  async onProjectDeactivated(event) {
    const previousProject = this.activeProjectId;

    this.activeProjectId = null;
    this.activeProjectPath = null;
    this.workingDirectory = null;
    this.systemMode = false;

    this.logger.info('filesystem.project.deactivated', {
      previous_project: previousProject
    });
  }

  // ==========================================
  // Request Event Handlers (for agents)
  // ==========================================

  async onWriteRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, path, content, encoding } = data;

    this.logger.info('fs.write.request', { path, request_id });

    const result = await this.handleWrite({ path, content, encoding });

    await this.eventBus.publish('fs.write.response', {
      request_id,
      ...result
    });
  }

  async onCopyRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, from, source, to, destination } = data;

    // Support both naming conventions
    const fromPath = from || source;
    const toPath = to || destination;

    this.logger.info('fs.copy.request', { from: fromPath, to: toPath, request_id });

    const result = await this.handleCopy({ from: fromPath, to: toPath });

    await this.eventBus.publish('fs.copy.response', {
      request_id,
      ...result
    });
  }

  async onReadRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, path } = data;

    this.logger.info('fs.read.request', { path, request_id });

    const result = await this.handleRead({ path });

    await this.eventBus.publish('fs.read.response', {
      request_id,
      ...result
    });
  }

  async onDeleteRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, path } = data;

    this.logger.info('fs.delete.request', { path, request_id });

    const result = await this.handleDelete({ path });

    await this.eventBus.publish('fs.delete.response', {
      request_id,
      ...result
    });
  }

  async onListRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, path } = data;

    this.logger.info('fs.list.request', { path, request_id });

    const result = await this.handleList({ path });

    await this.eventBus.publish('fs.list.response', {
      request_id,
      ...result
    });
  }

  async onMkdirRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, path } = data;

    this.logger.info('fs.mkdir.request', { path, request_id });

    const result = await this.handleMkdir({ path });

    await this.eventBus.publish('fs.mkdir.response', {
      request_id,
      ...result
    });
  }

  async onMoveRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, from, source, to, destination } = data;

    const fromPath = from || source;
    const toPath = to || destination;

    this.logger.info('fs.move.request', { from: fromPath, to: toPath, request_id });

    const result = await this.handleMove({ from: fromPath, to: toPath });

    // Respond to both move and rename events
    const responseEvent = event?.event?.includes('rename') ? 'fs.rename.response' : 'fs.move.response';
    await this.eventBus.publish(responseEvent, {
      request_id,
      ...result
    });
  }

  async onExistsRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, path } = data;

    this.logger.info('fs.exists.request', { path, request_id });

    try {
      const safePath = this.validatePath(path);
      const stats = await fs.stat(safePath);

      await this.eventBus.publish('fs.exists.response', {
        request_id,
        success: true,
        exists: true,
        path,
        type: stats.isDirectory() ? 'directory' : 'file'
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        await this.eventBus.publish('fs.exists.response', {
          request_id,
          success: true,
          exists: false,
          path
        });
      } else {
        await this.eventBus.publish('fs.exists.response', {
          request_id,
          success: false,
          error: error.message
        });
      }
    }
  }

  async onInfoRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, path } = data;

    this.logger.info('fs.info.request', { path, request_id });

    const result = await this.handleInfo({ path });

    await this.eventBus.publish('fs.info.response', {
      request_id,
      ...result
    });
  }

  async onAppendRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, path, content, encoding } = data;

    this.logger.info('fs.append.request', { path, request_id });

    try {
      const safePath = this.validatePath(path);

      // Ensure directory exists
      await fs.mkdir(require('path').dirname(safePath), { recursive: true });

      // Append to file
      await fs.appendFile(safePath, content, encoding || 'utf-8');

      const stats = await fs.stat(safePath);

      await this.eventBus.publish('fs.append.response', {
        request_id,
        success: true,
        message: `Content appended to ${path}`,
        path,
        size: stats.size
      });
    } catch (error) {
      await this.eventBus.publish('fs.append.response', {
        request_id,
        success: false,
        error: error.message
      });
    }
  }

  async onSearchRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, query, path, content } = data;

    this.logger.info('fs.search.request', { query, path, request_id });

    const result = await this.handleSearch({ query, path, content });

    await this.eventBus.publish('fs.search.response', {
      request_id,
      ...result
    });
  }

  async onStatsRequest(event) {
    const data = event?.data || event?.payload || event;
    const { request_id, path } = data;

    this.logger.info('fs.stats.request', { path, request_id });

    const result = await this.handleStats({ path });

    await this.eventBus.publish('fs.stats.response', {
      request_id,
      ...result
    });
  }

  /**
   * Get current working directory (for display/info)
   */
  getEffectiveWorkingDirectory() {
    return this.workingDirectory || this.basePath;
  }

  /**
   * Handle setting custom working directory
   */
  async handleSetWorkDir(data) {
    try {
      const requestedPath = data.path || '/';

      // Validate the path is within basePath
      const safePath = this.validatePath(requestedPath);

      // Check it exists and is a directory
      const stats = await fs.stat(safePath);
      if (!stats.isDirectory()) {
        return { success: false, error: 'Path is not a directory' };
      }

      this.workingDirectory = safePath;

      this.logger.info('filesystem.workdir.changed', {
        new_workdir: safePath,
        relative: this.toRelativePath(safePath)
      });

      return {
        success: true,
        working_directory: this.toRelativePath(safePath),
        absolute_path: safePath
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle getting current working directory info
   */
  async handleGetWorkDir(data) {
    const workDir = this.getEffectiveWorkingDirectory();

    return {
      success: true,
      working_directory: this.toRelativePath(workDir),
      absolute_path: workDir,
      project_id: this.activeProjectId,
      is_project_context: !!this.activeProjectId
    };
  }

  async ensureDataDirectory() {
    try {
      await fs.mkdir(this.basePath, { recursive: true });
    } catch (error) {
      this.logger.error('filesystem.ensureDataDirectory.error', { error: error.message });
    }
  }

  // ==========================================
  // Security
  // ==========================================

  /**
   * Validates that a path is within the allowed data directory
   * Prevents path traversal attacks
   *
   * Path resolution (when project is active):
   * - "/" or relative paths resolve from project storage
   * - "@/" prefix accesses global data root (system access)
   *
   * Path resolution (no active project):
   * - All paths resolve from global data root
   */
  validatePath(userPath, options = {}) {
    const inputPath = userPath || '/';

    let resolved;

    // Check for global data root access with @/ prefix
    if (inputPath.startsWith('@/') || inputPath === '@') {
      // Global data root access (bypass project context)
      const relativePart = inputPath === '@' ? '' : inputPath.slice(2);
      const normalized = path.normalize(relativePart).replace(/^\/+/, '');
      resolved = path.resolve(this.basePath, normalized);
    } else if (this.activeProjectPath) {
      // Project is active - all paths resolve from project storage (or system root)
      if (inputPath.startsWith('/')) {
        const normalized = path.normalize(inputPath).replace(/^\/+/, '');
        resolved = path.resolve(this.activeProjectPath, normalized);
      } else if (inputPath === '~' || inputPath.startsWith('~/')) {
        // "~" is alias for project storage root (same as "/")
        const relativePart = inputPath === '~' ? '' : inputPath.slice(2);
        resolved = path.resolve(this.activeProjectPath, relativePart);
      } else {
        // Relative path from working directory
        const workDir = this.getEffectiveWorkingDirectory();
        resolved = path.resolve(workDir, inputPath);
      }
    } else {
      // No active project - resolve from global data root
      if (inputPath.startsWith('/')) {
        const normalized = path.normalize(inputPath).replace(/^\/+/, '');
        resolved = path.resolve(this.basePath, normalized);
      } else {
        resolved = path.resolve(this.basePath, inputPath);
      }
    }

    // Security check: determine allowed root
    const allowedRoot = this.systemMode ? process.cwd() : this.basePath;
    if (!resolved.startsWith(allowedRoot)) {
      const error = new Error(`Access denied: path outside ${this.systemMode ? 'system' : 'data'} directory`);
      error.status = 403;
      error.code = 'PATH_TRAVERSAL';
      throw error;
    }

    return resolved;
  }

  /**
   * Converts absolute path back to relative path for responses
   * When a project is active, shows path relative to project storage
   */
  toRelativePath(absolutePath) {
    if (this.systemMode && absolutePath.startsWith(process.cwd())) {
      // System mode - show relative to system root
      const relativePath = path.relative(process.cwd(), absolutePath).replace(/\\/g, '/');
      return '/' + relativePath;
    }
    if (this.activeProjectPath && absolutePath.startsWith(this.activeProjectPath)) {
      // Path within project storage - show relative to project
      const relativePath = path.relative(this.activeProjectPath, absolutePath).replace(/\\/g, '/');
      return '/' + relativePath;
    }
    // Global path - show with @/ prefix to indicate it's outside project
    const relativePath = path.relative(this.basePath, absolutePath).replace(/\\/g, '/');
    return this.activeProjectPath ? '@/' + relativePath : '/' + relativePath;
  }

  // ==========================================
  // Handlers
  // ==========================================

  /**
   * List files and directories
   */
  async handleList(data) {
    this.logger.info('filesystem.list.called', { data, path: data?.path });
    try {
      const dirPath = data?.path || '/';
      const safePath = this.validatePath(dirPath);

      // Check if directory exists
      try {
        const stats = await fs.stat(safePath);
        if (!stats.isDirectory()) {
          return { status: 400, error: 'Path is not a directory' };
        }
      } catch (e) {
        if (e.code === 'ENOENT') {
          return { status: 404, error: 'Directory not found' };
        }
        throw e;
      }

      const entries = await fs.readdir(safePath, { withFileTypes: true });
      const items = await Promise.all(entries.map(async (entry) => {
        const fullPath = path.join(safePath, entry.name);
        try {
          const stats = await fs.stat(fullPath);
          const ext = entry.isDirectory() ? null : path.extname(entry.name).toLowerCase();
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stats.size,
            modified: stats.mtime,
            path: path.join(dirPath, entry.name).replace(/\\/g, '/'),
            extension: ext
          };
        } catch (e) {
          // Skip files we can't stat
          return null;
        }
      }));

      // Filter nulls and sort: directories first, then alphabetical
      const validItems = items.filter(item => item !== null);
      validItems.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      // Return data directly - UIRequestHandler wraps it in { status, success, data }
      const result = {
        success: true,
        message: `Directorio listado: ${dirPath} (${validItems.length} elementos)`,
        path: dirPath,
        files: validItems,
        items: validItems, // backwards compatibility
        count: validItems.length,
        root_mode: !data?.project_id
      };
      this.logger.info('filesystem.list.response', { path: dirPath, count: validItems.length, files: validItems.map(f => f.name) });
      return result;

    } catch (error) {
      this.logger.error('filesystem.list.error', { error: error.message, path: data?.path });
      return { status: error.status || 500, error: error.message };
    }
  }

  /**
   * Read file content
   */
  async handleRead(data) {
    try {
      if (!data?.path) {
        return { status: 400, error: 'path is required' };
      }

      const safePath = this.validatePath(data.path);

      // Check if file exists and is not a directory
      const stats = await fs.stat(safePath);
      if (stats.isDirectory()) {
        return { status: 400, error: 'Cannot read directory as file' };
      }

      // Check file size (limit to 10MB for text reading)
      const maxSize = 10 * 1024 * 1024;
      if (stats.size > maxSize) {
        return { status: 413, error: `File too large. Max size: ${maxSize / (1024 * 1024)}MB` };
      }

      // Detect if binary or text
      const ext = path.extname(data.path).toLowerCase();
      const binaryExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.tar', '.gz'];

      if (binaryExts.includes(ext)) {
        // Return base64 for binary files
        const buffer = await fs.readFile(safePath);
        return {
          path: data.path,
          content: buffer.toString('base64'),
          encoding: 'base64',
          size: stats.size,
          modified: stats.mtime,
          type: 'binary'
        };
      }

      // Text file
      const content = await fs.readFile(safePath, 'utf-8');

      return {
        success: true,
        message: `Archivo leído: ${data.path} (${stats.size} bytes)`,
        path: data.path,
        content,
        encoding: 'utf-8',
        size: stats.size,
        modified: stats.mtime,
        type: 'text'
      };

    } catch (error) {
      if (error.code === 'ENOENT') {
        return { status: 404, error: 'File not found' };
      }
      this.logger.error('filesystem.read.error', { error: error.message, path: data?.path });
      return { status: error.status || 500, error: error.message };
    }
  }

  /**
   * Write content to file (creates if not exists)
   */
  async handleWrite(data) {
    try {
      const filePath = data?.path || data?.file_path;
      if (!filePath) {
        return { status: 400, error: 'path is required' };
      }
      if (data.content === undefined) {
        return { status: 400, error: 'content is required' };
      }

      const safePath = this.validatePath(filePath);

      // Create parent directory if needed
      await fs.mkdir(path.dirname(safePath), { recursive: true });

      // Check if file exists (for event type)
      let isNew = false;
      try {
        await fs.stat(safePath);
      } catch (e) {
        if (e.code === 'ENOENT') isNew = true;
      }

      // Write file - support base64 encoding for binary files
      let contentBuffer;
      let fileSize;
      if (data.encoding === 'base64') {
        contentBuffer = Buffer.from(data.content, 'base64');
        fileSize = contentBuffer.length;
      } else {
        contentBuffer = data.content;
        fileSize = Buffer.byteLength(data.content, 'utf-8');
      }
      await fs.writeFile(safePath, contentBuffer, data.encoding === 'base64' ? undefined : 'utf-8');

      // Publish event
      const eventType = isNew ? 'fs.file.created' : 'fs.file.updated';
      await this.eventBus.publish(eventType, {
        path: filePath,
        size: fileSize,
        timestamp: new Date().toISOString()
      });

      this.logger.info('filesystem.write.success', { path: filePath, isNew, encoding: data.encoding || 'utf-8' });

      // Return data directly - UIRequestHandler wraps it
      return {
        success: true,
        message: isNew
          ? `Archivo creado exitosamente: ${filePath}`
          : `Archivo actualizado exitosamente: ${filePath}`,
        path: filePath,
        file_path: filePath,
        created: isNew,
        size: fileSize
      };

    } catch (error) {
      this.logger.error('filesystem.write.error', { error: error.message, path: data?.path });
      return { status: error.status || 500, error: error.message };
    }
  }

  /**
   * Delete file or directory
   */
  async handleDelete(data) {
    try {
      const filePath = data?.path || data?.file_path;
      if (!filePath) {
        return { status: 400, error: 'path is required' };
      }

      // Prevent deleting root
      if (filePath === '/' || filePath === '') {
        return { status: 403, error: 'Cannot delete root directory' };
      }

      const safePath = this.validatePath(filePath);

      const stats = await fs.stat(safePath);
      const isDirectory = stats.isDirectory();

      if (isDirectory) {
        await fs.rm(safePath, { recursive: true });
      } else {
        await fs.unlink(safePath);
      }

      // Publish event
      await this.eventBus.publish('fs.file.deleted', {
        path: filePath,
        type: isDirectory ? 'directory' : 'file',
        timestamp: new Date().toISOString()
      });

      this.logger.info('filesystem.delete.success', { path: filePath, type: isDirectory ? 'directory' : 'file' });

      return {
        success: true,
        message: `${isDirectory ? 'Directorio' : 'Archivo'} eliminado: ${filePath}`,
        path: filePath,
        file_path: filePath,
        deleted: true,
        type: isDirectory ? 'directory' : 'file'
      };

    } catch (error) {
      if (error.code === 'ENOENT') {
        return { status: 404, error: 'Path not found' };
      }
      this.logger.error('filesystem.delete.error', { error: error.message, path: data?.path });
      return { status: error.status || 500, error: error.message };
    }
  }

  /**
   * Create directory
   */
  async handleMkdir(data) {
    try {
      if (!data?.path) {
        return { status: 400, error: 'path is required' };
      }

      const safePath = this.validatePath(data.path);

      await fs.mkdir(safePath, { recursive: true });

      // Publish event
      await this.eventBus.publish('fs.directory.created', {
        path: data.path,
        timestamp: new Date().toISOString()
      });

      this.logger.info('filesystem.mkdir.success', { path: data.path });

      return {
        success: true,
        message: `Directorio creado: ${data.path}`,
        path: data.path,
        created: true
      };

    } catch (error) {
      this.logger.error('filesystem.mkdir.error', { error: error.message, path: data?.path });
      return { status: error.status || 500, error: error.message };
    }
  }

  /**
   * Move file or directory
   */
  async handleMove(data) {
    try {
      if (!data?.from || !data?.to) {
        return { status: 400, error: 'from and to are required' };
      }

      const safeFrom = this.validatePath(data.from);
      const safeTo = this.validatePath(data.to);

      // Check source exists
      await fs.stat(safeFrom);

      // Create target directory if needed
      await fs.mkdir(path.dirname(safeTo), { recursive: true });

      // Move
      await fs.rename(safeFrom, safeTo);

      this.logger.info('filesystem.move.success', { from: data.from, to: data.to });

      return {
        success: true,
        message: `Movido de ${data.from} a ${data.to}`,
        from: data.from,
        to: data.to,
        moved: true
      };

    } catch (error) {
      if (error.code === 'ENOENT') {
        return { status: 404, error: 'Source path not found' };
      }
      this.logger.error('filesystem.move.error', { error: error.message, from: data?.from, to: data?.to });
      return { status: error.status || 500, error: error.message };
    }
  }

  /**
   * Copy file
   */
  async handleCopy(data) {
    try {
      if (!data?.from || !data?.to) {
        return { status: 400, error: 'from and to are required' };
      }

      const safeFrom = this.validatePath(data.from);
      const safeTo = this.validatePath(data.to);

      // Check source exists and is a file
      const stats = await fs.stat(safeFrom);
      if (stats.isDirectory()) {
        return { status: 400, error: 'Cannot copy directories (use recursive copy)' };
      }

      // Create target directory if needed
      await fs.mkdir(path.dirname(safeTo), { recursive: true });

      // Copy
      await fs.copyFile(safeFrom, safeTo);

      this.logger.info('filesystem.copy.success', { from: data.from, to: data.to });

      return {
        status: 200,
        data: {
          from: data.from,
          to: data.to,
          copied: true
        }
      };

    } catch (error) {
      if (error.code === 'ENOENT') {
        return { status: 404, error: 'Source file not found' };
      }
      this.logger.error('filesystem.copy.error', { error: error.message, from: data?.from, to: data?.to });
      return { status: error.status || 500, error: error.message };
    }
  }

  /**
   * Search files by name or content
   */
  async handleSearch(data) {
    try {
      if (!data?.query) {
        return { status: 400, error: 'query is required' };
      }

      const basePath = this.validatePath(data.path || '/');
      const searchContent = data.content === true;
      const query = data.query.toLowerCase();
      const results = [];
      const maxResults = 100;

      await this.searchRecursive(basePath, query, searchContent, results, data.path || '/', maxResults);

      return {
        status: 200,
        data: {
          query: data.query,
          path: data.path || '/',
          searchContent,
          results,
          count: results.length,
          truncated: results.length >= maxResults
        }
      };

    } catch (error) {
      this.logger.error('filesystem.search.error', { error: error.message, query: data?.query });
      return { status: error.status || 500, error: error.message };
    }
  }

  async searchRecursive(dirPath, query, searchContent, results, relativePath, maxResults) {
    if (results.length >= maxResults) return;

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (results.length >= maxResults) break;

        const fullPath = path.join(dirPath, entry.name);
        const entryRelative = path.join(relativePath, entry.name).replace(/\\/g, '/');

        // Search in filename
        if (entry.name.toLowerCase().includes(query)) {
          try {
            const stats = await fs.stat(fullPath);
            results.push({
              name: entry.name,
              path: entryRelative,
              type: entry.isDirectory() ? 'directory' : 'file',
              size: stats.size,
              modified: stats.mtime,
              match: 'filename'
            });
          } catch (e) {
            // Skip
          }
        }

        // Search in content (only text files)
        if (searchContent && entry.isFile() && results.length < maxResults) {
          const ext = path.extname(entry.name).toLowerCase();
          const textExts = ['.txt', '.md', '.json', '.js', '.ts', '.html', '.css', '.yaml', '.yml', '.xml', '.csv', '.log'];

          if (textExts.includes(ext)) {
            try {
              const stats = await fs.stat(fullPath);
              // Skip large files
              if (stats.size < 1024 * 1024) {
                const content = await fs.readFile(fullPath, 'utf-8');
                if (content.toLowerCase().includes(query)) {
                  // Avoid duplicates
                  if (!results.some(r => r.path === entryRelative)) {
                    results.push({
                      name: entry.name,
                      path: entryRelative,
                      type: 'file',
                      size: stats.size,
                      modified: stats.mtime,
                      match: 'content'
                    });
                  }
                }
              }
            } catch (e) {
              // Skip files that can't be read
            }
          }
        }

        // Recurse into directories
        if (entry.isDirectory() && results.length < maxResults) {
          await this.searchRecursive(fullPath, query, searchContent, results, entryRelative, maxResults);
        }
      }
    } catch (e) {
      // Skip directories we can't access
    }
  }

  /**
   * Get file/directory info
   */
  async handleInfo(data) {
    try {
      if (!data?.path) {
        return { status: 400, error: 'path is required' };
      }

      const safePath = this.validatePath(data.path);
      const stats = await fs.stat(safePath);

      return {
        status: 200,
        data: {
          path: data.path,
          type: stats.isDirectory() ? 'directory' : 'file',
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime,
          accessed: stats.atime
        }
      };

    } catch (error) {
      if (error.code === 'ENOENT') {
        return { status: 404, error: 'Path not found' };
      }
      this.logger.error('filesystem.info.error', { error: error.message, path: data?.path });
      return { status: error.status || 500, error: error.message };
    }
  }

  /**
   * Cleanup old files from temp directory
   */
  async handleCleanup(data) {
    try {
      const cleanupPath = data?.path || '/temp';
      const maxAgeHours = data?.max_age_hours || 24;
      const dryRun = data?.dry_run === true;

      const safePath = this.validatePath(cleanupPath);

      // Check if directory exists
      try {
        const stats = await fs.stat(safePath);
        if (!stats.isDirectory()) {
          return { status: 400, error: 'Path is not a directory' };
        }
      } catch (e) {
        if (e.code === 'ENOENT') {
          return { status: 200, data: { message: 'Directory does not exist, nothing to clean', deleted: [], count: 0 } };
        }
        throw e;
      }

      const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
      const deleted = [];
      const errors = [];

      await this.cleanupRecursive(safePath, cleanupPath, cutoffTime, dryRun, deleted, errors);

      this.logger.info('filesystem.cleanup.complete', {
        path: cleanupPath,
        maxAgeHours,
        dryRun,
        deletedCount: deleted.length
      });

      return {
        status: 200,
        data: {
          path: cleanupPath,
          max_age_hours: maxAgeHours,
          dry_run: dryRun,
          deleted,
          count: deleted.length,
          errors: errors.length > 0 ? errors : undefined
        }
      };

    } catch (error) {
      this.logger.error('filesystem.cleanup.error', { error: error.message, path: data?.path });
      return { status: error.status || 500, error: error.message };
    }
  }

  async cleanupRecursive(dirPath, relativePath, cutoffTime, dryRun, deleted, errors) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const entryRelative = path.join(relativePath, entry.name).replace(/\\/g, '/');

        try {
          const stats = await fs.stat(fullPath);

          if (entry.isDirectory()) {
            // Recurse into subdirectories
            await this.cleanupRecursive(fullPath, entryRelative, cutoffTime, dryRun, deleted, errors);

            // Check if directory is now empty
            const remaining = await fs.readdir(fullPath);
            if (remaining.length === 0) {
              if (!dryRun) {
                await fs.rmdir(fullPath);
              }
              deleted.push({ path: entryRelative, type: 'directory', reason: 'empty' });
            }
          } else {
            // Check file age
            if (stats.mtimeMs < cutoffTime) {
              if (!dryRun) {
                await fs.unlink(fullPath);
              }
              deleted.push({
                path: entryRelative,
                type: 'file',
                size: stats.size,
                age_hours: Math.round((Date.now() - stats.mtimeMs) / (1000 * 60 * 60))
              });
            }
          }
        } catch (e) {
          errors.push({ path: entryRelative, error: e.message });
        }
      }
    } catch (e) {
      errors.push({ path: relativePath, error: e.message });
    }
  }

  /**
   * Get storage statistics
   */
  async handleStats(data) {
    try {
      const statsPath = data?.path || '/';
      const safePath = this.validatePath(statsPath);

      // Check if directory exists
      try {
        const dirStats = await fs.stat(safePath);
        if (!dirStats.isDirectory()) {
          return { status: 400, error: 'Path is not a directory' };
        }
      } catch (e) {
        if (e.code === 'ENOENT') {
          return { status: 404, error: 'Directory not found' };
        }
        throw e;
      }

      const stats = {
        totalFiles: 0,
        totalDirectories: 0,
        totalSize: 0,
        byExtension: {},
        largestFiles: []
      };

      await this.calculateStats(safePath, statsPath, stats);

      // Sort largest files
      stats.largestFiles.sort((a, b) => b.size - a.size);
      stats.largestFiles = stats.largestFiles.slice(0, 10);

      // Sort extensions by size
      const byExtSorted = Object.entries(stats.byExtension)
        .sort((a, b) => b[1].size - a[1].size)
        .reduce((obj, [ext, data]) => {
          obj[ext] = data;
          return obj;
        }, {});
      stats.byExtension = byExtSorted;

      return {
        status: 200,
        data: {
          path: statsPath,
          total_files: stats.totalFiles,
          total_directories: stats.totalDirectories,
          total_size: stats.totalSize,
          total_size_human: this.formatBytes(stats.totalSize),
          by_extension: stats.byExtension,
          largest_files: stats.largestFiles
        }
      };

    } catch (error) {
      this.logger.error('filesystem.stats.error', { error: error.message, path: data?.path });
      return { status: error.status || 500, error: error.message };
    }
  }

  async calculateStats(dirPath, relativePath, stats) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const entryRelative = path.join(relativePath, entry.name).replace(/\\/g, '/');

        try {
          const fileStats = await fs.stat(fullPath);

          if (entry.isDirectory()) {
            stats.totalDirectories++;
            await this.calculateStats(fullPath, entryRelative, stats);
          } else {
            stats.totalFiles++;
            stats.totalSize += fileStats.size;

            // Track by extension
            const ext = path.extname(entry.name).toLowerCase() || '.noext';
            if (!stats.byExtension[ext]) {
              stats.byExtension[ext] = { count: 0, size: 0 };
            }
            stats.byExtension[ext].count++;
            stats.byExtension[ext].size += fileStats.size;

            // Track largest files
            if (stats.largestFiles.length < 20 || fileStats.size > stats.largestFiles[stats.largestFiles.length - 1]?.size) {
              stats.largestFiles.push({
                path: entryRelative,
                name: entry.name,
                size: fileStats.size,
                size_human: this.formatBytes(fileStats.size)
              });
            }
          }
        } catch (e) {
          // Skip files we can't stat
        }
      }
    } catch (e) {
      // Skip directories we can't access
    }
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

module.exports = FilesystemModule;
