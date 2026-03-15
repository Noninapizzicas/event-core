/**
 * Local SVG Service
 *
 * Generación de gráficos SVG: planos, esquemas, diagramas, gráficas.
 * No requiere dependencias externas — genera SVG puro como string.
 *
 * Eventos:
 * - local.svg.create.request -> local.svg.create.response
 * - local.svg.from-data.request -> local.svg.from-data.response
 * - local.svg.schematic.request -> local.svg.schematic.response
 * - local.svg.floorplan.request -> local.svg.floorplan.response
 *
 * @version 1.0.0
 * @created 2026-02-05
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(process.cwd(), 'data', 'svg');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function svgWrap(width, height, content, viewBox) {
  const vb = viewBox || `0 0 ${width} ${height}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${vb}">
<style>
  text { font-family: Arial, sans-serif; }
  .label { font-size: 12px; fill: #333; }
  .title { font-size: 16px; font-weight: bold; fill: #111; }
</style>
${content}
</svg>`;
}

function escapeXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
  name: 'local.svg',
  description: 'Generación de gráficos SVG — planos, esquemas, diagramas, gráficas',

  functions: {
    create: {
      event: 'local.svg.create.request',
      description: 'Crea un SVG a partir de elementos definidos',
      input: {
        width: { type: 'number', description: 'Ancho en px (default: 800)', required: false },
        height: { type: 'number', description: 'Alto en px (default: 600)', required: false },
        elements: { type: 'array', description: 'Array de elementos: { type: rect|circle|line|text|path, attrs: {} }', required: true },
        filename: { type: 'string', description: 'Nombre del archivo (sin .svg)', required: false },
        title: { type: 'string', description: 'Título del SVG', required: false }
      },
      output: {
        path: { type: 'string', description: 'Ruta del archivo SVG' },
        svg: { type: 'string', description: 'Contenido SVG (si es pequeño)' }
      }
    },
    'from-data': {
      event: 'local.svg.from-data.request',
      description: 'Genera gráfica SVG a partir de datos (barras, líneas, pie)',
      input: {
        type: { type: 'string', description: 'Tipo: bar | line | pie', required: true },
        data: { type: 'array', description: 'Array de { label, value } o { x, y }', required: true },
        title: { type: 'string', description: 'Título de la gráfica', required: false },
        width: { type: 'number', description: 'Ancho (default: 800)', required: false },
        height: { type: 'number', description: 'Alto (default: 400)', required: false },
        colors: { type: 'array', description: 'Colores personalizados', required: false },
        filename: { type: 'string', description: 'Nombre del archivo', required: false }
      },
      output: {
        path: { type: 'string', description: 'Ruta del archivo SVG' }
      }
    },
    schematic: {
      event: 'local.svg.schematic.request',
      description: 'Genera esquema/diagrama de bloques SVG',
      input: {
        blocks: { type: 'array', description: 'Array de { id, label, x, y, w?, h?, color? }', required: true },
        connections: { type: 'array', description: 'Array de { from, to, label? }', required: false },
        title: { type: 'string', description: 'Título del esquema', required: false },
        filename: { type: 'string', description: 'Nombre del archivo', required: false }
      },
      output: {
        path: { type: 'string', description: 'Ruta del archivo SVG' }
      }
    },
    floorplan: {
      event: 'local.svg.floorplan.request',
      description: 'Genera plano de planta SVG con habitaciones',
      input: {
        rooms: { type: 'array', description: 'Array de { name, x, y, w, h, color? }', required: true },
        doors: { type: 'array', description: 'Array de { x, y, orientation: h|v }', required: false },
        scale: { type: 'number', description: 'Escala px por metro (default: 50)', required: false },
        title: { type: 'string', description: 'Título del plano', required: false },
        filename: { type: 'string', description: 'Nombre del archivo', required: false }
      },
      output: {
        path: { type: 'string', description: 'Ruta del archivo SVG' }
      }
    }
  },

  async create({ width = 800, height = 600, elements, filename, title }) {
    if (!elements || !Array.isArray(elements) || elements.length === 0) {
      return { success: false, error: 'elements es requerido (array de elementos SVG)' };
    }

    try {
      let content = '';
      if (title) {
        content += `<text x="${width / 2}" y="30" text-anchor="middle" class="title">${escapeXml(title)}</text>\n`;
      }

      for (const el of elements) {
        const attrs = el.attrs || {};
        const attrStr = Object.entries(attrs).map(([k, v]) => `${k}="${escapeXml(v)}"`).join(' ');
        switch (el.type) {
          case 'rect':
            content += `<rect ${attrStr} />\n`;
            break;
          case 'circle':
            content += `<circle ${attrStr} />\n`;
            break;
          case 'line':
            content += `<line ${attrStr} stroke="${attrs.stroke || '#333'}" />\n`;
            break;
          case 'text':
            content += `<text ${attrStr}>${escapeXml(el.text || '')}</text>\n`;
            break;
          case 'path':
            content += `<path ${attrStr} />\n`;
            break;
          case 'polygon':
            content += `<polygon ${attrStr} />\n`;
            break;
          default:
            content += `<${el.type} ${attrStr} />\n`;
        }
      }

      const svg = svgWrap(width, height, content);
      const fname = (filename || `svg_${Date.now()}`).replace(/\.svg$/, '');
      ensureDir(OUTPUT_DIR);
      const filePath = path.join(OUTPUT_DIR, `${fname}.svg`);
      fs.writeFileSync(filePath, svg, 'utf8');

      return {
        success: true,
        data: {
          path: filePath,
          elements: elements.length,
          size: `${width}x${height}`,
          svg: svg.length < 5000 ? svg : undefined
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async 'from-data'({ type, data, title, width = 800, height = 400, colors, filename }) {
    if (!type || !data || !Array.isArray(data) || data.length === 0) {
      return { success: false, error: 'type y data son requeridos' };
    }
    const validTypes = ['bar', 'line', 'pie'];
    if (!validTypes.includes(type)) return { success: false, error: `type debe ser: ${validTypes.join(', ')}` };

    try {
      const defaultColors = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];
      const palette = colors || defaultColors;
      let content = '';
      const margin = { top: 50, right: 30, bottom: 60, left: 60 };
      const chartW = width - margin.left - margin.right;
      const chartH = height - margin.top - margin.bottom;

      if (title) {
        content += `<text x="${width / 2}" y="30" text-anchor="middle" class="title">${escapeXml(title)}</text>\n`;
      }

      if (type === 'bar') {
        const maxVal = Math.max(...data.map(d => d.value || 0));
        const barW = Math.min(60, (chartW / data.length) * 0.7);
        const gap = chartW / data.length;

        content += `<g transform="translate(${margin.left},${margin.top})">`;
        // Eje Y
        content += `<line x1="0" y1="0" x2="0" y2="${chartH}" stroke="#ccc" />`;
        // Eje X
        content += `<line x1="0" y1="${chartH}" x2="${chartW}" y2="${chartH}" stroke="#ccc" />`;

        data.forEach((d, i) => {
          const barH = maxVal > 0 ? (d.value / maxVal) * chartH : 0;
          const x = i * gap + (gap - barW) / 2;
          const y = chartH - barH;
          const color = palette[i % palette.length];
          content += `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${color}" rx="2" />`;
          content += `<text x="${x + barW / 2}" y="${chartH + 20}" text-anchor="middle" class="label">${escapeXml(d.label || i)}</text>`;
          content += `<text x="${x + barW / 2}" y="${y - 5}" text-anchor="middle" class="label">${d.value}</text>`;
        });
        content += '</g>';
      } else if (type === 'line') {
        const values = data.map(d => d.value || d.y || 0);
        const maxVal = Math.max(...values);
        const minVal = Math.min(...values);
        const range = maxVal - minVal || 1;

        content += `<g transform="translate(${margin.left},${margin.top})">`;
        content += `<line x1="0" y1="0" x2="0" y2="${chartH}" stroke="#ccc" />`;
        content += `<line x1="0" y1="${chartH}" x2="${chartW}" y2="${chartH}" stroke="#ccc" />`;

        const points = data.map((d, i) => {
          const x = (i / Math.max(data.length - 1, 1)) * chartW;
          const y = chartH - ((values[i] - minVal) / range) * chartH;
          return `${x},${y}`;
        });

        content += `<polyline points="${points.join(' ')}" fill="none" stroke="${palette[0]}" stroke-width="2" />`;
        data.forEach((d, i) => {
          const x = (i / Math.max(data.length - 1, 1)) * chartW;
          const y = chartH - ((values[i] - minVal) / range) * chartH;
          content += `<circle cx="${x}" cy="${y}" r="4" fill="${palette[0]}" />`;
          if (data.length <= 20) {
            content += `<text x="${x}" y="${chartH + 20}" text-anchor="middle" class="label">${escapeXml(d.label || d.x || i)}</text>`;
          }
        });
        content += '</g>';
      } else if (type === 'pie') {
        const total = data.reduce((s, d) => s + (d.value || 0), 0);
        if (total === 0) return { success: false, error: 'Datos con valor total 0' };

        const cx = width / 2;
        const cy = margin.top + chartH / 2;
        const r = Math.min(chartW, chartH) / 2 - 10;
        let startAngle = -Math.PI / 2;

        content += `<g>`;
        data.forEach((d, i) => {
          const slice = (d.value / total) * Math.PI * 2;
          const endAngle = startAngle + slice;
          const x1 = cx + r * Math.cos(startAngle);
          const y1 = cy + r * Math.sin(startAngle);
          const x2 = cx + r * Math.cos(endAngle);
          const y2 = cy + r * Math.sin(endAngle);
          const large = slice > Math.PI ? 1 : 0;
          const color = palette[i % palette.length];
          content += `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} Z" fill="${color}" stroke="#fff" stroke-width="1" />`;

          // Label
          const midAngle = startAngle + slice / 2;
          const lx = cx + (r * 0.7) * Math.cos(midAngle);
          const ly = cy + (r * 0.7) * Math.sin(midAngle);
          content += `<text x="${lx}" y="${ly}" text-anchor="middle" class="label" fill="#fff">${escapeXml(d.label || '')}</text>`;
          startAngle = endAngle;
        });
        content += '</g>';
      }

      const svg = svgWrap(width, height, content);
      const fname = (filename || `chart_${type}_${Date.now()}`).replace(/\.svg$/, '');
      ensureDir(OUTPUT_DIR);
      const filePath = path.join(OUTPUT_DIR, `${fname}.svg`);
      fs.writeFileSync(filePath, svg, 'utf8');

      return {
        success: true,
        data: { path: filePath, type, dataPoints: data.length }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async schematic({ blocks, connections = [], title, filename }) {
    if (!blocks || !Array.isArray(blocks) || blocks.length === 0) {
      return { success: false, error: 'blocks es requerido' };
    }

    try {
      const blockMap = {};
      let maxX = 0, maxY = 0;

      blocks.forEach(b => {
        b.w = b.w || 150;
        b.h = b.h || 60;
        blockMap[b.id] = b;
        maxX = Math.max(maxX, b.x + b.w);
        maxY = Math.max(maxY, b.y + b.h);
      });

      const width = maxX + 100;
      const height = maxY + 100;
      let content = '';

      if (title) {
        content += `<text x="${width / 2}" y="25" text-anchor="middle" class="title">${escapeXml(title)}</text>\n`;
      }

      // Connections (arrows)
      connections.forEach(c => {
        const from = blockMap[c.from];
        const to = blockMap[c.to];
        if (!from || !to) return;
        const fx = from.x + from.w;
        const fy = from.y + from.h / 2;
        const tx = to.x;
        const ty = to.y + to.h / 2;
        content += `<line x1="${fx}" y1="${fy}" x2="${tx}" y2="${ty}" stroke="#666" stroke-width="2" marker-end="url(#arrow)" />\n`;
        if (c.label) {
          const mx = (fx + tx) / 2;
          const my = (fy + ty) / 2 - 8;
          content += `<text x="${mx}" y="${my}" text-anchor="middle" class="label" fill="#666">${escapeXml(c.label)}</text>\n`;
        }
      });

      // Arrow marker
      content = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#666"/></marker></defs>\n` + content;

      // Blocks
      blocks.forEach(b => {
        const color = b.color || '#4e79a7';
        content += `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${color}" rx="8" ry="8" opacity="0.9" />\n`;
        content += `<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2 + 5}" text-anchor="middle" fill="#fff" font-size="13">${escapeXml(b.label || b.id)}</text>\n`;
      });

      const svg = svgWrap(width, height, content);
      const fname = (filename || `schematic_${Date.now()}`).replace(/\.svg$/, '');
      ensureDir(OUTPUT_DIR);
      const filePath = path.join(OUTPUT_DIR, `${fname}.svg`);
      fs.writeFileSync(filePath, svg, 'utf8');

      return {
        success: true,
        data: { path: filePath, blocks: blocks.length, connections: connections.length }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async floorplan({ rooms, doors = [], scale = 50, title, filename }) {
    if (!rooms || !Array.isArray(rooms) || rooms.length === 0) {
      return { success: false, error: 'rooms es requerido' };
    }

    try {
      let maxX = 0, maxY = 0;
      rooms.forEach(r => {
        maxX = Math.max(maxX, (r.x + r.w) * scale);
        maxY = Math.max(maxY, (r.y + r.h) * scale);
      });

      const margin = 60;
      const width = maxX + margin * 2;
      const height = maxY + margin * 2 + 40;
      let content = '';

      if (title) {
        content += `<text x="${width / 2}" y="25" text-anchor="middle" class="title">${escapeXml(title)}</text>\n`;
      }

      content += `<g transform="translate(${margin},${margin + (title ? 20 : 0)})">`;

      // Rooms
      rooms.forEach(r => {
        const x = r.x * scale;
        const y = r.y * scale;
        const w = r.w * scale;
        const h = r.h * scale;
        const color = r.color || '#f0f0f0';
        content += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" stroke="#333" stroke-width="2" />\n`;
        content += `<text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" dominant-baseline="central" class="label">${escapeXml(r.name)}</text>\n`;
        content += `<text x="${x + w / 2}" y="${y + h / 2 + 16}" text-anchor="middle" class="label" font-size="10" fill="#888">${r.w}×${r.h}m</text>\n`;
      });

      // Doors
      doors.forEach(d => {
        const x = d.x * scale;
        const y = d.y * scale;
        const doorSize = 0.8 * scale;
        if (d.orientation === 'h') {
          content += `<line x1="${x}" y1="${y}" x2="${x + doorSize}" y2="${y}" stroke="#fff" stroke-width="4" />\n`;
          content += `<path d="M${x},${y} A${doorSize},${doorSize} 0 0,1 ${x + doorSize},${y}" fill="none" stroke="#333" stroke-width="1" stroke-dasharray="4,2" />\n`;
        } else {
          content += `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + doorSize}" stroke="#fff" stroke-width="4" />\n`;
          content += `<path d="M${x},${y} A${doorSize},${doorSize} 0 0,0 ${x},${y + doorSize}" fill="none" stroke="#333" stroke-width="1" stroke-dasharray="4,2" />\n`;
        }
      });

      content += '</g>';

      // Scale indicator
      content += `<text x="${width - 20}" y="${height - 10}" text-anchor="end" class="label" fill="#999">Escala: 1m = ${scale}px</text>`;

      const svg = svgWrap(width, height, content);
      const fname = (filename || `floorplan_${Date.now()}`).replace(/\.svg$/, '');
      ensureDir(OUTPUT_DIR);
      const filePath = path.join(OUTPUT_DIR, `${fname}.svg`);
      fs.writeFileSync(filePath, svg, 'utf8');

      return {
        success: true,
        data: { path: filePath, rooms: rooms.length, doors: doors.length, scale: `1m=${scale}px` }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};
