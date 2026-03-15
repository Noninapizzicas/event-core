/**
 * Scheduler Module
 *
 * Advanced job scheduling with multiple trigger types:
 * - cron: Cron expressions
 * - interval: Fixed intervals
 * - datetime: Specific date/time
 * - event: MQTT event-based triggers
 * - condition: Condition-based triggers
 * - composite: Combination of triggers (AND/OR logic)
 *
 * @module scheduler
 * @version 1.0.0
 */

const crypto = require('crypto');

const JobManager = require('./services/job-manager');
const TriggerManager = require('./services/trigger-manager');

class SchedulerModule {
  constructor() {
    this.name = 'scheduler';
    this.version = '1.0.0';

    // Dependencies (injected)
    this.logger = null;
    this.metrics = null;
    this.eventBus = null;
    this.uiHandler = null;
    this.config = null;

    // Services
    this.jobManager = null;
    this.triggerManager = null;

    // Unsubscribe functions for cleanup
    this.unsubscribes = [];

    // Execution history (in-memory, limited)
    this.executions = [];
    this.maxExecutionHistory = 100;

    // Active project tracking
    this.activeProjectId = null;

    // Stats
    this.stats = {
      jobsCreated: 0,
      jobsDeleted: 0,
      jobsTriggered: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      startedAt: null
    };
  }

  // ==================== LIFECYCLE ====================

  async onLoad(core) {
    this.logger = core.logger;
    this.metrics = core.metrics;
    this.eventBus = core.eventBus;
    this.uiHandler = core.uiHandler;

    // Load config from loader-injected moduleConfig
    this.config = this.loadConfig(core.moduleConfig);

    this.logger.info('scheduler.loading', {
      module: this.name,
      version: this.version
    });

    // Initialize services
    this.jobManager = new JobManager({
      logger: this.logger,
      config: this.config,
      onJobChange: () => this.onJobsChanged()
    });

    this.triggerManager = new TriggerManager({
      logger: this.logger,
      eventBus: this.eventBus,
      config: this.config,
      onTrigger: (job, triggerInfo) => this.executeJob(job, triggerInfo)
    });

    // Load persisted jobs
    await this.jobManager.load();

    // Static event subscriptions and UI handlers are auto-wired by the loader from module.json

    // Subscribe to dynamic events for event-based triggers (these depend on job config, can't be in manifest)
    await this.subscribeToEventTriggers();

    // Start all enabled jobs
    await this.startAllJobs();

    this.stats.startedAt = new Date().toISOString();

    this.logger.info('scheduler.loaded', {
      totalJobs: this.jobManager.count(),
      activeJobs: this.jobManager.countEnabled()
    });
  }

  async onUnload() {
    this.logger.info('scheduler.unloading');

    // Stop all triggers
    this.triggerManager.stopAll();

    // Save jobs before unloading
    await this.jobManager.save();

    // Dynamic event trigger subscriptions cleanup
    for (const unsub of this.unsubscribes) {
      if (typeof unsub === 'function') {
        await unsub();
      }
    }
    this.unsubscribes = [];

    // Static event subscriptions and UI handlers are auto-cleaned by the loader
    this.logger.info('scheduler.unloaded');
  }

  loadConfig(moduleConfig) {
    const defaults = {
      jobsPath: './data/scheduler/jobs.json',
      autoSave: true,
      saveInterval: 30000,
      defaultTimezone: 'Europe/Madrid',
      maxConcurrentJobs: 100,
      defaultTimeout: 300000,
      defaultRetries: 3,
      defaultRetryDelay: 5000
    };

    return { ...defaults, ...(moduleConfig || {}) };
  }

  // ==================== INITIALIZATION ====================

  // UI handlers are wired by the loader from module.json (uiActions)

  async subscribeToEventTriggers() {
    // Get all unique event topics from jobs with event triggers
    const jobs = this.jobManager.getAll();
    const topics = new Set();

    for (const job of jobs) {
      if (job.trigger?.type === 'event' && job.trigger.topic) {
        topics.add(job.trigger.topic);
      }
      // Also check composite triggers
      if (job.trigger?.type === 'composite' && job.trigger.triggers) {
        for (const t of job.trigger.triggers) {
          if (t.type === 'event' && t.topic) {
            topics.add(t.topic);
          }
        }
      }
    }

    // Subscribe to each unique topic
    for (const topic of topics) {
      const unsub = await this.eventBus.subscribe(topic, (event) => {
        this.onEventReceived(topic, event);
      });
      this.unsubscribes.push(unsub);
    }

    this.logger.debug('scheduler.event-triggers.subscribed', {
      topics: Array.from(topics)
    });
  }

