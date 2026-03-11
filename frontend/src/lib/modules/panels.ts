/**
 * Panel Loaders - Metadata + carga lazy de paneles
 *
 * Solo metadata aquí. Los componentes se importan bajo demanda.
 */

import type { ComponentType } from 'svelte';

export interface PanelDef {
  id: string;
  title: string;
  icon: string;
  size: 'sm' | 'md' | 'lg';
  position?: 'top' | 'bottom' | 'left' | 'right' | 'center';
  zone: 'work-bar' | 'chat-config' | 'chat-tools' | 'system-bar';
  order: number;
  // Si false, no muestra botón en la barra (solo accesible via openPanel)
  showInBar?: boolean;
  // Loader - importa el componente bajo demanda
  loader: () => Promise<{ default: ComponentType }>;
}

// Cache de componentes ya cargados
const componentCache = new Map<string, ComponentType>();

/**
 * Definiciones de paneles - SIN importar componentes
 */
export const panels: Record<string, PanelDef> = {
  // === CHAT CONFIG (barra de configuración) ===
  project: {
    id: 'project',
    title: 'Proyecto',
    icon: '📁',
    size: 'md',
    position: 'top',
    zone: 'chat-config',
    order: 0,
    loader: () => import('$lib/modules/project/ProjectPanel.svelte')
  },
  provider: {
    id: 'provider',
    title: 'Proveedor IA',
    icon: '🤖',
    size: 'sm',
    position: 'top',
    zone: 'chat-config',
    order: 1,
    loader: () => import('$lib/modules/provider/ProviderPanel.svelte')
  },
  prompts: {
    id: 'prompts',
    title: 'Prompts',
    icon: '🧘',
    size: 'lg',
    position: 'top',
    zone: 'chat-config',
    order: 2,
    loader: () => import('$lib/modules/prompts/PromptsPanel.svelte')
  },
  conversations: {
    id: 'conversations',
    title: 'Conversaciones',
    icon: '💬',
    size: 'lg',
    position: 'top',
    zone: 'chat-config',
    order: 3,
    loader: () => import('$lib/modules/conversations/ConversationsPanel.svelte')
  },
  'credentials-list': {
    id: 'credentials-list',
    title: 'Credenciales',
    icon: '🔐',
    size: 'lg',
    position: 'top',
    zone: 'chat-config',
    order: 4,
    loader: () => import('$lib/modules/credentials/CredentialsPanel.svelte')
  },

  // === WORK BAR (barra de trabajo — micro-módulos menú) ===
  'menu-pdf2img-panel': {
    id: 'menu-pdf2img-panel',
    title: 'PDF a Imagen',
    icon: '📄',
    size: 'sm',
    position: 'top',
    zone: 'work-bar',
    order: 1,
    loader: () => import('$lib/modules/menu-pdf2img/Pdf2ImgPanel.svelte')
  },
  'menu-prepare-panel': {
    id: 'menu-prepare-panel',
    title: 'Preparar Imagen para OCR',
    icon: '🖼️',
    size: 'sm',
    position: 'top',
    zone: 'work-bar',
    order: 2,
    loader: () => import('$lib/modules/menu-prepare/PreparePanel.svelte')
  },
  'menu-ocr-panel': {
    id: 'menu-ocr-panel',
    title: 'Extraer Texto (OCR)',
    icon: '🔍',
    size: 'md',
    position: 'top',
    zone: 'work-bar',
    order: 3,
    loader: () => import('$lib/modules/menu-ocr/OcrPanel.svelte')
  },
  'menu-generate-panel': {
    id: 'menu-generate-panel',
    title: 'Generar Carta',
    icon: '✨',
    size: 'md',
    position: 'top',
    zone: 'work-bar',
    order: 4,
    loader: () => import('$lib/modules/menu-generate/GeneratePanel.svelte')
  },
  'menu-cartas-panel': {
    id: 'menu-cartas-panel',
    title: 'Cartas Generadas',
    icon: '📋',
    size: 'lg',
    position: 'top',
    zone: 'work-bar',
    order: 5,
    loader: () => import('$lib/modules/menu-cartas/CartasPanel.svelte')
  },

  // === WORK BAR — Carta Digital ===
  'carta-config-panel': {
    id: 'carta-config-panel',
    title: 'Configuración de Carta Digital',
    icon: '⚙️',
    size: 'md',
    position: 'top',
    zone: 'work-bar',
    order: 1,
    loader: () => import('$lib/modules/carta-config/CartaConfigPanel.svelte')
  },
  'carta-preview-panel': {
    id: 'carta-preview-panel',
    title: 'Vista Previa de la Carta',
    icon: '👁️',
    size: 'lg',
    position: 'top',
    zone: 'work-bar',
    order: 2,
    loader: () => import('$lib/modules/carta-preview/CartaPreviewPanel.svelte')
  },
  'carta-export-panel': {
    id: 'carta-export-panel',
    title: 'Exportar Carta Digital',
    icon: '📤',
    size: 'md',
    position: 'top',
    zone: 'work-bar',
    order: 3,
    loader: () => import('$lib/modules/carta-export/CartaExportPanel.svelte')
  },
  'carta-stats-panel': {
    id: 'carta-stats-panel',
    title: 'Estadísticas de Carta Digital',
    icon: '📊',
    size: 'md',
    position: 'top',
    zone: 'work-bar',
    order: 4,
    loader: () => import('$lib/modules/carta-stats/CartaStatsPanel.svelte')
  },

  // === WORK BAR — Facturas ===
  'facturas-panel': {
    id: 'facturas-panel',
    title: 'Facturas',
    icon: '🧾',
    size: 'lg',
    position: 'top',
    zone: 'work-bar',
    order: 9,
    loader: () => import('$lib/modules/facturas/FacturasPanel.svelte')
  },

  // === WORK BAR — Impresion (comandas de cocina) ===
  'impresion-panel': {
    id: 'impresion-panel',
    title: 'Impresora',
    icon: '🖨️',
    size: 'md',
    position: 'top',
    zone: 'work-bar',
    order: 10,
    loader: () => import('$lib/modules/impresion/ImpresionPanel.svelte')
  },

  // === CHAT TOOLS (barra inferior junto al chat) ===
  files: {
    id: 'files',
    title: 'Archivos',
    icon: '🗂️',
    size: 'lg',
    position: 'left',
    zone: 'chat-tools',
    order: 1,
    loader: () => import('$lib/modules/files/FilesPanel.svelte')
  },

  // === PANELES PROGRAMÁTICOS (showInBar: false — solo vía openPanel()) ===
  'html-preview': {
    id: 'html-preview',
    title: 'Vista previa',
    icon: '📄',
    size: 'lg',
    position: 'top',
    zone: 'work-bar',
    order: 99,
    showInBar: false,
    loader: () => import('$lib/modules/html-preview/HtmlPreviewPanel.svelte')
  }
};

