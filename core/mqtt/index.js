/**
 * MQTT Module - Broker embebido + Client wrapper + Topic helpers
 *
 * @example
 * const { MQTTClient, EmbeddedBroker, topics } = require('./mqtt');
 *
 * // Cliente con fallback automático
 * const client = new MQTTClient({ coreId: 'core-a', logger });
 * await client.connect();
 * await client.publish('core/core-a/events/test', { data: 'hello' });
 *
 * // Broker standalone
 * const broker = new EmbeddedBroker({ port: 1883, logger });
 * await broker.start();
 *
 * // Topic helpers
 * const topic = topics.event('core-a', 'user.created');
 * // 'core/core-a/events/user/created'
 */

const MQTTClient = require('./client');
const EmbeddedBroker = require('../broker/embedded');
const topics = require('./topics');

module.exports = {
  MQTTClient,
  EmbeddedBroker,
  topics
};
