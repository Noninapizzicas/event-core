/**
 * Events Module - EventBus + Event Envelope
 *
 * @example
 * const { EventBus, EventEnvelope } = require('./events');
 *
 * // Event Bus híbrido (local + MQTT)
 * const bus = new EventBus({
 *   coreId: 'core-a',
 *   mqtt: mqttClient,
 *   hooks: hookManager,
 *   logger,
 *   tracer
 * });
 *
 * await bus.emit('user.created', { id: 123 });
 *
 * bus.on('user.created', (event) => {
 *   console.log('User created:', event.data);
 * });
 *
 * // Event Envelope
 * const envelope = EventEnvelope.create('user.created', { id: 123 }, {
 *   coreId: 'core-a',
 *   tracer
 * });
 */

const EventBus = require('./bus');
const EventEnvelope = require('./envelope');

module.exports = {
  EventBus,
  EventEnvelope
};
