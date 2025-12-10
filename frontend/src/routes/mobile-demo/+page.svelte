<script lang="ts">
  /**
   * Mobile Demo - Prueba de MobileChatWorkspace con componentes uisis-
   *
   * Esta página demuestra todos los componentes uisis- funcionando juntos:
   * - Barra superior: MenuGeneratorButton, ProjectButton
   * - Barra chat: AIButton, CredentialButton, PromptButton, ConversationButton
   * - Barra chat inferior: FileBrowserButton
   * - Barra lateral: Iconos del sistema
   */
  import { onMount, onDestroy } from 'svelte';
  import { MobileChatWorkspace } from '$components/toolbar';
  import { setHideGlobalHeader, setHideGlobalSidebar, resetLayout } from '$stores/layout';

  // Ocultar layout global para esta demo
  onMount(() => {
    setHideGlobalHeader(true);
    setHideGlobalSidebar(true);
  });

  onDestroy(() => {
    resetLayout();
  });

  // State
  let message = '';
  let sending = false;
  let projectId = 'demo-project';
  let chatMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  // Handlers
  function handleSend(e: CustomEvent<{ message: string }>) {
    const msg = e.detail.message;
    chatMessages = [...chatMessages, { role: 'user', content: msg }];

    // Simular respuesta
    sending = true;
    setTimeout(() => {
      chatMessages = [...chatMessages, {
        role: 'assistant',
        content: `Recibido: "${msg}". Los paneles de cada botón deberían abrirse al hacer tap/doubleTap/longPress.`
      }];
      sending = false;
    }, 1000);
  }

  // Log de eventos para debug
  let eventLog: string[] = [];

  function log(event: string, data?: unknown) {
    const entry = `[${new Date().toLocaleTimeString()}] ${event}${data ? ': ' + JSON.stringify(data).slice(0, 50) : ''}`;
    eventLog = [entry, ...eventLog.slice(0, 9)];
    console.log(entry, data);
  }
</script>

<MobileChatWorkspace
  title="Demo Mobile"
  bind:message
  {sending}
  {projectId}
  notificationCount={3}
  on:send={handleSend}
  on:menuSelect={(e) => log('menuSelect', e.detail)}
  on:menuAdd={() => log('menuAdd')}
  on:menuConfig={(e) => log('menuConfig', e.detail)}
  on:projectSelect={(e) => log('projectSelect', e.detail)}
  on:projectAdd={() => log('projectAdd')}
  on:projectConfig={(e) => log('projectConfig', e.detail)}
  on:aiSelect={(e) => log('aiSelect', e.detail)}
  on:aiConfig={(e) => log('aiConfig', e.detail)}
  on:credentialSelect={(e) => log('credentialSelect', e.detail)}
  on:credentialAdd={() => log('credentialAdd')}
  on:credentialConfig={(e) => log('credentialConfig', e.detail)}
  on:promptSelect={(e) => log('promptSelect', e.detail)}
  on:promptAdd={() => log('promptAdd')}
  on:promptConfig={(e) => log('promptConfig', e.detail)}
  on:conversationSelect={(e) => log('conversationSelect', e.detail)}
  on:conversationAdd={() => log('conversationAdd')}
  on:conversationConfig={(e) => log('conversationConfig', e.detail)}
  on:fileSelect={(e) => log('fileSelect', e.detail)}
  on:fileAdd={(e) => log('fileAdd', e.detail)}
  on:settingsOpen={() => log('settingsOpen')}
  on:modulesOpen={() => log('modulesOpen')}
  on:notificationsOpen={() => log('notificationsOpen')}
  on:profileOpen={() => log('profileOpen')}
>
  <!-- Contenido del chat -->
  <div class="chat-content">
    <div class="chat-header">
      <h2>Demo uisis- Components</h2>
      <p class="subtitle">Prueba la interacción triple en cada botón</p>
    </div>

    <!-- Instrucciones -->
    <div class="instructions">
      <div class="instruction-card">
        <span class="gesture">TAP</span>
        <span class="action">SelectorPanel (elegir)</span>
      </div>
      <div class="instruction-card">
        <span class="gesture">2× TAP</span>
        <span class="action">AddPanel (crear nuevo)</span>
      </div>
      <div class="instruction-card">
        <span class="gesture">HOLD</span>
        <span class="action">ConfigPanel (configurar)</span>
      </div>
    </div>

    <!-- Mensajes -->
    <div class="messages">
      {#each chatMessages as msg}
        <div class="message message--{msg.role}">
          <span class="message-icon">{msg.role === 'user' ? '👤' : '🤖'}</span>
          <span class="message-content">{msg.content}</span>
        </div>
      {:else}
        <div class="empty-chat">
          <p>Envía un mensaje o prueba los botones</p>
        </div>
      {/each}
    </div>

    <!-- Event Log -->
    {#if eventLog.length > 0}
      <div class="event-log">
        <h3>Event Log</h3>
        {#each eventLog as entry}
          <div class="log-entry">{entry}</div>
        {/each}
      </div>
    {/if}
  </div>
</MobileChatWorkspace>

<style>
  .chat-content {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding-bottom: 1rem;
  }

  .chat-header {
    text-align: center;
    padding: 1rem 0;
  }

  .chat-header h2 {
    margin: 0;
    font-size: 1.25rem;
    color: var(--color-text, #fff);
  }

  .subtitle {
    margin: 0.25rem 0 0;
    font-size: 0.75rem;
    color: var(--color-text-muted, #888);
  }

  .instructions {
    display: flex;
    gap: 0.5rem;
    justify-content: center;
    flex-wrap: wrap;
  }

  .instruction-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.5rem 0.75rem;
    background: var(--color-bg-card, #1a1d24);
    border: 1px solid var(--color-border, #2e3440);
    border-radius: 8px;
    font-size: 0.625rem;
  }

  .gesture {
    font-weight: 700;
    color: var(--color-primary, #6366f1);
    font-family: monospace;
  }

  .action {
    color: var(--color-text-muted, #888);
  }

  .messages {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .message {
    display: flex;
    gap: 0.5rem;
    padding: 0.75rem;
    border-radius: 12px;
    font-size: 0.875rem;
  }

  .message--user {
    background: var(--color-primary, #6366f1);
    color: white;
    margin-left: 2rem;
  }

  .message--assistant {
    background: var(--color-bg-card, #1a1d24);
    border: 1px solid var(--color-border, #2e3440);
    margin-right: 2rem;
  }

  .message-icon {
    font-size: 1rem;
  }

  .message-content {
    flex: 1;
  }

  .empty-chat {
    text-align: center;
    padding: 2rem;
    color: var(--color-text-muted, #888);
    font-size: 0.875rem;
  }

  .event-log {
    background: var(--color-bg-card, #1a1d24);
    border: 1px solid var(--color-border, #2e3440);
    border-radius: 8px;
    padding: 0.75rem;
    font-family: monospace;
    font-size: 0.625rem;
  }

  .event-log h3 {
    margin: 0 0 0.5rem;
    font-size: 0.75rem;
    color: var(--color-text-muted, #888);
  }

  .log-entry {
    padding: 0.25rem 0;
    color: var(--color-text, #fff);
    border-bottom: 1px solid var(--color-border, #2e3440);
  }

  .log-entry:last-child {
    border-bottom: none;
  }
</style>
