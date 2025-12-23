/**
 * Initialization Store - Lógica de inicio de la aplicación
 *
 * Gestiona el flujo de inicialización:
 * 1. Restaurar proyecto persistido
 * 2. Activar proyecto en backend
 * 3. Cargar conversaciones del proyecto
 * 4. Restaurar última conversación o preparar nueva
 * 5. Configurar provider por defecto
 */

import { get } from 'svelte/store';
import { getState, getDefaultProvider } from './persistence';
import { loadProjects, activateProject, projectsStore, activeProjectData } from './projects';
import { switchProject } from './conversations';
import { selectProvider, activeProvider } from './workspace';
import { mqttRequest } from '$lib/ui-core';

// ============================================================================
// ESTADO DE INICIALIZACIÓN
// ============================================================================

let initialized = false;
let initializing = false;

// ============================================================================
// INICIALIZACIÓN PRINCIPAL
// ============================================================================

/**
 * Inicializar la aplicación después de conectar MQTT
 * Restaura el estado persistido y sincroniza con el backend
 */
export async function initializeApp(): Promise<void> {
  if (initialized || initializing) {
    console.log('[Init] Already initialized or initializing');
    return;
  }

  initializing = true;
  console.log('[Init] Starting app initialization...');

  try {
    // 1. Cargar estado persistido
    const state = getState();
    console.log('[Init] Persisted state:', state);

    // 2. Cargar lista de proyectos desde backend
    await loadProjects();

    // 3. Restaurar proyecto activo
    if (state.workspace.projectId) {
      console.log('[Init] Restoring project:', state.workspace.projectId);

      try {
        // Activar en backend
        await activateProject(state.workspace.projectId);

        // Cargar conversaciones y restaurar última
        await switchProject(state.workspace.projectId);
      } catch (error) {
        console.warn('[Init] Failed to restore project:', error);
      }
    }

    // 4. Restaurar provider por defecto
    const defaultProvider = getDefaultProvider();
    if (defaultProvider.providerId && !get(activeProvider)) {
      console.log('[Init] Restoring default provider:', defaultProvider.providerId);
      await restoreProvider(defaultProvider.providerId, defaultProvider.modelId);
    }

    initialized = true;
    console.log('[Init] App initialization complete');
  } catch (error) {
    console.error('[Init] Initialization failed:', error);
  } finally {
    initializing = false;
  }
}

/**
 * Restaurar provider desde ID persistido
 */
async function restoreProvider(providerId: string, modelId: string | null): Promise<void> {
  try {
    // Obtener datos del provider desde credentials
    const response = await mqttRequest<{ credential: { id: string; provider: string; name: string } }>(
      'credential',
      'get',
      { id: providerId }
    );

    if (response.data?.credential) {
      const cred = response.data.credential;
      selectProvider(
        { id: cred.id, name: cred.name, provider: cred.provider },
        modelId || 'default'
      );
    }
  } catch (error) {
    console.warn('[Init] Failed to restore provider:', error);
  }
}

/**
 * Manejar cambio de proyecto
 * Llamar cuando el usuario selecciona un proyecto diferente
 */
export async function handleProjectChange(projectId: string): Promise<void> {
  console.log('[Init] Project changed to:', projectId);

  // 1. Activar proyecto en backend
  await activateProject(projectId);

  // 2. Cargar conversaciones y restaurar última
  await switchProject(projectId);
}

/**
 * Verificar si la app está inicializada
 */
export function isInitialized(): boolean {
  return initialized;
}

/**
 * Verificar si la app está inicializando
 */
export function isInitializing(): boolean {
  return initializing;
}

/**
 * Resetear estado de inicialización (para testing/logout)
 */
export function resetInit(): void {
  initialized = false;
  initializing = false;
}
