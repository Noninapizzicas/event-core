# Event-Core v2 — Manifiesto de Migración

> Generado: 2026-03-15
> Repo origen: `event-core` (se conserva intacto para referencia histórica)
> Repo destino: **ENKI**

---

## 1. MÓDULOS EXCLUIDOS (8)

| Módulo | Razón |
|--------|-------|
| `conversation-manager` | Deprecated — reemplazado por chat-session + chat-ai-bridge + prompt-composer |
| `metricas` | Excluido por decisión de producto |
| `dashboard` | Excluido por decisión de producto |
| `admin-panel` | Excluido por decisión de producto |
| `scratch-designer` | Excluido por decisión de producto |
| `ui-designer` | Excluido por decisión de producto |
| `notas` | Excluido por decisión de producto |
| `facturacion` | Incompleto (sin module.json) |

---

## 2. MÓDULOS INCLUIDOS (32)

### 2.1 Core Infrastructure (6)
| Módulo | Versión | Descripción |
|--------|---------|-------------|
| `database-manager` | 2.0.0 | SQLite con sql.js — persistencia de todo el sistema |
| `project-manager` | 3.0.0 | CRUD de proyectos, sesión activa, features/blueprints |
| `credential-manager` | 2.1.0 | Gestión multi-nivel de credenciales (.env) |
| `filesystem` | 1.0.0 | Operaciones de filesystem del sistema |
| `log-manager` | 2.0.0 | Logs centralizados por sesión |
| `scheduler` | 1.0.0 | Jobs con cron, interval, datetime, event-based, composite |

### 2.2 AI Stack (6)
| Módulo | Versión | Descripción |
|--------|---------|-------------|
| `ai-gateway` | 1.0.0 | Gateway unificado multi-proveedor LLM |
| `ai-agent-framework` | 1.0.0 | Framework de agentes IA event-driven |
| `prompt-manager` | 2.0.0 | Gestión de prompts con versionado, slots, presets |
| `prompt-composer` | 1.1.0 | Composición de system prompts con contexto |
| `chat-ai-bridge` | 1.0.0 | Puente chat↔AI que coordina el flujo completo |
| `code-executor` | 1.0.0 | Ejecución de comandos shell para AI |

### 2.3 Chat & Session (1)
| Módulo | Versión | Descripción |
|--------|---------|-------------|
| `chat-session` | 1.0.0 | Persistencia de conversaciones y mensajes |

### 2.4 Agent & Bot (3)
| Módulo | Versión | Descripción |
|--------|---------|-------------|
| `agent-manager` | 1.0.0 | Orquestación de agentes, pipelines, triggers |
| `bot-manager` | 1.0.0 | Gestión de bots, descargas, auto-responder |
| `channel-manager` | 1.0.0 | Registry de canales externos → proyectos |

### 2.5 Communication (1)
| Módulo | Versión | Descripción |
|--------|---------|-------------|
| `telegram-service` | 3.0.0 | Servicio multi-bot Telegram |

### 2.6 Composition & Context (2)
| Módulo | Versión | Descripción |
|--------|---------|-------------|
| `composition-manager` | 1.0.0 | Composición genérica de entidades |
| `context-manager` | 1.0.0 | Contexto compartido entre entidades |

### 2.7 Security (2)
| Módulo | Versión | Descripción |
|--------|---------|-------------|
| `certificate-authority` | 1.0.0 | CA interna con mTLS |
| `security-p2p` | 1.0.0 | Zero Trust P2P con E2E encryption |

### 2.8 Tools & Utilities (4)
| Módulo | Versión | Descripción |
|--------|---------|-------------|
| `plugin-manager` | 2.0.0 | Descubrimiento y gestión de plugins JSON |
| `calling-generator` | 2.0.0 | Genera funciones ejecutables desde plugins |
| `text-editor` | 1.0.0 | Editor MD/JSON con syntax highlighting |
| `pdf-viewer` | 1.0.0 | Visor PDF y extracción de texto |

### 2.9 Dev Only (1)
| Módulo | Versión | Descripción |
|--------|---------|-------------|
| `system-inspector` | 1.0.0 | Captura estado del sistema para IA (dev_only) |

