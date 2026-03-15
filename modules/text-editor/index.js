const fs = require('fs').promises;
const path = require('path');

const { EVENTS, FIELDS, HELPERS, CONFIG, ERRORS } = require('../../core/constants');

class TextEditorModule {
  constructor() {
    this.name = 'text-editor';
    this.version = '1.0.0';

    // Dependencies (injected)
    this.logger = null;
    this.metrics = null;
    this.eventBus = null;
    this.config = null;
    this.uiHandler = null;

    // State
    this.unsubscribes = [];
  }

  async onLoad(core) {
    this.logger = core.logger;
    this.metrics = core.metrics;
    this.eventBus = core.eventBus;
    this.config = core.moduleConfig || {};
    this.uiHandler = core.uiHandler;

    this.logger.info('text-editor.loading', { module: this.name });

    // Event subscriptions and UI handlers are auto-wired by the loader from module.json

    this.logger.info('text-editor.loaded', { module: this.name });
  }

  async onUnload() {
    // Event subscriptions and UI handlers are auto-cleaned by the loader
    this.logger.info('text-editor.unloaded', { module: this.name });
  }

  // API Handlers

  async openFile(req, res) {
    try {
      const { project_id, file_path } = req.query;

      if (!project_id || !file_path) {
        return res.status(400).json({
          success: false,
          error: 'project_id and file_path are required'
        });
      }

      const projectPath = await this.getProjectPath(project_id);

      // Security: Validate path is within project directory
      let fullPath;
      try {
        fullPath = this.validatePath(projectPath, file_path);
      } catch (error) {
        return res.status(403).json({
          success: false,
          error: error.message
        });
      }

      const stats = await fs.stat(fullPath);
      if (stats.size > this.config.max_file_size) {
        return res.status(400).json({
          success: false,
          error: `File too large. Maximum size: ${this.config.max_file_size} bytes`
        });
      }

      const extension = path.extname(file_path).slice(1).toLowerCase();
      if (!this.config.supported_formats.includes(extension)) {
        return res.status(400).json({
          success: false,
          error: `Unsupported format: ${extension}`
        });
      }

      const content = await fs.readFile(fullPath, 'utf-8');

      // REMOVED: this.metrics.counter('files_opened_total').inc();

      res.json({
        success: true,
        data: {
          file_path,
          content,
          extension,
          size: stats.size,
          modified: stats.mtime,
          readonly: false
        }
      });
    } catch (error) {
      this.logger.error('text-editor.open-error', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async saveFile(req, res) {
    try {
      const { project_id, file_path, content } = req.body;

      if (!project_id || !file_path || content === undefined) {
        return res.status(400).json({
          success: false,
          error: 'project_id, file_path and content are required'
        });
      }

      const projectPath = await this.getProjectPath(project_id);

      // Security: Validate path is within project directory
      let fullPath;
      try {
        fullPath = this.validatePath(projectPath, file_path);
      } catch (error) {
        return res.status(403).json({
          success: false,
          error: error.message
        });
      }

      const extension = path.extname(file_path).slice(1).toLowerCase();
      if (extension === 'json') {
        try {
          JSON.parse(content);
        } catch (error) {
          return res.status(400).json({
            success: false,
            error: 'Invalid JSON: ' + error.message
          });
        }
      }

      const dirPath = path.dirname(fullPath);
      await fs.mkdir(dirPath, { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');

      const stats = await fs.stat(fullPath);

      // REMOVED: this.metrics.counter('files_saved_total').inc();

      await this.eventBus.publish(EVENTS.EDITOR.SAVED, {
        project_id,
        file_path,
        size: stats.size,
        timestamp: new Date().toISOString()
      });

      res.json({
        success: true,
        data: {
          file_path,
          saved: true,
          size: stats.size,
          modified: stats.mtime
        }
      });
    } catch (error) {
      this.logger.error('text-editor.save-error', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async validateContent(req, res) {
    try {
      const { content, format } = req.body;

      if (!content || !format) {
        return res.status(400).json({
          success: false,
          error: 'content and format are required'
        });
      }

      const validation = this.validateByFormat(content, format);

      if (!validation.valid) {
        // REMOVED: this.metrics.counter('validation_errors_total').inc();
      }

      res.json(HELPERS.buildResponse(true, validation));
    } catch (error) {
      this.logger.error('text-editor.validate-error', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async formatContent(req, res) {
    try {
      const { content, format } = req.body;

      if (!content || !format) {
        return res.status(400).json({
          success: false,
          error: 'content and format are required'
        });
      }

      const formatted = this.formatByFormat(content, format);

      res.json({
        success: true,
        data: {
          formatted: formatted.content,
          changed: formatted.changed
        }
      });
    } catch (error) {
      this.logger.error('text-editor.format-error', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // Event Handlers

  async handleOpenRequest(event) {
    try {
      const { request_id, project_id, file_path } = event.data;

      const projectPath = await this.getProjectPath(project_id);
      const fullPath = this.validatePath(projectPath, file_path);

      const content = await fs.readFile(fullPath, 'utf-8');
      const stats = await fs.stat(fullPath);
      const extension = path.extname(file_path).slice(1).toLowerCase();

      await this.eventBus.publish(EVENTS.EDITOR.OPEN_RESPONSE, {
        request_id,
        success: true,
        data: {
          file_path,
          content,
          extension,
          size: stats.size
        }
      });
    } catch (error) {
      await this.eventBus.publish(EVENTS.EDITOR.OPEN_RESPONSE, {
        request_id: event.data.request_id,
        success: false,
        error: error.message
      });
    }
  }

  async handleSaveRequest(event) {
    try {
      const { request_id, project_id, file_path, content } = event.data;

      const projectPath = await this.getProjectPath(project_id);
      const fullPath = this.validatePath(projectPath, file_path);

      const dirPath = path.dirname(fullPath);
      await fs.mkdir(dirPath, { recursive: true });

      await fs.writeFile(fullPath, content, 'utf-8');

      await this.eventBus.publish(EVENTS.EDITOR.SAVED, {
        request_id,
        project_id,
        file_path,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      await this.eventBus.publish(EVENTS.EDITOR.ERROR, {
        request_id: event.data.request_id,
        error: error.message
      });
    }
  }

  async handleValidateRequest(event) {
    try {
      const { request_id, content, format } = event.data;

      const validation = this.validateByFormat(content, format);

      await this.eventBus.publish(EVENTS.EDITOR.VALIDATE_RESPONSE, {
        request_id,
        success: true,
        data: validation
      });
    } catch (error) {
      await this.eventBus.publish(EVENTS.EDITOR.VALIDATE_RESPONSE, {
        request_id: event.data.request_id,
        success: false,
        error: error.message
      });
    }
  }

  async handleFormatRequest(event) {
    try {
      const { request_id, content, format } = event.data;

      const formatted = this.formatByFormat(content, format);

      await this.eventBus.publish(EVENTS.EDITOR.FORMAT_RESPONSE, {
        request_id,
        success: true,
        data: formatted
      });
    } catch (error) {
      await this.eventBus.publish(EVENTS.EDITOR.FORMAT_RESPONSE, {
        request_id: event.data.request_id,
        success: false,
        error: error.message
      });
    }
  }

  // Helper Methods

  /**
   * Gets the base path for file operations
   * @param {string|null} project_id - Project ID or null for root mode
   * @returns {string} Base path for file operations
   */
  async getBasePath(project_id) {
    const projectsRoot = path.join(process.cwd(), 'data', 'projects');

    // Ensure projects root exists
    await fs.mkdir(projectsRoot, { recursive: true });

    if (!project_id) {
      // Root mode: return projects root directory
      return projectsRoot;
    }

    // Project mode: return specific project directory
    const projectDir = path.join(projectsRoot, project_id);
    await fs.mkdir(projectDir, { recursive: true });

    return projectDir;
  }

  async getProjectPath(project_id) {
    const dataDir = path.join(process.cwd(), 'data', 'projects', project_id);

    // Ensure directory exists
    await fs.mkdir(dataDir, { recursive: true });

    return dataDir;
  }

  /**
   * Validates that a path is within the allowed project directory
   * @param {string} projectPath - Base project directory
   * @param {string} relativePath - User-provided relative path
   * @returns {string} Validated full path
   * @throws {Error} If path is outside project directory
   */
  validatePath(projectPath, relativePath) {
    const normalizedProjectPath = path.resolve(projectPath);

    // Strip leading slashes to prevent path.resolve from treating it as absolute
    let safePath = (relativePath || '').replace(/^\/+/, '');

    const fullPath = path.resolve(projectPath, safePath);

    if (!fullPath.startsWith(normalizedProjectPath + path.sep) && fullPath !== normalizedProjectPath) {
      throw new Error('Access denied: Path outside project directory');
    }

    return fullPath;
  }

  validateByFormat(content, format) {
    const validation = {
      valid: true,
      errors: [],
      warnings: []
    };

    switch (format.toLowerCase()) {
      case 'json':
        try {
          JSON.parse(content);
        } catch (error) {
          validation.valid = false;
          validation.errors.push({
            line: null,
            message: error.message,
            type: 'syntax'
          });
        }
        break;

      case 'md':
      case 'markdown':
        const lines = content.split('\n');
        lines.forEach((line, index) => {
          if (line.includes('[') && line.includes('](') && !line.includes(')')) {
            validation.warnings.push({
              line: index + 1,
              message: 'Possibly broken markdown link',
              type: 'syntax'
            });
          }
        });
        break;
    }

    return validation;
  }

  formatByFormat(content, format) {
    let formatted = content;
    let changed = false;

    switch (format.toLowerCase()) {
      case 'json':
        try {
          const parsed = JSON.parse(content);
          const indented = JSON.stringify(parsed, null, this.config.tab_size);
          if (indented !== content) {
            formatted = indented;
            changed = true;
          }
        } catch (error) {
          // Can't format invalid JSON
        }
        break;

      case 'md':
      case 'markdown':
        const lines = content.split('\n');
        const trimmed = lines.map(line => line.trimEnd()).join('\n');
        if (trimmed !== content) {
          formatted = trimmed;
          changed = true;
        }
        break;
    }

    return {
      content: formatted,
      changed
    };
  }

  // ==========================================
  // UI Request/Response Handlers (MQTT)
  // ==========================================

  // UI handlers are wired by the loader from module.json

  async handleUIOpen(data) {
    const { project_id, file_path } = data || {};

    if (!file_path) {
      throw { status: 400, code: 'MISSING_PARAMS', message: 'file_path is required' };
    }

    const basePath = await this.getBasePath(project_id);

    let fullPath;
    try {
      fullPath = this.validatePath(basePath, file_path);
    } catch (error) {
      throw { status: 403, code: 'ACCESS_DENIED', message: error.message };
    }

    const stats = await fs.stat(fullPath);
    if (this.config.max_file_size && stats.size > this.config.max_file_size) {
      throw { status: 413, code: 'FILE_TOO_LARGE', message: `File too large. Maximum size: ${this.config.max_file_size} bytes` };
    }

    const extension = path.extname(file_path).slice(1).toLowerCase();
    if (this.config.supported_formats && !this.config.supported_formats.includes(extension)) {
      throw { status: 400, code: 'UNSUPPORTED_FORMAT', message: `Unsupported format: ${extension}` };
    }

    const content = await fs.readFile(fullPath, 'utf-8');

    return {
      file_path,
      content,
      extension,
      size: stats.size,
      modified: stats.mtime,
      readonly: false
    };
  }

  async handleUISave(data) {
    const { project_id, file_path, content } = data || {};

    if (!file_path || content === undefined) {
      throw { status: 400, code: 'MISSING_PARAMS', message: 'file_path and content are required' };
    }

    const basePath = await this.getBasePath(project_id);

    let fullPath;
    try {
      fullPath = this.validatePath(basePath, file_path);
    } catch (error) {
      throw { status: 403, code: 'ACCESS_DENIED', message: error.message };
    }

    // Validate JSON if applicable
    const extension = path.extname(file_path).slice(1).toLowerCase();
    if (extension === 'json') {
      try {
        JSON.parse(content);
      } catch (error) {
        throw { status: 400, code: 'INVALID_JSON', message: 'Invalid JSON: ' + error.message };
      }
    }

    const dirPath = path.dirname(fullPath);
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');

    const stats = await fs.stat(fullPath);

    await this.eventBus.publish(EVENTS.EDITOR.SAVED, {
      project_id,
      file_path,
      size: stats.size,
      timestamp: new Date().toISOString()
    });

    return {
      file_path,
      saved: true,
      size: stats.size,
      modified: stats.mtime
    };
  }

  async handleUIValidate(data) {
    const { content, format } = data || {};

    if (!content || !format) {
      throw { status: 400, code: 'MISSING_PARAMS', message: 'content and format are required' };
    }

    const validation = this.validateByFormat(content, format);

    return validation;
  }

  async handleUIFormat(data) {
    const { content, format } = data || {};

    if (!content || !format) {
      throw { status: 400, code: 'MISSING_PARAMS', message: 'content and format are required' };
    }

    const formatted = this.formatByFormat(content, format);

    return {
      formatted: formatted.content,
      changed: formatted.changed
    };
  }
}

module.exports = TextEditorModule;
