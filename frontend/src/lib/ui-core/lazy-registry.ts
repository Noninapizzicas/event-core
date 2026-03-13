/**
 * Lazy Module Registry - Carga bajo demanda real
 *
 * Características:
 * 1. Los módulos NO se importan hasta que se navegan
 * 2. Eventos con scope: ui.{module}.*
 * 3. Subscribe/unsubscribe automático en mount/unmount
 * 4. Bootstrap mínimo: solo Core, Router, EventBus, Shell
 */

import { writable, derived, get } from 'svelte/store';
import { publish, subscribe as mqttSubscribe, isConnected } from './mqtt';
import type { UIModule, UIZone, ModuleContext, AppState } from './types';
import { getPanel, loadPanelComponent } from '$lib/modules/panels';
import { setPageContext as setPageCtx, clearPageContext as clearPageCtx } from '$lib/stores/page-context';

// ============================================================================
// TIPOS PARA LAZY LOADING
// ============================================================================

export interface LazyModuleDefinition {
  id: string;
  zone: UIZone;
  order?: number;
  // Loader que importa el módulo bajo demanda
  loader: () => Promise<UIModule>;
  // Ícono para mostrar mientras no está cargado
  icon: string;
  label: string;
  // Dependencias que deben cargarse primero
  dependencies?: string[];
  // Rutas donde el módulo es visible (sin definir = aparece en todas)
  routes?: string[];
}

interface LoadedModule {
  definition: LazyModuleDefinition;
  module: UIModule | null;
  loading: boolean;
  error: Error | null;
  subscriptions: Array<() => void>;
  mounted: boolean;
}

// ============================================================================
// ESTADO INTERNO
// ============================================================================

// Definiciones de módulos (sin cargar)
const definitionsStore = writable<Map<string, LazyModuleDefinition>>(new Map());

// Módulos cargados
const loadedStore = writable<Map<string, LoadedModule>>(new Map());

// Estado de la app
const appStateStore = writable<AppState>({
  project: null,
  provider: null,
  model: null,
  prompt: null,
  credentials: { valid: false, providers: [] },
  conversationCount: 0
});

// Panel/módulo activo
const activePanelStore = writable<string | null>(null);
const activeModuleStore = writable<string | null>(null);

// ============================================================================
// SCOPED EVENTS - ui.{module}.*
// ============================================================================

/**
 * Crea un contexto con eventos limitados al módulo
 */
function createScopedContext(moduleId: string): ModuleContext {
  const scopePrefix = `ui.${moduleId}`;
  const subscriptions: Array<() => void> = [];

  return {
    // Publish solo con prefijo del módulo
    publish: (topic: string, payload: unknown) => {
      const scopedTopic = topic.startsWith('ui.') ? topic : `${scopePrefix}.${topic}`;
      publish(scopedTopic, payload);
    },

    // Subscribe solo a eventos del módulo o globales explícitos
    subscribe: (pattern: string, handler: (topic: string, payload: unknown) => void) => {
      // Si no tiene prefijo, asumimos scope del módulo
      const scopedPattern = pattern.startsWith('ui.') || pattern.startsWith('system.')
        ? pattern
        : `${scopePrefix}.${pattern}`;

      const unsub = mqttSubscribe(scopedPattern, handler);
      subscriptions.push(unsub);
      return unsub;
    },

    // Acceso al scope global (explícito)
    subscribeGlobal: (pattern: string, handler: (topic: string, payload: unknown) => void) => {
      const unsub = mqttSubscribe(pattern, handler);
      subscriptions.push(unsub);
      return unsub;
    },

    openPanel: (panelId: string) => {
      activePanelStore.set(panelId);
    },

    closePanel: () => {
      activePanelStore.set(null);
    },

    // Cleanup de todas las subscripciones del contexto
    cleanup: () => {
      for (const unsub of subscriptions) {
        unsub();
      }
      subscriptions.length = 0;
    }
  };
}

// ============================================================================
// LAZY LOADING
// ============================================================================

