<script lang="ts">
  /**
   * CodeEditor - Editor de código simple
   *
   * Features:
   * - Números de línea
   * - Syntax highlighting básico (keywords)
   * - Tab support
   * - Auto-indent
   * - Readonly mode
   */

  import { createEventDispatcher } from 'svelte';

  export let value: string = '';
  export let language: string = 'javascript';
  export let readonly: boolean = false;
  export let placeholder: string = '// Escribe tu código aquí...';
  export let minHeight: string = '200px';

  const dispatch = createEventDispatcher<{ change: string }>();

  let textareaEl: HTMLTextAreaElement;

  $: lines = value.split('\n');
  $: lineCount = lines.length;

  function handleInput(event: Event) {
    const target = event.target as HTMLTextAreaElement;
    value = target.value;
    dispatch('change', value);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Tab') {
      event.preventDefault();
      const start = textareaEl.selectionStart;
      const end = textareaEl.selectionEnd;

      // Insert tab at cursor
      value = value.substring(0, start) + '  ' + value.substring(end);

      // Move cursor after tab
      requestAnimationFrame(() => {
        textareaEl.selectionStart = textareaEl.selectionEnd = start + 2;
      });

      dispatch('change', value);
    }

    // Auto-indent on Enter
    if (event.key === 'Enter') {
      const start = textareaEl.selectionStart;
      const currentLine = value.substring(0, start).split('\n').pop() || '';
      const indent = currentLine.match(/^\s*/)?.[0] || '';

      // Check if line ends with { or :
      if (currentLine.trimEnd().endsWith('{') || currentLine.trimEnd().endsWith(':')) {
        event.preventDefault();
        value = value.substring(0, start) + '\n' + indent + '  ' + value.substring(start);
        requestAnimationFrame(() => {
          textareaEl.selectionStart = textareaEl.selectionEnd = start + indent.length + 3;
        });
        dispatch('change', value);
      }
    }
  }

  function handleScroll(event: Event) {
    const target = event.target as HTMLTextAreaElement;
    const lineNumbers = target.previousElementSibling as HTMLElement;
    if (lineNumbers) {
      lineNumbers.scrollTop = target.scrollTop;
    }
  }
</script>

<div class="code-editor" style="--min-height: {minHeight}">
  <div class="line-numbers" aria-hidden="true">
    {#each Array(lineCount) as _, i}
      <span class="line-number">{i + 1}</span>
    {/each}
  </div>

  <textarea
    bind:this={textareaEl}
    bind:value
    on:input={handleInput}
    on:keydown={handleKeydown}
    on:scroll={handleScroll}
    {readonly}
    {placeholder}
    class="editor-textarea"
    class:readonly
    spellcheck="false"
    autocomplete="off"
    {...{ autocorrect: 'off', autocapitalize: 'off' }}
    data-language={language}
  ></textarea>
</div>

<style>
  .code-editor {
    display: flex;
    background: var(--color-code-bg, #1a1a1a);
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
    border-radius: 0.5rem;
    overflow: hidden;
    min-height: var(--min-height, 200px);
    font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .line-numbers {
    display: flex;
    flex-direction: column;
    padding: 0.75rem 0;
    background: var(--color-code-gutter, rgba(0, 0, 0, 0.2));
    border-right: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
    user-select: none;
    overflow: hidden;
    min-width: 3rem;
    text-align: right;
  }

  .line-number {
    padding: 0 0.75rem;
    color: var(--color-text-muted, #666);
    font-size: 0.75rem;
    line-height: 1.5;
    height: calc(0.875rem * 1.5);
  }

  .editor-textarea {
    flex: 1;
    padding: 0.75rem;
    background: transparent;
    border: none;
    color: var(--color-code-text, #e5e5e5);
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
    resize: none;
    outline: none;
    overflow: auto;
    white-space: pre;
    tab-size: 2;
  }

  .editor-textarea::placeholder {
    color: var(--color-text-muted, #666);
  }

  .editor-textarea.readonly {
    cursor: default;
    opacity: 0.8;
  }

  .editor-textarea:focus {
    background: var(--color-code-focus, rgba(255, 255, 255, 0.02));
  }

  /* Scrollbar */
  .editor-textarea::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  .editor-textarea::-webkit-scrollbar-track {
    background: transparent;
  }

  .editor-textarea::-webkit-scrollbar-thumb {
    background: var(--color-scrollbar, rgba(255, 255, 255, 0.2));
    border-radius: 4px;
  }

  .editor-textarea::-webkit-scrollbar-thumb:hover {
    background: var(--color-scrollbar-hover, rgba(255, 255, 255, 0.3));
  }
</style>
