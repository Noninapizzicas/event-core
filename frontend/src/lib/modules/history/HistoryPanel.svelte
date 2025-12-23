<script lang="ts">
  /**
   * HistoryPanel - Panel de historial de conversaciones
   *
   * Features:
   * - Lista de conversaciones del proyecto activo (desde backend)
   * - Cargar conversación existente
   * - Nueva conversación
   * - Eliminar conversación
   * - Indicador de conversación activa
   */

  import { onMount } from 'svelte';
  import {
    conversationId,
    conversationsList,
    conversationsLoading,
    conversationsError,
    activeProjectIdMqtt,
    loadConversations,
    selectConversation,
    startNewConversation,
    createConversation
  } from '$lib/stores';
  import { closePanel } from '$lib/stores/ui';
  import { mqttRequest } from '$lib/ui-core';

  export let panelId: string;

  // Cargar conversaciones al montar (si hay proyecto activo)
  onMount(() => {
    if ($activeProjectIdMqtt) {
      loadConversations($activeProjectIdMqtt);
    }
  });

  // Recargar cuando cambia el proyecto
  $: if ($activeProjectIdMqtt) {
    loadConversations($activeProjectIdMqtt);
  }

  function formatDate(timestamp: string): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return 'Hoy ' + date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
      return 'Ayer';
    } else if (diffDays < 7) {
      return `Hace ${diffDays} días`;
    } else {
      return date.toLocaleDateString('es', { day: 'numeric', month: 'short' });
    }
  }

  async function handleSelect(convId: string) {
    if ($activeProjectIdMqtt) {
      await selectConversation(convId, $activeProjectIdMqtt);
    }
    closePanel();
  }

  async function handleNew() {
    if ($activeProjectIdMqtt) {
      // Crear conversación en el backend
      await createConversation($activeProjectIdMqtt);
    } else {
      // Sin proyecto, crear temporal
      startNewConversation();
    }
    closePanel();
  }

  async function handleDelete(convId: string, event: MouseEvent) {
    event.stopPropagation();

    try {
      await mqttRequest('conversation', 'delete', { conversationId: convId });

      // Recargar lista
      if ($activeProjectIdMqtt) {
        await loadConversations($activeProjectIdMqtt);
      }

      // Si eliminamos la conversación activa, iniciar nueva
      if ($conversationId === convId) {
        startNewConversation();
      }
    } catch (error) {
      console.error('[HistoryPanel] Delete failed:', error);
    }
  }
</script>

<div class="history-panel">
  <button class="new-conversation" on:click={handleNew}>
    ➕ Nueva conversación
  </button>

  <div class="conversations-list">
    {#if $conversationsLoading}
      <div class="loading-state">
        <span class="loading-spinner"></span>
        <span class="loading-text">Cargando conversaciones...</span>
      </div>
    {:else if $conversationsError}
      <div class="error-state">
        <span class="error-icon">⚠️</span>
        <span class="error-text">{$conversationsError}</span>
      </div>
    {:else if !$activeProjectIdMqtt}
      <div class="empty-state">
        <span class="empty-icon">📁</span>
        <span class="empty-text">Sin proyecto activo</span>
        <span class="empty-hint">Selecciona un proyecto primero</span>
      </div>
    {:else if $conversationsList.length === 0}
      <div class="empty-state">
        <span class="empty-icon">💬</span>
        <span class="empty-text">No hay conversaciones</span>
        <span class="empty-hint">Inicia una nueva conversación</span>
      </div>
    {:else}
      {#each $conversationsList as conv (conv.id)}
        <button
          class="conversation-item"
          class:active={$conversationId === conv.id}
          on:click={() => handleSelect(conv.id)}
        >
          <div class="conv-header">
            <span class="conv-title">{conv.title || 'Sin título'}</span>
            <span class="conv-date">{formatDate(conv.updated_at)}</span>
          </div>
          <div class="conv-footer">
            <span class="conv-count">{conv.message_count || 0} mensajes</span>
            {#if conv.model}
              <span class="conv-model">{conv.model}</span>
            {/if}
            <button
              class="delete-btn"
              on:click={(e) => handleDelete(conv.id, e)}
              title="Eliminar"
            >
              🗑️
            </button>
          </div>
        </button>
      {/each}
    {/if}
  </div>
</div>

<style>
  .history-panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    height: 100%;
  }

  .new-conversation {
    width: 100%;
    padding: 0.75rem 1rem;
    background: var(--color-primary, #3b82f6);
    border: none;
    border-radius: 0.375rem;
    color: white;
    font-size: 0.9375rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .new-conversation:hover {
    background: var(--color-primary-hover, #2563eb);
  }

  .conversations-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    flex: 1;
    overflow-y: auto;
  }

  /* Loading state */
  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 2rem;
    color: var(--color-text-muted, #a3a3a3);
  }

  .loading-spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--color-border, rgba(255, 255, 255, 0.1));
    border-top-color: var(--color-primary, #3b82f6);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .loading-text {
    font-size: 0.875rem;
  }

  /* Error state */
  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 2rem;
    color: var(--color-error, #ef4444);
  }

  .error-icon {
    font-size: 2rem;
  }

  .error-text {
    font-size: 0.875rem;
    text-align: center;
  }

  /* Empty state */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem;
    color: var(--color-text-muted, #a3a3a3);
  }

  .empty-icon {
    font-size: 2.5rem;
    opacity: 0.5;
  }

  .empty-text {
    font-size: 1rem;
    font-weight: 500;
  }

  .empty-hint {
    font-size: 0.875rem;
    opacity: 0.7;
  }

  .conversation-item {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.75rem;
    background: var(--color-surface, rgba(255, 255, 255, 0.05));
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
    border-radius: 0.375rem;
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
    width: 100%;
  }

  .conversation-item:hover {
    background: var(--color-hover, rgba(255, 255, 255, 0.1));
    border-color: var(--color-border-hover, rgba(255, 255, 255, 0.2));
  }

  .conversation-item.active {
    background: var(--color-active, rgba(59, 130, 246, 0.2));
    border-color: var(--color-primary, #3b82f6);
  }

  .conv-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .conv-title {
    font-weight: 500;
    color: var(--color-text, #e5e5e5);
    font-size: 0.9375rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 70%;
  }

  .conv-date {
    font-size: 0.75rem;
    color: var(--color-text-muted, #a3a3a3);
    flex-shrink: 0;
  }

  .conv-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 0.25rem;
  }

  .conv-count {
    font-size: 0.75rem;
    color: var(--color-text-muted, #a3a3a3);
    opacity: 0.7;
  }

  .conv-model {
    font-size: 0.6875rem;
    color: var(--color-text-muted, #a3a3a3);
    background: var(--color-surface, rgba(255, 255, 255, 0.05));
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
  }

  .delete-btn {
    padding: 0.25rem;
    background: transparent;
    border: none;
    border-radius: 0.25rem;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s, background-color 0.15s;
    font-size: 0.875rem;
  }

  .conversation-item:hover .delete-btn {
    opacity: 0.7;
  }

  .delete-btn:hover {
    opacity: 1 !important;
    background: rgba(239, 68, 68, 0.2);
  }
</style>
