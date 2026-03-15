/**
 * Local PDF Service
 *
 * Servicio local para crear y manipular PDFs.
 * No requiere credenciales externas.
 *
 * Eventos:
 * - local.pdf.create.request -> local.pdf.create.response
 *
 * @example
 * eventBus.publish('local.pdf.create.request', {
 *   type: 'from_text',
 *   content: 'Hola Mundo',
 *   filename: 'saludo.pdf'
 * });
 */

const fs = require('fs');
const path = require('path');

// Lazy load PDFKit para evitar errores si no está instalado
let PDFDocument = null;

const loadPDFKit = () => {
  if (!PDFDocument) {
    try {
      PDFDocument = require('pdfkit');
    } catch (e) {
      throw new Error('pdfkit not installed. Run: npm install pdfkit');
    }
  }
  return PDFDocument;
};

module.exports = {
  name: 'local.pdf',
  description: 'Servicio local para crear PDFs',

  functions: {
    create: {
      event: 'local.pdf.create.request',
      description: 'Crear PDF desde datos o template',
      input: {
        type: {
          type: 'string',
          enum: ['from_text', 'from_html', 'from_template'],
          required: true
        },
        content: {
          type: 'string|object',
          description: 'Contenido del PDF',
          required: true
        },
        template: {
          type: 'string',
          description: 'Nombre del template (si type=from_template)'
        },
        filename: {
          type: 'string',
          description: 'Nombre del archivo de salida',
          required: true
        },
        options: {
          type: 'object',
          properties: {
            orientation: { enum: ['portrait', 'landscape'], default: 'portrait' },
            format: { enum: ['A4', 'letter', 'legal'], default: 'A4' },
            margin: { type: 'number', default: 50 }
          }
        }
      },
      output: {
        success: { type: 'boolean' },
        path: { type: 'string', description: 'Ruta del PDF generado' },
        size: { type: 'number', description: 'Tamano en bytes' }
      }
    }
  },

  /**
   * Crear PDF desde texto, HTML o template
   */
  async create({ type, content, template, filename, options = {} }) {
    const PDF = loadPDFKit();

    const outputDir = './data/generated/pdf';
    await fs.promises.mkdir(outputDir, { recursive: true });

    const outputPath = path.join(outputDir, filename);

    const doc = new PDF({
      size: options.format || 'A4',
      layout: options.orientation || 'portrait',
      margin: options.margin || 50
    });

    const writeStream = fs.createWriteStream(outputPath);
    doc.pipe(writeStream);

    if (type === 'from_text') {
      // Texto simple
      if (typeof content === 'string') {
        doc.text(content);
      } else if (content.title) {
        doc.fontSize(18).text(content.title, { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(content.body || '');
      }
    } else if (type === 'from_template') {
      // Cargar template y renderizar
      const templatePath = path.join(__dirname, 'templates', `${template}.js`);
      if (fs.existsSync(templatePath)) {
        const templateFn = require(templatePath);
        await templateFn(doc, content);
      } else {
        doc.text(`Template not found: ${template}`);
      }
    } else if (type === 'from_html') {
      // HTML basico - solo texto por ahora
      const plainText = content.replace(/<[^>]*>/g, '');
      doc.text(plainText);
    }

    doc.end();

    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    const stats = await fs.promises.stat(outputPath);

    return {
      success: true,
      path: outputPath,
      size: stats.size
    };
  }
};
