/**
 * CONSTANTES CENTRALIZADAS DEL SISTEMA
 *
 * ⚠️  ARCHIVO AUTO-GENERADO - NO EDITAR MANUALMENTE
 *
 * Generado por: scripts/generate-constants.js
 * Fuente: module.json de cada módulo
 *
 * Para regenerar: npm run generate:constants
 *
 * Este archivo es la ÚNICA fuente de verdad para:
 * - Nombres de eventos MQTT
 * - Rutas de APIs HTTP
 */

// ============================================
// EVENTOS MQTT - Generados desde module.json
// ============================================

const EVENTS = {
  // === ADMIN ===
  ADMIN: {
    ACTION: 'admin.action',
  },

  // === AI ===
  AI: {
    CHAT_REQUEST: 'ai.chat.request',
    CHAT_RESPONSE: 'ai.chat.response',
    CHAT_CHUNK: 'ai.chat.chunk',
    COMPLETION_COMPLETED: 'ai.completion.completed',
    REQUEST: 'ai.request',
  },

  // === CONVERSATION ===
  CONVERSATION: {
    CONTEXT_LOADED: 'conversation.context.loaded',
    CREATED: 'conversation.created',
    DELETED: 'conversation.deleted',
    GET_REQUEST: 'conversation.get.request',
    GET_RESPONSE: 'conversation.get.response',
    LIST_REQUEST: 'conversation.list.request',
    LIST_RESPONSE: 'conversation.list.response',
    SEND_REQUEST: 'conversation.send.request',
    SEND_RESPONSE: 'conversation.send.response',
    UPDATED: 'conversation.updated',
  },

  // === CONVERSATIONS ===
  CONVERSATIONS: {
    LIST: 'conversations.list',
  },

  // === CORE ===
  CORE: {
    ERRORS_PATTERN: 'core/+/errors/#',
    EVENTS_PATTERN: 'core/+/events/#',
  },

  // === CREDENTIAL ===
  CREDENTIAL: {
    CREATE: 'credential/create',
    DELETE: 'credential/delete',
    DELETED: 'credential.deleted',
    RESOLVED: 'credential.resolved',
    RESOLVE_FAILED: 'credential.resolve.failed',
    RESOLVE_REQUEST: 'credential.resolve.request',
    RESOLVE_RESPONSE: 'credential.resolve.response',
    SAVED: 'credential.saved',
    STATE: 'credential/state',
    STATE_REQUEST: 'credential/state/request',
    UPDATE: 'credential/update',
    UPDATED: 'credential.updated',
  },

  // === DB ===
  DB: {
    CREATED: 'db.created',
    DELETED: 'db.deleted',
    QUERY_EXECUTED: 'db.query.executed',
    QUERY_REQUEST: 'db.query.request',
    QUERY_RESPONSE: 'db.query.response',
    SCHEMA_INITIALIZED: 'db.schema.initialized',
    SCHEMA_INIT_REQUEST: 'db.schema.init.request',
    SCHEMA_INIT_RESPONSE: 'db.schema.init.response',
  },

  // === EDITOR ===
  EDITOR: {
    ERROR: 'editor.error',
    FORMAT_REQUEST: 'editor.format.request',
    FORMAT_RESPONSE: 'editor.format.response',
    OPEN_REQUEST: 'editor.open.request',
    OPEN_RESPONSE: 'editor.open.response',
    SAVED: 'editor.saved',
    SAVE_REQUEST: 'editor.save.request',
    VALIDATE_REQUEST: 'editor.validate.request',
    VALIDATE_RESPONSE: 'editor.validate.response',
  },

  // === FS ===
  FS: {
    DIRECTORY_CREATED: 'fs.directory.created',
    FILE_CREATED: 'fs.file.created',
    FILE_DELETED: 'fs.file.deleted',
    FILE_UPDATED: 'fs.file.updated',
    WORKDIR_CHANGED: 'fs.workdir.changed',
    // Request events (agents can ask for actions)
    WRITE_REQUEST: 'fs.write.request',
    WRITE_RESPONSE: 'fs.write.response',
    COPY_REQUEST: 'fs.copy.request',
    COPY_RESPONSE: 'fs.copy.response',
    READ_REQUEST: 'fs.read.request',
    READ_RESPONSE: 'fs.read.response',
  },

  // === FUNCTION ===
  FUNCTION: {
    EXECUTED: 'function.executed',
    EXECUTE_REQUEST: 'function.execute.request',
    EXECUTE_RESPONSE: 'function.execute.response',
    FAILED: 'function.failed',
    GENERATED: 'function.generated',
    GENERATION_ERROR: 'function.generation.error',
    GET_REQUEST: 'function.get.request',
    GET_RESPONSE: 'function.get.response',
    LIST_REQUEST: 'function.list.request',
    LIST_RESPONSE: 'function.list.response',
  },

  // === MENU ===
  MENU: {
    ERROR: 'menu.error',
    GENERADO: 'menu.generado',
    OBTENER_ULTIMO: 'menu.obtener_ultimo',
    VALIDADO: 'menu.validado',
  },

  // === MENU_GENERATOR ===
  MENU_GENERATOR: {
    CONVERSATION_CREATED: 'menu-generator.conversation.created',
    MENU_CREATED: 'menu-generator.menu.created',
    MENU_EXPORTED: 'menu-generator.menu.exported',
    MENU_EXPORTED_POS: 'menu-generator.menu.exported_pos',
    MESSAGE_RECEIVED: 'menu-generator.message.received',
    MESSAGE_SENT: 'menu-generator.message.sent',
  },

  // === MESSAGE ===
  MESSAGE: {
    LIST_REQUEST: 'message.list.request',
    LIST_RESPONSE: 'message.list.response',
    RECEIVED: 'message.received',
    SENT: 'message.sent',
  },

  // === METRICAS ===
  METRICAS: {
    ALERTA: 'metricas.alerta',
    COUNTERS: 'metricas.counters',
    GAUGES: 'metricas.gauges',
    OBTENER: 'metricas.obtener',
    SNAPSHOT: 'metricas.snapshot',
  },

  // === NOTA ===
  NOTA: {
    ACTUALIZADA: 'nota.actualizada',
    CREADA: 'nota.creada',
    ELIMINADA: 'nota.eliminada',
    LISTAR: 'nota.listar',
    OBTENER: 'nota.obtener',
  },

  // === OCR ===
  OCR: {
    EXTRACT_COMPLETED: 'ocr.extract.completed',
    EXTRACT_FAILED: 'ocr.extract.failed',
    EXTRACT_REQUEST: 'ocr.extract.request',
  },

  // === PDF ===
  PDF: {
    ERROR: 'pdf.error',
    EXTRACT_REQUEST: 'pdf.extract.request',
    EXTRACT_RESPONSE: 'pdf.extract.response',
    LIST_REQUEST: 'pdf.list.request',
    LIST_RESPONSE: 'pdf.list.response',
    METADATA_REQUEST: 'pdf.metadata.request',
    METADATA_RESPONSE: 'pdf.metadata.response',
    VIEW_REQUEST: 'pdf.view.request',
    VIEW_RESPONSE: 'pdf.view.response',
  },

  // === PLUGIN ===
  PLUGIN: {
    ERROR: 'plugin.error',
    GET_REQUEST: 'plugin.get.request',
    GET_RESPONSE: 'plugin.get.response',
    LIST_REQUEST: 'plugin.list.request',
    LIST_RESPONSE: 'plugin.list.response',
    LOADED: 'plugin.loaded',
    RELOADED: 'plugin.reloaded',
    UNLOADED: 'plugin.unloaded',
  },

  // === POS ===
  POS: {
    CATEGORIAS_IMPORT: 'pos.categorias.import',
    INGREDIENTES_IMPORT: 'pos.ingredientes.import',
    PRODUCTOS_IMPORT: 'pos.productos.import',
    VARIACIONES_IMPORT: 'pos.variaciones.import',
  },

  // === PROJECT ===
  PROJECT: {
    ACTIVATE: 'project/activate',
    ACTIVATED: 'project.activated',
    ACTIVE_REQUEST: 'project.active.request',
    ACTIVE_RESPONSE: 'project.active.response',
    CREATE: 'project/create',
    CREATED: 'project.created',
    DEACTIVATED: 'project.deactivated',
    DELETE: 'project/delete',
    DELETED: 'project.deleted',
    GET_REQUEST: 'project.get.request',
    GET_RESPONSE: 'project.get.response',
    LIST_REQUEST: 'project.list.request',
    LIST_RESPONSE: 'project.list.response',
    STATE: 'project/state',
    STATE_REQUEST: 'project/state/request',
    UPDATE: 'project/update',
    UPDATED: 'project.updated',
  },

  // === SCRATCH ===
  SCRATCH: {
    DESIGN_CREATED: 'scratch.design.created',
    DESIGN_DELETED: 'scratch.design.deleted',
    DESIGN_EXPORTED: 'scratch.design.exported',
    DESIGN_UPDATED: 'scratch.design.updated',
  },

  // === SHELL ===
  SHELL: {
    ERROR: 'shell.error',
    EXECUTED: 'shell.executed',
    EXEC_REQUEST: 'shell.exec.request',
    PROCESS_STARTED: 'shell.process.started',
    PROCESS_STOPPED: 'shell.process.stopped',
  },

  // === STORAGE ===
  STORAGE: {
    INFO_RESPONSE: 'storage.info.response',
  },

  // === SYSTEM ===
  SYSTEM: {
    ERRORS: 'system.errors',
    STATUS: 'system.status',
  },

  // === TELEGRAM ===
  TELEGRAM: {
    AUDIO_RECEIVED: 'telegram.audio.received',
    BOT_ERROR: 'telegram.bot.error',
    BOT_STARTED: 'telegram.bot.started',
    BOT_STOPPED: 'telegram.bot.stopped',
    CALLBACK_RECEIVED: 'telegram.callback.received',
    COMMAND_RECEIVED: 'telegram.command.received',
    CONTACT_RECEIVED: 'telegram.contact.received',
    DOCUMENT_RECEIVED: 'telegram.document.received',
    LOCATION_RECEIVED: 'telegram.location.received',
    MESSAGE_SENT: 'telegram.message.sent',
    PHOTO_RECEIVED: 'telegram.photo.received',
    QUEUE_OVERFLOW: 'telegram.queue.overflow',
    SEND_FAILED: 'telegram.send.failed',
    TEXT_RECEIVED: 'telegram.text.received',
    VIDEO_RECEIVED: 'telegram.video.received',
    VOICE_RECEIVED: 'telegram.voice.received',
    // Request events (agents can ask for actions)
    SEND_MESSAGE_REQUEST: 'telegram.send_message.request',
    SEND_MESSAGE_RESPONSE: 'telegram.send_message.response',
    GET_FILE_REQUEST: 'telegram.get_file.request',
    GET_FILE_RESPONSE: 'telegram.get_file.response',
    SEND_PHOTO_REQUEST: 'telegram.send_photo.request',
    SEND_PHOTO_RESPONSE: 'telegram.send_photo.response',
    SEND_DOCUMENT_REQUEST: 'telegram.send_document.request',
    SEND_DOCUMENT_RESPONSE: 'telegram.send_document.response',
    SEND_VIDEO_REQUEST: 'telegram.send_video.request',
    SEND_VIDEO_RESPONSE: 'telegram.send_video.response',
    SEND_LOCATION_REQUEST: 'telegram.send_location.request',
    SEND_LOCATION_RESPONSE: 'telegram.send_location.response',
    EDIT_MESSAGE_REQUEST: 'telegram.edit_message.request',
    EDIT_MESSAGE_RESPONSE: 'telegram.edit_message.response',
    DELETE_MESSAGE_REQUEST: 'telegram.delete_message.request',
    DELETE_MESSAGE_RESPONSE: 'telegram.delete_message.response',
    ANSWER_CALLBACK_REQUEST: 'telegram.answer_callback.request',
    ANSWER_CALLBACK_RESPONSE: 'telegram.answer_callback.response',
    GET_CHAT_REQUEST: 'telegram.get_chat.request',
    GET_CHAT_RESPONSE: 'telegram.get_chat.response',
    SET_COMMANDS_REQUEST: 'telegram.set_commands.request',
    SET_COMMANDS_RESPONSE: 'telegram.set_commands.response',
    LIST_BOTS_REQUEST: 'telegram.list_bots.request',
    LIST_BOTS_RESPONSE: 'telegram.list_bots.response',
  },

  // === TEMPLATES ===
  TEMPLATES: {
    LIST: 'templates.list',
  },

  // === TOOL ===
  TOOL: {
    CALL_REQUEST: 'tool.call.request',
    CALL_RESPONSE: 'tool.call.response',
    LIST_REQUEST: 'tool.list.request',
    LIST_RESPONSE: 'tool.list.response',
  },

  // === UI ===
  UI: {
    COMPONENT_LOADED: 'ui.component.loaded',
  },

  // === UI_DESIGNER ===
  UI_DESIGNER: {
    EXPORT_JSON: 'ui-designer.export.json',
    EXPORT_SVELTE: 'ui-designer.export.svelte',
    EXPORT_YAML: 'ui-designer.export.yaml',
    TEMPLATE_CREATED: 'ui-designer.template.created',
    TEMPLATE_DELETED: 'ui-designer.template.deleted',
    TEMPLATE_UPDATED: 'ui-designer.template.updated',
  },

  // === WILDCARD ===
  WILDCARD: {
    ACTUALIZADO: '*.actualizado',
    COMPLETADO: '*.completado',
    CREADO: '*.creado',
    ELIMINADO: '*.eliminado',
    ERROR: '*.error',
  },

};

