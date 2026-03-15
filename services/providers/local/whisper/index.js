/**
 * Local Whisper Service
 *
 * Transcripción de audio usando OpenAI Whisper (CLI local).
 * Requiere whisper instalado: pip install openai-whisper
 * Soporta modelos: tiny, base, small, medium, large.
 *
 * Eventos:
 * - local.whisper.transcribe.request -> local.whisper.transcribe.response
 * - local.whisper.detect-language.request -> local.whisper.detect-language.response
 *
 * @version 1.0.0
 * @created 2026-02-05
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(process.cwd(), 'data', 'transcriptions');
const DEFAULT_MODEL = 'base';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function runWhisper(args, timeout = 300000) {
  return new Promise((resolve, reject) => {
    execFile('whisper', args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 'ENOENT') {
          return reject(new Error('whisper no encontrado. Instalar: pip install openai-whisper'));
        }
        return reject(new Error(error.message));
      }
      resolve({ stdout, stderr });
    });
  });
}

function checkWhisperInstalled() {
  return new Promise((resolve) => {
    execFile('whisper', ['--help'], { timeout: 5000 }, (error) => {
      resolve(!error);
    });
  });
}

module.exports = {
  name: 'local.whisper',
  description: 'Transcripción de audio con Whisper — speech-to-text local',

  functions: {
    transcribe: {
      event: 'local.whisper.transcribe.request',
      description: 'Transcribe un archivo de audio a texto',
      input: {
        file: { type: 'string', description: 'Ruta al archivo de audio (mp3, wav, m4a, etc.)', required: true },
        model: { type: 'string', description: 'Modelo: tiny, base, small, medium, large (default: base)', required: false },
        language: { type: 'string', description: 'Código idioma (es, en, etc.) — auto si se omite', required: false },
        format: { type: 'string', description: 'Formato salida: txt, srt, vtt, json (default: txt)', required: false },
        task: { type: 'string', description: 'transcribe o translate (a inglés)', required: false }
      },
      output: {
        text: { type: 'string', description: 'Texto transcrito' },
        language: { type: 'string', description: 'Idioma detectado' },
        outputFile: { type: 'string', description: 'Ruta del archivo de salida' },
        duration: { type: 'string', description: 'Duración del proceso' }
      }
    },
    'detect-language': {
      event: 'local.whisper.detect-language.request',
      description: 'Detecta el idioma de un archivo de audio',
      input: {
        file: { type: 'string', description: 'Ruta al archivo de audio', required: true },
        model: { type: 'string', description: 'Modelo a usar (default: base)', required: false }
      },
      output: {
        language: { type: 'string', description: 'Código de idioma detectado' },
        confidence: { type: 'string', description: 'Probabilidades por idioma' }
      }
    }
  },

  async transcribe({ file, model, language, format = 'txt', task = 'transcribe' }) {
    if (!file) return { success: false, error: 'file es requerido' };
    if (!fs.existsSync(file)) return { success: false, error: `Archivo no encontrado: ${file}` };

    const installed = await checkWhisperInstalled();
    if (!installed) return { success: false, error: 'whisper no instalado. Ejecutar: pip install openai-whisper' };

    const validFormats = ['txt', 'srt', 'vtt', 'json', 'tsv'];
    if (!validFormats.includes(format)) {
      return { success: false, error: `Formato debe ser: ${validFormats.join(', ')}` };
    }

    try {
      ensureDir(OUTPUT_DIR);
      const startTime = Date.now();
      const args = [
        file,
        '--model', model || DEFAULT_MODEL,
        '--output_format', format,
        '--output_dir', OUTPUT_DIR,
        '--task', task === 'translate' ? 'translate' : 'transcribe'
      ];
      if (language) {
        args.push('--language', language);
      }

      const { stderr } = await runWhisper(args);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      // Buscar archivo de salida
      const baseName = path.basename(file, path.extname(file));
      const outputFile = path.join(OUTPUT_DIR, `${baseName}.${format}`);

      let text = '';
      if (fs.existsSync(outputFile)) {
        text = fs.readFileSync(outputFile, 'utf8').trim();
      }

      // Extraer idioma detectado del stderr
      const langMatch = stderr.match(/Detected language:\s*(\w+)/i);
      const detectedLang = langMatch ? langMatch[1] : language || 'unknown';

      return {
        success: true,
        data: {
          text: text.substring(0, 10000),
          language: detectedLang,
          outputFile,
          format,
          model: model || DEFAULT_MODEL,
          duration: `${elapsed}s`,
          charCount: text.length
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async 'detect-language'({ file, model }) {
    if (!file) return { success: false, error: 'file es requerido' };
    if (!fs.existsSync(file)) return { success: false, error: `Archivo no encontrado: ${file}` };

    const installed = await checkWhisperInstalled();
    if (!installed) return { success: false, error: 'whisper no instalado. Ejecutar: pip install openai-whisper' };

    try {
      ensureDir(OUTPUT_DIR);
      // Usar whisper con output mínimo solo para detectar idioma
      const args = [
        file,
        '--model', model || 'tiny',
        '--output_format', 'txt',
        '--output_dir', OUTPUT_DIR,
        '--task', 'transcribe'
      ];

      const { stderr } = await runWhisper(args, 120000);

      const langMatch = stderr.match(/Detected language:\s*(\w+)/i);
      const language = langMatch ? langMatch[1] : 'unknown';

      // Buscar probabilidades en stderr
      const probabilities = {};
      const probMatches = stderr.matchAll(/(\w{2,})\s*:\s*([\d.]+)/g);
      for (const m of probMatches) {
        const prob = parseFloat(m[2]);
        if (prob > 0.01) probabilities[m[1]] = prob;
      }

      return {
        success: true,
        data: {
          language,
          probabilities: Object.keys(probabilities).length > 0 ? probabilities : undefined,
          model: model || 'tiny'
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};