/**
 * Registrar definición de módulo (sin cargarlo)
 */
export function defineModule(def: LazyModuleDefinition): void {
  definitionsStore.update(m => {
    m.set(def.id, def);
    return new Map(m);
  });

  // Inicializar entrada en loadedStore
  loadedStore.update(m => {
    m.set(def.id, {
      definition: def,
      module: null,
      loading: false,
      error: null,
      subscriptions: [],
      mounted: false
    });
    return new Map(m);
  });

  console.log(`[LazyRegistry] Defined module "${def.id}" (not loaded)`);
}

/**
 * Cargar un módulo bajo demanda
 */
export async function loadModule(moduleId: string): Promise<UIModule | null> {
  const loaded = get(loadedStore).get(moduleId);

  if (!loaded) {
    console.error(`[LazyRegistry] Module "${moduleId}" not defined`);
    return null;
  }

  // Ya cargado
  if (loaded.module) {
    return loaded.module;
  }

  // En proceso de carga
  if (loaded.loading) {
    // Esperar a que termine
    return new Promise((resolve) => {
      const unsub = loadedStore.subscribe(m => {
        const l = m.get(moduleId);
        if (l && !l.loading) {
          unsub();
          resolve(l.module);
        }
      });
    });
  }

  // Cargar dependencias primero
  if (loaded.definition.dependencies) {
    for (const depId of loaded.definition.dependencies) {
      await loadModule(depId);
    }
  }

  // Marcar como loading
  loadedStore.update(m => {
    const l = m.get(moduleId)!;
    l.loading = true;
    return new Map(m);
  });

  try {
    console.log(`[LazyRegistry] Loading module "${moduleId}"...`);
    const startTime = performance.now();

    const module = await loaded.definition.loader();

    const duration = performance.now() - startTime;
    console.log(`[LazyRegistry] Module "${moduleId}" loaded in ${duration.toFixed(1)}ms`);

    // Guardar módulo cargado
    loadedStore.update(m => {
      const l = m.get(moduleId)!;
      l.module = module;
      l.loading = false;
      return new Map(m);
    });

    return module;
  } catch (error) {
    console.error(`[LazyRegistry] Failed to load module "${moduleId}":`, error);

    loadedStore.update(m => {
      const l = m.get(moduleId)!;
      l.loading = false;
      l.error = error as Error;
      return new Map(m);
    });

    return null;
  }
}

/**
 * Montar un módulo (activar subscripciones)
 */
export async function mountModule(moduleId: string): Promise<boolean> {
  // Cargar si no está cargado
  const module = await loadModule(moduleId);
  if (!module) return false;

  const loaded = get(loadedStore).get(moduleId)!;
  if (loaded.mounted) return true;

  // Crear contexto con scope
  const ctx = createScopedContext(moduleId);

  // Llamar onMount
  if (module.onMount) {
    try {
      module.onMount(ctx);
    } catch (err) {
      console.error(`[LazyRegistry] Error in onMount for "${moduleId}":`, err);
    }
  }

  // Suscribir a topics del manifest (con scope)
  if (module.manifest.mqtt?.subscribes && module.onMessage) {
    for (const topic of module.manifest.mqtt.subscribes) {
      const handler = module.onMessage[topic];
      if (handler) {
        // Los topics del manifest ya incluyen el scope completo
        const unsub = mqttSubscribe(topic, handler);
        loaded.subscriptions.push(unsub);
      }
    }
  }

  // Marcar como montado
  loadedStore.update(m => {
    const l = m.get(moduleId)!;
    l.mounted = true;
    return new Map(m);
  });

  console.log(`[LazyRegistry] Module "${moduleId}" mounted`);
  return true;
}

/**
 * Desmontar un módulo (limpiar subscripciones)
 */
