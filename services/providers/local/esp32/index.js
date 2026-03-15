/**
 * Local ESP32 Service
 *
 * Comunicación con dispositivos ESP32 via MQTT (Aedes broker interno).
 * Envía comandos, lee sensores, gestiona OTA y listado de dispositivos.
 *
 * Convención de topics MQTT para ESP32:
 *   esp32/{deviceId}/command   → comandos al dispositivo
 *   esp32/{deviceId}/status    → estado del dispositivo
 *   esp32/{deviceId}/sensor    → datos de sensores
 *   esp32/{deviceId}/ota       → actualizaciones OTA
 *
 * Eventos:
 * - local.esp32.send-command.request -> local.esp32.send-command.response
 * - local.esp32.read-sensor.request -> local.esp32.read-sensor.response
 * - local.esp32.ota-update.request -> local.esp32.ota-update.response
 * - local.esp32.list-devices.request -> local.esp32.list-devices.response
 * - local.esp32.status.request -> local.esp32.status.response
 *
 * @version 1.0.0
 * @created 2026-02-05
 */

const DEVICE_TIMEOUT = 10000;
const ESP32_TOPIC_PREFIX = 'esp32';

// Registro de dispositivos conocidos (se puebla escuchando status)
const devices = new Map();

module.exports = {
  name: 'local.esp32',
  description: 'Comunicación con dispositivos ESP32 via MQTT — comandos, sensores, OTA',

  functions: {
    'send-command': {
      event: 'local.esp32.send-command.request',
      description: 'Envía un comando a un ESP32 via MQTT',
      input: {
        deviceId: { type: 'string', description: 'ID del dispositivo ESP32', required: true },
        command: { type: 'string', description: 'Comando a enviar (ej: relay_on, led_blink, reset)', required: true },
        params: { type: 'object', description: 'Parámetros del comando (opcional)', required: false }
      },
      output: {
        sent: { type: 'boolean', description: 'Si se envió correctamente' },
        topic: { type: 'string', description: 'Topic MQTT usado' }
      }
    },
    'read-sensor': {
      event: 'local.esp32.read-sensor.request',
      description: 'Solicita lectura de sensor a un ESP32',
      input: {
        deviceId: { type: 'string', description: 'ID del dispositivo', required: true },
        sensor: { type: 'string', description: 'Tipo de sensor (temperature, humidity, light, etc.)', required: false }
      },
      output: {
        deviceId: { type: 'string', description: 'ID del dispositivo' },
        readings: { type: 'object', description: 'Lecturas del sensor' }
      }
    },
    'ota-update': {
      event: 'local.esp32.ota-update.request',
      description: 'Inicia actualización OTA de un ESP32',
      input: {
        deviceId: { type: 'string', description: 'ID del dispositivo', required: true },
        firmware_url: { type: 'string', description: 'URL del firmware .bin', required: true },
        version: { type: 'string', description: 'Versión del firmware', required: false }
      },
      output: {
        sent: { type: 'boolean', description: 'Si se envió la orden OTA' }
      }
    },
    'list-devices': {
      event: 'local.esp32.list-devices.request',
      description: 'Lista dispositivos ESP32 conocidos y su último estado',
      input: {},
      output: {
        devices: { type: 'array', description: 'Lista de dispositivos con estado' },
        total: { type: 'number', description: 'Total de dispositivos' }
      }
    },
    status: {
      event: 'local.esp32.status.request',
      description: 'Solicita estado completo de un ESP32 específico',
      input: {
        deviceId: { type: 'string', description: 'ID del dispositivo', required: true }
      },
      output: {
        online: { type: 'boolean', description: 'Si está conectado' },
        info: { type: 'object', description: 'Info del dispositivo (ip, firmware, uptime, free_heap)' }
      }
    }
  },

  async 'send-command'({ deviceId, command, params = {}, _context }) {
    if (!deviceId || !command) {
      return { success: false, error: 'deviceId y command son requeridos' };
    }

    const topic = `${ESP32_TOPIC_PREFIX}/${deviceId}/command`;
    const payload = JSON.stringify({
      cmd: command,
      params,
      ts: Date.now(),
      id: `cmd_${Date.now().toString(36)}`
    });

    try {
      if (_context?.emit) {
        _context.emit(topic, payload);
      }

      return {
        success: true,
        data: {
          sent: true,
          deviceId,
          command,
          topic,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      return { success: false, error: `Error enviando comando: ${error.message}` };
    }
  },

  async 'read-sensor'({ deviceId, sensor, _context }) {
    if (!deviceId) return { success: false, error: 'deviceId es requerido' };

    const topic = `${ESP32_TOPIC_PREFIX}/${deviceId}/command`;
    const payload = JSON.stringify({
      cmd: 'read_sensor',
      params: { sensor: sensor || 'all' },
      ts: Date.now()
    });

    try {
      if (_context?.emit) {
        _context.emit(topic, payload);
      }

      // Devolver último dato conocido si existe
      const device = devices.get(deviceId);
      const lastReadings = device?.sensors || {};

      return {
        success: true,
        data: {
          deviceId,
          sensor: sensor || 'all',
          readings: lastReadings,
          requestSent: true,
          nota: 'Lectura solicitada via MQTT. Datos actuales son del último reporte.'
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async 'ota-update'({ deviceId, firmware_url, version, _context }) {
    if (!deviceId || !firmware_url) {
      return { success: false, error: 'deviceId y firmware_url son requeridos' };
    }

    const topic = `${ESP32_TOPIC_PREFIX}/${deviceId}/ota`;
    const payload = JSON.stringify({
      cmd: 'ota_update',
      url: firmware_url,
      version: version || 'unknown',
      ts: Date.now()
    });

    try {
      if (_context?.emit) {
        _context.emit(topic, payload);
      }

      return {
        success: true,
        data: {
          sent: true,
          deviceId,
          firmware_url,
          version: version || 'unknown',
          topic
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async 'list-devices'() {
    const deviceList = [];
    for (const [id, info] of devices.entries()) {
      deviceList.push({
        deviceId: id,
        online: (Date.now() - (info.lastSeen || 0)) < 60000,
        lastSeen: info.lastSeen ? new Date(info.lastSeen).toISOString() : null,
        ip: info.ip || null,
        firmware: info.firmware || null,
        sensors: Object.keys(info.sensors || {})
      });
    }

    return {
      success: true,
      data: {
        devices: deviceList,
        total: deviceList.length
      }
    };
  },

  async status({ deviceId, _context }) {
    if (!deviceId) return { success: false, error: 'deviceId es requerido' };

    // Solicitar status fresco
    const topic = `${ESP32_TOPIC_PREFIX}/${deviceId}/command`;
    if (_context?.emit) {
      _context.emit(topic, JSON.stringify({ cmd: 'status', ts: Date.now() }));
    }

    const device = devices.get(deviceId);
    const online = device ? (Date.now() - (device.lastSeen || 0)) < 60000 : false;

    return {
      success: true,
      data: {
        deviceId,
        online,
        info: device ? {
          ip: device.ip,
          firmware: device.firmware,
          uptime: device.uptime,
          free_heap: device.free_heap,
          lastSeen: device.lastSeen ? new Date(device.lastSeen).toISOString() : null,
          sensors: device.sensors || {}
        } : null,
        nota: !device ? 'Dispositivo no registrado. Conectar ESP32 al broker MQTT.' : undefined
      }
    };
  },

  // Método para registrar datos de dispositivos (llamado por handler MQTT)
  _registerDevice(deviceId, data) {
    const existing = devices.get(deviceId) || {};
    devices.set(deviceId, {
      ...existing,
      ...data,
      lastSeen: Date.now()
    });
  }
};