// ============================================
// RUTAS DE APIs HTTP - Generadas desde module.json
// ============================================

const API_ROUTES = {
  ADMIN: {
    BASE: '/modules/admin-panel',
    UI: '/modules/admin-panel/',
    DASHBOARD_DATA: '/modules/admin-panel/api/dashboard',
    LIST_MODULES: '/modules/admin-panel/api/modules',
    LIST_PLUGINS: '/modules/admin-panel/api/plugins',
    TOGGLE_PLUGIN: '/modules/admin-panel/api/plugins/:name/toggle',
    LIST_AGENTS: '/modules/admin-panel/api/agents',
    CREATE_AGENT: '/modules/admin-panel/api/agents',
    DELETE_AGENT: '/modules/admin-panel/api/agents/:id',
    LIST_PROMPTS: '/modules/admin-panel/api/prompts',
    GET_PROMPT: '/modules/admin-panel/api/prompts/:name',
    CREATE_PROMPT: '/modules/admin-panel/api/prompts',
    UPDATE_PROMPT: '/modules/admin-panel/api/prompts/:name',
  },

  AGENT: {
    BASE: '/modules/ai-agent-framework',
    REGISTER_AGENT: '/modules/ai-agent-framework/agents',
    LIST_AGENTS: '/modules/ai-agent-framework/agents',
    GET_AGENT: '/modules/ai-agent-framework/agents/:id',
    UPDATE_AGENT: '/modules/ai-agent-framework/agents/:id',
    DELETE_AGENT: '/modules/ai-agent-framework/agents/:id',
    TRIGGER_AGENT: '/modules/ai-agent-framework/agents/:id/trigger',
    GET_CONTEXT: '/modules/ai-agent-framework/agents/:id/context',
    CLEAR_CONTEXT: '/modules/ai-agent-framework/agents/:id/context',
    LIST_TOOLS: '/modules/ai-agent-framework/tools',
    GET_AGENT_STATS: '/modules/ai-agent-framework/agents/:id/stats',
  },

  AI: {
    BASE: '/modules/ai-gateway',
    CHAT_COMPLETION: '/modules/ai-gateway/chat',
    CHAT_STREAM: '/modules/ai-gateway/chat/stream',
    LIST_PROVIDERS: '/modules/ai-gateway/providers',
    LIST_MODELS: '/modules/ai-gateway/models',
    GET_USAGE: '/modules/ai-gateway/usage',
    TEST_PROVIDER: '/modules/ai-gateway/providers/test',
    U_I_STATE: '/modules/ai-gateway/ui/state',
    U_I_SELECT: '/modules/ai-gateway/ui/select',
    U_I_CONFIG_GET: '/modules/ai-gateway/ui/config',
    U_I_CONFIG_POST: '/modules/ai-gateway/ui/config',
    LIST_TOOLS: '/modules/ai-gateway/tools',
    EXECUTE_TOOL: '/modules/ai-gateway/tools/:name/execute',
  },

  CALLING: {
    BASE: '/modules/calling-generator',
    LIST_FUNCTIONS: '/modules/calling-generator/functions',
    GET_FUNCTION: '/modules/calling-generator/functions/:name',
    EXECUTE_FUNCTION: '/modules/calling-generator/functions/:name/execute',
    HEALTH_CHECK: '/modules/calling-generator/health',
    GET_METRICS: '/modules/calling-generator/metrics',
  },

  CONVERSATION: {
    BASE: '/modules/conversation-manager',
    CREATE_CONVERSATION: '/modules/conversation-manager/conversations',
    LIST_CONVERSATIONS: '/modules/conversation-manager/conversations',
    GET_CONVERSATION: '/modules/conversation-manager/conversations/:id',
    UPDATE_CONVERSATION: '/modules/conversation-manager/conversations/:id',
    DELETE_CONVERSATION: '/modules/conversation-manager/conversations/:id',
    SEND_MESSAGE: '/modules/conversation-manager/conversations/:id/messages',
    GET_MESSAGES: '/modules/conversation-manager/conversations/:id/messages',
    GET_CONTEXT: '/modules/conversation-manager/conversations/:id/context',
    U_I_STATE: '/modules/conversation-manager/ui/state',
    TOGGLE_CONTEXT: '/modules/conversation-manager/messages/:id/context',
    CONTEXT_STATS: '/modules/conversation-manager/conversations/:id/context-stats',
    HEALTH_CHECK: '/modules/conversation-manager/health',
    GET_METRICS: '/modules/conversation-manager/metrics',
  },

  CREDENTIAL: {
    BASE: '/modules/credential-manager',
    SAVE_CREDENTIAL: '/modules/credential-manager/credentials',
    RESOLVE_CREDENTIAL: '/modules/credential-manager/credentials/resolve',
    LIST_CREDENTIALS: '/modules/credential-manager/credentials',
    UPDATE_CREDENTIAL: '/modules/credential-manager/credentials/:key',
    DELETE_CREDENTIAL: '/modules/credential-manager/credentials/:key',
    GET_LEVELS: '/modules/credential-manager/credentials/levels',
    TEST_CREDENTIAL: '/modules/credential-manager/ui/test',
    HEALTH_CHECK: '/modules/credential-manager/health',
    GET_METRICS: '/modules/credential-manager/metrics',
  },

  DATABASE: {
    BASE: '/modules/database-manager',
    LIST_DATABASES: '/modules/database-manager/databases',
    EXECUTE_QUERY: '/modules/database-manager/databases/:projectId/query',
    GET_SCHEMA: '/modules/database-manager/databases/:projectId/schema',
    INIT_SCHEMA: '/modules/database-manager/databases/:projectId/init',
    DELETE_DATABASE: '/modules/database-manager/databases/:projectId',
    LIST_TABLES: '/modules/database-manager/databases/:projectId/tables',
    HEALTH_CHECK: '/modules/database-manager/health',
    GET_METRICS: '/modules/database-manager/metrics',
  },

  LOG: {
    BASE: '/modules/log-manager',
    GET_SESSION: '/modules/log-manager/session',
    GET_SESSION_MODULES: '/modules/log-manager/session/modules',
    GET_SESSION_MODULE_LOGS: '/modules/log-manager/session/modules/*/logs',
    SET_TRACKED_MODULES: '/modules/log-manager/session/track',
    ADD_TRACKED_MODULES: '/modules/log-manager/session/track/add',
    GET_SESSIONS: '/modules/log-manager/sessions',
    GET_SESSION_BY_ID: '/modules/log-manager/sessions/*',
    GET_SESSION_LOGS: '/modules/log-manager/sessions/*/logs',
    GET_LOGS: '/modules/log-manager/logs',
    ADD_LOG: '/modules/log-manager/logs',
    GET_STATS: '/modules/log-manager/stats',
  },

  MENU: {
    BASE: '/modules/menu-generator',
    UPLOAD_MENU: '/modules/menu-generator/upload',
    LIST_MENUS: '/modules/menu-generator/menus',
    GET_MENU: '/modules/menu-generator/menus/:id',
    VALIDATE_MENU: '/modules/menu-generator/menus/:id/validate',
    EXPORT_MENU: '/modules/menu-generator/menus/:id/export',
    EXPORT_P_O_S: '/modules/menu-generator/menus/:id/export-pos',
    APPLY_TO_P_O_S: '/modules/menu-generator/menus/:id/apply-pos',
    LIST_CONVERSATIONS: '/modules/menu-generator/conversations',
    CREATE_CONVERSATION: '/modules/menu-generator/conversations',
    GET_CONVERSATION: '/modules/menu-generator/conversations/:id',
    DELETE_CONVERSATION: '/modules/menu-generator/conversations/:id',
    GET_MESSAGES: '/modules/menu-generator/conversations/:id/messages',
    SEND_MESSAGE: '/modules/menu-generator/conversations/:id/messages',
    STREAM: '/modules/menu-generator/stream',
    GET_TEMPLATES: '/modules/menu-generator/templates',
    GET_TEMPLATE: '/modules/menu-generator/templates/:id',
    GET_HISTORY: '/modules/menu-generator/history',
    HEALTH_CHECK: '/modules/menu-generator/health',
    GET_METRICS: '/modules/menu-generator/metrics',
  },

  METRICAS: {
    BASE: '/modules/metricas',
    GET_ALL_METRICS: '/modules/metricas/metrics',
    GET_COUNTERS: '/modules/metricas/metrics/counters',
    GET_GAUGES: '/modules/metricas/metrics/gauges',
    GET_TIMINGS: '/modules/metricas/metrics/timings',
    GET_EVENT_METRICS: '/modules/metricas/metrics/eventos',
    RESET_METRICS: '/modules/metricas/metrics/reset',
    HEALTH_CHECK: '/modules/metricas/health',
  },

  NOTAS: {
    BASE: '/modules/notas',
    LIST_NOTAS: '/modules/notas/notas',
    GET_NOTA: '/modules/notas/notas/:id',
    CREATE_NOTA: '/modules/notas/notas',
    UPDATE_NOTA: '/modules/notas/notas/:id',
    DELETE_NOTA: '/modules/notas/notas/:id',
    TOGGLE_PIN: '/modules/notas/notas/:id/pin',
    HEALTH_CHECK: '/modules/notas/health',
    GET_METRICS: '/modules/notas/metrics',
  },

  PDF: {
    BASE: '/modules/pdf-viewer',
    VIEW_PDF: '/modules/pdf-viewer/pdf/view',
    EXTRACT_TEXT: '/modules/pdf-viewer/pdf/extract-text',
    GET_METADATA: '/modules/pdf-viewer/pdf/metadata',
    LIST_PDFS: '/modules/pdf-viewer/pdf/list',
  },

  PLUGIN: {
    BASE: '/modules/plugin-manager',
    GET_PLUGIN: '/modules/plugin-manager/plugins/:name',
    LIST_PLUGINS: '/modules/plugin-manager/plugins',
    RELOAD_PLUGINS: '/modules/plugin-manager/plugins/reload',
    HEALTH_CHECK: '/modules/plugin-manager/health',
    GET_METRICS: '/modules/plugin-manager/metrics',
  },

  PROJECT: {
    BASE: '/modules/project-manager',
    CREATE_PROJECT: '/modules/project-manager/projects',
    LIST_PROJECTS: '/modules/project-manager/projects',
    GET_PROJECT: '/modules/project-manager/projects/:id',
    UPDATE_PROJECT: '/modules/project-manager/projects/:id',
    DELETE_PROJECT: '/modules/project-manager/projects/:id',
    ACTIVATE_PROJECT: '/modules/project-manager/projects/:id/activate',
    GET_ACTIVE_PROJECT: '/modules/project-manager/projects/active',
    SAVE_SESSION: '/modules/project-manager/projects/:id/session',
    RESTORE_SESSION: '/modules/project-manager/projects/:id/session',
    SET_A_I_CONFIG: '/modules/project-manager/projects/:id/ai-config',
    SET_LAST_CONVERSATION: '/modules/project-manager/projects/:id/last-conversation',
    HEALTH_CHECK: '/modules/project-manager/health',
    GET_METRICS: '/modules/project-manager/metrics',
  },

  PROMPT: {
    BASE: '/modules/prompt-manager',
    GET_U_I_STATE: '/modules/prompt-manager/ui/state',
    CREATE_PROMPT: '/modules/prompt-manager/prompts',
    LIST_PROMPTS: '/modules/prompt-manager/prompts',
    GET_PROMPT: '/modules/prompt-manager/prompts/:id',
    UPDATE_PROMPT: '/modules/prompt-manager/prompts/:id',
    DELETE_PROMPT: '/modules/prompt-manager/prompts/:id',
    LIST_VERSIONS: '/modules/prompt-manager/prompts/:id/versions',
    RENDER_TEMPLATE: '/modules/prompt-manager/prompts/:id/render',
    CREATE_PRESET: '/modules/prompt-manager/presets',
    LIST_PRESETS: '/modules/prompt-manager/presets',
    GET_PRESET: '/modules/prompt-manager/presets/:id',
    DELETE_PRESET: '/modules/prompt-manager/presets/:id',
    GET_ANALYTICS: '/modules/prompt-manager/analytics',
    HEALTH_CHECK: '/modules/prompt-manager/health',
    GET_METRICS: '/modules/prompt-manager/metrics',
  },

  SCRATCH: {
    BASE: '/modules/scratch-designer',
    GET_ALL_BLOCKS: '/modules/scratch-designer/blocks/all',
    GET_MODULE_BLOCKS: '/modules/scratch-designer/blocks/modules',
    GET_EVENT_BLOCKS: '/modules/scratch-designer/blocks/events',
    GET_ACTION_BLOCKS: '/modules/scratch-designer/blocks/actions',
    GET_COMPONENT_BLOCKS: '/modules/scratch-designer/blocks/components',
    GET_CONTAINER_BLOCKS: '/modules/scratch-designer/blocks/containers',
    GET_DATA_BLOCKS: '/modules/scratch-designer/blocks/data',
    GET_CONDITION_BLOCKS: '/modules/scratch-designer/blocks/conditions',
    LIST_DESIGNS: '/modules/scratch-designer/designs',
    CREATE_DESIGN: '/modules/scratch-designer/designs',
    GET_DESIGN: '/modules/scratch-designer/designs/:id',
    UPDATE_DESIGN: '/modules/scratch-designer/designs/:id',
    DELETE_DESIGN: '/modules/scratch-designer/designs/:id',
    DUPLICATE_DESIGN: '/modules/scratch-designer/designs/:id/duplicate',
    VALIDATE_CONNECTION: '/modules/scratch-designer/validate/connection',
    VALIDATE_DESIGN: '/modules/scratch-designer/validate/design',
    EXPORT_J_S_O_N: '/modules/scratch-designer/export/json',
    EXPORT_MODULE_U_I: '/modules/scratch-designer/export/module-ui',
    HEALTH_CHECK: '/modules/scratch-designer/health',
    GET_METRICS: '/modules/scratch-designer/metrics',
  },

  SYSTEM: {
    BASE: '/modules/system-inspector',
    GET_STATUS: '/modules/system-inspector/status',
    GET_ERRORS: '/modules/system-inspector/errors',
    GET_NETWORK: '/modules/system-inspector/network',
    CLEAR: '/modules/system-inspector/clear',
  },

  TEXT: {
    BASE: '/modules/text-editor',
    OPEN_FILE: '/modules/text-editor/editor/open',
    SAVE_FILE: '/modules/text-editor/editor/save',
    VALIDATE_CONTENT: '/modules/text-editor/editor/validate',
    FORMAT_CONTENT: '/modules/text-editor/editor/format',
  },

  UI: {
    BASE: '/modules/ui-designer',
    LIST_TEMPLATES: '/modules/ui-designer/templates',
    CREATE_TEMPLATE: '/modules/ui-designer/templates',
    GET_TEMPLATE: '/modules/ui-designer/templates/:id',
    UPDATE_TEMPLATE: '/modules/ui-designer/templates/:id',
    DELETE_TEMPLATE: '/modules/ui-designer/templates/:id',
    DUPLICATE_TEMPLATE: '/modules/ui-designer/templates/:id/duplicate',
    PUBLISH_TEMPLATE: '/modules/ui-designer/templates/:id/publish',
    ARCHIVE_TEMPLATE: '/modules/ui-designer/templates/:id/archive',
    LIST_LAYOUTS: '/modules/ui-designer/layouts',
    GET_LAYOUT: '/modules/ui-designer/layouts/:type',
    GET_PREDEFINED_TEMPLATES: '/modules/ui-designer/predefined',
    CREATE_FROM_PREDEFINED: '/modules/ui-designer/predefined/create',
    LIST_COMPONENTS: '/modules/ui-designer/components',
    GET_COMPONENT_SCHEMA: '/modules/ui-designer/components/:name',
    EXPORT_YAML: '/modules/ui-designer/export/yaml',
    EXPORT_SVELTE: '/modules/ui-designer/export/svelte',
    EXPORT_JSON: '/modules/ui-designer/export/json',
    HEALTH_CHECK: '/modules/ui-designer/health',
  },

};

