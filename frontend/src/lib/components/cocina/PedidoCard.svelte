<script lang="ts">
  /**
   * PedidoCard — Tarjeta de pedido en pantalla cocina
   *
   * Muestra: referencia (MESA 5, LLEVAR #3), timer en vivo, items con estado
   * Tap en header = marcar todo listo (atajo rápido)
   * Tap en item = toggle estado
   *
   * Colores borde:
   *   - Todos pendientes: slate-700
   *   - Alguno preparando: yellow-500
   *   - Todos listos: green-500 → fade out 3s
   *   - Timer >10min: red-500 pulse
   */
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import type { PedidoCocina } from '$lib/stores/cocina';
  import {
    extractRef, elapsed, prepararItem, marcarListo,
    confirmarGlovo, rechazarGlovo, isGlovoConfirmado,
    itemPassesFilter
  } from '$lib/stores/cocina';

  import ItemLine from './ItemLine.svelte';

  export let pedido: PedidoCocina;
  export let filtros: string[] = [];

  const dispatch = createEventDispatcher();

  let elapsedTime = '00:00';
  let timerInterval: ReturnType<typeof setInterval>;
  let confirmando = false;
  let rechazando = false;

  onMount(() => {
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
  });

  onDestroy(() => {
    clearInterval(timerInterval);
  });

  function updateTimer() {
    elapsedTime = elapsed(pedido.recibido_at);
  }

  $: ref = extractRef(pedido.cuenta_id);
  $: isListo = pedido.estado === 'listo';
  $: hasPreparando = pedido.items.some(i => i.estado === 'preparando');
  $: allPendiente = pedido.items.every(i => i.estado === 'pendiente');
  $: itemsListos = pedido.items.filter(i => i.estado === 'listo').length;
  $: itemsTotal = pedido.items.length;
  $: progress = itemsTotal > 0 ? itemsListos / itemsTotal : 0;

  // Glovo detection
  $: isGlovo = pedido.canal === 'glovo';
  $: pendienteConfirmacion = isGlovo
    && pedido.metadata?.requiere_confirmacion
    && !isGlovoConfirmado(pedido.cuenta_id);

  // Timer warning: >10 minutos
  $: elapsedSeconds = (Date.now() - new Date(pedido.recibido_at).getTime()) / 1000;
  $: isUrgent = elapsedSeconds > 600 && !isListo;

  // Split items by filter
  $: hasFilters = filtros.length > 0;
  $: myItems = hasFilters
    ? pedido.items.filter(i => itemPassesFilter(i, filtros))
    : pedido.items;
  $: otherItems = hasFilters
    ? pedido.items.filter(i => !itemPassesFilter(i, filtros))
    : [];

  $: borderColor = isListo
    ? '#22c55e'
    : isGlovo && pendienteConfirmacion
      ? '#FF6B00'
      : isGlovo
        ? '#FF6B00'
        : hasPreparando
          ? '#eab308'
          : isUrgent
            ? '#ef4444'
            : '#334155';

  function handleMarkReady() {
    if (pendienteConfirmacion) return;
    marcarListo(pedido.pedido_id);
  }

  function handleItemTap(e: CustomEvent<{ item_id: string }>) {
    if (pendienteConfirmacion) return;
    prepararItem(e.detail.item_id);
  }

  async function handleConfirmarGlovo() {
    if (confirmando) return;
    confirmando = true;
    await confirmarGlovo(pedido.cuenta_id);
    confirmando = false;
  }

  async function handleRechazarGlovo() {
    if (rechazando) return;
    rechazando = true;
    await rechazarGlovo(pedido.cuenta_id, 'Rechazado desde cocina');
    rechazando = false;
  }
</script>

<article
  class="pedido-card"
  class:listo={isListo}
  class:urgent={isUrgent}
  class:glovo={isGlovo}
  class:glovo-pendiente={pendienteConfirmacion}
  class:new-order={allPendiente && elapsedSeconds < 5 && !isGlovo}
  class:glovo-new={isGlovo && allPendiente && elapsedSeconds < 5}
  style="--border-color: {borderColor}"