/**
 * Obtener paneles por zona (solo los que muestran botón)
 */
export function getPanelsByZone(zone: PanelDef['zone']): PanelDef[] {
  return Object.values(panels)
    .filter(p => p.zone === zone && p.showInBar !== false)
    .sort((a, b) => a.order - b.order);
}

/**
 * Cargar componente de un panel (con cache)
 */
export async function loadPanelComponent(panelId: string): Promise<ComponentType | null> {
  // Revisar cache
  if (componentCache.has(panelId)) {
    return componentCache.get(panelId)!;
  }

  const panel = panels[panelId];
  if (!panel) {
    console.error(`[Panels] Panel "${panelId}" not found`);
    return null;
  }

  try {
    console.log(`[Panels] Loading "${panelId}"...`);
    const start = performance.now();

    const module = await panel.loader();
    const Component = module.default;

    // Guardar en cache
    componentCache.set(panelId, Component);

    console.log(`[Panels] "${panelId}" loaded in ${(performance.now() - start).toFixed(1)}ms`);
    return Component;
  } catch (err) {
    console.error(`[Panels] Failed to load "${panelId}":`, err);
    return null;
  }
}

/**
 * Obtener definición de panel
 */
export function getPanel(panelId: string): PanelDef | undefined {
  return panels[panelId];
}

/**
 * Verificar si un panel está en cache
 */
export function isPanelLoaded(panelId: string): boolean {
  return componentCache.has(panelId);
}
