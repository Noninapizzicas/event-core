/**
 * Gateway System - HTTP API Gateway
 *
 * @example
 * const { HTTPGateway } = require('./gateway');
 *
 * const gateway = new HTTPGateway({
 *   port: 3000,
 *   registry,
 *   logger,
 *   metrics,
 *   hooks
 * });
 *
 * await gateway.start();
 */

const HTTPGateway = require('./http');

module.exports = {
  HTTPGateway
};
