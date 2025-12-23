/**
 * Conversations Store - Gestión de conversaciones por proyecto
 *
 * Gestiona:
 * - Lista de conversaciones del proyecto activo
 * - Carga de conversaciones desde backend via MQTT
 * - Creación de nuevas conversaciones
 * - Persistencia de última conversación por proyecto
 * - Sincronización con chat store
 */

import { writable, derived, get } from 'svelte/store';
import { mqttRequest } from '$lib/ui-core';
import {
  saveLastConversationForProject,
  getLastConversationForProject,
  saveConversation
} from './persistence';
import { conversationId, messages, loadConversation as loadChatConversation } from './chat';

// ============================================================================
// TIPOS
// ============================================================================

export interface Conversation {
  id: string;
  title: string;
  message_count: number;
  model?: string;
  provider?: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationsState {
  conversations: Conversation[];
  projectId: string | null;
  loading: boolean;
  error: string | null;
}

// ============================================================================
// STORE
// ============================================================================

const initialState: ConversationsState = {
  conversations: [],
  projectId: null,
  loading: false,
  error: null
};

export const conversationsStore = writable<ConversationsState>(initialState);

// ============================================================================
// ACCIONES
// ============================================================================

/**
 * Cargar conversaciones de un proyecto desde el backend
 */
export async function loadConversations(projectId: string): Promise<void> {
  if (!projectId) {
    conversationsStore.set(initialState);
    return;
  }

  conversationsStore.update(s => ({ ...s, loading: true, error: null, projectId }));

  try {
    const response = await mqttRequest<{ conversations: Conversation[]; total: number }>(
      'conversation',
      'list',
      { projectId }
    );

    conversationsStore.update(s => ({
      ...s,
      conversations: response.data?.conversations || [],
      loading: false,
      error: null
    }));

    console.log('[Conversations] Loaded:', response.data?.total || 0, 'conversations for project', projectId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to load conversations';
    conversationsStore.update(s => ({ ...s, loading: false, error: errorMessage }));
    console.error('[Conversations] Load failed:', errorMessage);
  }
}

/**
 * Crear nueva conversación
 */
export async function createConversation(projectId: string, title?: string): Promise<Conversation | null> {
  if (!projectId) {
    console.error('[Conversations] Cannot create conversation without project');
    return null;
  }

  try {
    const response = await mqttRequest<{ conversation: Conversation }>(
      'conversation',
      'create',
      { projectId, title: title || 'Nueva conversación' }
    );

    const newConversation = response.data?.conversation;

    if (newConversation) {
      // Añadir a la lista
      conversationsStore.update(s => ({
        ...s,
        conversations: [newConversation, ...s.conversations]
      }));

      // Activar esta conversación
      await selectConversation(newConversation.id, projectId);

      console.log('[Conversations] Created:', newConversation.id);
      return newConversation;
    }

    return null;
  } catch (error) {
    console.error('[Conversations] Create failed:', error);
    return null;
  }
}

/**
 * Seleccionar una conversación (cargar mensajes y persistir)
 */
export async function selectConversation(convId: string, projectId: string): Promise<void> {
  // Actualizar stores
  conversationId.set(convId);

  // Persistir
  saveConversation(convId);
  saveLastConversationForProject(projectId, convId);

  // Cargar mensajes
  await loadChatConversation(convId);

  console.log('[Conversations] Selected:', convId);
}

/**
 * Iniciar nueva conversación (sin persistir hasta enviar mensaje)
 */
export function startNewConversation(): void {
  const newId = crypto.randomUUID();
  conversationId.set(newId);
  messages.set([]);
  console.log('[Conversations] Started new (temporary):', newId);
}

/**
 * Restaurar última conversación de un proyecto
 * Retorna true si se restauró, false si no había
 */
export async function restoreLastConversation(projectId: string): Promise<boolean> {
  const lastConvId = getLastConversationForProject(projectId);

  if (lastConvId) {
    // Verificar que la conversación existe en la lista cargada
    const state = get(conversationsStore);
    const exists = state.conversations.some(c => c.id === lastConvId);

    if (exists) {
      await selectConversation(lastConvId, projectId);
      console.log('[Conversations] Restored last conversation:', lastConvId);
      return true;
    } else {
      console.log('[Conversations] Last conversation not found, may have been deleted');
    }
  }

  return false;
}

/**
 * Cambiar de proyecto: cargar conversaciones y restaurar última
 */
export async function switchProject(projectId: string): Promise<void> {
  if (!projectId) {
    conversationsStore.set(initialState);
    conversationId.set(null);
    messages.set([]);
    return;
  }

  // 1. Cargar conversaciones del proyecto
  await loadConversations(projectId);

  // 2. Intentar restaurar última conversación
  const restored = await restoreLastConversation(projectId);

  // 3. Si no se restauró, preparar para nueva conversación
  if (!restored) {
    startNewConversation();
  }
}

/**
 * Limpiar estado (al cerrar sesión o cambiar proyecto)
 */
export function clearConversations(): void {
  conversationsStore.set(initialState);
}

// ============================================================================
// STORES DERIVADOS
// ============================================================================

/** Lista de conversaciones */
export const conversationsList = derived(conversationsStore, $s => $s.conversations);

/** Proyecto actual de las conversaciones */
export const conversationsProjectId = derived(conversationsStore, $s => $s.projectId);

/** Estado de carga */
export const conversationsLoading = derived(conversationsStore, $s => $s.loading);

/** Error actual */
export const conversationsError = derived(conversationsStore, $s => $s.error);

/** Número de conversaciones */
export const conversationsCount = derived(conversationsStore, $s => $s.conversations.length);

/** ¿Tiene conversaciones? */
export const hasConversations = derived(conversationsStore, $s => $s.conversations.length > 0);

/** Conversación activa (datos completos) */
export const activeConversationData = derived(
  [conversationsStore, conversationId],
  ([$store, $convId]) => {
    if (!$convId) return null;
    return $store.conversations.find(c => c.id === $convId) || null;
  }
);