// ============================================
// REGISTRO DE MÓDULOS
// ============================================

const MODULES = {
  'admin-panel': {
    version: '1.0.0',
    events: {
      publishes: ['admin.action'],
      subscribes: ['plugin.loaded', 'ui.component.loaded'],
    },
  },
  'ai-agent-framework': {
    version: '1.0.0',
    events: {
      publishes: [],
      subscribes: [],
    },
  },
  'ai-gateway': {
    version: '1.0.0',
    events: {
      publishes: [],
      subscribes: [],
    },
  },
  'calling-generator': {
    version: '2.0.0',
    events: {
      publishes: ['function.generated', 'function.executed', 'function.failed', 'function.generation.error', 'function.get.response', 'function.list.response', 'function.execute.response'],
      subscribes: ['plugin.loaded', 'function.get.request', 'function.list.request', 'function.execute.request'],
    },
  },
  'code-executor': {
    version: '1.0.0',
    events: {
      publishes: ['shell.executed', 'shell.error', 'shell.process.started', 'shell.process.stopped'],
      subscribes: ['shell.exec.request'],
    },
  },
  'conversation-manager': {
    version: '1.0.0',
    events: {
      publishes: ['ai.chat.request', 'conversation.created', 'conversation.updated', 'conversation.deleted', 'message.sent', 'message.received', 'conversation.context.loaded', 'conversation.get.response', 'conversation.list.response', 'message.list.response', 'conversation.send.response', 'tool.list.request', 'tool.call.request'],
      subscribes: ['conversation.get.request', 'conversation.list.request', 'message.list.request', 'conversation.send.request', 'db.query.response', 'ai.chat.response', 'project.get.response', 'storage.info.response', 'tool.list.response', 'tool.call.response'],
    },
  },
  'credential-manager': {
    version: '2.0.0',
    events: {
      publishes: ['credential.saved', 'credential.updated', 'credential.deleted', 'credential.resolved', 'credential.resolve.failed', 'credential.resolve.response', 'credential/state'],
      subscribes: ['credential.resolve.request', 'credential/state/request', 'credential/create', 'credential/update', 'credential/delete'],
    },
  },
  'dashboard': {
    version: '2.0.0',
    events: {
      publishes: [],
      subscribes: [],
    },
  },
  'database-manager': {
    version: '2.0.0',
    events: {
      publishes: ['db.created', 'db.deleted', 'db.query.executed', 'db.schema.initialized', 'db.query.response', 'db.schema.init.response'],
      subscribes: ['db.query.request', 'db.schema.init.request'],
    },
  },
  'filesystem': {
    version: '1.0.0',
    events: {
      publishes: ['fs.file.created', 'fs.file.updated', 'fs.file.deleted', 'fs.directory.created', 'fs.workdir.changed'],
      subscribes: ['project.activated', 'project.deactivated'],
    },
  },
  'log-manager': {
    version: '2.0.0',
    events: {
      publishes: [],
      subscribes: [],
    },
  },
  'menu-generator': {
    version: '2.0.0',
    events: {
      publishes: ['ai.request', 'menu.generado', 'menu.validado', 'menu.error', 'menu-generator.conversation.created', 'menu-generator.message.sent', 'menu-generator.message.received', 'menu-generator.menu.created', 'menu-generator.menu.exported', 'menu-generator.menu.exported_pos', 'pos.categorias.import', 'pos.ingredientes.import', 'pos.productos.import', 'pos.variaciones.import'],
      subscribes: ['ai.completion.completed', 'menu.obtener_ultimo', 'conversations.list', 'templates.list'],
    },
  },
  'metricas': {
    version: '1.0.0',
    events: {
      publishes: ['metricas.snapshot', 'metricas.alerta'],
      subscribes: ['*.creado', '*.actualizado', '*.eliminado', '*.error', '*.completado', 'metricas.obtener', 'metricas.counters', 'metricas.gauges'],
    },
  },
  'notas': {
    version: '1.0.0',
    events: {
      publishes: ['nota.creada', 'nota.actualizada', 'nota.eliminada'],
      subscribes: ['nota.obtener', 'nota.listar'],
    },
  },
  'pdf-viewer': {
    version: '1.0.0',
    events: {
      publishes: ['pdf.view.response', 'pdf.extract.response', 'pdf.metadata.response', 'pdf.list.response', 'pdf.error'],
      subscribes: ['pdf.view.request', 'pdf.extract.request', 'pdf.metadata.request', 'pdf.list.request'],
    },
  },
  'plugin-manager': {
    version: '2.0.0',
    events: {
      publishes: ['plugin.loaded', 'plugin.unloaded', 'plugin.error', 'plugin.reloaded', 'plugin.get.response', 'plugin.list.response'],
      subscribes: ['plugin.get.request', 'plugin.list.request'],
    },
  },
  'project-manager': {
    version: '2.0.0',
    events: {
      publishes: ['project.created', 'project.updated', 'project.deleted', 'project.activated', 'project.deactivated', 'project.get.response', 'project.list.response', 'project.active.response', 'project/state'],
      subscribes: ['project.get.request', 'project.list.request', 'project.active.request', 'db.query.response', 'project/state/request', 'project/create', 'project/update', 'project/delete', 'project/activate'],
    },
  },
  'prompt-manager': {
    version: '2.0.0',
    events: {
      publishes: [],
      subscribes: [],
    },
  },
  'scratch-designer': {
    version: '2.0.0',
    events: {
      publishes: ['scratch.design.created', 'scratch.design.updated', 'scratch.design.deleted', 'scratch.design.exported'],
      subscribes: [],
    },
  },
  'system-inspector': {
    version: '1.0.0',
    events: {
      publishes: [],
      subscribes: ['core/+/events/#', 'core/+/errors/#', 'system.status', 'system.errors'],
    },
  },
  'telegram-service': {
    version: '3.0.0',
    events: {
      publishes: ['telegram.text.received', 'telegram.photo.received', 'telegram.document.received', 'telegram.video.received', 'telegram.audio.received', 'telegram.voice.received', 'telegram.location.received', 'telegram.contact.received', 'telegram.command.received', 'telegram.callback.received', 'telegram.message.sent', 'telegram.send.failed', 'telegram.bot.started', 'telegram.bot.stopped', 'telegram.bot.error', 'telegram.queue.overflow'],
      subscribes: ['credential.saved', 'credential.deleted'],
    },
  },
  'text-editor': {
    version: '1.0.0',
    events: {
      publishes: ['editor.open.response', 'editor.saved', 'editor.validate.response', 'editor.format.response', 'editor.error'],
      subscribes: ['editor.open.request', 'editor.save.request', 'editor.validate.request', 'editor.format.request'],
    },
  },
  'ui-designer': {
    version: '1.0.0',
    events: {
      publishes: ['ui-designer.template.created', 'ui-designer.template.updated', 'ui-designer.template.deleted', 'ui-designer.export.yaml', 'ui-designer.export.svelte', 'ui-designer.export.json'],
      subscribes: [],
    },
  },
};

