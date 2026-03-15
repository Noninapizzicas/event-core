# Prompts Especializados - Event Core

Este directorio contiene los 15 prompts especializados que guían el desarrollo del Event Core.

## 📋 Índice de Prompts

### **Estrategia y Producto**
- `estratega_producto_y_roadmap_v1.1.0.json` - Vision, OKRs, roadmap, priorización

### **Arquitectura**
- `arquitecto_event_driven_y_messaging_v1.1.0.json` - Event-driven architecture, MQTT, messaging patterns
- `arquitecto_experiencia_usuario_y_usabilidad_v1.1.0.json` - UX, onboarding, user journeys
- `arquitecto_productividad_y_dx_v1.1.0.json` - Developer experience, CLI, tooling
- `arquitecto_seguridad_y_cumplimiento_v1.1.0.json` - Security-first, compliance, audit

### **Gestión y Gobernanza**
- `gestor_feedback_y_mejora_continua_v1.1.0.json` - Feedback loops, retrospectivas, mejora continua
- `gestor_gobernanza_y_evolucion_v1.1.0.json` - Versionado, contratos, deprecación, RFCs

### **Implementación**
- `orquestador_implementacion_modulos_v1.1.0.json` - Implementación de módulos, testing, CI/CD
- `generador_contratos_y_esqueletos_v1.1.0.json` - Generación de contratos, scaffolding
- `disenador_flujo_entre_modulos_v1.1.0.json` - Diseño de flujos inter-módulos

### **Operaciones**
- `coordinador_instalacion_y_puesta_en_marcha_por_entornos_v1.1.0.json` - Setup, deployment, entornos
- `operador_despliegue_y_observabilidad_v1.1.0.json` - Deploy, monitoring, logs, traces
- `optimizador_rendimiento_y_escalabilidad_v1.1.0.json` - Performance tuning, caching, profiling

### **Documentación**
- `curador_documentacion_y_conocimiento_v1.1.0.json` - Docs técnicas, knowledge base, ejemplos

### **Herramientas**
- `stack_decision_tool.json` - Decisiones de tecnología, trade-offs, análisis

### **Guías y Ejemplos (Markdown)**
- `EJEMPLO_crear_app_modular.md` - Ejemplo práctico de aplicación modular
- `GUIA_seleccion_stack_por_modulo.md` - Guía para seleccionar stack técnico por módulo
- `implementation_prompt.md` - Prompt para implementación
- `prompt_diseño_modular.md` - Prompt para diseño modular
- `validador-integracion.md` - Validador de integración entre módulos

---

## 🔄 Flujo de Trabajo con Prompts

```
1. Estratega Producto      → Define vision, OKRs, roadmap
2. Arquitecto Event-Driven → Diseña arquitectura MQTT + event-driven
3. Gestor Gobernanza       → Define contratos, versionado, políticas
4. Generador Contratos     → Crea schemas, esqueletos
5. Orquestador Implementa  → Implementa módulos
6. Operador Observabilidad → Añade logs, traces, métricas
7. Optimizador Performance → Optimiza latencia, throughput
8. Curador Documentación   → Genera docs completas
```

---

## 📊 Outputs Generados

Cada prompt genera deliverables en ubicaciones estándar:

- **Estratega Producto** → `../.strategy/v1/`
- **Gestor Gobernanza** → `../governance/v1/`
- **Arquitecto UX/DX** → `../ux/v1/`
- **Operador Observabilidad** → `../observability/v1/`

Ver estructura completa en `/event-core/README.md`

---

## 🚀 Uso

```bash
# Cargar un prompt en Claude Code
claude load-prompt .prompts/estratega_producto_y_roadmap_v1.1.0.json

# O manualmente
cat .prompts/estratega_producto_y_roadmap_v1.1.0.json
```

---

**Versión:** 1.1.0
**Última actualización:** 2025-10-06
