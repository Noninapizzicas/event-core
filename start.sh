#!/bin/bash
###############################################################################
# Event-Core - Start Script
#
# Inicia el backend (Event-Core) y frontend (SvelteKit) con puertos dinámicos.
# Si un puerto está ocupado, busca el siguiente disponible.
#
# Uso:
#   ./start.sh              # Inicia todo (backend + frontend) - desarrollo
#   ./start.sh backend      # Solo backend
#   ./start.sh frontend     # Solo frontend
#   ./start.sh production   # Inicia via systemd (backend + caddy) - VPS
#   ./start.sh --help       # Ayuda
#
# Variables de entorno:
#   BACKEND_PORT=3000       # Puerto del backend (default: 3000)
#   FRONTEND_PORT=5173      # Puerto del frontend (default: 5173)
#   MQTT_PORT=1883          # Puerto MQTT TCP (default: 1883)
#   MQTT_WS_PORT=9001       # Puerto MQTT WebSocket (default: 9001)
###############################################################################

set -e

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Directorio del script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_DIR="$SCRIPT_DIR/.pids"
LOG_DIR="$SCRIPT_DIR/logs"

# Puertos por defecto
DEFAULT_BACKEND_PORT=3000
DEFAULT_FRONTEND_PORT=5173
DEFAULT_MQTT_PORT=1883
DEFAULT_MQTT_WS_PORT=9001

# Crear directorios necesarios
mkdir -p "$PID_DIR" "$LOG_DIR"

# Verificar que Node.js y npm estén instalados
check_dependencies() {
    if ! command -v node &> /dev/null; then
        log_error "Node.js no está instalado. Por favor instala Node.js >= 18"
        exit 1
    fi
    if ! command -v npm &> /dev/null; then
        log_error "npm no está instalado. Por favor instala npm"
        exit 1
    fi
    log_info "Node $(node -v) / npm $(npm -v)"
}

###############################################################################
# Funciones de utilidad
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

# Verificar si un puerto está disponible
is_port_available() {
    local port=$1
    ! (lsof -i :$port > /dev/null 2>&1 || netstat -tuln 2>/dev/null | grep -q ":$port ")
}

# Encontrar puerto disponible empezando desde el dado
find_available_port() {
    local start_port=$1
    local max_attempts=${2:-10}
    local port=$start_port

    for ((i=0; i<max_attempts; i++)); do
        if is_port_available $port; then
            echo $port
            return 0
        fi
        log_warn "Puerto $port ocupado, probando siguiente..." >&2
        port=$((port + 1))
    done

    log_error "No se encontró puerto disponible después de $max_attempts intentos" >&2
    return 1
}

# Obtener el proceso que usa un puerto
get_port_process() {
    local port=$1
    lsof -i :$port 2>/dev/null | tail -n1 | awk '{print $1 " (PID: " $2 ")"}'
}

show_help() {
    cat << EOF
${BLUE}Event-Core - Script de Inicio${NC}

${GREEN}Uso:${NC}
  ./start.sh [comando] [opciones]

${GREEN}Comandos:${NC}
  (sin args)    Inicia backend + frontend (desarrollo)
  backend       Solo inicia el backend (Event-Core)
  frontend      Solo inicia el frontend (SvelteKit)
  production    Inicia via systemd: event-core + caddy (VPS)
  status        Muestra el estado de los servicios
  --help, -h    Muestra esta ayuda

${GREEN}Variables de entorno:${NC}
  BACKEND_PORT    Puerto del backend (default: $DEFAULT_BACKEND_PORT)
  FRONTEND_PORT   Puerto del frontend (default: $DEFAULT_FRONTEND_PORT)
  MQTT_PORT       Puerto MQTT TCP (default: $DEFAULT_MQTT_PORT)
  MQTT_WS_PORT    Puerto MQTT WebSocket (default: $DEFAULT_MQTT_WS_PORT)

${GREEN}Ejemplos:${NC}
  ./start.sh                          # Desarrollo: todo con puertos por defecto
  ./start.sh production               # VPS: systemd + caddy (HTTPS)
  BACKEND_PORT=4000 ./start.sh        # Backend en puerto 4000
  ./start.sh frontend                 # Solo frontend

${GREEN}Archivos:${NC}
  .pids/                PIDs de procesos (desarrollo)
  logs/                 Logs de servicios (desarrollo)
  .production           Config de VPS (generado por setup-vps.sh)

EOF
}

