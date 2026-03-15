#!/bin/bash
# ==============================================================
# Event-Core → Repo Limpio — Script de Migración
# Generado: 2026-03-15
# ==============================================================
# USO: ./migrate-to-clean-repo.sh /ruta/destino
# ==============================================================

set -euo pipefail

DEST="${1:?Uso: $0 /ruta/destino}"
SRC="$(cd "$(dirname "$0")" && pwd)"

if [ -d "$DEST" ] && [ "$(ls -A "$DEST" 2>/dev/null)" ]; then
  echo "ERROR: El directorio destino '$DEST' ya existe y no está vacío."
  exit 1
fi

echo "=== Migrando Event-Core limpio ==="
echo "  Origen:  $SRC"
echo "  Destino: $DEST"
echo ""

mkdir -p "$DEST"

# ──────────────────────────────────────────────
# 1. ARCHIVOS RAÍZ
# ──────────────────────────────────────────────
echo "[1/5] Copiando archivos raíz..."
for f in \
  package.json \
  package-lock.json \
  config.example.json \
  .env.example \
  .gitignore \
  .dockerignore \
  Dockerfile \
  start.sh \
  stop.sh \
  restart.sh \
  dev.sh \
  deploy.sh \
  setup-vps.sh \
  INSTALL.md \
; do
  if [ -f "$SRC/$f" ]; then
    cp "$SRC/$f" "$DEST/$f"
  fi
done

# Copiar config.json pero limpiar luego
if [ -f "$SRC/config.json" ]; then
  cp "$SRC/config.json" "$DEST/config.json"
fi

# ──────────────────────────────────────────────
# 2. DIRECTORIOS CORE Y AUXILIARES
# ──────────────────────────────────────────────
echo "[2/5] Copiando core y directorios auxiliares..."
for dir in core config cli services plugins prompts templates tests deployment network; do
  if [ -d "$SRC/$dir" ]; then
    cp -r "$SRC/$dir" "$DEST/$dir"
  fi
done

# Crear storage/ vacío
mkdir -p "$DEST/storage"

# ──────────────────────────────────────────────
# 3. MÓDULOS (solo los 32 incluidos)
# ──────────────────────────────────────────────
echo "[3/5] Copiando 32 módulos activos..."
mkdir -p "$DEST/modules"

MODULES=(
  ai-gateway
  ai-agent-framework
  prompt-manager
  prompt-composer
  chat-ai-bridge
  chat-session
  agent-manager
  bot-manager
  channel-manager
  database-manager
  project-manager
  credential-manager
  composition-manager
  context-manager
  telegram-service
  calling-generator
  certificate-authority
  security-p2p
  code-executor
  log-manager
  scheduler
  plugin-manager
  text-editor
  pdf-viewer
  filesystem
  system-inspector
  staff-manager
  pizzepos
  recetas
  escandallo
  viabilidad
  facturas
)

for mod in "${MODULES[@]}"; do
  if [ -d "$SRC/modules/$mod" ]; then
    cp -r "$SRC/modules/$mod" "$DEST/modules/$mod"
    echo "  + $mod"
  else
    echo "  ! ADVERTENCIA: $SRC/modules/$mod no encontrado"
  fi
done

# ──────────────────────────────────────────────
# 4. VERIFICACIÓN
# ──────────────────────────────────────────────
echo ""
echo "[4/5] Verificando..."

EXCLUDED=(conversation-manager metricas dashboard admin-panel scratch-designer ui-designer notas facturacion)
for mod in "${EXCLUDED[@]}"; do
  if [ -d "$DEST/modules/$mod" ]; then
    echo "  ! ERROR: $mod no debería estar en el destino"
    exit 1
  fi
done

# Verificar que no se copió contexto/
if [ -d "$DEST/contexto" ]; then
  echo "  ! ERROR: contexto/ no debería estar en el destino"
  exit 1
fi

MOD_COUNT=$(ls -d "$DEST/modules"/*/ 2>/dev/null | wc -l)
echo "  Módulos copiados: $MOD_COUNT (esperados: 32)"

# ──────────────────────────────────────────────
# 5. INICIALIZAR GIT
# ──────────────────────────────────────────────
echo "[5/5] Inicializando git..."
cd "$DEST"
git init
git add -A
git commit -m "Initial commit — event-core limpio (32 módulos activos)

Migrado desde event-core original.
Excluidos: conversation-manager, metricas, dashboard, admin-panel,
scratch-designer, ui-designer, notas, facturacion.
Excluido: directorio contexto/ completo.
Excluida: documentación suelta (*.md análisis, imágenes, archives)."

echo ""
echo "=== Migración completada ==="
echo "  Destino: $DEST"
echo "  Módulos: $MOD_COUNT"
echo "  Git: inicializado con commit inicial"
echo ""
echo "Próximos pasos:"
echo "  1. cd $DEST"
echo "  2. npm install"
echo "  3. Editar config.json (quitar refs a módulos excluidos)"
echo "  4. Escribir README.md nuevo"
echo "  5. npm start → verificar arranque"
echo "  6. Crear repo remoto y push"
