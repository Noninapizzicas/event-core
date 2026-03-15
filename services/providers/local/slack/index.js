/**
 * Local Slack Service
 *
 * Integración con Slack Bot API — mensajes, canales, historial.
 * Requiere Slack Bot Token (xoxb-...).
 *
 * Eventos:
 * - local.slack.send.request -> local.slack.send.response
 * - local.slack.list-channels.request -> local.slack.list-channels.response
 * - local.slack.history.request -> local.slack.history.response
 * - local.slack.upload.request -> local.slack.upload.response
 * - local.slack.react.request -> local.slack.react.response
 *
 * @version 1.0.0
 * @created 2026-02-05
 */

const https = require('https');

function slackApi(method, token, body = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: 'slack.com',
      path: `/api/${method}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) return reject(new Error(`Slack: ${parsed.error || 'unknown error'}`));
          resolve(parsed);
        } catch (e) { reject(new Error('JSON parse error')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function getToken(credentials) {
  return credentials?.SLACK_BOT_TOKEN || credentials?.token || process.env.SLACK_BOT_TOKEN;
}

module.exports = {
  name: 'local.slack',
  description: 'Integración con Slack Bot API — mensajes, canales, historial',

  functions: {
    send: {
      event: 'local.slack.send.request',
      description: 'Envía un mensaje a un canal o usuario de Slack',
      input: {
        channel: { type: 'string', description: 'ID del canal o usuario', required: true },
        text: { type: 'string', description: 'Texto del mensaje', required: true },
        blocks: { type: 'array', description: 'Blocks de Slack (rich formatting, opcional)', required: false },
        thread_ts: { type: 'string', description: 'Timestamp del mensaje padre (para threads)', required: false }
      },
      output: { ts: { type: 'string', description: 'Timestamp del mensaje enviado' } }
    },
    'list-channels': {
      event: 'local.slack.list-channels.request',
      description: 'Lista canales del workspace',
      input: {
        types: { type: 'string', description: 'public_channel,private_channel (default: public_channel)', required: false },
        limit: { type: 'number', description: 'Máximo resultados (default: 100)', required: false }
      },
      output: { channels: { type: 'array', description: 'Lista de canales' } }
    },
    history: {
      event: 'local.slack.history.request',
      description: 'Obtiene historial de mensajes de un canal',
      input: {
        channel: { type: 'string', description: 'ID del canal', required: true },
        limit: { type: 'number', description: 'Máximo mensajes (default: 20)', required: false }
      },
      output: { messages: { type: 'array', description: 'Mensajes del canal' } }
    },
    upload: {
      event: 'local.slack.upload.request',
      description: 'Sube un archivo a un canal',
      input: {
        channel: { type: 'string', description: 'ID del canal', required: true },
        content: { type: 'string', description: 'Contenido del archivo (texto)', required: true },
        filename: { type: 'string', description: 'Nombre del archivo', required: true },
        title: { type: 'string', description: 'Título (opcional)', required: false }
      },
      output: { file_id: { type: 'string', description: 'ID del archivo subido' } }
    },
    react: {
      event: 'local.slack.react.request',
      description: 'Añade una reacción emoji a un mensaje',
      input: {
        channel: { type: 'string', description: 'ID del canal', required: true },
        timestamp: { type: 'string', description: 'Timestamp del mensaje', required: true },
        name: { type: 'string', description: 'Nombre del emoji (sin :)', required: true }
      },
      output: { added: { type: 'boolean', description: 'Si se añadió' } }
    }
  },

  async send({ channel, text, blocks, thread_ts, _credentials }) {
    if (!channel || !text) return { success: false, error: 'channel y text son requeridos' };
    const token = getToken(_credentials);
    if (!token) return { success: false, error: 'SLACK_BOT_TOKEN no configurado' };
    try {
      const body = { channel, text };
      if (blocks) body.blocks = blocks;
      if (thread_ts) body.thread_ts = thread_ts;
      const data = await slackApi('chat.postMessage', token, body);
      return { success: true, data: { ts: data.ts, channel: data.channel } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async 'list-channels'({ types = 'public_channel', limit = 100, _credentials } = {}) {
    const token = getToken(_credentials);
    if (!token) return { success: false, error: 'SLACK_BOT_TOKEN no configurado' };
    try {
      const data = await slackApi('conversations.list', token, { types, limit });
      const channels = (data.channels || []).map(c => ({
        id: c.id, name: c.name, topic: c.topic?.value || '',
        purpose: c.purpose?.value || '', members: c.num_members, is_private: c.is_private
      }));
      return { success: true, data: { channels, total: channels.length } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async history({ channel, limit = 20, _credentials }) {
    if (!channel) return { success: false, error: 'channel es requerido' };
    const token = getToken(_credentials);
    if (!token) return { success: false, error: 'SLACK_BOT_TOKEN no configurado' };
    try {
      const data = await slackApi('conversations.history', token, { channel, limit });
      const messages = (data.messages || []).map(m => ({
        ts: m.ts, user: m.user, text: m.text, type: m.type,
        thread_ts: m.thread_ts, reply_count: m.reply_count
      }));
      return { success: true, data: { messages, channel } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async upload({ channel, content, filename, title, _credentials }) {
    if (!channel || !content || !filename) return { success: false, error: 'channel, content y filename requeridos' };
    const token = getToken(_credentials);
    if (!token) return { success: false, error: 'SLACK_BOT_TOKEN no configurado' };
    try {
      const data = await slackApi('files.upload', token, {
        channels: channel, content, filename, title: title || filename
      });
      return { success: true, data: { file_id: data.file?.id, name: data.file?.name } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async react({ channel, timestamp, name, _credentials }) {
    if (!channel || !timestamp || !name) return { success: false, error: 'channel, timestamp y name requeridos' };
    const token = getToken(_credentials);
    if (!token) return { success: false, error: 'SLACK_BOT_TOKEN no configurado' };
    try {
      await slackApi('reactions.add', token, { channel, timestamp, name });
      return { success: true, data: { added: true, emoji: name } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};
