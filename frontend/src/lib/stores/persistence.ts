/**
 * Persistence Store - Guardar y restaurar estado
 *
 * Gestiona:
 * - LocalStorage para estado de UI
 * - Restauración automática al cargar
 * - Debounce para evitar writes excesivos
 */

import { browser } from '$app/environment';

// ============================================================================
// TIPOS
// ============================================================================

export interface PersistedState {
  workspace: {
    projectId: string | null;
    providerId: string | null;
    modelId: string | null;
    promptId: string | null;
  };
  ui: {
    workBarExpanded: boolean;
    panelSizes: Record<string, { width?: number; height?: number }>;
    theme: 'dark' | 'light' | 'system';
  };
  chat: {
    conversationId: string | null;
    /** Última conversación por proyecto: { projectId: conversationId } */
    lastConversationByProject: Record<string, string>;
  };
  /** Provider por defecto (global) */
  defaultProvider: {
    providerId: string | null;
    modelId: string | null;
  };
}

const STORAGE_KEY = 'event-core-state';
const DEBOUNCE_MS = 500;

// ============================================================================
// DEFAULT STATE
// ============================================================================

const defaultState: PersistedState = {
  workspace: {
    projectId: null,
    providerId: null,
    modelId: null,
    promptId: null
  },
  ui: {
    workBarExpanded: true,
    panelSizes: {},
    theme: 'dark'
  },
  chat: {
    conversationId: null,
    lastConversationByProject: {}
  },
  defaultProvider: {
    providerId: null,
    modelId: null
  }
};

// ============================================================================
// INTERNAL STATE
// ============================================================================

let currentState: PersistedState = { ...defaultState };
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

// ============================================================================
// FUNCIONES
// ============================================================================

/**
 * Cargar estado desde localStorage
 */
export function loadState(): PersistedState {
  if (!browser) return defaultState;

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Merge con defaults para asegurar estructura completa
      currentState = {
        workspace: { ...defaultState.workspace, ...parsed.workspace },
        ui: { ...defaultState.ui, ...parsed.ui },
        chat: { ...defaultState.chat, ...parsed.chat },
        defaultProvider: { ...defaultState.defaultProvider, ...parsed.defaultProvider }
      };
      console.log('[Persistence] State loaded:', currentState);
    }
  } catch (error) {
    console.warn('[Persistence] Failed to load state:', error);
    currentState = { ...defaultState };
  }

  return currentState;
}

/**
 * Guardar estado a localStorage (con debounce)
 */
export function saveState(partial?: Partial<PersistedState>): void {
  if (!browser) return;

  // Merge partial state
  if (partial) {
    if (partial.workspace) {
      currentState.workspace = { ...currentState.workspace, ...partial.workspace };
    }
    if (partial.ui) {
      currentState.ui = { ...currentState.ui, ...partial.ui };
    }
    if (partial.chat) {
      currentState.chat = { ...currentState.chat, ...partial.chat };
    }
    if (partial.defaultProvider) {
      currentState.defaultProvider = { ...currentState.defaultProvider, ...partial.defaultProvider };
    }
  }

  // Debounce writes
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }

  saveTimeout = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(currentState));
      console.log('[Persistence] State saved');
    } catch (error) {
      console.warn('[Persistence] Failed to save state:', error);
    }
  }, DEBOUNCE_MS);
}

/**
 * Obtener estado actual
 */
export function getState(): PersistedState {
  return currentState;
}

/**
 * Limpiar estado guardado
 */
export function clearState(): void {
  if (!browser) return;

  try {
    localStorage.removeItem(STORAGE_KEY);
    currentState = { ...defaultState };
    console.log('[Persistence] State cleared');
  } catch (error) {
    console.warn('[Persistence] Failed to clear state:', error);
  }
}

// ============================================================================
// HELPERS ESPECÍFICOS
// ============================================================================

/**
 * Guardar estado del workspace
 */
export function saveWorkspace(workspace: Partial<PersistedState['workspace']>): void {
  saveState({ workspace });
}

/**
 * Guardar estado de UI
 */
export function saveUI(ui: Partial<PersistedState['ui']>): void {
  saveState({ ui });
}

/**
 * Guardar tamaño de panel
 */
export function savePanelSize(panelId: string, size: { width?: number; height?: number }): void {
  const panelSizes = { ...currentState.ui.panelSizes, [panelId]: size };
  saveState({ ui: { panelSizes } });
}

/**
 * Obtener tamaño de panel guardado
 */
export function getPanelSize(panelId: string): { width?: number; height?: number } | null {
  return currentState.ui.panelSizes[panelId] || null;
}

/**
 * Guardar conversación activa
 */
export function saveConversation(conversationId: string | null): void {
  saveState({ chat: { conversationId, lastConversationByProject: currentState.chat.lastConversationByProject } });
}

/**
 * Guardar última conversación de un proyecto específico
 */
export function saveLastConversationForProject(projectId: string, conversationId: string): void {
  const lastConversationByProject = {
    ...currentState.chat.lastConversationByProject,
    [projectId]: conversationId
  };
  saveState({ chat: { conversationId, lastConversationByProject } });
}

/**
 * Obtener última conversación de un proyecto
 */
export function getLastConversationForProject(projectId: string): string | null {
  return currentState.chat.lastConversationByProject[projectId] || null;
}

/**
 * Guardar provider por defecto
 */
export function saveDefaultProvider(providerId: string | null, modelId: string | null): void {
  saveState({ defaultProvider: { providerId, modelId } });
}

/**
 * Obtener provider por defecto
 */
export function getDefaultProvider(): { providerId: string | null; modelId: string | null } {
  return currentState.defaultProvider;
}

// ============================================================================
// INICIALIZACIÓN
// ============================================================================

// Cargar estado automáticamente al importar (solo en browser)
if (browser) {
  loadState();
}
