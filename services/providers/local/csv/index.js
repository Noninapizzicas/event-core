/**
 * Local CSV Service
 *
 * Servicio local para crear y parsear CSVs.
 * No requiere credenciales externas.
 *
 * Eventos:
 * - local.csv.create.request -> local.csv.create.response
 * - local.csv.parse.request -> local.csv.parse.response
 */

const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'local.csv',
  description: 'Servicio local para crear y parsear CSVs',

  functions: {
    create: {
      event: 'local.csv.create.request',
      description: 'Crear CSV desde array de objetos',
      input: {
        data: {
          type: 'array',
          description: 'Array de objetos',
          required: true
        },
        columns: {
          type: 'array',
          description: 'Columnas a incluir (opcional, infiere de data)'
        },
        filename: {
          type: 'string',
          description: 'Nombre del archivo',
          required: true
        },
        delimiter: {
          type: 'string',
          description: 'Delimitador',
          default: ','
        }
      },
      output: {
        path: { type: 'string' },
        rows: { type: 'number' }
      }
    },
    parse: {
      event: 'local.csv.parse.request',
      description: 'Leer CSV y convertir a array de objetos',
      input: {
        path: {
          type: 'string',
          description: 'Ruta del archivo'
        },
        content: {
          type: 'string',
          description: 'Contenido CSV (alternativa a path)'
        },
        delimiter: {
          type: 'string',
          default: ','
        }
      },
      output: {
        data: { type: 'array' },
        columns: { type: 'array' },
        rows: { type: 'number' }
      }
    }
  },

  /**
   * Crear CSV desde array de objetos
   */
  async create({ data, columns, filename, delimiter = ',' }) {
    if (!Array.isArray(data) || data.length === 0) {
      return { success: false, error: 'Data must be a non-empty array' };
    }

    const outputDir = './data/generated/csv';
    await fs.promises.mkdir(outputDir, { recursive: true });

    const outputPath = path.join(outputDir, filename);

    // Inferir columnas si no se proporcionan
    const cols = columns || Object.keys(data[0]);

    // Escapar valores
    const escape = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(delimiter) || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    // Construir CSV
    const lines = [];
    lines.push(cols.map(escape).join(delimiter));

    for (const row of data) {
      const values = cols.map(col => escape(row[col]));
      lines.push(values.join(delimiter));
    }

    const csvContent = lines.join('\n');
    await fs.promises.writeFile(outputPath, csvContent, 'utf8');

    return {
      success: true,
      path: outputPath,
      rows: data.length
    };
  },

  /**
   * Parsear CSV a array de objetos
   */
  async parse({ path: filePath, content, delimiter = ',' }) {
    let csvContent;

    if (content) {
      csvContent = content;
    } else if (filePath) {
      csvContent = await fs.promises.readFile(filePath, 'utf8');
    } else {
      return { success: false, error: 'Must provide path or content' };
    }

    const lines = csvContent.trim().split('\n');
    if (lines.length === 0) {
      return { success: false, error: 'Empty CSV' };
    }

    // Parsear linea respetando quotes
    const parseLine = (line) => {
      const result = [];
      let current = '';
      let inQuotes = false;

      for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
          if (inQuotes && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === delimiter && !inQuotes) {
          result.push(current);
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current);
      return result;
    };

    const columns = parseLine(lines[0]);
    const data = [];

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;

      const values = parseLine(lines[i]);
      const row = {};

      columns.forEach((col, idx) => {
        row[col] = values[idx] || '';
      });

      data.push(row);
    }

    return {
      success: true,
      data,
      columns,
      rows: data.length
    };
  }
};
