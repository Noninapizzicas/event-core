/**
 * Local WhatsApp Service
 *
 * Integración con WhatsApp Business API (Meta Cloud API).
 * Envía mensajes, media, templates y lee chats.
 * Requiere WhatsApp Business token y Phone Number ID.
 *
 * Eventos:
 * - local.whatsapp.send.request -> local.whatsapp.send.response
 * - local.whatsapp.send-media.request -> local.whatsapp.send-media.response
 * - local.whatsapp.template.request -> local.whatsapp.template.response
 * - local.whatsapp.read.request -> local.whatsapp.read.response
 * - local.whatsapp.list-templates.request -> local.whatsapp.list-templates.response
 *
 * @version 1.0.0
 * @created 2026-02-05
 */

const https = require('https');

const GRAPH_API_VERSION = 'v18.0';

function graphApi(method, path, token, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'graph.facebook.com',
      path: `/${GRAPH_API_VERSION}${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'EventCore/1.0'
      },
      timeout: 15000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const errMsg = parsed.error?.message || data.substring(0, 200);
            return reject(new Error(`WhatsApp API ${res.statusCode}: ${errMsg}`));
          }
          resolve(parsed);
        } catch (e) { reject(new Error('JSON parse error')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function getConfig(credentials) {
  return {
    token: credentials?.WHATSAPP_TOKEN || process.env.WHATSAPP_TOKEN,
    phoneId: credentials?.WHATSAPP_PHONE_ID || process.env.WHATSAPP_PHONE_ID,
    businessId: credentials?.WHATSAPP_BUSINESS_ID || process.env.WHATSAPP_BUSINESS_ID
  };
}

module.exports = {
  name: 'local.whatsapp',
  description: 'Integración con WhatsApp Business API — mensajes, media, templates',

  functions: {
    send: {
      event: 'local.whatsapp.send.request',
      description: 'Envía un mensaje de texto por WhatsApp',
      input: {
        to: { type: 'string', description: 'Número destino con código país (34612345678)', required: true },
        text: { type: 'string', description: 'Texto del mensaje', required: true },
        preview_url: { type: 'boolean', description: 'Previsualizar URLs (default: false)', required: false }
      },
      output: { message_id: { type: 'string', description: 'ID del mensaje enviado' } }
    },
    'send-media': {
      event: 'local.whatsapp.send-media.request',
      description: 'Envía imagen, documento, audio o video por WhatsApp',
      input: {
        to: { type: 'string', description: 'Número destino', required: true },
        type: { type: 'string', description: 'image | document | audio | video', required: true },
        url: { type: 'string', description: 'URL pública del archivo', required: true },
        caption: { type: 'string', description: 'Texto caption (opcional)', required: false },
        filename: { type: 'string', description: 'Nombre del archivo (para documents)', required: false }
      },
      output: { message_id: { type: 'string', description: 'ID del mensaje' } }
    },
    template: {
      event: 'local.whatsapp.template.request',
      description: 'Envía un mensaje template (aprobado por Meta)',
      input: {
        to: { type: 'string', description: 'Número destino', required: true },
        name: { type: 'string', description: 'Nombre del template', required: true },
        language: { type: 'string', description: 'Código idioma (es, en, etc.)', required: true },
        components: { type: 'array', description: 'Parámetros del template', required: false }
      },
      output: { message_id: { type: 'string', description: 'ID del mensaje' } }
    },
    read: {
      event: 'local.whatsapp.read.request',
      description: 'Marca mensajes como leídos',
      input: {
        message_id: { type: 'string', description: 'ID del mensaje a marcar', required: true }
      },
      output: { marked: { type: 'boolean', description: 'Si se marcó' } }
    },
    'list-templates': {
      event: 'local.whatsapp.list-templates.request',
      description: 'Lista templates aprobados de la cuenta',
      input: {},
      output: { templates: { type: 'array', description: 'Templates disponibles' } }
    }
  },

  async send({ to, text, preview_url = false, _credentials }) {
    if (!to || !text) return { success: false, error: 'to y text son requeridos' };
    const { token, phoneId } = getConfig(_credentials);
    if (!token || !phoneId) return { success: false, error: 'WHATSAPP_TOKEN y WHATSAPP_PHONE_ID requeridos' };

    try {
      const data = await graphApi('POST', `/${phoneId}/messages`, token, {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { preview_url, body: text }
      });
      return { success: true, data: { message_id: data.messages?.[0]?.id, to } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async 'send-media'({ to, type, url, caption, filename, _credentials }) {
    if (!to || !type || !url) return { success: false, error: 'to, type y url son requeridos' };
    const validTypes = ['image', 'document', 'audio', 'video'];
    if (!validTypes.includes(type)) return { success: false, error: `type debe ser: ${validTypes.join(', ')}` };
    const { token, phoneId } = getConfig(_credentials);
    if (!token || !phoneId) return { success: false, error: 'WHATSAPP_TOKEN y WHATSAPP_PHONE_ID requeridos' };

    try {
      const mediaObj = { link: url };
      if (caption && type !== 'audio') mediaObj.caption = caption;
      if (filename && type === 'document') mediaObj.filename = filename;

      const data = await graphApi('POST', `/${phoneId}/messages`, token, {
        messaging_product: 'whatsapp',
        to,
        type,
        [type]: mediaObj
      });
      return { success: true, data: { message_id: data.messages?.[0]?.id, to, type } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async template({ to, name, language, components, _credentials }) {
    if (!to || !name || !language) return { success: false, error: 'to, name y language son requeridos' };
    const { token, phoneId } = getConfig(_credentials);
    if (!token || !phoneId) return { success: false, error: 'WHATSAPP_TOKEN y WHATSAPP_PHONE_ID requeridos' };

    try {
      const templateObj = { name, language: { code: language } };
      if (components) templateObj.components = components;

      const data = await graphApi('POST', `/${phoneId}/messages`, token, {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: templateObj
      });
      return { success: true, data: { message_id: data.messages?.[0]?.id, to, template: name } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async read({ message_id, _credentials }) {
    if (!message_id) return { success: false, error: 'message_id es requerido' };
    const { token, phoneId } = getConfig(_credentials);
    if (!token || !phoneId) return { success: false, error: 'WHATSAPP_TOKEN y WHATSAPP_PHONE_ID requeridos' };

    try {
      await graphApi('POST', `/${phoneId}/messages`, token, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id
      });
      return { success: true, data: { marked: true, message_id } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async 'list-templates'({ _credentials } = {}) {
    const { token, businessId } = getConfig(_credentials);
    if (!token || !businessId) return { success: false, error: 'WHATSAPP_TOKEN y WHATSAPP_BUSINESS_ID requeridos' };

    try {
      const data = await graphApi('GET', `/${businessId}/message_templates`, token);
      const templates = (data.data || []).map(t => ({
        name: t.name,
        status: t.status,
        language: t.language,
        category: t.category,
        components: t.components?.map(c => ({ type: c.type, text: c.text }))
      }));
      return { success: true, data: { templates, total: templates.length } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};
