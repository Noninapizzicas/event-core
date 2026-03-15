const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');

const { EVENTS, FIELDS, HELPERS, CONFIG, ERRORS } = require('../../core/constants');

class PdfViewerModule {
  constructor() {
    this.name = 'pdf-viewer';
    this.version = '1.0.0';

    // Dependencies (injected)
    this.logger = null;
    this.metrics = null;
    this.eventBus = null;
    this.config = null;
    this.uiHandler = null;

    // State
    this.cache = new Map();
    this.projectPaths = new Map(); // projectId -> basePath cache
    this.unsubscribes = [];

    // System projects use legacy structure
    this.systemProjects = new Set(['system', '_prompts']);
  }

  async onLoad(core) {
    this.logger = core.logger;
    this.metrics = core.metrics;
    this.eventBus = core.eventBus;
    this.config = core.moduleConfig || {};
    this.uiHandler = core.uiHandler;

    this.logger.info('pdf-viewer.loading', { module: this.name });

    // Event subscriptions and UI handlers are auto-wired by the loader from module.json

    // Setup cache cleanup
    if (this.config.cache_enabled) {
      this.setupCacheCleanup();
    }

    this.logger.info('pdf-viewer.loaded', { module: this.name });
  }

  async onUnload() {
    if (this.cacheCleanupInterval) {
      clearInterval(this.cacheCleanupInterval);
    }
    // Event subscriptions and UI handlers are auto-cleaned by the loader
    this.logger.info('pdf-viewer.unloaded', { module: this.name });
  }

  // API Handlers

