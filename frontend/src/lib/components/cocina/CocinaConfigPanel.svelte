<script lang="ts">
  /**
   * CocinaConfigPanel — Panel flotante de configuración por terminal
   *
   * Permite a cada dispositivo de cocina:
   * - Ver/cambiar su nombre de estación
   * - Seleccionar familias/categorías a filtrar
   * - Ver su color asignado y los peers conectados
   *
   * Se abre desde el botón engranaje del CocinaHeader.
   * Overlay oscuro con panel lateral derecho.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import {
    cocinaStore,
    myDeviceColor, myDeviceNombre, filtrosActivos, cocinaDevices,
    pedidosCocina,
    setFiltros, updateDeviceName
  } from '$lib/stores/cocina';
  import type { ItemCocina } from '$lib/stores/cocina';

  const dispatch = createEventDispatcher();

  // Local state for editing
  let editNombre = '';
  let selectedFamilias: Set<string> = new Set();
  let saving = false;

  // Extract all known families from active items
  $: allItems = $pedidosCocina.flatMap(p => p.items) as (ItemCocina & { categoria?: string; familia?: string })[];
  $: availableFamilias = [...new Set(
    allItems
      .map(i => (i as any).categoria || (i as any).familia || '')
      .filter(Boolean)
  )].sort();

  // Also include currently active filters (may include families not in current orders)
  $: allFamilias = [...new Set([...availableFamilias, ...$filtrosActivos])].sort();

  // Init local state from store
  onMount(() => {
    editNombre = $myDeviceNombre || '';
    selectedFamilias = new Set($filtrosActivos);
  });

  function toggleFamilia(f: string) {
    if (selectedFamilias.has(f)) {
      selectedFamilias.delete(f);
    } else {
      selectedFamilias.add(f);
    }
    selectedFamilias = selectedFamilias; // trigger reactivity
  }

  function selectAll() {
    selectedFamilias = new Set();
  }

  async function handleSave() {
    saving = true;
    const familias = [...selectedFamilias];

    // Update filters
    setFiltros(familias);

    // Update name if changed
    const currentName = $myDeviceNombre || '';
    if (editNombre.trim() && editNombre.trim() !== currentName) {
      await updateDeviceName(editNombre.trim());
    }

    saving = false;
    dispatch('close');
  }

  function handleClose() {
    dispatch('close');
  }

  function handleOverlayClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('config-overlay')) {
      handleClose();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') handleClose();
  }

  $: isAllSelected = selectedFamilias.size === 0;
  $: peerDevices = $cocinaDevices;
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="config-overlay" on:click={handleOverlayClick} role="dialog" aria-modal="true" aria-label="Configuración de estación">
  <div class="config-panel">
    <!-- Header -->
    <div class="panel-header">
      <h2>Configuración</h2>
      <button class="close-btn" on:click={handleClose} aria-label="Cerrar">&times;</button>
    </div>

    <div class="panel-body">
      <!-- Device info -->
      <section class="config-section">
        <h3>Estación</h3>
        <div class="device-info">
          {#if $myDeviceColor}
            <span class="color-badge" style="background: {$myDeviceColor}"></span>
          {/if}
          <input
            class="name-input"
            type="text"
            bind:value={editNombre}
            placeholder="Nombre de estación..."
            maxlength="20"
          />
        </div>
      </section>

      <!-- Family filters -->
      <section class="config-section">
        <h3>Familias</h3>
        <p class="section-hint">Selecciona las familias que prepara esta estación. Sin selección = ver todo.</p>

        <div class="familia-grid">
          <button
            class="familia-chip"
            class:active={isAllSelected}
            on:click={selectAll}
          >
            TODO
          </button>

          {#each allFamilias as familia}
            <button
              class="familia-chip"
              class:active={selectedFamilias.has(familia)}
              on:click={() => toggleFamilia(familia)}
            >
              {familia.toUpperCase()}
            </button>
          {/each}

          {#if allFamilias.length === 0}
            <p class="no-familias">No hay familias disponibles. Aparecen cuando llegan pedidos.</p>
          {/if}
        </div>
      </section>

      <!-- Connected devices -->
      {#if peerDevices.length > 0}
        <section class="config-section">
          <h3>Dispositivos conectados</h3>
          <div class="devices-list">
            {#each peerDevices as dev}
              <div class="device-row">
                <span class="dev-dot" style="background: {dev.color}"></span>
                <span class="dev-name">{dev.nombre}</span>
                <span class="dev-filtros">
                  {#if dev.filtros?.familias?.length > 0}
                    {dev.filtros.familias.join(', ')}
                  {:else}
                    todo
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        </section>
      {/if}
    </div>

    <!-- Footer -->
    <div class="panel-footer">
      <button class="btn-cancel" on:click={handleClose}>Cancelar</button>
      <button class="btn-save" on:click={handleSave} disabled={saving}>
        {saving ? 'Guardando...' : 'Aplicar'}
      </button>
    </div>
  </div>
</div>

<style>
  .config-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    justify-content: flex-end;
    animation: fadeIn 0.15s ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .config-panel {
    width: 360px;
    max-width: 90vw;
    height: 100vh;
    background: #1e293b;
    display: flex;
    flex-direction: column;
    animation: slideIn 0.2s ease-out;
    box-shadow: -4px 0 20px rgba(0, 0, 0, 0.4);
  }

  @keyframes slideIn {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 24px;
    border-bottom: 1px solid #334155;
    flex-shrink: 0;
  }

  .panel-header h2 {
    margin: 0;
    font-size: 1.3rem;
    font-weight: 700;
    color: #f8fafc;
  }

  .close-btn {
    background: none;
    border: none;
    color: #94a3b8;
    font-size: 1.8rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    transition: color 0.15s, background 0.15s;
  }

  .close-btn:active {
    background: rgba(255, 255, 255, 0.05);
    color: #f8fafc;
  }

  .panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 20px 24px;
  }

  .panel-body::-webkit-scrollbar {
    width: 4px;
  }
  .panel-body::-webkit-scrollbar-thumb {
    background: #475569;
    border-radius: 2px;
  }

  .config-section {
    margin-bottom: 28px;
  }

  .config-section h3 {
    margin: 0 0 12px;
    font-size: 0.85rem;
    font-weight: 700;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .section-hint {
    margin: -8px 0 12px;
    font-size: 0.75rem;
    color: #64748b;
  }

  /* Device info */
  .device-info {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .color-badge {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 0 8px currentColor;
  }

  .name-input {
    flex: 1;
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 10px 14px;
    color: #f8fafc;
    font-size: 1rem;
    font-weight: 600;
    outline: none;
    transition: border-color 0.15s;
  }

  .name-input:focus {
    border-color: #3b82f6;
  }

  .name-input::placeholder {
    color: #475569;
  }

  /* Family chips */
  .familia-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .familia-chip {
    padding: 10px 18px;
    border: 2px solid #334155;
    border-radius: 12px;
    background: transparent;
    color: #94a3b8;
    font-size: 0.85rem;
    font-weight: 700;
    letter-spacing: 0.5px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    -webkit-tap-highlight-color: transparent;
  }

  .familia-chip:active {
    background: rgba(255, 255, 255, 0.05);
  }

  .familia-chip.active {
    background: #3b82f6;
    border-color: #3b82f6;
    color: #fff;
  }

  .no-familias {
    color: #475569;
    font-size: 0.8rem;
    font-style: italic;
  }

  /* Connected devices list */
  .devices-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .device-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: #0f172a;
    border-radius: 8px;
  }

  .dev-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .dev-name {
    font-size: 0.85rem;
    font-weight: 600;
    color: #e2e8f0;
    flex: 1;
  }

  .dev-filtros {
    font-size: 0.7rem;
    color: #64748b;
    text-transform: uppercase;
  }

  /* Footer */
  .panel-footer {
    display: flex;
    gap: 12px;
    padding: 16px 24px;
    border-top: 1px solid #334155;
    flex-shrink: 0;
  }

  .btn-cancel {
    flex: 1;
    padding: 12px;
    border: 1px solid #334155;
    border-radius: 10px;
    background: transparent;
    color: #94a3b8;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn-cancel:active {
    background: rgba(255, 255, 255, 0.05);
  }

  .btn-save {
    flex: 1;
    padding: 12px;
    border: none;
    border-radius: 10px;
    background: #3b82f6;
    color: #fff;
    font-size: 0.9rem;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
  }

  .btn-save:active {
    background: #2563eb;
  }

  .btn-save:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Mobile */
  @media (max-width: 600px) {
    .config-panel {
      width: 100vw;
      max-width: 100vw;
    }

    .panel-header {
      padding: 14px 16px;
    }

    .panel-body {
      padding: 16px;
    }

    .panel-footer {
      padding: 12px 16px;
    }

    .familia-chip {
      padding: 8px 14px;
      font-size: 0.8rem;
    }
  }
</style>
