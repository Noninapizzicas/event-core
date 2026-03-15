#!/bin/bash
###############################################################################
# Event-Core - Stop Script
#
# Detiene los servicios de Event-Core (backend y frontend).
#
# Uso:
#   ./stop.sh              # Detiene todo (desarrollo)
#   ./stop.sh backend      # Solo backend
#   ./stop.sh frontend     # Solo frontend
#   ./stop.sh production   # Detiene via systemd (backend + caddy) - VPS
#   ./stop.sh --force      # Forzar (SIGKILL)
###############################################################################

set -e

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Directorio del script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_DIR="$SCRIPT_DIR/.pids"

# Modo force
FORCE=false

###############################################################################
# Funciones
###############################################################################

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

stop_process() {
    local name=$1
    local pid_file="$PID_DIR/${name}.pid"
    local port_file="$PID_DIR/${name}.port"

    if [ ! -f "$pid_file" ]; then
        log_warn "$name: No hay PID registrado"
        return 0
    fi

    local pid=$(cat "$pid_file")

    if ! kill -0 $pid 2>/dev/null; then
        log_warn "$name: Proceso no encontrado (PID: $pid)"
        rm -f "$pid_file" "$port_file"
        return 0
    fi

    log_info "Deteniendo $name (PID: $pid)..."

    if [ "$FORCE" = true ]; then
        kill -9 $pid 2>/dev/null || true
    else
        # Intentar SIGTERM primero
        kill -15 $pid 2>/dev/null || true

        # Esperar hasta 5 segundos
        local count=0
        while kill -0 $pid 2>/dev/null && [ $count -lt 50 ]; do
            sleep 0.1
            count=$((count + 1))
        done

        # Si sigue vivo, SIGKILL
        if kill -0 $pid 2>/dev/null; then
            log_warn "$name no respondió a SIGTERM, usando SIGKILL..."
            kill -9 $pid 2>/dev/null || true
        fi
    fi

    rm -f "$pid_file" "$port_file"
    log_success "$name detenido"
}

stop_backend() {
    stop_process "backend"

    # También buscar procesos node huérfanos de Event-Core
    local orphans=$(pgrep -f "node.*index.js" 2>/dev/null || true)
    if [ -n "$orphans" ]; then
        log_warn "Encontrados procesos node huérfanos: $orphans"
        if [ "$FORCE" = true ]; then
            echo "$orphans" | xargs kill -9 2>/dev/null || true
            log_info "Procesos huérfanos eliminados"
        else
            log_info "Usa --force para eliminarlos"
        fi
    fi
}

stop_frontend() {
    stop_process "frontend"

    # Buscar procesos vite huérfanos
    local orphans=$(pgrep -f "vite.*--port" 2>/dev/null || true)
    if [ -n "$orphans" ]; then
        log_warn "Encontrados procesos vite huérfanos: $orphans"
        if [ "$FORCE" = true ]; then
            echo "$orphans" | xargs kill -9 2>/dev/null || true
            log_info "Procesos huérfanos eliminados"
        fi
    fi
}

stop_production() {
    log_info "Deteniendo servicios de producción (systemd)..."

    # Detener Caddy
    if systemctl is-active --quiet caddy 2>/dev/null; then
        sudo systemctl stop caddy
        log_success "Caddy detenido"
    else
        log_warn "Caddy no estaba corriendo"
    fi

    # Detener event-core
    if systemctl is-active --quiet event-core 2>/dev/null; then
        sudo systemctl stop event-core
        log_success "event-core detenido"
    else
        log_warn "event-core no estaba corriendo"
    fi
}

show_help() {
    cat << EOF
${BLUE}Event-Core - Script de Parada${NC}

${GREEN}Uso:${NC}
  ./stop.sh [comando] [opciones]

${GREEN}Comandos:${NC}
  (sin args)    Detiene backend + frontend (desarrollo)
  backend       Solo detiene el backend
  frontend      Solo detiene el frontend
  production    Detiene via systemd: event-core + caddy (VPS)
  --help, -h    Muestra esta ayuda

${GREEN}Opciones:${NC}
  --force, -f   Usar SIGKILL inmediatamente

${GREEN}Ejemplos:${NC}
  ./stop.sh                 # Detener todo (desarrollo)
  ./stop.sh production      # Detener todo (VPS/systemd)
  ./stop.sh --force         # Forzar parada
  ./stop.sh backend         # Solo backend

EOF
}

###############################################################################
# Main
###############################################################################

# Parsear argumentos
COMMAND="all"
for arg in "$@"; do
    case $arg in
        --force|-f)
            FORCE=true
            ;;
        --help|-h|help)
            show_help
            exit 0
            ;;
        backend|frontend|all|production|prod)
            COMMAND=$arg
            ;;
        *)
            log_error "Argumento desconocido: $arg"
            show_help
            exit 1
            ;;
    esac
done

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}              Event-Core - Deteniendo Servicios             ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

case "$COMMAND" in
    backend)
        stop_backend
        ;;
    frontend)
        stop_frontend
        ;;
    production|prod)
        stop_production
        ;;
    all)
        stop_frontend
        stop_backend
        ;;
esac

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}                    Servicios detenidos                     ${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
