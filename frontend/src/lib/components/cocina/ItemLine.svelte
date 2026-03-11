<script lang="ts">
  /**
   * ItemLine — Línea de item en la tarjeta de pedido cocina
   *
   * Comportamiento expand/collapse por estado:
   *   - PENDIENTE: compacto — qty + nombre + variaciones inline + notas inline
   *   - PREPARANDO: expandido — ficha completa con ingredientes, variaciones,
   *     notas grandes. Foco visual en el producto a elaborar.
   *   - LISTO: compacto otra vez — faded + strikethrough
   *
   * Tap toggle: pendiente → preparando (expande) → listo (comprime)
   * Target mínimo 60px para manos con harina
   */
  import { slide } from 'svelte/transition';
  import { createEventDispatcher } from 'svelte';
  import type { ItemCocina, PizzaHalf, IngredienteAlGusto } from '$lib/stores/cocina';
  import { ESTADO_ITEM_COLORS } from '$lib/stores/cocina';

  export let item: ItemCocina;

  const dispatch = createEventDispatcher<{
    'tap': { item_id: string };
  }>();

  $: color = ESTADO_ITEM_COLORS[item.estado];
  $: isListo = item.estado === 'listo';
  $: isPreparando = item.estado === 'preparando';
  $: expanded = isPreparando;

  // Multi-device: show who is preparing this item
  $: deviceColor = item.device_color || null;
  $: deviceNombre = item.device_nombre || null;

  // — Mitad y Mitad —
  $: isMitad = item.tipo === 'mitad_mitad' && (item.pizza_izquierda || item.pizza_derecha);
  $: pizzaIzq = parsePizzaHalf(item.pizza_izquierda);
  $: pizzaDer = parsePizzaHalf(item.pizza_derecha);

  // — Al Gusto —
  $: isAlGusto = item.tipo === 'al_gusto' && item.ingredientes?.length;
  $: ingredientesAlGusto = (item.ingredientes || []).map(parseIngrediente);

  // — Ingredientes base (todos los productos) —
  $: hasIngredientesBase = !isMitad && !isAlGusto && item.ingredientes_base?.length;

  // — Variaciones (quitar / añadir) —
  $: quitarList = extractQuitar(item);
  $: anadirList = extractAnadir(item);
  $: hasVariaciones = quitarList.length > 0 || anadirList.length > 0;

  // — Compact inline summary (pendiente/listo) —
  $: compactVariaciones = [
    ...quitarList.map(n => `SIN ${n.toUpperCase()}`),
    ...anadirList.map(a => `+${a.nombre.toUpperCase()}`)
  ];
  $: hasCompactSummary = compactVariaciones.length > 0 || !!item.notas;

  // ——————————————————————————————————————————
  // Helpers para extraer datos con formatos flexibles
  // ——————————————————————————————————————————

  function parsePizzaHalf(half: string | PizzaHalf | undefined | null): { nombre: string; ingredientes: string[] } | null {
    if (!half) return null;
    if (typeof half === 'string') return { nombre: half, ingredientes: [] };
    return {
      nombre: half.nombre || '???',
      ingredientes: half.ingredientes_base || []
    };
  }

  function parseIngrediente(ing: string | IngredienteAlGusto): string {
    if (typeof ing === 'string') return ing;
    return ing.nombre || '???';
  }

  function extractQuitar(item: ItemCocina): string[] {
    if (!item.variaciones) return [];
    const v = item.variaciones as any;

    // Formato nuevo (objeto): { ingredientes_quitar: string[] }
    if (Array.isArray(v.ingredientes_quitar)) {
      return v.ingredientes_quitar.map((i: any) => typeof i === 'string' ? i : i.nombre || '???');
    }

    // Formato legacy (array): [{ tipo: 'quitar', ingrediente_id | nombre }]
    if (Array.isArray(v)) {
      return v
        .filter((x: any) => x.tipo === 'quitar')
        .map((x: any) => x.nombre || x.ingrediente_id || '???');
    }

    return [];
  }

  function extractAnadir(item: ItemCocina): { nombre: string; cantidad?: number }[] {
    if (!item.variaciones) return [];
    const v = item.variaciones as any;

    // Formato nuevo (objeto): { ingredientes_anadir: [{ nombre, cantidad? }] }
    if (Array.isArray(v.ingredientes_anadir)) {
      return v.ingredientes_anadir.map((i: any) => {
        if (typeof i === 'string') return { nombre: i };
        return { nombre: i.nombre || '???', cantidad: i.cantidad };
      });
    }

    // Formato legacy (array): [{ tipo: 'anadir', ingrediente_id | nombre, cantidad? }]
    if (Array.isArray(v)) {
      return v
        .filter((x: any) => x.tipo === 'anadir')
        .map((x: any) => ({
          nombre: x.nombre || x.ingrediente_id || '???',
          cantidad: x.cantidad
        }));
    }

    return [];
  }

  function handleTap() {
    if (!isListo) {
      dispatch('tap', { item_id: item.item_id });
    }
  }
