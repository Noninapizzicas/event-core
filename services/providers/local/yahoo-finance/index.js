/**
 * Local Yahoo Finance Service
 *
 * Datos de mercados de valores via Yahoo Finance (sin API key).
 * Cotizaciones, históricos, búsqueda y noticias.
 *
 * Eventos:
 * - local.yahoo-finance.quote.request -> local.yahoo-finance.quote.response
 * - local.yahoo-finance.history.request -> local.yahoo-finance.history.response
 * - local.yahoo-finance.search.request -> local.yahoo-finance.search.response
 * - local.yahoo-finance.news.request -> local.yahoo-finance.news.response
 *
 * @version 1.0.0
 * @created 2026-02-05
 */

const https = require('https');

const BASE_URL = 'https://query1.finance.yahoo.com/v8/finance';
const SEARCH_URL = 'https://query2.finance.yahoo.com/v1/finance';

function yahooGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EventCore/1.0)',
        'Accept': 'application/json'
      },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Yahoo Finance ${res.statusCode}: ${data.substring(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = {
  name: 'local.yahoo-finance',
  description: 'Datos de mercados de valores via Yahoo Finance — cotizaciones, históricos, búsqueda',

  functions: {
    quote: {
      event: 'local.yahoo-finance.quote.request',
      description: 'Cotización actual de uno o varios símbolos',
      input: {
        symbols: { type: 'string', description: 'Símbolos separados por coma (AAPL,MSFT,GOOGL)', required: true }
      },
      output: {
        quotes: { type: 'array', description: 'Cotizaciones con precio, cambio, volumen' }
      }
    },
    history: {
      event: 'local.yahoo-finance.history.request',
      description: 'Histórico de precios de un símbolo',
      input: {
        symbol: { type: 'string', description: 'Símbolo (AAPL)', required: true },
        range: { type: 'string', description: 'Rango: 1d|5d|1mo|3mo|6mo|1y|5y|max (default: 1mo)', required: false },
        interval: { type: 'string', description: 'Intervalo: 1m|5m|15m|1d|1wk|1mo (default: 1d)', required: false }
      },
      output: {
        prices: { type: 'array', description: 'Array de {date, open, high, low, close, volume}' }
      }
    },
    search: {
      event: 'local.yahoo-finance.search.request',
      description: 'Busca símbolos/empresas por nombre',
      input: {
        query: { type: 'string', description: 'Texto a buscar (nombre o símbolo)', required: true }
      },
      output: {
        results: { type: 'array', description: 'Resultados con symbol, name, type, exchange' }
      }
    },
    news: {
      event: 'local.yahoo-finance.news.request',
      description: 'Noticias de un símbolo o del mercado',
      input: {
        symbol: { type: 'string', description: 'Símbolo (opcional, sin él devuelve noticias generales)', required: false }
      },
      output: {
        articles: { type: 'array', description: 'Noticias con title, link, publisher, date' }
      }
    }
  },

  async quote({ symbols }) {
    if (!symbols) return { success: false, error: 'symbols es requerido (ej: AAPL,MSFT)' };
    try {
      const data = await yahooGet(`${BASE_URL}/quote?symbols=${encodeURIComponent(symbols)}`);
      const results = data.quoteResponse?.result || [];
      const quotes = results.map(q => ({
        symbol: q.symbol,
        name: q.shortName || q.longName,
        price: q.regularMarketPrice,
        change: q.regularMarketChange,
        changePercent: q.regularMarketChangePercent,
        volume: q.regularMarketVolume,
        marketCap: q.marketCap,
        high: q.regularMarketDayHigh,
        low: q.regularMarketDayLow,
        open: q.regularMarketOpen,
        previousClose: q.regularMarketPreviousClose,
        exchange: q.exchange,
        currency: q.currency,
        marketState: q.marketState
      }));
      return { success: true, data: { quotes } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async history({ symbol, range = '1mo', interval = '1d' }) {
    if (!symbol) return { success: false, error: 'symbol es requerido' };
    try {
      const data = await yahooGet(`${BASE_URL}/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`);
      const result = data.chart?.result?.[0];
      if (!result) return { success: false, error: `No data for ${symbol}` };

      const timestamps = result.timestamp || [];
      const quote = result.indicators?.quote?.[0] || {};
      const prices = timestamps.map((ts, i) => ({
        date: new Date(ts * 1000).toISOString().split('T')[0],
        open: quote.open?.[i],
        high: quote.high?.[i],
        low: quote.low?.[i],
        close: quote.close?.[i],
        volume: quote.volume?.[i]
      })).filter(p => p.close !== null);

      return {
        success: true,
        data: {
          symbol,
          currency: result.meta?.currency,
          range, interval,
          prices,
          total: prices.length
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async search({ query }) {
    if (!query) return { success: false, error: 'query es requerido' };
    try {
      const data = await yahooGet(`${SEARCH_URL}/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`);
      const results = (data.quotes || []).map(q => ({
        symbol: q.symbol,
        name: q.shortname || q.longname,
        type: q.quoteType,
        exchange: q.exchange,
        sector: q.sector || null
      }));
      return { success: true, data: { results, query } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async news({ symbol } = {}) {
    try {
      const url = symbol
        ? `${BASE_URL}/quote?symbols=${encodeURIComponent(symbol)}&fields=shortName`
        : `${SEARCH_URL}/search?q=market&newsCount=20&quotesCount=0`;
      const data = await yahooGet(url);

      let articles = [];
      if (symbol && data.quoteResponse?.result?.[0]) {
        // Intentar obtener noticias desde quote (no siempre disponible)
        articles = [];
      }
      if (!symbol && data.news) {
        articles = data.news.map(n => ({
          title: n.title,
          link: n.link,
          publisher: n.publisher,
          date: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
          thumbnail: n.thumbnail?.resolutions?.[0]?.url || null
        }));
      }

      return { success: true, data: { articles, symbol: symbol || 'general', total: articles.length } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};
