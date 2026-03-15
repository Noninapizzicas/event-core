/**
 * Local DXF Service
 *
 * Parseo y generación de archivos DXF (Drawing Exchange Format).
 * Lee capas, entidades y convierte DXF a SVG.
 * No requiere dependencias externas — parser DXF básico integrado.
 *
 * Eventos:
 * - local.dxf.parse.request -> local.dxf.parse.response
 * - local.dxf.create.request -> local.dxf.create.response
 * - local.dxf.layers.request -> local.dxf.layers.response
 * - local.dxf.export-svg.request -> local.dxf.export-svg.response
 *
 * @version 1.0.0
 * @created 2026-02-05
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(process.cwd(), 'data', 'dxf');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Parser DXF minimalista — lee secciones ENTITIES y TABLES
function parseDxfContent(content) {
  const lines = content.split(/\r?\n/);
  const entities = [];
  const layers = new Map();
  let i = 0;

  function readPair() {
    if (i >= lines.length - 1) return null;
    const code = parseInt(lines[i].trim(), 10);
    const value = lines[i + 1]?.trim();
    i += 2;
    return { code, value };
  }

  // Buscar sección ENTITIES
  while (i < lines.length) {
    const pair = readPair();
    if (!pair) break;
    if (pair.code === 2 && pair.value === 'ENTITIES') break;
    // Capturar layers de la tabla LAYER
    if (pair.code === 0 && pair.value === 'LAYER') {
      const layer = { name: '', color: 7 };
      while (i < lines.length) {
        const lp = readPair();
        if (!lp || (lp.code === 0)) { i -= 2; break; }
        if (lp.code === 2) layer.name = lp.value;
        if (lp.code === 62) layer.color = parseInt(lp.value, 10);
      }
      if (layer.name) layers.set(layer.name, layer);
    }
  }

  // Leer entidades
  while (i < lines.length) {
    const pair = readPair();
    if (!pair) break;
    if (pair.code === 0 && pair.value === 'ENDSEC') break;
    if (pair.code === 0) {
      const entityType = pair.value;
      const entity = { type: entityType, layer: '0', props: {} };
      while (i < lines.length) {
        const ep = readPair();
        if (!ep || ep.code === 0) { i -= 2; break; }
        if (ep.code === 8) entity.layer = ep.value;
        // Coordenadas comunes
        if (ep.code === 10) entity.props.x1 = parseFloat(ep.value);
        if (ep.code === 20) entity.props.y1 = parseFloat(ep.value);
        if (ep.code === 11) entity.props.x2 = parseFloat(ep.value);
        if (ep.code === 21) entity.props.y2 = parseFloat(ep.value);
        if (ep.code === 40) entity.props.radius = parseFloat(ep.value);
        if (ep.code === 1) entity.props.text = ep.value;
        if (ep.code === 62) entity.props.color = parseInt(ep.value, 10);
      }
      entities.push(entity);
    }
  }

  return { entities, layers: Object.fromEntries(layers) };
}

// Generador DXF minimalista
function generateDxf(entities) {
  let dxf = '';
  dxf += '0\nSECTION\n2\nHEADER\n0\nENDSEC\n';
  dxf += '0\nSECTION\n2\nENTITIES\n';

  for (const e of entities) {
    switch (e.type) {
      case 'LINE':
        dxf += `0\nLINE\n8\n${e.layer || '0'}\n`;
        dxf += `10\n${e.x1 || 0}\n20\n${e.y1 || 0}\n`;
        dxf += `11\n${e.x2 || 0}\n21\n${e.y2 || 0}\n`;
        break;
      case 'CIRCLE':
        dxf += `0\nCIRCLE\n8\n${e.layer || '0'}\n`;
        dxf += `10\n${e.cx || 0}\n20\n${e.cy || 0}\n`;
        dxf += `40\n${e.radius || 1}\n`;
        break;
      case 'TEXT':
        dxf += `0\nTEXT\n8\n${e.layer || '0'}\n`;
        dxf += `10\n${e.x || 0}\n20\n${e.y || 0}\n`;
        dxf += `40\n${e.height || 10}\n`;
        dxf += `1\n${e.text || ''}\n`;
        break;
      case 'ARC':
        dxf += `0\nARC\n8\n${e.layer || '0'}\n`;
        dxf += `10\n${e.cx || 0}\n20\n${e.cy || 0}\n`;
        dxf += `40\n${e.radius || 1}\n`;
        dxf += `50\n${e.startAngle || 0}\n51\n${e.endAngle || 360}\n`;
        break;
    }
  }

  dxf += '0\nENDSEC\n0\nEOF\n';
  return dxf;
}

// Convertir entidades DXF a SVG
function entitiesToSvg(entities, width = 800, height = 600) {
  // Calcular bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of entities) {
    const p = e.props || e;
    for (const [k, v] of Object.entries(p)) {
      if ((k.startsWith('x') || k === 'cx') && typeof v === 'number') {
        minX = Math.min(minX, v);
        maxX = Math.max(maxX, v);
      }
      if ((k.startsWith('y') || k === 'cy') && typeof v === 'number') {
        minY = Math.min(minY, v);
        maxY = Math.max(maxY, v);
      }
    }
  }

  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = width; maxY = height; }
  const margin = 20;
  const vbW = (maxX - minX) || width;
  const vbH = (maxY - minY) || height;
  const viewBox = `${minX - margin} ${minY - margin} ${vbW + margin * 2} ${vbH + margin * 2}`;

  let content = '';
  for (const e of entities) {
    const p = e.props || e;
    const type = e.type;
    const stroke = '#333';
    switch (type) {
      case 'LINE':
        content += `<line x1="${p.x1 || 0}" y1="${p.y1 || 0}" x2="${p.x2 || 0}" y2="${p.y2 || 0}" stroke="${stroke}" stroke-width="1" />\n`;
        break;
      case 'CIRCLE':
        content += `<circle cx="${p.x1 || p.cx || 0}" cy="${p.y1 || p.cy || 0}" r="${p.radius || 1}" fill="none" stroke="${stroke}" stroke-width="1" />\n`;
        break;
      case 'ARC': {
        const cx = p.x1 || p.cx || 0;
        const cy = p.y1 || p.cy || 0;
        const r = p.radius || 1;
        content += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${stroke}" stroke-width="1" stroke-dasharray="4,2" />\n`;
        break;
      }
      case 'TEXT':
        content += `<text x="${p.x1 || p.x || 0}" y="${p.y1 || p.y || 0}" font-size="12" fill="#333">${p.text || ''}</text>\n`;
        break;
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}">
${content}
</svg>`;
}

module.exports = {
  name: 'local.dxf',
  description: 'Parseo y generación de archivos DXF — planos técnicos, capas, export SVG',

  functions: {
    parse: {
      event: 'local.dxf.parse.request',
      description: 'Parsea un archivo DXF y extrae entidades y capas',
      input: {
        file: { type: 'string', description: 'Ruta al archivo DXF', required: true }
      },
      output: {
        entities: { type: 'array', description: 'Entidades encontradas' },
        layers: { type: 'object', description: 'Capas del DXF' },
        total: { type: 'number', description: 'Total de entidades' }
      }
    },
    create: {
      event: 'local.dxf.create.request',
      description: 'Crea un archivo DXF a partir de entidades',
      input: {
        entities: { type: 'array', description: 'Array de { type: LINE|CIRCLE|TEXT|ARC, ...coords }', required: true },
        filename: { type: 'string', description: 'Nombre del archivo (sin .dxf)', required: false }
      },
      output: {
        path: { type: 'string', description: 'Ruta del archivo DXF creado' },
        entities: { type: 'number', description: 'Total de entidades' }
      }
    },
    layers: {
      event: 'local.dxf.layers.request',
      description: 'Lista capas de un archivo DXF',
      input: {
        file: { type: 'string', description: 'Ruta al archivo DXF', required: true }
      },
      output: {
        layers: { type: 'object', description: 'Capas con info' },
        total: { type: 'number', description: 'Total de capas' }
      }
    },
    'export-svg': {
      event: 'local.dxf.export-svg.request',
      description: 'Convierte un DXF a SVG',
      input: {
        file: { type: 'string', description: 'Ruta al archivo DXF', required: true },
        width: { type: 'number', description: 'Ancho SVG (default: 800)', required: false },
        height: { type: 'number', description: 'Alto SVG (default: 600)', required: false },
        filename: { type: 'string', description: 'Nombre del SVG de salida', required: false }
      },
      output: {
        path: { type: 'string', description: 'Ruta del SVG generado' }
      }
    }
  },

  async parse({ file }) {
    if (!file) return { success: false, error: 'file es requerido' };
    try {
      if (!fs.existsSync(file)) return { success: false, error: `Archivo no encontrado: ${file}` };
      const content = fs.readFileSync(file, 'utf8');
      const { entities, layers } = parseDxfContent(content);

      return {
        success: true,
        data: {
          entities: entities.map(e => ({
            type: e.type,
            layer: e.layer,
            ...e.props
          })),
          layers,
          total: entities.length,
          layerCount: Object.keys(layers).length
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async create({ entities, filename }) {
    if (!entities || !Array.isArray(entities) || entities.length === 0) {
      return { success: false, error: 'entities es requerido' };
    }

    try {
      const dxf = generateDxf(entities);
      const fname = (filename || `drawing_${Date.now()}`).replace(/\.dxf$/, '');
      ensureDir(OUTPUT_DIR);
      const filePath = path.join(OUTPUT_DIR, `${fname}.dxf`);
      fs.writeFileSync(filePath, dxf, 'utf8');

      return {
        success: true,
        data: { path: filePath, entities: entities.length, size: `${dxf.length} bytes` }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async layers({ file }) {
    if (!file) return { success: false, error: 'file es requerido' };
    try {
      if (!fs.existsSync(file)) return { success: false, error: `Archivo no encontrado: ${file}` };
      const content = fs.readFileSync(file, 'utf8');
      const { entities, layers } = parseDxfContent(content);

      // Contar entidades por capa
      const layerStats = {};
      for (const [name, info] of Object.entries(layers)) {
        layerStats[name] = { ...info, entityCount: 0 };
      }
      for (const e of entities) {
        if (!layerStats[e.layer]) layerStats[e.layer] = { name: e.layer, color: 7, entityCount: 0 };
        layerStats[e.layer].entityCount++;
      }

      return {
        success: true,
        data: { layers: layerStats, total: Object.keys(layerStats).length }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async 'export-svg'({ file, width = 800, height = 600, filename }) {
    if (!file) return { success: false, error: 'file es requerido' };
    try {
      if (!fs.existsSync(file)) return { success: false, error: `Archivo no encontrado: ${file}` };
      const content = fs.readFileSync(file, 'utf8');
      const { entities } = parseDxfContent(content);

      const svg = entitiesToSvg(entities, width, height);
      const fname = (filename || path.basename(file, '.dxf') + '_export').replace(/\.svg$/, '');
      const svgDir = path.join(process.cwd(), 'data', 'svg');
      ensureDir(svgDir);
      const filePath = path.join(svgDir, `${fname}.svg`);
      fs.writeFileSync(filePath, svg, 'utf8');

      return {
        success: true,
        data: { path: filePath, entities: entities.length, size: `${width}x${height}` }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};
