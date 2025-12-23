<script lang="ts">
  /**
   * FilesPanel - Unified File Management Panel
   *
   * Adaptive views:
   * - Explorer: File browser navigation
   * - Editor: Text file editing
   * - PDF: PDF viewing
   * - Image: Image viewing
   */

  import { onMount, onDestroy } from 'svelte';
  import {
    filesStore,
    listFiles,
    openFile,
    saveFile,
    createFile,
    deleteFile,
    navigateUp,
    closeFile,
    updateEditorContent,
    searchFiles,
    clearSearch,
    formatContent,
    getFileIcon,
    formatFileSize,
    type FileItem
  } from '$lib/stores/files';

  export let _panelId: string;

  // Subscribe to store
  let state = $filesStore;
  $: state = $filesStore;

  // Local UI state
  let searchInput = '';
  let newFileName = '';
  let newFileType: 'file' | 'directory' = 'file';
  let showNewFileForm = false;
  let confirmDelete: string | null = null;

  // Start in root mode - navigate all projects
  onMount(() => {
    listFiles('/');
  });

  // Handlers
  function handleItemClick(item: FileItem) {
    if (item.type === 'directory') {
      const newPath = state.currentPath === '/'
        ? `/${item.name}`
        : `${state.currentPath}/${item.name}`;
      listFiles(newPath);
    } else {
      const filePath = state.currentPath === '/'
        ? `/${item.name}`
        : `${state.currentPath}/${item.name}`;
      openFile(filePath);
    }
  }

  function handleGoUp() {
    navigateUp();
  }

  function handleClose() {
    closeFile();
  }

  async function handleSave() {
    await saveFile();
  }

  function handleContentChange(event: Event) {
    const target = event.target as HTMLTextAreaElement;
    updateEditorContent(target.value);
  }

  async function handleFormat() {
    await formatContent();
  }

  function handleSearch() {
    if (searchInput.trim()) {
      searchFiles(searchInput);
    } else {
      clearSearch();
    }
  }

  function handleClearSearch() {
    searchInput = '';
    clearSearch();
  }

  async function handleCreateFile() {
    if (!newFileName.trim()) return;

    const success = await createFile(newFileName, newFileType);
    if (success) {
      newFileName = '';
      showNewFileForm = false;
    }
  }

  function handleCancelCreate() {
    newFileName = '';
    showNewFileForm = false;
  }

  async function handleDelete(filePath: string) {
    if (confirmDelete === filePath) {
      await deleteFile(filePath);
      confirmDelete = null;
    } else {
      confirmDelete = filePath;
      // Auto-cancel after 3 seconds
      setTimeout(() => {
        if (confirmDelete === filePath) {
          confirmDelete = null;
        }
      }, 3000);
    }
  }

  // Path breadcrumbs
  $: breadcrumbs = (() => {
    const parts = state.currentPath.split('/').filter(Boolean);
    const crumbs = [{ name: '/', path: '/' }];
    let accumulated = '';
    for (const part of parts) {
      accumulated += '/' + part;
      crumbs.push({ name: part, path: accumulated });
    }
    return crumbs;
  })();
</script>

