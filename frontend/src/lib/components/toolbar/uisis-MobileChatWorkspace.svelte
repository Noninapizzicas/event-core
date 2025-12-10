<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  // ═══════════════════════════════════════════════════════════════════════════
  // COMPONENTES UISIS- (auto-gestionan sus paneles)
  // ═══════════════════════════════════════════════════════════════════════════
  import { AIButton } from '$components/ai';
  import { CredentialButton } from '$components/credentials';
  import { PromptButton } from '$components/prompts';
  import { ConversationButton } from '$components/conversations';
  import { ProjectButton } from '$components/projects';
  import { FileBrowserButton } from '$components/files';
  import { MenuGeneratorButton } from '$components/menu';

  // Otros componentes
  import ToolbarIcon from './uisis-ToolbarIcon.svelte';

  /**
   * MobileChatWorkspace - Layout móvil completo con componentes uisis-
   *
   * ESTRUCTURA:
   * ┌──────────────────────────────────────────────────┐
   * │  [≡]  🍔 MenuGen  📂 Project  [título]     [⚙️] │ ← Barra superior
   * ├──────────────────────────────────────────────────┤
   * │                                             [🧩] │
   * │           CONTENIDO PRINCIPAL               [⚙️] │ ← Barra lateral
   * │              (slot)                         [🔔] │
   * │                                             [👤] │
   * ├──────────────────────────────────────────────────┤
   * │  🤖  🔐  📝  💬                                  │ ← Sub-barra chat top
   * │  [      Input mensaje           ] [➤]           │ ← Input
   * │  📁  🔧  📎  📋  🔌                              │ ← Sub-barra chat bottom
   * └──────────────────────────────────────────────────┘
   *
   * Interacción triple en todos los botones uisis-:
   * - TAP → SelectorPanel
   * - DOUBLE TAP → AddPanel (si enableAdd)
   * - LONG PRESS → ConfigPanel
   */

  // ═══════════════════════════════════════════════════════════════════════════
  // PROPS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Título del módulo actual */
  export let title: string = 'Chat';

  /** ID del proyecto activo */
  export let projectId: string | null = null;

  /** Mensaje del chat */
  export let message = '';

  /** Placeholder del input */
  export let placeholder = 'Escribe aquí...';

  /** Enviando mensaje */
  export let sending = false;

  /** Mostrar barra lateral */
  export let showSidebar = true;

  /** Contador de notificaciones */
  export let notificationCount = 0;

  /** Clase CSS adicional */
  let className = '';
  export { className as class };

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════════════════

  let menuExpanded = false;
  let sidebarExpanded = false;

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  const dispatch = createEventDispatcher<{
    send: { message: string };
    // Eventos de módulos
    menuSelect: { menu: unknown };
    menuAdd: void;
    menuConfig: { menu: unknown };
    projectSelect: { project: unknown };
    projectAdd: void;
    projectConfig: { project: unknown };
    aiSelect: { model: unknown };
    aiConfig: { config: unknown };
    credentialSelect: { credential: unknown };
    credentialAdd: void;
    credentialConfig: { credential: unknown };
    promptSelect: { prompt: unknown };
    promptAdd: void;
    promptConfig: { prompt: unknown };
    conversationSelect: { conversation: unknown };
    conversationAdd: void;
    conversationConfig: { conversation: unknown };
    fileSelect: { file: unknown };
    fileAdd: { path: string };
    // Sistema
    settingsOpen: void;
    modulesOpen: void;
    notificationsOpen: void;
    profileOpen: void;
  }>();

  // ═══════════════════════════════════════════════════════════════════════════
  // HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════

  // Input
  function handleSend() {
    if (!message.trim() || sending) return;
    dispatch('send', { message: message.trim() });
    message = '';
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  // Menu
  function toggleMenu() {
    menuExpanded = !menuExpanded;
  }

  // Sidebar
  function toggleSidebar() {
    sidebarExpanded = !sidebarExpanded;
  }
</script>

<div class="mobile-workspace {className}">
  <!-- ═══════════════════════════════════════════════════════════════════════
       BARRA SUPERIOR
       ═══════════════════════════════════════════════════════════════════════ -->
  <header class="top-bar">
    <!-- Hamburger menu -->
    <button class="menu-toggle" on:click={toggleMenu} aria-label="Menú">
      <span class="menu-icon">{menuExpanded ? '✕' : '≡'}</span>
    </button>

    <!-- Menu Generator Button -->
    <MenuGeneratorButton
      size="sm"
      showLabel={false}
      on:select={(e) => dispatch('menuSelect', { menu: e.detail })}
      on:add={() => dispatch('menuAdd')}
      on:config={(e) => dispatch('menuConfig', { menu: e.detail })}
    />

    <!-- Project Button -->
    <ProjectButton
      size="sm"
      showLabel={false}
      on:select={(e) => dispatch('projectSelect', { project: e.detail })}
      on:add={() => dispatch('projectAdd')}
      on:config={(e) => dispatch('projectConfig', { project: e.detail })}
    />

    <!-- Título -->
    <span class="top-bar__title">{title}</span>

    <!-- Spacer -->
    <div class="flex-1"></div>

    <!-- Settings -->
    <ToolbarIcon
      id="settings"
      icon="⚙️"
      label="Config"
      showLabel={false}
      orientation="horizontal"
      on:tap={() => dispatch('settingsOpen')}
    />
  </header>

  <!-- ═══════════════════════════════════════════════════════════════════════
       MENÚ DESPLEGABLE (cuando menuExpanded)
       ═══════════════════════════════════════════════════════════════════════ -->
  {#if menuExpanded}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="menu-dropdown" on:click|self={toggleMenu}>
      <nav class="menu-content" role="menu">
        <a href="/" class="menu-item" role="menuitem">🏠 Inicio</a>
        <a href="/workspace" class="menu-item" role="menuitem">💼 Workspace</a>
        <a href="/pruebas" class="menu-item" role="menuitem">🧪 Pruebas</a>
        <a href="/credenciales" class="menu-item" role="menuitem">🔐 Credenciales</a>
        <a href="/modules" class="menu-item" role="menuitem">🧩 Módulos</a>
        <hr class="menu-divider" />
        <a href="/ui-designer" class="menu-item" role="menuitem">🎨 UI Designer</a>
        <a href="/scratch-designer" class="menu-item" role="menuitem">🧩 Scratch Designer</a>
      </nav>
    </div>
  {/if}

  <!-- ═══════════════════════════════════════════════════════════════════════
       CONTENIDO PRINCIPAL
       ═══════════════════════════════════════════════════════════════════════ -->
  <main class="main-content" class:with-sidebar={showSidebar}>
    <slot>
      <div class="empty-state">
        <span class="empty-icon">💬</span>
        <p>Zona de contenido</p>
      </div>
    </slot>
  </main>

  <!-- ═══════════════════════════════════════════════════════════════════════
       BARRA LATERAL (Ecosystem)
       ═══════════════════════════════════════════════════════════════════════ -->
  {#if showSidebar}
    <aside class="sidebar" class:expanded={sidebarExpanded}>
      <!-- Toggle expand -->
      <button class="sidebar-toggle" on:click={toggleSidebar}>
        {sidebarExpanded ? '›' : '‹'}
      </button>

      <div class="sidebar-icons">
        <!-- Módulos -->
        <ToolbarIcon
          id="modules"
          icon="🧩"
          label={sidebarExpanded ? 'Módulos' : ''}
          showLabel={sidebarExpanded}
          orientation="vertical"
          on:tap={() => dispatch('modulesOpen')}
        />

        <!-- Config sistema -->
        <ToolbarIcon
          id="config"
          icon="⚙️"
          label={sidebarExpanded ? 'Sistema' : ''}
          showLabel={sidebarExpanded}
          orientation="vertical"
          on:tap={() => dispatch('settingsOpen')}
        />

        <!-- Notificaciones -->
        <ToolbarIcon
          id="notifications"
          icon="🔔"
          label={sidebarExpanded ? 'Alertas' : ''}
          showLabel={sidebarExpanded}
          badge={notificationCount > 0 ? (notificationCount > 99 ? '99+' : notificationCount) : undefined}
          orientation="vertical"
          on:tap={() => dispatch('notificationsOpen')}
        />

        <!-- Perfil -->
        <ToolbarIcon
          id="profile"
          icon="👤"
          label={sidebarExpanded ? 'Perfil' : ''}
          showLabel={sidebarExpanded}
          orientation="vertical"
          on:tap={() => dispatch('profileOpen')}
        />
      </div>
    </aside>
  {/if}

  <!-- ═══════════════════════════════════════════════════════════════════════
       BARRA DE CHAT (Sandwich con uisis- buttons)
       ═══════════════════════════════════════════════════════════════════════ -->
  <footer class="chat-bar">
    <!-- Sub-barra superior: PREPARA el mensaje -->
    <div class="chat-sub-bar chat-sub-bar--top">
      <AIButton
        size="sm"
        showLabel={false}
        on:select={(e) => dispatch('aiSelect', { model: e.detail })}
        on:config={(e) => dispatch('aiConfig', { config: e.detail })}
      />
      <CredentialButton
        size="sm"
        showLabel={false}
        on:select={(e) => dispatch('credentialSelect', { credential: e.detail })}
        on:add={() => dispatch('credentialAdd')}
        on:config={(e) => dispatch('credentialConfig', { credential: e.detail })}
      />
      <PromptButton
        size="sm"
        showLabel={false}
        on:select={(e) => dispatch('promptSelect', { prompt: e.detail })}
        on:add={() => dispatch('promptAdd')}
        on:config={(e) => dispatch('promptConfig', { prompt: e.detail })}
      />
      <ConversationButton
        size="sm"
        showLabel={false}
        {projectId}
        on:select={(e) => dispatch('conversationSelect', { conversation: e.detail })}
        on:add={() => dispatch('conversationAdd')}
        on:config={(e) => dispatch('conversationConfig', { conversation: e.detail })}
      />
    </div>

    <!-- Input de mensaje -->
    <div class="chat-input">
      <textarea
        bind:value={message}
        {placeholder}
        disabled={sending}
        rows="1"
        on:keydown={handleKeydown}
      ></textarea>
      <button
        class="send-btn"
        disabled={!message.trim() || sending}
        on:click={handleSend}
        aria-label="Enviar"
      >
        {#if sending}
          <span class="spinner"></span>
        {:else}
          ➤
        {/if}
      </button>
    </div>

    <!-- Sub-barra inferior: COMPLEMENTA el mensaje -->
    <div class="chat-sub-bar chat-sub-bar--bottom">
      <FileBrowserButton
        size="sm"
        showLabel={false}
        {projectId}
        on:select={(e) => dispatch('fileSelect', { file: e.detail.file })}
        on:add={(e) => dispatch('fileAdd', { path: e.detail.path })}
      />
      <ToolbarIcon id="tools" icon="🔧" showLabel={false} orientation="horizontal" />
      <ToolbarIcon id="attach" icon="📎" showLabel={false} orientation="horizontal" />
      <ToolbarIcon id="context" icon="📋" showLabel={false} orientation="horizontal" />
      <ToolbarIcon id="plugins" icon="🔌" showLabel={false} orientation="horizontal" />
    </div>

    <!-- Safe area iOS -->
    <div class="safe-area"></div>
  </footer>
</div>

<style>
  /* ═══════════════════════════════════════════════════════════════════════════
     CONTAINER PRINCIPAL
     ═══════════════════════════════════════════════════════════════════════════ */
  .mobile-workspace {
    display: flex;
    flex-direction: column;
    height: 100vh;
    height: 100dvh;
    background: var(--color-bg, #0d1117);
    color: var(--color-text, #ffffff);
    overflow: hidden;
    position: relative;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     BARRA SUPERIOR
     ═══════════════════════════════════════════════════════════════════════════ */
  .top-bar {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.5rem;
    padding-top: max(0.5rem, env(safe-area-inset-top));
    background: var(--color-bg-card, #1a1d24);
    border-bottom: 1px solid var(--color-border, #2e3440);
    z-index: 100;
  }

  .menu-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    background: transparent;
    border: none;
    color: var(--color-text, #ffffff);
    font-size: 1.25rem;
    cursor: pointer;
    border-radius: 8px;
    transition: background 150ms;
  }

  .menu-toggle:hover {
    background: var(--color-bg-hover, #2a2f3a);
  }

  .top-bar__title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-text, #ffffff);
    margin-left: 0.5rem;
  }

  .flex-1 {
    flex: 1;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     MENÚ DESPLEGABLE
     ═══════════════════════════════════════════════════════════════════════════ */
  .menu-dropdown {
    position: fixed;
    inset: 0;
    top: calc(52px + env(safe-area-inset-top));
    background: rgba(0, 0, 0, 0.5);
    z-index: 200;
    animation: fadeIn 150ms ease;
  }

  .menu-content {
    background: var(--color-bg-card, #1a1d24);
    border-bottom: 1px solid var(--color-border, #2e3440);
    padding: 0.5rem;
    animation: slideDown 150ms ease;
  }

  .menu-item {
    display: block;
    padding: 0.75rem 1rem;
    color: var(--color-text, #ffffff);
    text-decoration: none;
    border-radius: 8px;
    transition: background 150ms;
  }

  .menu-item:hover {
    background: var(--color-bg-hover, #2a2f3a);
  }

  .menu-divider {
    border: none;
    border-top: 1px solid var(--color-border, #2e3440);
    margin: 0.5rem 0;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes slideDown {
    from { transform: translateY(-10px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     CONTENIDO PRINCIPAL
     ═══════════════════════════════════════════════════════════════════════════ */
  .main-content {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
    -webkit-overflow-scrolling: touch;
  }

  .main-content.with-sidebar {
    padding-right: calc(52px + 0.5rem);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--color-text-muted, #6b7280);
    gap: 0.5rem;
  }

  .empty-icon {
    font-size: 3rem;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     BARRA LATERAL
     ═══════════════════════════════════════════════════════════════════════════ */
  .sidebar {
    position: fixed;
    right: 0;
    top: calc(52px + env(safe-area-inset-top));
    bottom: 160px;
    width: 48px;
    background: var(--color-bg-card, #1a1d24);
    border-left: 1px solid var(--color-border, #2e3440);
    display: flex;
    flex-direction: column;
    z-index: 90;
    transition: width 200ms ease;
  }

  .sidebar.expanded {
    width: 140px;
  }

  .sidebar-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 28px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--color-border, #2e3440);
    color: var(--color-text-muted, #6b7280);
    cursor: pointer;
    font-size: 0.875rem;
  }

  .sidebar-icons {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.5rem 0.25rem;
    overflow-y: auto;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     BARRA DE CHAT
     ═══════════════════════════════════════════════════════════════════════════ */
  .chat-bar {
    background: var(--color-bg-card, #1a1d24);
    border-top: 1px solid var(--color-border, #2e3440);
    z-index: 100;
  }

  .chat-sub-bar {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.375rem 0.5rem;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .chat-sub-bar::-webkit-scrollbar {
    display: none;
  }

  .chat-sub-bar--top {
    background: var(--color-bg-elevated, #232830);
    border-bottom: 1px solid var(--color-border, #2e3440);
  }

  .chat-sub-bar--bottom {
    background: var(--color-bg-elevated, #232830);
    border-top: 1px solid var(--color-border, #2e3440);
  }

  .chat-input {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
  }

  .chat-input textarea {
    flex: 1;
    resize: none;
    background: var(--color-bg, #0d1117);
    border: 1px solid var(--color-border, #2e3440);
    border-radius: 12px;
    padding: 0.625rem 1rem;
    font-size: 0.875rem;
    color: var(--color-text, #ffffff);
    min-height: 44px;
    max-height: 100px;
  }

  .chat-input textarea:focus {
    outline: none;
    border-color: var(--color-primary, #6366f1);
  }

  .send-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: none;
    background: var(--color-primary, #6366f1);
    color: white;
    font-size: 1.25rem;
    cursor: pointer;
    transition: all 150ms;
  }

  .send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .send-btn:not(:disabled):active {
    transform: scale(0.95);
  }

  .spinner {
    width: 18px;
    height: 18px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .safe-area {
    height: env(safe-area-inset-bottom, 0);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     RESPONSIVE
     ═══════════════════════════════════════════════════════════════════════════ */
  @media (max-width: 380px) {
    .chat-sub-bar {
      gap: 0.125rem;
      padding: 0.25rem;
    }
  }
</style>
