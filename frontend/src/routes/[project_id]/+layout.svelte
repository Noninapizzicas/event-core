<script lang="ts">
  /**
   * Layout de Proyecto
   *
   * Sincroniza el project_id de la URL con los stores.
   * Pasa el contexto del proyecto a todos los hijos.
   * La URL es la fuente de verdad para el proyecto activo.
   */
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import { setContext } from 'svelte';
  import { writable, get } from 'svelte/store';
  import { mqttRequest, MqttNotConnectedError, MqttRequestError } from '$lib/ui-core/mqtt-request';
  import { connected } from '$lib/ui-core/mqtt';
  import { activeProjectId, activateProject } from '$lib/stores/projects';
  import { selectProject } from '$lib/stores/workspace';
  import { saveWorkspace } from '$lib/stores/persistence';

  // Store del proyecto actual
  const projectStore = writable<{
    id: string;
    name: string;
    isPizzepos: boolean;
    loading: boolean;
    error: string | null;
  }>({
    id: '',
    name: '',
    isPizzepos: false,
    loading: true,
    error: null
  });

  // Pasar contexto a hijos
  setContext('project', projectStore);

  // URL es la fuente de verdad
  $: urlParam = $page.params.project_id;
  $: project_id = urlParam;

  // Sincronizar URL → stores
  // 1. Guardar en localStorage para que initProjects lo recoja al conectar MQTT
  // 2. Si MQTT ya conectado, activar inmediatamente (navegación entre proyectos)
  let lastSyncedParam = '';
  $: if (urlParam && urlParam !== lastSyncedParam) {
    lastSyncedParam = urlParam;
    saveWorkspace({ projectId: urlParam });

    // Si MQTT conectado y el proyecto activo difiere, activar el de la URL
    if ($connected && urlParam !== $activeProjectId) {
      activateProject(urlParam).catch(err => {
        console.warn('[ProjectLayout] Activate from URL failed:', err);
      });
    }
    // Si MQTT no conectado, initProjects() lo recogerá de localStorage
  }

  let loaded = false;
  let lastLoadedParam = '';
  let unsubConnected: (() => void) | null = null;

  onMount(() => {
    // Marcar el param inicial como cargado
    lastLoadedParam = project_id;

    // Render immediately with defaults — don't block on MQTT
    projectStore.set({
      id: project_id,
      name: project_id,
      isPizzepos: false,
      loading: false,
      error: null
    });

    // Try to load real project data (non-blocking)
    loadProject();

    // If MQTT wasn't ready, retry when it connects
    unsubConnected = connected.subscribe((isConnected) => {
      if (isConnected && project_id) {
        if (!loaded) {
          loadProject();
        }
        // Activate project from URL if not already active
        if (project_id !== get(activeProjectId)) {
          activateProject(project_id).catch(err => {
            console.warn('[ProjectLayout] Activate on connect failed:', err);
          });
        }
      }
    });
  });

  onDestroy(() => {
    if (unsubConnected) unsubConnected();
  });

  // Recargar datos cuando cambia el proyecto en la URL (no en el mount inicial)
  $: if (urlParam && urlParam !== lastLoadedParam && lastLoadedParam !== '') {
    lastLoadedParam = urlParam;
    loaded = false;
    projectStore.set({
      id: urlParam,
      name: urlParam,
      isPizzepos: false,
      loading: false,
      error: null
    });
    loadProject();
  }

  async function loadProject() {
    if (!project_id) return;

    try {
      const res = await mqttRequest<any>('project', 'get', { id: project_id });
      const project = res.data?.project || res.data;
      const features: string[] = project?.metadata?.features || [];
      const isPizzepos = features.includes('pizzepos') || project?.metadata?.workspaceType === 'pizzepos';

      // Usar siempre el UUID real del proyecto para los stores
      const realId = project?.id || project_id;
      const slug = project?.slug;

      projectStore.set({
        id: realId,
        name: project?.name || project_id,
        isPizzepos,
        loading: false,
        error: null
      });

      // Sincronizar datos completos al workspace store (con UUID real)
      if (project) {
        selectProject({
          id: realId,
          name: project.name || project_id,
          color: project.color || 'blue',
          icon: project.icon || '',
          workspaceType: project.workspaceType || 'general'
        });
      }

      // Sincronizar activeProjectId con el UUID real
      saveWorkspace({ projectId: realId });

      // Normalizar URL: si la URL tiene UUID y tenemos slug, redirigir al slug
      if (slug && urlParam !== slug && isUUID(urlParam)) {
        const currentPath = $page.url.pathname;
        const newPath = currentPath.replace(`/${urlParam}`, `/${slug}`);
        goto(newPath, { replaceState: true });
      }

      loaded = true;

    } catch (err: any) {
      if (err instanceof MqttNotConnectedError) {
        console.log('[ProjectLayout] MQTT not ready yet, will retry when connected');
        return;
      }

      // Project not found or other backend error — use defaults, don't block
      if (err instanceof MqttRequestError) {
        console.log(`[ProjectLayout] Backend: ${err.message} — using defaults for "${project_id}"`);
      } else {
        console.warn('[ProjectLayout] Error loading project:', err.message);
      }

      loaded = true;
    }
  }

  function isUUID(str: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
  }
</script>

{#if $projectStore.loading}
  <div class="loading-screen">
    <div class="spinner"></div>
    <p>Cargando {project_id}...</p>
  </div>
{:else if $projectStore.error}
  <div class="error-screen">
    <h1>Error</h1>
    <p>{$projectStore.error}</p>
    <a href="/">Volver al inicio</a>
  </div>
{:else}
  <slot />
{/if}

<style>
  .loading-screen,
  .error-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    background: #0a0a0a;
    color: #e5e5e5;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid #333;
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .loading-screen p,
  .error-screen p {
    margin-top: 16px;
    color: #888;
  }

  .error-screen h1 {
    color: #ef4444;
    margin-bottom: 8px;
  }

  .error-screen a {
    margin-top: 20px;
    color: #3b82f6;
    text-decoration: none;
  }

  .error-screen a:hover {
    text-decoration: underline;
  }
</style>
