#!/bin/bash
###############################################################################
# Event-Core - Deploy Script
#
# Actualiza el código, reconstruye el frontend y reinicia los servicios.
# Diseñado para ejecutarse cada vez que quieras desplegar cambios al VPS.
#
# Uso:
#   ./deploy.sh              # Deploy completo (pull + build + restart)
#   ./deploy.sh --no-pull    # Sin git pull (útil si ya hiciste pull manual)
#   ./deploy.sh --backend    # Solo reiniciar backend (sin rebuild frontend)
#   ./deploy.sh --help       # Ayuda
#
# Requisitos:
#   - Haber ejecutado ./setup-vps.sh previamente
###############################################################################

set -e

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# Opciones
DO_PULL=true
DO_FRONTEND=true
DO_BACKEND=true

for arg in "$@"; do
    case $arg in
        --no-pull)
            DO_PULL=false
            ;;
        --backend)
            DO_FRONTEND=false
            ;;
        --frontend)
            DO_BACKEND=false
            ;;
        --help|-h)
            cat << EOF
${BLUE}Event-Core - Deploy Script${NC}

${GREEN}Uso:${NC}
  ./deploy.sh                # Deploy completo
  ./deploy.sh --no-pull      # Sin git pull
  ./deploy.sh --backend      # Solo backend (sin rebuild frontend)
  ./deploy.sh --frontend     # Solo frontend (sin restart backend)

${GREEN}Qué hace:${NC}
  1. git pull origin (rama actual)
  2. npm install (backend + frontend)
  3. npm run build (frontend → SvelteKit)
  4. Copia build a /srv/event-core/frontend/build
  5. Reinicia servicios (systemd)

${GREEN}Requisitos:${NC}
  Haber ejecutado ./setup-vps.sh previamente

EOF
            exit 0
            ;;
        *)
            log_error "Argumento desconocido: $arg"
            exit 1
            ;;
    esac
done

###############################################################################
# Banner
###############################################################################
echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}              Event-Core - Deploy                          ${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

cd "$SCRIPT_DIR"
DEPLOY_START=$(date +%s)

###############################################################################
# PASO 1: Git pull
###############################################################################
if [ "$DO_PULL" = true ]; then
    log_info "[1/5] Actualizando código..."
    BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
    git pull origin "$BRANCH"
    log_success "Código actualizado (rama: $BRANCH)"
else
    log_info "[1/5] Saltando git pull (--no-pull)"
fi

###############################################################################
# PASO 2: Dependencias backend
###############################################################################
if [ "$DO_BACKEND" = true ]; then
    log_info "[2/5] Actualizando dependencias del backend..."
    npm install --production
    log_success "Dependencias del backend actualizadas"
else
    log_info "[2/5] Saltando dependencias backend"
fi

###############################################################################
# PASO 3: Build frontend
###############################################################################
if [ "$DO_FRONTEND" = true ] && [ -d "frontend" ]; then
    log_info "[3/5] Construyendo frontend..."
    cd frontend
    npm install
    npm run build
    cd "$SCRIPT_DIR"
    log_success "Frontend construido"

    log_info "[4/5] Copiando frontend a /srv/event-core..."
    sudo cp -r frontend/build /srv/event-core/frontend/
    log_success "Frontend desplegado"
else
    log_info "[3/5] Saltando build frontend"
    log_info "[4/5] Saltando copia frontend"
fi

###############################################################################
# PASO 4: Reiniciar servicios
###############################################################################
log_info "[5/5] Reiniciando servicios..."

if [ "$DO_BACKEND" = true ]; then
    sudo systemctl restart event-core
    sleep 2
    if systemctl is-active --quiet event-core; then
        log_success "event-core reiniciado"
    else
        log_error "event-core falló. Ver: journalctl -u event-core -n 20"
    fi
fi

if [ "$DO_FRONTEND" = true ]; then
    # Caddy sirve archivos estáticos, solo necesita reload si cambió el Caddyfile
    sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy
    sleep 1
    if systemctl is-active --quiet caddy; then
        log_success "Caddy recargado"
    else
        log_error "Caddy falló. Ver: journalctl -u caddy -n 20"
    fi
fi

###############################################################################
# Resumen
###############################################################################
DEPLOY_END=$(date +%s)
DEPLOY_TIME=$((DEPLOY_END - DEPLOY_START))

# Leer dominio
DOMAIN=""
if [ -f "$SCRIPT_DIR/.production" ]; then
    DOMAIN=$(grep "^DOMAIN=" "$SCRIPT_DIR/.production" | cut -d= -f2)
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}           Deploy completado en ${DEPLOY_TIME}s                       ${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""

if [ -n "$DOMAIN" ]; then
    echo -e "  ${BLUE}URL:${NC}  https://$DOMAIN"
fi

# Mostrar estado
echo ""
echo -e "  ${BLUE}event-core:${NC} $(systemctl is-active event-core 2>/dev/null || echo 'desconocido')"
echo -e "  ${BLUE}caddy:${NC}      $(systemctl is-active caddy 2>/dev/null || echo 'desconocido')"
echo ""
echo -e "  ${YELLOW}Commit:${NC} $(git log --oneline -1 2>/dev/null || echo 'N/A')"
echo ""
