/**
 * Credential Manager Module
 * Multi-level credential management with .env storage
 *
 * Levels (priority order):
 * 1. CUSTOM - highest priority, custom specific
 * 2. CLIENT - client-specific
 * 3. PROJECT - project-specific
 * 4. GLOBAL - fallback
 *
 * Follows event-driven architecture - NO HTTP internal calls
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

const { EVENTS } = require('../../core/constants');
const googleOAuth = require('./oauth/google');

class CredentialManagerModule {
  constructor() {
    this.name = 'credential-manager';
    this.version = '2.1.0';

    // State
    this.credentials = new Map(); // key -> value
    this.oauthConfigs = new Map(); // accountId -> { clientId, clientSecret, accountName }
    this.envFilePath = null;
    this.oauthPending = new Map(); // stateId -> { provider, level, identifier, scopes, createdAt }

    // Dependencies (injected)
    this.logger = null;
    this.metrics = null;
    this.eventBus = null;
    this.uiHandler = null;  // UI Request/Response handler
    this.config = null;
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(core) {
    this.logger = core.logger;
    this.metrics = core.metrics;
    this.eventBus = core.eventBus;
    this.uiHandler = core.uiHandler;
    this.activity = core.activity?.forModule('credential-manager');

    this.activity?.action('module.loading', {});

    // Load config from loader-injected moduleConfig
    this.config = core.moduleConfig || {};

    this.logger.info('module.loading', {
      module: this.name,
      version: this.version
    });

    // Configure env file path - use project root (2 levels up from module)
    const projectRoot = path.resolve(__dirname, '..', '..');
    this.envFilePath = path.join(projectRoot, this.config.envFile || '.env');

    // Load existing credentials
    await this.loadEnvFile();

    // Event subscriptions and UI handlers are auto-wired by the loader from module.json

    // Update metrics
    this.updateCredentialMetrics();

    this.logger.info('module.loaded', {
      module: this.name,
      version: this.version,
      env_file: this.envFilePath,
      credentials_count: this.credentials.size
    });

    // Publicar estado inicial via MQTT
    await this.publishState();
  }

  async onUnload() {
    this.logger.info('module.unloading', { module: this.name });

    // UI handlers and event subscriptions are auto-cleaned by the loader

    this.credentials.clear();
    this.oauthPending.clear();
    this.logger.info('module.unloaded', { module: this.name });
  }

  // ==========================================
  // Initialization Helpers
  // ==========================================

  async loadEnvFile() {
    try {
      if (!fsSync.existsSync(this.envFilePath)) {
        await fs.writeFile(this.envFilePath, '# Credentials\n');
        this.logger.info('env.file.created', { path: this.envFilePath });
        return;
      }

      const content = await fs.readFile(this.envFilePath, 'utf-8');
      const lines = content.split('\n');

      // Temporary storage for OAuth configs
      const oauthClientIds = new Map(); // accountId -> clientId
      const oauthClientSecrets = new Map(); // accountId -> clientSecret

      // Líneas no gestionadas que hay que preservar al guardar
      this._unmanagedLines = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const [key, ...valueParts] = trimmed.split('=');
          const value = valueParts.join('=');

          // API Key credentials (formato con nivel: _API_KEY_GLOBAL, _API_KEY_PROJECT_x, etc.)
          if (key.includes('_API_KEY_')) {
            this.credentials.set(key, value);
            process.env[key] = value;
          }
          // API Key credentials (formato legacy sin nivel: DEEPSEEK_API_KEY, GOOGLE_API_KEY, etc.)
          else if (key.endsWith('_API_KEY')) {
            this.credentials.set(key, value);
            process.env[key] = value;
          }
          // OAuth Client ID (GMAIL_CLIENT_ID or GMAIL_CLIENT_ID_accountName)
          else if (key.startsWith('GMAIL_CLIENT_ID')) {
            const accountId = key === 'GMAIL_CLIENT_ID' ? 'default' : key.replace('GMAIL_CLIENT_ID_', '');
            oauthClientIds.set(accountId, value);
            process.env[key] = value;
          }
          // OAuth Client Secret (GMAIL_CLIENT_SECRET or GMAIL_CLIENT_SECRET_accountName)
          else if (key.startsWith('GMAIL_CLIENT_SECRET')) {
            const accountId = key === 'GMAIL_CLIENT_SECRET' ? 'default' : key.replace('GMAIL_CLIENT_SECRET_', '');
            oauthClientSecrets.set(accountId, value);
            process.env[key] = value;
          }
          // OAuth Refresh Token (GMAIL_REFRESH_TOKEN or GMAIL_REFRESH_TOKEN_accountName)
          else if (key.startsWith('GMAIL_REFRESH_TOKEN')) {
            process.env[key] = value;
            this._unmanagedLines.push(trimmed);
          }
          // Telegram notification config (chatId + botName por nivel)
          else if (key.startsWith('TELEGRAM_CHAT_ID_') || key.startsWith('TELEGRAM_BOT_NAME_')) {
            this.credentials.set(key, value);
            process.env[key] = value;
          }
          // Cualquier otra variable: preservar
          else {
            process.env[key] = value;
            this._unmanagedLines.push(trimmed);
          }
        }
      }

      // Build oauthConfigs from matched pairs
      for (const [accountId, clientId] of oauthClientIds.entries()) {
        const clientSecret = oauthClientSecrets.get(accountId);
        if (clientSecret) {
          this.oauthConfigs.set(accountId, {
            accountId,
            accountName: accountId === 'default' ? 'Cuenta Principal' : accountId,
            clientId,
            clientSecret,
            configured: true
          });
        }
      }

      this.logger.info('env.file.loaded', {
        path: this.envFilePath,
        credentials_count: this.credentials.size,
        oauth_configs_count: this.oauthConfigs.size
      });
    } catch (error) {
      this.logger.error('env.file.load.error', {
        path: this.envFilePath,
        error: error.message
      });
    }
  }

  async saveEnvFile() {
    const startTime = Date.now();

    try {
      let content = '# Credentials managed by credential-manager\n';
      content += `# Last updated: ${new Date().toISOString()}\n\n`;

      // OAuth Configs section first
      if (this.oauthConfigs.size > 0) {
        content += '# OAuth2 Configurations (Google/Gmail)\n';
        for (const [accountId, config] of this.oauthConfigs.entries()) {
          if (accountId === 'default') {
            content += `GMAIL_CLIENT_ID=${config.clientId}\n`;
            content += `GMAIL_CLIENT_SECRET=${config.clientSecret}\n`;
          } else {
            content += `GMAIL_CLIENT_ID_${accountId}=${config.clientId}\n`;
            content += `GMAIL_CLIENT_SECRET_${accountId}=${config.clientSecret}\n`;
          }
        }
        content += '\n';
      }

      // Group API keys by level
      const grouped = { GLOBAL: [], PROJECT: [], CLIENT: [], CUSTOM: [] };

      for (const [key, value] of this.credentials.entries()) {
        const level = this.extractLevel(key);
        if (grouped[level]) {
          grouped[level].push({ key, value });
        }
      }

      // Write in order
      for (const level of ['GLOBAL', 'PROJECT', 'CLIENT', 'CUSTOM']) {
        if (grouped[level].length > 0) {
          content += `# ${level} credentials\n`;
          for (const { key, value } of grouped[level]) {
            content += `${key}=${value}\n`;
          }
          content += '\n';
        }
      }

      // Preservar líneas no gestionadas (refresh tokens, variables custom, etc.)
      if (this._unmanagedLines && this._unmanagedLines.length > 0) {
        content += '# Other variables (preserved)\n';
        for (const line of this._unmanagedLines) {
          content += `${line}\n`;
        }
        content += '\n';
      }

      await fs.writeFile(this.envFilePath, content);

      const duration = Date.now() - startTime;
      this.logger.info('env.file.saved', {
        path: this.envFilePath,
        credentials_count: this.credentials.size,
        oauth_configs_count: this.oauthConfigs.size,
        duration
      });

      if (this.metrics && typeof this.metrics.timing === 'function') {
        this.metrics.timing('credential.save.duration', duration);
      }
    } catch (error) {
      this.logger.error('env.file.save.error', {
        path: this.envFilePath,
        error: error.message
      });
      throw error;
    }
  }

  updateCredentialMetrics() {
    // Guard: metrics might not have gauge method
    if (!this.metrics || typeof this.metrics.gauge !== 'function') {
      return;
    }

    this.metrics.gauge('credential.count.total', this.credentials.size);

    const byLevel = { GLOBAL: 0, PROJECT: 0, CLIENT: 0, CUSTOM: 0 };
    for (const key of this.credentials.keys()) {
      const level = this.extractLevel(key);
      if (byLevel[level] !== undefined) {
        byLevel[level]++;
      }
    }

    for (const [level, count] of Object.entries(byLevel)) {
      this.metrics.gauge(`credential.count.${level.toLowerCase()}`, count);
    }
  }

  // ==========================================
  // Event Handlers (wired by loader from module.json)
  // ==========================================

  /**
   * Handler para solicitudes de estado desde el frontend
   * Recibe eventos via eventBus (frontend publica a core/{coreId}/events/credential/state/request)
   */
  async onStateRequest(event) {
    const correlationId = event?.correlation_id || event?.correlationId;
    this.logger.info('credential.state.request.received', { correlation_id: correlationId });
    await this.publishState(correlationId);
  }

  /**
   * Handler para crear credencial desde frontend
   * Recibe eventos via eventBus (frontend publica a core/{coreId}/events/credential/create)
   */
  async onCreateCredential(event) {
    // EventBus envía envelope con .data, MQTT directo envía .payload
    const payload = event?.data || event?.payload || event;
    const { provider, level, identifier, api_key } = payload;
    const correlationId = event?.correlation_id || event?.correlationId;

    this.logger.info('credential.create.mqtt.received', {
      provider,
      level,
      correlation_id: correlationId
    });

    try {
      // Validate
      const validation = this.validateLevel(level, identifier);
      if (!validation.valid) {
        this.logger.warn('credential.create.mqtt.validation_failed', {
          error: validation.error,
          correlation_id: correlationId
        });
        return;
      }

      // Build key and save
      const key = this.buildKey(provider, level, identifier);
      const isNew = !this.credentials.has(key);

      this.credentials.set(key, api_key);
      await this.saveEnvFile();
      process.env[key] = api_key;

      // Metrics
      if (isNew) {
        this.metrics.increment('credential.saved.total');
      } else {
        this.metrics.increment('credential.updated.total');
      }
      this.updateCredentialMetrics();

      // Publish notification event
      await this.eventBus.publish(EVENTS.CREDENTIAL.SAVED, {
        key,
        provider,
        level,
        identifier: identifier || null,
        created: isNew,
        updated: !isNew
      }, { correlationId });

      this.logger.info('credential.create.mqtt.success', {
        key,
        created: isNew,
        correlation_id: correlationId
      });

      // Publish updated state
      await this.publishState(correlationId);
    } catch (error) {
      this.logger.error('credential.create.mqtt.error', {
        error: error.message,
        correlation_id: correlationId
      });
      this.metrics.increment('credential.errors.total');
    }
  }

  /**
   * Handler para actualizar credencial desde frontend
   * Recibe eventos via eventBus (frontend publica a core/{coreId}/events/credential/update)
   */
  async onUpdateCredential(event) {
    // EventBus envía envelope con .data, MQTT directo envía .payload
    const payload = event?.data || event?.payload || event;
    const { key, api_key } = payload;
    const correlationId = event?.correlation_id || event?.correlationId;

    this.logger.info('credential.update.mqtt.received', {
      key,
      correlation_id: correlationId
    });

    if (!this.credentials.has(key)) {
      this.logger.warn('credential.update.mqtt.not_found', {
        key,
        correlation_id: correlationId
      });
      return;
    }

    try {
      this.credentials.set(key, api_key);
      await this.saveEnvFile();
      process.env[key] = api_key;

      this.metrics.increment('credential.updated.total');

      await this.eventBus.publish(EVENTS.CREDENTIAL.UPDATED, {
        key,
        updated_at: new Date().toISOString()
      }, { correlationId });

      this.logger.info('credential.update.mqtt.success', {
        key,
        correlation_id: correlationId
      });

      // Publish updated state
      await this.publishState(correlationId);
    } catch (error) {
      this.logger.error('credential.update.mqtt.error', {
        error: error.message,
        correlation_id: correlationId
      });
      this.metrics.increment('credential.errors.total');
    }
  }

  /**
   * Handler para eliminar credencial desde frontend
   * Recibe eventos via eventBus (frontend publica a core/{coreId}/events/credential/delete)
   */
  async onDeleteCredential(event) {
    // EventBus envía envelope con .data, MQTT directo envía .payload
    const payload = event?.data || event?.payload || event;
    const { key } = payload;
    const correlationId = event?.correlation_id || event?.correlationId;

    this.logger.info('credential.delete.mqtt.received', {
      key,
      correlation_id: correlationId
    });

    if (!this.credentials.has(key)) {
      this.logger.warn('credential.delete.mqtt.not_found', {
        key,
        correlation_id: correlationId
      });
      return;
    }

    try {
      this.credentials.delete(key);
      await this.saveEnvFile();
      delete process.env[key];

      this.metrics.increment('credential.deleted.total');
      this.updateCredentialMetrics();

      await this.eventBus.publish(EVENTS.CREDENTIAL.DELETED, {
        key,
        deleted_at: new Date().toISOString()
      }, { correlationId });

      this.logger.info('credential.delete.mqtt.success', {
        key,
        correlation_id: correlationId
      });

      // Publish updated state
      await this.publishState(correlationId);
    } catch (error) {
      this.logger.error('credential.delete.mqtt.error', {
        error: error.message,
        correlation_id: correlationId
      });
      this.metrics.increment('credential.errors.total');
    }
  }

  // ==========================================
  // Event Handlers (from other modules)
  // ==========================================

  async onResolveRequest(event) {
    const {
      provider,
      project_id,
      client_id,
      custom_id,
      request_id,
      correlation_id
    } = event.data || event.payload || event;

    this.logger.info('credential.resolve.request.received', {
      provider,
      project_id,
      client_id,
      custom_id,
      request_id,
      correlation_id
    });

    const startTime = Date.now();

    try {
      const result = this.resolveCredential(provider, {
        customId: custom_id,
        clientId: client_id,
        projectId: project_id
      });

      const duration = Date.now() - startTime;
      if (this.metrics && typeof this.metrics.timing === 'function') {
        this.metrics.timing('credential.resolve.duration', duration);
      }

      if (result.found) {
        this.metrics.increment('credential.resolved.total');

        this.logger.info('credential.resolve.request.success', {
          provider,
          resolved_from: result.resolvedFrom,
          duration,
          correlation_id
        });

        await this.publishResolveResponse(
          request_id,
          true,
          provider,
          result.apiKey,
          result.resolvedFrom,
          null,
          correlation_id
        );
      } else {
        this.metrics.increment('credential.resolve.failed.total');

        this.logger.warn('credential.resolve.request.not_found', {
          provider,
          attempts: result.attempts,
          correlation_id
        });

        await this.publishResolveResponse(
          request_id,
          false,
          provider,
          null,
          null,
          `No credential found for provider: ${provider}`,
          correlation_id
        );
      }
    } catch (error) {
      this.logger.error('credential.resolve.request.error', {
        provider,
        error: error.message,
        correlation_id
      });

      this.metrics.increment('credential.errors.total');

      await this.publishResolveResponse(
        request_id,
        false,
        provider,
        null,
        null,
        error.message,
        correlation_id
      );
    }
  }

  /**
   * Handler para resolución de credenciales OAuth (Gmail, Google)
   * Retorna { clientId, clientSecret, refreshToken }
   */
  async onOAuthResolveRequest(event) {
    const {
      provider,
      account,
      request_id,
      correlation_id
    } = event.data || event;

    this.logger.info('credential.oauth.resolve.request', {
      provider,
      account,
      request_id,
      correlation_id
    });

    const responseEvent = 'credential.oauth.resolve.response';

    try {
      // Buscar OAuth config (clientId, clientSecret)
      const accountsToTry = account ? [account, 'default'] : ['default'];
      let oauthConfig = null;
      let usedAccount = null;

      for (const acc of accountsToTry) {
        const config = this.oauthConfigs.get(acc);
        if (config && config.clientId && config.clientSecret) {
          oauthConfig = config;
          usedAccount = acc;
          break;
        }
        // Fallback to process.env
        const envClientId = acc === 'default'
          ? process.env.GMAIL_CLIENT_ID
          : process.env[`GMAIL_CLIENT_ID_${acc}`];
        const envClientSecret = acc === 'default'
          ? process.env.GMAIL_CLIENT_SECRET
          : process.env[`GMAIL_CLIENT_SECRET_${acc}`];

        if (envClientId && envClientSecret) {
          oauthConfig = { clientId: envClientId, clientSecret: envClientSecret };
          usedAccount = acc;
          break;
        }
      }

      if (!oauthConfig) {
        this.logger.warn('credential.oauth.resolve.no_config', { provider, account });
        await this.eventBus.publish(responseEvent, {
          request_id,
          success: false,
          provider,
          account,
          error: `No OAuth config found for account: ${account || 'default'}`
        });
        return;
      }

      // Buscar refresh token
      let refreshToken = null;
      for (const acc of accountsToTry) {
        // Buscar en credentials Map (patrón GMAIL_API_KEY_CUSTOM_{account})
        const customKey = this.buildKey('GMAIL', 'CUSTOM', acc);
        if (this.credentials.has(customKey)) {
          refreshToken = this.credentials.get(customKey);
          break;
        }
        // Fallback a process.env
        const envRefreshToken = acc === 'default'
          ? process.env.GMAIL_REFRESH_TOKEN
          : process.env[`GMAIL_REFRESH_TOKEN_${acc}`];
        if (envRefreshToken) {
          refreshToken = envRefreshToken;
          break;
        }
      }

      if (!refreshToken) {
        this.logger.warn('credential.oauth.resolve.no_refresh_token', { provider, account });
        await this.eventBus.publish(responseEvent, {
          request_id,
          success: false,
          provider,
          account,
          error: `No refresh token found for account: ${account || 'default'}`
        });
        return;
      }

      // Éxito - retornar los 3 valores
      this.logger.info('credential.oauth.resolve.success', {
        provider,
        account: usedAccount,
        correlation_id
      });

      this.metrics.increment('credential.oauth.resolved.total');

      await this.eventBus.publish(responseEvent, {
        request_id,
        success: true,
        provider,
        account: usedAccount,
        credentials: {
          clientId: oauthConfig.clientId,
          clientSecret: oauthConfig.clientSecret,
          refreshToken
        },
        resolved_from: usedAccount === 'default' ? 'GLOBAL' : 'CUSTOM'
      });

    } catch (error) {
      this.logger.error('credential.oauth.resolve.error', {
        provider,
        account,
        error: error.message,
        correlation_id
      });

      this.metrics.increment('credential.errors.total');

      await this.eventBus.publish(responseEvent, {
        request_id,
        success: false,
        provider,
        account,
        error: error.message
      });
    }
  }

  // ==========================================
  // HTTP API Handlers
  // ==========================================

  async handleSaveCredential(req, context) {
    const startTime = Date.now();

    this.logger.info('credential.save.start', {
      correlation_id: context.correlationId
    });

    try {
      const { provider, level, identifier, api_key } = req.body || {};

      // Validate
      const validation = this.validateLevel(level, identifier);
      if (!validation.valid) {
        this.logger.warn('credential.save.validation_failed', {
          provider,
          level,
          error: validation.error,
          correlation_id: context.correlationId
        });

        return {
          status: 400,
          data: { success: false, error: validation.error }
        };
      }

      // Build key
      const key = this.buildKey(provider, level, identifier);
      const isNew = !this.credentials.has(key);

      // Save to memory and file
      this.credentials.set(key, api_key);
      await this.saveEnvFile();

      // Also update process.env for immediate availability to other modules
      process.env[key] = api_key;

      // Metrics
      if (isNew) {
        this.metrics.increment('credential.saved.total');
      } else {
        this.metrics.increment('credential.updated.total');
      }
      this.updateCredentialMetrics();

      // Publish event
      await this.eventBus.publish(EVENTS.CREDENTIAL.SAVED, {
        key,
        provider,
        level,
        identifier: identifier || null,
        created: isNew,
        updated: !isNew
      }, { correlationId: context.correlationId });

      this.logger.info('credential.saved', {
        key,
        created: isNew,
        duration: Date.now() - startTime,
        correlation_id: context.correlationId
      });

      // Publicar estado actualizado via MQTT
      await this.publishState(context.correlationId);

      return {
        status: isNew ? 201 : 200,
        data: {
          success: true,
          credential: {
            key,
            provider,
            level,
            identifier: identifier || null,
            created: isNew,
            updated: !isNew
          }
        }
      };
    } catch (error) {
      this.logger.error('credential.save.error', {
        error: error.message,
        correlation_id: context.correlationId
      });

      this.metrics.increment('credential.errors.total');

      return {
        status: 500,
        data: {
          success: false,
          error: 'Failed to save credential',
          message: error.message
        }
      };
    }
  }

  async handleResolveCredential(req, context) {
    const startTime = Date.now();
    const { provider, clientId, projectId, customId } = req.query || {};

    this.logger.info('credential.resolve.start', {
      provider,
      correlation_id: context.correlationId
    });

    if (!provider) {
      return {
        status: 400,
        data: { success: false, error: 'Provider is required' }
      };
    }

    try {
      const result = this.resolveCredential(provider, {
        customId,
        clientId,
        projectId
      });

      const duration = Date.now() - startTime;
      if (this.metrics && typeof this.metrics.timing === 'function') {
        this.metrics.timing('credential.resolve.duration', duration);
      }

      if (result.found) {
        this.metrics.increment('credential.resolved.total');

        await this.eventBus.publish(EVENTS.CREDENTIAL.RESOLVED, {
          provider,
          resolved_from: result.resolvedFrom,
          key: result.key
        }, { correlationId: context.correlationId });

        this.logger.info('credential.resolved', {
          provider,
          resolved_from: result.resolvedFrom,
          duration,
          correlation_id: context.correlationId
        });

        return {
          status: 200,
          data: {
            success: true,
            found: true,
            credential: {
              provider,
              level: result.resolvedFrom,
              identifier: result.identifier,
              api_key: result.apiKey,
              key: result.key
            },
            resolved_from: result.resolvedFrom
          }
        };
      } else {
        this.metrics.increment('credential.resolve.failed.total');

        await this.eventBus.publish(EVENTS.CREDENTIAL.RESOLVE_FAILED, {
          provider,
          attempts: result.attempts
        }, { correlationId: context.correlationId });

        this.logger.warn('credential.resolve.not_found', {
          provider,
          attempts: result.attempts,
          correlation_id: context.correlationId
        });

        return {
          status: 404,
          data: {
            success: false,
            found: false,
            message: `No credential found for provider: ${provider}`,
            attempts: result.attempts
          }
        };
      }
    } catch (error) {
      this.logger.error('credential.resolve.error', {
        error: error.message,
        correlation_id: context.correlationId
      });

      this.metrics.increment('credential.errors.total');

      return {
        status: 500,
        data: {
          success: false,
          error: 'Failed to resolve credential',
          message: error.message
        }
      };
    }
  }

  async handleListCredentials(req, context) {
    this.logger.info('credential.list.start', {
      correlation_id: context.correlationId
    });

    try {
      const { level, provider } = req.query || {};
      const masked = [];

      for (const [key, value] of this.credentials.entries()) {
        const parsed = this.parseKey(key);
        if (!parsed) continue;

        // Apply filters
        if (level && parsed.level !== level) continue;
        if (provider && parsed.provider !== provider) continue;

        masked.push({
          key,
          provider: parsed.provider,
          level: parsed.level,
          identifier: parsed.identifier,
          api_key_preview: this.maskApiKey(value)
        });
      }

      this.logger.info('credential.listed', {
        count: masked.length,
        filters: { level, provider },
        correlation_id: context.correlationId
      });

      return {
        status: 200,
        data: {
          success: true,
          credentials: masked,
          total: masked.length,
          filters: { level, provider }
        }
      };
    } catch (error) {
      this.logger.error('credential.list.error', {
        error: error.message,
        correlation_id: context.correlationId
      });

      return {
        status: 500,
        data: {
          success: false,
          error: 'Failed to list credentials',
          message: error.message
        }
      };
    }
  }

  async handleUpdateCredential(req, context) {
    const { key } = req.params || {};
    const { api_key } = req.body || {};

    this.logger.info('credential.update.start', {
      key,
      correlation_id: context.correlationId
    });

    if (!api_key) {
      return {
        status: 400,
        data: { success: false, error: 'api_key is required' }
      };
    }

    if (!this.credentials.has(key)) {
      this.logger.warn('credential.update.not_found', {
        key,
        correlation_id: context.correlationId
      });

      return {
        status: 404,
        data: { success: false, error: `Credential not found: ${key}` }
      };
    }

    try {
      this.credentials.set(key, api_key);
      await this.saveEnvFile();

      // Also update process.env for immediate availability
      process.env[key] = api_key;

      this.metrics.increment('credential.updated.total');

      await this.eventBus.publish(EVENTS.CREDENTIAL.UPDATED, {
        key,
        updated_at: new Date().toISOString()
      }, { correlationId: context.correlationId });

      this.logger.info('credential.updated', {
        key,
        correlation_id: context.correlationId
      });

      // Publicar estado actualizado via MQTT
      await this.publishState(context.correlationId);

      return {
        status: 200,
        data: { success: true, key, updated: true }
      };
    } catch (error) {
      this.logger.error('credential.update.error', {
        error: error.message,
        correlation_id: context.correlationId
      });

      this.metrics.increment('credential.errors.total');

      return {
        status: 500,
        data: {
          success: false,
          error: 'Failed to update credential',
          message: error.message
        }
      };
    }
  }

  async handleDeleteCredential(req, context) {
    const { key } = req.params || {};

    this.logger.info('credential.delete.start', {
      key,
      correlation_id: context.correlationId
    });

    if (!this.credentials.has(key)) {
      this.logger.warn('credential.delete.not_found', {
        key,
        correlation_id: context.correlationId
      });

      return {
        status: 404,
        data: { success: false, error: `Credential not found: ${key}` }
      };
    }

    try {
      this.credentials.delete(key);
      await this.saveEnvFile();

      // Also remove from process.env
      delete process.env[key];

      this.metrics.increment('credential.deleted.total');
      this.updateCredentialMetrics();

      await this.eventBus.publish(EVENTS.CREDENTIAL.DELETED, {
        key,
        deleted_at: new Date().toISOString()
      }, { correlationId: context.correlationId });

      this.logger.info('credential.deleted', {
        key,
        correlation_id: context.correlationId
      });

      // Publicar estado actualizado via MQTT
      await this.publishState(context.correlationId);

      return {
        status: 200,
        data: { success: true, key, deleted: true }
      };
    } catch (error) {
      this.logger.error('credential.delete.error', {
        error: error.message,
        correlation_id: context.correlationId
      });

      this.metrics.increment('credential.errors.total');

      return {
        status: 500,
        data: {
          success: false,
          error: 'Failed to delete credential',
          message: error.message
        }
      };
    }
  }

  async handleGetLevels(req, context) {
    const levels = Object.entries(this.config.levels || {}).map(([name, info]) => ({
      name,
      priority: info.priority,
      requires_identifier: info.requiresIdentifier,
      description: info.description
    }));

    levels.sort((a, b) => a.priority - b.priority);

    this.logger.info('credential.levels.retrieved', {
      count: levels.length,
      correlation_id: context.correlationId
    });

    return {
      status: 200,
      data: { success: true, levels, total: levels.length }
    };
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
        credentials_count: this.credentials.size,
        env_file: this.envFilePath
      }
    };
  }

  async handleGetMetrics(req, context) {
    const byLevel = { GLOBAL: 0, PROJECT: 0, CLIENT: 0, CUSTOM: 0 };
    for (const key of this.credentials.keys()) {
      const level = this.extractLevel(key);
      if (byLevel[level] !== undefined) {
        byLevel[level]++;
      }
    }

    return {
      status: 200,
      data: {
        counters: {
          'credential.saved.total': this.metrics.getCounter('credential.saved.total') || 0,
          'credential.updated.total': this.metrics.getCounter('credential.updated.total') || 0,
          'credential.deleted.total': this.metrics.getCounter('credential.deleted.total') || 0,
          'credential.resolved.total': this.metrics.getCounter('credential.resolved.total') || 0,
          'credential.resolve.failed.total': this.metrics.getCounter('credential.resolve.failed.total') || 0
        },
        gauges: {
          'credential.count.total': this.credentials.size,
          'credential.count.by_level': byLevel
        }
      }
    };
  }

  // ==========================================
  // MQTT State Publisher - Estado via eventos
  // ==========================================

  /**
   * Genera el estado UI completo para publicar via MQTT
   */
  getUIState() {
    // Proveedores disponibles con metadata UI
    const providers = [
      { id: 'DEEPSEEK', name: 'DeepSeek', icon: '🔮' },
      { id: 'ANTHROPIC', name: 'Anthropic', icon: '🧠' },
      { id: 'OPENAI', name: 'OpenAI', icon: '🤖' },
      { id: 'GROQ', name: 'Groq', icon: '⚡' },
      { id: 'GEMINI', name: 'Google Gemini', icon: '💎' },
      { id: 'OLLAMA', name: 'Ollama', icon: '🦙' },
      { id: 'GOOGLE', name: 'Google Cloud', icon: '☁️' },
      { id: 'GMAIL', name: 'Gmail', icon: '📧' },
      { id: 'GLOVO', name: 'Glovo', icon: '🛵' },
      { id: 'CLOUDFLARE', name: 'Cloudflare', icon: '☁️' }
    ];

    // Niveles disponibles con metadata UI
    const levels = [
      { id: 'GLOBAL', name: 'Global', icon: '🟢', requiresIdentifier: false },
      { id: 'PROJECT', name: 'Proyecto', icon: '🔵', requiresIdentifier: true },
      { id: 'CLIENT', name: 'Cliente', icon: '🟡', requiresIdentifier: true },
      { id: 'CUSTOM', name: 'Custom', icon: '🔴', requiresIdentifier: true }
    ];

    // Credenciales agrupadas y enriquecidas
    const credentialsGrouped = {
      GLOBAL: [],
      PROJECT: [],
      CLIENT: [],
      CUSTOM: []
    };

    for (const [key, value] of this.credentials.entries()) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;

      const provider = providers.find(p => p.id === parsed.provider);
      const credential = {
        key,
        provider: parsed.provider,
        providerName: provider?.name || parsed.provider,
        providerIcon: provider?.icon || '🔑',
        level: parsed.level,
        identifier: parsed.identifier,
        preview: this.maskApiKey(value)
      };

      // Group by level
      if (credentialsGrouped[parsed.level]) {
        credentialsGrouped[parsed.level].push(credential);
      }
    }

    // Estadísticas
    const stats = {
      total: this.credentials.size,
      byLevel: { GLOBAL: 0, PROJECT: 0, CLIENT: 0, CUSTOM: 0 }
    };
    for (const key of this.credentials.keys()) {
      const level = this.extractLevel(key);
      if (stats.byLevel[level] !== undefined) {
        stats.byLevel[level]++;
      }
    }

    // OAuth Configs for UI (masked secrets)
    const oauthConfigs = [];
    for (const [accountId, config] of this.oauthConfigs.entries()) {
      oauthConfigs.push({
        accountId,
        accountName: config.accountName || accountId,
        clientId: config.clientId,
        clientIdPreview: this.maskApiKey(config.clientId),
        hasSecret: !!config.clientSecret,
        configured: true
      });
    }

    // Glovo Configs for UI (masked secrets)
    const glovoConfigs = this.getGlovoConfigs();

    // Telegram Notification Configs for UI (chatId + botName por nivel)
    const telegramNotifConfigs = this.getTelegramNotifConfigs();

    return {
      providers,
      levels,
      credentials: credentialsGrouped,
      stats,
      oauthConfigs,
      glovoConfigs,
      telegramNotifConfigs
    };
  }

  /**
   * Publica el estado actual via eventBus
   * EventBus transforma 'credential.state' → 'core/{coreId}/events/credential/state'
   * Frontend suscribe a 'core/{coreId}/events/credential/state'
   */
  async publishState(correlationId = null) {
    const state = this.getUIState();

    // Publicar via eventBus → MQTT topic: core/*/events/credential/state
    await this.eventBus.emit(EVENTS.CREDENTIAL.STATE, state);
    this.logger.info('credential.state.published', {
      total: state.stats.total,
      correlation_id: correlationId
    });
  }

  // ==========================================
  // UI Request/Response Handlers
  // Patrón Request/Response sobre MQTT
  // Frontend usa: await mqttRequest('credential', 'list')
  // ==========================================

  /**
   * UI Handler: Listar credenciales
   * Request: mqttRequest('credential', 'list')
   */
  async handleUIList(data, request) {
    return this.getUIState();
  }

  /**
   * UI Handler: Obtener credencial por key
   * Request: mqttRequest('credential', 'get', { key })
   */
  async handleUIGet(data, request) {
    const { key } = data;

    if (!key) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Credential key is required' };
    }

    const value = this.credentials.get(key);
    if (!value) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Credential not found' };
    }

    const parsed = this.parseKey(key);
    const provider = parsed?.provider || 'UNKNOWN';
    const level = parsed?.level || 'UNKNOWN';
    const identifier = parsed?.identifier || null;

    // Provider icons
    const providerIcons = {
      'OPENAI': '🤖',
      'DEEPSEEK': '🔮',
      'ANTHROPIC': '🧠',
      'OLLAMA': '🦙',
      'GOOGLE': '☁️',
      'GMAIL': '📧',
      'GLOVO': '🛵'
    };

    return {
      credential: {
        key,
        provider,
        providerName: provider,
        providerIcon: providerIcons[provider] || '🔑',
        level,
        identifier,
        preview: this.maskApiKey(value)
      }
    };
  }

  /**
   * UI Handler: Crear credencial
   * Request: mqttRequest('credential', 'create', { provider, level, identifier?, api_key })
   */
  async handleUICreate(data, request) {
    const { provider, level, identifier, api_key } = data;

    if (!provider) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Provider is required' };
    }
    if (!level) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Level is required' };
    }
    if (!api_key) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'API key is required' };
    }

    // Generar key
    const key = this.buildKey(provider, level, identifier);

    // Verificar si ya existe
    const existed = this.credentials.has(key);

    // Guardar
    this.credentials.set(key, api_key);
    process.env[key] = api_key;
    await this.saveEnvFile();
    this.updateCredentialMetrics();

    return {
      key,
      created: !existed,
      updated: existed
    };
  }

  /**
   * UI Handler: Actualizar credencial
   * Request: mqttRequest('credential', 'update', { key, api_key })
   */
  async handleUIUpdate(data, request) {
    const { key, api_key } = data;

    if (!key) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Credential key is required' };
    }
    if (!api_key) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'API key is required' };
    }

    if (!this.credentials.has(key)) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Credential not found' };
    }

    this.credentials.set(key, api_key);
    process.env[key] = api_key;
    await this.saveEnvFile();
    this.updateCredentialMetrics();

    return { key, updated: true };
  }

  /**
   * UI Handler: Eliminar credencial
   * Request: mqttRequest('credential', 'delete', { key })
   */
  async handleUIDelete(data, request) {
    const { key } = data;

    if (!key) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Credential key is required' };
    }

    if (!this.credentials.has(key)) {
      throw { status: 404, code: 'NOT_FOUND', message: 'Credential not found' };
    }

    this.credentials.delete(key);
    delete process.env[key];
    await this.saveEnvFile();
    this.updateCredentialMetrics();

    return { key, deleted: true };
  }

  /**
   * UI Handler: Testear API key
   * Request: mqttRequest('credential', 'test', { provider, api_key })
   */
  async handleUITest(data, request) {
    const { provider, api_key } = data;

    if (!provider) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Provider is required' };
    }
    if (!api_key) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'API key is required' };
    }

    let valid = false;
    let message = '';

    try {
      switch (provider.toUpperCase()) {
        case 'DEEPSEEK':
          valid = await this.testDeepSeek(api_key);
          message = valid ? 'API key válida' : 'API key inválida o sin créditos';
          break;

        case 'OPENAI':
          valid = await this.testOpenAI(api_key);
          message = valid ? 'API key válida' : 'API key inválida';
          break;

        case 'ANTHROPIC':
          valid = await this.testAnthropic(api_key);
          message = valid ? 'API key válida' : 'API key inválida';
          break;

        case 'GROQ':
          valid = await this.testGroq(api_key);
          message = valid ? 'API key válida' : 'API key inválida';
          break;

        case 'GEMINI':
          valid = await this.testGemini(api_key);
          message = valid ? 'API key válida' : 'API key inválida';
          break;

        case 'OLLAMA':
          valid = api_key && api_key.length > 0;
          message = 'Ollama es local - no requiere validación';
          break;

        case 'GMAIL':
          valid = await this.testGmail(api_key);
          message = valid ? 'Refresh token válido' : 'Refresh token inválido o credenciales incompletas';
          break;

        case 'GLOVO':
          // Glovo usa credenciales multi-campo, test se hace desde glovo.save
          valid = api_key && api_key.length > 5;
          message = valid ? 'Formato válido' : 'Client ID demasiado corto';
          break;

        case 'CLOUDFLARE':
          valid = await this.testCloudflare(api_key);
          message = valid ? 'API token válido — permisos Workers confirmados' : 'API token inválido o sin permisos de Workers';
          break;

        default:
          valid = api_key && api_key.length > 10;
          message = 'Provider no reconocido - validación básica';
      }
    } catch (error) {
      message = `Error al validar: ${error.message}`;
    }

    return { valid, provider, message };
  }

  // ==========================================
  // OAuth2 UI Handlers
  // ==========================================

  /**
   * UI Handler: Iniciar flujo OAuth2
   * Request: mqttRequest('credential', 'oauth.start', { provider, level, identifier?, scopes? })
   *
   * Flujo:
   * 1. UI llama oauth.start con provider/level/identifier
   * 2. Backend genera URL de autorización y state único
   * 3. UI abre popup/redirect a auth_url
   * 4. Usuario autoriza en Google
   * 5. Google callback a /oauth/callback con code
   * 6. Backend intercambia code por tokens y guarda refresh_token
   * 7. Backend emite credential.saved y actualiza estado
   */
  async handleUIOAuthStart(data, request) {
    const { provider, level, identifier, scopes = ['gmail'], oauthAccountId } = data;

    if (!provider) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Provider is required' };
    }
    if (!level) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'Level is required' };
    }

    // Validar level
    const validation = this.validateLevel(level, identifier);
    if (!validation.valid) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: validation.error };
    }

    // Solo soportamos Google/Gmail por ahora
    const supportedProviders = ['GMAIL', 'GOOGLE'];
    if (!supportedProviders.includes(provider.toUpperCase())) {
      throw {
        status: 400,
        code: 'UNSUPPORTED_PROVIDER',
        message: `OAuth not supported for provider: ${provider}. Supported: ${supportedProviders.join(', ')}`
      };
    }

    // Buscar client_id y client_secret
    // Prioridad:
    // 1. oauthAccountId específico (si se proporciona)
    // 2. identifier como accountId
    // 3. "default"
    let clientId = null;
    let clientSecret = null;
    let usedAccountId = null;

    // Lista de accountIds a intentar
    const accountIdsToTry = [];
    if (oauthAccountId) accountIdsToTry.push(oauthAccountId);
    if (identifier) accountIdsToTry.push(identifier);
    accountIdsToTry.push('default');

    // Buscar primero en oauthConfigs (configurados desde UI)
    for (const accId of accountIdsToTry) {
      const config = this.oauthConfigs.get(accId);
      if (config && config.clientId && config.clientSecret) {
        clientId = config.clientId;
        clientSecret = config.clientSecret;
        usedAccountId = accId;
        break;
      }
    }

    // Si no se encontró en oauthConfigs, buscar en process.env (legacy)
    if (!clientId || !clientSecret) {
      for (const accId of accountIdsToTry) {
        const envClientId = accId === 'default'
          ? process.env.GMAIL_CLIENT_ID
          : process.env[`GMAIL_CLIENT_ID_${accId}`];
        const envClientSecret = accId === 'default'
          ? process.env.GMAIL_CLIENT_SECRET
          : process.env[`GMAIL_CLIENT_SECRET_${accId}`];

        if (envClientId && envClientSecret) {
          clientId = envClientId;
          clientSecret = envClientSecret;
          usedAccountId = accId;
          break;
        }
      }
    }

    if (!clientId || !clientSecret) {
      // Listar cuentas disponibles para mensaje de error más útil
      const availableAccounts = Array.from(this.oauthConfigs.keys());
      throw {
        status: 400,
        code: 'MISSING_OAUTH_CREDENTIALS',
        message: availableAccounts.length > 0
          ? `No OAuth config found for accounts: ${accountIdsToTry.join(', ')}. Available: ${availableAccounts.join(', ')}`
          : 'No OAuth configurations found. Please configure OAuth credentials first in the Credentials panel (OAuth Config tab).'
      };
    }

    // Generar state único para validar callback
    const stateId = crypto.randomBytes(16).toString('hex');

    // Construir redirect URI
    const baseUrl = process.env.BASE_URL || process.env.API_URL || 'http://localhost:3000';
    const redirectUri = `${baseUrl}/modules/credential-manager/oauth/callback`;

    // State incluye info para el callback
    const state = {
      id: stateId,
      provider: provider.toUpperCase(),
      level,
      identifier: identifier || null
    };

    // Guardar pending OAuth
    this.oauthPending.set(stateId, {
      provider: provider.toUpperCase(),
      level,
      identifier: identifier || null,
      scopes,
      clientId,
      clientSecret,
      redirectUri,
      createdAt: Date.now()
    });

    // Limpiar OAuth pendientes antiguos (> 10 minutos)
    this.cleanupPendingOAuth();

    // Generar URL de autorización
    const authUrl = googleOAuth.getAuthUrl({
      clientId,
      redirectUri,
      state,
      scopes
    });

    this.logger.info('oauth.start.initiated', {
      provider,
      level,
      identifier,
      stateId,
      scopes,
      usedAccountId
    });

    return {
      auth_url: authUrl,
      state_id: stateId,
      expires_in: 600, // 10 minutos
      instructions: 'Open auth_url in browser. After authorization, credential will be saved automatically.'
    };
  }

  /**
   * UI Handler: Verificar estado de OAuth pendiente
   * Request: mqttRequest('credential', 'oauth.status', { state_id })
   */
  async handleUIOAuthStatus(data, request) {
    const { state_id } = data;

    if (!state_id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'state_id is required' };
    }

    const pending = this.oauthPending.get(state_id);

    if (!pending) {
      // Si no está pendiente, puede ser que ya se completó
      return {
        state_id,
        status: 'completed_or_expired',
        message: 'OAuth flow completed or expired'
      };
    }

    const elapsed = Date.now() - pending.createdAt;
    const remainingMs = Math.max(0, 600000 - elapsed); // 10 minutos

    return {
      state_id,
      status: 'pending',
      provider: pending.provider,
      level: pending.level,
      identifier: pending.identifier,
      remaining_seconds: Math.floor(remainingMs / 1000)
    };
  }

  // ==========================================
  // OAuth Config Handlers - Configurar Client ID y Secret
  // ==========================================

  /**
   * UI Handler: Listar configuraciones OAuth
   * Request: mqttRequest('credential', 'oauth.config.list')
   */
  async handleUIOAuthConfigList(data, request) {
    const configs = [];
    for (const [accountId, config] of this.oauthConfigs.entries()) {
      configs.push({
        accountId,
        accountName: config.accountName || accountId,
        clientId: config.clientId,
        clientIdPreview: this.maskApiKey(config.clientId),
        hasSecret: !!config.clientSecret,
        configured: true
      });
    }

    return {
      configs,
      total: configs.length
    };
  }

  /**
   * UI Handler: Guardar configuración OAuth
   * Request: mqttRequest('credential', 'oauth.config.save', { accountId, accountName?, clientId, clientSecret })
   *
   * accountId: Identificador único de la cuenta (ej: "empresa", "personal", "default")
   * accountName: Nombre amigable para mostrar en UI
   * clientId: OAuth Client ID de Google Cloud Console
   * clientSecret: OAuth Client Secret de Google Cloud Console
   */
  async handleUIOAuthConfigSave(data, request) {
    const { accountId, accountName, clientId, clientSecret } = data;

    if (!accountId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'accountId is required (e.g., "default", "empresa", "personal")' };
    }
    if (!clientId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'clientId is required (from Google Cloud Console)' };
    }
    if (!clientSecret) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'clientSecret is required (from Google Cloud Console)' };
    }

    // Validar formato básico de Client ID
    if (!clientId.includes('.apps.googleusercontent.com')) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'clientId format invalid. Should end with .apps.googleusercontent.com' };
    }

    const isNew = !this.oauthConfigs.has(accountId);

    // Guardar en memoria
    this.oauthConfigs.set(accountId, {
      accountId,
      accountName: accountName || accountId,
      clientId,
      clientSecret,
      configured: true
    });

    // Guardar en process.env para uso inmediato
    if (accountId === 'default') {
      process.env.GMAIL_CLIENT_ID = clientId;
      process.env.GMAIL_CLIENT_SECRET = clientSecret;
    } else {
      process.env[`GMAIL_CLIENT_ID_${accountId}`] = clientId;
      process.env[`GMAIL_CLIENT_SECRET_${accountId}`] = clientSecret;
    }

    // Persistir en archivo .env
    await this.saveEnvFile();

    this.logger.info('oauth.config.saved', {
      accountId,
      isNew
    });

    // Publicar estado actualizado
    await this.publishState();

    return {
      accountId,
      accountName: accountName || accountId,
      created: isNew,
      updated: !isNew,
      message: `OAuth configuration ${isNew ? 'created' : 'updated'} for account: ${accountId}`
    };
  }

  /**
   * UI Handler: Eliminar configuración OAuth
   * Request: mqttRequest('credential', 'oauth.config.delete', { accountId })
   */
  async handleUIOAuthConfigDelete(data, request) {
    const { accountId } = data;

    if (!accountId) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'accountId is required' };
    }

    if (!this.oauthConfigs.has(accountId)) {
      throw { status: 404, code: 'NOT_FOUND', message: `OAuth config not found: ${accountId}` };
    }

    // Eliminar de memoria
    this.oauthConfigs.delete(accountId);

    // Eliminar de process.env
    if (accountId === 'default') {
      delete process.env.GMAIL_CLIENT_ID;
      delete process.env.GMAIL_CLIENT_SECRET;
    } else {
      delete process.env[`GMAIL_CLIENT_ID_${accountId}`];
      delete process.env[`GMAIL_CLIENT_SECRET_${accountId}`];
    }

    // Persistir en archivo .env
    await this.saveEnvFile();

    this.logger.info('oauth.config.deleted', { accountId });

    // Publicar estado actualizado
    await this.publishState();

    return {
      accountId,
      deleted: true
    };
  }

  // ==========================================
  // Glovo Credential Handlers
  // ==========================================

  /**
   * UI Handler: Guardar configuración Glovo
   * Request: mqttRequest('credential', 'glovo.save', { level, identifier?, client_id, client_secret, chain_id })
   *
   * Glovo requiere 3 credenciales: Client ID, Client Secret y Chain ID.
   * Se guardan como GLOVO_CLIENT_ID_{LEVEL}[_{ID}], GLOVO_CLIENT_SECRET_{LEVEL}[_{ID}], GLOVO_CHAIN_ID_{LEVEL}[_{ID}]
   */
  async handleUIGlovoSave(data, request) {
    const { level, identifier, client_id, client_secret, chain_id } = data;

    if (!client_id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'client_id es requerido (de Glovo Developer Portal)' };
    }
    if (!client_secret) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'client_secret es requerido (de Glovo Developer Portal)' };
    }
    if (!chain_id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'chain_id es requerido (ID del restaurante en Glovo)' };
    }

    const validLevel = level || 'GLOBAL';
    const suffix = validLevel === 'GLOBAL' ? '_GLOBAL' : `_${validLevel}_${identifier}`;

    const keyClientId = `GLOVO_CLIENT_ID${suffix}`;
    const keyClientSecret = `GLOVO_CLIENT_SECRET${suffix}`;
    const keyChainId = `GLOVO_CHAIN_ID${suffix}`;

    const isNew = !this.credentials.has(keyClientId);

    // Guardar las 3 credenciales en memoria
    this.credentials.set(keyClientId, client_id);
    this.credentials.set(keyClientSecret, client_secret);
    this.credentials.set(keyChainId, chain_id);

    // Guardar en process.env para uso inmediato
    process.env[keyClientId] = client_id;
    process.env[keyClientSecret] = client_secret;
    process.env[keyChainId] = chain_id;

    // Persistir en archivo .env
    await this.saveEnvFile();
    this.updateCredentialMetrics();

    this.logger.info('glovo.config.saved', {
      level: validLevel,
      identifier: identifier || null,
      isNew
    });

    // Publicar estado actualizado
    await this.publishState();

    return {
      level: validLevel,
      identifier: identifier || null,
      created: isNew,
      updated: !isNew,
      keys: [keyClientId, keyClientSecret, keyChainId]
    };
  }

  /**
   * UI Handler: Eliminar configuración Glovo
   * Request: mqttRequest('credential', 'glovo.delete', { level, identifier? })
   */
  async handleUIGlovoDelete(data, request) {
    const { level, identifier } = data;

    const validLevel = level || 'GLOBAL';
    const suffix = validLevel === 'GLOBAL' ? '_GLOBAL' : `_${validLevel}_${identifier}`;

    const keyClientId = `GLOVO_CLIENT_ID${suffix}`;
    const keyClientSecret = `GLOVO_CLIENT_SECRET${suffix}`;
    const keyChainId = `GLOVO_CHAIN_ID${suffix}`;

    if (!this.credentials.has(keyClientId)) {
      throw { status: 404, code: 'NOT_FOUND', message: `Configuración Glovo no encontrada para nivel ${validLevel}` };
    }

    // Eliminar de memoria
    this.credentials.delete(keyClientId);
    this.credentials.delete(keyClientSecret);
    this.credentials.delete(keyChainId);

    // Eliminar de process.env
    delete process.env[keyClientId];
    delete process.env[keyClientSecret];
    delete process.env[keyChainId];

    // Persistir
    await this.saveEnvFile();
    this.updateCredentialMetrics();

    this.logger.info('glovo.config.deleted', { level: validLevel, identifier: identifier || null });

    // Publicar estado actualizado
    await this.publishState();

    return { level: validLevel, identifier: identifier || null, deleted: true };
  }

  /**
   * Obtiene configuraciones Glovo actuales desde credentials en memoria.
   * Busca keys con patrón GLOVO_CLIENT_ID_{LEVEL}[_{IDENTIFIER}]
   */
  getGlovoConfigs() {
    const configs = [];
    const processed = new Set();

    for (const key of this.credentials.keys()) {
      if (!key.startsWith('GLOVO_CLIENT_ID_')) continue;

      // Extraer level e identifier del key: GLOVO_CLIENT_ID_GLOBAL o GLOVO_CLIENT_ID_PROJECT_xxx
      const rest = key.replace('GLOVO_CLIENT_ID_', '');
      let level, identifier;

      if (rest === 'GLOBAL') {
        level = 'GLOBAL';
        identifier = null;
      } else {
        const parts = rest.split('_');
        level = parts[0]; // PROJECT, CLIENT, CUSTOM
        identifier = parts.slice(1).join('_') || null;
      }

      const configKey = `${level}_${identifier || ''}`;
      if (processed.has(configKey)) continue;
      processed.add(configKey);

      const suffix = level === 'GLOBAL' ? '_GLOBAL' : `_${level}_${identifier}`;
      const clientId = this.credentials.get(`GLOVO_CLIENT_ID${suffix}`) || '';
      const clientSecret = this.credentials.get(`GLOVO_CLIENT_SECRET${suffix}`) || '';
      const chainId = this.credentials.get(`GLOVO_CHAIN_ID${suffix}`) || '';

      configs.push({
        level,
        identifier,
        clientIdPreview: this.maskApiKey(clientId),
        hasSecret: !!clientSecret,
        chainId: chainId,
        configured: !!clientId && !!clientSecret && !!chainId
      });
    }

    return configs;
  }

  // ==========================================
  // Telegram Notification Config (chatId + botName)
  // ==========================================

  /**
   * UI Handler: Guardar configuración de notificación Telegram
   * Request: mqttRequest('credential', 'telegram.notif.save', { level, identifier?, chat_id, bot_name })
   */
  async handleUITelegramNotifSave(data, request) {
    const { level, identifier, chat_id, bot_name } = data;

    if (!chat_id) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'chat_id es requerido (ID del chat o usuario de Telegram)' };
    }
    if (!bot_name) {
      throw { status: 400, code: 'VALIDATION_ERROR', message: 'bot_name es requerido (nombre del bot de Telegram)' };
    }

    const validLevel = level || 'GLOBAL';
    const suffix = validLevel === 'GLOBAL' ? '_GLOBAL' : `_${validLevel}_${identifier}`;

    const keyChatId = `TELEGRAM_CHAT_ID${suffix}`;
    const keyBotName = `TELEGRAM_BOT_NAME${suffix}`;

    const isNew = !this.credentials.has(keyChatId);

    // Guardar en memoria
    this.credentials.set(keyChatId, chat_id);
    this.credentials.set(keyBotName, bot_name);

    // Guardar en process.env para uso inmediato
    process.env[keyChatId] = chat_id;
    process.env[keyBotName] = bot_name;

    // Persistir en archivo .env
    await this.saveEnvFile();
    this.updateCredentialMetrics();

    this.logger.info('telegram.notif.config.saved', {
      level: validLevel,
      identifier: identifier || null,
      isNew
    });

    // Publicar estado actualizado
    await this.publishState();

    return {
      level: validLevel,
      identifier: identifier || null,
      created: isNew,
      updated: !isNew,
      keys: [keyChatId, keyBotName]
    };
  }

  /**
   * UI Handler: Eliminar configuración de notificación Telegram
   * Request: mqttRequest('credential', 'telegram.notif.delete', { level, identifier? })
   */
  async handleUITelegramNotifDelete(data, request) {
    const { level, identifier } = data;

    const validLevel = level || 'GLOBAL';
    const suffix = validLevel === 'GLOBAL' ? '_GLOBAL' : `_${validLevel}_${identifier}`;

    const keyChatId = `TELEGRAM_CHAT_ID${suffix}`;
    const keyBotName = `TELEGRAM_BOT_NAME${suffix}`;

    if (!this.credentials.has(keyChatId)) {
      throw { status: 404, code: 'NOT_FOUND', message: `Configuración Telegram notificación no encontrada para nivel ${validLevel}` };
    }

    // Eliminar de memoria
    this.credentials.delete(keyChatId);
    this.credentials.delete(keyBotName);

    // Eliminar de process.env
    delete process.env[keyChatId];
    delete process.env[keyBotName];

    // Persistir
    await this.saveEnvFile();
    this.updateCredentialMetrics();

    this.logger.info('telegram.notif.config.deleted', { level: validLevel, identifier: identifier || null });

    // Publicar estado actualizado
    await this.publishState();

    return { level: validLevel, identifier: identifier || null, deleted: true };
  }

  /**
   * Obtiene configuraciones de notificación Telegram desde credentials en memoria.
   * Busca keys con patrón TELEGRAM_CHAT_ID_{LEVEL}[_{IDENTIFIER}]
   */
  getTelegramNotifConfigs() {
    const configs = [];
    const processed = new Set();

    for (const key of this.credentials.keys()) {
      if (!key.startsWith('TELEGRAM_CHAT_ID_')) continue;

      // Extraer level e identifier del key: TELEGRAM_CHAT_ID_GLOBAL o TELEGRAM_CHAT_ID_PROJECT_xxx
      const rest = key.replace('TELEGRAM_CHAT_ID_', '');
      let level, identifier;

      if (rest === 'GLOBAL') {
        level = 'GLOBAL';
        identifier = null;
      } else {
        const parts = rest.split('_');
        level = parts[0]; // PROJECT, CLIENT, CUSTOM
        identifier = parts.slice(1).join('_') || null;
      }

      const configKey = `${level}_${identifier || ''}`;
      if (processed.has(configKey)) continue;
      processed.add(configKey);

      const suffix = level === 'GLOBAL' ? '_GLOBAL' : `_${level}_${identifier}`;
      const chatId = this.credentials.get(`TELEGRAM_CHAT_ID${suffix}`) || '';
      const botName = this.credentials.get(`TELEGRAM_BOT_NAME${suffix}`) || '';

      configs.push({
        level,
        identifier,
        chatId,
        botName,
        configured: !!chatId && !!botName
      });
    }

    return configs;
  }

  /**
   * HTTP Handler: Callback de OAuth2
   * Google redirige aquí después de la autorización
   * GET /modules/credential-manager/oauth/callback?code=xxx&state=xxx
   */
  async handleOAuthCallback(req, context) {
    const { code, state: stateParam, error } = req.query || {};

    this.logger.info('oauth.callback.received', {
      hasCode: !!code,
      hasState: !!stateParam,
      hasError: !!error,
      correlation_id: context.correlationId
    });

    // Manejar error de Google
    if (error) {
      this.logger.error('oauth.callback.google_error', {
        error,
        correlation_id: context.correlationId
      });

      return {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        data: this.renderOAuthResultPage(false, `Error de autorización: ${error}`)
      };
    }

    if (!code || !stateParam) {
      return {
        status: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        data: this.renderOAuthResultPage(false, 'Parámetros incompletos: code y state requeridos')
      };
    }

    // Parsear state
    let state;
    try {
      state = googleOAuth.parseState(stateParam);
    } catch {
      return {
        status: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        data: this.renderOAuthResultPage(false, 'State inválido')
      };
    }

    // Buscar pending OAuth
    const pending = this.oauthPending.get(state.id);
    if (!pending) {
      return {
        status: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        data: this.renderOAuthResultPage(false, 'Sesión OAuth expirada o inválida. Por favor, inicia el proceso nuevamente.')
      };
    }

    try {
      // Intercambiar código por tokens
      const tokens = await googleOAuth.exchangeCode({
        code,
        clientId: pending.clientId,
        clientSecret: pending.clientSecret,
        redirectUri: pending.redirectUri
      });

      if (!tokens.refresh_token) {
        throw new Error('No se recibió refresh_token. El usuario puede necesitar revocar acceso y reautorizar.');
      }

      // Guardar refresh_token como credencial
      const key = this.buildKey(pending.provider, pending.level, pending.identifier);
      const isNew = !this.credentials.has(key);

      this.credentials.set(key, tokens.refresh_token);
      process.env[key] = tokens.refresh_token;
      await this.saveEnvFile();

      // Limpiar pending
      this.oauthPending.delete(state.id);

      // Metrics
      if (isNew) {
        this.metrics.increment('credential.saved.total');
      } else {
        this.metrics.increment('credential.updated.total');
      }
      this.updateCredentialMetrics();

      // Publicar evento
      await this.eventBus.publish(EVENTS.CREDENTIAL.SAVED, {
        key,
        provider: pending.provider,
        level: pending.level,
        identifier: pending.identifier,
        created: isNew,
        updated: !isNew,
        oauth: true
      }, { correlationId: context.correlationId });

      // Actualizar estado UI
      await this.publishState(context.correlationId);

      this.logger.info('oauth.callback.success', {
        key,
        provider: pending.provider,
        level: pending.level,
        created: isNew,
        correlation_id: context.correlationId
      });

      return {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        data: this.renderOAuthResultPage(true, `Credencial ${isNew ? 'creada' : 'actualizada'} correctamente`, {
          provider: pending.provider,
          level: pending.level,
          identifier: pending.identifier
        })
      };

    } catch (error) {
      this.logger.error('oauth.callback.error', {
        error: error.message,
        correlation_id: context.correlationId
      });

      this.metrics.increment('credential.errors.total');

      return {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        data: this.renderOAuthResultPage(false, `Error al procesar autorización: ${error.message}`)
      };
    }
  }

  /**
   * Renderiza página HTML de resultado OAuth
   */
  renderOAuthResultPage(success, message, details = null) {
    const color = success ? '#16a34a' : '#dc2626';
    const icon = success ? '✓' : '✗';
    const title = success ? 'Autorización Exitosa' : 'Error de Autorización';

    let detailsHtml = '';
    if (details) {
      detailsHtml = `
        <div style="margin-top: 20px; padding: 15px; background: #f3f4f6; border-radius: 8px; text-align: left;">
          <p><strong>Provider:</strong> ${details.provider}</p>
          <p><strong>Nivel:</strong> ${details.level}</p>
          ${details.identifier ? `<p><strong>Identificador:</strong> ${details.identifier}</p>` : ''}
        </div>
      `;
    }

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>${title} - Event-Core</title>
          <style>
            body {
              font-family: system-ui, -apple-system, sans-serif;
              padding: 40px;
              text-align: center;
              background: #f9fafb;
              margin: 0;
            }
            .container {
              max-width: 500px;
              margin: 0 auto;
              background: white;
              padding: 40px;
              border-radius: 12px;
              box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            }
            h1 { color: ${color}; margin-bottom: 10px; }
            .icon { font-size: 64px; margin-bottom: 20px; }
            p { color: #374151; line-height: 1.6; }
            .close-hint {
              margin-top: 30px;
              color: #6b7280;
              font-size: 14px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="icon">${icon}</div>
            <h1>${title}</h1>
            <p>${message}</p>
            ${detailsHtml}
            <p class="close-hint">Puedes cerrar esta ventana y volver a la aplicación.</p>
          </div>
          <script>
            // Notificar a la ventana padre si existe
            if (window.opener) {
              window.opener.postMessage({
                type: 'oauth-callback',
                success: ${success},
                message: '${message.replace(/'/g, "\\'")}'
              }, '*');
            }
          </script>
        </body>
      </html>
    `;
  }

  /**
   * Limpia OAuth pendientes expirados (> 10 minutos)
   */
  cleanupPendingOAuth() {
    const maxAge = 10 * 60 * 1000; // 10 minutos
    const now = Date.now();
    let cleaned = 0;

    for (const [stateId, pending] of this.oauthPending.entries()) {
      if (now - pending.createdAt > maxAge) {
        this.oauthPending.delete(stateId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.info('oauth.pending.cleanup', { cleaned });
    }
  }

  // ==========================================
  // UI Test Endpoint (HTTP) - Validar API key antes de guardar
  // ==========================================

  async handleTestCredential(req, context) {
    const { provider, api_key } = req.body || {};

    this.logger.info('ui.test.request', {
      provider,
      correlation_id: context.correlationId
    });

    if (!provider || !api_key) {
      return {
        status: 400,
        data: {
          success: false,
          valid: false,
          error: 'Provider y api_key son requeridos'
        }
      };
    }

    try {
      let valid = false;
      let message = '';

      switch (provider.toUpperCase()) {
        case 'DEEPSEEK':
          valid = await this.testDeepSeek(api_key);
          message = valid ? 'API key válida' : 'API key inválida o sin créditos';
          break;

        case 'OPENAI':
          valid = await this.testOpenAI(api_key);
          message = valid ? 'API key válida' : 'API key inválida';
          break;

        case 'ANTHROPIC':
          valid = await this.testAnthropic(api_key);
          message = valid ? 'API key válida' : 'API key inválida';
          break;

        case 'GROQ':
          valid = await this.testGroq(api_key);
          message = valid ? 'API key válida' : 'API key inválida';
          break;

        case 'GEMINI':
          valid = await this.testGemini(api_key);
          message = valid ? 'API key válida' : 'API key inválida';
          break;

        case 'OLLAMA':
          // Ollama es local, no necesita validación de API key
          valid = api_key && api_key.length > 0;
          message = 'Ollama es local - no requiere validación';
          break;

        default:
          valid = api_key && api_key.length > 10;
          message = 'Provider no reconocido - validación básica';
      }

      return {
        status: 200,
        data: {
          success: true,
          valid,
          provider,
          message
        }
      };
    } catch (error) {
      this.logger.error('ui.test.error', {
        provider,
        error: error.message,
        correlation_id: context.correlationId
      });

      return {
        status: 200,
        data: {
          success: true,
          valid: false,
          provider,
          message: `Error al validar: ${error.message}`
        }
      };
    }
  }

  // Test helpers para cada provider
  async testDeepSeek(apiKey) {
    try {
      const response = await fetch('https://api.deepseek.com/v1/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async testOpenAI(apiKey) {
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async testAnthropic(apiKey) {
    try {
      // Anthropic no tiene endpoint de listado, usamos un mensaje mínimo
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }]
        })
      });
      // 200 = válida, 401 = inválida, otros pueden ser rate limit pero key válida
      return response.status !== 401;
    } catch {
      return false;
    }
  }

  async testGroq(apiKey) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async testGemini(apiKey) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
        method: 'GET'
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Test Gmail OAuth2 credentials
   * Requires GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in environment
   * The api_key parameter is the refresh_token
   */
  async testGmail(refreshToken) {
    try {
      const clientId = process.env.GMAIL_CLIENT_ID;
      const clientSecret = process.env.GMAIL_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        this.logger.warn('gmail.test.missing_credentials', {
          hasClientId: !!clientId,
          hasClientSecret: !!clientSecret
        });
        // Si no hay client_id/secret, solo validamos formato del refresh token
        return refreshToken && refreshToken.startsWith('1//');
      }

      // Intentar obtener un access token con el refresh token
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        }).toString()
      });

      const data = await response.json();

      if (data.access_token) {
        this.logger.info('gmail.test.success', { hasAccessToken: true });
        return true;
      }

      this.logger.warn('gmail.test.failed', {
        error: data.error,
        error_description: data.error_description
      });
      return false;
    } catch (error) {
      this.logger.error('gmail.test.error', { error: error.message });
      return false;
    }
  }

  async testCloudflare(apiToken) {
    try {
      // Verify token by checking user details + workers permissions
      const response = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();

      if (data.success && data.result && data.result.status === 'active') {
        this.logger.info('cloudflare.test.success', { status: data.result.status });
        return true;
      }

      this.logger.warn('cloudflare.test.failed', {
        success: data.success,
        errors: data.errors
      });
      return false;
    } catch (error) {
      this.logger.error('cloudflare.test.error', { error: error.message });
      return false;
    }
  }

  // ==========================================
  // AI Tool Handlers
  // ==========================================

  /**
   * Tool handler: Lista credenciales para AI
   * IMPORTANTE: Solo retorna metadata (provider, level, identifier)
   * NUNCA retorna valores de API keys
   *
   * @param {Object} args - Tool arguments
   * @param {string} [args.level] - Filter by level (GLOBAL, PROJECT, CLIENT, CUSTOM)
   * @param {string} [args.provider] - Filter by provider (OPENAI, DEEPSEEK, ANTHROPIC, OLLAMA)
   * @returns {Object} List of credential metadata
   */
  async handleToolCredentialList(args) {
    const { level, provider } = args || {};

    this.logger.info('credential.tool.list.called', {
      level,
      provider
    });

    const credentials = [];

    for (const [key, _value] of this.credentials.entries()) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;

      // Apply filters if specified
      if (level && parsed.level !== level.toUpperCase()) continue;
      if (provider && parsed.provider !== provider.toUpperCase()) continue;

      // SECURITY: Never include api_key value - only metadata
      credentials.push({
        key,
        provider: parsed.provider,
        level: parsed.level,
        identifier: parsed.identifier || null
      });
    }

    // Sort by level priority (GLOBAL first, then PROJECT, CLIENT, CUSTOM)
    const levelOrder = { GLOBAL: 1, PROJECT: 2, CLIENT: 3, CUSTOM: 4 };
    credentials.sort((a, b) => (levelOrder[a.level] || 99) - (levelOrder[b.level] || 99));

    this.logger.info('credential.tool.list.result', {
      count: credentials.length,
      filters: { level, provider }
    });

    return {
      status: 200,
      data: {
        credentials,
        total: credentials.length,
        filters: { level: level || null, provider: provider || null },
        note: 'Only credential names and metadata are returned. API key values are never exposed.'
      }
    };
  }

  // ==========================================
  // Core Logic
  // ==========================================

  resolveCredential(provider, { customId, clientId, projectId } = {}) {
    const attempts = [];

    // Priority 1: CUSTOM
    if (customId) {
      const customKey = this.buildKey(provider, 'CUSTOM', customId);
      attempts.push(customKey);
      if (this.credentials.has(customKey)) {
        return {
          found: true,
          apiKey: this.credentials.get(customKey),
          key: customKey,
          resolvedFrom: 'CUSTOM',
          identifier: customId,
          attempts
        };
      }
    }

    // Priority 2: CLIENT
    if (clientId) {
      const clientKey = this.buildKey(provider, 'CLIENT', clientId);
      attempts.push(clientKey);
      if (this.credentials.has(clientKey)) {
        return {
          found: true,
          apiKey: this.credentials.get(clientKey),
          key: clientKey,
          resolvedFrom: 'CLIENT',
          identifier: clientId,
          attempts
        };
      }
    }

    // Priority 3: PROJECT
    if (projectId) {
      const projectKey = this.buildKey(provider, 'PROJECT', projectId);
      attempts.push(projectKey);
      if (this.credentials.has(projectKey)) {
        return {
          found: true,
          apiKey: this.credentials.get(projectKey),
          key: projectKey,
          resolvedFrom: 'PROJECT',
          identifier: projectId,
          attempts
        };
      }
    }

    // Priority 4: GLOBAL
    const globalKey = this.buildKey(provider, 'GLOBAL');
    attempts.push(globalKey);
    if (this.credentials.has(globalKey)) {
      return {
        found: true,
        apiKey: this.credentials.get(globalKey),
        key: globalKey,
        resolvedFrom: 'GLOBAL',
        identifier: null,
        attempts
      };
    }

    return { found: false, attempts };
  }

  buildKey(provider, level, identifier = null) {
    const providerUpper = provider.toUpperCase();
    if (level === 'GLOBAL') {
      return `${providerUpper}_API_KEY_GLOBAL`;
    }
    return `${providerUpper}_API_KEY_${level}_${identifier}`;
  }

  parseKey(key) {
    // Pattern: PROVIDER_API_KEY_LEVEL or PROVIDER_API_KEY_LEVEL_IDENTIFIER
    const match = key.match(/^([A-Z_]+)_API_KEY_(GLOBAL|PROJECT|CLIENT|CUSTOM|BOT)(?:_(.+))?$/);
    if (match) {
      return {
        provider: match[1],
        level: match[2],
        identifier: match[3] || null
      };
    }

    // Legacy pattern: PROVIDER_API_KEY (sin nivel, se trata como GLOBAL)
    const legacyMatch = key.match(/^([A-Z_]+)_API_KEY$/);
    if (legacyMatch) {
      return {
        provider: legacyMatch[1],
        level: 'GLOBAL',
        identifier: null
      };
    }

    return null;
  }

  extractLevel(key) {
    const parsed = this.parseKey(key);
    return parsed ? parsed.level : 'UNKNOWN';
  }

  validateLevel(level, identifier) {
    const levelConfig = this.config.levels?.[level];
    if (!levelConfig) {
      return { valid: false, error: `Unknown level: ${level}` };
    }

    if (levelConfig.requiresIdentifier && !identifier) {
      return { valid: false, error: `Level ${level} requires an identifier` };
    }

    if (!levelConfig.requiresIdentifier && identifier) {
      return { valid: false, error: `Level ${level} does not accept an identifier` };
    }

    return { valid: true };
  }

  maskApiKey(apiKey) {
    const maskLength = this.config.maskLength || 4;
    if (apiKey.length <= maskLength) {
      return '*'.repeat(apiKey.length);
    }
    const visible = apiKey.slice(-maskLength);
    const masked = '*'.repeat(apiKey.length - maskLength);
    return masked + visible;
  }

  // ==========================================
  // Event Publishers
  // ==========================================

  async publishResolveResponse(requestId, success, provider, apiKey, resolvedFrom, error, correlationId) {
    await this.eventBus.publish(EVENTS.CREDENTIAL.RESOLVE_RESPONSE, {
      request_id: requestId,
      success,
      provider,
      api_key: apiKey,
      resolved_from: resolvedFrom,
      error
    }, { correlationId });
  }
}

module.exports = CredentialManagerModule;
