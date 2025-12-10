<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  // Componentes uisis- con interacción triple integrada
  import { AIButton } from '$components/ai';
  import { CredentialButton } from '$components/credentials';
  import { PromptButton } from '$components/prompts';
  import { ConversationButton } from '$components/conversations';
  import { FileBrowserButton } from '$components/files';

  // ToolbarIcon para iconos sin módulo backend (herramientas, adjuntar, etc.)
  import ToolbarIcon from './uisis-ToolbarIcon.svelte';

  /**
   * ChatToolbar - Barra de chat con estructura sandwich
   *
   * ACTUALIZADO: Usa componentes uisis-*Button con interacción triple integrada
   *
   * Estructura sandwich:
   * - Sub-barra superior: PREPARA el mensaje (modelo, creds, prompt, historial)
   * - Input: Campo de texto
   * - Sub-barra inferior: COMPLEMENTA el mensaje (archivos, tools, contexto, plugins)
   *
   * Los uisis-*Button manejan sus propios paneles internamente:
   * - TAP → SelectorPanel (elegir)
   * - DOUBLE TAP → AddPanel (crear nuevo)
   * - LONG PRESS → ConfigPanel (configurar)
   */

  // Props
  export let message = '';
  export let placeholder = 'Escribe aquí...';
  export let sending = false;
  export let projectId: string | null = null;
  let className = '';
  export { className as class };

  const dispatch = createEventDispatcher<{
    send: { message: string };
    expandInput: void;
    // Eventos de los botones uisis
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
    toolsOpen: void;
    attachOpen: void;
    contextOpen: void;
    pluginsOpen: void;
  }>();

  // Estado del input
  let inputElement: HTMLTextAreaElement;
  let tapCount = 0;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;

  // Handler de envío
  function handleSend() {
    if (!message.trim() || sending) return;
    dispatch('send', { message: message.trim() });
    message = '';
  }

  // Handler de teclas en input
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  // Doble tap en input para expandir
  function handleInputTap() {
    tapCount++;
    if (tapCount === 1) {
      tapTimer = setTimeout(() => {
        tapCount = 0;
      }, 300);
    } else if (tapCount === 2) {
      if (tapTimer) clearTimeout(tapTimer);
      tapCount = 0;
      dispatch('expandInput');
    }
  }

  // === Handlers de botones uisis ===

  // AI
  function handleAISelect(e: CustomEvent) {
    dispatch('aiSelect', { model: e.detail });
  }
  function handleAIConfig(e: CustomEvent) {
    dispatch('aiConfig', { config: e.detail });
  }

  // Credentials
  function handleCredentialSelect(e: CustomEvent) {
    dispatch('credentialSelect', { credential: e.detail });
  }
  function handleCredentialAdd() {
    dispatch('credentialAdd');
  }
  function handleCredentialConfig(e: CustomEvent) {
    dispatch('credentialConfig', { credential: e.detail });
  }

  // Prompts
  function handlePromptSelect(e: CustomEvent) {
    dispatch('promptSelect', { prompt: e.detail });
  }
  function handlePromptAdd() {
    dispatch('promptAdd');
  }
  function handlePromptConfig(e: CustomEvent) {
    dispatch('promptConfig', { prompt: e.detail });
  }

  // Conversations
  function handleConversationSelect(e: CustomEvent) {
    dispatch('conversationSelect', { conversation: e.detail });
  }
  function handleConversationAdd() {
    dispatch('conversationAdd');
  }
  function handleConversationConfig(e: CustomEvent) {
    dispatch('conversationConfig', { conversation: e.detail });
  }

  // Files
  function handleFileSelect(e: CustomEvent) {
    dispatch('fileSelect', { file: e.detail.file });
  }
  function handleFileAdd(e: CustomEvent) {
    dispatch('fileAdd', { path: e.detail.path });
  }

  // Tools auxiliares (sin módulo backend propio)
  function handleToolsTap() {
    dispatch('toolsOpen');
  }
  function handleAttachTap() {
    dispatch('attachOpen');
  }
  function handleContextTap() {
    dispatch('contextOpen');
  }
  function handlePluginsTap() {
    dispatch('pluginsOpen');
  }
</script>

