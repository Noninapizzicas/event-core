/**
 * Local CoinGecko Service
 *
 * Datos de criptomonedas via CoinGecko API (gratis, sin key).
 * Precios, históricos, conversiones y tendencias.
 *
 * Eventos:
 * - local.coingecko.price.request -> local.coingecko.price.response
 * - local.coingecko.history.request -> local.coingecko.history.response
 * - local.coingecko.list.request -> local.coingecko.list.response
 * - local.coingecko.convert.request -> local.coingecko.convert.response
 * - local.coingecko.trending.request -> local.coingecko.trending.response
 *
 * @version 1.0.0
 * @created 2026-02-05
 */

const https = require('https');

const BASE_URL = 'https://api.coingecko.com/api/v3';

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${path}`;
    https.get(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'EventCore/1.0' },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`CoinGecko API ${res.statusCode}: ${data.substring(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = {
  name: 'local.coingecko',
  description: 'Datos de criptomonedas via CoinGecko API — precios, históricos, conversiones y tendencias',

  functions: {
    price: {
      event: 'local.coingecko.price.request',
      description: 'Precio actual de una o varias criptomonedas',
      input: {
        ids: { type: 'string', description: 'IDs separados por coma (bitcoin,ethereum,solana)', required: true },
        currencies: { type: 'string', description: 'Monedas fiat separadas por coma (default: usd,eur)', required: false }
      },
      output: {
        prices: { type: 'object', description: 'Precios por moneda' }
      }
    },
    history: {
      event: 'local.coingecko.history.request',
      description: 'Histórico de precios (1-365 días)',
      input: {
        id: { type: 'string', description: 'ID de la crypto (bitcoin, ethereum...)', required: true },
        days: { type: 'number', description: 'Días de histórico (default: 30)', required: false },
        currency: { type: 'string', description: 'Moneda fiat (default: usd)', required: false }
      },
      output: {
        prices: { type: 'array', description: 'Array de [timestamp, price]' }
      }
    },
    list: {
      event: 'local.coingecko.list.request',
      description: 'Top criptomonedas por market cap',
      input: {
        limit: { type: 'number', description: 'Cantidad (default: 20, max: 250)', required: false },
        currency: { type: 'string', description: 'Moneda fiat (default: usd)', required: false }
      },
      output: {
        coins: { type: 'array', description: 'Lista de monedas con precio, market_cap, cambio 24h' }
      }
    },
    convert: {
      event: 'local.coingecko.convert.request',
      description: 'Convierte entre crypto y fiat',
      input: {
        from: { type: 'string', description: 'ID crypto origen (bitcoin)', required: true },
        to: { type: 'string', description: 'Moneda destino (usd, eur, bitcoin)', required: true },
        amount: { type: 'number', description: 'Cantidad a convertir', required: true }
      },
      output: {
        result: { type: 'number', description: 'Resultado de la conversión' }
      }
    },
    trending: {
      event: 'local.coingecko.trending.request',
      description: 'Criptomonedas trending (más buscadas)',
      input: {},
      output: {
        coins: { type: 'array', description: 'Top trending coins' }
      }
    }
  },

  async price({ ids, currencies = 'usd,eur' }) {
    if (!ids) return { success: false, error: 'ids es requerido (ej: bitcoin,ethereum)' };
    try {
      const data = await apiGet(`/simple/price?ids=${ids}&vs_currencies=${currencies}&include_24hr_change=true&include_market_cap=true`);
      return { success: true, data: { prices: data } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async history({ id, days = 30, currency = 'usd' }) {
    if (!id) return { success: false, error: 'id es requerido (ej: bitcoin)' };
    try {
      const data = await apiGet(`/coins/${id}/market_chart?vs_currency=${currency}&days=${days}`);
      return {
        success: true,
        data: {
          prices: data.prices,
          market_caps: data.market_caps,
          volumes: data.total_volumes,
          id, days, currency
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async list({ limit = 20, currency = 'usd' } = {}) {
    const perPage = Math.min(limit, 250);
    try {
      const data = await apiGet(`/coins/markets?vs_currency=${currency}&order=market_cap_desc&per_page=${perPage}&page=1&sparkline=false`);
      const coins = data.map(c => ({
        id: c.id,
        symbol: c.symbol,
        name: c.name,
        price: c.current_price,
        market_cap: c.market_cap,
        rank: c.market_cap_rank,
        change_24h: c.price_change_percentage_24h,
        volume_24h: c.total_volume,
        high_24h: c.high_24h,
        low_24h: c.low_24h
      }));
      return { success: true, data: { coins, currency, total: coins.length } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async convert({ from, to, amount }) {
    if (!from || !to || amount === undefined) {
      return { success: false, error: 'from, to y amount son requeridos' };
    }
    try {
      const data = await apiGet(`/simple/price?ids=${from}&vs_currencies=${to}`);
      const rate = data[from]?.[to];
      if (rate === undefined) {
        return { success: false, error: `No se pudo obtener tasa ${from} → ${to}` };
      }
      return {
        success: true,
        data: { from, to, amount, rate, result: amount * rate }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async trending() {
    try {
      const data = await apiGet('/search/trending');
      const coins = (data.coins || []).map(c => ({
        id: c.item.id,
        symbol: c.item.symbol,
        name: c.item.name,
        rank: c.item.market_cap_rank,
        score: c.item.score
      }));
      return { success: true, data: { coins } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};
