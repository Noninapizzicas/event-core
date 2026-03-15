/**
 * Local FFmpeg Service
 *
 * Procesamiento de audio/video via ffmpeg CLI.
 * Conversión, recorte, merge, info y waveform.
 *
 * Eventos:
 * - local.ffmpeg.convert.request -> local.ffmpeg.convert.response
 * - local.ffmpeg.trim.request -> local.ffmpeg.trim.response
 * - local.ffmpeg.merge.request -> local.ffmpeg.merge.response
 * - local.ffmpeg.info.request -> local.ffmpeg.info.response
 * - local.ffmpeg.waveform.request -> local.ffmpeg.waveform.response
 *
 * @version 1.0.0
 * @created 2026-02-05
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = path.resolve('./data/media');

function exec(cmd, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message));
      resolve({ stdout, stderr });
    });
  });
}

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

module.exports = {
  name: 'local.ffmpeg',
  description: 'Procesamiento de audio/video via ffmpeg CLI — conversión, recorte, merge, info',

  functions: {
    convert: {
      event: 'local.ffmpeg.convert.request',
      description: 'Convierte formato de audio/video (mp3→wav, mp4→mp3, etc.)',
      input: {
        input: { type: 'string', description: 'Ruta del archivo origen', required: true },
        format: { type: 'string', description: 'Formato destino (mp3, wav, ogg, mp4, webm)', required: true },
        options: { type: 'object', description: '{ bitrate, sampleRate, channels } (opcional)', required: false }
      },
      output: { path: { type: 'string', description: 'Ruta del archivo convertido' } }
    },
    trim: {
      event: 'local.ffmpeg.trim.request',
      description: 'Recorta audio/video por tiempo (start/end)',
      input: {
        input: { type: 'string', description: 'Ruta del archivo', required: true },
        start: { type: 'string', description: 'Tiempo inicio (HH:MM:SS o segundos)', required: false },
        end: { type: 'string', description: 'Tiempo fin', required: false },
        duration: { type: 'string', description: 'Duración desde start', required: false }
      },
      output: { path: { type: 'string', description: 'Ruta del archivo recortado' } }
    },
    merge: {
      event: 'local.ffmpeg.merge.request',
      description: 'Une varios archivos de audio/video',
      input: {
        inputs: { type: 'array', description: 'Array de rutas de archivos', required: true },
        format: { type: 'string', description: 'Formato de salida (default: mismo que input)', required: false }
      },
      output: { path: { type: 'string', description: 'Ruta del archivo unido' } }
    },
    info: {
      event: 'local.ffmpeg.info.request',
      description: 'Información detallada de un archivo multimedia',
      input: {
        input: { type: 'string', description: 'Ruta del archivo', required: true }
      },
      output: {
        duration: { type: 'number', description: 'Duración en segundos' },
        format: { type: 'string', description: 'Formato del contenedor' },
        streams: { type: 'array', description: 'Streams de audio/video' }
      }
    },
    waveform: {
      event: 'local.ffmpeg.waveform.request',
      description: 'Genera imagen de waveform de un archivo de audio',
      input: {
        input: { type: 'string', description: 'Ruta del audio', required: true },
        width: { type: 'number', description: 'Ancho en px (default: 800)', required: false },
        height: { type: 'number', description: 'Alto en px (default: 200)', required: false },
        color: { type: 'string', description: 'Color de la onda (default: #0066ff)', required: false }
      },
      output: { path: { type: 'string', description: 'Ruta de la imagen PNG' } }
    }
  },

  async convert({ input, format, options = {} }) {
    if (!input || !format) return { success: false, error: 'input y format requeridos' };
    if (!fs.existsSync(input)) return { success: false, error: `Archivo no encontrado: ${input}` };
    ensureOutputDir();

    try {
      const basename = path.basename(input, path.extname(input));
      const output = path.join(OUTPUT_DIR, `${basename}_converted.${format}`);
      const args = ['-i', input, '-y'];

      if (options.bitrate) args.push('-b:a', options.bitrate);
      if (options.sampleRate) args.push('-ar', String(options.sampleRate));
      if (options.channels) args.push('-ac', String(options.channels));
      args.push(output);

      await exec('ffmpeg', args);
      const stat = fs.statSync(output);
      return { success: true, data: { path: output, format, size: stat.size } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async trim({ input, start, end, duration }) {
    if (!input) return { success: false, error: 'input es requerido' };
    if (!start && !end && !duration) return { success: false, error: 'Se necesita start, end o duration' };
    if (!fs.existsSync(input)) return { success: false, error: `Archivo no encontrado: ${input}` };
    ensureOutputDir();

    try {
      const ext = path.extname(input);
      const basename = path.basename(input, ext);
      const output = path.join(OUTPUT_DIR, `${basename}_trimmed${ext}`);
      const args = ['-i', input, '-y'];

      if (start) args.push('-ss', start);
      if (end) args.push('-to', end);
      if (duration) args.push('-t', duration);
      args.push('-c', 'copy', output);

      await exec('ffmpeg', args);
      return { success: true, data: { path: output, start, end, duration } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async merge({ inputs, format }) {
    if (!inputs || !Array.isArray(inputs) || inputs.length < 2) {
      return { success: false, error: 'Se necesitan al menos 2 archivos en inputs' };
    }
    for (const f of inputs) {
      if (!fs.existsSync(f)) return { success: false, error: `Archivo no encontrado: ${f}` };
    }
    ensureOutputDir();

    try {
      const ext = format || path.extname(inputs[0]).replace('.', '');
      const output = path.join(OUTPUT_DIR, `merged_${Date.now()}.${ext}`);
      const listFile = path.join(OUTPUT_DIR, `_concat_${Date.now()}.txt`);

      const listContent = inputs.map(f => `file '${path.resolve(f)}'`).join('\n');
      fs.writeFileSync(listFile, listContent);

      await exec('ffmpeg', ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', output]);
      fs.unlinkSync(listFile);

      return { success: true, data: { path: output, inputCount: inputs.length } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async info({ input }) {
    if (!input) return { success: false, error: 'input es requerido' };
    if (!fs.existsSync(input)) return { success: false, error: `Archivo no encontrado: ${input}` };

    try {
      const { stdout } = await exec('ffprobe', [
        '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', input
      ]);
      const data = JSON.parse(stdout);
      return {
        success: true,
        data: {
          duration: parseFloat(data.format?.duration || 0),
          size: parseInt(data.format?.size || 0, 10),
          bitrate: parseInt(data.format?.bit_rate || 0, 10),
          format: data.format?.format_name,
          streams: (data.streams || []).map(s => ({
            type: s.codec_type,
            codec: s.codec_name,
            sampleRate: s.sample_rate ? parseInt(s.sample_rate, 10) : undefined,
            channels: s.channels,
            width: s.width,
            height: s.height,
            fps: s.r_frame_rate
          }))
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async waveform({ input, width = 800, height = 200, color = '#0066ff' }) {
    if (!input) return { success: false, error: 'input es requerido' };
    if (!fs.existsSync(input)) return { success: false, error: `Archivo no encontrado: ${input}` };
    ensureOutputDir();

    try {
      const output = path.join(OUTPUT_DIR, `waveform_${Date.now()}.png`);
      await exec('ffmpeg', [
        '-i', input, '-y',
        '-filter_complex', `aformat=channel_layouts=mono,showwavespic=s=${width}x${height}:colors=${color}`,
        '-frames:v', '1', output
      ]);
      return { success: true, data: { path: output, width, height } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};