  // ==================== PROJECT LIFECYCLE ====================

  /**
   * Handle project.activated event
   * Stores the active project ID so job executions can include project context.
   */
  async onProjectActivated(event) {
    const data = event.data || event;
    const { project_id, name } = data;

    if (!project_id) return;

    this.activeProjectId = project_id;

    const projectJobs = this.jobManager.getByProject(project_id);

    this.logger.info('scheduler.project.activated', {
      project_id,
      project_name: name,
      projectJobs: projectJobs.length
    });
  }

  async startAllJobs() {
    const jobs = this.jobManager.getAll();

    for (const job of jobs) {
      if (job.enabled !== false) {
        this.triggerManager.start(job);
      }
    }
  }

  // ==================== JOB LIFECYCLE ====================

  onJobsChanged() {
    // Auto-save if configured
    if (this.config.autoSave) {
      this.jobManager.save().catch(err => {
        this.logger.error('scheduler.autosave.failed', { error: err.message });
      });
    }
  }

  async onEventReceived(topic, event) {
    // Find jobs that listen to this event
    const jobs = this.jobManager.getAll().filter(job => {
      if (job.enabled === false) return false;

      if (job.trigger?.type === 'event' && job.trigger.topic === topic) {
        return this.evaluateEventCondition(job.trigger, event);
      }

      if (job.trigger?.type === 'composite') {
        // Check if any nested event trigger matches
        return job.trigger.triggers?.some(t =>
          t.type === 'event' && t.topic === topic && this.evaluateEventCondition(t, event)
        );
      }

      return false;
    });

    for (const job of jobs) {
      this.triggerManager.handleEventTrigger(job, topic, event);
    }
  }

  evaluateEventCondition(trigger, event) {
    if (!trigger.condition) return true;

    try {
      // Simple expression evaluation (careful with security)
      const payload = event;
      const fn = new Function('payload', `return ${trigger.condition}`);
      return fn(payload);
    } catch (err) {
      this.logger.warn('scheduler.event-condition.error', {
        condition: trigger.condition,
        error: err.message
      });
      return false;
    }
  }

  async executeJob(job, triggerInfo = {}) {
    const executionId = crypto.randomUUID();
    const startTime = Date.now();

    this.logger.info('scheduler.job.executing', {
      jobId: job.id,
      jobName: job.name,
      executionId,
      trigger: triggerInfo.type || 'manual'
    });

    // Update stats
    this.stats.jobsTriggered++;

    // Publish triggered event
    await this.eventBus.publish('scheduler.job.triggered', {
      jobId: job.id,
      jobName: job.name,
      project_id: job.project_id || null,
      executionId,
      trigger: triggerInfo,
      timestamp: new Date().toISOString()
    });

    // Add to execution history
    const execution = {
      id: executionId,
      jobId: job.id,
      jobName: job.name,
      project_id: job.project_id || null,
      trigger: triggerInfo,
      startedAt: new Date().toISOString(),
      status: 'running',
      result: null,
      error: null,
      duration: null
    };
    this.executions.unshift(execution);
    if (this.executions.length > this.maxExecutionHistory) {
      this.executions.pop();
    }

    try {
      // Execute action based on type
      const result = await this.executeAction(job.action, {
        job,
        trigger: triggerInfo,
        executionId
      });

      // Update execution
      execution.status = 'completed';
      execution.result = result;
      execution.duration = Date.now() - startTime;

      // Update stats
      this.stats.jobsCompleted++;

      // Update job last run
      this.jobManager.updateLastRun(job.id, {
        executionId,
        success: true,
        timestamp: new Date().toISOString()
      });

      // Publish completed event
      await this.eventBus.publish('scheduler.job.completed', {
        jobId: job.id,
        jobName: job.name,
        executionId,
        duration: execution.duration,
        result,
        timestamp: new Date().toISOString()
      });

      this.logger.info('scheduler.job.completed', {
        jobId: job.id,
        executionId,
        duration: execution.duration
      });

      return result;

    } catch (error) {
      // Update execution
      execution.status = 'failed';
      execution.error = error.message;
      execution.duration = Date.now() - startTime;

      // Update stats
      this.stats.jobsFailed++;

      // Update job last run
      this.jobManager.updateLastRun(job.id, {
        executionId,
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      });

      // Publish failed event
      await this.eventBus.publish('scheduler.job.failed', {
        jobId: job.id,
        jobName: job.name,
        executionId,
        error: error.message,
        duration: execution.duration,
        timestamp: new Date().toISOString()
      });

      this.logger.error('scheduler.job.failed', {
        jobId: job.id,
        executionId,
        error: error.message
      });

      // Retry logic
      if (job.options?.maxRetries > 0 && (triggerInfo.retryCount || 0) < job.options.maxRetries) {
        const retryDelay = job.options.retryDelay || this.config.defaultRetryDelay;
        this.logger.info('scheduler.job.retrying', {
          jobId: job.id,
          retryCount: (triggerInfo.retryCount || 0) + 1,
          maxRetries: job.options.maxRetries,
          delayMs: retryDelay
        });

        setTimeout(() => {
          this.executeJob(job, {
            ...triggerInfo,
            type: 'retry',
            retryCount: (triggerInfo.retryCount || 0) + 1
          });
        }, retryDelay);
      }

      throw error;
    }
  }

