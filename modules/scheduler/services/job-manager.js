/**
 * Job Manager Service
 *
 * Manages job definitions with persistence.
 *
 * @module scheduler/job-manager
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class JobManager {
  constructor({ logger, config, onJobChange }) {
    this.logger = logger;
    this.config = config;
    this.onJobChange = onJobChange || (() => {});

    // In-memory job storage
    this.jobs = new Map();

    // File path for persistence
    this.filePath = path.resolve(process.cwd(), config.jobsPath || './data/scheduler/jobs.json');
  }

  /**
   * Load jobs from file
   */
  async load() {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.filePath);
      await fs.promises.mkdir(dir, { recursive: true });

      // Check if file exists
      try {
        await fs.promises.access(this.filePath);
      } catch {
        // File doesn't exist, start with empty jobs
        this.logger.info('scheduler.job-manager.no-file', { path: this.filePath });
        return;
      }

      // Read and parse file
      const content = await fs.promises.readFile(this.filePath, 'utf-8');
      const data = JSON.parse(content);

      if (Array.isArray(data.jobs)) {
        for (const job of data.jobs) {
          this.jobs.set(job.id, job);
        }
      }

      this.logger.info('scheduler.job-manager.loaded', {
        path: this.filePath,
        jobCount: this.jobs.size
      });

    } catch (error) {
      this.logger.error('scheduler.job-manager.load-error', {
        path: this.filePath,
        error: error.message
      });
    }
  }

  /**
   * Save jobs to file
   */
  async save() {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.filePath);
      await fs.promises.mkdir(dir, { recursive: true });

      const data = {
        version: '1.0.0',
        savedAt: new Date().toISOString(),
        jobs: Array.from(this.jobs.values())
      };

      await fs.promises.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');

      this.logger.debug('scheduler.job-manager.saved', {
        path: this.filePath,
        jobCount: this.jobs.size
      });

    } catch (error) {
      this.logger.error('scheduler.job-manager.save-error', {
        path: this.filePath,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Create a new job
   */
  create(jobData) {
    const id = jobData.id || crypto.randomUUID();

    const job = {
      id,
      name: jobData.name,
      description: jobData.description || '',
      project_id: jobData.project_id || null,
      trigger: jobData.trigger,
      action: jobData.action,
      enabled: jobData.enabled !== false,
      options: {
        maxRetries: 3,
        retryDelay: 5000,
        timeout: 300000,
        overlap: false,
        ...jobData.options
      },
      metadata: {
        createdAt: new Date().toISOString(),
        ...jobData.metadata
      },
      lastRun: null,
      runCount: 0
    };

    this.jobs.set(id, job);
    this.onJobChange();

    return job;
  }

  /**
   * Get a job by ID
   */
  get(jobId) {
    return this.jobs.get(jobId);
  }

  /**
   * Get all jobs
   */
  getAll() {
    return Array.from(this.jobs.values());
  }

  /**
   * Get all jobs for a specific project
   * @param {string} projectId - Project ID to filter by
   * @returns {Array} Jobs belonging to this project
   */
  getByProject(projectId) {
    return Array.from(this.jobs.values()).filter(job => job.project_id === projectId);
  }

  /**
   * Get all global jobs (not assigned to any project)
   * @returns {Array} Jobs without a project_id
   */
  getGlobal() {
    return Array.from(this.jobs.values()).filter(job => !job.project_id);
  }

  /**
   * Update a job
   */
  update(jobId, updates) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const updated = {
      ...job,
      ...updates,
      id: jobId, // Prevent ID change
      metadata: {
        ...job.metadata,
        ...updates.metadata,
        updatedAt: new Date().toISOString()
      }
    };

    this.jobs.set(jobId, updated);
    this.onJobChange();

    return updated;
  }

  /**
   * Delete a job
   */
  delete(jobId) {
    const deleted = this.jobs.delete(jobId);
    if (deleted) {
      this.onJobChange();
    }
    return deleted;
  }

  /**
   * Update last run info
   */
  updateLastRun(jobId, runInfo) {
    const job = this.jobs.get(jobId);
    if (job) {
      job.lastRun = runInfo;
      job.runCount = (job.runCount || 0) + 1;
      this.onJobChange();
    }
  }

  /**
   * Get total job count
   */
  count() {
    return this.jobs.size;
  }

  /**
   * Get enabled job count
   */
  countEnabled() {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.enabled !== false) {
        count++;
      }
    }
    return count;
  }

  /**
   * Find jobs by trigger type
   */
  findByTriggerType(type) {
    return this.getAll().filter(job => job.trigger?.type === type);
  }

  /**
   * Find jobs by event topic
   */
  findByEventTopic(topic) {
    return this.getAll().filter(job => {
      if (job.trigger?.type === 'event' && job.trigger.topic === topic) {
        return true;
      }
      if (job.trigger?.type === 'composite') {
        return job.trigger.triggers?.some(t => t.type === 'event' && t.topic === topic);
      }
      return false;
    });
  }
}

module.exports = JobManager;
