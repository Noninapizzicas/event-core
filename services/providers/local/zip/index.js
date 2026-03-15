/**
 * Local ZIP Service
 *
 * Servicio local para crear archivos ZIP.
 * Usa archiver para la compresión.
 *
 * Eventos:
 * - local.zip.create.request -> local.zip.create.response
 * - local.zip.createFromFiles.request -> local.zip.createFromFiles.response
 */

const fs = require('fs');
const path = require('path');

// Lazy load archiver
let archiver = null;

const loadArchiver = () => {
  if (!archiver) {
    try {
      archiver = require('archiver');
    } catch (e) {
      throw new Error('archiver not installed. Run: npm install archiver');
    }
  }
  return archiver;
};

/**
 * Resuelve rutas con prefijo @/ a rutas absolutas
 */
const resolvePath = (inputPath) => {
  if (!inputPath) return inputPath;

  if (inputPath.startsWith('@/')) {
    return path.join(process.cwd(), 'data', inputPath.slice(2));
  }

  if (inputPath.startsWith('/')) {
    return path.join(process.cwd(), 'data', inputPath);
  }

  return inputPath;
};

module.exports = {
  name: 'local.zip',
  description: 'Servicio local para crear archivos ZIP',

  functions: {
    create: {
      event: 'local.zip.create.request',
      description: 'Crear ZIP desde un directorio',
      input: {
        source: {
          type: 'string',
          description: 'Directorio o archivo a comprimir (soporta @/)',
          required: true
        },
        output: {
          type: 'string',
          description: 'Ruta del archivo ZIP de salida (soporta @/)',
          required: true
        },
        level: {
          type: 'number',
          description: 'Nivel de compresión 0-9 (default: 6)'
        }
      },
      output: {
        path: { type: 'string' },
        size: { type: 'number' },
        files: { type: 'number' }
      }
    },

    createFromFiles: {
      event: 'local.zip.createFromFiles.request',
      description: 'Crear ZIP desde lista de archivos',
      input: {
        files: {
          type: 'array',
          description: 'Array de {source, name} o strings con rutas',
          required: true
        },
        output: {
          type: 'string',
          description: 'Ruta del archivo ZIP de salida (soporta @/)',
          required: true
        },
        level: {
          type: 'number',
          description: 'Nivel de compresión 0-9 (default: 6)'
        }
      },
      output: {
        path: { type: 'string' },
        size: { type: 'number' },
        files: { type: 'number' }
      }
    },

    addDirectory: {
      event: 'local.zip.addDirectory.request',
      description: 'Añadir un directorio completo al ZIP',
      input: {
        source: {
          type: 'string',
          description: 'Directorio a añadir (soporta @/)',
          required: true
        },
        output: {
          type: 'string',
          description: 'Ruta del archivo ZIP de salida (soporta @/)',
          required: true
        },
        destPath: {
          type: 'string',
          description: 'Ruta dentro del ZIP (default: nombre del directorio)'
        },
        level: {
          type: 'number',
          description: 'Nivel de compresión 0-9 (default: 6)'
        }
      },
      output: {
        path: { type: 'string' },
        size: { type: 'number' },
        files: { type: 'number' }
      }
    }
  },

  /**
   * Crear ZIP desde un directorio
   */
  async create({ source, output, level = 6 }) {
    const archiverLib = loadArchiver();

    const sourcePath = resolvePath(source);
    const outputPath = resolvePath(output);

    // Verificar que existe el source
    if (!fs.existsSync(sourcePath)) {
      return {
        success: false,
        error: `Source not found: ${source}`
      };
    }

    // Crear directorio de salida si no existe
    const outputDir = path.dirname(outputPath);
    await fs.promises.mkdir(outputDir, { recursive: true });

    return new Promise((resolve, reject) => {
      const outputStream = fs.createWriteStream(outputPath);
      const archive = archiverLib('zip', {
        zlib: { level }
      });

      let fileCount = 0;

      archive.on('entry', () => {
        fileCount++;
      });

      outputStream.on('close', () => {
        resolve({
          success: true,
          path: outputPath,
          size: archive.pointer(),
          files: fileCount
        });
      });

      archive.on('error', (err) => {
        reject({
          success: false,
          error: err.message
        });
      });

      archive.pipe(outputStream);

      const stats = fs.statSync(sourcePath);

      if (stats.isDirectory()) {
        // Añadir directorio completo
        archive.directory(sourcePath, path.basename(sourcePath));
      } else {
        // Añadir archivo individual
        archive.file(sourcePath, { name: path.basename(sourcePath) });
      }

      archive.finalize();
    });
  },

  /**
   * Crear ZIP desde lista de archivos
   */
  async createFromFiles({ files, output, level = 6 }) {
    const archiverLib = loadArchiver();

    const outputPath = resolvePath(output);

    // Crear directorio de salida si no existe
    const outputDir = path.dirname(outputPath);
    await fs.promises.mkdir(outputDir, { recursive: true });

    return new Promise((resolve, reject) => {
      const outputStream = fs.createWriteStream(outputPath);
      const archive = archiverLib('zip', {
        zlib: { level }
      });

      let fileCount = 0;
      let errors = [];

      archive.on('entry', () => {
        fileCount++;
      });

      outputStream.on('close', () => {
        resolve({
          success: true,
          path: outputPath,
          size: archive.pointer(),
          files: fileCount,
          errors: errors.length > 0 ? errors : undefined
        });
      });

      archive.on('error', (err) => {
        reject({
          success: false,
          error: err.message
        });
      });

      archive.pipe(outputStream);

      // Añadir cada archivo
      for (const file of files) {
        let sourcePath, destName;

        if (typeof file === 'string') {
          sourcePath = resolvePath(file);
          destName = path.basename(sourcePath);
        } else {
          sourcePath = resolvePath(file.source);
          destName = file.name || path.basename(sourcePath);
        }

        if (fs.existsSync(sourcePath)) {
          const stats = fs.statSync(sourcePath);

          if (stats.isDirectory()) {
            archive.directory(sourcePath, destName);
          } else {
            archive.file(sourcePath, { name: destName });
          }
        } else {
          errors.push(`File not found: ${file.source || file}`);
        }
      }

      archive.finalize();
    });
  },

  /**
   * Añadir directorio al ZIP
   */
  async addDirectory({ source, output, destPath, level = 6 }) {
    const archiverLib = loadArchiver();

    const sourcePath = resolvePath(source);
    const outputPath = resolvePath(output);

    // Verificar que existe el source
    if (!fs.existsSync(sourcePath)) {
      return {
        success: false,
        error: `Source directory not found: ${source}`
      };
    }

    const stats = fs.statSync(sourcePath);
    if (!stats.isDirectory()) {
      return {
        success: false,
        error: `Source is not a directory: ${source}`
      };
    }

    // Crear directorio de salida si no existe
    const outputDir = path.dirname(outputPath);
    await fs.promises.mkdir(outputDir, { recursive: true });

    const zipDestPath = destPath || path.basename(sourcePath);

    return new Promise((resolve, reject) => {
      const outputStream = fs.createWriteStream(outputPath);
      const archive = archiverLib('zip', {
        zlib: { level }
      });

      let fileCount = 0;

      archive.on('entry', () => {
        fileCount++;
      });

      outputStream.on('close', () => {
        resolve({
          success: true,
          path: outputPath,
          size: archive.pointer(),
          files: fileCount
        });
      });

      archive.on('error', (err) => {
        reject({
          success: false,
          error: err.message
        });
      });

      archive.pipe(outputStream);
      archive.directory(sourcePath, zipDestPath);
      archive.finalize();
    });
  }
};