// ============================================
// HELPERS
// ============================================

const HELPERS = {
  /**
   * Valida que un evento esté registrado
   * @param {string} eventName - Nombre del evento
   * @returns {boolean} true si el evento es válido
   */
  isValidEvent(eventName) {
    const domain = eventName.split('.')[0].toUpperCase();
    if (!EVENTS[domain]) return false;

    const constName = eventName.split('.').slice(1).join('_').toUpperCase();
    return EVENTS[domain][constName] === eventName;
  },

  /**
   * Obtiene todos los eventos de un dominio
   * @param {string} domain - Dominio (ej: 'TOOL')
   * @returns {string[]} Lista de eventos
   */
  getEventsByDomain(domain) {
    return EVENTS[domain] ? Object.values(EVENTS[domain]) : [];
  },

  /**
   * Obtiene todos los eventos registrados
   * @returns {string[]} Lista de todos los eventos
   */
  getAllEvents() {
    const all = [];
    for (const domain of Object.values(EVENTS)) {
      all.push(...Object.values(domain));
    }
    return all;
  },

  /**
   * Genera un request_id único
   * @returns {string} Request ID
   */
  generateRequestId() {
    return 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }
};

// ============================================
// EXPORTS
// ============================================

module.exports = {
  EVENTS,
  API_ROUTES,
  MODULES,
  HELPERS
};
