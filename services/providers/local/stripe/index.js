/**
 * Local Stripe Service
 *
 * Integración con Stripe API para pagos y facturación.
 * Crea pagos, lista transacciones, gestiona clientes y reembolsos.
 * Requiere STRIPE_SECRET_KEY.
 *
 * Eventos:
 * - local.stripe.create-payment.request -> local.stripe.create-payment.response
 * - local.stripe.list-payments.request -> local.stripe.list-payments.response
 * - local.stripe.refund.request -> local.stripe.refund.response
 * - local.stripe.customers.request -> local.stripe.customers.response
 * - local.stripe.invoices.request -> local.stripe.invoices.response
 *
 * @version 1.0.0
 * @created 2026-02-05
 */

const https = require('https');
const querystring = require('querystring');

function stripeApi(method, path, secretKey, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.stripe.com',
      path: `/v1${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
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
          if (parsed.error) {
            return reject(new Error(`Stripe: ${parsed.error.message}`));
          }
          resolve(parsed);
        } catch (e) { reject(new Error('JSON parse error')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    if (body) req.write(querystring.stringify(flattenObj(body)));
    req.end();
  });
}

// Stripe necesita params aplanados: metadata[key]=val
function flattenObj(obj, prefix = '') {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(result, flattenObj(v, key));
    } else {
      result[key] = v;
    }
  }
  return result;
}

function getKey(credentials) {
  return credentials?.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY;
}

module.exports = {
  name: 'local.stripe',
  description: 'Integración con Stripe API — pagos, clientes, reembolsos, facturas',

  functions: {
    'create-payment': {
      event: 'local.stripe.create-payment.request',
      description: 'Crea un PaymentIntent en Stripe',
      input: {
        amount: { type: 'number', description: 'Monto en céntimos (1000 = 10.00€)', required: true },
        currency: { type: 'string', description: 'Moneda ISO (eur, usd, etc.)', required: true },
        description: { type: 'string', description: 'Descripción del pago', required: false },
        customer: { type: 'string', description: 'ID del cliente Stripe (opcional)', required: false },
        metadata: { type: 'object', description: 'Metadatos adicionales', required: false }
      },
      output: {
        paymentId: { type: 'string', description: 'ID del PaymentIntent' },
        client_secret: { type: 'string', description: 'Client secret para frontend' },
        status: { type: 'string', description: 'Estado del pago' }
      }
    },
    'list-payments': {
      event: 'local.stripe.list-payments.request',
      description: 'Lista pagos recientes de Stripe',
      input: {
        limit: { type: 'number', description: 'Máximo resultados (default: 10)', required: false },
        customer: { type: 'string', description: 'Filtrar por cliente', required: false }
      },
      output: {
        payments: { type: 'array', description: 'Lista de pagos' },
        total: { type: 'number', description: 'Total devuelto' }
      }
    },
    refund: {
      event: 'local.stripe.refund.request',
      description: 'Crea un reembolso de un pago',
      input: {
        payment_intent: { type: 'string', description: 'ID del PaymentIntent a reembolsar', required: true },
        amount: { type: 'number', description: 'Monto parcial en céntimos (omitir = total)', required: false },
        reason: { type: 'string', description: 'Razón: duplicate, fraudulent, requested_by_customer', required: false }
      },
      output: {
        refundId: { type: 'string', description: 'ID del reembolso' },
        status: { type: 'string', description: 'Estado del reembolso' }
      }
    },
    customers: {
      event: 'local.stripe.customers.request',
      description: 'Lista o busca clientes en Stripe',
      input: {
        email: { type: 'string', description: 'Filtrar por email', required: false },
        limit: { type: 'number', description: 'Máximo resultados (default: 10)', required: false }
      },
      output: {
        customers: { type: 'array', description: 'Lista de clientes' },
        total: { type: 'number', description: 'Total devuelto' }
      }
    },
    invoices: {
      event: 'local.stripe.invoices.request',
      description: 'Lista facturas de Stripe',
      input: {
        customer: { type: 'string', description: 'Filtrar por cliente', required: false },
        status: { type: 'string', description: 'Filtrar por estado: draft, open, paid, void', required: false },
        limit: { type: 'number', description: 'Máximo resultados (default: 10)', required: false }
      },
      output: {
        invoices: { type: 'array', description: 'Lista de facturas' },
        total: { type: 'number', description: 'Total devuelto' }
      }
    }
  },

  async 'create-payment'({ amount, currency, description, customer, metadata, _credentials }) {
    if (!amount || !currency) return { success: false, error: 'amount y currency son requeridos' };
    const key = getKey(_credentials);
    if (!key) return { success: false, error: 'STRIPE_SECRET_KEY requerido' };

    try {
      const params = {
        amount: Math.round(amount),
        currency: currency.toLowerCase(),
        automatic_payment_methods: { enabled: 'true' }
      };
      if (description) params.description = description;
      if (customer) params.customer = customer;
      if (metadata) params.metadata = metadata;

      const data = await stripeApi('POST', '/payment_intents', key, params);
      return {
        success: true,
        data: {
          paymentId: data.id,
          client_secret: data.client_secret,
          status: data.status,
          amount: data.amount,
          currency: data.currency
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async 'list-payments'({ limit = 10, customer, _credentials } = {}) {
    const key = getKey(_credentials);
    if (!key) return { success: false, error: 'STRIPE_SECRET_KEY requerido' };

    try {
      let path = `/payment_intents?limit=${limit}`;
      if (customer) path += `&customer=${customer}`;

      const data = await stripeApi('GET', path, key);
      const payments = (data.data || []).map(p => ({
        id: p.id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        description: p.description,
        created: new Date(p.created * 1000).toISOString()
      }));
      return { success: true, data: { payments, total: payments.length } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async refund({ payment_intent, amount, reason, _credentials }) {
    if (!payment_intent) return { success: false, error: 'payment_intent es requerido' };
    const key = getKey(_credentials);
    if (!key) return { success: false, error: 'STRIPE_SECRET_KEY requerido' };

    try {
      const params = { payment_intent };
      if (amount) params.amount = Math.round(amount);
      if (reason) params.reason = reason;

      const data = await stripeApi('POST', '/refunds', key, params);
      return {
        success: true,
        data: {
          refundId: data.id,
          status: data.status,
          amount: data.amount,
          currency: data.currency
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async customers({ email, limit = 10, _credentials } = {}) {
    const key = getKey(_credentials);
    if (!key) return { success: false, error: 'STRIPE_SECRET_KEY requerido' };

    try {
      let path = `/customers?limit=${limit}`;
      if (email) path += `&email=${encodeURIComponent(email)}`;

      const data = await stripeApi('GET', path, key);
      const customers = (data.data || []).map(c => ({
        id: c.id,
        email: c.email,
        name: c.name,
        created: new Date(c.created * 1000).toISOString()
      }));
      return { success: true, data: { customers, total: customers.length } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async invoices({ customer, status, limit = 10, _credentials } = {}) {
    const key = getKey(_credentials);
    if (!key) return { success: false, error: 'STRIPE_SECRET_KEY requerido' };

    try {
      let path = `/invoices?limit=${limit}`;
      if (customer) path += `&customer=${customer}`;
      if (status) path += `&status=${status}`;

      const data = await stripeApi('GET', path, key);
      const invoices = (data.data || []).map(i => ({
        id: i.id,
        number: i.number,
        customer: i.customer,
        amount_due: i.amount_due,
        currency: i.currency,
        status: i.status,
        due_date: i.due_date ? new Date(i.due_date * 1000).toISOString() : null,
        created: new Date(i.created * 1000).toISOString()
      }));
      return { success: true, data: { invoices, total: invoices.length } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};