### 2.10 Business — Alimentación (5)
| Módulo | Versión | Descripción |
|--------|---------|-------------|
| `pizzepos` | composite | Sistema POS completo (17 sub-módulos) |
| `recetas` | 1.0.0 | Gestión de recetas e ingredientes |
| `escandallo` | 1.0.0 | Análisis de costes y food cost |
| `viabilidad` | 1.0.0 | Estudio de viabilidad de negocio |
| `facturas` | 1.0.0 | Procesamiento de facturas → datos estructurados |

### 2.11 Business — Personal (1)
| Módulo | Versión | Descripción |
|--------|---------|-------------|
| `staff-manager` | 1.0.0 | Control de personal con NFC |

---

## 3. ARCHIVOS RAÍZ

### 3.1 INCLUIR
| Archivo/Dir | Descripción |
|-------------|-------------|
| `package.json` | Dependencias del proyecto |
| `package-lock.json` | Lock de dependencias |
| `config.example.json` | Ejemplo de configuración |
| `config.json` | Config activa (regenerar limpia) |
| `.env.example` | Variables de entorno ejemplo |
| `.gitignore` | Git ignore |
| `.dockerignore` | Docker ignore |
| `Dockerfile` | Contenedor Docker |
| `start.sh` | Script de arranque |
| `stop.sh` | Script de parada |
| `restart.sh` | Script de reinicio |
| `dev.sh` | Script de desarrollo |
| `deploy.sh` | Script de despliegue |
| `setup-vps.sh` | Setup de VPS |
| `README.md` | Documentación principal (REESCRIBIR) |
| `INSTALL.md` | Guía de instalación |
| `core/` | Motor del sistema (event-bus, broker, gateway, modules, mqtt, etc.) |
| `config/` | Configuración de servicios y puertos |
| `cli/` | Cliente CLI |
| `services/` | Manifest loader y providers |
| `plugins/` | Plugins JSON (github, http-utils, ocr, slack, weather) |
| `prompts/` | Prompts del sistema |
| `templates/` | Plantillas de UI |
| `tests/` | Tests del sistema |
| `deployment/` | Caddy + Helm |
| `network/` | Network utilities |
| `storage/` | Directorio de almacenamiento |

### 3.2 EXCLUIR (toda la documentación suelta + directorios auxiliares)
| Archivo/Dir | Razón |
|-------------|-------|
| `contexto/` | **EXCLUIDO COMPLETO** — se regenerará desde cero si se necesita |
| `ANALISIS-FLUJOS-COMPLETO.md` | Documentación suelta |
| `SYSTEM-ANALYSIS.md` | Documentación suelta |
| `CREATE_PR.md` | Documentación suelta |
| `PR_CLEANUP.md` | Documentación suelta |
| `TEMPLATE_API.md` | Documentación suelta |
| `TEMPLATE_EVENTOS.md` | Documentación suelta |
| `TEMPLATE_MODULO.md` | Documentación suelta |
| `INVENTARIO-SISTEMA.json` | Documentación suelta |
| `plan.md` | Documentación suelta |
| `*.png`, `*.jpg`, `*.pdf` (raíz) | Imágenes sueltas |
| `_archived/` | Archivos archivados |
| `backup/` | Backups viejos |
| `tutoriales/` | Documentación suelta |
| `strategy/` | Documentación/prompts de estrategia |
| `design-system/` | Tokens de diseño |
| `plopfile.js` + `plop-templates/` | Generador Plop |
| `blueprints/` | Schemas de UI |
| `scripts/` | Scripts temporales |

---

## 4. DIRECTORIO `contexto/`

**EXCLUIDO COMPLETAMENTE.** El directorio `contexto/` no se migra al repo nuevo.
Se regenerará desde cero basado en el código real cuando se necesite.

---

## 5. CADENA DE DEPENDENCIAS (Grafo simplificado)

```
                    ┌─────────────────┐
                    │ database-manager │ ← Sin dependencias
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
       ┌─────────────┐ ┌──────────┐  ┌──────────────┐
       │ chat-session │ │ channel  │  │ project-mgr  │ ← Sin deps
       │             │ │ manager  │  └──────┬───────┘
       └──────┬──────┘ └──────────┘         │
              │                    ┌────────┼────────┐
              │                    ▼        ▼        ▼
              │            ┌───────────┐ ┌────────────────┐
              │            │ prompt-mgr│ │ prompt-composer │
              │            └─────┬─────┘ └───────┬────────┘
              │                  │                │
              │                  └───────┬────────┘
              ▼                          ▼
       ┌──────────────┐          ┌──────────────┐
       │chat-ai-bridge│◄─────── │    compose    │
       └──────┬───────┘          └──────────────┘
              │
              ▼
       ┌──────────────┐
       │  ai-gateway   │ ← Sin deps (providers internos)
       └──────────────┘

  credential-manager ← telegram-service ← bot-manager ← agent-manager
                                                            ↑
                                                   ai-agent-framework
                                                     ↑           ↑
                                                prompt-mgr   ai-gateway
```

