<script lang="ts">
  /**
   * Pagina Menu Generator (scoped a proyecto)
   *
   * URL: /[project_id]/menu-generator
   * Ej:  /peppone/menu-generator
   *
   * Page context is auto-set by lazy-registry's setCurrentRoute().
   * Workspace-specific instructions come from prompt-manager (workspace:menu-generator).
   * Panels update live state via updatePageState().
   */
  import { LazyShell } from '$lib/components/layout';
</script>

<LazyShell />