  async executeAction(action, context) {
    const { job, trigger, executionId } = context;

    switch (action.type) {
      case 'mqtt':
        return this.executeActionMQTT(action, context);

      case 'http':
        return this.executeActionHTTP(action, context);

      case 'module':
        return this.executeActionModule(action, context);

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  async executeActionMQTT(action, context) {
    const { job, trigger } = context;

    // Resolve template variables in topic and payload
    const topic = this.resolveTemplate(action.topic, { job, trigger, now: new Date().toISOString() });
    let payload = action.payload || {};

    if (typeof payload === 'string') {
      payload = this.resolveTemplate(payload, { job, trigger, now: new Date().toISOString() });
    } else if (typeof payload === 'object') {
      payload = JSON.parse(
        this.resolveTemplate(JSON.stringify(payload), { job, trigger, now: new Date().toISOString() })
      );
    }

    // SIEMPRE añadir metadatos de tiempo al payload
    // Los handlers pueden filtrar por hora, día, etc.
    const now = new Date();
    payload._time = {
      timestamp: now.getTime(),
      iso: now.toISOString(),
      hour: now.getHours(),
      minute: now.getMinutes(),
      second: now.getSeconds(),
      dayOfWeek: now.getDay(),        // 0=Domingo, 6=Sábado
      dayOfMonth: now.getDate(),
      month: now.getMonth() + 1,      // 1-12
      year: now.getFullYear(),
      timezone: this.config.defaultTimezone || 'Europe/Madrid'
    };

    // Añadir info del job
    payload._job = {
      id: job.id,
      name: job.name
    };

    await this.eventBus.publish(topic, payload, { qos: action.qos || 1 });

    return { published: true, topic, payload };
  }

  async executeActionHTTP(action, context) {
    const { job, trigger } = context;

    const url = this.resolveTemplate(action.url, { job, trigger, now: new Date().toISOString() });
    const method = action.method || 'GET';
    const headers = action.headers || {};
    let body = action.body;

    if (body && typeof body === 'object') {
      body = JSON.parse(
        this.resolveTemplate(JSON.stringify(body), { job, trigger, now: new Date().toISOString() })
      );
    }

    const timeout = action.timeout || this.config.defaultTimeout;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const responseText = await response.text();
      let responseData;
      try {
        responseData = JSON.parse(responseText);
      } catch {
        responseData = responseText;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${responseText}`);
      }

      return {
        status: response.status,
        data: responseData
      };

    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`HTTP request timeout after ${timeout}ms`);
      }
      throw error;
    }
  }

  async executeActionModule(action, context) {
    // Call a module method via event
    const requestEvent = `${action.module}.${action.method}.request`;
    const responseEvent = `${action.module}.${action.method}.response`;
    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Module action timeout: ${action.module}.${action.method}`));
      }, action.timeout || this.config.defaultTimeout);

