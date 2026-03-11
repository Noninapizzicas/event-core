<script lang="ts">
  /**
   * ComanderoScreen — Pantalla de pedido
   *
   * Layout scroll completo:
   * ┌────────────────────────────────────────┐
   * │ Header: nombre cuenta                  │
   * ├────────────────────────────────────────┤
   * │ Especiales: Mitad | Al gusto | Menú    │
   * ├────────────────────────────────────────┤
   * │ Familias: [🍕Pizza][🥗Ensaladas][...]  │
   * ├──────────────────────────┬─────────────┤
   * │ ┌── 🍕 Pizzas ────────┐ │ Sidebar     │
   * │ │ [prod] [prod] [prod]│ │ (acciones)  │
   * │ ├── 🥗 Ensaladas ─────┤ │ Enviar      │
   * │ │ [prod] [prod]       │ │ Cobro       │
   * │ ├── 🍰 Postres ───────┤ │ Cuenta      │
   * │ │ [prod] [prod] [prod]│ │ Imprimir    │
   * │ ├──────────────────────┤ │ Salir       │
   * │ │ Pedido (scroll down) │ │             │
   * │ └──────────────────────┘ │             │
   * └──────────────────────────┴─────────────┘
   * Cada sección tiene color de fondo de su familia.
   * Botones de familia hacen scroll-to-section.
   */
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { connect, disconnect, setupVisibilityHandler, removeVisibilityHandler } from '$lib/ui-core';
  import {
    comanderoStore,
    categorias,
    productos,
    todosProductos,
    categoriaActiva,
    pedidoItems,
    pedidoTotal,
    comanderoLoading,
    initComandero,
    selectCategoria,
    addItem,
    updateItem,
    removeItem,
    enviarCocina,
    resetComandero,
    initComanderoSubscriptions,
    ingredientes as ingredientesStore,
    type Producto,
    type Categoria
  } from '$lib/stores/comandero';
  import { renameMesa, renameCuenta, getCuenta } from '$lib/stores/cuentas';
  import { imprimirComanda, type ComandaItem, type Canal } from '$lib/stores/impresion';

  import BotonEspecial from './BotonEspecial.svelte';
  import CategoriaBtn from './CategoriaBtn.svelte';
  import AccionBtn from './AccionBtn.svelte';
  import ProductoBtn from './ProductoBtn.svelte';
  import PedidoList from './PedidoList.svelte';
  import VariacionesPanel from './VariacionesPanel.svelte';
  import CobroPanel from './CobroPanel.svelte';
  import MitadMitadPanel from './MitadMitadPanel.svelte';
  import AlGustoPanel from './AlGustoPanel.svelte';

  /** ID de la cuenta activa */
  export let cuenta_id: string;

  /** ID del proyecto */
  export let projectId: string = '';

  /** Callback para navegar */
  export let onNavigate: ((path: string) => void) | null = null;

  /** Callback para abrir flotante */
  export let onOpenPanel: ((panel: string, data?: any) => void) | null = null;

  /** Vista inicial: 'cuenta' abre panel de cobro al cargar */
  export let initialView: string | undefined = undefined;

  let cleanupSubs: (() => void) | null = null;
  let contentEl: HTMLElement;
  let pedidoSectionEl: HTMLElement;

  // Refs para secciones de familia (scroll-to)
  let familiaRefs: Record<string, HTMLElement> = {};
  let familiaActiva: string | null = null;

  // Colores fijos por familia: amarillo, verde, azul, rojo, lila
  const FAMILIA_COLORS = ['#eab308', '#22c55e', '#3b82f6', '#ef4444', '#a855f7'];

  // Agrupar productos por categoría con color garantizado
  $: productosPorFamilia = $categorias.map((cat, idx) => ({
    categoria: cat,
    color: cat.color || FAMILIA_COLORS[idx % FAMILIA_COLORS.length],
    productos: $todosProductos.filter(p => p.categoria_id === cat.id || p.categoria === cat.id)
  })).filter(g => g.productos.length > 0);

  function scrollToFamilia(catId: string) {
    familiaActiva = catId;
    selectCategoria(catId);
    const el = familiaRefs[catId];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function scrollToPedido() {
    pedidoSectionEl?.scrollIntoView({ behavior: 'smooth' });
  }

  // Detectar familia visible al hacer scroll
  function handleContentScroll() {
    if (!contentEl) return;
    const scrollTop = contentEl.scrollTop;
    const offset = 60; // margen para considerar "visible"

    for (const grupo of productosPorFamilia) {
      const el = familiaRefs[grupo.categoria.id];
      if (el) {
        const top = el.offsetTop - contentEl.offsetTop;
        const bottom = top + el.offsetHeight;
        if (scrollTop + offset >= top && scrollTop + offset < bottom) {
          if (familiaActiva !== grupo.categoria.id) {
            familiaActiva = grupo.categoria.id;
            selectCategoria(grupo.categoria.id);
          }
          break;
        }
      }
    }
  }

  // Nombre editable de la cuenta (mesa y llevar)
  const isMesa = cuenta_id.startsWith('mesa_');
  const isLlevar = cuenta_id.startsWith('llevar_');
  const canRename = isMesa || isLlevar;
  let cuentaNombre = isMesa ? 'Mesa...' : isLlevar ? 'Llevar...' : cuenta_id.split('_')[0] || 'Cuenta';
  let editingName = false;
  let nameInput = '';
  let nameInputEl: HTMLInputElement;

  // Voice recognition
  let listening = false;
  let voiceError = '';

  function startEditName() {
    nameInput = cuentaNombre;
    editingName = true;
    setTimeout(() => nameInputEl?.focus(), 50);
  }

  async function saveName() {
    editingName = false;
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === cuentaNombre) return;

    if (isMesa) {
      const ok = await renameMesa(projectId, cuenta_id, trimmed);
      if (ok) cuentaNombre = trimmed;
    } else if (canRename) {
      const ok = await renameCuenta(projectId, cuenta_id, trimmed);
      if (ok) cuentaNombre = trimmed;
    }
  }

  function handleNameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') saveName();
    if (e.key === 'Escape') { editingName = false; }
  }

  async function startVoice() {
    voiceError = '';

    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      voiceError = 'Voz no soportada';
      setTimeout(() => voiceError = '', 3000);
      return;
    }

    // Pedir permisos de micrófono explícitamente
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Liberamos el stream inmediatamente — solo necesitábamos el permiso
      stream.getTracks().forEach(t => t.stop());
    } catch (err: any) {
      console.error('[Voice] Mic permission denied:', err);
      voiceError = 'Sin micro';
      setTimeout(() => voiceError = '', 3000);
      return;
    }

    try {
      const recognition = new SR();
      recognition.lang = 'es-ES';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      listening = true;

      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        if (transcript && transcript.trim()) {
          nameInput = transcript.trim();
          cuentaNombre = nameInput;
          listening = false;
          // Guardar directamente
          if (isMesa) {
            renameMesa(projectId, cuenta_id, nameInput);
          } else {
            renameCuenta(projectId, cuenta_id, nameInput);
          }
        }
      };

      recognition.onerror = (event: any) => {
        console.error('[Voice] Error:', event.error);
        listening = false;
        if (event.error === 'not-allowed') {
          voiceError = 'Sin permiso micro';
        } else if (event.error === 'no-speech') {
          voiceError = 'No te he oído';
        } else if (event.error === 'network') {
          voiceError = 'Sin conexión';
        } else {
          voiceError = 'Error de voz';
        }
        setTimeout(() => voiceError = '', 3000);
      };

      recognition.onend = () => { listening = false; };

      recognition.start();
    } catch (err: any) {
      console.error('[Voice] Start failed:', err);
      listening = false;
      voiceError = 'Error al iniciar';
      setTimeout(() => voiceError = '', 3000);
    }
  }

  // Estado del panel de variaciones
  let showVariaciones = false;
  let productoVariaciones: Producto | null = null;

  // Estado del panel de cobro
  let showCobro = false;
  let cobroMonto = 0;

  // Estado del panel mitad y mitad
  let showMitadMitad = false;

  // Estado del panel al gusto
  let showAlGusto = false;

  // Botones especiales (configurables según negocio)
  const botonesEspeciales = [
    { id: 'mitad', label: 'Mitad', icon: '🍕½', color: '#8b5cf6' },
    { id: 'algusto', label: 'Al gusto', icon: '🎨', color: '#ec4899' },
    { id: 'menu', label: 'Menú', icon: '📋', color: '#0ea5e9' }
  ];

  // Acciones sidebar
  const acciones = [
    { id: 'cuenta', label: 'Cuenta', icon: '📄', variant: 'default' as const },
    { id: 'enviar', label: 'Enviar', icon: '🍳', variant: 'primary' as const },
    { id: 'imprimir', label: 'Imprimir', icon: '🖨️', variant: 'default' as const },
    { id: 'cobro', label: 'Cobro', icon: '💶', variant: 'default' as const },
    { id: 'salir', label: 'Salir', icon: '↩️', variant: 'danger' as const }
  ];

  // Estado resultado impresion
  let printResult: { type: 'ok' | 'error'; msg: string } | null = null;

  // Handlers
  function handleCategoriaSelect(e: CustomEvent<{ id: string }>) {
    scrollToFamilia(e.detail.id);
  }

  function handleProductoAdd(e: CustomEvent<{ producto: Producto }>) {
    const prod = e.detail.producto;
    // Enviar ingredientes_base del producto para que cocina sepa qué lleva
    const ingsBase = (prod.ingredientes || []).map((i: any) => typeof i === 'string' ? i : i.nombre).filter(Boolean);
    if (ingsBase.length > 0) {
      addItem(prod.id, 1, [], { ingredientes_base: ingsBase });
    } else {
      addItem(prod.id);
    }
  }

  function handleProductoVariaciones(e: CustomEvent<{ producto: Producto }>) {
    productoVariaciones = e.detail.producto;
    showVariaciones = true;
  }

  function handleVariacionesClose() {
    showVariaciones = false;
    productoVariaciones = null;
  }

  /**
   * Abre el panel de cobro con el monto correcto.
   * Usa Math.max entre el buffer del comandero y el total acumulado
   * en persistencia (cuentas), para que tras reinicio del servidor
   * el monto refleje el total real aunque el buffer esté vacío.
   */
  async function openCobro() {
    let cuentaTotal = 0;
    try {
      const cuenta = await getCuenta(projectId, cuenta_id);
      if (cuenta?.total) cuentaTotal = cuenta.total;
    } catch { /* usar solo pedidoTotal */ }
    cobroMonto = Math.max(get(pedidoTotal), cuentaTotal);
    showCobro = true;
  }

  function handleCobroClose() {
    showCobro = false;
  }

  function handleCobroSuccess(e: CustomEvent<{ cobro_id: string; estado: string }>) {
    console.log('[Comandero] Cobro completado:', e.detail);
    showCobro = false;
    // Limpiar pedido actual después de cobrar
    resetComandero();
    // Volver a lista de cuentas
    if (onNavigate) onNavigate('/comandero');
  }

  function handleVariacionesConfirm(e: CustomEvent<{
    producto_id: string;
    ingredientes_quitar: string[];
    ingredientes_anadir: { nombre: string; cantidad: number; precio_extra?: number }[];
    ingredientes_base: string[];
    precio_total: number;
  }>) {
    const { producto_id, ingredientes_quitar, ingredientes_anadir, ingredientes_base, precio_total } = e.detail;

    // Variaciones como objeto con NOMBRES legibles (no IDs)
    addItem(producto_id, 1, [], {
      precio_override: precio_total,
      variaciones: { ingredientes_quitar, ingredientes_anadir },
      ingredientes_base
    });

    // Cerrar panel
    showVariaciones = false;
    productoVariaciones = null;
  }

  function handleItemIncrement(e: CustomEvent<{ item_id: string }>) {
    const item = $pedidoItems.find(i => i.id === e.detail.item_id);
    if (item) {
      updateItem(e.detail.item_id, { cantidad: item.cantidad + 1 });
    }
  }

  function handleItemDecrement(e: CustomEvent<{ item_id: string }>) {
    const item = $pedidoItems.find(i => i.id === e.detail.item_id);
    if (item && item.cantidad > 1) {
      updateItem(e.detail.item_id, { cantidad: item.cantidad - 1 });
    }
  }

  function handleItemRemove(e: CustomEvent<{ item_id: string }>) {
    removeItem(e.detail.item_id);
  }

  function handleEspecialClick(e: CustomEvent<{ id: string }>) {
    const { id } = e.detail;

    switch (id) {
      case 'mitad':
        showMitadMitad = true;
        break;
      case 'algusto':
        showAlGusto = true;
        break;
      case 'menu':
        if (onOpenPanel) onOpenPanel(id);
        break;
    }
  }

  function handleMitadMitadClose() {
    showMitadMitad = false;
  }

  function handleMitadMitadConfirm(e: CustomEvent<{
    pizza_izquierda: any;
    pizza_derecha: any;
    precio_final: number;
    nombre_compuesto: string;
  }>) {
    const { pizza_izquierda, pizza_derecha, precio_final, nombre_compuesto } = e.detail;

    // Incluir ingredientes_base de cada mitad para que cocina vea qué lleva
    const extractBase = (pizza: any) => ({
      id: pizza.id,
      nombre: pizza.nombre,
      ingredientes_base: (pizza.ingredientes_base || pizza.ingredientes || [])
        .map((i: any) => typeof i === 'string' ? i : i.nombre)
        .filter(Boolean)
    });

    addItem(pizza_izquierda.id, 1, [], {
      tipo: 'mitad_mitad',
      nombre_override: nombre_compuesto,
      precio_override: precio_final,
      pizza_izquierda: extractBase(pizza_izquierda),
      pizza_derecha: extractBase(pizza_derecha)
    });

    showMitadMitad = false;
  }

  function handleAlGustoClose() {
    showAlGusto = false;
  }

  function handleAlGustoConfirm(e: CustomEvent<{
    ingredientes: any[];
    precio_total: number;
    nombre_compuesto: string;
  }>) {
    const { ingredientes, precio_total, nombre_compuesto } = e.detail;

    addItem('pizza_algusto', 1, [], {
      tipo: 'al_gusto',
      nombre_override: nombre_compuesto,
      precio_override: precio_total,
      ingredientes: ingredientes.map(i => ({
        id: i.id,
        nombre: i.nombre,
        precio_extra: i.precio_extra || 0,
        tipo: i.tipo || null
      }))
    });

    showAlGusto = false;
  }

  async function handleAccionClick(e: CustomEvent<{ id: string }>) {
    const { id } = e.detail;

    switch (id) {
      case 'cuenta':
        if (onNavigate) onNavigate(`/comandero/${cuenta_id}?view=cuenta`);
        break;
      case 'enviar':
        const result = await enviarCocina();
        if (!result.success) {
          console.error('[Comandero] Error enviando:', result.error);
        }
        break;
      case 'imprimir':
        if ($pedidoItems.length === 0) {
          printResult = { type: 'error', msg: 'Sin items' };
          setTimeout(() => printResult = null, 2000);
          break;
        }
        {
          // Convertir pedidoItems al formato ComandaItem
          const comandaItems: ComandaItem[] = $pedidoItems.map(item => {
            const ci: ComandaItem = {
              nombre: item.nombre_override || item.nombre,
              cantidad: item.cantidad
            };
            // Variaciones: soportar formato objeto nuevo y array legacy
            const v = item.variaciones as any;
            if (v) {
              if (!Array.isArray(v) && typeof v === 'object' && (v.ingredientes_quitar || v.ingredientes_anadir)) {
                // Formato nuevo (objeto directo)
                ci.variaciones = {
                  ingredientes_quitar: v.ingredientes_quitar || [],
                  ingredientes_anadir: (v.ingredientes_anadir || []).map((i: any) =>
                    typeof i === 'string' ? i : i.nombre
                  )
                };
              } else if (Array.isArray(v) && v.length > 0) {
                // Formato legacy (array)
                ci.variaciones = {
                  ingredientes_quitar: v
                    .filter((x: any) => x.tipo === 'quitar')
                    .map((x: any) => x.ingrediente_id),
                  ingredientes_anadir: v
                    .filter((x: any) => x.tipo === 'anadir')
                    .map((x: any) => x.ingrediente_id)
                };
              }
            }
            if (item.tipo === 'mitad_mitad') {
              ci.tipo = 'mitad-mitad';
              ci.pizza_izquierda = item.pizza_izquierda?.nombre;
              ci.pizza_derecha = item.pizza_derecha?.nombre;
            }
            return ci;
          });

          // Detectar canal desde cuenta_id
          const canalDetected: Canal = cuenta_id.startsWith('mesa_') ? 'mesa'
            : cuenta_id.startsWith('telefono_') ? 'telefono'
            : cuenta_id.startsWith('llevar_') ? 'llevar'
            : cuenta_id.startsWith('glovo_') ? 'glovo'
            : 'mesa';

          const reg = await imprimirComanda(cuenta_id, canalDetected, comandaItems);
          printResult = reg
            ? { type: 'ok', msg: `Impreso` }
            : { type: 'error', msg: 'Error impresora' };
          setTimeout(() => printResult = null, 3000);
        }
        break;
      case 'cobro':
        openCobro();
        break;
      case 'salir':
        if (onNavigate) onNavigate('/comandero');
        break;
    }
  }

  onMount(() => {
    connect().then(async () => {
      await initComandero(projectId, cuenta_id);
      cleanupSubs = initComanderoSubscriptions(projectId);

      // Cargar nombre real de la cuenta
      if (isMesa) {
        try {
          const { mqttRequest } = await import('$lib/ui-core/mqtt-request');
          const res = await mqttRequest('mesa', 'get', {
            project_id: projectId,
            cuenta_id
          });
          const data = (res as any)?.data;
          if (data?.nombre) cuentaNombre = data.nombre;
        } catch { /* usa nombre por defecto */ }
      } else if (isLlevar) {
        try {
          const { mqttRequest } = await import('$lib/ui-core/mqtt-request');
          const res = await mqttRequest('cuenta', 'get', {
            project_id: projectId,
            id: cuenta_id
          });
          const data = (res as any)?.data;
          if (data?.nombre) cuentaNombre = data.nombre;
        } catch { /* usa nombre por defecto */ }
      }

      // Auto-abrir cobro si se navega con ?view=cuenta
      if (initialView === 'cuenta') {
        openCobro();
      }
    }).catch((err) => {
      console.error('[ComanderoScreen] MQTT connection failed', err);
    });

    setupVisibilityHandler();
  });

  onDestroy(() => {
    cleanupSubs?.();
    resetComandero();
    disconnect();
    removeVisibilityHandler();
  });
