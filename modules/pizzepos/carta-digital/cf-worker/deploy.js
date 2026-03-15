#!/usr/bin/env node
/**
 * Deploy script for Cloudflare Worker — AI Chat Proxy
 *
 * Reads credentials from event-core's .env (credential-manager)
 * and deploys the worker with all secrets configured automatically.
 *
 * Uso:
 *   node deploy.js
 *   node deploy.js --carta ../../storage/pizzepos/cartas/carta_pizzicas.json
 *   node deploy.js --origin https://noninapizzicas.github.io
 *   node deploy.js --nombre Pizzicas
 *   node deploy.js --max-tokens 300
 *   node deploy.js --dry-run          (solo muestra lo que haría, no despliega)
 *
 * Requisitos:
 *   - wrangler instalado (npm install -g wrangler)
 *   - CLOUDFLARE_API_TOKEN en .env o como variable de entorno
 *   - DEEPSEEK_API_KEY_GLOBAL en .env (gestionado por credential-manager)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── Parse args ───
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf('--' + name);
  if (idx === -1 || idx + 1 >= args.length) return defaultVal;
  return args[idx + 1];
}
const dryRun = args.includes('--dry-run');

// ─── Paths ───
const workerDir = __dirname;
const rootDir = path.resolve(workerDir, '..', '..', '..', '..');
const envPath = path.join(rootDir, '.env');

// ─── Banner ───
console.log('');
console.log('  ╔════════════════════════════════════════════╗');
console.log('  ║   CF Worker Deploy — Chat IA Carta Digital  ║');
console.log('  ╚════════════════════════════════════════════╝');
console.log('');

// ─── Load .env ───
function loadEnv(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Remove quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const envVars = loadEnv(envPath);

// ─── Resolve DeepSeek API Key (cascade like credential-manager) ───
const deepseekKey =
  envVars.DEEPSEEK_API_KEY_CUSTOM ||
  envVars.DEEPSEEK_API_KEY_CLIENT ||
  envVars.DEEPSEEK_API_KEY_PROJECT ||
  envVars.DEEPSEEK_API_KEY_GLOBAL ||
  envVars.DEEPSEEK_API_KEY ||
  process.env.DEEPSEEK_API_KEY_GLOBAL ||
  process.env.DEEPSEEK_API_KEY ||
  '';

if (!deepseekKey) {
  console.error('  ERROR: No se encontró DEEPSEEK_API_KEY en .env');
  console.error(`  Ruta .env: ${envPath}`);
  console.error('');
  console.error('  Configúrala desde la UI del credential-manager o añade a .env:');
  console.error('    DEEPSEEK_API_KEY_GLOBAL=sk-tu-key-aqui');
  process.exit(1);
}
console.log(`  DeepSeek key: ...${deepseekKey.slice(-4)} (de ${envPath})`);

// ─── Cloudflare token ───
const cfToken =
  envVars.CLOUDFLARE_API_TOKEN ||
  process.env.CLOUDFLARE_API_TOKEN ||
  '';

if (!cfToken) {
  console.error('  ERROR: No se encontró CLOUDFLARE_API_TOKEN');
  console.error('');
  console.error('  Pasos para obtenerlo:');
  console.error('  1. Ve a https://dash.cloudflare.com/profile/api-tokens');
  console.error('  2. "Create Token" → plantilla "Edit Cloudflare Workers"');
  console.error('  3. Copia el token y añádelo a .env:');
  console.error('     CLOUDFLARE_API_TOKEN=tu-token-aqui');
  process.exit(1);
}
console.log(`  CF Token:     ...${cfToken.slice(-4)}`);

// ─── Build system prompt from carta ───
const nombre = getArg('nombre', 'Pizzicas');
const moneda = getArg('moneda', '€');
const cartaPath = path.resolve(rootDir, getArg('carta', 'storage/pizzepos/cartas/carta_pizzicas.json'));

let systemPrompt = '';
try {
  const carta = JSON.parse(fs.readFileSync(cartaPath, 'utf8'));
  const productos = carta.productos || [];
  const menuResumen = productos.map(p => {
    const ings = (p.ingredientes || []).map(i => i.nombre).join(', ');
    const tags = (p.tags || []).join(', ');
    return `- ${p.nombre}: ${p.precio.toFixed(2)}${moneda}${ings ? ' (' + ings + ')' : ''}${tags ? ' [' + tags + ']' : ''}`;
  }).join('\n');

  systemPrompt =
    `Eres el asistente virtual de ${nombre}. Ayudas a los clientes a elegir y hacer su pedido.\n\n` +
    `REGLAS:\n` +
    `- Responde SIEMPRE en español, breve y amable (max 2-3 frases)\n` +
    `- Recomienda platos segun preferencias del cliente\n` +
    `- Si el cliente quiere pedir, confirma los items y cantidades\n` +
    `- Cuando el pedido este listo, responde con un JSON al final: {"pedido":[{"id":"ID","nombre":"NOMBRE","qty":N}]}\n` +
    `- Si no sabes algo, di que el cliente puede contactar por WhatsApp\n` +
    `- NO inventes productos que no estan en el menu\n\n` +
    `MENU DE ${nombre.toUpperCase()}:\n${menuResumen}`;

  console.log(`  Carta:        ${cartaPath}`);
  console.log(`  Productos:    ${productos.length}`);
  console.log(`  Prompt:       ${systemPrompt.length} chars`);
} catch (err) {
  console.error(`  ERROR: No se pudo leer la carta: ${cartaPath}`);
  console.error(`  ${err.message}`);
  process.exit(1);
}

// ─── Allowed origin ───
const origin = getArg('origin', '*');
const maxTokens = getArg('max-tokens', '300');

console.log(`  Origin:       ${origin}`);
console.log(`  Max tokens:   ${maxTokens}`);
console.log('');

// ─── Deploy ───
function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  if (dryRun) { console.log('    (dry-run, saltando)'); return ''; }
  return execSync(cmd, {
    cwd: workerDir,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: cfToken },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts
  });
}

function putSecret(name, value) {
  console.log(`  $ wrangler secret put ${name} (${value.length} chars)`);
  if (dryRun) { console.log('    (dry-run, saltando)'); return; }
  execSync(`wrangler secret put ${name}`, {
    cwd: workerDir,
    input: value,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: cfToken },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  console.log(`    ✓ ${name} configurado`);
}

try {
  // Step 1: Deploy worker code
  console.log('  ─── Paso 1: Deploy del Worker ───');
  const deployOutput = run('wrangler deploy');
  if (deployOutput) console.log('  ' + deployOutput.trim().split('\n').join('\n  '));

  // Step 2: Set secrets
  console.log('');
  console.log('  ─── Paso 2: Configurar secretos ───');
  putSecret('DEEPSEEK_API_KEY', deepseekKey);
  putSecret('SYSTEM_PROMPT', systemPrompt);

  // Step 3: Set vars (non-secret)
  console.log('');
  console.log('  ─── Paso 3: Variables de entorno ───');
  // Update wrangler.toml with vars before redeploy
  const tomlPath = path.join(workerDir, 'wrangler.toml');
  let toml = fs.readFileSync(tomlPath, 'utf8');
  // Remove old [vars] section if any
  toml = toml.replace(/\[vars\][\s\S]*?(?=\n\[|$)/, '');
  // Add new [vars]
  toml = toml.trim() + '\n\n[vars]\n';
  toml += `ALLOWED_ORIGIN = "${origin}"\n`;
  toml += `MAX_TOKENS = "${maxTokens}"\n`;
  if (!dryRun) {
    fs.writeFileSync(tomlPath, toml, 'utf8');
    console.log('    ✓ wrangler.toml actualizado');
    // Redeploy with vars
    run('wrangler deploy');
  } else {
    console.log('    (dry-run) wrangler.toml quedaría:');
    console.log('    ' + toml.trim().split('\n').join('\n    '));
  }

  // Done
  console.log('');
  console.log('  ═══════════════════════════════════════════');
  console.log('  ✓ DEPLOY COMPLETO');
  console.log('  ═══════════════════════════════════════════');
  console.log('');
  console.log('  Tu Worker está en:');
  console.log('    https://pizzicas-chat.<tu-usuario>.workers.dev');
  console.log('');
  console.log('  Para la PWA, usa esta config:');
  console.log('    ai_endpoint: "https://pizzicas-chat.<tu-usuario>.workers.dev"');
  console.log('    ai_chat_path: "/chat"');
  console.log('');
  console.log('  Para verificar:');
  console.log('    curl -X POST https://pizzicas-chat.<tu-usuario>.workers.dev/chat \\');
  console.log('      -H "Content-Type: application/json" \\');
  console.log('      -d \'{"messages":[{"role":"user","content":"Hola, qué pizzas tenéis?"}]}\'');
  console.log('');
} catch (err) {
  console.error('');
  console.error('  ERROR durante deploy:');
  console.error('  ' + (err.stderr || err.message || err));
  console.error('');
  if (err.message && err.message.includes('wrangler')) {
    console.error('  ¿Tienes wrangler instalado?');
    console.error('    sudo npm install -g wrangler');
  }
  process.exit(1);
}
