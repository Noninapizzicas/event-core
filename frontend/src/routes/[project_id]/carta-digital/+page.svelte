<script lang="ts">
  /**
   * Pagina Carta Digital (scoped a proyecto)
   *
   * URL: /[project_id]/carta-digital
   * Ej:  /peppone/carta-digital
   *
   * Page context is auto-set by lazy-registry's setCurrentRoute().
   * Workspace-specific instructions come from prompt-manager (workspace:carta-digital).
   * Panels update live state via updatePageState().
   */
  import { LazyShell } from '$lib/components/layout';
</script>

<LazyShell />
