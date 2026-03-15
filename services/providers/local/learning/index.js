/**
 * Provider: local.learning
 *
 * Sistema de aprendizaje genérico y reutilizable.
 * Almacena experiencias/feedback de cualquier proceso o agente.
 * Permite consultar casos similares y obtener estadísticas.
 *
 * FILOSOFÍA: Simple, robusto, reutilizable.
 *
 * Estructura de datos:
 *   data/learning/{dominio}/
 *     - experiencias.jsonl  (una experiencia por línea)
 *     - estadisticas.json   (cache de stats)
 *
 * Cada experiencia tiene:
 *   - id: único
 *   - timestamp: cuándo ocurrió
 *   - contexto: datos de entrada (para matching)
 *   - accion: qué se hizo
 *   - resultado: cómo salió
 *   - feedback: evaluación (score, comentario)
 *   - tags: etiquetas para búsqueda
 *
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Directorio base de aprendizaje
const LEARNING_DIR = path.join(process.cwd(), 'data/learning');

/**
 * Asegura que existe el directorio del dominio
 */
function ensureDomainDir(dominio) {
  const dir = path.join(LEARNING_DIR, dominio);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Lee todas las experiencias de un dominio
 */
function readExperiencias(dominio) {
  const filePath = path.join(LEARNING_DIR, dominio, 'experiencias.jsonl');
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Calcula similitud entre dos contextos
 * Devuelve un score de 0 a 1
 */
function calcularSimilitud(contexto1, contexto2, campos = []) {
  if (!contexto1 || !contexto2) return 0;

  // Si se especifican campos, comparar solo esos
  const keys = campos.length > 0
    ? campos
    : [...new Set([...Object.keys(contexto1), ...Object.keys(contexto2)])];

  let matches = 0;
  let comparisons = 0;

  for (const key of keys) {
    const val1 = contexto1[key];
    const val2 = contexto2[key];

    if (val1 === undefined || val2 === undefined) continue;

    comparisons++;

    if (typeof val1 === 'number' && typeof val2 === 'number') {
      // Para números, similitud basada en diferencia relativa
      const max = Math.max(Math.abs(val1), Math.abs(val2), 1);
      const diff = Math.abs(val1 - val2) / max;
      matches += Math.max(0, 1 - diff);
    } else if (typeof val1 === 'string' && typeof val2 === 'string') {
      // Para strings, comparar igualdad o contención
      if (val1 === val2) {
        matches += 1;
      } else if (val1.includes(val2) || val2.includes(val1)) {
        matches += 0.5;
      }
    } else if (Array.isArray(val1) && Array.isArray(val2)) {
      // Para arrays, calcular intersección
      const set1 = new Set(val1);
      const set2 = new Set(val2);
      const intersection = [...set1].filter(x => set2.has(x));
      const union = new Set([...val1, ...val2]);
      matches += union.size > 0 ? intersection.length / union.size : 0;
    } else if (val1 === val2) {
      matches += 1;
    }
  }

  return comparisons > 0 ? matches / comparisons : 0;
}

module.exports = {
  name: 'local.learning',

  functions: {
    /**
     * Guardar una experiencia/feedback
     */
    save: {
      handler: async ({ dominio, contexto, accion, resultado, feedback, tags = [] }) => {
        if (!dominio) {
          return { success: false, error: 'Dominio requerido' };
        }

        const dir = ensureDomainDir(dominio);
        const filePath = path.join(dir, 'experiencias.jsonl');

        const experiencia = {
          id: crypto.randomBytes(8).toString('hex'),
          timestamp: new Date().toISOString(),
          dominio,
          contexto: contexto || {},
          accion: accion || {},
          resultado: resultado || {},
          feedback: feedback || {},
          tags: Array.isArray(tags) ? tags : [tags]
        };

        // Append al archivo JSONL
        fs.appendFileSync(filePath, JSON.stringify(experiencia) + '\n');

        // Invalidar cache de estadísticas
        const statsPath = path.join(dir, 'estadisticas.json');
        if (fs.existsSync(statsPath)) {
          fs.unlinkSync(statsPath);
        }

        return {
          success: true,
          id: experiencia.id,
          dominio
        };
      }
    },

    /**
     * Buscar experiencias similares
     */
    query: {
      handler: async ({
        dominio,
        contexto,
        camposSimilitud = [],
        limite = 10,
        minSimilitud = 0.3,
        tags = [],
        soloExitosos = false
      }) => {
        if (!dominio) {
          return { success: false, error: 'Dominio requerido' };
        }

        const experiencias = readExperiencias(dominio);

        if (experiencias.length === 0) {
          return {
            success: true,
            total: 0,
            resultados: [],
            mensaje: 'Sin experiencias previas'
          };
        }

        // Filtrar por tags si se especifican
        let filtradas = experiencias;
        if (tags.length > 0) {
          const tagsSet = new Set(tags);
          filtradas = filtradas.filter(exp =>
            exp.tags && exp.tags.some(t => tagsSet.has(t))
          );
        }

        // Filtrar solo exitosos si se pide
        if (soloExitosos) {
          filtradas = filtradas.filter(exp =>
            exp.feedback?.exito === true ||
            exp.feedback?.score > 0.7 ||
            exp.resultado?.success === true
          );
        }

        // Calcular similitud si hay contexto de búsqueda
        if (contexto && Object.keys(contexto).length > 0) {
          filtradas = filtradas.map(exp => ({
            ...exp,
            _similitud: calcularSimilitud(contexto, exp.contexto, camposSimilitud)
          }));

          // Filtrar por umbral de similitud
          filtradas = filtradas.filter(exp => exp._similitud >= minSimilitud);

          // Ordenar por similitud descendente
          filtradas.sort((a, b) => b._similitud - a._similitud);
        } else {
          // Sin contexto, ordenar por timestamp descendente (más recientes primero)
          filtradas.sort((a, b) =>
            new Date(b.timestamp) - new Date(a.timestamp)
          );
        }

        // Limitar resultados
        const resultados = filtradas.slice(0, limite);

        return {
          success: true,
          total: filtradas.length,
          resultados,
          dominio
        };
      }
    },

    /**
     * Obtener estadísticas de un dominio
     */
    stats: {
      handler: async ({ dominio, regenerar = false }) => {
        if (!dominio) {
          return { success: false, error: 'Dominio requerido' };
        }

        const dir = path.join(LEARNING_DIR, dominio);
        const statsPath = path.join(dir, 'estadisticas.json');

        // Usar cache si existe y no se pide regenerar
        if (!regenerar && fs.existsSync(statsPath)) {
          const cached = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
          return { success: true, cached: true, ...cached };
        }

        const experiencias = readExperiencias(dominio);

        if (experiencias.length === 0) {
          return {
            success: true,
            total: 0,
            mensaje: 'Sin experiencias'
          };
        }

        // Calcular estadísticas
        const exitosos = experiencias.filter(e =>
          e.feedback?.exito === true ||
          e.feedback?.score > 0.7 ||
          e.resultado?.success === true
        );

        const conScore = experiencias.filter(e =>
          typeof e.feedback?.score === 'number'
        );

        const promedioScore = conScore.length > 0
          ? conScore.reduce((sum, e) => sum + e.feedback.score, 0) / conScore.length
          : null;

        // Contar por tags
        const tagCounts = {};
        experiencias.forEach(e => {
          (e.tags || []).forEach(tag => {
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          });
        });

        // Contar por día (últimos 30 días)
        const porDia = {};
        const hace30Dias = new Date();
        hace30Dias.setDate(hace30Dias.getDate() - 30);

        experiencias.forEach(e => {
          const fecha = e.timestamp?.substring(0, 10);
          if (fecha && new Date(fecha) >= hace30Dias) {
            porDia[fecha] = (porDia[fecha] || 0) + 1;
          }
        });

        const stats = {
          dominio,
          total: experiencias.length,
          exitosos: exitosos.length,
          tasaExito: experiencias.length > 0
            ? (exitosos.length / experiencias.length * 100).toFixed(1) + '%'
            : 'N/A',
          promedioScore,
          tags: tagCounts,
          actividadReciente: porDia,
          primeraExperiencia: experiencias[0]?.timestamp,
          ultimaExperiencia: experiencias[experiencias.length - 1]?.timestamp,
          generadoEn: new Date().toISOString()
        };

        // Guardar cache
        ensureDomainDir(dominio);
        fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));

        return { success: true, cached: false, ...stats };
      }
    },

    /**
     * Listar dominios disponibles
     */
    domains: {
      handler: async () => {
        if (!fs.existsSync(LEARNING_DIR)) {
          return { success: true, dominios: [] };
        }

        const entries = fs.readdirSync(LEARNING_DIR, { withFileTypes: true });
        const dominios = entries
          .filter(e => e.isDirectory())
          .map(e => {
            const expPath = path.join(LEARNING_DIR, e.name, 'experiencias.jsonl');
            let count = 0;
            if (fs.existsSync(expPath)) {
              const content = fs.readFileSync(expPath, 'utf8');
              count = content.split('\n').filter(l => l.trim()).length;
            }
            return {
              nombre: e.name,
              experiencias: count
            };
          });

        return {
          success: true,
          dominios,
          total: dominios.length
        };
      }
    },

    /**
     * Obtener la mejor acción para un contexto dado
     * Basado en experiencias exitosas similares
     */
    'best-action': {
      handler: async ({ dominio, contexto, camposSimilitud = [] }) => {
        if (!dominio || !contexto) {
          return { success: false, error: 'Dominio y contexto requeridos' };
        }

        const experiencias = readExperiencias(dominio);

        // Filtrar solo experiencias exitosas
        const exitosas = experiencias.filter(e =>
          e.feedback?.exito === true ||
          e.feedback?.score > 0.7 ||
          e.resultado?.success === true
        );

        if (exitosas.length === 0) {
          return {
            success: true,
            encontrado: false,
            mensaje: 'Sin experiencias exitosas previas'
          };
        }

        // Calcular similitud y encontrar la mejor
        const conSimilitud = exitosas.map(exp => ({
          ...exp,
          _similitud: calcularSimilitud(contexto, exp.contexto, camposSimilitud)
        }));

        conSimilitud.sort((a, b) => b._similitud - a._similitud);

        const mejor = conSimilitud[0];

        if (mejor._similitud < 0.3) {
          return {
            success: true,
            encontrado: false,
            mensaje: 'No hay experiencias suficientemente similares',
            mejorSimilitud: mejor._similitud
          };
        }

        return {
          success: true,
          encontrado: true,
          similitud: mejor._similitud,
          accionRecomendada: mejor.accion,
          contextoOriginal: mejor.contexto,
          resultadoObtenido: mejor.resultado,
          experienciaId: mejor.id
        };
      }
    }
  }
};
