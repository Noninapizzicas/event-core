/**
 * Local Glovo Provider v1.1
 *
 * Integración con Glovo Partner API v2 para recibir y gestionar pedidos.
 * Usa polling (order history) — no requiere endpoint público/webhooks.
 *
 * Autenticación: OAuth2 Client Credentials
 *   POST /v2/oauth/token → Bearer token (2h TTL, cache automático)
 *
 * Credenciales via credential-manager:
 *   GLOVO_CLIENT_ID     — Client ID de Glovo Partner
 *   GLOVO_CLIENT_SECRET  — Client Secret de Glovo Partner
 *   GLOVO_CHAIN_ID       — ID del chain (grupo de stores)
 *
 * Endpoints Glovo Partner API v2:
 *   Base: https://glovo.partner.deliveryhero.io (producción)
 *         https://stageapi.glovoapp.com (staging)
 *
 *   POST   /v2/oauth/token                              — obtener token
 *   GET    /v2/chains/{chainId}/orders/{orderId}        — detalle pedido
 *   PUT    /v2/chains/{chainId}/orders/{orderId}        — actualizar estado
 *
 * Eventos:
 * - local.glovo.poll_orders.request  → response
 * - local.glovo.get_order.request    → response
 * - local.glovo.accept_order.request → response
 * - local.glovo.reject_order.request → response
 * - local.glovo.mark_ready.request   → response
 *
 * @version 1.1.0
 */

const https = require('https');

// Entornos de la API de Glovo
const API_HOSTS = {
  production: 'glovo.partner.deliveryhero.io',
  staging: 'stageapi.glovoapp.com'
};