</script>

<div class="comandero-screen">
  <!-- Header: nombre de cuenta editable -->
  <header class="cuenta-header">
    <button class="back-btn" on:click={() => onNavigate?.('/comandero')}>
      &#8592;
    </button>

    {#if editingName}
      <input
        bind:this={nameInputEl}
        bind:value={nameInput}
        class="name-input"
        on:blur={saveName}
        on:keydown={handleNameKeydown}
        placeholder="Nombre..."
        maxlength="50"
      />
    {:else}
      <button
        class="name-display"
        class:is-mesa={canRename}
        on:click={canRename ? startEditName : undefined}
        title={canRename ? 'Tap para renombrar' : ''}
      >
        {cuentaNombre}
      </button>
    {/if}

    {#if canRename && !editingName}
      <button
        class="voice-btn"
        class:listening
        class:voice-error={!!voiceError}
        on:click={startVoice}
        disabled={listening}
        title="Renombrar por voz"
      >
        {#if voiceError}
          <span class="voice-error-text">{voiceError}</span>
        {:else if listening}
          <span class="voice-pulse">...</span>
        {:else}
          🎤
        {/if}
      </button>
    {/if}
  </header>

  <!-- Barra superior: botones especiales -->
  <header class="top-bar">
    {#each botonesEspeciales as btn}
      <BotonEspecial
        id={btn.id}
        label={btn.label}
        icon={btn.icon}
        color={btn.color}
        on:click={handleEspecialClick}
      />
    {/each}
  </header>

  <!-- Barra de familias con colores identificativos -->
  <div class="familias-bar">
    {#each $categorias as cat}
      <CategoriaBtn
        id={cat.id}
        nombre={cat.nombre}
        icon={cat.icon}
        color={cat.color || '#6366f1'}
        active={$categoriaActiva === cat.id}
        on:select={handleCategoriaSelect}
      />
    {/each}
  </div>

  <div class="main-body">
    <!-- Sidebar: solo acciones -->
    <aside class="sidebar">
      <div class="acciones">
        {#each acciones as acc}
          <AccionBtn
            id={acc.id}
            label={acc.label}
            icon={acc.icon}
            variant={acc.variant}
            on:click={handleAccionClick}
          />
        {/each}
      </div>
    </aside>

    <!-- Área principal: scroll continuo con todas las familias + pedido -->
    <main class="content" bind:this={contentEl} on:scroll={handleContentScroll}>
      {#if $comanderoLoading && $todosProductos.length === 0}
        <div class="loading">Cargando productos...</div>
      {:else if productosPorFamilia.length === 0}
        <div class="empty">
          <span>Sin productos</span>
        </div>
      {:else}
        {#each productosPorFamilia as grupo (grupo.categoria.id)}
          <div
            class="familia-section"
            style="--fam-color: {grupo.color}"
            bind:this={familiaRefs[grupo.categoria.id]}
          >
            <div class="familia-header">
              {#if grupo.categoria.icon}
                <span class="familia-icon">{grupo.categoria.icon}</span>
              {/if}
              <span class="familia-nombre">{grupo.categoria.nombre}</span>
            </div>
            <div class="productos-grid">
              {#each grupo.productos as producto (producto.id)}
                <ProductoBtn
                  {producto}
                  on:add={handleProductoAdd}
                  on:variaciones={handleProductoVariaciones}
                />
              {/each}
            </div>
          </div>
        {/each}
      {/if}

      <!-- Lista pedido (debajo de todas las familias) -->
      <div class="pedido-section" bind:this={pedidoSectionEl}>
        <PedidoList
          items={$pedidoItems}
          total={$pedidoTotal}
          on:increment={handleItemIncrement}
          on:decrement={handleItemDecrement}
          on:remove={handleItemRemove}
        />
      </div>
    </main>

    <!-- Botón flotante: ir al pedido -->
    {#if $pedidoItems.length > 0}
      <button class="fab-pedido" on:click={scrollToPedido}>
        <span class="fab-count">{$pedidoItems.reduce((s, i) => s + i.cantidad, 0)}</span>
        <span class="fab-total">{$pedidoTotal.toFixed(2)}{'\u20AC'}</span>
      </button>
    {/if}
  </div>

  <!-- Panel flotante: Variaciones -->
  {#if showVariaciones && productoVariaciones}
    <VariacionesPanel
      producto={productoVariaciones}
      visible={showVariaciones}
      {projectId}
      catalogoIngredientes={$ingredientesStore}
      on:close={handleVariacionesClose}
      on:confirm={handleVariacionesConfirm}
    />
  {/if}

  <!-- Panel flotante: Cobro -->
  {#if showCobro}
    <CobroPanel
      {cuenta_id}
      project_id={projectId}
      monto={cobroMonto}
      pedido_ids={$pedidoItems.map(i => i.id)}
      visible={showCobro}
      on:close={handleCobroClose}
      on:success={handleCobroSuccess}
    />
  {/if}

  <!-- Panel flotante: Mitad y Mitad -->
  {#if showMitadMitad}
    <MitadMitadPanel
      visible={showMitadMitad}
      {projectId}
      on:close={handleMitadMitadClose}
      on:confirm={handleMitadMitadConfirm}
    />
  {/if}

  <!-- Panel flotante: Al Gusto -->
  {#if showAlGusto}
    <AlGustoPanel
      visible={showAlGusto}
      {projectId}
      on:close={handleAlGustoClose}
      on:confirm={handleAlGustoConfirm}
    />
  {/if}

  <!-- Toast impresion -->
  {#if printResult}
    <div class="print-toast print-toast-{printResult.type}">
      {printResult.type === 'ok' ? '🖨️' : '⚠️'} {printResult.msg}
    </div>
  {/if}
</div>

<style>
  .comandero-screen {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    background: #0a0a0a;
    color: #e5e5e5;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  /* Cuenta header */
  .cuenta-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: #111;
    border-bottom: 1px solid #1a1a1a;
    flex-shrink: 0;
  }

  .back-btn {
    background: none;
    border: none;
    color: #888;
    font-size: 1.2rem;
    padding: 4px 8px;
    cursor: pointer;
    border-radius: 6px;
    line-height: 1;
  }

  .back-btn:active {
    background: #222;
  }

  .name-display {
    background: none;
    border: none;
    color: #fff;
    font-size: 1rem;
    font-weight: 700;
    padding: 4px 8px;
    cursor: default;
    border-radius: 6px;
    text-align: left;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name-display.is-mesa {
    cursor: pointer;
    border: 1px dashed transparent;
  }

  .name-display.is-mesa:active {
    background: #1a1a1a;
    border-color: #333;
  }

  .name-input {
    flex: 1;
    background: #1a1a1a;
    border: 1px solid #3b82f6;
    border-radius: 6px;
    color: #fff;
    font-size: 1rem;
    font-weight: 700;
    padding: 4px 8px;
    outline: none;
    min-width: 0;
  }

  .voice-btn {
    background: none;
    border: 1px solid #333;
    color: #888;
    font-size: 1.1rem;
    padding: 4px 10px;
    cursor: pointer;
    border-radius: 8px;
    flex-shrink: 0;
    transition: all 0.15s;
    min-width: 40px;
    text-align: center;
  }

  .voice-btn:active:not(:disabled) {
    background: #222;
  }

  .voice-btn:disabled {
    cursor: not-allowed;
  }

  .voice-btn.listening {
    border-color: #ef4444;
    color: #ef4444;
    animation: pulse-voice 1s ease-in-out infinite;
  }

  .voice-btn.voice-error {
    border-color: #f59e0b;
    color: #f59e0b;
    animation: none;
  }

  .voice-error-text {
    font-size: 0.6rem;
    font-weight: 600;
  }

  .voice-pulse {
    font-weight: 700;
  }

  @keyframes pulse-voice {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  /* Top bar */
  .top-bar {
    display: flex;
    gap: 8px;
    padding: 8px 12px;
    background: #111;
    border-bottom: 1px solid #222;
    overflow-x: auto;
    overflow-y: hidden;
    flex-shrink: 0;
    scrollbar-width: none;
  }

  .top-bar::-webkit-scrollbar {
    display: none;
  }

  /* Barra de familias */
  .familias-bar {
    display: flex;
    gap: 6px;
    padding: 5px 10px;
    background: #0d0d0d;
    border-bottom: 1px solid #222;
    overflow-x: auto;
    overflow-y: hidden;
    flex-shrink: 0;
    scrollbar-width: none;
  }

  .familias-bar::-webkit-scrollbar {
    display: none;
  }

  /* Main body */
  .main-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* Sidebar — acciones accesibles desde arriba */
  .sidebar {
    display: flex;
    flex-direction: column;
    width: 72px;
    flex-shrink: 0;
    background: #0d0d0d;
    border-left: 1px solid #1a1a1a;
    order: 1; /* Right side */
    justify-content: flex-start;
  }

  .acciones {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 5px;
    flex-shrink: 0;
  }

  /* Content — scroll continuo: productos + pedido */
  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
    scroll-behavior: smooth;
  }

  /* Secciones por familia — fondo coloreado visible */
  .familia-section {
    padding: 6px 8px 10px;
    background: color-mix(in srgb, var(--fam-color) 16%, #0f0f0f);
    border-bottom: 2px solid color-mix(in srgb, var(--fam-color) 40%, #1a1a1a);
    flex-shrink: 0;
  }

  .familia-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 4px 6px;
  }

  .familia-icon {
    font-size: 0.9rem;
    line-height: 1;
  }

  .familia-nombre {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: color-mix(in srgb, var(--fam-color) 70%, #ccc);
  }

  .productos-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
    align-content: start;
  }

  .loading, .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 200px;
    color: #555;
    font-size: 0.85rem;
  }

  .pedido-section {
    flex-shrink: 0;
    padding-top: 4px;
  }

  /* FAB flotante — ir al pedido */
  .fab-pedido {
    position: fixed;
    bottom: 16px;
    right: 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: #6366f1;
    color: #fff;
    border: none;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(99, 102, 241, 0.5);
    z-index: 50;
    -webkit-tap-highlight-color: transparent;
    transition: transform 0.15s, box-shadow 0.15s;
  }

  .fab-pedido:active {
    transform: scale(0.9);
    box-shadow: 0 2px 8px rgba(99, 102, 241, 0.4);
  }

  .fab-count {
    font-size: 1rem;
    font-weight: 800;
    line-height: 1;
  }

  .fab-total {
    font-size: 0.55rem;
    font-weight: 600;
    opacity: 0.85;
    line-height: 1;
  }

  /* Mobile */
  @media (max-width: 600px) {
    .cuenta-header { padding: 4px 8px; gap: 6px; }
    .back-btn { font-size: 1rem; padding: 2px 6px; }
    .name-display { font-size: 0.85rem; padding: 2px 6px; }
    .name-input { font-size: 0.85rem; padding: 2px 6px; }
    .voice-btn { font-size: 0.9rem; padding: 2px 8px; min-width: 32px; border-radius: 6px; }

    .top-bar { padding: 3px 6px; gap: 4px; }

    .familias-bar { padding: 4px 6px; gap: 4px; }

    /* Sidebar lateral también en móvil */
    .sidebar {
      width: 62px;
    }

    .acciones {
      gap: 6px;
      padding: 6px 4px;
    }

    .familia-section { padding: 4px 5px 8px; }
    .familia-header { padding: 2px 2px 4px; gap: 4px; }
    .familia-icon { font-size: 0.75rem; }
    .familia-nombre { font-size: 0.6rem; }
    .productos-grid { grid-template-columns: repeat(2, 1fr); gap: 4px; }
    .loading, .empty { min-height: 120px; font-size: 0.75rem; }

    .fab-pedido { width: 46px; height: 46px; bottom: 10px; right: 10px; }
    .fab-count { font-size: 0.85rem; }
    .fab-total { font-size: 0.5rem; }

    .print-toast { font-size: 0.75rem; padding: 6px 14px; bottom: 64px; }
  }

  /* Tablet */
  @media (min-width: 601px) and (max-width: 900px) {
    .productos-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  /* Print toast */
  .print-toast {
    position: fixed;
    bottom: 80px;
    left: 50%;
    transform: translateX(-50%);
    padding: 8px 20px;
    border-radius: 8px;
    font-size: 0.85rem;
    font-weight: 600;
    z-index: 100;
    pointer-events: none;
    animation: toast-in 0.2s ease-out;
  }

  .print-toast-ok {
    background: rgba(34, 197, 94, 0.9);
    color: #fff;
  }

  .print-toast-error {
    background: rgba(239, 68, 68, 0.9);
    color: #fff;
  }

  @keyframes toast-in {
    from { opacity: 0; transform: translateX(-50%) translateY(10px); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
</style>