>
  <!-- Header: ref + timer + progress -->
  <button class="card-header" class:glovo-header={isGlovo} on:click={handleMarkReady} title="Marcar todo listo">
    <div class="header-left">
      {#if isGlovo}
        <span class="glovo-badge">GLOVO</span>
      {/if}
      <span class="ref">{ref}</span>
      {#if pedido.canal && !isGlovo}
        <span class="canal">{pedido.canal}</span>
      {/if}
    </div>
    <div class="header-right">
      <span class="progress-text">{itemsListos}/{itemsTotal}</span>
      <span class="timer" class:timer-urgent={isUrgent}>{elapsedTime}</span>
    </div>
  </button>

  <!-- Progress bar -->
  <div class="progress-bar" class:glovo-bar={isGlovo}>
    <div class="progress-fill" class:glovo-fill={isGlovo} style="width: {progress * 100}%"></div>
  </div>

  {#if pendienteConfirmacion}
    <!-- Glovo sin confirmar: resumen + botones -->
    <div class="glovo-info">
      {#if pedido.metadata?.cliente_nombre}
        <div class="glovo-detail">
          <span class="glovo-label">CLIENTE</span>
          <span class="glovo-value">{pedido.metadata.cliente_nombre}</span>
        </div>
      {/if}
      {#if pedido.metadata?.total}
        <div class="glovo-detail">
          <span class="glovo-label">TOTAL</span>
          <span class="glovo-value">{pedido.metadata.total.toFixed(2)}€</span>
        </div>
      {/if}
      {#if pedido.metadata?.tiempo_estimado_entrega}
        <div class="glovo-detail">
          <span class="glovo-label">ENTREGA</span>
          <span class="glovo-value">{pedido.metadata.tiempo_estimado_entrega} min</span>
        </div>
      {/if}
    </div>

    <!-- Items (no interactivos, resumen con ingredientes) -->
    <div class="card-items glovo-items-preview">
      {#each pedido.items as item (item.item_id)}
        <div class="glovo-item-line">
          <span class="glovo-item-qty">{item.cantidad}x</span>
          <span class="glovo-item-name">{item.nombre}</span>
        </div>
        {#if item.ingredientes_base?.length}
          <div class="glovo-item-ings">{item.ingredientes_base.join(', ')}</div>
        {/if}
        {#if item.notas}
          <div class="glovo-item-nota">{item.notas}</div>
        {/if}
      {/each}
    </div>

    <!-- Botones confirmar/rechazar -->
    <div class="glovo-actions">
      <button class="glovo-btn glovo-btn-confirm" on:click={handleConfirmarGlovo} disabled={confirmando}>
        {confirmando ? 'CONFIRMANDO...' : 'CONFIRMAR'}
      </button>
      <button class="glovo-btn glovo-btn-reject" on:click={handleRechazarGlovo} disabled={rechazando}>
        {rechazando ? '...' : 'RECHAZAR'}
      </button>
    </div>
  {:else}
    <!-- Flujo normal: items interactivos -->
    {#if hasFilters && otherItems.length > 0}
      <!-- Two-column layout: my items | other items -->
      <div class="card-items-split">
        <div class="split-mine">
          {#each myItems as item (item.item_id)}
            <ItemLine {item} on:tap={handleItemTap} />
          {/each}
          {#if myItems.length === 0}
            <p class="split-empty">Sin items de tu estación</p>
          {/if}
        </div>
        <div class="split-others">
          <span class="split-others-label">OTROS</span>
          {#each otherItems as item (item.item_id)}
            <div class="other-item-line">
              <span class="other-qty">{item.cantidad}x</span>
              <span class="other-name">{item.nombre}</span>
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <!-- No filters: single column -->
      <div class="card-items">
        {#each pedido.items as item (item.item_id)}
          <ItemLine {item} on:tap={handleItemTap} />
        {/each}
      </div>
    {/if}
  {/if}

  <!-- Notas generales del pedido -->
  {#if pedido.notas_generales}
    <div class="card-notas">
      <span class="notas-label">NOTA PEDIDO:</span>
      <span class="notas-text">{pedido.notas_generales}</span>
    </div>
  {/if}
</article>

<style>
  .pedido-card {
    display: flex;
    flex-direction: column;
    background: #1e293b;
    border: 2px solid var(--border-color);
    border-radius: 12px;
    overflow: hidden;
    transition: opacity 0.5s, transform 0.5s, border-color 0.3s;
  }

  .pedido-card.listo {
    opacity: 0.3;
    transform: scale(0.96);
  }

  .pedido-card.urgent {
    animation: urgent-pulse 2s ease-in-out infinite;
  }

  .pedido-card.new-order {
    animation: flash-in 0.5s ease-out;
  }

  /* Header */
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: #0f172a;
    border: none;
    border-bottom: 1px solid #334155;
    color: #f8fafc;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    min-height: 56px;
  }

  .card-header:active {
    background: #166534;
  }

  .header-left {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .ref {
    font-size: 2rem;
    font-weight: 800;
    line-height: 1;
    letter-spacing: 1px;
  }

  .canal {
    font-size: 0.7rem;
    text-transform: uppercase;
    color: #64748b;
    letter-spacing: 1px;
    font-weight: 600;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .progress-text {
    font-size: 1rem;
    color: #64748b;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .timer {
    font-size: 1.2rem;
    font-weight: 700;
    color: #94a3b8;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-variant-numeric: tabular-nums;
  }

  .timer-urgent {
    color: #ef4444;
    animation: blink 1s ease-in-out infinite;
  }

  /* Progress bar */
  .progress-bar {
    height: 3px;
    background: #0f172a;
  }

  .progress-fill {
    height: 100%;
    background: #22c55e;
    transition: width 0.3s ease;
  }

  /* Items */
  .card-items {
    display: flex;
    flex-direction: column;
  }

  /* ===== TWO-COLUMN SPLIT LAYOUT ===== */
  .card-items-split {
    display: flex;
    min-height: 0;
  }

  .split-mine {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .split-others {
    width: 35%;
    max-width: 180px;
    min-width: 100px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 10px;
    background: rgba(0, 0, 0, 0.2);
    border-left: 1px solid #1e293b;
  }

  .split-others-label {
    font-size: 0.55rem;
    font-weight: 800;
    color: #475569;
    letter-spacing: 1.5px;
    margin-bottom: 2px;
  }

  .other-item-line {
    display: flex;
    gap: 4px;
    align-items: baseline;
    padding: 1px 0;
  }

  .other-qty {
    font-size: 0.65rem;
    font-weight: 700;
    color: #475569;
    flex-shrink: 0;
  }

  .other-name {
    font-size: 0.65rem;
    color: #475569;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .split-empty {
    padding: 10px 14px;
    margin: 0;
    color: #334155;
    font-size: 0.8rem;
    font-style: italic;
  }

  /* Notas generales del pedido */
  .card-notas {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 10px 16px;
    border-top: 2px solid #f59e0b;
    background: rgba(245, 158, 11, 0.1);
  }

  .notas-label {
    font-size: 0.7rem;
    font-weight: 800;
    color: #f59e0b;
    letter-spacing: 1px;
    flex-shrink: 0;
  }

  .notas-text {
    font-size: 1.15rem;
    color: #fbbf24;
    font-weight: 700;
    word-break: break-word;
  }

  /* ===== GLOVO STYLES ===== */

  .glovo-badge {
    display: inline-block;
    background: #FF6B00;
    color: #fff;
    font-size: 0.65rem;
    font-weight: 900;
    padding: 2px 8px;
    border-radius: 4px;
    letter-spacing: 1.5px;
    line-height: 1.4;
  }

  .glovo-header {
    border-bottom-color: #FF6B00;
  }

  .pedido-card.glovo-pendiente {
    animation: glovo-pulse 1.5s ease-in-out infinite;
  }

  .glovo-bar .glovo-fill {
    background: #FF6B00;
  }

  /* Glovo info section */
  .glovo-info {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    padding: 10px 16px;
    background: rgba(255, 107, 0, 0.08);
    border-bottom: 1px solid rgba(255, 107, 0, 0.2);
  }

  .glovo-detail {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .glovo-label {
    font-size: 0.6rem;
    font-weight: 700;
    color: #FF6B00;
    letter-spacing: 1px;
  }

  .glovo-value {
    font-size: 1rem;
    font-weight: 700;
    color: #f8fafc;
  }

  /* Glovo items preview (non-interactive) */
  .glovo-items-preview {
    padding: 8px 16px;
    gap: 4px;
  }

  .glovo-item-line {
    display: flex;
    gap: 8px;
    padding: 4px 0;
    color: #94a3b8;
    font-size: 0.95rem;
  }

  .glovo-item-qty {
    font-weight: 700;
    color: #f8fafc;
    min-width: 2.5em;
  }

  .glovo-item-name {
    font-weight: 500;
  }

  .glovo-item-ings {
    padding-left: 2.5em;
    font-size: 0.8rem;
    color: #64748b;
    font-style: italic;
    margin-top: -2px;
  }

  .glovo-item-nota {
    padding-left: 2.5em;
    font-size: 0.8rem;
    font-weight: 600;
    color: #fbbf24;
    margin-top: 1px;
  }

  /* Glovo action buttons */
  .glovo-actions {
    display: flex;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid rgba(255, 107, 0, 0.2);
  }

  .glovo-btn {
    flex: 1;
    padding: 14px 16px;
    border: none;
    border-radius: 8px;
    font-size: 1.1rem;
    font-weight: 800;
    letter-spacing: 1px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: opacity 0.15s;
  }

  .glovo-btn:disabled {
    opacity: 0.5;
  }

  .glovo-btn-confirm {
    background: #16a34a;
    color: #fff;
    flex: 3;
  }

  .glovo-btn-confirm:active:not(:disabled) {
    background: #15803d;
  }

  .glovo-btn-reject {
    background: #dc2626;
    color: #fff;
    flex: 1;
    font-size: 0.9rem;
  }

  .glovo-btn-reject:active:not(:disabled) {
    background: #b91c1c;
  }

  /* Animations */
  @keyframes urgent-pulse {
    0%, 100% { box-shadow: 0 0 8px rgba(239, 68, 68, 0.2); }
    50% { box-shadow: 0 0 24px rgba(239, 68, 68, 0.5); }
  }

  @keyframes glovo-pulse {
    0%, 100% { box-shadow: 0 0 8px rgba(255, 107, 0, 0.2); }
    50% { box-shadow: 0 0 28px rgba(255, 107, 0, 0.6); }
  }

  @keyframes flash-in {
    0% { background: #1e40af; transform: scale(1.02); }
    100% { background: #1e293b; transform: scale(1); }
  }

  @keyframes glovo-flash-in {
    0% { background: #FF6B00; transform: scale(1.03); }
    100% { background: #1e293b; transform: scale(1); }
  }

  .pedido-card.glovo-new {
    animation: glovo-flash-in 0.6s ease-out;
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  /* ===== MOBILE COMPACT ===== */
  @media (max-width: 600px) {
    .split-others { width: 30%; max-width: 120px; min-width: 80px; padding: 4px 6px; }
    .split-others-label { font-size: 0.5rem; }
    .other-qty { font-size: 0.55rem; }
    .other-name { font-size: 0.55rem; }
    .split-empty { padding: 6px 10px; font-size: 0.7rem; }
  }

  @media (max-width: 600px) {
    .pedido-card { border-radius: 8px; border-width: 1.5px; }
    .card-header { padding: 6px 10px; min-height: 36px; }
    .ref { font-size: 1.1rem; letter-spacing: 0.5px; }
    .canal { font-size: 0.6rem; }
    .progress-text { font-size: 0.75rem; }
    .timer { font-size: 0.85rem; }
    .header-right { gap: 8px; }
    .progress-bar { height: 2px; }
    .card-notas { padding: 6px 10px; gap: 6px; }
    .notas-label { font-size: 0.6rem; }
    .notas-text { font-size: 0.85rem; }
    .glovo-badge { font-size: 0.55rem; padding: 1px 5px; }
    .glovo-info { padding: 6px 10px; gap: 8px; }
    .glovo-label { font-size: 0.5rem; }
    .glovo-value { font-size: 0.85rem; }
    .glovo-items-preview { padding: 6px 10px; }
    .glovo-item-line { font-size: 0.8rem; }
    .glovo-item-qty { min-width: 2em; }
    .glovo-item-ings { font-size: 0.7rem; }
    .glovo-item-nota { font-size: 0.7rem; }
    .glovo-actions { padding: 8px 10px; gap: 6px; }
    .glovo-btn { padding: 10px 12px; font-size: 0.9rem; border-radius: 6px; }
    .glovo-btn-reject { font-size: 0.75rem; }
  }
</style>