---

## 6. ESTRUCTURA PROPUESTA DEL REPO LIMPIO

```
ENKI/
├── README.md                    # Nuevo — descripción real del sistema
├── INSTALL.md                   # Guía de instalación actualizada
├── package.json
├── package-lock.json
├── .gitignore
├── .dockerignore
├── .env.example
├── config.example.json
├── Dockerfile
├── start.sh
├── stop.sh
├── restart.sh
├── dev.sh
├── deploy.sh
├── setup-vps.sh
│
├── core/                        # Motor del sistema
│   ├── broker/
│   ├── config/
│   ├── constants.js
│   ├── discovery/
│   ├── events/
│   ├── flow/
│   ├── gateway/
│   ├── hooks.js
│   ├── modules/
│   ├── mqtt/
│   ├── observability/
│   ├── orchestrator/
│   ├── providers/
│   ├── ui/
│   ├── utils/
│   ├── validation/
│   ├── handler-loader.js
│   ├── handler-store.js
│   └── service-executor.js
│
├── modules/                     # 32 módulos activos
│   ├── ai-gateway/
│   ├── ai-agent-framework/
│   ├── prompt-manager/
│   ├── prompt-composer/
│   ├── chat-ai-bridge/
│   ├── chat-session/
│   ├── agent-manager/
│   ├── bot-manager/
│   ├── channel-manager/
│   ├── database-manager/
│   ├── project-manager/
│   ├── credential-manager/
│   ├── composition-manager/
│   ├── context-manager/
│   ├── telegram-service/
│   ├── calling-generator/
│   ├── certificate-authority/
│   ├── security-p2p/
│   ├── code-executor/
│   ├── log-manager/
│   ├── scheduler/
│   ├── plugin-manager/
│   ├── text-editor/
│   ├── pdf-viewer/
│   ├── filesystem/
│   ├── system-inspector/
│   ├── staff-manager/
│   ├── pizzepos/
│   ├── recetas/
│   ├── escandallo/
│   ├── viabilidad/
│   └── facturas/
│
├── config/                      # Configuración
├── cli/                         # Cliente CLI
├── services/                    # Manifest loader
├── plugins/                     # Plugins JSON
├── prompts/                     # Prompts del sistema
├── templates/                   # Templates UI
├── tests/                       # Tests
├── deployment/                  # Caddy + Helm
├── network/                     # Network utils
├── storage/                     # Almacenamiento runtime
│
└── data/                        # Datos runtime (gitignored)
```

---

## 7. PASOS DE MIGRACIÓN

1. **Crear repo nuevo** vacío
2. **Copiar core/** íntegro
3. **Copiar los 32 módulos** (excluir los 8 listados)
4. **Copiar archivos raíz** (solo los de la sección 3.1)
5. **Copiar directorios auxiliares** (config, cli, services, plugins, prompts, templates, tests, deployment, network)
6. **Escribir README.md** nuevo basado en la realidad actual
7. **Limpiar config.json** — quitar referencias a módulos excluidos
8. **Limpiar package.json** — quitar dependencias que solo usan módulos excluidos
9. **Verificar arranque** — `npm start` funciona con los 32 módulos
10. **Ejecutar tests** — verificar que pasan sin los módulos excluidos

---

## 8. NOTAS IMPORTANTES

- El repo original `event-core` se **CONSERVA** intacto como referencia histórica
- Los módulos excluidos pueden reincorporarse en el futuro si se necesitan
- `system-inspector` se incluye marcado como `dev_only: true`
- `pizzepos/` es el módulo más grande (1.2MB, 83 archivos) — considerar si se hace sub-repo en el futuro
- Los archivos de `strategy/` contienen prompts de roles de IA que podrían ser útiles — evaluar integración en `prompts/`
