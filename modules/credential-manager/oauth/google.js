/**
 * Google OAuth2 Provider
 * Lógica pura para OAuth2 de Google (Gmail, Drive, Calendar, etc.)
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Scopes predefinidos por servicio
const SCOPES = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify'
  ],
  drive: [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive.readonly'
  ],
  calendar: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.readonly'
  ],
  sheets: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/spreadsheets.readonly'
  ],
  // Google Cloud Platform - Document AI, Vision, Speech, etc.
  cloud: [
    'https://www.googleapis.com/auth/cloud-platform'
  ]
};

/**
 * Genera URL de autorización OAuth2
 * @param {Object} params
 * @param {string} params.clientId - OAuth Client ID
 * @param {string} params.redirectUri - URI de callback
 * @param {string} params.state - Estado para validar callback (JSON stringified)
 * @param {string[]} params.scopes - Scopes a solicitar (default: gmail)
 * @returns {string} URL de autorización
 */
function getAuthUrl({ clientId, redirectUri, state, scopes = ['gmail'] }) {
  // Resolver scopes
  const resolvedScopes = scopes.flatMap(s => SCOPES[s] || [s]);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: resolvedScopes.join(' '),
    access_type: 'offline',
    prompt: 'consent', // Forzar para obtener refresh_token
    state: typeof state === 'string' ? state : JSON.stringify(state)
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Intercambia código de autorización por tokens
 * @param {Object} params
 * @param {string} params.code - Código de autorización
 * @param {string} params.clientId - OAuth Client ID
 * @param {string} params.clientSecret - OAuth Client Secret
 * @param {string} params.redirectUri - URI de callback (debe coincidir)
 * @returns {Promise<Object>} { access_token, refresh_token, expires_in, scope, token_type }
 */
async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(`OAuth error: ${data.error} - ${data.error_description}`);
  }

  return data;
}

/**
 * Refresh access token usando refresh_token
 * @param {Object} params
 * @param {string} params.refreshToken - Refresh token
 * @param {string} params.clientId - OAuth Client ID
 * @param {string} params.clientSecret - OAuth Client Secret
 * @returns {Promise<Object>} { access_token, expires_in, scope, token_type }
 */
async function refreshAccessToken({ refreshToken, clientId, clientSecret }) {
  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token'
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(`Token refresh error: ${data.error} - ${data.error_description}`);
  }

  return data;
}

/**
 * Valida un refresh_token intentando obtener un access_token
 * @param {Object} params
 * @param {string} params.refreshToken - Refresh token a validar
 * @param {string} params.clientId - OAuth Client ID
 * @param {string} params.clientSecret - OAuth Client Secret
 * @returns {Promise<boolean>} true si el token es válido
 */
async function validateRefreshToken({ refreshToken, clientId, clientSecret }) {
  try {
    const result = await refreshAccessToken({ refreshToken, clientId, clientSecret });
    return !!result.access_token;
  } catch {
    return false;
  }
}

/**
 * Parsea el state del callback
 * @param {string} state - State string del callback
 * @returns {Object} State parseado
 */
function parseState(state) {
  try {
    return JSON.parse(state);
  } catch {
    return { raw: state };
  }
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  refreshAccessToken,
  validateRefreshToken,
  parseState,
  SCOPES
};
