/**
 * Cocina Store — Estado y operaciones MQTT para pantalla de cocina
 *
 * Backend: modules/pizzepos/cocina (uiHandler domain: 'cocina')
 *
 * Operaciones: list-active, get, history, prepare-item, mark-ready, metrics, health
 * Eventos RT: pedido.enviado_cocina, cocina.item_preparado, cocina.pedido_listo, pedido.cancelado
 *
 * Diseño: optimistic updates + sonido en nuevo pedido
 */

import { writable, derived, get } from 'svelte/store';
import { mqttRequest } from '$lib/ui-core/mqtt-request';
import { subscribe as mqttSubscribe } from '$lib/ui-core';
import { onReconnect } from '$lib/ui-core/mqtt';

// =============================================================================
// TYPES
// =============================================================================

export type EstadoItem = 'pendiente' | 'preparando' | 'listo';

export interface PizzaHalf {
  nombre: string;
  emoji?: string;
  precio?: number;
  ingredientes_base?: string[];
}

export interface IngredienteAlGusto {
  id?: string;
  nombre: string;
  emoji?: string;
  precio_extra?: number;
  tipo?: string;
}

export interface ItemCocina {
  item_id: string;
  producto_id: string;
  nombre: string;
  cantidad: number;
  variaciones?: any;
  notas?: string;
  estado: EstadoItem;
  tipo?: 'mitad_mitad' | 'al_gusto' | string;
  pizza_izquierda?: string | PizzaHalf;
  pizza_derecha?: string | PizzaHalf;
  ingredientes?: Array<string | IngredienteAlGusto>;
  ingredientes_base?: string[];
  preparando_at?: string;
  preparado_at?: string;
  // Multi-dispositivo
  device_id?: string;
  device_color?: string;
  device_nombre?: string;
}

export interface GlovoMetadata {
  glovo_order_id?: string;
  cliente_nombre?: string;
  direccion_entrega?: string;
  requiere_confirmacion?: boolean;
  tiempo_estimado_entrega?: number;
  total?: number;
}

export interface PedidoCocina {
  pedido_id: string;
  cuenta_id: string;
  canal: string | null;
  items: ItemCocina[];
  estado: 'activo' | 'listo' | 'cancelado';
  notas_generales: string;
  recibido_at: string;
  listo_at?: string;
  tiempo_preparacion?: number;
  metadata?: GlovoMetadata | null;
}

export interface CocinaMetrics {
  pedidos_activos: number;
  items_pendientes: number;
  items_preparando: number;
  historial_count: number;
  tiempo_promedio_preparacion: number;
}

export interface CocinaDevice {
  device_id: string;
  nombre: string;
  color: string;
  filtros: { familias: string[] };
  connected_at: string;
  last_seen: string;
}

export interface CocinaState {
  pedidos: PedidoCocina[];
  loading: boolean;
  error: string | null;
  metrics: CocinaMetrics | null;
  // Multi-dispositivo
  myDeviceId: string | null;
  myColor: string | null;
  myNombre: string | null;
  filtrosActivos: string[]; // familias/categorías activas (vacío = todo)
  devices: CocinaDevice[];
}

// =============================================================================
// COLORS — Paleta cocina (dark, high contrast)
// =============================================================================

export const ESTADO_ITEM_COLORS: Record<EstadoItem, string> = {
  pendiente: '#94a3b8',  // slate-400
  preparando: '#eab308', // yellow-500
  listo: '#22c55e'       // green-500
};

export const CANAL_LABELS: Record<string, string> = {
  mesa: 'MESA',
  telefono: 'TEL',
  llevar: 'LLEVAR',
  glovo: 'GLOVO',
  whatsapp: 'WHATSAPP'
};

// =============================================================================
// STORE
// =============================================================================

