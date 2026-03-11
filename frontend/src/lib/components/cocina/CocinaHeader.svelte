<script lang="ts">
  /**
   * CocinaHeader — Barra superior fija
   * Info: estacion, reloj HH:MM:SS, pedidos activos, items pendientes, tiempo promedio, MQTT
   * Multi-device: filtros por familia (chips toggleables) + indicador de color del dispositivo
   */
  import { ConnectionStatus } from '$lib/components/base';
  import {
    pedidosCount, itemsPendientes, itemsPreparando, cocinaMetrics,
    pedidosCocina, loadPedidosActivos, loadMetrics,
    myDeviceColor, myDeviceNombre, filtrosActivos, cocinaDevices,
    toggleFiltro, clearFiltros
  } from '$lib/stores/cocina';
  import type { ItemCocina } from '$lib/stores/cocina';

  let refreshing = false;

  async function handleRefresh() {
    if (refreshing) return;
    refreshing = true;
    await Promise.all([loadPedidosActivos(), loadMetrics()]);
    setTimeout(() => { refreshing = false; }, 1000);
  }

  let clock = '';
  let clockInterval: ReturnType<typeof setInterval>;

  function updateClock() {
    const now = new Date();
    clock = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  import { createEventDispatcher, onMount, onDestroy } from 'svelte';

  const dispatch = createEventDispatcher();

  onMount(() => {
    updateClock();
    clockInterval = setInterval(updateClock, 1000);
  });

  onDestroy(() => {
    clearInterval(clockInterval);
  });

  $: avgTime = $cocinaMetrics?.tiempo_promedio_preparacion
    ? `${Math.floor($cocinaMetrics.tiempo_promedio_preparacion / 60)}:${String($cocinaMetrics.tiempo_promedio_preparacion % 60).padStart(2, '0')}`
    : '--:--';

  // Extraer familias/categorías únicas de los items activos
  $: allItems = $pedidosCocina.flatMap(p => p.items) as (ItemCocina & { categoria?: string; familia?: string })[];
  $: availableFamilias = [...new Set(
    allItems
      .map(i => i.categoria || i.familia || '')
      .filter(Boolean)
  )].sort();

  $: hasFilters = $filtrosActivos.length > 0;
</script>

<header class="cocina-header">
  <div class="header-section">
    <h1 class="station-name">COCINA</h1>
  </div>

  <div class="header-metrics">
    <div class="metric">
      <span class="metric-value">{$pedidosCount}</span>
      <span class="metric-label">pedidos</span>
    </div>
    <div class="metric-divider"></div>
    <div class="metric">
      <span class="metric-value pending">{$itemsPendientes}</span>
      <span class="metric-label">pendientes</span>
    </div>
    <div class="metric-divider"></div>
    <div class="metric">
      <span class="metric-value preparing">{$itemsPreparando}</span>
      <span class="metric-label">preparando</span>
    </div>
    <div class="metric-divider"></div>
    <div class="metric">
      <span class="metric-value avg">{avgTime}</span>
      <span class="metric-label">promedio</span>
    </div>
  </div>

  <div class="header-section right">
    <!-- Device color indicator -->
    {#if $myDeviceColor}
      <div class="device-indicator" title="{$myDeviceNombre || 'Este dispositivo'}">
        <span class="device-dot" style="background: {$myDeviceColor}"></span>
        {#if $myDeviceNombre}
          <span class="device-name">{$myDeviceNombre}</span>
        {/if}
      </div>
    {/if}
    <!-- Other connected devices -->
    {#if $cocinaDevices.length > 1}
      <div class="device-peers">
        {#each $cocinaDevices as dev}
          <span class="peer-dot" style="background: {dev.color}" title="{dev.nombre}"></span>
        {/each}
      </div>
    {/if}
    <button class="config-btn" on:click={() => dispatch('configOpen')} title="Configuración de estación">
      &#x2699;
    </button>
    <button class="refresh-btn" class:spinning={refreshing} on:click={handleRefresh} title="Recargar pedidos">
      &#x21bb;
    </button>
    <ConnectionStatus showLabel={false} size="sm" />
    <span class="clock">{clock}</span>
  </div>
</header>

<!-- Filter chips row -->
{#if availableFamilias.length > 0}
  <div class="filter-bar">
    <button
      class="filter-chip"
      class:active={!hasFilters}
      on:click={clearFiltros}
    >TODO</button>
    {#each availableFamilias as familia}
      <button
        class="filter-chip"
        class:active={$filtrosActivos.includes(familia)}
        on:click={() => toggleFiltro(familia)}
      >{familia.toUpperCase()}</button>
    {/each}
  </div>
{/if}

<style>
  .cocina-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 80px;
    padding: 0 20px;
    background: #111827;
    border-bottom: 2px solid #1e293b;
    flex-shrink: 0;
    gap: 16px;
  }

  .header-section {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 140px;
  }

  .header-section.right {
    justify-content: flex-end;
  }

  .station-name {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 800;
    color: #f8fafc;
    letter-spacing: 2px;
  }

  .header-metrics {
    display: flex;
    align-items: center;
    gap: 16px;
    flex: 1;
    justify-content: center;
  }

  .metric {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .metric-value {
    font-size: 1.8rem;
    font-weight: 800;
    color: #f8fafc;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }

  .metric-value.pending { color: #94a3b8; }
  .metric-value.preparing { color: #eab308; }
  .metric-value.avg { color: #60a5fa; font-size: 1.3rem; }

  .metric-label {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #64748b;
    font-weight: 600;
  }

  .metric-divider {
    width: 1px;
    height: 36px;
    background: #1e293b;
  }

  .clock {
    font-size: 1.4rem;
    font-weight: 700;
    color: #94a3b8;
    font-variant-numeric: tabular-nums;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }

  .config-btn {
    background: none;
    border: 1px solid #334155;
    border-radius: 8px;
    color: #94a3b8;
    font-size: 1.4rem;
    width: 40px;
    height: 40px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.2s, border-color 0.2s;
    flex-shrink: 0;
  }

  .config-btn:active {
    color: #f8fafc;
    border-color: #60a5fa;
  }

  .refresh-btn {
    background: none;
    border: 1px solid #334155;
    border-radius: 8px;
    color: #94a3b8;
    font-size: 1.4rem;
    width: 40px;
    height: 40px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.2s, border-color 0.2s, transform 0.3s;
    flex-shrink: 0;
  }

  .refresh-btn:active {
    color: #f8fafc;
    border-color: #60a5fa;
  }

  .refresh-btn.spinning {
    animation: spin 0.8s ease-in-out;
    color: #60a5fa;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  /* ===== Device indicator ===== */
  .device-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .device-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 0 6px currentColor;
  }

  .device-name {
    font-size: 0.75rem;
    color: #94a3b8;
    font-weight: 600;
    max-width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .device-peers {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .peer-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    opacity: 0.7;
  }

  /* ===== Filter bar ===== */
  .filter-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 20px;
    background: #0f172a;
    border-bottom: 1px solid #1e293b;
    overflow-x: auto;
    flex-shrink: 0;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }

  .filter-bar::-webkit-scrollbar {
    display: none;
  }

  .filter-chip {
    padding: 6px 16px;
    border: 1px solid #334155;
    border-radius: 20px;
    background: transparent;
    color: #94a3b8;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.5px;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    -webkit-tap-highlight-color: transparent;
  }

  .filter-chip:active {
    background: rgba(255, 255, 255, 0.05);
  }

  .filter-chip.active {
    background: #3b82f6;
    border-color: #3b82f6;
    color: #fff;
  }

  @media (max-width: 600px) {
    .cocina-header {
      height: 44px;
      padding: 0 8px;
      gap: 6px;
    }
    .header-section { min-width: auto; gap: 6px; }
    .station-name { font-size: 0.8rem; letter-spacing: 1px; }
    .header-metrics { gap: 6px; }
    .metric { gap: 0; }
    .metric-value { font-size: 1rem; }
    .metric-value.avg { font-size: 0.85rem; }
    .metric-label { font-size: 0.5rem; letter-spacing: 0.5px; }
    .metric-divider { height: 24px; }
    .clock { font-size: 0.8rem; }
    .config-btn { width: 32px; height: 32px; font-size: 1.1rem; border-radius: 6px; }
    .refresh-btn { width: 32px; height: 32px; font-size: 1.1rem; border-radius: 6px; }
    .device-indicator { gap: 4px; }
    .device-dot { width: 10px; height: 10px; }
    .device-name { font-size: 0.6rem; max-width: 50px; }
    .peer-dot { width: 6px; height: 6px; }
    .filter-bar { padding: 4px 8px; gap: 6px; }
    .filter-chip { padding: 4px 10px; font-size: 0.65rem; border-radius: 14px; }
  }
</style>
