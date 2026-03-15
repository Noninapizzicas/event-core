/**
 * UI Module - Request/Response communication with frontend
 *
 * Provides structured communication between frontend and backend
 * using MQTT with Request/Response semantics.
 *
 * @see docs/architecture/mqtt-request-response.md
 */

const UIRequestHandler = require('./UIRequestHandler');

module.exports = {
  UIRequestHandler,
  STATUS: UIRequestHandler.STATUS,
  UIRequestError: UIRequestHandler.UIRequestError,
  ValidationError: UIRequestHandler.ValidationError,
  NotFoundError: UIRequestHandler.NotFoundError,
  ConflictError: UIRequestHandler.ConflictError
};
