#!/usr/bin/env node
/**
 * CLI para exportar carta digital estática
 *
 * Uso:
 *   node modules/pizzepos/carta-digital/export-cli.js
 *   node modules/pizzepos/carta-digital/export-cli.js --carta storage/pizzepos/cartas/carta_pizzicas.json
 *   node modules/pizzepos/carta-digital/export-cli.js --output ./mi-carta-web
 *   node modules/pizzepos/carta-digital/export-cli.js --whatsapp 34612345678
 *
 * Opciones:
 *   --carta     Ruta al JSON de la carta (default: storage/pizzepos/cartas/carta_pizzicas.json)
 *   --output    Directorio de salida (default: ./carta-static-output)
 *   --whatsapp  Número de WhatsApp con código de país (ej: 34612345678)
 *   --nombre    Nombre del negocio (default: Pizzicas)
 *   --moneda    Símbolo de moneda (default: €)
 *   --color     Color primario hex (default: #f59e0b)
 */

const fs = require('fs');
const path = require('path');
const { generateStaticHTML, generateServiceWorker, generateManifest, generateIcon, slugify } = require('./static-template');

// Parse args
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf('--' + name);
  if (idx === -1 || idx + 1 >= args.length) return defaultVal;
  return args[idx + 1];
}

const rootDir = path.resolve(__dirname, '..', '..', '..');
const cartaPath = path.resolve(rootDir, getArg('carta', 'storage/pizzepos/cartas/carta_pizzicas.json'));
const outputDir = path.resolve(getArg('output', path.join(rootDir, 'carta-static-output')));
const whatsapp = getArg('whatsapp', '');
const nombre = getArg('nombre', 'Pizzicas');
const moneda = getArg('moneda', '€');
const colorPrimario = getArg('color', '#f59e0b');

// Banner
console.log('');
console.log('  ╔═══════════════════════════════════════╗');
console.log('  ║   Carta Digital — Export Estático      ║');
console.log('  ╚═══════════════════════════════════════╝');
console.log('');

// Read carta
let carta;
try {
  const raw = fs.readFileSync(cartaPath, 'utf8');
  carta = JSON.parse(raw);
  console.log(`  Carta:     ${cartaPath}`);
  console.log(`  Productos: ${carta.productos.length}`);
  console.log(`  Categorias: ${carta.categorias.length}`);
} catch (err) {
  console.error(`  ERROR: No se pudo leer la carta en ${cartaPath}`);
  console.error(`  ${err.message}`);
  console.error('');
  console.error('  Usa --carta para especificar la ruta al JSON de la carta');
  process.exit(1);
}

// Build config
const config = {
  nombre_negocio: nombre,
  moneda,
  whatsapp_telefono: whatsapp,
  mensaje_header: '¡Hola! Quiero pedir:',
  tema: {
    color_primario: colorPrimario,
    color_fondo: '#0a0a0a',
    color_texto: '#e5e5e5'
  }
};

console.log(`  Negocio:   ${nombre}`);
console.log(`  WhatsApp:  ${whatsapp || '(no configurado)'}`);
console.log(`  Output:    ${outputDir}`);
console.log('');

// Generate
const html = generateStaticHTML(carta, config);
const sw = generateServiceWorker(nombre);
const manifest = generateManifest(nombre, colorPrimario, '#0a0a0a');

// Write output
const imgDir = path.join(outputDir, 'img');
fs.mkdirSync(imgDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'index.html'), html, 'utf8');
fs.writeFileSync(path.join(outputDir, 'sw.js'), sw, 'utf8');
fs.writeFileSync(path.join(outputDir, 'manifest.json'), manifest, 'utf8');

// Generate PWA icons (SVG)
const logoEmoji = config.tema?.logo_emoji || '\u{1F355}';
fs.writeFileSync(path.join(outputDir, 'icon-192.svg'), generateIcon(192, logoEmoji, colorPrimario, '#0a0a0a'), 'utf8');
fs.writeFileSync(path.join(outputDir, 'icon-512.svg'), generateIcon(512, logoEmoji, colorPrimario, '#0a0a0a'), 'utf8');

// Copy images if they exist
let imgCount = 0;
for (const p of carta.productos) {
  if (p.imagen && !p.imagen.startsWith('http')) {
    const srcPath = path.resolve(rootDir, 'storage', 'pizzepos', p.imagen.replace(/^\/+/, ''));
    if (fs.existsSync(srcPath)) {
      const destPath = path.join(imgDir, path.basename(srcPath));
      fs.copyFileSync(srcPath, destPath);
      imgCount++;
    }
  }
}

console.log('  Archivos generados:');
console.log(`    index.html    (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
console.log(`    sw.js         (service worker para offline)`);
console.log(`    manifest.json (PWA manifest)`);
if (imgCount > 0) console.log(`    img/          (${imgCount} imágenes copiadas)`);
console.log('');

// Deploy instructions
console.log('  ═══════════════════════════════════════');
console.log('  SIGUIENTE PASO — Desplegar:');
console.log('  ═══════════════════════════════════════');
console.log('');
console.log('  Opción 1: Netlify (más fácil)');
console.log('    → Abre https://app.netlify.com/drop');
console.log(`    → Arrastra la carpeta: ${outputDir}`);
console.log('    → Recibes URL con HTTPS al instante');
console.log('');
console.log('  Opción 2: GitHub Pages');
console.log('    $ cd ' + outputDir);
console.log('    $ git init && git add -A');
console.log('    $ git commit -m "Carta digital ' + nombre + '"');
console.log('    $ gh repo create ' + slugify(nombre) + '-carta --public --source=. --push');
console.log('    → Settings > Pages > Source: main > Save');
console.log(`    → URL: https://tu-usuario.github.io/${slugify(nombre)}-carta/`);
console.log('');
console.log('  Opción 3: Probar local');
console.log(`    $ cd ${outputDir} && npx serve .`);
console.log('    → Abre http://localhost:3000');
console.log('');

if (!whatsapp) {
  console.log('  NOTA: No configuraste WhatsApp. El botón de pedido');
  console.log('  usará "Compartir" en vez de enviar por WhatsApp.');
  console.log('  Para activar WhatsApp, re-ejecuta con:');
  console.log('    --whatsapp 34XXXXXXXXX');
  console.log('');
}

console.log('  Listo.');
console.log('');
