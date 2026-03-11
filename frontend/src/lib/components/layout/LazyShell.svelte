<script lang="ts">
  /**
   * LazyShell - Shell con bootstrap mínimo
   *
   * Bootstrap mínimo:
   * 1. Core (EventBus via MQTT)
   * 2. Router (navegación)
   * 3. Shell UI (layout básico)
   *
   * Los módulos se cargan bajo demanda cuando se navegan.
   */

  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { connect, disconnect, setupVisibilityHandler, removeVisibilityHandler } from '$lib/ui-core';
  import {
    defineModule,
    preloadModules,
    activePanel,
    getPanelConfig,
    getPanelComponent,
    setCurrentRoute
  } from '$lib/ui-core/lazy-registry';
  import { closePanel } from '$lib/stores/ui';
  import { initWorkspaceSubscriptions, initChatSubscriptions, initProjectsSubscriptions, initConversations, initHtmlPreviewSubscriptions } from '$lib/stores';
  import { moduleDefinitions, criticalModules } from '$lib/modules/definitions';
  import { perfStart, perfEnd, logMsg } from '$lib/utils/perf';

  // Informar ruta actual al registry para filtrar work-bar por ruta
  $: setCurrentRoute($page.url.pathname);

  // Layout components (siempre cargados)
  import ChatArea from './ChatArea.svelte';
  import ChatConfig from './ChatConfig.svelte';
  import ChatInput from './ChatInput.svelte';
  import ChatTools from './ChatTools.svelte';
  import SystemBar from './SystemBar.svelte';
  import Panel from './Panel.svelte';
  import LazyWorkBar from './LazyWorkBar.svelte';
  import { ToastContainer } from '$lib/components/base';

  let cleanupWorkspace: (() => void) | null = null;
  let cleanupChat: (() => void) | null = null;
  let cleanupProjects: (() => void) | null = null;
  let cleanupConversations: (() => void) | null = null;
  let cleanupHtmlPreview: (() => void) | null = null;
  let panelComponent: any = null;

  onMount(async () => {
    perfStart('LazyShell.onMount.TOTAL');
    logMsg('🚀 LazyShell mounting (minimal bootstrap)...');

    // 1. Definir módulos (sin cargarlos)
    perfStart('LazyShell.defineModules');
    for (const def of moduleDefinitions) {
      defineModule(def);
    }
    perfEnd('LazyShell.defineModules');
    logMsg(`📋 ${moduleDefinitions.length} módulos definidos (sin cargar)`);

    // Re-evaluate route now that definitions are loaded
    // (the reactive $: setCurrentRoute runs before onMount, when definitionsStore is empty)
    setCurrentRoute($page.url.pathname);

    // 2. Inicializar subscripciones core
    perfStart('LazyShell.initSubscriptions');
    cleanupWorkspace = initWorkspaceSubscriptions();
    cleanupChat = initChatSubscriptions();
    perfEnd('LazyShell.initSubscriptions');

    // 3. Conectar a MQTT en background
    perfStart('LazyShell.connect.start');
    connect().catch((error) => {
      logMsg('❌ MQTT connection failed', { error: String(error) });
    });
    perfEnd('LazyShell.connect.start');

    // 3b. Inicializar proyectos (carga lista + activa proyecto guardado en backend)
    cleanupProjects = initProjectsSubscriptions();

    // 3c. Inicializar conversaciones (carga lista + restaura conversación activa)
    cleanupConversations = initConversations();

    // 3d-extra. Panel HTML preview (cartas de impresión y otros módulos)
    cleanupHtmlPreview = initHtmlPreviewSubscriptions();

    // 3d. Registrar handler de visibilidad (HyperOS/MIUI fix)
    setupVisibilityHandler();

    perfEnd('LazyShell.onMount.TOTAL');
    logMsg('✅ LazyShell.onMount completed - UI visible');

    // 4. Precargar módulos críticos en background (después del render)
    setTimeout(() => {
      logMsg(`⏳ Preloading ${criticalModules.length} critical modules...`);
      preloadModules(criticalModules);
    }, 100);
  });

  onDestroy(() => {
    console.log('[LazyShell] Destroying...');

    // Limpiar subscripciones
    if (cleanupWorkspace) cleanupWorkspace();
    if (cleanupChat) cleanupChat();
    if (cleanupProjects) cleanupProjects();
    if (cleanupConversations) cleanupConversations();
    if (cleanupHtmlPreview) cleanupHtmlPreview();

    // Desconectar MQTT
    disconnect();

    // Remover handler de visibilidad
    removeVisibilityHandler();

    console.log('[LazyShell] Disconnected');
  });

  // Panel activo - cargar componente bajo demanda
  $: if ($activePanel) {
    loadPanelComponent($activePanel);
  } else {
    panelComponent = null;
  }

  async function loadPanelComponent(panelId: string) {
    panelComponent = await getPanelComponent(panelId);
  }

  $: panelConfig = $activePanel ? getPanelConfig($activePanel) : null;

  function handlePanelClose() {
    closePanel();
  }
</script>

<div class="shell">
  <!-- Work Bar (lazy loading) -->
  <LazyWorkBar />

  <!-- Main content area -->
  <main class="main">
    <!-- Chat Area (scrollable) -->
    <ChatArea />

    <!-- Chat "Sandwich" -->
    <div class="chat-controls">
      <ChatConfig />
      <ChatInput />
      <ChatTools />
    </div>
  </main>

  <!-- System Bar (floating right) -->
  <SystemBar />

  <!-- Toast notifications -->
  <ToastContainer />

  <!-- Active Panel (lazy loaded) -->
  {#if $activePanel && panelConfig}
    <Panel
      title={panelConfig.title}
      size={panelConfig.size}
      position={panelConfig.position || 'top'}
      resizable={panelConfig.resizable !== false}
      draggable={panelConfig.draggable || false}
      open={true}
      on:close={handlePanelClose}
    >
      {#if panelComponent}
        <svelte:component this={panelComponent} panelId={$activePanel} />
      {:else}
        <div class="loading-panel">
          <span class="spinner"></span>
          <span>Cargando módulo...</span>
        </div>
      {/if}
    </Panel>
  {/if}
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    background: var(--color-bg, #121212);
    color: var(--color-text, #e5e5e5);
    overflow: hidden;
  }

  .main {
    flex: 1;
    min-height: 0; /* Necesario para scroll en flexbox */
    display: flex;
    flex-direction: column;
    overflow: hidden;
    margin-right: 3rem;
  }

  .chat-controls {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }

  .loading-panel {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 2rem;
    color: var(--color-text-muted, #888);
  }

  .spinner {
    display: inline-block;
    width: 1.5rem;
    height: 1.5rem;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
