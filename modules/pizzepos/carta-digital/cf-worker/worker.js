/**
 * Cloudflare Worker — AI Chat Proxy for Carta Digital
 *
 * Receives chat messages from the PWA, enforces system prompt
 * server-side, forwards to DeepSeek, returns response.
 *
 * Supports streaming (SSE) and non-streaming modes.
 * PWA sends `stream: true` in body to get SSE response.
 *
 * The PWA never sees the API key. The system prompt cannot be
 * overridden by the client.
 *
 * Environment variables (set via wrangler secret):
 *   DEEPSEEK_API_KEY  — Your DeepSeek API key
 *   SYSTEM_PROMPT     — The full system prompt with menu data
 *   ALLOWED_ORIGIN    — e.g. "https://noninapizzicas.github.io" (optional, * if not set)
 *   MAX_TOKENS        — Max response tokens (default 300)
 */

const DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';
const MAX_HISTORY = 20;

// Simple in-memory rate limiter (per-worker-instance, resets on cold start)
const rateMap = new Map();
const RATE_LIMIT = 12;       // requests per minute per IP
const RATE_WINDOW = 60_000;  // 1 minute

function checkRate(ip) {
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW) {
    entry = { start: now, count: 0 };
    rateMap.set(ip, entry);
  }
  entry.count++;
  // Cleanup old entries every 100 checks
  if (rateMap.size > 500) {
    for (const [k, v] of rateMap) {
      if (now - v.start > RATE_WINDOW) rateMap.delete(k);
    }
  }
  return entry.count <= RATE_LIMIT;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = env.ALLOWED_ORIGIN || '*';

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin === '*' ? '*' : origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Only accept POST to /chat
    const url = new URL(request.url);
    if (request.method !== 'POST' || !url.pathname.endsWith('/chat')) {
      return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
    }

    // Origin check (if configured)
    if (allowedOrigin !== '*' && !allowedOrigin.split(',').some(o => origin === o.trim())) {
      return jsonResponse({ error: 'Origin not allowed' }, 403, corsHeaders);
    }

    // Rate limiting
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRate(clientIP)) {
      return jsonResponse({
        error: 'Rate limited',
        message: 'Demasiadas peticiones. Espera un momento.'
      }, 429, corsHeaders);
    }

    // Validate env
    if (!env.DEEPSEEK_API_KEY) {
      return jsonResponse({ error: 'Server misconfigured: missing API key' }, 500, corsHeaders);
    }
    if (!env.SYSTEM_PROMPT) {
      return jsonResponse({ error: 'Server misconfigured: missing system prompt' }, 500, corsHeaders);
    }

    // Parse request
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400, corsHeaders);
    }

    const clientMessages = body.messages || [];
    const wantStream = body.stream === true;

    // SECURITY: Strip any system messages from client input
    const userMessages = clientMessages
      .filter(m => m.role !== 'system')
      .slice(-MAX_HISTORY)
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 2000) }));

    if (userMessages.length === 0) {
      return jsonResponse({ error: 'No messages provided' }, 400, corsHeaders);
    }

    // Build final messages with server-enforced system prompt
    const maxTokens = parseInt(env.MAX_TOKENS) || 300;
    const messages = [
      { role: 'system', content: env.SYSTEM_PROMPT },
      ...userMessages
    ];

    // Call DeepSeek
    let dsResponse;
    try {
      dsResponse = await fetch(DEEPSEEK_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          messages,
          max_tokens: maxTokens,
          temperature: 0.7,
          stream: wantStream,
        })
      });
    } catch (err) {
      return jsonResponse({
        error: 'Provider unavailable',
        message: 'No puedo conectar con el servicio de IA ahora.'
      }, 502, corsHeaders);
    }

    if (!dsResponse.ok) {
      const errText = await dsResponse.text().catch(() => 'unknown');
      return jsonResponse({
        error: 'Provider error',
        status: dsResponse.status,
        message: 'Error del proveedor de IA.'
      }, 502, corsHeaders);
    }

    // Streaming mode: pipe SSE from DeepSeek to client
    if (wantStream) {
      return new Response(dsResponse.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...corsHeaders
        }
      });
    }

    // Non-streaming mode: same as before
    const dsData = await dsResponse.json();

    const choice = dsData.choices?.[0];
    const content = choice?.message?.content || 'Lo siento, no he podido responder.';
    const usage = dsData.usage || {};

    return jsonResponse({
      status: 200,
      data: {
        content,
        model: dsData.model || DEFAULT_MODEL,
        provider: 'deepseek',
        usage: {
          prompt_tokens: usage.prompt_tokens || 0,
          completion_tokens: usage.completion_tokens || 0,
          total_tokens: usage.total_tokens || 0
        }
      }
    }, 200, corsHeaders);
  }
};

function jsonResponse(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
}