      const handler = async (event) => {
        if (event.request_id === requestId) {
          clearTimeout(timeout);
          if (event.success === false) {
            reject(new Error(event.error || 'Module action failed'));
          } else {
            resolve(event.data || event);
          }
        }
      };

      this.eventBus.subscribe(responseEvent, handler).then(unsub => {
        // Cleanup after response or timeout
        setTimeout(() => unsub(), (action.timeout || this.config.defaultTimeout) + 1000);
      });

      this.eventBus.publish(requestEvent, {
        request_id: requestId,
        ...action.params
      });
    });
  }

  resolveTemplate(template, context) {
    if (typeof template !== 'string') return template;

    return template.replace(/\{\{([^}]+)\}\}/g, (match, expr) => {
      const trimmed = expr.trim();

      // Handle special variables
      if (trimmed === 'now') return context.now || new Date().toISOString();
      if (trimmed === 'uuid') return crypto.randomUUID();
      if (trimmed === 'timestamp') return Date.now().toString();
      if (trimmed === 'date') return new Date().toISOString().split('T')[0];
      if (trimmed === 'time') return new Date().toISOString().split('T')[1].split('.')[0];

      // Handle nested paths like job.id, trigger.type, event.payload.field
      try {
        const parts = trimmed.split('.');
        let value = context;
        for (const part of parts) {
          value = value?.[part];
        }
        return value !== undefined ? (typeof value === 'object' ? JSON.stringify(value) : value) : match;
      } catch {
        return match;
      }
    });
  }

  // ==================== UI HANDLERS ====================

  async handleUIListJobs(data, context) {
    try {
      const { project_id } = data || {};
      let jobs;

      if (project_id) {
        // Filter by project: return project-specific + global jobs
        const projectJobs = this.jobManager.getByProject(project_id);
        const globalJobs = this.jobManager.getGlobal();
        jobs = [...projectJobs, ...globalJobs];
      } else {
        jobs = this.jobManager.getAll();
      }

      const jobsWithStatus = jobs.map(job => ({
        ...job,
        status: this.triggerManager.getStatus(job.id)
      }));

      return { status: 200, data: { jobs: jobsWithStatus } };
    } catch (error) {
      this.logger.error('scheduler.ui.list.error', { error: error.message });
      return { status: 500, error: error.message };
    }
  }

  async handleUIGetJob(data, context) {
    try {
      const { jobId } = data;
      if (!jobId) {
        return { status: 400, error: 'jobId is required' };
      }

      const job = this.jobManager.get(jobId);
      if (!job) {
        return { status: 404, error: 'Job not found' };
      }

      return {
        status: 200,
        data: {
          ...job,
          status: this.triggerManager.getStatus(jobId)
        }
      };
    } catch (error) {
      this.logger.error('scheduler.ui.get.error', { error: error.message });
      return { status: 500, error: error.message };
    }
  }

  async handleUICreateJob(data, context) {
    try {
      const { name, description, trigger, action, options, metadata, project_id } = data;

      if (!name) {
        return { status: 400, error: 'name is required' };
      }
      if (!trigger || !trigger.type) {
        return { status: 400, error: 'trigger with type is required' };
      }
      if (!action || !action.type) {
        return { status: 400, error: 'action with type is required' };
      }

      const job = this.jobManager.create({
        name,
        description,
        project_id: project_id || null,
        trigger,
        action,
        options: {
          enabled: true,
          maxRetries: this.config.defaultRetries,
          retryDelay: this.config.defaultRetryDelay,
          timeout: this.config.defaultTimeout,
          overlap: false,
          ...options
        },
        metadata: {
          createdAt: new Date().toISOString(),
          ...metadata
        }
      });

      // Start trigger if enabled
      if (job.enabled !== false) {
        this.triggerManager.start(job);

        // Subscribe to new event topics if needed
        if (job.trigger.type === 'event' && job.trigger.topic) {
          const unsub = await this.eventBus.subscribe(job.trigger.topic, (event) => {
            this.onEventReceived(job.trigger.topic, event);
          });
          this.unsubscribes.push(unsub);
        }
      }

      this.stats.jobsCreated++;

      await this.eventBus.publish('scheduler.job.created', {
        job,
        timestamp: new Date().toISOString()
      });

      this.logger.info('scheduler.job.created', { jobId: job.id, jobName: job.name });

      return { status: 201, data: job };
    } catch (error) {
      this.logger.error('scheduler.ui.create.error', { error: error.message });
      return { status: 500, error: error.message };
    }
  }

  async handleUIUpdateJob(data, context) {
    try {
      const { jobId, ...updates } = data;

      if (!jobId) {
        return { status: 400, error: 'jobId is required' };
      }

      const existing = this.jobManager.get(jobId);
      if (!existing) {
        return { status: 404, error: 'Job not found' };
      }

      // Stop existing trigger
      this.triggerManager.stop(jobId);

      // Update job
      const job = this.jobManager.update(jobId, {
        ...updates,
        metadata: {
          ...existing.metadata,
          ...updates.metadata,
          updatedAt: new Date().toISOString()
        }
      });

      // Restart trigger if enabled
      if (job.enabled !== false) {
        this.triggerManager.start(job);
      }

      await this.eventBus.publish('scheduler.job.updated', {
        job,
        timestamp: new Date().toISOString()
      });

      this.logger.info('scheduler.job.updated', { jobId: job.id });

      return { status: 200, data: job };
    } catch (error) {
      this.logger.error('scheduler.ui.update.error', { error: error.message });
      return { status: 500, error: error.message };
    }
  }

  async handleUIDeleteJob(data, context) {
    try {
      const { jobId } = data;

      if (!jobId) {
        return { status: 400, error: 'jobId is required' };
      }

      const job = this.jobManager.get(jobId);
      if (!job) {
        return { status: 404, error: 'Job not found' };
      }

      // Stop trigger
      this.triggerManager.stop(jobId);

      // Delete job
      this.jobManager.delete(jobId);

      this.stats.jobsDeleted++;

      await this.eventBus.publish('scheduler.job.deleted', {
        jobId,
        jobName: job.name,
        timestamp: new Date().toISOString()
      });

      this.logger.info('scheduler.job.deleted', { jobId });

      return { status: 200, data: { deleted: true, jobId } };
    } catch (error) {
      this.logger.error('scheduler.ui.delete.error', { error: error.message });
      return { status: 500, error: error.message };
    }
  }

  async handleUIEnableJob(data, context) {
    try {
      const { jobId } = data;

      if (!jobId) {
        return { status: 400, error: 'jobId is required' };
      }

      const job = this.jobManager.get(jobId);
      if (!job) {
        return { status: 404, error: 'Job not found' };
      }

      this.jobManager.update(jobId, { enabled: true });
      this.triggerManager.start(job);

      await this.eventBus.publish('scheduler.job.enabled', {
        jobId,
        jobName: job.name,
        timestamp: new Date().toISOString()
      });

      this.logger.info('scheduler.job.enabled', { jobId });

      return { status: 200, data: { enabled: true, jobId } };
    } catch (error) {
      this.logger.error('scheduler.ui.enable.error', { error: error.message });
      return { status: 500, error: error.message };
    }
  }

  async handleUIDisableJob(data, context) {
    try {
      const { jobId } = data;

      if (!jobId) {
        return { status: 400, error: 'jobId is required' };
      }

      const job = this.jobManager.get(jobId);
      if (!job) {
        return { status: 404, error: 'Job not found' };
      }

      this.triggerManager.stop(jobId);
      this.jobManager.update(jobId, { enabled: false });

      await this.eventBus.publish('scheduler.job.disabled', {
        jobId,
        jobName: job.name,
        timestamp: new Date().toISOString()
      });

      this.logger.info('scheduler.job.disabled', { jobId });

      return { status: 200, data: { enabled: false, jobId } };
    } catch (error) {
      this.logger.error('scheduler.ui.disable.error', { error: error.message });
      return { status: 500, error: error.message };
    }
  }

  async handleUITriggerJob(data, context) {
    try {
      const { jobId } = data;

      if (!jobId) {
        return { status: 400, error: 'jobId is required' };
      }

      const job = this.jobManager.get(jobId);
      if (!job) {
        return { status: 404, error: 'Job not found' };
      }

      // Execute job
      const result = await this.executeJob(job, { type: 'manual', triggeredBy: 'ui' });

      return { status: 200, data: { triggered: true, jobId, result } };
    } catch (error) {
      this.logger.error('scheduler.ui.trigger.error', { error: error.message });
      return { status: 500, error: error.message };
    }
  }

  async handleUIGetTriggerTypes(data, context) {
    return {
      status: 200,
      data: {
        types: [
          {
            type: 'cron',
            name: 'Cron Expression',
            description: 'Schedule using cron expressions (e.g., "0 3 * * *" for daily at 3am)',
            schema: {
              expression: { type: 'string', required: true, description: 'Cron expression' },
              timezone: { type: 'string', description: 'Timezone (default: Europe/Madrid)' }
            },
            examples: [
              { expression: '*/5 * * * *', description: 'Every 5 minutes' },
              { expression: '0 3 * * *', description: 'Daily at 3:00 AM' },
              { expression: '0 3 * * 0', description: 'Every Sunday at 3:00 AM' },
              { expression: '0 9 * * 1-5', description: 'Weekdays at 9:00 AM' }
            ]
          },
          {
            type: 'interval',
            name: 'Fixed Interval',
            description: 'Execute at fixed intervals',
            schema: {
              value: { type: 'number', required: true, description: 'Interval value' },
              unit: { type: 'string', enum: ['ms', 's', 'm', 'h', 'd'], description: 'Time unit' }
            },
            examples: [
              { value: 30, unit: 's', description: 'Every 30 seconds' },
              { value: 5, unit: 'm', description: 'Every 5 minutes' },
              { value: 1, unit: 'h', description: 'Every hour' }
            ]
          },
          {
            type: 'datetime',
            name: 'Specific Date/Time',
            description: 'Execute at a specific date and time',
            schema: {
              date: { type: 'string', description: 'Date (YYYY-MM-DD)' },
              time: { type: 'string', description: 'Time (HH:mm:ss)' },
              repeat: { type: 'string', enum: ['once', 'daily', 'weekly', 'monthly', 'yearly'], description: 'Repeat pattern' },
              timezone: { type: 'string', description: 'Timezone' }
            },
            examples: [
              { date: '2025-12-25', time: '00:00:00', repeat: 'yearly', description: 'Every Christmas' }
            ]
          },
          {
            type: 'event',
            name: 'Event-Based',
            description: 'Trigger when an MQTT event is received',
            schema: {
              topic: { type: 'string', required: true, description: 'MQTT topic to listen' },
              condition: { type: 'string', description: 'JavaScript condition (e.g., "payload.size > 1000")' },
              debounce: { type: 'number', description: 'Debounce time in ms' }
            },
            examples: [
              { topic: 'file.uploaded', condition: 'payload.type === "pdf"', description: 'When PDF uploaded' }
            ]
          },
          {
            type: 'condition',
            name: 'Condition-Based',
            description: 'Trigger when a condition becomes true',
            schema: {
              check: { type: 'string', required: true, description: 'JavaScript expression to evaluate' },
              interval: { type: 'number', description: 'Check interval in ms (default: 10000)' },
              persist: { type: 'boolean', description: 'Stay triggered until reset' }
            },
            examples: [
              { check: 'metrics.cpu > 80', interval: 10000, description: 'High CPU usage' }
            ]
          },
          {
            type: 'composite',
            name: 'Composite',
            description: 'Combine multiple triggers with logic operators',
            schema: {
              logic: { type: 'string', enum: ['AND', 'OR', 'NAND', 'NOR', 'XOR'], description: 'Logic operator' },
              triggers: { type: 'array', description: 'Array of trigger definitions' }
            },
            examples: [
              {
                logic: 'AND',
                triggers: [
                  { type: 'cron', expression: '0 9 * * 1-5' },
                  { type: 'condition', check: 'system.load < 50' }
                ],
                description: 'Weekdays 9am when load is low'
              }
            ]
          }
        ]
      }
    };
  }

  async handleUIGetStats(data, context) {
    return {
      status: 200,
      data: {
        stats: {
          ...this.stats,
          totalJobs: this.jobManager.count(),
          activeJobs: this.jobManager.countEnabled(),
          disabledJobs: this.jobManager.count() - this.jobManager.countEnabled(),
          uptime: this.stats.startedAt
            ? Date.now() - new Date(this.stats.startedAt).getTime()
            : 0
        }
      }
    };
  }

  async handleUIListExecutions(data, context) {
    const { limit = 50, jobId } = data || {};

    let filtered = this.executions;
    if (jobId) {
      filtered = filtered.filter(e => e.jobId === jobId);
    }

    return {
      status: 200,
      data: {
        executions: filtered.slice(0, limit)
      }
    };
  }

  // ==================== HTTP API HANDLERS ====================

  async handleHealthCheck(req, res) {
    return {
      status: 'ok',
      module: this.name,
      version: this.version,
      jobs: {
        total: this.jobManager.count(),
        active: this.jobManager.countEnabled()
      },
      uptime: this.stats.startedAt
        ? Date.now() - new Date(this.stats.startedAt).getTime()
        : 0
    };
  }

  async handleListJobs(req, res) {
    const jobs = this.jobManager.getAll();
    return jobs.map(job => ({
      ...job,
      status: this.triggerManager.getStatus(job.id)
    }));
  }

  async handleGetJob(req, res) {
    const { jobId } = req.params;
    const job = this.jobManager.get(jobId);

    if (!job) {
      res.status(404);
      return { error: 'Job not found' };
    }

    return {
      ...job,
      status: this.triggerManager.getStatus(jobId)
    };
  }

  async handleCreateJob(req, res) {
    const result = await this.handleUICreateJob(req.body, {});
    res.status(result.status);
    return result.data || { error: result.error };
  }

  async handleUpdateJob(req, res) {
    const result = await this.handleUIUpdateJob({ jobId: req.params.jobId, ...req.body }, {});
    res.status(result.status);
    return result.data || { error: result.error };
  }

  async handleDeleteJob(req, res) {
    const result = await this.handleUIDeleteJob({ jobId: req.params.jobId }, {});
    res.status(result.status);
    return result.data || { error: result.error };
  }

  async handleEnableJob(req, res) {
    const result = await this.handleUIEnableJob({ jobId: req.params.jobId }, {});
    res.status(result.status);
    return result.data || { error: result.error };
  }

  async handleDisableJob(req, res) {
    const result = await this.handleUIDisableJob({ jobId: req.params.jobId }, {});
    res.status(result.status);
    return result.data || { error: result.error };
  }

  async handleTriggerJob(req, res) {
    const result = await this.handleUITriggerJob({ jobId: req.params.jobId }, {});
    res.status(result.status);
    return result.data || { error: result.error };
  }

  async handleGetTriggerTypes(req, res) {
    const result = await this.handleUIGetTriggerTypes({}, {});
    return result.data;
  }

  async handleListExecutions(req, res) {
    const result = await this.handleUIListExecutions({
      limit: parseInt(req.query.limit) || 50,
      jobId: req.query.jobId
    }, {});
    return result.data;
  }

  async handleGetStats(req, res) {
    const result = await this.handleUIGetStats({}, {});
    return result.data;
  }

  // ==================== AI TOOLS ====================

  async toolListJobs(params) {
    const jobs = this.jobManager.getAll();
    let filtered = jobs;

    if (params.enabled !== undefined) {
      filtered = filtered.filter(j => j.enabled === params.enabled);
    }
    if (params.triggerType) {
      filtered = filtered.filter(j => j.trigger?.type === params.triggerType);
    }

    return {
      success: true,
      data: {
        total: filtered.length,
        jobs: filtered.map(job => ({
          id: job.id,
          name: job.name,
          description: job.description,
          enabled: job.enabled,
          triggerType: job.trigger?.type,
          lastRun: job.lastRun,
          status: this.triggerManager.getStatus(job.id)
        }))
      }
    };
  }

  async toolCreateJob(params) {
    const result = await this.handleUICreateJob(params, {});
    return {
      success: result.status < 400,
      data: result.data,
      error: result.error
    };
  }

  async toolTriggerJob(params) {
    const result = await this.handleUITriggerJob(params, {});
    return {
      success: result.status < 400,
      data: result.data,
      error: result.error
    };
  }
}

module.exports = SchedulerModule;
