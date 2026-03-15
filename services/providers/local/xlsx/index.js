/**
 * Local XLSX Service
 *
 * Servicio local para crear y parsear archivos Excel.
 * Usa ExcelJS para la manipulacion.
 *
 * Eventos:
 * - local.xlsx.create.request -> local.xlsx.create.response
 * - local.xlsx.parse.request -> local.xlsx.parse.response
 */

const fs = require('fs');
const path = require('path');

// Lazy load ExcelJS
let ExcelJS = null;

const loadExcelJS = () => {
  if (!ExcelJS) {
    try {
      ExcelJS = require('exceljs');
    } catch (e) {
      throw new Error('exceljs not installed. Run: npm install exceljs');
    }
  }
  return ExcelJS;
};

module.exports = {
  name: 'local.xlsx',
  description: 'Servicio local para crear y parsear archivos Excel',

  functions: {
    create: {
      event: 'local.xlsx.create.request',
      description: 'Crear Excel con multiples hojas',
      input: {
        sheets: {
          type: 'array',
          description: 'Array de hojas con name y data',
          required: true
        },
        filename: {
          type: 'string',
          description: 'Nombre del archivo',
          required: true
        }
      },
      output: {
        path: { type: 'string' },
        sheets: { type: 'number' }
      }
    },
    parse: {
      event: 'local.xlsx.parse.request',
      description: 'Leer Excel y convertir a datos',
      input: {
        path: {
          type: 'string',
          description: 'Ruta del archivo',
          required: true
        },
        sheet: {
          type: 'string|number',
          description: 'Hoja a leer (nombre o indice, default: primera)'
        }
      },
      output: {
        sheets: { type: 'array' },
        data: { type: 'array' }
      }
    }
  },

  /**
   * Crear archivo Excel
   */
  async create({ sheets, filename }) {
    const Excel = loadExcelJS();

    const outputDir = './data/generated/xlsx';
    await fs.promises.mkdir(outputDir, { recursive: true });

    const outputPath = path.join(outputDir, filename);

    const workbook = new Excel.Workbook();
    workbook.created = new Date();

    for (const sheetDef of sheets) {
      const worksheet = workbook.addWorksheet(sheetDef.name || 'Sheet');

      if (Array.isArray(sheetDef.data) && sheetDef.data.length > 0) {
        // Inferir columnas
        const columns = sheetDef.columns || Object.keys(sheetDef.data[0]);

        // Header
        worksheet.columns = columns.map(col => ({
          header: col,
          key: col,
          width: 15
        }));

        // Rows
        for (const row of sheetDef.data) {
          worksheet.addRow(row);
        }

        // Estilo del header
        worksheet.getRow(1).font = { bold: true };
      }
    }

    await workbook.xlsx.writeFile(outputPath);

    return {
      success: true,
      path: outputPath,
      sheets: sheets.length
    };
  },

  /**
   * Parsear archivo Excel
   */
  async parse({ path: filePath, sheet }) {
    const Excel = loadExcelJS();

    const workbook = new Excel.Workbook();
    await workbook.xlsx.readFile(filePath);

    const sheetsInfo = workbook.worksheets.map(ws => ({
      name: ws.name,
      rowCount: ws.rowCount,
      columnCount: ws.columnCount
    }));

    // Seleccionar hoja
    let targetSheet;
    if (sheet === undefined || sheet === null) {
      targetSheet = workbook.worksheets[0];
    } else if (typeof sheet === 'number') {
      targetSheet = workbook.worksheets[sheet];
    } else {
      targetSheet = workbook.getWorksheet(sheet);
    }

    if (!targetSheet) {
      return {
        success: false,
        error: `Sheet not found: ${sheet}`,
        sheets: sheetsInfo
      };
    }

    // Extraer datos
    const data = [];
    const headerRow = targetSheet.getRow(1);
    const columns = [];

    headerRow.eachCell((cell, colNumber) => {
      columns[colNumber - 1] = cell.value?.toString() || `col_${colNumber}`;
    });

    targetSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header

      const rowData = {};
      row.eachCell((cell, colNumber) => {
        const colName = columns[colNumber - 1] || `col_${colNumber}`;
        rowData[colName] = cell.value;
      });

      if (Object.keys(rowData).length > 0) {
        data.push(rowData);
      }
    });

    return {
      success: true,
      sheets: sheetsInfo,
      data,
      columns,
      rows: data.length
    };
  }
};
