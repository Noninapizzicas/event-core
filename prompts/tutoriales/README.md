# 🎯 Prompts Maestros - Event Core

Colección de **prompts ejecutables** para implementar funcionalidades completas en Event Core. Estos prompts están diseñados para ser copiados y pegados directamente a un agente IA (Claude, GPT, etc.) y obtener código funcional como resultado.

---

## 📌 ¿Qué son estos prompts?

Son **instrucciones completas y ejecutables** que un agente IA puede seguir para:
1. **Crear** archivos y estructura
2. **Implementar** código funcional
3. **Retornar** resultados en formato estructurado
4. **Aplicar** reglas operativas específicas
5. **Consolidar** el estado final

---

## 🗂️ Prompts disponibles

### 1. [Crear Módulo con APIs](./prompt_crear_modulo_apis.md)
**Prompt para:** Implementar módulos funcionales con APIs REST, eventos y hooks.

**Complejidad:** 3-13 Story Points
**Lo que obtienes:**
- Estructura completa del módulo
- APIs CRUD funcionales
- Integración con eventos MQTT
- Logging y métricas
- Documentación completa

**Usar cuando:**
- Necesitas crear un nuevo módulo desde cero
- Quieres agregar APIs REST a tu módulo
- Necesitas ejemplos de TODO List o User Management

---

### 2. [Sistema de Validación](./prompt_sistema_validacion.md)
**Prompt para:** Implementar validación completa usando JSON Schema (AJV).

**Complejidad:** 2-8 Story Points
**Lo que obtienes:**
- Schemas JSON Schema inline y reutilizables
- Validación automática en HTTP Gateway
- Validadores personalizados
- Mensajes de error estructurados

**Usar cuando:**
- Necesitas validar input de usuarios
- Quieres crear schemas reutilizables
- Necesitas validadores con lógica de negocio

---

### 3. [MQTT y Event Bus](./prompt_mqtt_event_bus.md)
**Prompt para:** Implementar comunicación basada en eventos usando MQTT pub/sub.

**Complejidad:** 2-13 Story Points
**Lo que obtienes:**
- Publicación de eventos desde módulos
- Suscripción a eventos de otros módulos
- Trazabilidad con correlation IDs
- Patrones avanzados (request/response, DLQ)

**Usar cuando:**
- Necesitas desacoplar módulos
- Quieres crear flujos reactivos
- Necesitas rastrear operaciones distribuidas

---

### 4. [UI JSON-Driven](./prompt_ui_json_driven.md)
**Prompt para:** Crear interfaces gráficas automáticas usando configuración JSON.

**Complejidad:** 5-13 Story Points
**Lo que obtienes:**
- Vista de tabla con paginación y búsqueda
- Formularios con validación automática
- Vista de detalle con secciones
- Dashboard con widgets y métricas

**Usar cuando:**
- Necesitas UI sin escribir HTML/CSS/JS
- Quieres generar CRUDs visuales rápidamente
- Necesitas dashboards de monitoreo

---

### 5. [Logging y Métricas](./prompt_logging_metricas.md)
**Prompt para:** Implementar observabilidad completa con logging estructurado y métricas.

**Complejidad:** 2-8 Story Points
**Lo que obtienes:**
- Logging estructurado en JSON
- Métricas de negocio (counters, gauges, timings)
- Trazabilidad con correlation IDs
- Endpoints de monitoreo (/metrics, /health)

**Usar cuando:**
- Necesitas monitorear módulos en producción
- Quieres rastrear operaciones distribuidas
- Necesitas detectar problemas de performance

---

### 6. [Sistema de Hooks](./prompt_sistema_hooks.md)
**Prompt para:** Implementar interceptores para funcionalidad cross-cutting.

**Complejidad:** 2-8 Story Points
**Lo que obtienes:**
- Hooks de ciclo de vida (onLoad, onUnload)
- Hooks de request (beforeRequest, afterRequest)
- Autenticación y autorización
- Transformaciones de datos

**Usar cuando:**
- Necesitas implementar autenticación
- Quieres agregar rate limiting
- Necesitas transformar requests/responses

---

### 7. [Crear Componente UI](./prompt_crear_componente_ui.md)
**Prompt para:** Crear componentes UI totalmente funcionales con HTML, CSS y JavaScript vanilla.

**Complejidad:** 2-13 Story Points
**Lo que obtienes:**
- Especificación JSON del componente
- HTML semántico y accesible
- CSS modular con estados y transiciones
- JavaScript vanilla con gestión de estado
- Integración con Event Core (APIs + MQTT)
- Documentación completa con ejemplos

**Usar cuando:**
- Necesitas crear un componente UI reutilizable
- Quieres componentes con actualización en tiempo real (MQTT)
- Necesitas componentes accesibles y responsive
- Quieres integración completa con Event Core

---

## 🚀 Cómo usar estos prompts

### Método 1: Copiar y pegar a IA
```bash
# 1. Abrir el prompt que necesitas
cat prompt_crear_modulo_apis.md

# 2. Copiar TODO el contenido

# 3. Pegar en Claude/GPT/etc. con tu contexto:
"""
[PEGAR CONTENIDO DEL PROMPT]

Contexto adicional:
- Nombre del módulo: product-catalog
- Funcionalidad: CRUD de productos con categorías
- Autenticación: Sí, solo admin puede crear/editar/eliminar
"""

# 4. El agente retornará código completo funcional
```

### Método 2: Usar como checklist
```bash
# 1. Leer el prompt completo
# 2. Seguir las fases de implementación en orden
# 3. Implementar manualmente siguiendo ejemplos
# 4. Verificar con el checklist de entrega
```

### Método 3: Referencia rápida
```bash
# Consultar cuando necesites:
# - Estructura esperada
# - Ejemplos de código
# - Buenas prácticas
# - Comandos de prueba
```

