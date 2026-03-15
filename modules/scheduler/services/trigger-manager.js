/**
 * Trigger Manager Service
 *
 * Manages different types of triggers:
 * - cron: Cron expressions
 * - interval: Fixed intervals
 * - datetime: Specific date/time
 * - event: MQTT event-based
 * - condition: Condition-based
 * - composite: Combination of triggers
 *
 * @module scheduler/trigger-manager
 */

const cron = require('node-cron');

class TriggerManager {
  constructor({ logger, eventBus, config, onTrigger }) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.config = config;
    this.onTrigger = onTrigger;

    // Active triggers by job ID
    this.activeTriggers = new Map();

    // Debounce timers for event triggers
    this.debounceTimers = new Map();

    // Condition check states
    this.conditionStates = new Map();
  }

  /**
   * Start a trigger for a job
   */
  start(job) {
    if (!job || !job.trigger) {
      this.logger.warn('scheduler.trigger.invalid-job', { jobId: job?.id });
      return;
    }

    // Stop existing trigger if any
    this.stop(job.id);

    const trigger = job.trigger;

    switch (trigger.type) {
      case 'cron':
        this.startCronTrigger(job);
        break;

      case 'interval':
        this.startIntervalTrigger(job);
        break;

      case 'datetime':
        this.startDateTimeTrigger(job);
        break;

      case 'event':
        this.startEventTrigger(job);
        break;

      case 'condition':
        this.startConditionTrigger(job);
        break;

      case 'composite':
        this.startCompositeTrigger(job);
        break;

      default:
        this.logger.warn('scheduler.trigger.unknown-type', {
          jobId: job.id,
          type: trigger.type
        });
    }
  }

  /**
   * Stop a trigger for a job
   */
  stop(jobId) {
    const trigger = this.activeTriggers.get(jobId);
    if (!trigger) return;

    if (trigger.cronTask) {
      trigger.cronTask.stop();
    }

    if (trigger.intervalId) {
      clearInterval(trigger.intervalId);
    }

    if (trigger.timeoutId) {
      clearTimeout(trigger.timeoutId);
    }

    if (trigger.conditionIntervalId) {
      clearInterval(trigger.conditionIntervalId);
    }

    // Clear composite sub-triggers
    if (trigger.subTriggers) {
      for (const sub of trigger.subTriggers) {
        if (sub.stop) sub.stop();
      }
    }

    this.activeTriggers.delete(jobId);
    this.conditionStates.delete(jobId);

    // Clear debounce timer
    const debounce = this.debounceTimers.get(jobId);
    if (debounce) {
      clearTimeout(debounce);
      this.debounceTimers.delete(jobId);
    }

    this.logger.debug('scheduler.trigger.stopped', { jobId });
  }

  /**
   * Stop all triggers
   */
  stopAll() {
    for (const jobId of this.activeTriggers.keys()) {
      this.stop(jobId);
    }
  }

  /**
   * Get trigger status for a job
   */
  getStatus(jobId) {
    const trigger = this.activeTriggers.get(jobId);
    if (!trigger) {
      return { active: false };
    }

    return {
      active: true,
      type: trigger.type,
      nextRun: trigger.nextRun,
      lastTriggered: trigger.lastTriggered
    };
  }

  // ==================== CRON TRIGGER ====================

  startCronTrigger(job) {
    const { trigger } = job;
    const expression = trigger.expression;
    const timezone = trigger.timezone || this.config.defaultTimezone || 'Europe/Madrid';

    if (!cron.validate(expression)) {
      this.logger.error('scheduler.trigger.cron.invalid', {
        jobId: job.id,
        expression
      });
      return;
    }

    const cronTask = cron.schedule(expression, () => {
      this.triggerJob(job, { type: 'cron', expression });
    }, {
      scheduled: true,
      timezone
    });

    this.activeTriggers.set(job.id, {
      type: 'cron',
      cronTask,
      expression,
      timezone,
      nextRun: this.calculateNextCronRun(expression),
      lastTriggered: null
    });

    this.logger.info('scheduler.trigger.cron.started', {
      jobId: job.id,
      jobName: job.name,
      expression,
      timezone
    });
  }

  calculateNextCronRun(expression) {
    try {
      const parts = expression.split(' ');
      const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

      const now = new Date();
      const next = new Date();

      if (hour !== '*') next.setHours(parseInt(hour));
      if (minute !== '*') next.setMinutes(parseInt(minute));
      next.setSeconds(0);

      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }

      if (dayOfWeek !== '*') {
        const targetDay = parseInt(dayOfWeek);
        while (next.getDay() !== targetDay) {
          next.setDate(next.getDate() + 1);
        }
      }

      return next.toISOString();
    } catch {
      return null;
    }
  }

  // ==================== INTERVAL TRIGGER ====================

  startIntervalTrigger(job) {
    const { trigger } = job;
    let intervalMs = trigger.value;

    // Convert unit to milliseconds
    switch (trigger.unit) {
      case 's': intervalMs *= 1000; break;
      case 'm': intervalMs *= 60 * 1000; break;
      case 'h': intervalMs *= 60 * 60 * 1000; break;
      case 'd': intervalMs *= 24 * 60 * 60 * 1000; break;
      case 'ms':
      default:
        break;
    }

    const intervalId = setInterval(() => {
      this.triggerJob(job, { type: 'interval', intervalMs });
    }, intervalMs);

    this.activeTriggers.set(job.id, {
      type: 'interval',
      intervalId,
      intervalMs,
      nextRun: new Date(Date.now() + intervalMs).toISOString(),
      lastTriggered: null
    });

    this.logger.info('scheduler.trigger.interval.started', {
      jobId: job.id,
      jobName: job.name,
      intervalMs
    });
  }

  // ==================== DATETIME TRIGGER ====================

  startDateTimeTrigger(job) {
    const { trigger } = job;
    const { date, time, repeat, timezone } = trigger;

    const scheduleNext = () => {
      const targetDate = this.calculateNextDateTime(date, time, repeat, timezone);
      if (!targetDate) {
        this.logger.warn('scheduler.trigger.datetime.no-next', {
          jobId: job.id,
          date,
          time,
          repeat
        });
        return;
      }

      const now = Date.now();
      const delay = targetDate.getTime() - now;

      if (delay < 0) {
        // Target is in the past, schedule for next occurrence
        if (repeat && repeat !== 'once') {
          scheduleNext();
        }
        return;
      }

      const timeoutId = setTimeout(() => {
        this.triggerJob(job, { type: 'datetime', targetDate: targetDate.toISOString() });

        // Schedule next occurrence if repeating
        if (repeat && repeat !== 'once') {
          scheduleNext();
        }
      }, delay);

      const triggerInfo = this.activeTriggers.get(job.id) || { type: 'datetime' };
      triggerInfo.timeoutId = timeoutId;
      triggerInfo.nextRun = targetDate.toISOString();
      this.activeTriggers.set(job.id, triggerInfo);
    };

    this.activeTriggers.set(job.id, {
      type: 'datetime',
      date,
      time,
      repeat,
      lastTriggered: null
    });

    scheduleNext();

    this.logger.info('scheduler.trigger.datetime.started', {
      jobId: job.id,
      jobName: job.name,
      date,
      time,
      repeat
    });
  }

  calculateNextDateTime(date, time, repeat, timezone) {
    const now = new Date();
    let target;

    if (date) {
      const [year, month, day] = date.split('-').map(Number);
      const [hour, minute, second] = (time || '00:00:00').split(':').map(Number);
      target = new Date(year, month - 1, day, hour, minute, second || 0);
    } else if (time) {
      const [hour, minute, second] = time.split(':').map(Number);
      target = new Date(now);
      target.setHours(hour, minute, second || 0, 0);
    } else {
      return null;
    }

    // If target is in the past, calculate next occurrence based on repeat
    if (target <= now && repeat) {
      switch (repeat) {
        case 'daily':
          while (target <= now) {
            target.setDate(target.getDate() + 1);
          }
          break;

        case 'weekly':
          while (target <= now) {
            target.setDate(target.getDate() + 7);
          }
          break;

        case 'monthly':
          while (target <= now) {
            target.setMonth(target.getMonth() + 1);
          }
          break;

        case 'yearly':
          while (target <= now) {
            target.setFullYear(target.getFullYear() + 1);
          }
          break;

        case 'once':
        default:
          if (target <= now) return null;
          break;
      }
    }

    return target;
  }

  // ==================== EVENT TRIGGER ====================

  startEventTrigger(job) {
    // Event triggers are handled externally by the main module
    // which subscribes to MQTT topics and calls handleEventTrigger

    this.activeTriggers.set(job.id, {
      type: 'event',
      topic: job.trigger.topic,
      condition: job.trigger.condition,
      debounce: job.trigger.debounce,
      lastTriggered: null
    });

    this.logger.info('scheduler.trigger.event.started', {
      jobId: job.id,
      jobName: job.name,
      topic: job.trigger.topic
    });
  }

  handleEventTrigger(job, topic, event) {
    const { trigger } = job;
    const debounceMs = trigger.debounce || 0;

    // Clear existing debounce timer
    const existingTimer = this.debounceTimers.get(job.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    if (debounceMs > 0) {
      // Set debounce timer
      const timer = setTimeout(() => {
        this.debounceTimers.delete(job.id);
        this.triggerJob(job, { type: 'event', topic, event });
      }, debounceMs);

      this.debounceTimers.set(job.id, timer);
    } else {
      // Trigger immediately
      this.triggerJob(job, { type: 'event', topic, event });
    }
  }

  // ==================== CONDITION TRIGGER ====================

  startConditionTrigger(job) {
    const { trigger } = job;
    const checkInterval = trigger.interval || 10000;
    const persist = trigger.persist || false;

    // Initialize condition state
    this.conditionStates.set(job.id, {
      triggered: false,
      lastCheck: null,
      lastValue: null
    });

    const checkCondition = () => {
      const state = this.conditionStates.get(job.id);
      const wasTriggered = state.triggered;

      try {
        // Evaluate condition
        // In a real implementation, you'd have access to system metrics
        const metrics = this.getMetricsContext();
        const fn = new Function('metrics', 'system', `return ${trigger.check}`);
        const result = fn(metrics, metrics);

        state.lastCheck = new Date().toISOString();
        state.lastValue = result;

        if (result && (!persist || !wasTriggered)) {
          state.triggered = true;
          this.triggerJob(job, {
            type: 'condition',
            check: trigger.check,
            result
          });
        } else if (!result && persist) {
          state.triggered = false;
        }

      } catch (err) {
        this.logger.warn('scheduler.trigger.condition.error', {
          jobId: job.id,
          check: trigger.check,
          error: err.message
        });
      }
    };

    // Initial check
    checkCondition();

    // Start interval checks
    const conditionIntervalId = setInterval(checkCondition, checkInterval);

    this.activeTriggers.set(job.id, {
      type: 'condition',
      conditionIntervalId,
      check: trigger.check,
      checkInterval,
      persist,
      lastTriggered: null
    });

    this.logger.info('scheduler.trigger.condition.started', {
      jobId: job.id,
      jobName: job.name,
      check: trigger.check,
      checkInterval
    });
  }

  getMetricsContext() {
    // Returns mock metrics context
    // In production, this would integrate with the metrics system
    return {
      cpu: Math.random() * 100,
      memory: Math.random() * 100,
      load: Math.random() * 100
    };
  }

  // ==================== COMPOSITE TRIGGER ====================

  startCompositeTrigger(job) {
    const { trigger } = job;
    const logic = trigger.logic || 'AND';
    const subTriggers = trigger.triggers || [];

    // Track state of each sub-trigger
    const triggerStates = new Map();

    const checkComposite = () => {
      const states = Array.from(triggerStates.values());

      if (states.length === 0) return false;

      switch (logic) {
        case 'AND':
          return states.every(s => s.triggered);

        case 'OR':
          return states.some(s => s.triggered);

        case 'NAND':
          return !states.every(s => s.triggered);

        case 'NOR':
          return !states.some(s => s.triggered);

        case 'XOR':
          return states.filter(s => s.triggered).length === 1;

        default:
          return false;
      }
    };

    const onSubTrigger = (index, info) => {
      triggerStates.set(index, { triggered: true, info, timestamp: Date.now() });

      if (checkComposite()) {
        // Reset states for non-persistent triggers
        for (const [idx, state] of triggerStates) {
          state.triggered = false;
        }

        this.triggerJob(job, {
          type: 'composite',
          logic,
          subTriggers: Array.from(triggerStates.entries()).map(([idx, state]) => ({
            index: idx,
            ...state
          }))
        });
      }
    };

    // Start sub-triggers
    const subTriggerHandlers = [];

    for (let i = 0; i < subTriggers.length; i++) {
      const subTrigger = subTriggers[i];
      triggerStates.set(i, { triggered: false });

      switch (subTrigger.type) {
        case 'cron':
          if (cron.validate(subTrigger.expression)) {
            const cronTask = cron.schedule(subTrigger.expression, () => {
              onSubTrigger(i, { type: 'cron', expression: subTrigger.expression });
            }, {
              scheduled: true,
              timezone: subTrigger.timezone || this.config.defaultTimezone
            });
            subTriggerHandlers.push({ stop: () => cronTask.stop() });
          }
          break;

        case 'condition':
          const conditionIntervalId = setInterval(() => {
            try {
              const metrics = this.getMetricsContext();
              const fn = new Function('metrics', 'system', `return ${subTrigger.check}`);
              const result = fn(metrics, metrics);
              if (result) {
                onSubTrigger(i, { type: 'condition', check: subTrigger.check, result });
              }
            } catch (err) {
              this.logger.warn('scheduler.trigger.composite.condition.error', {
                jobId: job.id,
                index: i,
                error: err.message
              });
            }
          }, subTrigger.interval || 10000);
          subTriggerHandlers.push({ stop: () => clearInterval(conditionIntervalId) });
          break;

        case 'interval':
          let intervalMs = subTrigger.value;
          switch (subTrigger.unit) {
            case 's': intervalMs *= 1000; break;
            case 'm': intervalMs *= 60 * 1000; break;
            case 'h': intervalMs *= 60 * 60 * 1000; break;
            case 'd': intervalMs *= 24 * 60 * 60 * 1000; break;
          }
          const intervalId = setInterval(() => {
            onSubTrigger(i, { type: 'interval', intervalMs });
          }, intervalMs);
          subTriggerHandlers.push({ stop: () => clearInterval(intervalId) });
          break;

        // Event sub-triggers are handled by the main event subscription
      }
    }

    this.activeTriggers.set(job.id, {
      type: 'composite',
      logic,
      subTriggers: subTriggerHandlers,
      triggerStates,
      lastTriggered: null
    });

    this.logger.info('scheduler.trigger.composite.started', {
      jobId: job.id,
      jobName: job.name,
      logic,
      subTriggerCount: subTriggers.length
    });
  }

  // ==================== TRIGGER EXECUTION ====================

  triggerJob(job, triggerInfo) {
    // Update trigger info
    const trigger = this.activeTriggers.get(job.id);
    if (trigger) {
      trigger.lastTriggered = new Date().toISOString();

      // Update next run for cron triggers
      if (trigger.type === 'cron') {
        trigger.nextRun = this.calculateNextCronRun(trigger.expression);
      }
    }

    // Check overlap option
    if (job.options?.overlap === false) {
      // TODO: Check if job is currently running
      // For now, we allow execution
    }

    // Call the execution callback
    this.onTrigger(job, triggerInfo);
  }
}

module.exports = TriggerManager;
