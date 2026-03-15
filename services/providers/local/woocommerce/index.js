/**
 * Local WooCommerce Service
 *
 * Integración con WooCommerce REST API v3.
 * Gestiona productos, pedidos, stock y estadísticas de la tienda.
 * Requiere WOOCOMMERCE_URL, WOOCOMMERCE_KEY y WOOCOMMERCE_SECRET.
 *
 * Eventos:
 * - local.woocommerce.create-product.request -> local.woocommerce.create-product.response
 * - local.woocommerce.list-products.request -> local.woocommerce.list-products.response
 * - local.woocommerce.update-stock.request -> local.woocommerce.update-stock.response
 * - local.woocommerce.orders.request -> local.woocommerce.orders.response
 * - local.woocommerce.stats.request -> local.woocommerce.stats.response
 *
 * @version 1.0.0
 * @created 2026-02-05
 */

const https = require('https');
const http = require('http');

function wooApi(method, storeUrl, path, key, secret, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/wp-json/wc/v3${path}`, storeUrl);
    url.searchParams.set('consumer_key', key);
    url.searchParams.set('consumer_secret', secret);

    const mod = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'EventCore/1.0'
      },
      timeout: 15000
    };

    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const msg = parsed.message || data.substring(0, 200);
            return reject(new Error(`WooCommerce ${res.statusCode}: ${msg}`));
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
    url: credentials?.WOOCOMMERCE_URL || process.env.WOOCOMMERCE_URL,
    key: credentials?.WOOCOMMERCE_KEY || process.env.WOOCOMMERCE_KEY,
    secret: credentials?.WOOCOMMERCE_SECRET || process.env.WOOCOMMERCE_SECRET
  };
}

module.exports = {
  name: 'local.woocommerce',
  description: 'Integración con WooCommerce REST API — productos, pedidos, stock, estadísticas',

  functions: {
    'create-product': {
      event: 'local.woocommerce.create-product.request',
      description: 'Crea un producto en WooCommerce',
      input: {
        name: { type: 'string', description: 'Nombre del producto', required: true },
        regular_price: { type: 'string', description: 'Precio regular (ej: "12.50")', required: true },
        description: { type: 'string', description: 'Descripción HTML del producto', required: false },
        short_description: { type: 'string', description: 'Descripción corta', required: false },
        categories: { type: 'array', description: 'Array de { id: number }', required: false },
        images: { type: 'array', description: 'Array de { src: url }', required: false },
        sku: { type: 'string', description: 'SKU del producto', required: false },
        stock_quantity: { type: 'number', description: 'Cantidad en stock', required: false }
      },
      output: {
        productId: { type: 'number', description: 'ID del producto creado' },
        permalink: { type: 'string', description: 'URL del producto' }
      }
    },
    'list-products': {
      event: 'local.woocommerce.list-products.request',
      description: 'Lista productos de la tienda',
      input: {
        per_page: { type: 'number', description: 'Resultados por página (default: 10)', required: false },
        category: { type: 'number', description: 'Filtrar por categoría ID', required: false },
        search: { type: 'string', description: 'Buscar por nombre', required: false },
        status: { type: 'string', description: 'Estado: publish, draft, pending', required: false }
      },
      output: {
        products: { type: 'array', description: 'Lista de productos' },
        total: { type: 'number', description: 'Total devuelto' }
      }
    },
    'update-stock': {
      event: 'local.woocommerce.update-stock.request',
      description: 'Actualiza stock de un producto',
      input: {
        productId: { type: 'number', description: 'ID del producto', required: true },
        stock_quantity: { type: 'number', description: 'Nueva cantidad', required: true },
        manage_stock: { type: 'boolean', description: 'Activar gestión de stock (default: true)', required: false }
      },
      output: {
        productId: { type: 'number', description: 'ID del producto' },
        stock_quantity: { type: 'number', description: 'Stock actualizado' }
      }
    },
    orders: {
      event: 'local.woocommerce.orders.request',
      description: 'Lista pedidos de la tienda',
      input: {
        per_page: { type: 'number', description: 'Resultados por página (default: 10)', required: false },
        status: { type: 'string', description: 'Estado: pending, processing, completed, etc.', required: false },
        after: { type: 'string', description: 'Pedidos después de esta fecha ISO', required: false }
      },
      output: {
        orders: { type: 'array', description: 'Lista de pedidos' },
        total: { type: 'number', description: 'Total devuelto' }
      }
    },
    stats: {
      event: 'local.woocommerce.stats.request',
      description: 'Estadísticas de ventas de la tienda',
      input: {
        period: { type: 'string', description: 'Período: week, month, year (default: month)', required: false }
      },
      output: {
        total_sales: { type: 'string', description: 'Ventas totales' },
        total_orders: { type: 'number', description: 'Pedidos totales' },
        total_customers: { type: 'number', description: 'Clientes nuevos' }
      }
    }
  },

  async 'create-product'({ name, regular_price, description, short_description, categories, images, sku, stock_quantity, _credentials }) {
    if (!name || !regular_price) return { success: false, error: 'name y regular_price son requeridos' };
    const cfg = getConfig(_credentials);
    if (!cfg.url || !cfg.key || !cfg.secret) return { success: false, error: 'WOOCOMMERCE_URL, WOOCOMMERCE_KEY y WOOCOMMERCE_SECRET requeridos' };

    try {
      const product = { name, regular_price, type: 'simple' };
      if (description) product.description = description;
      if (short_description) product.short_description = short_description;
      if (categories) product.categories = categories;
      if (images) product.images = images;
      if (sku) product.sku = sku;
      if (stock_quantity != null) {
        product.manage_stock = true;
        product.stock_quantity = stock_quantity;
      }

      const data = await wooApi('POST', cfg.url, '/products', cfg.key, cfg.secret, product);
      return {
        success: true,
        data: {
          productId: data.id,
          name: data.name,
          permalink: data.permalink,
          price: data.regular_price,
          status: data.status
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async 'list-products'({ per_page = 10, category, search, status, _credentials } = {}) {
    const cfg = getConfig(_credentials);
    if (!cfg.url || !cfg.key || !cfg.secret) return { success: false, error: 'WOOCOMMERCE_URL, WOOCOMMERCE_KEY y WOOCOMMERCE_SECRET requeridos' };

    try {
      let path = `/products?per_page=${per_page}`;
      if (category) path += `&category=${category}`;
      if (search) path += `&search=${encodeURIComponent(search)}`;
      if (status) path += `&status=${status}`;

      const data = await wooApi('GET', cfg.url, path, cfg.key, cfg.secret);
      const products = (Array.isArray(data) ? data : []).map(p => ({
        id: p.id,
        name: p.name,
        price: p.regular_price,
        sale_price: p.sale_price || null,
        status: p.status,
        stock_quantity: p.stock_quantity,
        sku: p.sku,
        permalink: p.permalink
      }));
      return { success: true, data: { products, total: products.length } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async 'update-stock'({ productId, stock_quantity, manage_stock = true, _credentials }) {
    if (!productId || stock_quantity == null) return { success: false, error: 'productId y stock_quantity son requeridos' };
    const cfg = getConfig(_credentials);
    if (!cfg.url || !cfg.key || !cfg.secret) return { success: false, error: 'WOOCOMMERCE_URL, WOOCOMMERCE_KEY y WOOCOMMERCE_SECRET requeridos' };

    try {
      const data = await wooApi('PUT', cfg.url, `/products/${productId}`, cfg.key, cfg.secret, {
        manage_stock,
        stock_quantity
      });
      return {
        success: true,
        data: {
          productId: data.id,
          name: data.name,
          stock_quantity: data.stock_quantity,
          in_stock: data.in_stock
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async orders({ per_page = 10, status, after, _credentials } = {}) {
    const cfg = getConfig(_credentials);
    if (!cfg.url || !cfg.key || !cfg.secret) return { success: false, error: 'WOOCOMMERCE_URL, WOOCOMMERCE_KEY y WOOCOMMERCE_SECRET requeridos' };

    try {
      let path = `/orders?per_page=${per_page}`;
      if (status) path += `&status=${status}`;
      if (after) path += `&after=${after}`;

      const data = await wooApi('GET', cfg.url, path, cfg.key, cfg.secret);
      const orders = (Array.isArray(data) ? data : []).map(o => ({
        id: o.id,
        number: o.number,
        status: o.status,
        total: o.total,
        currency: o.currency,
        customer: o.billing?.first_name ? `${o.billing.first_name} ${o.billing.last_name}` : null,
        email: o.billing?.email,
        items: (o.line_items || []).length,
        date: o.date_created
      }));
      return { success: true, data: { orders, total: orders.length } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async stats({ period = 'month', _credentials } = {}) {
    const cfg = getConfig(_credentials);
    if (!cfg.url || !cfg.key || !cfg.secret) return { success: false, error: 'WOOCOMMERCE_URL, WOOCOMMERCE_KEY y WOOCOMMERCE_SECRET requeridos' };

    try {
      const data = await wooApi('GET', cfg.url, `/reports/sales?period=${period}`, cfg.key, cfg.secret);
      const report = Array.isArray(data) ? data[0] : data;
      return {
        success: true,
        data: {
          period,
          total_sales: report?.total_sales || '0',
          total_orders: report?.total_orders || 0,
          total_items: report?.total_items || 0,
          total_customers: report?.total_customers || 0,
          total_discount: report?.total_discount || '0',
          total_shipping: report?.total_shipping || '0'
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};