###############################################################################
# Funciones de servicios
###############################################################################

start_backend() {
    log_info "Iniciando Backend (Event-Core)..."

    # Verificar dependencias del backend
    if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
        log_info "Instalando dependencias del backend..."
        cd "$SCRIPT_DIR"
        npm install
    fi

    # Determinar puerto
    local port=${BACKEND_PORT:-$DEFAULT_BACKEND_PORT}
    port=$(find_available_port $port) || exit 1

    # Verificar MQTT también
    local mqtt_port=${MQTT_PORT:-$DEFAULT_MQTT_PORT}
    if ! is_port_available $mqtt_port; then
        log_warn "Puerto MQTT $mqtt_port ocupado por: $(get_port_process $mqtt_port)"
        mqtt_port=$(find_available_port $mqtt_port) || exit 1
    fi

    # Actualizar config.json temporalmente si los puertos cambiaron
    if [ "$port" != "$DEFAULT_BACKEND_PORT" ] || [ "$mqtt_port" != "$DEFAULT_MQTT_PORT" ]; then
        log_info "Usando puertos alternativos: HTTP=$port, MQTT=$mqtt_port"
    fi

    # Exportar puertos para el proceso
    export PORT=$port
    export MQTT_PORT=$mqtt_port
    export NODE_ENV=${NODE_ENV:-development}

    # Iniciar backend
    cd "$SCRIPT_DIR"
    nohup node index.js > "$LOG_DIR/backend.log" 2>&1 &
    local pid=$!
    echo $pid > "$PID_DIR/backend.pid"
    echo $port > "$PID_DIR/backend.port"

    # Esperar a que inicie
    sleep 2
    if kill -0 $pid 2>/dev/null; then
        log_success "Backend iniciado en http://localhost:$port (PID: $pid)"
        echo -e "  ${BLUE}→${NC} Health check: curl http://localhost:$port/health"
        echo -e "  ${BLUE}→${NC} Logs: tail -f logs/backend.log"
    else
        log_error "Backend falló al iniciar. Ver logs/backend.log"
        return 1
    fi
}

start_frontend() {
    log_info "Iniciando Frontend (SvelteKit)..."

    # Verificar que existe el directorio frontend
    if [ ! -d "$SCRIPT_DIR/frontend" ]; then
        log_error "Directorio frontend/ no encontrado"
        return 1
    fi

    # Determinar puerto
    local port=${FRONTEND_PORT:-$DEFAULT_FRONTEND_PORT}
    port=$(find_available_port $port) || exit 1

    # Obtener puerto del backend (si está corriendo)
    local backend_port=$DEFAULT_BACKEND_PORT
    if [ -f "$PID_DIR/backend.port" ]; then
        backend_port=$(cat "$PID_DIR/backend.port")
    fi

    # Configurar variables de entorno para el frontend
    export PUBLIC_API_URL="http://localhost:$backend_port"
    export PUBLIC_MQTT_URL="ws://localhost:${MQTT_WS_PORT:-$DEFAULT_MQTT_WS_PORT}"

    # Iniciar frontend
    cd "$SCRIPT_DIR/frontend"

    # Verificar node_modules
    if [ ! -d "node_modules" ]; then
        log_info "Instalando dependencias del frontend..."
        npm install
    fi

    nohup npm run dev -- --port $port > "$LOG_DIR/frontend.log" 2>&1 &
    local pid=$!
    echo $pid > "$PID_DIR/frontend.pid"
    echo $port > "$PID_DIR/frontend.port"

    # Esperar a que inicie
    sleep 3
    if kill -0 $pid 2>/dev/null; then
        log_success "Frontend iniciado en http://localhost:$port (PID: $pid)"
        echo -e "  ${BLUE}→${NC} Notas: http://localhost:$port/notas"
        echo -e "  ${BLUE}→${NC} Logs: tail -f logs/frontend.log"
    else
        log_error "Frontend falló al iniciar. Ver logs/frontend.log"
        return 1
    fi

    cd "$SCRIPT_DIR"
}

