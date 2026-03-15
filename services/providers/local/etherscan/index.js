/**
 * Local Etherscan Service
 *
 * Integración con Etherscan API para consultas de blockchain Ethereum.
 * Consulta balances, transacciones y precios de gas.
 * Requiere ETHERSCAN_API_KEY (gratis en etherscan.io).
 *
 * Eventos:
 * - local.etherscan.balance.request -> local.etherscan.balance.response
 * - local.etherscan.transactions.request -> local.etherscan.transactions.response
 * - local.etherscan.gas.request -> local.etherscan.gas.response
 *
 * @version 1.0.0
 * @created 2026-02-05
 */

const https = require('https');

function etherscanApi(params, apiKey) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ ...params, apikey: apiKey }).toString();
    const options = {
      hostname: 'api.etherscan.io',
      path: `/api?${qs}`,
      method: 'GET',
      headers: { 'User-Agent': 'EventCore/1.0' },
      timeout: 15000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.status === '0' && parsed.message !== 'No transactions found') {
            return reject(new Error(`Etherscan: ${parsed.result || parsed.message}`));
          }
          resolve(parsed);
        } catch (e) { reject(new Error('JSON parse error')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function getKey(credentials) {
  return credentials?.ETHERSCAN_API_KEY || process.env.ETHERSCAN_API_KEY;
}

function weiToEth(wei) {
  const eth = parseFloat(wei) / 1e18;
  return eth.toFixed(6);
}

function isValidAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

module.exports = {
  name: 'local.etherscan',
  description: 'Consultas blockchain Ethereum via Etherscan — balances, transacciones, gas',

  functions: {
    balance: {
      event: 'local.etherscan.balance.request',
      description: 'Consulta el balance ETH de una dirección',
      input: {
        address: { type: 'string', description: 'Dirección Ethereum (0x...)', required: true },
        tag: { type: 'string', description: 'latest, earliest, pending (default: latest)', required: false }
      },
      output: {
        address: { type: 'string', description: 'Dirección consultada' },
        balance_wei: { type: 'string', description: 'Balance en Wei' },
        balance_eth: { type: 'string', description: 'Balance en ETH' }
      }
    },
    transactions: {
      event: 'local.etherscan.transactions.request',
      description: 'Lista transacciones de una dirección',
      input: {
        address: { type: 'string', description: 'Dirección Ethereum', required: true },
        page: { type: 'number', description: 'Página (default: 1)', required: false },
        offset: { type: 'number', description: 'Resultados por página (default: 10)', required: false },
        sort: { type: 'string', description: 'asc o desc (default: desc)', required: false },
        startblock: { type: 'number', description: 'Bloque inicial (default: 0)', required: false },
        endblock: { type: 'number', description: 'Bloque final (default: 99999999)', required: false }
      },
      output: {
        transactions: { type: 'array', description: 'Lista de transacciones' },
        total: { type: 'number', description: 'Total devuelto' }
      }
    },
    gas: {
      event: 'local.etherscan.gas.request',
      description: 'Consulta precios actuales de gas en la red Ethereum',
      input: {},
      output: {
        low: { type: 'string', description: 'Gas price bajo (Gwei)' },
        average: { type: 'string', description: 'Gas price medio (Gwei)' },
        high: { type: 'string', description: 'Gas price alto (Gwei)' }
      }
    }
  },

  async balance({ address, tag = 'latest', _credentials }) {
    if (!address) return { success: false, error: 'address es requerido' };
    if (!isValidAddress(address)) return { success: false, error: 'Dirección Ethereum inválida (debe ser 0x + 40 hex chars)' };
    const key = getKey(_credentials);
    if (!key) return { success: false, error: 'ETHERSCAN_API_KEY requerido' };

    try {
      const data = await etherscanApi({
        module: 'account',
        action: 'balance',
        address,
        tag
      }, key);

      return {
        success: true,
        data: {
          address,
          balance_wei: data.result,
          balance_eth: weiToEth(data.result)
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async transactions({ address, page = 1, offset = 10, sort = 'desc', startblock = 0, endblock = 99999999, _credentials }) {
    if (!address) return { success: false, error: 'address es requerido' };
    if (!isValidAddress(address)) return { success: false, error: 'Dirección Ethereum inválida' };
    const key = getKey(_credentials);
    if (!key) return { success: false, error: 'ETHERSCAN_API_KEY requerido' };

    try {
      const data = await etherscanApi({
        module: 'account',
        action: 'txlist',
        address,
        startblock,
        endblock,
        page,
        offset,
        sort
      }, key);

      const txs = (Array.isArray(data.result) ? data.result : []).map(tx => ({
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        value_eth: weiToEth(tx.value),
        gas_used: tx.gasUsed,
        gas_price_gwei: (parseFloat(tx.gasPrice) / 1e9).toFixed(2),
        status: tx.isError === '0' ? 'success' : 'failed',
        block: parseInt(tx.blockNumber, 10),
        timestamp: new Date(parseInt(tx.timeStamp, 10) * 1000).toISOString(),
        method: tx.functionName ? tx.functionName.split('(')[0] : 'transfer'
      }));

      return {
        success: true,
        data: { transactions: txs, total: txs.length, address }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async gas({ _credentials } = {}) {
    const key = getKey(_credentials);
    if (!key) return { success: false, error: 'ETHERSCAN_API_KEY requerido' };

    try {
      const data = await etherscanApi({
        module: 'gastracker',
        action: 'gasoracle'
      }, key);

      const result = data.result || {};
      return {
        success: true,
        data: {
          low: `${result.SafeGasPrice || '?'} Gwei`,
          average: `${result.ProposeGasPrice || '?'} Gwei`,
          high: `${result.FastGasPrice || '?'} Gwei`,
          baseFee: result.suggestBaseFee ? `${parseFloat(result.suggestBaseFee).toFixed(2)} Gwei` : undefined,
          lastBlock: result.LastBlock || undefined
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};
