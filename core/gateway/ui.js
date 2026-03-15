/**
 * Event Core - UI Gateway
 *
 * Proxy to the SvelteKit frontend.
 * Legacy admin panel and UI renderer have been removed.
 * All UI is now served by the SvelteKit app in /frontend.
 */

class UIGateway {
  constructor(core) {
    this.core = core;
  }

  /**
   * Redirect to SvelteKit frontend
   */
  async serveAdminPanel(request, response) {
    // Redirect to SvelteKit dev server or production build
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    response.writeHead(302, { Location: frontendUrl });
    response.end();
  }

  /**
   * List all modules that have UI enabled
   * GET /ui/modules
   */
  async listModulesWithUI(request, response) {
    try {
      const modules = [];
      const moduleLoader = this.core.moduleLoader;

      if (!moduleLoader || !moduleLoader.loadedModules) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ modules: [] }));
        return;
      }

      for (const [moduleName, moduleData] of moduleLoader.loadedModules.entries()) {
        const moduleConfig = moduleData.manifest;

        if (moduleConfig.ui && moduleConfig.ui.enabled) {
          modules.push({
            name: moduleName,
            title: moduleConfig.ui.title || moduleConfig.name,
            description: moduleConfig.ui.description || moduleConfig.description || '',
            icon: moduleConfig.ui.icon || '',
            version: moduleConfig.version || '1.0.0'
          });
        }
      }

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ modules }));
    } catch (error) {
      this.core.logger.error('[UIGateway] Error listing modules:', error);
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Failed to list modules' }));
    }
  }

  /**
   * Get UI definition for a specific module
   * GET /ui/modules/:name
   */
  async getModuleUI(request, response) {
    try {
      const moduleName = request.params.name;
      const moduleLoader = this.core.moduleLoader;
      const moduleData = moduleLoader?.loadedModules.get(moduleName);

      if (!moduleData) {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: `Module "${moduleName}" not found` }));
        return;
      }

      const moduleConfig = moduleData.manifest;

      if (!moduleConfig.ui || !moduleConfig.ui.enabled) {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: `Module "${moduleName}" does not have UI enabled` }));
        return;
      }

      const uiDefinition = {
        name: moduleName,
        title: moduleConfig.ui.title || moduleConfig.name,
        description: moduleConfig.ui.description || moduleConfig.description || '',
        icon: moduleConfig.ui.icon || '',
        version: moduleConfig.version || '1.0.0',
        views: moduleConfig.ui.views || []
      };

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(uiDefinition));
    } catch (error) {
      this.core.logger.error('[UIGateway] Error getting module UI:', error);
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Failed to get module UI' }));
    }
  }
}

module.exports = UIGateway;