<div class="chat-toolbar {className}">
  <!-- ═══════════════════════════════════════════════════════════════════════
       SUB-BARRA SUPERIOR: PREPARA el mensaje
       Componentes uisis- con paneles auto-gestionados
       ═══════════════════════════════════════════════════════════════════════ -->
  <div class="chat-bar chat-bar--top">
    <!-- AI Model (tap: selector, longPress: config) -->
    <AIButton
      size="sm"
      showLabel={false}
      on:select={handleAISelect}
      on:config={handleAIConfig}
    />

    <!-- Credentials (tap: selector, doubleTap: add, longPress: config) -->
    <CredentialButton
      size="sm"
      showLabel={false}
      on:select={handleCredentialSelect}
      on:add={handleCredentialAdd}
      on:config={handleCredentialConfig}
    />

    <!-- Prompts (tap: selector, doubleTap: add, longPress: config) -->
    <PromptButton
      size="sm"
      showLabel={false}
      on:select={handlePromptSelect}
      on:add={handlePromptAdd}
      on:config={handlePromptConfig}
    />

    <!-- Conversations (tap: selector, doubleTap: add, longPress: config) -->
    <ConversationButton
      size="sm"
      showLabel={false}
      {projectId}
      on:select={handleConversationSelect}
      on:add={handleConversationAdd}
      on:config={handleConversationConfig}
    />
  </div>

  <!-- ═══════════════════════════════════════════════════════════════════════
       INPUT DE MENSAJE (el relleno del sandwich)
       ═══════════════════════════════════════════════════════════════════════ -->
  <div class="chat-input">
    <textarea
      bind:this={inputElement}
      bind:value={message}
      {placeholder}
      disabled={sending}
      rows="1"
      on:keydown={handleKeydown}
      on:click={handleInputTap}
    ></textarea>

    <button
      type="button"
      class="send-btn"
      disabled={!message.trim() || sending}
      on:click={handleSend}
      aria-label="Enviar mensaje"
    >
      {#if sending}
        <span class="spinner"></span>
      {:else}
        <span class="send-icon">➤</span>
      {/if}
    </button>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════════════
       SUB-BARRA INFERIOR: COMPLEMENTA el mensaje
       FileBrowser es uisis-, el resto son ToolbarIcon por ahora
       ═══════════════════════════════════════════════════════════════════════ -->
  <div class="chat-bar chat-bar--bottom">
    <!-- Files (tap: navegar, doubleTap: crear, longPress: config) -->
    <FileBrowserButton
      size="sm"
      showLabel={false}
      {projectId}
      on:select={handleFileSelect}
      on:add={handleFileAdd}
    />

    <!-- Tools (sin módulo backend propio) -->
    <ToolbarIcon
      id="tools"
      icon="🔧"
      label="Tools"
      showLabel={false}
      orientation="horizontal"
      on:tap={handleToolsTap}
    />

    <!-- Attach -->
    <ToolbarIcon
      id="attach"
      icon="📎"
      label="Adjuntar"
      showLabel={false}
      orientation="horizontal"
      on:tap={handleAttachTap}
    />

    <!-- Context -->
    <ToolbarIcon
      id="context"
      icon="📋"
      label="Contexto"
      showLabel={false}
      orientation="horizontal"
      on:tap={handleContextTap}
    />

    <!-- Plugins -->
    <ToolbarIcon
      id="plugins"
      icon="🔌"
      label="Plugins"
      showLabel={false}
      orientation="horizontal"
      on:tap={handlePluginsTap}
    />
  </div>

  <!-- Safe area para móviles -->
  <div class="safe-area"></div>
</div>

<style>
  .chat-toolbar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 100;
    background: var(--color-bg-card, #1a1d24);
    border-top: 1px solid var(--color-border, #2e3440);
    box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.15);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     SUB-BARRAS (top y bottom)
     ═══════════════════════════════════════════════════════════════════════ */
  .chat-bar {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.375rem 0.5rem;
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  .chat-bar::-webkit-scrollbar {
    display: none;
  }

  .chat-bar--top {
    border-bottom: 1px solid var(--color-border, #2e3440);
    background: var(--color-bg-elevated, #232830);
  }

  .chat-bar--bottom {
    border-top: 1px solid var(--color-border, #2e3440);
    background: var(--color-bg-elevated, #232830);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     INPUT AREA
     ═══════════════════════════════════════════════════════════════════════ */
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
    line-height: 1.4;
    min-height: 44px;
    max-height: 120px;
  }

  .chat-input textarea::placeholder {
    color: var(--color-text-muted, #6b7280);
  }

  .chat-input textarea:focus {
    outline: none;
    border-color: var(--color-primary, #6366f1);
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
  }

  .chat-input textarea:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     SEND BUTTON
     ═══════════════════════════════════════════════════════════════════════ */
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
    cursor: pointer;
    transition: all 150ms ease;
    flex-shrink: 0;
  }

  .send-btn:hover:not(:disabled) {
    background: var(--color-primary-hover, #4f46e5);
    transform: scale(1.05);
  }

  .send-btn:active:not(:disabled) {
    transform: scale(0.95);
  }

  .send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .send-icon {
    font-size: 1.25rem;
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     SAFE AREA (iOS)
     ═══════════════════════════════════════════════════════════════════════ */
  .safe-area {
    height: env(safe-area-inset-bottom, 0);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     RESPONSIVE
     ═══════════════════════════════════════════════════════════════════════ */
  @media (max-width: 380px) {
    .chat-bar {
      gap: 0.125rem;
      padding: 0.25rem;
    }
  }
</style>
