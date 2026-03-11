<script lang="ts">
  /**
   * Página Facturas (scoped a proyecto)
   *
   * URL: /[project_id]/facturas
   * Ej:  /noninapizzicas/facturas
   *
   * Page context is auto-set by lazy-registry's setCurrentRoute().
   * Workspace-specific instructions come from prompt-manager (workspace:facturas).
   * Panels update live state via updatePageState().
   */
  import { LazyShell } from '$lib/components/layout';
</script>

<LazyShell />
