/**
 * Observability Module - Logger, Tracer, Metrics
 *
 * @example
 * const { Logger, Tracer, Metrics } = require('./observability');
 *
 * const logger = new Logger({ level: 'info', coreId: 'core-a' });
 * const tracer = new Tracer({ coreId: 'core-a', logger });
 * const metrics = new Metrics({ coreId: 'core-a' });
 *
 * // Logger
 * logger.info('module.loaded', { module: 'echo' });
 *
 * // Tracer
 * const trace = tracer.start('process.file');
 * trace.addTag('filename', 'data.json');
 * trace.end();
 *
 * // Metrics
 * metrics.increment('events.published');
 * metrics.observe('event.duration_ms', 123.45);
 */

const Logger = require('./logger');
const Tracer = require('./tracer');
const Metrics = require('./metrics');
const ActivityLogger = require('./activity-logger');

module.exports = {
  Logger,
  Tracer,
  Metrics,
  ActivityLogger
};