start_production() {
    log_info "Iniciando servicios de producción (systemd)..."

    # Verificar que el setup se haya ejecutado
    if ! systemctl list-unit-files event-core.service &>/dev/null; then
        log_error "Servicio event-core.service no encontrado."
        log_info "Ejecuta primero: ./setup-vps.sh"
        return 1
    fi

    # Iniciar event-core
    sudo systemctl start event-core
    sleep 2
    if systemctl is-active --quiet event-core; then
        log_success "event-core activo"
    else
        log_error "event-core falló. Ver: journalctl -u event-core -n 20"
    fi

    # Iniciar Caddy
    sudo systemctl start caddy
    sleep 1
    if systemctl is-active --quiet caddy; then
        log_success "Caddy activo (HTTPS)"
    else
        log_error "Caddy falló. Ver: journalctl -u caddy -n 20"
    fi

    # Mostrar dominio si existe
    if [ -f "$SCRIPT_DIR/.production" ]; then
        local domain=$(grep "^DOMAIN=" "$SCRIPT_DIR/.production" | cut -d= -f2)
        if [ -n "$domain" ]; then
            echo ""
            echo -e "  ${GREEN}→${NC} https://$domain"
            echo -e "  ${GREEN}→${NC} https://$domain/health"
        fi
    fi
}

show_status() {
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}              Event-Core - Estado de Servicios              ${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo ""

    # Backend
    if [ -f "$PID_DIR/backend.pid" ]; then
        local pid=$(cat "$PID_DIR/backend.pid")
        local port=$(cat "$PID_DIR/backend.port" 2>/dev/null || echo "$DEFAULT_BACKEND_PORT")
        if kill -0 $pid 2>/dev/null; then
            echo -e "  ${GREEN}●${NC} Backend:  http://localhost:$port (PID: $pid)"
        else
            echo -e "  ${RED}●${NC} Backend:  No ejecutándose (PID inválido: $pid)"
        fi
    else
        echo -e "  ${YELLOW}●${NC} Backend:  No iniciado"
    fi

    # Frontend
    if [ -f "$PID_DIR/frontend.pid" ]; then
        local pid=$(cat "$PID_DIR/frontend.pid")
        local port=$(cat "$PID_DIR/frontend.port" 2>/dev/null || echo "$DEFAULT_FRONTEND_PORT")
        if kill -0 $pid 2>/dev/null; then
            echo -e "  ${GREEN}●${NC} Frontend: http://localhost:$port (PID: $pid)"
        else
            echo -e "  ${RED}●${NC} Frontend: No ejecutándose (PID inválido: $pid)"
        fi
    else
        echo -e "  ${YELLOW}●${NC} Frontend: No iniciado"
    fi

    # Servicios de producción (systemd)
    if systemctl list-unit-files event-core.service &>/dev/null 2>&1; then
        echo ""
        echo -e "  ${BLUE}── Producción (systemd) ──${NC}"
        local ec_status=$(systemctl is-active event-core 2>/dev/null || echo "no instalado")
        local caddy_status=$(systemctl is-active caddy 2>/dev/null || echo "no instalado")

        if [ "$ec_status" = "active" ]; then
            echo -e "  ${GREEN}●${NC} event-core: activo (systemd)"
        else
            echo -e "  ${YELLOW}●${NC} event-core: $ec_status"
        fi

        if [ "$caddy_status" = "active" ]; then
            echo -e "  ${GREEN}●${NC} caddy:      activo (HTTPS)"
        else
            echo -e "  ${YELLOW}●${NC} caddy:      $caddy_status"
        fi

        if [ -f "$SCRIPT_DIR/.production" ]; then
            local domain=$(grep "^DOMAIN=" "$SCRIPT_DIR/.production" | cut -d= -f2)
            if [ -n "$domain" ]; then
                echo -e "  ${BLUE}→${NC} https://$domain"
            fi
        fi
    fi

    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo ""
}

###############################################################################
# Main
###############################################################################

case "${1:-all}" in
    backend)
        check_dependencies
        start_backend
        ;;
    frontend)
        check_dependencies
        start_frontend
        ;;
    production|prod)
        echo ""
        echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
        echo -e "${BLUE}          Event-Core - Iniciando Producción (VPS)           ${NC}"
        echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
        echo ""
        start_production
        ;;
    status)
        show_status
        ;;
    --help|-h|help)
        show_help
        ;;
    all|"")
        echo ""
        echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
        echo -e "${BLUE}              Event-Core - Iniciando Servicios              ${NC}"
        echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
        echo ""
        check_dependencies
        echo ""
        start_backend
        echo ""
        start_frontend
        echo ""
        echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
        echo -e "${GREEN}                    ¡Servicios iniciados!                   ${NC}"
        echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
        show_status
        ;;
    *)
        log_error "Comando desconocido: $1"
        show_help
        exit 1
        ;;
esac
