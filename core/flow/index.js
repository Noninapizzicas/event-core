/**
 * Flow System - Entry point
 *
 * Exporta las 3 piezas del motor de flows.
 *
 * Uso:
 *   const { FlowEngine, Registry, FlowAgent } = require('./core/flow');
 *
 * @version 1.0.0
 */

const FlowEngine = require('./engine');
const Registry = require('./registry');
const FlowAgent = require('./agent');

module.exports = { FlowEngine, Registry, FlowAgent };
