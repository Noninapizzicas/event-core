<script lang="ts">
  /**
   * ProjectPanel - Panel de gestión de proyectos (MQTT)
   *
   * - Lista de proyectos con búsqueda
   * - Crear nuevo proyecto
   * - Añadir módulos al proyecto activo (checklist)
   * - Editar/eliminar proyecto
   * - Seleccionar/activar proyecto
   */

  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { activeProject, selectProject, closePanel } from '$lib/stores';
  import {
    projectsStore,
    initProjectsSubscriptions,
    createProjectMqtt,
    updateProjectMqtt,
    deleteProjectMqtt,
    activateProjectMqtt,
    addFeaturesMqtt,
    listFeaturesMqtt
  } from '$lib/stores';
  import { PROJECT_COLORS } from '$lib/ui-core';

  interface Feature {
    id: string;
    label: string;
    icon: string;
    description: string;
    dependencies: string[];
    installed: boolean;
    handlersAvailable: boolean;
  }

  // Props
  export let panelId: string = '';

  // ============================================================================
  // ESTADO LOCAL
  // ============================================================================

  let searchQuery = '';

  // Módulos disponibles — cargados dinámicamente desde blueprints
  let availableFeatures: Feature[] = [];

  // Form crear
  let showCreateForm = false;
  let createForm = {
    name: '',
    description: '',
    color: 'blue'
  };
  let creating = false;

  // Añadir módulos
  let showFeatures = false;
  let selectedFeatures: Set<string> = new Set();
  let addingFeatures = false;

  // Edición inline
  let editingId: string | null = null;
  let editForm = { name: '', description: '' };
  let saving = false;

  // Eliminar
  let deletingId: string | null = null;

  // Cleanup
  let cleanup: (() => void) | null = null;

  // ============================================================================
  // SUSCRIPCIÓN MQTT
  // ============================================================================

  async function loadFeatures(): Promise<void> {
    availableFeatures = await listFeaturesMqtt($activeProject?.id);
  }

  onMount(async () => {
    cleanup = initProjectsSubscriptions();
    await loadFeatures();
  });
  onDestroy(() => { cleanup?.(); });

  // ============================================================================
  // ACCIONES
  // ============================================================================

  function toggleFeature(id: string): void {
    if (selectedFeatures.has(id)) {
      selectedFeatures.delete(id);
    } else {
      selectedFeatures.add(id);
    }
    selectedFeatures = selectedFeatures; // trigger reactivity
  }

  function handleCreate(): void {
    if (!createForm.name.trim() || creating) return;

    creating = true;
    createProjectMqtt(
      createForm.name.trim(),
      createForm.description.trim(),
      createForm.color
    );

    setTimeout(() => {
      createForm = { name: '', description: '', color: 'blue' };
      showCreateForm = false;
      creating = false;
    }, 300);
  }

  async function handleAddFeatures(): Promise<void> {
    if (!$activeProject || selectedFeatures.size === 0 || addingFeatures) return;

    addingFeatures = true;
    try {
      await addFeaturesMqtt($activeProject.id, [...selectedFeatures]);
      selectedFeatures = new Set();
      await loadFeatures(); // Recargar estado
    } catch (err) {
      console.error('[ProjectPanel] Add features failed:', err);
    } finally {
      addingFeatures = false;
    }
  }

  function handleUpdate(id: string): void {
    if (!editForm.name.trim() || saving) return;
    saving = true;
    updateProjectMqtt(id, { name: editForm.name.trim(), description: editForm.description.trim() });
    setTimeout(() => { editingId = null; saving = false; }, 300);
  }

  function handleDelete(id: string): void {
    if (deletingId || $activeProject?.id === id) return;
    if (!confirm('¿Eliminar este proyecto?')) return;
    deletingId = id;
    deleteProjectMqtt(id);
    setTimeout(() => { deletingId = null; }, 300);
  }

  function handleActivate(project: typeof $projectsStore.projects[0]): void {
    activateProjectMqtt(project.id);
    selectProject({
      id: project.id,
      name: project.name,
      color: project.color,
      icon: project.icon,
      workspaceType: project.workspaceType
    });
    closePanel();

    // Navegar a la ruta project-scoped (preferir slug sobre UUID)
    const currentPath = $page.url.pathname;
    const subRoute = getSubRoute(currentPath);
    const projectParam = project.slug || project.id;
    goto(`/${projectParam}/${subRoute}`);
  }

  /**
   * Extrae la sub-ruta actual para reutilizarla con el nuevo proyecto.
   * /old_project/chat → chat
   * /old_project/facturas → facturas
   * /chat → chat
   * / → chat (default)
   */
  function getSubRoute(path: string): string {
    const segments = path.split('/').filter(Boolean);

    if (segments.length === 0) {
      return 'chat';
    }

    if (segments.length === 1) {
      // /chat, /facturas, /comandero → usar como sub-ruta
      return segments[0];
    }

    // /project_id/chat → chat, /project_id/comandero/cuenta_id → comandero/cuenta_id
    return segments.slice(1).join('/');
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  function startEdit(project: typeof $projectsStore.projects[0], event: MouseEvent): void {
    event.stopPropagation();
    editingId = project.id;
    editForm = { name: project.name, description: project.description };
  }

  function cancelEdit(): void { editingId = null; }

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
    <input type="text" class="search-input" placeholder="Buscar proyecto..." bind:value={searchQuery} />
    <button class="btn-add" class:active={showCreateForm} on:click={() => showCreateForm = !showCreateForm}
      title={showCreateForm ? 'Cancelar' : 'Nuevo proyecto'}>
      {showCreateForm ? '✕' : '+'}
    </button>
  </header>

  <!-- ===== FORM CREAR ===== -->
  {#if showCreateForm}
    <form class="create-form" on:submit|preventDefault={handleCreate}>
      <input type="text" class="input" placeholder="Nombre del proyecto" bind:value={createForm.name} disabled={creating} />
      <input type="text" class="input" placeholder="Descripción (opcional)" bind:value={createForm.description} disabled={creating} />
      <div class="color-row">
        <span class="color-label">Color:</span>
        <div class="color-options">
          {#each PROJECT_COLORS as color (color.id)}
            <button type="button" class="color-btn" class:selected={createForm.color === color.id}
              style="background-color: {color.hex}" on:click={() => createForm.color = color.id} title={color.id}></button>
          {/each}
        </div>
      </div>
      <button type="submit" class="btn-create" disabled={!createForm.name.trim() || creating}>
        {creating ? 'Creando...' : 'Crear proyecto'}
      </button>
    </form>
  {/if}

  <!-- ===== AÑADIR MÓDULOS (proyecto activo) ===== -->
  {#if $activeProject}
    <div class="features-section">
      <button class="features-toggle" on:click={() => { showFeatures = !showFeatures; if (showFeatures) loadFeatures(); }}>
        <span>{showFeatures ? '▾' : '▸'} Módulos</span>
        <span class="features-project">{$activeProject.name}</span>
      </button>

      {#if showFeatures}
        <div class="features-list">
          {#each availableFeatures as feat (feat.id)}
            <button
              type="button"
              class="feature-btn"
              class:installed={feat.installed}
              class:selected={!feat.installed && selectedFeatures.has(feat.id)}
              on:click={() => !feat.installed && toggleFeature(feat.id)}
              disabled={feat.installed}
              title={feat.installed ? `${feat.label} ya instalado` : feat.description}
            >
              <span class="feature-check">{feat.installed ? '✓' : selectedFeatures.has(feat.id) ? '☑' : '☐'}</span>
              <span class="feature-icon">{feat.icon}</span>
              <span class="feature-info">
                <span class="feature-name">{feat.label}</span>
                <span class="feature-desc">
                  {#if feat.installed}
                    Instalado
                  {:else}
                    {feat.description}
                  {/if}
                </span>
              </span>
              {#if !feat.handlersAvailable && !feat.installed}
                <span class="warn-badge">sin handlers</span>
              {/if}
            </button>
          {/each}

          {#if selectedFeatures.size > 0}
            <button class="btn-apply" on:click={handleAddFeatures} disabled={addingFeatures}>
              {addingFeatures ? 'Aplicando...' : `Aplicar ${selectedFeatures.size} módulo${selectedFeatures.size > 1 ? 's' : ''}`}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <!-- ===== ERROR ===== -->
  {#if $projectsStore.error}
    <div class="error-box"><span>{$projectsStore.error}</span></div>
  {/if}

  <!-- ===== LISTA ===== -->
  <div class="projects-list">
    {#if $projectsStore.loading}
      <div class="empty-state">Cargando...</div>
    {:else if filteredProjects.length === 0}
      <div class="empty-state">{searchQuery ? 'Sin resultados' : 'No hay proyectos'}</div>
    {:else}
      {#each filteredProjects as project (project.id)}
        {#if editingId === project.id}
          <div class="project-item editing">
            <input type="text" class="edit-input" bind:value={editForm.name}
              on:keydown={(e) => e.key === 'Enter' && handleUpdate(project.id)}
              on:keydown={(e) => e.key === 'Escape' && cancelEdit()} disabled={saving} />
            <button class="btn-icon save" on:click={() => handleUpdate(project.id)} disabled={saving || !editForm.name.trim()} title="Guardar">✓</button>
            <button class="btn-icon cancel" on:click={cancelEdit} disabled={saving} title="Cancelar">✕</button>
          </div>
        {:else}
          <div class="project-item" class:active={$activeProject?.id === project.id}
            role="button" tabindex="0"
            on:click={() => handleActivate(project)}
            on:keydown={(e) => e.key === 'Enter' && handleActivate(project)}>
            <span class="color-indicator" style="background: {getColorHex(project.color)}"></span>
            <span class="project-icon">{getColorEmoji(project.color)}</span>
            <span class="project-name">{project.name}</span>
            {#if $activeProject?.id === project.id}
              <span class="active-badge">activo</span>
            {/if}
            <button class="btn-icon edit" on:click|stopPropagation={(e) => startEdit(project, e)} title="Editar">✏️</button>
            <button class="btn-icon delete" on:click|stopPropagation={() => handleDelete(project.id)}
              disabled={$activeProject?.id === project.id || deletingId === project.id}
              title={$activeProject?.id === project.id ? 'No puedes eliminar el proyecto activo' : 'Eliminar'}>
              {deletingId === project.id ? '...' : '🗑️'}
            </button>
          </div>
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

  .search-input:focus { outline: none; border-color: var(--color-primary, #3b82f6); }

  .btn-add {
    width: 2.5rem; height: 2.5rem;
    display: flex; align-items: center; justify-content: center;
    background: var(--color-primary, #3b82f6);
    border: none; border-radius: 0.5rem;
    color: white; font-size: 1.25rem; font-weight: 600;
    cursor: pointer; transition: background-color 0.15s;
  }
  .btn-add:hover { background: #2563eb; }
  .btn-add.active { background: var(--color-error, #ef4444); }

  /* ===== FORM CREAR ===== */
  .create-form {
    display: flex; flex-direction: column; gap: 0.5rem;
    padding: 0.75rem;
    background: var(--color-surface, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
    border-radius: 0.5rem; flex-shrink: 0;
  }

  .input {
    padding: 0.5rem 0.75rem;
    background: var(--color-bg, #0d0d0d);
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
    border-radius: 0.375rem;
    color: var(--color-text, #e5e5e5); font-size: 0.875rem;
  }
  .input:focus { outline: none; border-color: var(--color-primary, #3b82f6); }
  .input:disabled { opacity: 0.6; }

  /* ===== AÑADIR MÓDULOS ===== */
  .features-section {
    flex-shrink: 0;
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
    border-radius: 0.5rem;
    overflow: hidden;
  }

  .features-toggle {
    width: 100%; display: flex; align-items: center; justify-content: space-between;
    padding: 0.5rem 0.75rem;
    background: var(--color-surface, rgba(255, 255, 255, 0.04));
    border: none; color: var(--color-text, #e5e5e5);
    font-size: 0.8125rem; cursor: pointer;
    transition: background-color 0.15s;
  }
  .features-toggle:hover { background: rgba(255, 255, 255, 0.06); }
  .features-project {
    font-size: 0.75rem; color: var(--color-text-muted, #888);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 50%;
  }

  .features-list {
    display: flex; flex-direction: column; gap: 0.375rem;
    padding: 0.5rem;
  }

  .feature-btn {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.5rem 0.625rem;
    background: var(--color-bg, #0d0d0d);
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
    border-radius: 0.375rem;
    color: var(--color-text-muted, #888); font-size: 0.8125rem;
    cursor: pointer; transition: border-color 0.15s, color 0.15s, background-color 0.15s;
    text-align: left;
  }
  .feature-btn:hover { border-color: rgba(255, 255, 255, 0.25); color: var(--color-text, #e5e5e5); }
  .feature-btn.selected {
    border-color: var(--color-success, #22c55e);
    color: var(--color-text, #e5e5e5);
    background: rgba(34, 197, 94, 0.08);
  }
  .feature-check { font-size: 0.875rem; flex-shrink: 0; }
  .feature-icon { font-size: 1rem; flex-shrink: 0; }
  .feature-info { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .feature-name { font-size: 0.8125rem; font-weight: 500; }
  .feature-desc { font-size: 0.6875rem; color: var(--color-text-muted, #888); }

  .feature-btn.installed {
    opacity: 0.6; cursor: default;
    border-color: rgba(34, 197, 94, 0.3);
    background: rgba(34, 197, 94, 0.05);
  }
  .feature-btn.installed .feature-check { color: var(--color-success, #22c55e); }

  .warn-badge {
    font-size: 0.5625rem; flex-shrink: 0;
    padding: 0.125rem 0.3125rem;
    background: rgba(245, 158, 11, 0.2);
    color: #f59e0b;
    border-radius: 0.1875rem;
    font-weight: 600;
  }

  .btn-apply {
    padding: 0.5rem;
    background: var(--color-success, #22c55e);
    border: none; border-radius: 0.375rem;
    color: white; font-size: 0.8125rem; font-weight: 500;
    cursor: pointer; transition: background-color 0.15s;
  }
  .btn-apply:hover:not(:disabled) { background: #16a34a; }
  .btn-apply:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ===== COLOR ===== */
  .color-row { display: flex; align-items: center; gap: 0.5rem; }
  .color-label { font-size: 0.8125rem; color: var(--color-text-muted, #888); }
  .color-options { display: flex; gap: 0.375rem; flex-wrap: wrap; }
  .color-btn {
    width: 1.5rem; height: 1.5rem;
    border: 2px solid transparent; border-radius: 50%;
    cursor: pointer; transition: transform 0.15s, border-color 0.15s;
  }
  .color-btn:hover { transform: scale(1.15); }
  .color-btn.selected { border-color: white; }

  .btn-create {
    padding: 0.625rem;
    background: var(--color-primary, #3b82f6);
    border: none; border-radius: 0.375rem;
    color: white; font-size: 0.875rem; font-weight: 500;
    cursor: pointer; transition: background-color 0.15s;
  }
  .btn-create:hover:not(:disabled) { background: #2563eb; }
  .btn-create:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ===== ERROR ===== */
  .error-box {
    padding: 0.625rem 0.75rem;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.25);
    border-radius: 0.5rem; color: #f87171; font-size: 0.875rem; flex-shrink: 0;
  }

  /* ===== LISTA ===== */
  .projects-list {
    flex: 1; display: flex; flex-direction: column; gap: 0.375rem;
    overflow-y: auto; min-height: 0;
  }
  .empty-state { padding: 2rem 1rem; text-align: center; color: var(--color-text-muted, #666); font-size: 0.9375rem; }

  /* ===== ITEM ===== */
  .project-item {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.75rem;
    background: var(--color-surface, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
    border-radius: 0.5rem;
    color: var(--color-text, #e5e5e5); font-size: 0.9375rem;
    text-align: left; cursor: pointer;
    transition: background-color 0.15s, border-color 0.15s;
  }
  .project-item:hover { background: rgba(255, 255, 255, 0.06); border-color: rgba(255, 255, 255, 0.15); }
  .project-item.active { background: rgba(59, 130, 246, 0.12); border-color: var(--color-primary, #3b82f6); }
  .project-item.editing { cursor: default; }

  .color-indicator { width: 4px; height: 1.5rem; border-radius: 2px; flex-shrink: 0; }
  .project-icon { font-size: 1.125rem; flex-shrink: 0; }
  .project-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .active-badge {
    padding: 0.125rem 0.375rem;
    background: var(--color-success, #22c55e); border-radius: 0.25rem;
    color: white; font-size: 0.625rem; font-weight: 600;
    text-transform: uppercase; flex-shrink: 0;
  }

  /* ===== BOTONES INLINE ===== */
  .btn-icon {
    padding: 0.25rem; background: transparent; border: none; border-radius: 0.25rem;
    font-size: 0.875rem; cursor: pointer; opacity: 0;
    transition: opacity 0.15s, background-color 0.15s;
  }
  .project-item:hover .btn-icon { opacity: 0.7; }
  .btn-icon:hover { opacity: 1 !important; background: rgba(255, 255, 255, 0.1); }
  .btn-icon.delete:hover { background: rgba(239, 68, 68, 0.2); }
  .btn-icon:disabled { opacity: 0.3 !important; cursor: not-allowed; }
  .btn-icon.save, .btn-icon.cancel { opacity: 1; }
  .btn-icon.save { color: var(--color-success, #22c55e); }
  .btn-icon.cancel { color: var(--color-text-muted, #888); }

  .edit-input {
    flex: 1; padding: 0.375rem 0.5rem;
    background: var(--color-bg, #0d0d0d);
    border: 1px solid var(--color-primary, #3b82f6);
    border-radius: 0.25rem;
    color: var(--color-text, #e5e5e5); font-size: 0.875rem;
  }
  .edit-input:focus { outline: none; }
  .edit-input:disabled { opacity: 0.6; }
</style>