<div class="files-panel">
  {#if state.currentView === 'explorer'}
    <!-- EXPLORER VIEW -->
    <div class="explorer-view">
      <!-- Header with path and actions -->
      <div class="header">
        <button class="icon-btn" on:click={handleGoUp} disabled={state.currentPath === '/'} title="Subir">
          ⬆️
        </button>

        <div class="breadcrumbs">
          {#each breadcrumbs as crumb, i}
            {#if i > 0}<span class="separator">/</span>{/if}
            <button
              class="crumb"
              class:current={crumb.path === state.currentPath}
              on:click={() => listFiles(crumb.path)}
            >
              {crumb.name}
            </button>
          {/each}
        </div>

        <button class="icon-btn" on:click={() => showNewFileForm = !showNewFileForm} title="Nuevo">
          ➕
        </button>
      </div>

      <!-- Search bar -->
      <div class="search-bar">
        <input
          type="text"
          class="search-input"
          placeholder="Buscar archivos..."
          bind:value={searchInput}
          on:keydown={(e) => e.key === 'Enter' && handleSearch()}
        />
        {#if state.searchActive}
          <button class="icon-btn small" on:click={handleClearSearch}>✖</button>
        {:else}
          <button class="icon-btn small" on:click={handleSearch}>🔍</button>
        {/if}
      </div>

      <!-- New file form -->
      {#if showNewFileForm}
        <div class="new-file-form">
          <input
            type="text"
            class="input"
            placeholder="Nombre del archivo o carpeta"
            bind:value={newFileName}
            on:keydown={(e) => e.key === 'Enter' && handleCreateFile()}
          />
          <select class="select" bind:value={newFileType}>
            <option value="file">📄 Archivo</option>
            <option value="directory">📁 Carpeta</option>
          </select>
          <button class="btn primary small" on:click={handleCreateFile}>Crear</button>
          <button class="btn secondary small" on:click={handleCancelCreate}>Cancelar</button>
        </div>
      {/if}

      <!-- Loading/Error -->
      {#if state.loading}
        <div class="loading">Cargando...</div>
      {:else if state.error}
        <div class="error">{state.error}</div>
      {:else}
        <!-- File list or search results -->
        <div class="file-list">
          {#if state.searchActive}
            <div class="search-info">
              {state.searchResults.length} resultado{state.searchResults.length !== 1 ? 's' : ''} para "{state.searchQuery}"
            </div>
            {#each state.searchResults as result (result.path)}
              <button
                class="file-item"
                class:directory={result.type === 'directory'}
                on:click={() => {
                  if (result.type === 'file') {
                    openFile(result.path);
                  } else {
                    listFiles(result.path);
                  }
                }}
              >
                <span class="file-icon">{getFileIcon({ ...result, extension: result.path.split('.').pop() || null })}</span>
                <span class="file-name">{result.name}</span>
                <span class="file-path">{result.path}</span>
                <span class="match-type">{result.match_type === 'content' ? '📝' : '📂'}</span>
              </button>
            {/each}
          {:else}
            {#each state.files as item (item.path)}
              <div
                class="file-item"
                class:directory={item.type === 'directory'}
                class:project={item.projectId}
                on:click={() => handleItemClick(item)}
                on:keydown={(e) => e.key === 'Enter' && handleItemClick(item)}
                role="button"
                tabindex="0"
              >
                <span class="file-icon">{getFileIcon(item)}</span>
                <span class="file-name">
                  {item.displayName || item.name}
                  {#if item.displayName}
                    <span class="project-id">{item.name}</span>
                  {/if}
                </span>
                {#if item.type === 'file'}
                  <span class="file-size">{formatFileSize(item.size)}</span>
                {/if}
                <button
                  class="delete-btn"
                  class:confirm={confirmDelete === item.path}
                  on:click|stopPropagation={() => handleDelete(item.path)}
                  title={confirmDelete === item.path ? 'Click para confirmar' : 'Eliminar'}
                >
                  {confirmDelete === item.path ? '⚠️' : '🗑️'}
                </button>
              </div>
            {:else}
              <div class="empty">Carpeta vacía</div>
            {/each}
          {/if}
        </div>
      {/if}
    </div>

  {:else if state.currentView === 'editor'}
    <!-- EDITOR VIEW -->
    <div class="editor-view">
      <div class="editor-header">
        <button class="icon-btn" on:click={handleClose} title="Cerrar">⬅️</button>
        <span class="file-title">{state.currentFilePath}</span>
        <div class="editor-actions">
          <button class="btn secondary small" on:click={handleFormat} title="Formatear">📐</button>
          <button
            class="btn primary small"
            on:click={handleSave}
            disabled={!state.editorDirty || state.saving}
          >
            {state.saving ? '⏳' : '💾'} {state.editorDirty ? 'Guardar*' : 'Guardado'}
          </button>
        </div>
      </div>

      {#if state.editorValidation && !state.editorValidation.valid}
        <div class="validation-errors">
          {#each state.editorValidation.errors as error}
            <div class="validation-error">
              ❌ {error.line ? `Línea ${error.line}: ` : ''}{error.message}
            </div>
          {/each}
        </div>
      {/if}

      <textarea
        class="editor-content"
        value={state.editorContent}
        on:input={handleContentChange}
        spellcheck="false"
      ></textarea>

      <div class="editor-footer">
        <span>{formatFileSize(state.currentFile?.size || 0)}</span>
        <span>{state.currentFile?.extension || 'txt'}</span>
      </div>
    </div>

  {:else if state.currentView === 'pdf'}
    <!-- PDF VIEW -->
    <div class="pdf-view">
      <div class="viewer-header">
        <button class="icon-btn" on:click={handleClose} title="Cerrar">⬅️</button>
        <span class="file-title">{state.currentFilePath}</span>
        <span class="file-size">{formatFileSize(state.currentFile?.size || 0)}</span>
      </div>

      {#if state.currentFile && state.currentFile.content}
        <iframe
          class="pdf-frame"
          src={`data:application/pdf;base64,${state.currentFile.content}`}
          title="PDF Viewer"
        ></iframe>
      {:else}
        <div class="loading">Cargando PDF...</div>
      {/if}
    </div>

  {:else if state.currentView === 'image'}
    <!-- IMAGE VIEW -->
    <div class="image-view">
      <div class="viewer-header">
        <button class="icon-btn" on:click={handleClose} title="Cerrar">⬅️</button>
        <span class="file-title">{state.currentFilePath}</span>
        <span class="file-size">{formatFileSize(state.currentFile?.size || 0)}</span>
      </div>

      {#if state.currentFile && state.currentFile.content}
        <div class="image-container">
          <img
            src={`data:${state.currentFile.content_type};base64,${state.currentFile.content}`}
            alt={state.currentFilePath}
            class="preview-image"
          />
        </div>
      {:else}
        <div class="loading">Cargando imagen...</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .files-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-bg-secondary, #1a1a2e);
    color: var(--color-text, #e5e5e5);
  }

  /* Common styles */
  .header, .viewer-header, .editor-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem;
    border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  }

  .icon-btn {
    padding: 0.25rem 0.5rem;
    background: transparent;
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
    border-radius: 0.25rem;
    color: var(--color-text, #e5e5e5);
    cursor: pointer;
    font-size: 0.875rem;
  }

  .icon-btn:hover:not(:disabled) {
    background: var(--color-hover, rgba(255, 255, 255, 0.1));
  }

  .icon-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .icon-btn.small {
    padding: 0.125rem 0.375rem;
    font-size: 0.75rem;
  }

  .btn {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 0.375rem;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .btn.primary {
    background: var(--color-primary, #3b82f6);
    color: white;
  }

  .btn.primary:hover:not(:disabled) {
    background: var(--color-primary-hover, #2563eb);
  }

  .btn.secondary {
    background: transparent;
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.2));
    color: var(--color-text, #e5e5e5);
  }

  .btn.secondary:hover {
    background: var(--color-hover, rgba(255, 255, 255, 0.1));
  }

  .btn.small {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .file-title {
    flex: 1;
    font-size: 0.875rem;
    font-family: ui-monospace, monospace;
    color: var(--color-text-muted, #a3a3a3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-size {
    font-size: 0.75rem;
    color: var(--color-text-muted, #a3a3a3);
    font-family: ui-monospace, monospace;
  }

  .loading, .error, .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    font-size: 0.875rem;
    color: var(--color-text-muted, #a3a3a3);
  }

  .error {
    color: var(--color-error, #ef4444);
  }

  /* Explorer view */
  .explorer-view {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .breadcrumbs {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    overflow-x: auto;
    font-size: 0.75rem;
  }

  .crumb {
    background: transparent;
    border: none;
    color: var(--color-text-muted, #a3a3a3);
    cursor: pointer;
    padding: 0.25rem;
  }

  .crumb:hover {
    color: var(--color-text, #e5e5e5);
  }

  .crumb.current {
    color: var(--color-primary, #3b82f6);
    font-weight: 500;
  }

  .separator {
    color: var(--color-text-muted, #a3a3a3);
  }

  .search-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  }

  .search-input {
    flex: 1;
    padding: 0.375rem 0.5rem;
    background: var(--color-bg, #0f0f1a);
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
    border-radius: 0.25rem;
    color: var(--color-text, #e5e5e5);
    font-size: 0.75rem;
  }

  .search-info {
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem;
    color: var(--color-text-muted, #a3a3a3);
    background: var(--color-bg, #0f0f1a);
  }

  .new-file-form {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: var(--color-bg, #0f0f1a);
    border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  }

  .new-file-form .input {
    flex: 1;
    padding: 0.375rem 0.5rem;
    background: var(--color-bg-secondary, #1a1a2e);
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
    border-radius: 0.25rem;
    color: var(--color-text, #e5e5e5);
    font-size: 0.75rem;
  }

  .new-file-form .select {
    padding: 0.375rem 0.5rem;
    background: var(--color-bg-secondary, #1a1a2e);
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
    border-radius: 0.25rem;
    color: var(--color-text, #e5e5e5);
    font-size: 0.75rem;
  }

  .file-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.5rem;
  }

  .file-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 0.375rem;
    color: var(--color-text, #e5e5e5);
    cursor: pointer;
    transition: background-color 0.15s;
    text-align: left;
    font-size: 0.875rem;
  }

  .file-item:hover {
    background: var(--color-hover, rgba(255, 255, 255, 0.05));
  }

  .file-item.directory {
    color: var(--color-primary, #3b82f6);
  }

  .file-item.project {
    background: var(--color-bg, rgba(59, 130, 246, 0.05));
    border-left: 2px solid var(--color-primary, #3b82f6);
  }

  .project-id {
    display: block;
    font-size: 0.625rem;
    color: var(--color-text-muted, #a3a3a3);
    font-family: ui-monospace, monospace;
    opacity: 0.7;
  }

  .file-icon {
    font-size: 1rem;
    width: 1.25rem;
    text-align: center;
  }

  .file-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-path {
    font-size: 0.625rem;
    color: var(--color-text-muted, #a3a3a3);
    font-family: ui-monospace, monospace;
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .match-type {
    font-size: 0.75rem;
  }

  .delete-btn {
    padding: 0.25rem;
    background: transparent;
    border: none;
    cursor: pointer;
    opacity: 0.5;
    transition: opacity 0.15s;
  }

  .delete-btn:hover {
    opacity: 1;
  }

  .delete-btn.confirm {
    opacity: 1;
    animation: pulse 0.5s infinite alternate;
  }

  @keyframes pulse {
    from { transform: scale(1); }
    to { transform: scale(1.2); }
  }

  /* Editor view */
  .editor-view {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .editor-actions {
    display: flex;
    gap: 0.5rem;
  }

  .validation-errors {
    padding: 0.5rem 0.75rem;
    background: var(--color-error-bg, rgba(239, 68, 68, 0.1));
    border-bottom: 1px solid var(--color-error, #ef4444);
  }

  .validation-error {
    font-size: 0.75rem;
    color: var(--color-error, #ef4444);
  }

  .editor-content {
    flex: 1;
    padding: 1rem;
    background: var(--color-bg, #0f0f1a);
    border: none;
    color: var(--color-text, #e5e5e5);
    font-family: ui-monospace, 'Fira Code', 'Consolas', monospace;
    font-size: 0.875rem;
    line-height: 1.5;
    resize: none;
  }

  .editor-content:focus {
    outline: none;
  }

  .editor-footer {
    display: flex;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem;
    color: var(--color-text-muted, #a3a3a3);
    background: var(--color-bg-secondary, #1a1a2e);
    border-top: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  }

  /* PDF view */
  .pdf-view {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .pdf-frame {
    flex: 1;
    border: none;
    background: white;
  }

  /* Image view */
  .image-view {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .image-container {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    overflow: auto;
    background: var(--color-bg, #0f0f1a);
  }

  .preview-image {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: 0.25rem;
  }
</style>