export function unmountModule(moduleId: string): void {
  const loaded = get(loadedStore).get(moduleId);
  if (!loaded || !loaded.mounted) return;

  // Limpiar subscripciones
  for (const unsub of loaded.subscriptions) {
    unsub();
  }

  // Llamar onUnmount
  if (loaded.module?.onUnmount) {
    try {
      loaded.module.onUnmount();
    } catch (err) {
      console.error(`[LazyRegistry] Error in onUnmount for "${moduleId}":`, err);
    }
  }

  // Actualizar estado
  loadedStore.update(m => {
    const l = m.get(moduleId)!;
    l.subscriptions = [];
    l.mounted = false;
    return new Map(m);
  });

  console.log(`[LazyRegistry] Module "${moduleId}" unmounted`);
}

/**
 * Precargar módulos en background (opcional)
 */
export function preloadModules(moduleIds: string[]): void {
  // Cargar en background sin montar
  setTimeout(async () => {
    for (const id of moduleIds) {
      await loadModule(id);
    }
  }, 100);
}

// ============================================================================
// API PÚBLICA - PANELES
// ============================================================================

export function openPanel(panelId: string): void {
  activePanelStore.set(panelId);
}

export function closePanel(): void {
  activePanelStore.set(null);
}

export function setActiveModule(moduleId: string | null): void {
  activeModuleStore.set(moduleId);
}

export async function getPanelComponent(panelId: string) {
  const definitions = get(definitionsStore);

  // 1. Buscar en módulos del lazy-registry (work-bar modules)
  for (const [id, def] of definitions) {
    const loaded = get(loadedStore).get(id);

    // Intentar cargar el módulo si tiene el panel
    if (!loaded?.module) {
      const module = await loadModule(id);
      if (module) {
        const panel = module.manifest.panels?.find(p => p.id === panelId);
        if (panel) {
          return module.PanelComponent || null;
        }
      }
    } else {
      const panel = loaded.module.manifest.panels?.find(p => p.id === panelId);
      if (panel) {
        return loaded.module.PanelComponent || null;
      }
    }
  }

  // 2. Fallback: buscar en panels.ts (chat-config, system-bar, chat-tools)
  return loadPanelComponent(panelId);
}

export function getPanelConfig(panelId: string) {
  const loaded = get(loadedStore);

  // 1. Buscar en módulos cargados del lazy-registry
  for (const [, l] of loaded) {
    if (l.module) {
      const panel = l.module.manifest.panels?.find(p => p.id === panelId);
      if (panel) return panel;
    }
  }

  // 2. Fallback: buscar en panels.ts (chat-config, system-bar, chat-tools)
  const panelDef = getPanel(panelId);
  if (panelDef) {
    return { id: panelDef.id, title: panelDef.title, size: panelDef.size, position: panelDef.position };
  }

  return null;
}

// ============================================================================
// APP STATE
// ============================================================================

export function updateAppState(partial: Partial<AppState>): void {
  appStateStore.update(state => ({ ...state, ...partial }));
}

export function getAppState(): AppState {
  return get(appStateStore);
}

// ============================================================================
// STORES DERIVADOS
// ============================================================================

// Ruta actual — permite filtrar módulos por ruta
const currentRouteStore = writable<string>('/');

/**
 * Informa la ruta actual al registry.
 * Llamado desde LazyShell reactivamente con $page.url.pathname.
 * Auto-sets page context when modules match the route.
 */