module.exports = {
  name: 'local.glovo',
  description: 'Integración con Glovo Partner API v2 (OAuth2)',

  // Token cache
  _token: null,
  _tokenExpiresAt: 0,

  functions: {
    poll_orders: {
      event: 'local.glovo.poll_orders.request',
      description: 'Obtener pedidos recientes del chain',
      input: {
        status: { type: 'string', default: 'RECEIVED' },
        minutes_back: { type: 'number', default: 30 }
      }
    },
    get_order: {
      event: 'local.glovo.get_order.request',
      description: 'Obtener detalle de un pedido',
      input: {
        order_id: { type: 'string', required: true }
      }
    },
    accept_order: {
      event: 'local.glovo.accept_order.request',
      description: 'Aceptar un pedido',
      input: {
        order_id: { type: 'string', required: true },
        preparation_minutes: { type: 'number', default: 20 }
      }
    },
    reject_order: {
      event: 'local.glovo.reject_order.request',
      description: 'Rechazar un pedido',
      input: {
        order_id: { type: 'string', required: true },
        reason: { type: 'string', default: 'STORE_CLOSED' }
      }
    },
    mark_ready: {
      event: 'local.glovo.mark_ready.request',
      description: 'Marcar pedido como listo para rider',
      input: {
        order_id: { type: 'string', required: true }
      }
    }
  },

  // ==========================================
  // Credenciales
  // ==========================================

  resolveCredentials() {
    const clientId = process.env.GLOVO_CLIENT_ID
      || process.env.GLOVO_CLIENT_ID_GLOBAL;
    const clientSecret = process.env.GLOVO_CLIENT_SECRET
      || process.env.GLOVO_CLIENT_SECRET_GLOBAL;
    const chainId = process.env.GLOVO_CHAIN_ID
      || process.env.GLOVO_CHAIN_ID_GLOBAL;
    const env = process.env.GLOVO_ENV || 'production';

    if (!clientId || !clientSecret) {
      throw new Error('GLOVO_CLIENT_ID y GLOVO_CLIENT_SECRET requeridos. Configurar via credential-manager o .env');
    }
    if (!chainId) {
      throw new Error('GLOVO_CHAIN_ID requerido. Configurar via credential-manager o .env');
    }

    return { clientId, clientSecret, chainId, env };
  },

  // ==========================================
  // OAuth2 Token
  // ==========================================

  async getToken() {
    // Usar token en cache si aún es válido (con 5 min de margen)
    if (this._token && Date.now() < this._tokenExpiresAt - 300000) {
      return this._token;
    }

    const { clientId, clientSecret, env } = this.resolveCredentials();
    const host = API_HOSTS[env] || API_HOSTS.production;

    const body = JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    });

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: host,
        port: 443,
        path: '/v2/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 15000
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(`OAuth error: ${parsed.error || parsed.message || `HTTP ${res.statusCode}`}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error(`OAuth: respuesta inválida (HTTP ${res.statusCode})`));
          }
        });
      });

      req.on('error', (err) => reject(new Error(`OAuth: ${err.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('OAuth: timeout')); });
      req.write(body);
      req.end();
    });

    this._token = result.access_token;
    // expires_in es en segundos (default 7200 = 2h)
    this._tokenExpiresAt = Date.now() + (result.expires_in || 7200) * 1000;

    return this._token;
  },

  // ==========================================
  // HTTP Client (autenticado)
  // ==========================================

  async request(method, path, body = null) {
    const { chainId, env } = this.resolveCredentials();
    const token = await this.getToken();
    const host = API_HOSTS[env] || API_HOSTS.production;

    // Reemplazar {chainId} en el path
    const resolvedPath = path.replace('{chainId}', chainId);

    return new Promise((resolve, reject) => {
      const postData = body ? JSON.stringify(body) : null;

      const options = {
        hostname: host,
        port: 443,
        path: resolvedPath,
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(postData && { 'Content-Length': Buffer.byteLength(postData) })
        },
        timeout: 30000
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          // 401 = token expirado, invalidar cache
          if (res.statusCode === 401) {
            this._token = null;
            this._tokenExpiresAt = 0;
          }

          try {
            const parsed = data ? JSON.parse(data) : {};

            if (res.statusCode >= 400) {
              const errorMsg = parsed.error?.message
                || parsed.message
                || `HTTP ${res.statusCode}: ${data.substring(0, 200)}`;
              reject(new Error(errorMsg));
            } else {
              resolve({ status: res.statusCode, data: parsed });
            }
          } catch (e) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ status: res.statusCode, data: {} });
            } else {
              reject(new Error(`Glovo API: respuesta inválida (HTTP ${res.statusCode})`));
            }
          }
        });
      });

      req.on('error', (err) => reject(new Error(`Glovo API: ${err.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Glovo API: timeout')); });
      if (postData) req.write(postData);
      req.end();
    });
  },

  // ==========================================
  // Functions
  // ==========================================

  /**
   * Polling de pedidos — obtiene pedidos recientes y filtra por estado
   *
   * Estados Glovo:
   *   RECEIVED         — nuevo, pendiente de aceptar
   *   ACCEPTED         — aceptado, en preparación
   *   READY_FOR_PICKUP — listo para rider
   *   DISPATCHED       — en camino
   *   DELIVERED        — entregado
   *   CANCELLED        — cancelado
   */
  async poll_orders({ status = 'RECEIVED', minutes_back = 30 } = {}) {
    // Rango de tiempo para buscar pedidos
    const end = new Date().toISOString();
    const start = new Date(Date.now() - minutes_back * 60 * 1000).toISOString();

    const queryParams = `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    const res = await this.request('GET', `/v2/chains/{chainId}/orders${queryParams}`);

    const allOrders = res.data?.orders || res.data?.results || res.data || [];
    const orders = Array.isArray(allOrders) ? allOrders : [];

    // Filtrar por estado
    const filtered = status === 'ALL'
      ? orders
      : orders.filter(o => (o.status || o.state) === status);

    const normalized = filtered.map(o => this.normalizeOrder(o));

    return {
      orders: normalized,
      total: normalized.length,
      raw_total: orders.length
    };
  },

  /**
   * Detalle de un pedido específico
   */
  async get_order({ order_id } = {}) {
    if (!order_id) throw new Error('order_id es requerido');

    const res = await this.request('GET', `/v2/chains/{chainId}/orders/${order_id}`);
    return {
      order: this.normalizeOrder(res.data)
    };
  },

  /**
   * Aceptar un pedido
   * Requiere accepted_for (ISO timestamp de cuándo estará listo)
   */
  async accept_order({ order_id, preparation_minutes = 20 } = {}) {
    if (!order_id) throw new Error('order_id es requerido');

    const acceptedFor = new Date(Date.now() + preparation_minutes * 60 * 1000).toISOString();

    await this.request('PUT', `/v2/chains/{chainId}/orders/${order_id}`, {
      order_id,
      status: 'ACCEPTED',
      accepted_for: acceptedFor
    });

    return { accepted: true, order_id, accepted_for: acceptedFor };
  },

  /**
   * Rechazar/cancelar un pedido
   */
  async reject_order({ order_id, reason = 'STORE_CLOSED' } = {}) {
    if (!order_id) throw new Error('order_id es requerido');

    await this.request('PUT', `/v2/chains/{chainId}/orders/${order_id}`, {
      order_id,
      status: 'CANCELLED',
      cancel_reason: reason
    });

    return { rejected: true, order_id, reason };
  },

  /**
   * Marcar pedido como listo para recogida por rider
   */
  async mark_ready({ order_id } = {}) {
    if (!order_id) throw new Error('order_id es requerido');

    await this.request('PUT', `/v2/chains/{chainId}/orders/${order_id}`, {
      order_id,
      status: 'READY_FOR_PICKUP'
    });

    return { ready: true, order_id };
  },

  // ==========================================
  // Normalización
  // ==========================================

  /**
   * Normalizar pedido de Glovo al formato interno de PizzePOS
   */
  normalizeOrder(raw) {
    if (!raw) return null;

    return {
      glovo_order_id: raw.order_id || raw.orderId || raw.id,
      status: raw.status || raw.state || 'UNKNOWN',
      items: (raw.products || raw.items || []).map(p => ({
        nombre: p.name || p.nombre,
        cantidad: p.quantity || p.cantidad || 1,
        precio: p.price || p.precio || 0,
        notas: p.comments || p.notas || '',
        atributos: (p.attributes || p.modificadores || []).map(a => ({
          nombre: a.name || a.nombre,
          precio: a.price || a.precio || 0
        }))
      })),
      total: raw.total_price || raw.totalPrice || raw.total || 0,
      cliente_nombre: raw.customer?.name
        || raw.customerName
        || 'Cliente Glovo',
      direccion_entrega: raw.delivery_address?.label
        || raw.delivery_address?.raw_address
        || raw.deliveryAddress?.label
        || '',
      telefono_cliente: raw.customer?.phone || null,
      notas: raw.special_requirements || raw.customerComments || raw.comments || '',
      tiempo_estimado: raw.estimated_pickup_time
        || raw.estimated_delivery_time
        || raw.estimatedDeliveryTime
        || null,
      hora_creado: raw.creation_time || raw.creationTime || new Date().toISOString(),
      rider_info: raw.courier ? {
        nombre: raw.courier.name,
        telefono: raw.courier.phone
      } : null,
      _raw: raw
    };
  },

  /**
   * Cleanup — invalidar token
   */
  async cleanup() {
    this._token = null;
    this._tokenExpiresAt = 0;
  }
};