</script>

<button
  class="item-line"
  class:listo={isListo}
  class:preparando={isPreparando}
  class:expanded
  style="--item-color: {color}"
  on:click={handleTap}
  disabled={isListo}
>
  <div class="item-state">
    {#if isListo}
      <span class="check">&#10003;</span>
    {:else if isPreparando}
      <span class="fire">&#9711;</span>
    {:else}
      <span class="dot">&#9679;</span>
    {/if}
  </div>

  <div class="item-info">
    <!-- Línea principal: cantidad + nombre + badge tipo + device badge -->
    <div class="item-main">
      <span class="qty">{item.cantidad}x</span>
      <span class="name">{item.nombre}</span>
      {#if item.tipo === 'mitad_mitad'}
        <span class="tipo-badge badge-mitad">MITAD</span>
      {:else if item.tipo === 'al_gusto'}
        <span class="tipo-badge badge-algusto">AL GUSTO</span>
      {/if}
      {#if isPreparando && deviceColor}
        <span class="device-badge" style="background: {deviceColor}" title="{deviceNombre || ''}">
          {#if deviceNombre}{deviceNombre}{/if}
        </span>
      {/if}
    </div>

    {#if expanded}
      <!-- ======== EXPANDED: ficha completa (preparando) ======== -->
      <div class="expanded-details" transition:slide={{ duration: 200 }}>
        <!-- INGREDIENTES BASE — lista vertical -->
        {#if hasIngredientesBase}
          <div class="detail-section base-section">
            <ul class="base-list">
              {#each item.ingredientes_base || [] as ing}
                <li class="base-item">{ing}</li>
              {/each}
            </ul>
          </div>
        {/if}

        <!-- MITAD Y MITAD -->
        {#if isMitad}
          <div class="detail-section mitad-section">
            {#if pizzaIzq}
              <div class="mitad-half">
                <span class="mitad-arrow left">&#9664;</span>
                <span class="mitad-name">{pizzaIzq.nombre}</span>
                {#if pizzaIzq.ingredientes.length > 0}
                  <ul class="mitad-ing-list">
                    {#each pizzaIzq.ingredientes as ing}
                      <li class="mitad-ing-item">{ing}</li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/if}
            {#if pizzaDer}
              <div class="mitad-half">
                <span class="mitad-arrow right">&#9654;</span>
                <span class="mitad-name">{pizzaDer.nombre}</span>
                {#if pizzaDer.ingredientes.length > 0}
                  <ul class="mitad-ing-list">
                    {#each pizzaDer.ingredientes as ing}
                      <li class="mitad-ing-item">{ing}</li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/if}
          </div>
        {/if}

        <!-- AL GUSTO -->
        {#if isAlGusto}
          <div class="detail-section algusto-section">
            <span class="section-label">INGREDIENTES:</span>
            <ul class="algusto-list">
              {#each ingredientesAlGusto as ing}
                <li class="algusto-ing">{ing}</li>
              {/each}
            </ul>
          </div>
        {/if}

        <!-- VARIACIONES -->
        {#if hasVariaciones}
          <div class="detail-section variaciones-section">
            {#each quitarList as nombre}
              <div class="var-line var-quitar">
                <span class="var-icon">&#10005;</span>
                <span>SIN {nombre.toUpperCase()}</span>
              </div>
            {/each}
            {#each anadirList as addItem}
              <div class="var-line var-anadir">
                <span class="var-icon">+</span>
                <span>
                  {#if addItem.cantidad && addItem.cantidad > 1}{addItem.cantidad}x{/if}
                  {addItem.nombre.toUpperCase()}
                </span>
              </div>
            {/each}
          </div>
        {/if}

        <!-- NOTAS -->
        {#if item.notas}
          <div class="detail-section notas-section">
            <span class="nota-label">NOTA:</span>
            <span class="nota-text">{item.notas}</span>
          </div>
        {/if}
      </div>
    {:else if hasCompactSummary}
      <!-- ======== COMPACT: resumen inline (pendiente/listo) ======== -->
      <div class="compact-summary">
        {#each compactVariaciones as v}
          <span
            class="compact-var"
            class:compact-var-remove={v.startsWith('SIN')}
            class:compact-var-add={v.startsWith('+')}
          >{v}</span>
        {/each}
        {#if item.notas}
          <span class="compact-nota">
            <span class="compact-nota-label">NOTA:</span> {item.notas}
          </span>
        {/if}
      </div>
    {/if}
  </div>
</button>

<style>
  /* ===== BASE ITEM LINE ===== */
  .item-line {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    width: 100%;
    min-height: 60px;
    padding: 10px 14px;
    border: none;
    border-left: 4px solid var(--item-color);
    background: transparent;
    color: #f8fafc;
    cursor: pointer;
    text-align: left;
    transition: background 0.2s, padding 0.2s, border-left-width 0.2s;
    -webkit-tap-highlight-color: transparent;
  }

  .item-line:not(.listo):active {
    background: rgba(255, 255, 255, 0.05);
  }

  .item-line.listo {
    opacity: 0.4;
    cursor: default;
  }

  .item-line.listo .item-main {
    text-decoration: line-through;
    text-decoration-color: #22c55e;
  }

  /* ===== EXPANDED STATE (preparando) — exagerado ===== */
  .item-line.expanded {
    padding: 24px 24px 28px;
    border-left-width: 8px;
    background: rgba(234, 179, 8, 0.15);
    box-shadow: inset 0 0 40px rgba(234, 179, 8, 0.06);
  }

  .item-line.expanded .item-state {
    width: 52px;
    height: 52px;
  }

  .item-line.expanded .fire {
    font-size: 2rem;
  }

  .item-line.expanded .qty {
    font-size: 4rem;
  }

  .item-line.expanded .name {
    font-size: 3rem;
  }

  .item-line.expanded .tipo-badge {
    font-size: 1rem;
    padding: 4px 12px;
  }

  .item-line.expanded .device-badge {
    font-size: 0.9rem;
    padding: 4px 12px;
  }

  /* ===== State indicator ===== */
  .item-state {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    margin-top: 2px;
    transition: width 0.2s, height 0.2s;
  }

  .check {
    font-size: 1.4rem;
    color: #22c55e;
    font-weight: 800;
  }

  .fire {
    font-size: 1.2rem;
    color: #eab308;
    animation: spin-slow 2s linear infinite;
    transition: font-size 0.2s;
  }

  .dot {
    font-size: 0.8rem;
    color: #64748b;
  }

  /* ===== Info container ===== */
  .item-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  /* Main line: qty + name + badge */
  .item-main {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }

  .qty {
    font-size: 2rem;
    font-weight: 800;
    color: var(--item-color);
    line-height: 1;
    font-variant-numeric: tabular-nums;
    transition: font-size 0.2s;
  }

  .name {
    font-size: 1.5rem;
    font-weight: 700;
    line-height: 1.1;
    word-break: break-word;
    transition: font-size 0.2s;
  }

  /* Tipo badge */
  .tipo-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 800;
    letter-spacing: 1px;
    line-height: 1.4;
    flex-shrink: 0;
    transition: font-size 0.2s, padding 0.2s;
  }

  .badge-mitad {
    background: #7c3aed;
    color: #f5f3ff;
  }

  .badge-algusto {
    background: #0891b2;
    color: #ecfeff;
  }

  .device-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.7rem;
    font-weight: 800;
    letter-spacing: 0.5px;
    color: #fff;
    text-transform: uppercase;
    flex-shrink: 0;
    line-height: 1.4;
    min-width: 12px;
    min-height: 12px;
    transition: font-size 0.2s, padding 0.2s;
  }

  /* ===== EXPANDED DETAILS ===== */
  .expanded-details {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 12px;
  }

  /* ——— Detail sections (shared) ——— */
  .detail-section {
    padding-left: 2px;
  }

  .section-label {
    font-size: 0.95rem;
    font-weight: 700;
    color: #64748b;
    letter-spacing: 1.5px;
    display: block;
    margin-bottom: 4px;
  }

  /* ——— INGREDIENTES BASE — lista vertical ——— */
  .base-section {
    padding: 8px 12px;
    background: rgba(148, 163, 184, 0.08);
    border-radius: 8px;
    border-left: 4px solid #475569;
  }

  .base-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .base-item {
    font-size: 1.35rem;
    color: #e2e8f0;
    line-height: 1.3;
    padding: 2px 0;
  }

  .base-item::before {
    content: '\2022  ';
    color: #94a3b8;
    font-weight: 800;
  }

  /* ——— MITAD Y MITAD ——— */
  .mitad-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    background: rgba(124, 58, 237, 0.1);
    border-radius: 8px;
    border-left: 4px solid #7c3aed;
  }

  .mitad-half {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .mitad-half > :first-child {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .mitad-arrow {
    font-size: 1.1rem;
    font-weight: 800;
    flex-shrink: 0;
  }

  .mitad-arrow.left { color: #a78bfa; }
  .mitad-arrow.right { color: #c084fc; }

  .mitad-name {
    font-size: 1.7rem;
    font-weight: 700;
    color: #e2e8f0;
  }

  .mitad-ing-list {
    list-style: none;
    margin: 0;
    padding: 0 0 0 24px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .mitad-ing-item {
    font-size: 1.2rem;
    color: #e2e8f0;
    line-height: 1.3;
  }

  .mitad-ing-item::before {
    content: '- ';
    color: #7c3aed;
  }

  /* ——— AL GUSTO — lista vertical ——— */
  .algusto-section {
    padding: 10px 12px;
    background: rgba(8, 145, 178, 0.1);
    border-radius: 8px;
    border-left: 4px solid #0891b2;
  }

  .algusto-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .algusto-ing {
    font-size: 1.4rem;
    font-weight: 600;
    color: #67e8f9;
    padding: 2px 0;
  }

  .algusto-ing::before {
    content: '\2022  ';
    color: #0891b2;
    font-weight: 800;
  }

  /* ——— VARIACIONES ——— */
  .variaciones-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .var-line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 1.4rem;
    font-weight: 700;
    padding: 3px 0;
  }

  .var-icon {
    flex-shrink: 0;
    width: 22px;
    text-align: center;
    font-weight: 900;
    font-size: 1.2rem;
  }

  .var-quitar {
    color: #f87171;
  }

  .var-quitar .var-icon {
    color: #ef4444;
  }

  .var-anadir {
    color: #4ade80;
  }

  .var-anadir .var-icon {
    color: #22c55e;
  }

  /* ——— NOTAS (expanded) ——— */
  .notas-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
    background: rgba(251, 191, 36, 0.15);
    border-radius: 8px;
    border-left: 4px solid #f59e0b;
  }

  .nota-label {
    font-size: 0.85rem;
    font-weight: 800;
    color: #f59e0b;
    letter-spacing: 1.5px;
    flex-shrink: 0;
  }

  .nota-text {
    font-size: 1.4rem;
    font-weight: 600;
    color: #fbbf24;
    word-break: break-word;
    line-height: 1.3;
  }

  /* ===== COMPACT SUMMARY (pendiente/listo) ===== */
  .compact-summary {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
    margin-top: 2px;
  }

  .compact-var {
    font-size: 0.85rem;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 3px;
  }

  .compact-var-remove {
    color: #f87171;
    background: rgba(248, 113, 113, 0.12);
  }

  .compact-var-add {
    color: #4ade80;
    background: rgba(74, 222, 128, 0.12);
  }

  .compact-nota {
    font-size: 0.85rem;
    font-weight: 600;
    color: #fbbf24;
  }

  .compact-nota-label {
    font-size: 0.7rem;
    font-weight: 800;
    color: #f59e0b;
    letter-spacing: 0.5px;
  }

  /* ===== Animations ===== */
  @keyframes spin-slow {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  /* ===== Mobile Compact ===== */
  @media (max-width: 600px) {
    /* Base item line — compact */
    .item-line { min-height: 38px; padding: 5px 10px; gap: 8px; }
    .item-state { width: 22px; height: 22px; margin-top: 1px; }
    .check { font-size: 1rem; }
    .fire { font-size: 0.9rem; }
    .dot { font-size: 0.6rem; }

    /* Main line — readable but compact */
    .qty { font-size: 1rem; }
    .name { font-size: 0.9rem; }
    .item-main { gap: 5px; }
    .tipo-badge { font-size: 0.6rem; padding: 1px 5px; }
    .device-badge { font-size: 0.55rem; padding: 1px 5px; }

    /* Compact summary (pendiente/listo) */
    .compact-summary { gap: 3px 5px; margin-top: 1px; }
    .compact-var { font-size: 0.7rem; padding: 0 4px; }
    .compact-nota { font-size: 0.7rem; }
    .compact-nota-label { font-size: 0.6rem; }

    /* Expanded state (preparando) — still prominent but fits mobile */
    .item-line.expanded { padding: 10px 12px 12px; border-left-width: 5px; }
    .item-line.expanded .item-state { width: 32px; height: 32px; }
    .item-line.expanded .fire { font-size: 1.3rem; }
    .item-line.expanded .qty { font-size: 1.6rem; }
    .item-line.expanded .name { font-size: 1.3rem; }
    .item-line.expanded .tipo-badge { font-size: 0.7rem; padding: 2px 8px; }
    .item-line.expanded .device-badge { font-size: 0.65rem; padding: 2px 8px; }

    /* Expanded details — tighter */
    .expanded-details { gap: 8px; margin-top: 8px; }
    .detail-section { padding-left: 0; }
    .section-label { font-size: 0.75rem; margin-bottom: 2px; }
    .base-section { padding: 6px 8px; border-radius: 6px; border-left-width: 3px; }
    .base-item { font-size: 0.9rem; padding: 1px 0; }
    .base-list { gap: 2px; }
    .mitad-section { padding: 6px 8px; border-radius: 6px; border-left-width: 3px; gap: 6px; }
    .mitad-name { font-size: 1rem; }
    .mitad-arrow { font-size: 0.85rem; }
    .mitad-ing-list { padding-left: 18px; gap: 1px; }
    .mitad-ing-item { font-size: 0.8rem; }
    .algusto-section { padding: 6px 8px; border-radius: 6px; border-left-width: 3px; }
    .algusto-list { gap: 2px; }
    .algusto-ing { font-size: 0.9rem; padding: 1px 0; }
    .variaciones-section { gap: 3px; }
    .var-line { font-size: 0.9rem; padding: 2px 0; gap: 5px; }
    .var-icon { width: 16px; font-size: 0.85rem; }
    .notas-section { padding: 6px 8px; border-radius: 6px; border-left-width: 3px; }
    .nota-label { font-size: 0.65rem; }
    .nota-text { font-size: 0.9rem; }
  }
</style>