---

## 📊 Matriz de complejidad

| Prompt | Fase Básica | Fase Avanzada | SP Total | Tiempo |
|--------|-------------|---------------|----------|--------|
| Módulo con APIs | 3 SP | 13 SP | 3-13 | 1h - 2d |
| Validación | 2 SP | 8 SP | 2-8 | 30m - 5h |
| MQTT/Event Bus | 2 SP | 13 SP | 2-13 | 30m - 2d |
| UI JSON-Driven | 5 SP | 13 SP | 5-13 | 2h - 2d |
| Logging/Métricas | 2 SP | 8 SP | 2-8 | 30m - 5h |
| Hooks | 2 SP | 8 SP | 2-8 | 30m - 5h |
| Componente UI | 2 SP | 13 SP | 2-13 | 30m - 2d |

---

## 🎓 Rutas de aprendizaje

### Para principiantes
```
1. prompt_crear_modulo_apis.md (Fase 1: TODO List básico)
2. prompt_sistema_validacion.md (Fase 1-2: Validación inline)
3. prompt_logging_metricas.md (Fase 1-2: Logging básico)

Tiempo total: ~3-4 horas
```

### Para desarrolladores intermedios
```
1. prompt_crear_modulo_apis.md (Fase 2: User Management)
2. prompt_sistema_hooks.md (Fase 1-3: Autenticación)
3. prompt_mqtt_event_bus.md (Fase 1-3: Pub/Sub con trazabilidad)
4. prompt_ui_json_driven.md (Fase 1-3: Vistas automáticas)

Tiempo total: ~1-2 días
```

### Para desarrolladores avanzados
```
1. prompt_crear_modulo_apis.md (Fase 3: Con persistencia)
2. prompt_mqtt_event_bus.md (Fase 4: Patrones avanzados)
3. prompt_ui_json_driven.md (Fase 4: Dashboards)
4. prompt_logging_metricas.md (Fase 5: Dashboard completo)
5. prompt_sistema_hooks.md (Fase 6: Hooks personalizados)

Tiempo total: ~2-3 días
```

---

## ✨ Diferencia con tutoriales/

| Aspecto | tutoriales/ | prompts/tutoriales/ |
|---------|-------------|---------------------|
| **Formato** | Documentación educativa | Prompts ejecutables |
| **Tono** | "Aprende cómo..." | "Implementa esto..." |
| **Estructura** | Explicativa | Imperativa |
| **Salida** | Conocimiento | Código funcional |
| **Target** | Humanos aprendiendo | Agentes IA ejecutando |
| **Uso** | Lectura y estudio | Copiar/pegar a IA |

**Ejemplo:**

**Tutorial (tutoriales/):**
```markdown
## Objetivo
Este tutorial te enseña cómo crear módulos...

### Paso 1
Primero, crea el directorio...
```

**Prompt (prompts/tutoriales/):**
```markdown
## 🎯 Objetivo General
Implementar un módulo funcional...

Debes crear:
- module.json con APIs
- index.js con handlers
...

## 🧭 Formato de salida esperado
1. Resumen ejecutivo
2. Lista de archivos creados
3. Contenido completo...
```

---

## 📋 Estructura de cada prompt

Todos los prompts siguen esta estructura:

1. **Rol activo** - Especialista en el tema
2. **Objetivo General** - Qué implementar (imperativo)
3. **Estructura esperada** - Organización de archivos
4. **Fases de implementación** - Paso a paso con SP y tiempo
5. **Buenas prácticas** - Patrones recomendados
6. **Checklist de entrega** - Verificación de completitud
7. **Ejemplos completos** - Código funcional listo
8. **Pruebas** - Comandos curl y verificación
9. **Convenciones** - Estándares del sistema
10. **Formato de salida esperado** - Qué retornar
11. **Reglas operativas** - Cómo trabajar
12. **Capa de consolidación** - Estado final

---

## 🔧 Personalización de prompts

Para adaptar un prompt a tu caso específico:

```markdown
[COPIAR CONTENIDO COMPLETO DEL PROMPT]

---
## CONTEXTO ESPECÍFICO

**Nombre del módulo:** mi-modulo
**Funcionalidad:** [describir]
**Endpoints necesarios:** [listar]
**Autenticación:** Sí/No
**Persistencia:** Sí/No (SQLite/PostgreSQL/MongoDB)
**UI:** Sí/No

**Requisitos adicionales:**
- [Listar requisitos específicos]

**Restricciones:**
- [Listar restricciones]
```

---

## 🧪 Verificación de resultados

Cada prompt incluye un **checklist de entrega** y **comandos de prueba**.

Después de ejecutar el prompt:
1. Verificar que todos los archivos fueron creados
2. Ejecutar comandos `curl` de prueba
3. Revisar logs y métricas
4. Marcar checklist como ✅ o ❌
5. Verificar capa de consolidación

---

## 📚 Referencias

- **Event Core Docs:** `docs/`
- **Tutoriales (educativos):** `tutoriales/`
- **Módulos de ejemplo:** `modules/echo/`, `modules/file-watcher/`
- **Core del sistema:** `core/`

---

## 🤝 Contribuir

Para agregar un nuevo prompt:

1. Seguir la estructura estándar (ver prompts existentes)
2. Incluir todas las secciones obligatorias
3. Proporcionar ejemplos completos y funcionales
4. Probar el prompt con un agente IA
5. Actualizar este README

---

## ⚖️ Licencia

Misma licencia que Event Core.

---

## 👥 Autores

**Event Core Team**

---

**Versión:** 1.0.0
**Fecha:** 2025-01-14
**Compatible con:** Event Core v0.5.0+

---

**¡Copia, pega y genera código funcional! 🚀**