  async viewPdf(req, res) {
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

      if (!fullPath.toLowerCase().endsWith('.pdf')) {
        return res.status(400).json({
          success: false,
          error: 'File must be a PDF'
        });
      }

      const stats = await fs.stat(fullPath);
      if (stats.size > this.config.max_pdf_size) {
        return res.status(400).json({
          success: false,
          error: `PDF too large. Maximum size: ${this.config.max_pdf_size} bytes`
        });
      }

      const buffer = await fs.readFile(fullPath);
      const base64 = buffer.toString('base64');

      // REMOVED: this.metrics.counter('pdfs_viewed_total').inc();

      res.json({
        success: true,
        data: {
          file_path,
          size: stats.size,
          modified: stats.mtime,
          content: base64,
          content_type: 'application/pdf'
        }
      });
    } catch (error) {
      this.logger.error('pdf-viewer.view-error', { error: error.message });
      // REMOVED: this.metrics.counter('pdf_errors_total').inc();
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async extractText(req, res) {
    try {
      const { project_id, file_path, page } = req.query;

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

      // REMOVED: this.metrics.counter('text_extractions_total').inc();

      res.json({
        success: true,
        data: {
          file_path,
          text: 'Text extraction requires pdf-parse library. Install with: npm install pdf-parse',
          pages: null,
          note: 'This is a placeholder response. Implement pdf-parse for full functionality.'
        }
      });
    } catch (error) {
      this.logger.error('pdf-viewer.extract-error', { error: error.message });
      // REMOVED: this.metrics.counter('pdf_errors_total').inc();
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async getMetadata(req, res) {
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

      const metadata = {
        file_path,
        filename: path.basename(file_path),
        size: stats.size,
        size_formatted: this.formatBytes(stats.size),
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime
      };

      res.json(HELPERS.buildResponse(true, metadata
      ));
    } catch (error) {
      this.logger.error('pdf-viewer.metadata-error', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async listPdfs(req, res) {
    try {
      const { project_id } = req.query;

      if (!project_id) {
        return res.status(400).json({
          success: false,
          error: 'project_id is required'
        });
      }

      const projectPath = await this.getProjectPath(project_id);
      const pdfs = await this.findPdfsRecursive(projectPath);

      res.json({
        success: true,
        data: {
          project_id,
          pdfs,
          count: pdfs.length
        }
      });
    } catch (error) {
      this.logger.error('pdf-viewer.list-error', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // Event Handlers

  async handleViewRequest(event) {
    try {
      const { request_id, project_id, file_path } = event.data;

      const projectPath = await this.getProjectPath(project_id);
      const fullPath = this.validatePath(projectPath, file_path);

      const buffer = await fs.readFile(fullPath);
      const stats = await fs.stat(fullPath);
      const base64 = buffer.toString('base64');

      await this.eventBus.publish(EVENTS.PDF.VIEW_RESPONSE, {
        request_id,
        success: true,
        data: {
          file_path,
          content: base64,
          size: stats.size
        }
      });
    } catch (error) {
      await this.eventBus.publish(EVENTS.PDF.VIEW_RESPONSE, {
        request_id: event.data.request_id,
        success: false,
        error: error.message
      });
    }
  }

  async handleExtractRequest(event) {
    try {
      const { request_id, project_id, file_path, page } = event.data;

      await this.eventBus.publish(EVENTS.PDF.EXTRACT_RESPONSE, {
        request_id,
        success: true,
        data: {
          text: 'Text extraction requires pdf-parse library',
          note: 'Install pdf-parse for full functionality'
        }
      });
    } catch (error) {
      await this.eventBus.publish(EVENTS.PDF.EXTRACT_RESPONSE, {
        request_id: event.data.request_id,
        success: false,
        error: error.message
      });
    }
  }

  async handleMetadataRequest(event) {
    try {
      const { request_id, project_id, file_path } = event.data;

      const projectPath = await this.getProjectPath(project_id);
      const fullPath = this.validatePath(projectPath, file_path);

      const stats = await fs.stat(fullPath);

      const metadata = {
        file_path,
        filename: path.basename(file_path),
        size: stats.size,
        modified: stats.mtime
      };

      await this.eventBus.publish(EVENTS.PDF.METADATA_RESPONSE, {
        request_id,
        success: true,
        data: metadata
      });
    } catch (error) {
      await this.eventBus.publish(EVENTS.PDF.METADATA_RESPONSE, {
        request_id: event.data.request_id,
        success: false,
        error: error.message
      });
    }
  }

  async handleListRequest(event) {
    try {
      const { request_id, project_id } = event.data;

      const projectPath = await this.getProjectPath(project_id);
      const pdfs = await this.findPdfsRecursive(projectPath);

      await this.eventBus.publish(EVENTS.PDF.LIST_RESPONSE, {
        request_id,
        success: true,
        data: { pdfs }
      });
    } catch (error) {
      await this.eventBus.publish(EVENTS.PDF.LIST_RESPONSE, {
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
    // Check cache first
    if (this.projectPaths.has(project_id)) {
      const cachedPath = this.projectPaths.get(project_id);
      await fs.mkdir(cachedPath, { recursive: true });
      return cachedPath;
    }

    // System projects use legacy structure
    if (this.systemProjects.has(project_id)) {
      const legacyPath = path.join(process.cwd(), 'data', 'projects', project_id);
      await fs.mkdir(legacyPath, { recursive: true });
      return legacyPath;
    }

    // Query project base_path from database via events
    try {
      const result = await this.queryProjectBasePath(project_id);
      if (result) {
        // Use storage subdirectory for PDFs
        const storagePath = path.join(result, 'storage');
        this.projectPaths.set(project_id, storagePath);
        await fs.mkdir(storagePath, { recursive: true });
        return storagePath;
      }
    } catch (err) {
      this.logger.debug('pdf-viewer.project.path.fallback', {
        project_id,
        error: err.message
      });
    }

    // Fallback to legacy structure
    const fallbackPath = path.join(process.cwd(), 'data', 'projects', project_id);
    await fs.mkdir(fallbackPath, { recursive: true });
    return fallbackPath;
  }

  /**
   * Query project base_path from system database
   */
  async queryProjectBasePath(project_id) {
    return new Promise((resolve, reject) => {
      const requestId = `pdf_path_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const timeout = setTimeout(() => {
        reject(new Error('Timeout querying project path'));
      }, 5000);

      const handler = (event) => {
        const data = event.data || event;
        if (data.request_id === requestId) {
          clearTimeout(timeout);
          if (data.success && data.data?.length > 0) {
            resolve(data.data[0].base_path);
          } else {
            resolve(null);
          }
        }
      };

      // Subscribe temporarily
      this.eventBus.subscribe('db.query.response', handler).then(unsub => {
        // Query system DB for project base_path
        this.eventBus.publish('db.query.request', {
          project_id: 'system',
          query: 'SELECT base_path FROM projects WHERE id = ?',
          params: [project_id],
          read_only: true,
          request_id: requestId
        }).catch(err => {
          clearTimeout(timeout);
          unsub();
          reject(err);
        });

        // Cleanup after response or timeout
        setTimeout(() => unsub(), 6000);
      });
    });
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

  async findPdfsRecursive(dirPath) {
    const pdfs = [];
    const self = this;

    async function search(currentPath) {
      try {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(currentPath, entry.name);

          if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
            const stats = await fs.stat(fullPath);
            pdfs.push({
              name: entry.name,
              path: fullPath.replace(dirPath, '').replace(/\\/g, '/'),
              size: stats.size,
              size_formatted: self.formatBytes(stats.size),
              modified: stats.mtime
            });
          } else if (entry.isDirectory()) {
            await search(fullPath);
          }
        }
      } catch (error) {
        // Skip directories we can't access
      }
    }

    await search(dirPath);
    return pdfs;
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  setupCacheCleanup() {
    this.cacheCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.cache.entries()) {
        if (now - value.timestamp > this.config.cache_ttl) {
          this.cache.delete(key);
        }
      }
    }, this.config.cache_ttl);
  }

  // ==========================================
  // UI Request/Response Handlers (MQTT)
  // ==========================================

  // UI handlers are wired by the loader from module.json

  async handleUIView(data) {
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

    if (!fullPath.toLowerCase().endsWith('.pdf')) {
      throw { status: 400, code: 'NOT_PDF', message: 'File must be a PDF' };
    }

    const stats = await fs.stat(fullPath);
    if (this.config.max_pdf_size && stats.size > this.config.max_pdf_size) {
      throw { status: 413, code: 'FILE_TOO_LARGE', message: `PDF too large. Maximum size: ${this.config.max_pdf_size} bytes` };
    }

    const buffer = await fs.readFile(fullPath);
    const base64 = buffer.toString('base64');

    return {
      file_path,
      size: stats.size,
      size_formatted: this.formatBytes(stats.size),
      modified: stats.mtime,
      content: base64,
      content_type: 'application/pdf'
    };
  }

  async handleUIMetadata(data) {
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

    return {
      file_path,
      filename: path.basename(file_path),
      size: stats.size,
      size_formatted: this.formatBytes(stats.size),
      created: stats.birthtime,
      modified: stats.mtime,
      accessed: stats.atime
    };
  }

  async handleUIListPdfs(data) {
    const { project_id } = data || {};

    const basePath = await this.getBasePath(project_id);
    const pdfs = await this.findPdfsRecursive(basePath);

    return {
      project_id,
      pdfs,
      count: pdfs.length
    };
  }

  // ==========================================
  // AI Tool Handlers
  // ==========================================

  /**
   * pdf.create - Create a PDF from text or structured content
   * Delegates to local.pdf provider via eventBus, falls back to direct PDFKit
   */
  async handleToolCreate(args) {
    const {
      project_id,
      filename,
      title,
      content,
      type = 'from_text',
      orientation = 'portrait',
      format = 'A4',
      margin = 50
    } = args || {};

    if (!filename) {
      return { status: 400, data: { error: 'filename is required' } };
    }
    if (!content) {
      return { status: 400, data: { error: 'content is required (text or structured object with title/body)' } };
    }

    // Sanitize filename
    const safeName = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;

    this.logger.info('tool.pdf.create.start', {
      project_id,
      filename: safeName,
      type,
      content_length: typeof content === 'string' ? content.length : JSON.stringify(content).length
    });

    try {
      // Try via provider event first (preferred: keeps consistency)
      const result = await this.createViaProvider({
        type,
        content: title ? { title, body: content } : content,
        filename: safeName,
        options: { orientation, format, margin }
      });

      if (result) {
        this.logger.info('tool.pdf.create.success', {
          filename: safeName,
          path: result.path,
          size: result.size,
          method: 'provider'
        });

        return {
          status: 200,
          data: {
            success: true,
            filename: safeName,
            path: result.path,
            size: result.size,
            method: 'provider'
          }
        };
      }

      // Fallback: create directly with PDFKit
      return await this.createDirectPdf({
        type, content, title, filename: safeName,
        orientation, format, margin, project_id
      });
    } catch (error) {
      const errorMsg = error?.message || String(error);
      this.logger.error('tool.pdf.create.error', { filename: safeName, error: errorMsg });

      return {
        status: 500,
        data: { success: false, filename: safeName, error: errorMsg }
      };
    }
  }

  /**
   * Create PDF via local.pdf provider (event bus)
   * Returns null if provider unavailable
   */
  async createViaProvider(payload) {
    if (!this.eventBus) return null;

    return new Promise((resolve) => {
      const requestId = `pdf_create_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const timeout = setTimeout(() => {
        resolve(null); // fallback to direct
      }, 8000);

      const handler = (event) => {
        const data = event.data || event;
        if (data.request_id !== requestId) return;
        clearTimeout(timeout);
        if (data.success && data.data) {
          resolve(data.data);
        } else {
          resolve(null);
        }
      };

      this.eventBus.subscribe('local.pdf.create.response', handler)
        .then(unsub => {
          this.eventBus.publish('local.pdf.create.request', {
            request_id: requestId,
            ...payload
          }).catch(() => {
            clearTimeout(timeout);
            unsub();
            resolve(null);
          });
          setTimeout(() => unsub(), 9000);
        })
        .catch(() => resolve(null));
    });
  }

  /**
   * Direct PDFKit fallback when provider is not available
   */
  async createDirectPdf({ type, content, title, filename, orientation, format, margin }) {
    let PDFDocument;
    try {
      PDFDocument = require('pdfkit');
    } catch {
      return {
        status: 500,
        data: { success: false, error: 'pdfkit not installed. Run: npm install pdfkit' }
      };
    }

    const outputDir = path.join(process.cwd(), 'data', 'generated', 'pdf');
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, filename);

    const doc = new PDFDocument({
      size: format,
      layout: orientation,
      margin
    });

    const fsSync = require('fs');
    const writeStream = fsSync.createWriteStream(outputPath);
    doc.pipe(writeStream);

    if (type === 'from_text') {
      if (title) {
        doc.fontSize(18).text(title, { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      } else if (typeof content === 'string') {
        doc.fontSize(12).text(content);
      } else if (content && typeof content === 'object') {
        if (content.title) {
          doc.fontSize(18).text(content.title, { align: 'center' });
          doc.moveDown();
        }
        doc.fontSize(12).text(content.body || JSON.stringify(content, null, 2));
      }
    } else if (type === 'from_html') {
      const plainText = (typeof content === 'string' ? content : '').replace(/<[^>]*>/g, '');
      if (title) {
        doc.fontSize(18).text(title, { align: 'center' });
        doc.moveDown();
      }
      doc.fontSize(12).text(plainText);
    } else {
      doc.fontSize(12).text(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    }

    doc.end();

    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    const stats = await fs.stat(outputPath);

    this.logger.info('tool.pdf.create.success', {
      filename,
      path: outputPath,
      size: stats.size,
      method: 'direct'
    });

    return {
      status: 200,
      data: {
        success: true,
        filename,
        path: outputPath,
        size: stats.size,
        sizeFormatted: this.formatBytes(stats.size),
        method: 'direct'
      }
    };
  }

  /**
   * pdf.list - List all PDFs in a project
   */
  async handleToolList(args) {
    const { projectId } = args || {};

    if (!projectId) {
      return {
        status: 400,
        data: { error: 'projectId is required' }
      };
    }

    this.logger.info('tool.pdf.list.start', { project_id: projectId });

    try {
      const basePath = await this.getBasePath(projectId);
      const pdfs = await this.findPdfsRecursive(basePath);

      this.logger.info('tool.pdf.list.success', {
        project_id: projectId,
        count: pdfs.length
      });

      return {
        status: 200,
        data: {
          success: true,
          projectId,
          pdfs,
          count: pdfs.length
        }
      };
    } catch (error) {
      const errorMsg = error?.message || String(error);
      this.logger.error('tool.pdf.list.error', {
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
   * pdf.metadata - Get PDF file metadata
   */
  async handleToolMetadata(args) {
    const { projectId, filePath } = args || {};

    if (!projectId) {
      return {
        status: 400,
        data: { error: 'projectId is required' }
      };
    }

    if (!filePath) {
      return {
        status: 400,
        data: { error: 'filePath is required' }
      };
    }

    this.logger.info('tool.pdf.metadata.start', {
      project_id: projectId,
      file_path: filePath
    });

    try {
      const basePath = await this.getBasePath(projectId);
      const fullPath = this.validatePath(basePath, filePath);

      if (!fullPath.toLowerCase().endsWith('.pdf')) {
        return {
          status: 400,
          data: { error: 'File must be a PDF' }
        };
      }

      const stats = await fs.stat(fullPath);

      const metadata = {
        filePath,
        filename: path.basename(filePath),
        size: stats.size,
        sizeFormatted: this.formatBytes(stats.size),
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime
      };

      this.logger.info('tool.pdf.metadata.success', {
        project_id: projectId,
        file_path: filePath
      });

      return {
        status: 200,
        data: {
          success: true,
          projectId,
          ...metadata
        }
      };
    } catch (error) {
      const errorMsg = error?.message || String(error);
      this.logger.error('tool.pdf.metadata.error', {
        project_id: projectId,
        file_path: filePath,
        error: errorMsg
      });

      return {
        status: 500,
        data: {
          success: false,
          projectId,
          filePath,
          error: errorMsg
        }
      };
    }
  }

  /**
   * pdf.extract - Extract text from PDF
   * Note: Requires pdf-parse library for full functionality
   */
  async handleToolExtract(args) {
    const { projectId, filePath, page } = args || {};

    if (!projectId) {
      return {
        status: 400,
        data: { error: 'projectId is required' }
      };
    }

    if (!filePath) {
      return {
        status: 400,
        data: { error: 'filePath is required' }
      };
    }

    this.logger.info('tool.pdf.extract.start', {
      project_id: projectId,
      file_path: filePath,
      page: page || 'all'
    });

    try {
      const basePath = await this.getBasePath(projectId);
      const fullPath = this.validatePath(basePath, filePath);

      if (!fullPath.toLowerCase().endsWith('.pdf')) {
        return {
          status: 400,
          data: { error: 'File must be a PDF' }
        };
      }

      // Check if file exists
      await fs.stat(fullPath);

      let text = null;
      let pages = null;
      let method = null;

      // Try pdftotext first (poppler-utils) - lightweight, no npm dependencies
      try {
        const pageArgs = page ? `-f ${page} -l ${page}` : '';
        text = execSync(
          `pdftotext ${pageArgs} "${fullPath}" -`,
          { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
        );

        // Get page count with pdfinfo
        try {
          const info = execSync(`pdfinfo "${fullPath}"`, { encoding: 'utf-8' });
          const pagesMatch = info.match(/Pages:\s+(\d+)/);
          pages = pagesMatch ? parseInt(pagesMatch[1], 10) : null;
        } catch {
          // pdfinfo not available, pages will be null
        }

        method = 'pdftotext';
        this.logger.info('tool.pdf.extract.pdftotext.success', {
          project_id: projectId,
          file_path: filePath,
          pages,
          text_length: text?.length || 0
        });
      } catch (pdftotextError) {
        // pdftotext not available, try pdf-parse as fallback
        this.logger.debug('tool.pdf.extract.pdftotext.unavailable', {
          error: pdftotextError.message
        });

        try {
          const pdfParse = require('pdf-parse');
          const buffer = await fs.readFile(fullPath);
          const data = await pdfParse(buffer);

          text = data.text;
          pages = data.numpages;
          method = 'pdf-parse';

          this.logger.info('tool.pdf.extract.pdfparse.success', {
            project_id: projectId,
            file_path: filePath,
            pages,
            text_length: text?.length || 0
          });
        } catch (parseError) {
          // Neither pdftotext nor pdf-parse available
          this.logger.warn('tool.pdf.extract.no_parser', {
            pdftotext_error: pdftotextError.message,
            pdfparse_error: parseError.message
          });

          return {
            status: 200,
            data: {
              success: true,
              projectId,
              filePath,
              text: null,
              pages: null,
              note: 'No PDF parser available. Install poppler-utils (pdftotext) or pdf-parse npm package.',
              requestedPage: page || null
            }
          };
        }
      }

      return {
        status: 200,
        data: {
          success: true,
          projectId,
          filePath,
          text,
          pages,
          method,
          requestedPage: page || null
        }
      };
    } catch (error) {
      const errorMsg = error?.message || String(error);
      this.logger.error('tool.pdf.extract.error', {
        project_id: projectId,
        file_path: filePath,
        error: errorMsg
      });

      return {
        status: 500,
        data: {
          success: false,
          projectId,
          filePath,
          error: errorMsg
        }
      };
    }
  }
}

module.exports = PdfViewerModule;
