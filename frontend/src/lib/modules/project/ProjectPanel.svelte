<script lang="ts">
  /**
   * ProjectPanel - Panel único de gestión de proyectos (MQTT)
   *
   * Funcionalidades:
   * - Lista de proyectos con búsqueda
   * - Crear nuevo proyecto (form expandible)
   * - Editar proyecto (inline)
   * - Eliminar proyecto
   * - Seleccionar/activar proyecto
   *
   * Comunicación via MQTT (NO REST):
   * - project/state/request → solicita lista
   * - project/state → recibe lista
   * - project/create → crea proyecto
   * - project/update → actualiza proyecto
   * - project/delete → elimina proyecto
   * - project/activate → activa proyecto
   */

  import { onMount, onDestroy } from 'svelte';
  import { activeProject, selectProject, closePanel, handleProjectChange } from '$lib/stores';
  import {
    projectsStore,
    initProjectsSubscriptions,
    createProjectMqtt,
    updateProjectMqtt,
    deleteProjectMqtt,
    activateProjectMqtt
  } from '$lib/stores';
  import { PROJECT_COLORS } from '$lib/ui-core';

  // Props
  export let panelId: string = '';

  // ============================================================================
  // ESTADO LOCAL
  // ============================================================================

  let searchQuery = '';

  // Form crear
  let showCreateForm = false;
  let createForm = {
    name: '',
    description: '',
    color: 'blue'
  };
  let creating = false;

  // Edición inline
  let editingId: string | null = null;
  let editForm = {
    name: '',
    description: ''
  };
  let saving = false;

  // Eliminar
  let deletingId: string | null = null;

  // Cleanup
  let cleanup: (() => void) | null = null;

  // ============================================================================
  // SUSCRIPCIÓN MQTT
  // ============================================================================

  onMount(() => {
    cleanup = initProjectsSubscriptions();
  });

  onDestroy(() => {
    cleanup?.();
  });

  // ============================================================================
  // ACCIONES
  // ============================================================================

  function handleCreate(): void {
    if (!createForm.name.trim() || creating) return;

    creating = true;
    createProjectMqtt(
      createForm.name.trim(),
      createForm.description.trim(),
      createForm.color
    );

    // Reset form después de un momento (el store se actualiza via MQTT)
    setTimeout(() => {
      createForm = { name: '', description: '', color: 'blue' };
      showCreateForm = false;
      creating = false;
    }, 300);
  }

  function handleUpdate(id: string): void {
    if (!editForm.name.trim() || saving) return;

    saving = true;
    updateProjectMqtt(id, {
      name: editForm.name.trim(),
      description: editForm.description.trim()
    });

    // Reset edit después de un momento
    setTimeout(() => {
      editingId = null;
      saving = false;
    }, 300);
  }

  function handleDelete(id: string): void {
    if (deletingId) return;

    // No permitir eliminar proyecto activo
    if ($activeProject?.id === id) {
      return;
    }

    if (!confirm('¿Eliminar este proyecto?')) return;

    deletingId = id;
    deleteProjectMqtt(id);

    // Reset después de un momento
    setTimeout(() => {
      deletingId = null;
    }, 300);
  }

  async function handleActivate(project: typeof $projectsStore.projects[0]): Promise<void> {
    // Actualizar store local inmediatamente para feedback
    selectProject({
      id: project.id,
      name: project.name,
      color: project.color,
      icon: project.icon,
      workspaceType: project.workspaceType
    });

    closePanel();

    // Activar proyecto y cargar conversaciones (en background)
    await handleProjectChange(project.id);
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  function startEdit(project: typeof $projectsStore.projects[0], event: MouseEvent): void {
    event.stopPropagation();
    editingId = project.id;
    editForm = {
      name: project.name,
      description: project.description
    };
  }

  function cancelEdit(): void {
    editingId = null;
  }

  function getColorHex(colorId: string): string {
    return PROJECT_COLORS.find(c => c.id === colorId)?.hex || '#3b82f6';
  }

  function getColorEmoji(colorId: string): string {
    return PROJECT_COLORS.find(c => c.id === colorId)?.emoji || '📁';
  }

  // Filtrar proyectos
  $: filteredProjects = searchQuery
    ? $projectsStore.projects.filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : $projectsStore.projects;
</script>

<div class="project-panel">
  <!-- ===== HEADER ===== -->
  <header class="panel-header">
    <input
      type="text"
      class="search-input"
      placeholder="Buscar proyecto..."
      bind:value={searchQuery}
    />
    <button
      class="btn-add"
      class:active={showCreateForm}
      on:click={() => showCreateForm = !showCreateForm}
      title={showCreateForm ? 'Cancelar' : 'Nuevo proyecto'}
    >
      {showCreateForm ? '✕' : '+'}
    </button>
  </header>

  <!-- ===== FORM CREAR ===== -->
  {#if showCreateForm}
    <form class="create-form" on:submit|preventDefault={handleCreate}>
      <input
        type="text"
        class="input"
        placeholder="Nombre del proyecto"
        bind:value={createForm.name}
        disabled={creating}
      />
      <input
        type="text"
        class="input"
        placeholder="Descripción (opcional)"
        bind:value={createForm.description}
        disabled={creating}
      />
      <div class="color-row">
        <span class="color-label">Color:</span>
        <div class="color-options">
          {#each PROJECT_COLORS as color (color.id)}
            <button
              type="button"
              class="color-btn"
              class:selected={createForm.color === color.id}
              style="background-color: {color.hex}"
              on:click={() => createForm.color = color.id}
              title={color.id}
            />
          {/each}
        </div>
      </div>
      <button
        type="submit"
        class="btn-create"
        disabled={!createForm.name.trim() || creating}
      >
        {creating ? 'Creando...' : 'Crear proyecto'}
      </button>
    </form>
  {/if}

  <!-- ===== ERROR ===== -->
  {#if $projectsStore.error}
    <div class="error-box">
      <span>{$projectsStore.error}</span>
    </div>
  {/if}

  <!-- ===== LISTA ===== -->
  <div class="projects-list">
    {#if $projectsStore.loading}
      <div class="empty-state">Cargando...</div>
    {:else if filteredProjects.length === 0}
      <div class="empty-state">
        {searchQuery ? 'Sin resultados' : 'No hay proyectos'}
      </div>
    {:else}
      {#each filteredProjects as project (project.id)}
        {#if editingId === project.id}
          <!-- MODO EDICIÓN -->
          <div class="project-item editing">
            <input
              type="text"
              class="edit-input"
              bind:value={editForm.name}
              on:keydown={(e) => e.key === 'Enter' && handleUpdate(project.id)}
              on:keydown={(e) => e.key === 'Escape' && cancelEdit()}
              disabled={saving}
            />
            <button
              class="btn-icon save"
              on:click={() => handleUpdate(project.id)}
              disabled={saving || !editForm.name.trim()}
              title="Guardar"
            >
              ✓
            </button>
            <button
              class="btn-icon cancel"
              on:click={cancelEdit}
              disabled={saving}
              title="Cancelar"
            >
              ✕
            </button>
          </div>
        {:else}
          <!-- MODO NORMAL -->
          <button
            class="project-item"
            class:active={$activeProject?.id === project.id}
            on:click={() => handleActivate(project)}
          >
            <span class="color-indicator" style="background: {getColorHex(project.color)}"></span>
            <span class="project-icon">{getColorEmoji(project.color)}</span>
            <span class="project-name">{project.name}</span>

            {#if $activeProject?.id === project.id}
              <span class="active-badge">activo</span>
            {/if}

            <button
              class="btn-icon edit"
              on:click={(e) => startEdit(project, e)}
              title="Editar"
            >
              ✏️
            </button>
            <button
              class="btn-icon delete"
              on:click|stopPropagation={() => handleDelete(project.id)}
              disabled={$activeProject?.id === project.id || deletingId === project.id}
              title={$activeProject?.id === project.id ? 'No puedes eliminar el proyecto activo' : 'Eliminar'}
            >
              {deletingId === project.id ? '...' : '🗑️'}
            </button>
          </button>
        {/if}
      {/each}
    {/if}
  </div>
</div>

<style>
  .project-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    height: 100%;
    min-height: 0;
  }

  /* ===== HEADER ===== */
  .panel-header {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    padding: 0.625rem 0.75rem;
    background: var(--color-bg, #0d0d0d);
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
    border-radius: 0.5rem;
    color: var(--color-text, #e5e5e5);
    font-size: 0.9375rem;
  }

  .search-input:focus {
    outline: none;
    border-color: var(--color-primary, #3b82f6);
  }

  .btn-add {
    width: 2.5rem;
    height: 2.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-primary, #3b82f6);
    border: none;
    border-radius: 0.5rem;
    color: white;
    font-size: 1.25rem;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .btn-add:hover {
    background: #2563eb;
  }

  .btn-add.active {
    background: var(--color-error, #ef4444);
  }

  /* ===== FORM CREAR ===== */
  .create-form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    background: var(--color-surface, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
    border-radius: 0.5rem;
    flex-shrink: 0;
  }

  .input {
    padding: 0.5rem 0.75rem;
    background: var(--color-bg, #0d0d0d);
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
    border-radius: 0.375rem;
    color: var(--color-text, #e5e5e5);
    font-size: 0.875rem;
  }

  .input:focus {
    outline: none;
    border-color: var(--color-primary, #3b82f6);
  }

  .input:disabled {
    opacity: 0.6;
  }

  .color-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .color-label {
    font-size: 0.8125rem;
    color: var(--color-text-muted, #888);
  }

  .color-options {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
  }

  .color-btn {
    width: 1.5rem;
    height: 1.5rem;
    border: 2px solid transparent;
    border-radius: 50%;
    cursor: pointer;
    transition: transform 0.15s, border-color 0.15s;
  }

  .color-btn:hover {
    transform: scale(1.15);
  }

  .color-btn.selected {
    border-color: white;
  }

  .btn-create {
    padding: 0.625rem;
    background: var(--color-primary, #3b82f6);
    border: none;
    border-radius: 0.375rem;
    color: white;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .btn-create:hover:not(:disabled) {
    background: #2563eb;
  }

  .btn-create:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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

  /* ===== LISTA ===== */
  .projects-list {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    overflow-y: auto;
    min-height: 0;
  }

  .empty-state {
    padding: 2rem 1rem;
    text-align: center;
    color: var(--color-text-muted, #666);
    font-size: 0.9375rem;
  }

  /* ===== ITEM ===== */
  .project-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem;
    background: var(--color-surface, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
    border-radius: 0.5rem;
    color: var(--color-text, #e5e5e5);
    font-size: 0.9375rem;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.15s, border-color 0.15s;
  }

  .project-item:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.15);
  }

  .project-item.active {
    background: rgba(59, 130, 246, 0.12);
    border-color: var(--color-primary, #3b82f6);
  }

  .project-item.editing {
    cursor: default;
  }

  .color-indicator {
    width: 4px;
    height: 1.5rem;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .project-icon {
    font-size: 1.125rem;
    flex-shrink: 0;
  }

  .project-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .active-badge {
    padding: 0.125rem 0.375rem;
    background: var(--color-success, #22c55e);
    border-radius: 0.25rem;
    color: white;
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    flex-shrink: 0;
  }

  /* ===== BOTONES INLINE ===== */
  .btn-icon {
    padding: 0.25rem;
    background: transparent;
    border: none;
    border-radius: 0.25rem;
    font-size: 0.875rem;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s, background-color 0.15s;
  }

  .project-item:hover .btn-icon {
    opacity: 0.7;
  }

  .btn-icon:hover {
    opacity: 1 !important;
    background: rgba(255, 255, 255, 0.1);
  }

  .btn-icon.delete:hover {
    background: rgba(239, 68, 68, 0.2);
  }

  .btn-icon:disabled {
    opacity: 0.3 !important;
    cursor: not-allowed;
  }

  /* Edición: mostrar siempre */
  .btn-icon.save,
  .btn-icon.cancel {
    opacity: 1;
  }

  .btn-icon.save {
    color: var(--color-success, #22c55e);
  }

  .btn-icon.cancel {
    color: var(--color-text-muted, #888);
  }

  /* ===== INPUT EDICIÓN ===== */
  .edit-input {
    flex: 1;
    padding: 0.375rem 0.5rem;
    background: var(--color-bg, #0d0d0d);
    border: 1px solid var(--color-primary, #3b82f6);
    border-radius: 0.25rem;
    color: var(--color-text, #e5e5e5);
    font-size: 0.875rem;
  }

  .edit-input:focus {
    outline: none;
  }

  .edit-input:disabled {
    opacity: 0.6;
  }
</style>