export function setCurrentRoute(route: string): void {
  currentRouteStore.set(route);

  // Auto page context: find modules that match this route
  const defs = get(definitionsStore);

  // Guard: if no modules defined yet, skip — don't clear page context prematurely.
  // LazyShell will call again after defineModule() populates the store.
  if (defs.size === 0) {
    console.log('[LazyRegistry] setCurrentRoute: skipping (no definitions yet)', { route });
    return;
  }

  const matchingModules = [...defs.values()]
    .filter(d => d.routes && routeMatches(route, d.routes));

  console.log('[LazyRegistry] setCurrentRoute:', {
    route,
    totalDefs: defs.size,
    matchingModules: matchingModules.map(d => ({ id: d.id, routes: d.routes }))
  });

  if (matchingModules.length > 0) {
    // Extract project_id from route: /peppone/menu-generator → peppone
    const segments = route.split('/').filter(Boolean);
    const projectId = segments.length > 1 ? segments[0] : undefined;
    const workspaceRoute = segments.length > 1
      ? '/' + segments.slice(1).join('/')
      : route;

    const title = matchingModules[0].label || matchingModules[0].id;

    const ctx = {
      route: workspaceRoute,
      title,
      description: `Workspace: ${title}`,
      state: {
        projectId: projectId || '',
        moduleIds: matchingModules.map(d => d.id)
      }
    };
    console.log('[LazyRegistry] setPageContext:', ctx);
    setPageCtx(ctx);
  } else {
    console.log('[LazyRegistry] No matching modules — clearing page context');
    clearPageCtx();
  }
}

/**
 * Comprueba si la ruta actual matchea con alguna ruta declarada en el manifest.
 * Soporta rutas planas (/menu-generator) y project-scoped (/peppone/menu-generator).
 * Para project-scoped: strip del primer segmento (project_id) y compara.
 */
function routeMatches(currentRoute: string, manifestRoutes: string[]): boolean {
  // Ruta sin el prefijo de proyecto: /peppone/menu-generator → /menu-generator
  const segments = currentRoute.split('/');
  const withoutProject = segments.length > 2 ? '/' + segments.slice(2).join('/') : currentRoute;

  return manifestRoutes.some(r => currentRoute.startsWith(r) || withoutProject.startsWith(r));
}

function filterDefinitionsByZone(defs: Map<string, LazyModuleDefinition>, zone: UIZone, currentRoute?: string) {
  return [...defs.values()]
    .filter(d => d.zone === zone)
    .filter(d => !d.routes || !currentRoute || routeMatches(currentRoute, d.routes))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

// Work-bar filtra por ruta (cada ruta tiene su propia work-bar)
export const workBarDefinitions = derived(
  [definitionsStore, currentRouteStore],
  ([$d, $route]) => filterDefinitionsByZone($d, 'work-bar', $route)
);
// Resto de zonas: compartidas en todas las rutas
export const chatConfigDefinitions = derived(definitionsStore, $d => filterDefinitionsByZone($d, 'chat-config'));
export const chatToolsDefinitions = derived(definitionsStore, $d => filterDefinitionsByZone($d, 'chat-tools'));
export const systemBarDefinitions = derived(definitionsStore, $d => filterDefinitionsByZone($d, 'system-bar'));

// Estado de carga de módulos
export const moduleLoadState = derived(loadedStore, $l => {
  const states: Record<string, { loading: boolean; loaded: boolean; mounted: boolean; error: Error | null }> = {};
  for (const [id, l] of $l) {
    states[id] = {
      loading: l.loading,
      loaded: !!l.module,
      mounted: l.mounted,
      error: l.error
    };
  }
  return states;
});

// Módulos cargados (para compatibilidad)
export const loadedModules = derived(loadedStore, $l => {
  const modules: UIModule[] = [];
  for (const [, l] of $l) {
    if (l.module) modules.push(l.module);
  }
  return modules;
});

export const activePanel = {
  subscribe: activePanelStore.subscribe,
  set: activePanelStore.set
};

export const activeModule = {
  subscribe: activeModuleStore.subscribe,
  set: activeModuleStore.set
};

export const appState = { subscribe: appStateStore.subscribe };

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Obtener un módulo cargado
 */
export function getLoadedModule(moduleId: string): UIModule | null {
  return get(loadedStore).get(moduleId)?.module || null;
}

/**
 * Verificar si un módulo está cargado
 */
export function isModuleLoaded(moduleId: string): boolean {
  return !!get(loadedStore).get(moduleId)?.module;
}

/**
 * Verificar si un módulo está montado
 */
export function isModuleMounted(moduleId: string): boolean {
  return !!get(loadedStore).get(moduleId)?.mounted;
}