// Genera un device ID persistente en localStorage
function getOrCreateDeviceId(): string {
  const KEY = 'cocina_device_id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = `dev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

export const cocinaStore = writable<CocinaState>({
  pedidos: [],
  loading: false,
  error: null,
  metrics: null,
  myDeviceId: null,
  myColor: null,
  myNombre: null,
  filtrosActivos: [],
  devices: []
});

// Glovo: Set de cuenta_ids ya confirmados (aceptados en Glovo API)
const glovoConfirmados = new Set<string>();

// Derivados
export const pedidosCocina = derived(cocinaStore, $s => $s.pedidos);
export const cocinaLoading = derived(cocinaStore, $s => $s.loading);
export const cocinaError = derived(cocinaStore, $s => $s.error);
export const cocinaMetrics = derived(cocinaStore, $s => $s.metrics);
export const pedidosCount = derived(cocinaStore, $s => $s.pedidos.length);
export const myDeviceColor = derived(cocinaStore, $s => $s.myColor);
export const myDeviceNombre = derived(cocinaStore, $s => $s.myNombre);
export const filtrosActivos = derived(cocinaStore, $s => $s.filtrosActivos);
export const cocinaDevices = derived(cocinaStore, $s => $s.devices);

export const itemsPendientes = derived(cocinaStore, $s =>
  $s.pedidos.reduce((sum, p) => sum + p.items.filter(i => i.estado === 'pendiente').length, 0)
);

export const itemsPreparando = derived(cocinaStore, $s =>
  $s.pedidos.reduce((sum, p) => sum + p.items.filter(i => i.estado === 'preparando').length, 0)
);

/** Comprobar si un pedido Glovo ya fue confirmado */
export function isGlovoConfirmado(cuentaId: string): boolean {
  return glovoConfirmados.has(cuentaId);
}

// =============================================================================
// OPERATIONS
// =============================================================================

export async function loadPedidosActivos(): Promise<void> {
  cocinaStore.update(s => ({ ...s, loading: true, error: null }));

  try {
    const res = await mqttRequest<any>('cocina', 'list-active', {});
    const data = res?.data?.pedidos ? res.data : res?.data?.data;
    const pedidos = data?.pedidos || [];
    const devices = data?.devices || [];

    cocinaStore.update(s => ({
      ...s,
      pedidos,
      devices,
      loading: false
    }));
  } catch (err: any) {
    cocinaStore.update(s => ({
      ...s,
      loading: false,
      error: err.message || 'Error al cargar pedidos'
    }));
  }
}

export async function loadMetrics(): Promise<void> {
  try {
    const res = await mqttRequest<any>('cocina', 'metrics', {});
    const metrics = res?.data?.pedidos_activos !== undefined ? res.data : res?.data?.data;

    if (metrics) {
      cocinaStore.update(s => ({ ...s, metrics }));
    }
  } catch {
    // Non-critical
  }
}

/**
 * Tap toggle: pendiente → preparando → listo
 * Optimistic update: UI cambia al instante, revierte si falla
 */
export async function prepararItem(itemId: string): Promise<boolean> {
  const state = get(cocinaStore);

  // Encontrar item para optimistic update
  let pedidoIdx = -1;
  let itemIdx = -1;
  let estadoAnterior: EstadoItem = 'pendiente';

  for (let pi = 0; pi < state.pedidos.length; pi++) {
    const ii = state.pedidos[pi].items.findIndex(i => i.item_id === itemId);
    if (ii !== -1) {
      pedidoIdx = pi;
      itemIdx = ii;
      estadoAnterior = state.pedidos[pi].items[ii].estado;
      break;
    }
  }

  if (pedidoIdx === -1 || estadoAnterior === 'listo') return false;

  // Optimistic: siguiente estado
  const nuevoEstado: EstadoItem = estadoAnterior === 'pendiente' ? 'preparando' : 'listo';

  cocinaStore.update(s => {
    const pedidos = [...s.pedidos];
    const pedido = { ...pedidos[pedidoIdx], items: [...pedidos[pedidoIdx].items] };
    pedido.items[itemIdx] = { ...pedido.items[itemIdx], estado: nuevoEstado };
    pedidos[pedidoIdx] = pedido;
    return { ...s, pedidos };
  });

  try {
    const state2 = get(cocinaStore);
    const payload: any = { item_id: itemId };
    if (state2.myDeviceId) payload.device_id = state2.myDeviceId;
    await mqttRequest<any>('cocina', 'prepare-item', payload);
    return true;
  } catch {
    // Revert optimistic update
    cocinaStore.update(s => {
      const pedidos = [...s.pedidos];
      if (pedidos[pedidoIdx]) {
        const pedido = { ...pedidos[pedidoIdx], items: [...pedidos[pedidoIdx].items] };
        pedido.items[itemIdx] = { ...pedido.items[itemIdx], estado: estadoAnterior };
        pedidos[pedidoIdx] = pedido;
      }
      return { ...s, pedidos };
    });
    return false;
  }
}

/**
 * Marca todos los items de un pedido como listo de golpe
 */
export async function marcarListo(pedidoId: string): Promise<boolean> {
  // Optimistic: marcar todos listo
  cocinaStore.update(s => ({
    ...s,
    pedidos: s.pedidos.map(p =>
      p.pedido_id === pedidoId
        ? { ...p, items: p.items.map(i => ({ ...i, estado: 'listo' as EstadoItem })) }
        : p
    )
  }));

  try {
    await mqttRequest<any>('cocina', 'mark-ready', { pedido_id: pedidoId });
    return true;
  } catch {
    // Recargar estado real
    await loadPedidosActivos();
    return false;
  }
}

// =============================================================================
// DEVICE REGISTRATION & FILTERS
// =============================================================================

/**
 * Registra este dispositivo en el backend de cocina.
 * Asigna color único, persiste device_id en localStorage.
 */
export async function registerDevice(nombre?: string): Promise<boolean> {
  const deviceId = getOrCreateDeviceId();

  try {
    const state = get(cocinaStore);
    const res = await mqttRequest<any>('cocina', 'register-device', {
      device_id: deviceId,
      nombre: nombre || undefined,
      filtros: state.filtrosActivos.length > 0 ? { familias: state.filtrosActivos } : undefined
    });

    const data = res?.data?.color ? res.data : res?.data?.data;
    if (data) {
      cocinaStore.update(s => ({
        ...s,
        myDeviceId: deviceId,
        myColor: data.color,
        myNombre: data.nombre,
        devices: data.devices || s.devices
      }));
    }
    return true;
  } catch {
    // Registro falló, seguir sin color
    cocinaStore.update(s => ({ ...s, myDeviceId: deviceId }));
    return false;
  }
}

/**
 * Toggle de filtro por familia/categoría.
 * Vacío = ver todo. Con filtros = solo items de esas familias.
 * El filtrado es client-side, todos los pedidos llegan completos.
 */
export function toggleFiltro(familia: string): void {
  cocinaStore.update(s => {
    const activos = s.filtrosActivos.includes(familia)
      ? s.filtrosActivos.filter(f => f !== familia)
      : [...s.filtrosActivos, familia];
    return { ...s, filtrosActivos: activos };
  });

  // Sincronizar filtros con backend (para que otros dispositivos vean la config)
  const state = get(cocinaStore);
  if (state.myDeviceId) {
    mqttRequest('cocina', 'register-device', {
      device_id: state.myDeviceId,
      filtros: { familias: state.filtrosActivos }
    }).catch(() => {});
  }
}

/** Limpia todos los filtros (ver todo) */
export function clearFiltros(): void {
  cocinaStore.update(s => ({ ...s, filtrosActivos: [] }));

  const state = get(cocinaStore);
  if (state.myDeviceId) {
    mqttRequest('cocina', 'register-device', {
      device_id: state.myDeviceId,
      filtros: { familias: [] }
    }).catch(() => {});
  }
}

/**
 * Establece filtros de golpe (reemplaza todos los activos).
 * Usado por el panel de configuración.
 */
export function setFiltros(familias: string[]): void {
  cocinaStore.update(s => ({ ...s, filtrosActivos: familias }));

  const state = get(cocinaStore);
  if (state.myDeviceId) {
    mqttRequest('cocina', 'register-device', {
      device_id: state.myDeviceId,
      filtros: { familias }
    }).catch(() => {});
  }
}

/**
 * Actualiza el nombre del dispositivo (persiste en backend).
 */
export async function updateDeviceName(nombre: string): Promise<boolean> {
  const state = get(cocinaStore);
  if (!state.myDeviceId) return false;

  cocinaStore.update(s => ({ ...s, myNombre: nombre }));

  try {
    await mqttRequest('cocina', 'register-device', {
      device_id: state.myDeviceId,
      nombre,
      filtros: { familias: state.filtrosActivos }
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Comprueba si un item pasa el filtro activo del dispositivo.
 * Si no hay filtros activos, pasa todo.
 * Usa el campo `categoria` del item si existe, o intenta inferir de la metadata.
 */
export function itemPassesFilter(item: ItemCocina, filtros: string[]): boolean {
  if (filtros.length === 0) return true;
  // El item puede tener categoria directa (añadida por el comandero)
  const cat = (item as any).categoria || (item as any).familia || '';
  if (!cat) return true; // Sin categoría = siempre visible (no filtrable)
  return filtros.includes(cat);
}

// =============================================================================
// GLOVO OPERATIONS
// =============================================================================

/**
 * Confirmar pedido Glovo — acepta en Glovo API y permite preparación
 */
export async function confirmarGlovo(cuentaId: string, tiempoEstimado?: number): Promise<boolean> {
  try {
    await mqttRequest<any>('glovo', 'aceptar', {
      cuenta_id: cuentaId,
      tiempo_preparacion_estimado: tiempoEstimado || 25
    });
    glovoConfirmados.add(cuentaId);
    // Forzar re-render actualizando pedidos
    cocinaStore.update(s => ({ ...s, pedidos: [...s.pedidos] }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Rechazar pedido Glovo — rechaza en Glovo API y quita de cocina
 */
export async function rechazarGlovo(cuentaId: string, motivo: string): Promise<boolean> {
  try {
    await mqttRequest<any>('glovo', 'rechazar', {
      cuenta_id: cuentaId,
      motivo
    });
    // Quitar de la cola de cocina
    cocinaStore.update(s => ({
      ...s,
      pedidos: s.pedidos.filter(p => p.cuenta_id !== cuentaId)
    }));
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// NOTIFICATIONS — Web Notification API para pedidos en background
// =============================================================================

let notificationsPermission: NotificationPermission = 'default';

/**
 * Solicita permiso de notificaciones al usuario.
 * Llamar tras gesto de usuario (click/tap).
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  try {
    notificationsPermission = await Notification.requestPermission();
    return notificationsPermission === 'granted';
  } catch {
    return false;
  }
}

function sendNotification(title: string, body: string, tag?: string) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  // Solo notificar si la pestaña NO está visible (en background)
  if (document.visibilityState === 'visible') return;

  try {
    const n = new Notification(title, {
      body,
      icon: '/favicon.png',
      tag: tag || 'cocina-pedido',
      renotify: true,
      vibrate: [200, 100, 200, 100, 300]
    });
    // Auto-cerrar después de 10s
    setTimeout(() => n.close(), 10000);
    // Click en la notificación = enfocar la pestaña
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Notifications not supported in this context
  }
}

/**
 * Vibrar el dispositivo (móvil) — patrón corto de alerta
 */
function vibrateDevice(pattern: number[] = [200, 100, 200]) {
  try {
    if ('vibrate' in navigator) {
      navigator.vibrate(pattern);
    }
  } catch {
    // Vibration not available
  }
}

// =============================================================================
// SOUND — Campana de cocina (triple ding ascendente, audible en ambiente ruidoso)
// =============================================================================

let audioCtx: AudioContext | null = null;

/**
 * Desbloquea AudioContext (requiere gesto de usuario en navegadores modernos).
 * Llamar una vez en el primer click/tap de la pantalla.
 */
export function resumeAudioContext() {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    // Audio not available
  }
}

function bellTone(startTime: number, freq: number, vol: number, dur: number) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.frequency.value = freq;
  osc.type = 'triangle';
  gain.gain.setValueAtTime(vol, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + dur);
  osc.start(startTime);
  osc.stop(startTime + dur);
}

function playNewOrderSound() {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const t = audioCtx.currentTime;

    // Ding 1 — fundamental + overtone
    bellTone(t, 1200, 0.5, 0.35);
    bellTone(t, 2400, 0.2, 0.25);

    // Ding 2 — más alto (150ms después)
    bellTone(t + 0.15, 1500, 0.5, 0.35);
    bellTone(t + 0.15, 3000, 0.2, 0.25);

    // Ding 3 — aún más alto (300ms después)
    bellTone(t + 0.30, 1800, 0.45, 0.4);
    bellTone(t + 0.30, 3600, 0.15, 0.3);
  } catch {
    // Audio not available
  }
}

/**
 * Alarma Glovo — más grave, más larga, doble secuencia
 * Distinguible del bell normal en ambiente ruidoso de cocina
 */
function playGlovoAlertSound() {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const t = audioCtx.currentTime;

    // Secuencia 1: tono grave de alerta (800Hz base)
    bellTone(t, 800, 0.6, 0.3);
    bellTone(t, 1600, 0.3, 0.2);
    bellTone(t + 0.12, 1000, 0.6, 0.3);
    bellTone(t + 0.12, 2000, 0.3, 0.2);
    bellTone(t + 0.24, 1200, 0.5, 0.35);
    bellTone(t + 0.24, 2400, 0.25, 0.25);

    // Pausa breve, luego secuencia 2 (repetir para urgencia)
    bellTone(t + 0.6, 800, 0.6, 0.3);
    bellTone(t + 0.6, 1600, 0.3, 0.2);
    bellTone(t + 0.72, 1000, 0.6, 0.3);
    bellTone(t + 0.72, 2000, 0.3, 0.2);
    bellTone(t + 0.84, 1200, 0.5, 0.35);
    bellTone(t + 0.84, 2400, 0.25, 0.25);
  } catch {
    // Audio not available
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Extrae referencia legible del cuenta_id
 * mesa_5_20260225_001 → "MESA 5"
 * tel_20260225_001 → "TEL #1"
 */
export function extractRef(cuentaId: string): string {
  if (!cuentaId) return '???';
  if (cuentaId.startsWith('mesa_')) {
    const parts = cuentaId.split('_');
    return `MESA ${parts[1]}`;
  }
  if (cuentaId.startsWith('tel_')) {
    const parts = cuentaId.split('_');
    return `TEL #${parseInt(parts[2]) || parts[2]}`;
  }
  if (cuentaId.startsWith('llevar_')) {
    const parts = cuentaId.split('_');
    return `LLEVAR #${parseInt(parts[2]) || parts[2]}`;
  }
  if (cuentaId.startsWith('glovo_')) {
    const parts = cuentaId.split('_');
    return `GLOVO #${parseInt(parts[2]) || parts[2]}`;
  }
  if (cuentaId.startsWith('wa_')) {
    const parts = cuentaId.split('_');
    return `WA #${parseInt(parts[2]) || parts[2]}`;
  }
  // Fallback: UUID corto
  return cuentaId.substring(0, 8).toUpperCase();
}

/**
 * Calcula tiempo transcurrido en formato MM:SS
 */
export function elapsed(isoDate: string): string {
  const diff = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  const mins = Math.floor(diff / 60);
  const secs = diff % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// =============================================================================
// REALTIME SUBSCRIPTIONS
// =============================================================================

export function initCocinaSubscriptions(): () => void {
  const cleanups: (() => void)[] = [];

  // pedido.enviado_cocina → nuevo pedido llega
  cleanups.push(
    mqttSubscribe('pedido.enviado_cocina', (event: any) => {
      const data = event?.data || event?.payload || event;
      if (!data?.pedido_id) return;

      const isGlovo = data.canal === 'glovo';

      const pedidoCocina: PedidoCocina = {
        pedido_id: data.pedido_id,
        cuenta_id: data.cuenta_id,
        canal: data.canal || null,
        items: (data.items || []).map((item: any) => ({
          ...item,
          estado: 'pendiente' as EstadoItem
        })),
        estado: 'activo',
        notas_generales: data.notas_generales || '',
        recibido_at: data.recibido_at || new Date().toISOString(),
        metadata: isGlovo ? (data.metadata || null) : null
      };

      cocinaStore.update(s => {
        // Evitar duplicados
        if (s.pedidos.some(p => p.pedido_id === data.pedido_id)) return s;
        return { ...s, pedidos: [...s.pedidos, pedidoCocina] };
      });

      // Sonido diferenciado: Glovo = alarma doble grave, resto = campana triple
      if (isGlovo) {
        playGlovoAlertSound();
        sendNotification('GLOVO', `Nuevo pedido Glovo${data.metadata?.cliente_nombre ? ` — ${data.metadata.cliente_nombre}` : ''}`, `glovo-${data.pedido_id}`);
        vibrateDevice([200, 100, 200, 100, 300]);
      } else {
        playNewOrderSound();
        const ref = data.cuenta_id ? extractRef(data.cuenta_id) : 'Nuevo pedido';
        sendNotification('COCINA', `${ref} — ${(data.items || []).length} items`, `pedido-${data.pedido_id}`);
        vibrateDevice([200, 100, 200]);
      }
    })
  );

  // cocina.item_preparando → item empieza a prepararse (sync multi-pantalla + device color)
  cleanups.push(
    mqttSubscribe('cocina.item_preparando', (event: any) => {
      const data = event?.data || event?.payload || event;
      if (!data?.item_id) return;

      cocinaStore.update(s => ({
        ...s,
        pedidos: s.pedidos.map(p =>
          p.pedido_id === data.pedido_id
            ? {
              ...p,
              items: p.items.map(i =>
                i.item_id === data.item_id
                  ? {
                    ...i,
                    estado: 'preparando' as EstadoItem,
                    preparando_at: data.preparando_at,
                    device_id: data.device_id || i.device_id,
                    device_color: data.device_color || i.device_color,
                    device_nombre: data.device_nombre || i.device_nombre
                  }
                  : i
              )
            }
            : p
        )
      }));
    })
  );

  // cocina.item_preparado → item marcado listo (sync multi-pantalla + device color)
  cleanups.push(
    mqttSubscribe('cocina.item_preparado', (event: any) => {
      const data = event?.data || event?.payload || event;
      if (!data?.item_id) return;

      cocinaStore.update(s => ({
        ...s,
        pedidos: s.pedidos.map(p =>
          p.pedido_id === data.pedido_id
            ? {
              ...p,
              items: p.items.map(i =>
                i.item_id === data.item_id
                  ? {
                    ...i,
                    estado: 'listo' as EstadoItem,
                    preparado_at: data.preparado_at,
                    device_id: data.device_id || i.device_id,
                    device_color: data.device_color || i.device_color,
                    device_nombre: data.device_nombre || i.device_nombre
                  }
                  : i
              )
            }
            : p
        )
      }));
    })
  );

  // cocina.pedido_listo → pedido completado, quitar de pantalla con delay
  cleanups.push(
    mqttSubscribe('cocina.pedido_listo', (event: any) => {
      const data = event?.data || event?.payload || event;
      if (!data?.pedido_id) return;

      // Marcar como listo visualmente
      cocinaStore.update(s => ({
        ...s,
        pedidos: s.pedidos.map(p =>
          p.pedido_id === data.pedido_id
            ? { ...p, estado: 'listo', listo_at: data.listo_at, tiempo_preparacion: data.tiempo_preparacion }
            : p
        )
      }));

      // Remover después de 3s (fade out en CSS)
      setTimeout(() => {
        cocinaStore.update(s => ({
          ...s,
          pedidos: s.pedidos.filter(p => p.pedido_id !== data.pedido_id)
        }));
      }, 3000);
    })
  );

  // pedido.cancelado → quitar inmediatamente
  cleanups.push(
    mqttSubscribe('pedido.cancelado', (event: any) => {
      const data = event?.data || event?.payload || event;
      if (!data?.pedido_id) return;

      cocinaStore.update(s => ({
        ...s,
        pedidos: s.pedidos.filter(p => p.pedido_id !== data.pedido_id)
      }));
    })
  );

  // glovo.pedido_aceptado → marcar como confirmado (sync multi-pantalla)
  cleanups.push(
    mqttSubscribe('glovo.pedido_aceptado', (event: any) => {
      const data = event?.data || event?.payload || event;
      if (!data?.cuenta_id) return;
      glovoConfirmados.add(data.cuenta_id);
      // Forzar re-render
      cocinaStore.update(s => ({ ...s, pedidos: [...s.pedidos] }));
    })
  );

  // glovo.pedido_rechazado → quitar de cola cocina (sync multi-pantalla)
  cleanups.push(
    mqttSubscribe('glovo.pedido_rechazado', (event: any) => {
      const data = event?.data || event?.payload || event;
      if (!data?.cuenta_id) return;
      cocinaStore.update(s => ({
        ...s,
        pedidos: s.pedidos.filter(p => p.cuenta_id !== data.cuenta_id)
      }));
    })
  );

  // cocina.device_registered / cocina.device_updated → sync device list
  cleanups.push(
    mqttSubscribe('cocina.device_registered', (event: any) => {
      const data = event?.data || event?.payload || event;
      if (!data?.device_id) return;
      // Reload devices list
      loadPedidosActivos();
    })
  );
  cleanups.push(
    mqttSubscribe('cocina.device_unregistered', (event: any) => {
      const data = event?.data || event?.payload || event;
      if (!data?.device_id) return;
      cocinaStore.update(s => ({
        ...s,
        devices: s.devices.filter(d => d.device_id !== data.device_id)
      }));
    })
  );

  // Recargar datos completos cuando MQTT reconecta (tras pérdida de conexión)
  const unsubReconnect = onReconnect(() => {
    console.log('[Cocina] MQTT reconnected — reloading pedidos and metrics');
    loadPedidosActivos();
    loadMetrics();
    registerDevice(); // Re-register device
  });
  cleanups.push(unsubReconnect);

  // Recargar cuando la pestaña vuelve a ser visible (usuario vuelve del background)
  function onVisibilityChange() {
    if (document.visibilityState === 'visible') {
      console.log('[Cocina] Tab visible — recargando pedidos');
      loadPedidosActivos();
      loadMetrics();
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  // Carga inicial + register device
  loadPedidosActivos();
  loadMetrics();
  registerDevice();

  // Refrescar métricas cada 30s
  const metricsInterval = setInterval(loadMetrics, 30000);

  return () => {
    for (const cleanup of cleanups) cleanup();
    clearInterval(metricsInterval);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
