#!/bin/bash
###############################################################################
# Event-Core - Instalador
#
# Instalación interactiva: detecta entorno, crea .env con puertos
# personalizados e instala las dependencias de backend y frontend.
#
# Uso:
#   ./install.sh              # Instalación interactiva
#   ./install.sh --defaults   # Instalación rápida con valores por defecto
#   ./install.sh --help       # Ayuda
###############################################################################

set -e

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Directorio del script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

###############################################################################
# Funciones de utilidad
###############################################################################

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# Preguntar un puerto con validación
ask_port() {
    local prompt="$1"
    local default="$2"
    local varname="$3"
    local value

    echo -ne "  ${CYAN}${prompt}${NC} [${BOLD}${default}${NC}]: "
    read -r value
    value="${value:-$default}"

    # Validar rango
    if ! [[ "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
        log_error "Puerto inválido: $value (debe ser 1-65535). Usando default: $default"
        value="$default"
    fi

    eval "$varname=$value"
}

# Preguntar un valor de texto
ask_value() {
    local prompt="$1"
    local default="$2"
    local varname="$3"
    local value

    echo -ne "  ${CYAN}${prompt}${NC} [${BOLD}${default}${NC}]: "
    read -r value
    value="${value:-$default}"

    eval "$varname=$value"
}

show_help() {
    cat << EOF
${BLUE}Event-Core - Instalador${NC}

${GREEN}Uso:${NC}
  ./install.sh              Instalación interactiva (pregunta puertos)
  ./install.sh --defaults   Instalación rápida con valores por defecto
  ./install.sh --help       Muestra esta ayuda

${GREEN}Qué hace:${NC}
  1. Detecta el entorno (Linux / Termux)
  2. Verifica dependencias (Node.js >= 18, npm)
  3. Crea el archivo .env con los puertos configurados
  4. Instala dependencias del backend (npm install)
  5. Instala dependencias del frontend (npm install)

${GREEN}Puertos por defecto:${NC}
  Backend API (HTTP):       3000
  MQTT Broker (TCP):        1883
  MQTT Broker (WebSocket):  9001
  Frontend (Vite dev):      5173

${GREEN}Después de instalar:${NC}
  ./start.sh          Inicia todo (backend + frontend)
  ./start.sh backend  Solo backend
  ./stop.sh           Detiene todo
  ./restart.sh        Reinicia todo

EOF
}

###############################################################################
# Detección de entorno
###############################################################################

detect_environment() {
    if [ -d "/data/data/com.termux" ]; then
        echo "termux"
    else
        echo "linux"
    fi
}

###############################################################################
# Verificar dependencias
###############################################################################

check_dependencies() {
    local errors=0

    echo ""
    log_info "Verificando dependencias del sistema..."

    # Node.js
    if command -v node &> /dev/null; then
        local node_version=$(node -v)
        local node_major=$(echo "$node_version" | sed 's/v//' | cut -d. -f1)
        if [ "$node_major" -ge 18 ]; then
            log_success "Node.js $node_version"
        else
            log_error "Node.js $node_version (se requiere >= 18)"
            errors=1
        fi
    else
        log_error "Node.js no instalado (se requiere >= 18)"
        errors=1
    fi

    # npm
    if command -v npm &> /dev/null; then
        log_success "npm $(npm -v)"
    else
        log_error "npm no instalado"
        errors=1
    fi

    # git (opcional)
    if command -v git &> /dev/null; then
        log_success "git $(git --version | awk '{print $3}')"
    else
        log_warn "git no instalado (opcional)"
    fi

    if [ "$errors" -eq 1 ]; then
        echo ""
        local env=$(detect_environment)
        if [ "$env" = "termux" ]; then
            log_error "Faltan dependencias. Instala con:"
            echo -e "  ${CYAN}pkg install nodejs-lts${NC}"
        else
            log_error "Faltan dependencias. Instala Node.js >= 18:"
            echo -e "  ${CYAN}https://nodejs.org/${NC}"
        fi
        exit 1
    fi
}

###############################################################################
# Configuración del .env
###############################################################################

configure_env() {
    local use_defaults="$1"

    # Valores por defecto
    local backend_port=3000
    local mqtt_port=1883
    local mqtt_ws_port=9001
    local frontend_port=5173
    local core_id="core-a"
    local environment="development"
    local log_level="info"

    if [ "$use_defaults" != "true" ]; then
        echo ""
        echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
        echo -e "${BLUE}              Configuración de Puertos                      ${NC}"
        echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
        echo ""
        echo -e "  Pulsa ${BOLD}Enter${NC} para aceptar el valor por defecto"
        echo ""

        echo -e "  ${BOLD}── Backend ──${NC}"
        ask_port "Puerto API (HTTP)" "3000" backend_port
        echo ""

        echo -e "  ${BOLD}── MQTT Broker ──${NC}"
        ask_port "Puerto MQTT (TCP)" "1883" mqtt_port
        ask_port "Puerto MQTT (WebSocket)" "9001" mqtt_ws_port
        echo ""

        echo -e "  ${BOLD}── Frontend ──${NC}"
        ask_port "Puerto Vite dev server" "5173" frontend_port
        echo ""

        echo -e "  ${BOLD}── General ──${NC}"
        ask_value "ID de esta instancia" "core-a" core_id
        ask_value "Entorno (development/production)" "development" environment
        ask_value "Nivel de log (debug/info/warn/error)" "info" log_level
    fi

    # Verificar si .env ya existe
    if [ -f "$SCRIPT_DIR/.env" ]; then
        echo ""
        log_warn "Ya existe un archivo .env"
        echo -ne "  ${CYAN}¿Sobreescribir? (s/N):${NC} "
        read -r overwrite
        if [[ ! "$overwrite" =~ ^[sS]$ ]]; then
            log_info "Manteniendo .env existente"
            return 0
        fi
        cp "$SCRIPT_DIR/.env" "$SCRIPT_DIR/.env.backup"
        log_info "Backup guardado en .env.backup"
    fi

    # Generar .env
    cat > "$SCRIPT_DIR/.env" << EOF
# Event Core - Configuración
# Generado por install.sh el $(date '+%Y-%m-%d %H:%M:%S')
# Editar y reiniciar con: ./restart.sh

# =============================================================================
# CORE
# =============================================================================
EVENT_CORE_ID=$core_id
EVENT_CORE_ENV=$environment

# =============================================================================
# PUERTOS
# =============================================================================

# Backend API
EVENT_CORE_PORT=$backend_port
EVENT_CORE_HTTP_HOST=0.0.0.0

# MQTT Broker (TCP)
EVENT_CORE_BROKER_PORT=$mqtt_port

# MQTT Broker (WebSocket - usado por el frontend)
EVENT_CORE_BROKER_WS_PORT=$mqtt_ws_port

# MQTT Broker host
EVENT_CORE_BROKER_HOST=0.0.0.0

# Frontend dev server
FRONTEND_PORT=$frontend_port

# =============================================================================
# OBSERVABILITY
# =============================================================================
EVENT_CORE_LOG_LEVEL=$log_level
EVENT_CORE_TRACING_ENABLED=true
EVENT_CORE_METRICS_ENABLED=true

# =============================================================================
# SECURITY
# =============================================================================
EVENT_CORE_ENCRYPTION_ENABLED=true

# =============================================================================
# SERVICIOS EXTERNOS (descomentar según necesites)
# =============================================================================
# DOMAIN=tudominio.com
# WEATHER_API_KEY=
# OPENAI_API_KEY=
# DATABASE_URL=
# REDIS_URL=
EOF

    log_success ".env creado correctamente"
}

###############################################################################
# Instalar dependencias npm
###############################################################################

install_dependencies() {
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}              Instalando Dependencias                      ${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo ""

    # Backend
    log_info "Instalando dependencias del backend..."
    cd "$SCRIPT_DIR"
    npm install
    log_success "Backend: dependencias instaladas"

    echo ""

    # Frontend
    if [ -d "$SCRIPT_DIR/frontend" ]; then
        log_info "Instalando dependencias del frontend..."
        cd "$SCRIPT_DIR/frontend"
        npm install
        log_success "Frontend: dependencias instaladas"
        cd "$SCRIPT_DIR"
    else
        log_warn "Directorio frontend/ no encontrado, saltando"
    fi
}

###############################################################################
# Resumen final
###############################################################################

show_summary() {
    source "$SCRIPT_DIR/.env"

    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}              ¡Instalación completada!                     ${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${BOLD}Puertos configurados:${NC}"
    echo -e "    Backend API:        ${CYAN}http://localhost:${EVENT_CORE_PORT}${NC}"
    echo -e "    MQTT TCP:           ${CYAN}localhost:${EVENT_CORE_BROKER_PORT}${NC}"
    echo -e "    MQTT WebSocket:     ${CYAN}ws://localhost:${EVENT_CORE_BROKER_WS_PORT}${NC}"
    echo -e "    Frontend:           ${CYAN}http://localhost:${FRONTEND_PORT}${NC}"
    echo ""
    echo -e "  ${BOLD}Archivos:${NC}"
    echo -e "    Config:   ${CYAN}.env${NC} (editar puertos aquí)"
    echo -e "    Ejemplo:  ${CYAN}.env.example${NC} (referencia completa)"
    echo ""
    echo -e "  ${BOLD}Comandos:${NC}"
    echo -e "    ${GREEN}./start.sh${NC}        Iniciar todo"
    echo -e "    ${GREEN}./stop.sh${NC}         Detener todo"
    echo -e "    ${GREEN}./restart.sh${NC}      Reiniciar todo"
    echo ""
    echo -e "  ${BOLD}Para empezar ahora:${NC}"
    echo -e "    ${CYAN}./start.sh${NC}"
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    echo ""
}

###############################################################################
# Main
###############################################################################

case "${1:-}" in
    --help|-h|help)
        show_help
        exit 0
        ;;
    --defaults|-d)
        echo ""
        echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
        echo -e "${BLUE}        Event-Core - Instalación Rápida (defaults)         ${NC}"
        echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

        local_env=$(detect_environment)
        log_info "Entorno detectado: $local_env"

        check_dependencies
        configure_env "true"
        install_dependencies
        show_summary
        ;;
    "")
        echo ""
        echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
        echo -e "${BLUE}            Event-Core - Instalación Interactiva           ${NC}"
        echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

        local_env=$(detect_environment)
        log_info "Entorno detectado: $local_env"

        check_dependencies
        configure_env "false"
        install_dependencies
        show_summary
        ;;
    *)
        log_error "Opción desconocida: $1"
        show_help
        exit 1
        ;;
esac
