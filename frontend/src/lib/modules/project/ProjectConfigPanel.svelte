<script lang="ts">
  /**
   * ProjectConfigPanel - Panel de configuración de proyecto
   *
   * Gestiona las suscripciones de eventos del proyecto:
   * - Lista suscripciones existentes
   * - Añadir nuevas con filtros
   * - Eliminar suscripciones
   */

  import { onMount, createEventDispatcher } from 'svelte';
  import {
    getProjectSubscriptions,
    addProjectSubscription,
    removeProjectSubscription,
    type EventSubscription
  } from '$lib/stores/projects';

  const dispatch = createEventDispatcher<{
    back: void;
  }>();

  // Props
  export let projectId: string;
  export let projectName: string;

  // Estado
  let subscriptions: EventSubscription[] = [];
  let loading = true;
  let error: string | null = null;
  let showAddForm = false;
  let saving = false;
  let deletingId: string | null = null;

  // Form nueva suscripción
  let newSubscription = {
    event: 'telegram.file.received',
    action: 'save_file' as const,
    filters: [{ key: '', value: '' }],
    config: {
      path: '',
      notifyBot: '',
      notifyMessage: ''
    }
  };

  // Eventos disponibles
  const availableEvents = [
    { id: 'telegram.file.received', label: 'Archivo recibido (Telegram)' },
    { id: 'telegram.message.received', label: 'Mensaje recibido (Telegram)' },
    { id: 'telegram.photo.received', label: 'Foto recibida (Telegram)' },
    { id: 'telegram.document.received', label: 'Documento recibido (Telegram)' },
    { id: 'fs.file.created', label: 'Archivo creado (Storage)' },
    { id: 'fs.file.deleted', label: 'Archivo eliminado (Storage)' }
  ];

  // Acciones disponibles
  const availableActions = [
    { id: 'save_file', label: 'Guardar archivo' },
    { id: 'send_message', label: 'Enviar mensaje' },
    { id: 'publish_event', label: 'Publicar evento' }
  ];

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  onMount(async () => {
    await loadSubscriptions();
  });

  // ============================================================================
  // ACTIONS
  // ============================================================================

  async function loadSubscriptions(): Promise<void> {
    loading = true;
    error = null;
    try {
      subscriptions = await getProjectSubscriptions(projectId);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Error cargando suscripciones';
    } finally {
      loading = false;
    }
  }

  async function handleAddSubscription(): Promise<void> {
    if (saving) return;

    // Validar
    if (!newSubscription.event) {
      error = 'Selecciona un evento';
      return;
    }

    saving = true;
    error = null;

    try {
      // Construir filtro desde array de pares key-value
      const filter: Record<string, string> = {};
      for (const f of newSubscription.filters) {
        if (f.key.trim() && f.value.trim()) {
          filter[f.key.trim()] = f.value.trim();
        }
      }

      // Construir config según acción
      const config: Record<string, unknown> = {};
      if (newSubscription.action === 'save_file') {
        if (newSubscription.config.path) config.path = newSubscription.config.path;
        if (newSubscription.config.notifyBot) config.notifyBot = newSubscription.config.notifyBot;
        if (newSubscription.config.notifyMessage) config.notifyMessage = newSubscription.config.notifyMessage;
      } else if (newSubscription.action === 'send_message') {
        if (newSubscription.config.notifyBot) config.botName = newSubscription.config.notifyBot;
        if (newSubscription.config.notifyMessage) config.message = newSubscription.config.notifyMessage;
      }

      await addProjectSubscription(
        projectId,
        newSubscription.event,
        newSubscription.action,
        Object.keys(filter).length > 0 ? filter : undefined,
        Object.keys(config).length > 0 ? config : undefined
      );

      // Recargar lista
      await loadSubscriptions();

      // Reset form
      resetForm();
      showAddForm = false;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Error añadiendo suscripción';
    } finally {
      saving = false;
    }
  }

  async function handleRemoveSubscription(subscriptionId: string): Promise<void> {
    if (deletingId) return;

    if (!confirm('¿Eliminar esta suscripción?')) return;

    deletingId = subscriptionId;
    error = null;

    try {
      await removeProjectSubscription(projectId, subscriptionId);
      await loadSubscriptions();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Error eliminando suscripción';
    } finally {
      deletingId = null;
    }
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  function resetForm(): void {
    newSubscription = {
      event: 'telegram.file.received',
      action: 'save_file',
      filters: [{ key: '', value: '' }],
      config: {
        path: '',
        notifyBot: '',
        notifyMessage: ''
      }
    };
  }

  function addFilterRow(): void {
    newSubscription.filters = [...newSubscription.filters, { key: '', value: '' }];
  }

  function removeFilterRow(index: number): void {
    newSubscription.filters = newSubscription.filters.filter((_, i) => i !== index);
  }

  function getEventLabel(eventId: string): string {
    return availableEvents.find(e => e.id === eventId)?.label || eventId;
  }

  function getActionLabel(actionId: string): string {
    return availableActions.find(a => a.id === actionId)?.label || actionId;
  }

  function formatFilter(filter?: Record<string, string>): string {
    if (!filter || Object.keys(filter).length === 0) return 'Sin filtro';
    return Object.entries(filter).map(([k, v]) => `${k}="${v}"`).join(', ');
  }

  function formatConfig(config?: Record<string, unknown>): string {
    if (!config || Object.keys(config).length === 0) return '';
    return Object.entries(config).map(([k, v]) => `${k}: ${v}`).join(', ');
  }
</script>

<div class="config-panel">
  <!-- HEADER -->
  <header class="panel-header">
    <button class="btn-back" on:click={() => dispatch('back')} title="Volver">
      ←
    </button>
    <div class="header-title">
      <span class="header-icon">⚙️</span>
      <span class="header-text">{projectName}</span>
    </div>
  </header>

  <!-- ERROR -->
  {#if error}
    <div class="error-box">
      <span>{error}</span>
      <button class="btn-dismiss" on:click={() => error = null}>✕</button>
    </div>
  {/if}

  <!-- SECCIONES -->
  <div class="sections">
    <!-- SUSCRIPCIONES -->
    <section class="section">
      <div class="section-header">
        <h3 class="section-title">Suscripciones a Eventos</h3>
        <button
          class="btn-add-small"
          class:active={showAddForm}
          on:click={() => showAddForm = !showAddForm}
        >
          {showAddForm ? '✕' : '+'}
        </button>
      </div>

      <!-- FORM AÑADIR -->
      {#if showAddForm}
        <div class="add-form">
          <div class="form-group">
            <label class="form-label">Evento</label>
            <select class="form-select" bind:value={newSubscription.event}>
              {#each availableEvents as event}
                <option value={event.id}>{event.label}</option>
              {/each}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label">Filtros (AND)</label>
            {#each newSubscription.filters as filter, i}
              <div class="filter-row">
                <input
                  type="text"
                  class="form-input filter-key"
                  placeholder="campo"
                  bind:value={filter.key}
                />
                <span class="filter-equals">=</span>
                <input
                  type="text"
                  class="form-input filter-value"
                  placeholder="valor"
                  bind:value={filter.value}
                />
                <button
                  class="btn-filter-action"
                  on:click={() => removeFilterRow(i)}
                  disabled={newSubscription.filters.length === 1}
                >
                  −
                </button>
              </div>
            {/each}
            <button class="btn-add-filter" on:click={addFilterRow}>
              + Añadir filtro
            </button>
          </div>

          <div class="form-group">
            <label class="form-label">Acción</label>
            <select class="form-select" bind:value={newSubscription.action}>
              {#each availableActions as action}
                <option value={action.id}>{action.label}</option>
              {/each}
            </select>
          </div>

          <!-- Config según acción -->
          {#if newSubscription.action === 'save_file'}
            <div class="form-group">
              <label class="form-label">Ruta destino</label>
              <input
                type="text"
                class="form-input"
                placeholder="storage/facturas/{filename}"
                bind:value={newSubscription.config.path}
              />
              <span class="form-hint">Variables: {'{filename}'}, {'{date}'}, {'{botName}'}</span>
            </div>
            <div class="form-group">
              <label class="form-label">Bot notificación (opcional)</label>
              <input
                type="text"
                class="form-input"
                placeholder="nombre del bot"
                bind:value={newSubscription.config.notifyBot}
              />
            </div>
            <div class="form-group">
              <label class="form-label">Mensaje notificación (opcional)</label>
              <input
                type="text"
                class="form-input"
                placeholder="Archivo {'{filename}'} guardado"
                bind:value={newSubscription.config.notifyMessage}
              />
            </div>
          {:else if newSubscription.action === 'send_message'}
            <div class="form-group">
              <label class="form-label">Bot</label>
              <input
                type="text"
                class="form-input"
                placeholder="nombre del bot"
                bind:value={newSubscription.config.notifyBot}
              />
            </div>
            <div class="form-group">
              <label class="form-label">Mensaje</label>
              <input
                type="text"
                class="form-input"
                placeholder="Mensaje a enviar"
                bind:value={newSubscription.config.notifyMessage}
              />
            </div>
          {/if}

          <div class="form-actions">
            <button class="btn-cancel" on:click={() => { showAddForm = false; resetForm(); }}>
              Cancelar
            </button>
            <button class="btn-save" on:click={handleAddSubscription} disabled={saving}>
              {saving ? 'Guardando...' : 'Añadir Suscripción'}
            </button>
          </div>
        </div>
      {/if}

      <!-- LISTA -->
      <div class="subscriptions-list">
        {#if loading}
          <div class="empty-state">Cargando...</div>
        {:else if subscriptions.length === 0}
          <div class="empty-state">No hay suscripciones configuradas</div>
        {:else}
          {#each subscriptions as sub (sub.id)}
            <div class="subscription-item">
              <div class="subscription-header">
                <span class="subscription-event">{getEventLabel(sub.event)}</span>
                <button
                  class="btn-delete-sub"
                  on:click={() => handleRemoveSubscription(sub.id)}
                  disabled={deletingId === sub.id}
                  title="Eliminar"
                >
                  {deletingId === sub.id ? '...' : '🗑️'}
                </button>
              </div>
              <div class="subscription-details">
                <div class="subscription-filter">
                  <span class="detail-label">Filtro:</span>
                  <span class="detail-value">{formatFilter(sub.filter)}</span>
                </div>
                <div class="subscription-action">
                  <span class="detail-label">Acción:</span>
                  <span class="detail-value">{getActionLabel(sub.action)}</span>
                </div>
                {#if sub.config && Object.keys(sub.config).length > 0}
                  <div class="subscription-config">
                    <span class="detail-value config-value">{formatConfig(sub.config)}</span>
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>
    </section>
  </div>
</div>

<style>
  .config-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    height: 100%;
    min-height: 0;
  }

  /* ===== HEADER ===== */
  .panel-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-shrink: 0;
  }

  .btn-back {
    width: 2rem;
    height: 2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-surface, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
    border-radius: 0.375rem;
    color: var(--color-text, #e5e5e5);
    font-size: 1rem;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .btn-back:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .header-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
  }

  .header-icon {
    font-size: 1.125rem;
  }

  .header-text {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-text, #e5e5e5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ===== ERROR ===== */
  .error-box {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.625rem 0.75rem;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.25);
    border-radius: 0.5rem;
    color: #f87171;
    font-size: 0.875rem;
    flex-shrink: 0;
  }

  .btn-dismiss {
    background: none;
    border: none;
    color: #f87171;
    cursor: pointer;
    padding: 0.25rem;
  }

  /* ===== SECTIONS ===== */
  .sections {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  }

  .section-title {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-text-muted, #888);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .btn-add-small {
    width: 1.75rem;
    height: 1.75rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-primary, #3b82f6);
    border: none;
    border-radius: 0.375rem;
    color: white;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .btn-add-small:hover {
    background: #2563eb;
  }

  .btn-add-small.active {
    background: var(--color-error, #ef4444);
  }

  /* ===== ADD FORM ===== */
  .add-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem;
    background: var(--color-surface, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
    border-radius: 0.5rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .form-label {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-text-muted, #888);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .form-input,
  .form-select {
    padding: 0.5rem 0.75rem;
    background: var(--color-bg, #0d0d0d);
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
    border-radius: 0.375rem;
    color: var(--color-text, #e5e5e5);
    font-size: 0.875rem;
  }

  .form-input:focus,
  .form-select:focus {
    outline: none;
    border-color: var(--color-primary, #3b82f6);
  }

  .form-hint {
    font-size: 0.75rem;
    color: var(--color-text-muted, #666);
  }

  /* Filter rows */
  .filter-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .filter-key {
    flex: 1;
    min-width: 0;
  }

  .filter-equals {
    color: var(--color-text-muted, #888);
    font-size: 0.875rem;
  }

  .filter-value {
    flex: 1.5;
    min-width: 0;
  }

  .btn-filter-action {
    width: 1.75rem;
    height: 1.75rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
    border-radius: 0.25rem;
    color: var(--color-text-muted, #888);
    font-size: 1rem;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .btn-filter-action:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
    color: var(--color-text, #e5e5e5);
  }

  .btn-filter-action:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .btn-add-filter {
    padding: 0.375rem 0.5rem;
    background: transparent;
    border: 1px dashed var(--color-border, rgba(255, 255, 255, 0.2));
    border-radius: 0.375rem;
    color: var(--color-text-muted, #888);
    font-size: 0.75rem;
    cursor: pointer;
    transition: background-color 0.15s, border-color 0.15s;
  }

  .btn-add-filter:hover {
    background: rgba(255, 255, 255, 0.04);
    border-color: var(--color-primary, #3b82f6);
    color: var(--color-primary, #3b82f6);
  }

  /* Form actions */
  .form-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    padding-top: 0.5rem;
  }

  .btn-cancel,
  .btn-save {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .btn-cancel {
    background: transparent;
    color: var(--color-text-muted, #888);
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  }

  .btn-cancel:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .btn-save {
    background: var(--color-primary, #3b82f6);
    color: white;
  }

  .btn-save:hover:not(:disabled) {
    background: #2563eb;
  }

  .btn-save:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ===== SUBSCRIPTIONS LIST ===== */
  .subscriptions-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .empty-state {
    padding: 1.5rem 1rem;
    text-align: center;
    color: var(--color-text-muted, #666);
    font-size: 0.875rem;
  }

  .subscription-item {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    background: var(--color-surface, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
    border-radius: 0.5rem;
  }

  .subscription-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .subscription-event {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-primary, #3b82f6);
  }

  .btn-delete-sub {
    padding: 0.25rem;
    background: transparent;
    border: none;
    border-radius: 0.25rem;
    font-size: 0.875rem;
    cursor: pointer;
    opacity: 0.5;
    transition: opacity 0.15s, background-color 0.15s;
  }

  .subscription-item:hover .btn-delete-sub {
    opacity: 0.8;
  }

  .btn-delete-sub:hover:not(:disabled) {
    opacity: 1;
    background: rgba(239, 68, 68, 0.2);
  }

  .btn-delete-sub:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .subscription-details {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding-left: 0.25rem;
  }

  .subscription-filter,
  .subscription-action,
  .subscription-config {
    display: flex;
    align-items: baseline;
    gap: 0.375rem;
    font-size: 0.8125rem;
  }

  .detail-label {
    color: var(--color-text-muted, #888);
    flex-shrink: 0;
  }

  .detail-value {
    color: var(--color-text, #e5e5e5);
    word-break: break-word;
  }

  .config-value {
    color: var(--color-text-muted, #666);
    font-size: 0.75rem;
    font-style: italic;
  }
</style>
