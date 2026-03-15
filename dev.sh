#!/bin/bash
###############################################################################
# Event-Core - Development Helper
#
# Script principal para desarrollo con comandos útiles.
#
# Uso:
#   ./dev.sh                  # Muestra menú interactivo
#   ./dev.sh start            # Inicia servicios
#   ./dev.sh stop             # Detiene servicios
#   ./dev.sh restart          # Reinicia servicios
#   ./dev.sh status           # Estado de servicios
#   ./dev.sh logs [servicio]  # Ver logs
#   ./dev.sh plop [generator] # Ejecutar plop
#   ./dev.sh build            # Build del frontend
#   ./dev.sh test             # Ejecutar tests
#   ./dev.sh clean            # Limpiar logs y PIDs
###############################################################################

set -e

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Directorio del script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"

###############################################################################
# Funciones
###############################################################################

show_banner() {
    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║                                                           ║${NC}"
    echo -e "${CYAN}║   ${GREEN}███████╗██╗   ██╗███████╗███╗   ██╗████████╗${CYAN}           ║${NC}"
    echo -e "${CYAN}║   ${GREEN}██╔════╝██║   ██║██╔════╝████╗  ██║╚══██╔══╝${CYAN}           ║${NC}"
    echo -e "${CYAN}║   ${GREEN}█████╗  ██║   ██║█████╗  ██╔██╗ ██║   ██║${CYAN}              ║${NC}"
    echo -e "${CYAN}║   ${GREEN}██╔══╝  ╚██╗ ██╔╝██╔══╝  ██║╚██╗██║   ██║${CYAN}              ║${NC}"
    echo -e "${CYAN}║   ${GREEN}███████╗ ╚████╔╝ ███████╗██║ ╚████║   ██║${CYAN}              ║${NC}"
    echo -e "${CYAN}║   ${GREEN}╚══════╝  ╚═══╝  ╚══════╝╚═╝  ╚═══╝   ╚═╝${CYAN}   ${YELLOW}CORE${CYAN}      ║${NC}"
    echo -e "${CYAN}║                                                           ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

show_menu() {
    echo -e "${BLUE}Comandos disponibles:${NC}"
    echo ""
    echo -e "  ${GREEN}start${NC}     [backend|frontend]   Iniciar servicios"
    echo -e "  ${GREEN}stop${NC}      [backend|frontend]   Detener servicios"
    echo -e "  ${GREEN}restart${NC}   [backend|frontend]   Reiniciar servicios"
    echo -e "  ${GREEN}status${NC}                         Estado de servicios"
    echo -e "  ${GREEN}logs${NC}      [backend|frontend]   Ver logs en tiempo real"
    echo ""
    echo -e "  ${YELLOW}plop${NC}      [generator]          Generadores de código"
    echo -e "  ${YELLOW}build${NC}                          Build del frontend"
    echo -e "  ${YELLOW}test${NC}                           Ejecutar tests"
    echo ""
    echo -e "  ${CYAN}clean${NC}                          Limpiar logs y PIDs"
    echo -e "  ${CYAN}ports${NC}                          Ver puertos en uso"
    echo -e "  ${CYAN}help${NC}                           Esta ayuda"
    echo ""
}

show_logs() {
    local service="${1:-all}"

    case "$service" in
        backend)
            tail -f "$LOG_DIR/backend.log"
            ;;
        frontend)
            tail -f "$LOG_DIR/frontend.log"
            ;;
        all|"")
            # Mostrar ambos logs con prefijos
            tail -f "$LOG_DIR/backend.log" "$LOG_DIR/frontend.log" 2>/dev/null || {
                echo -e "${YELLOW}No hay logs disponibles. ¿Están los servicios iniciados?${NC}"
            }
            ;;
        *)
            echo -e "${RED}Servicio desconocido: $service${NC}"
            echo "Usa: logs [backend|frontend]"
            ;;
    esac
}

run_plop() {
    local generator="$1"

    if [ -z "$generator" ]; then
        echo -e "${BLUE}Generadores disponibles:${NC}"
        echo ""
        echo -e "  ${GREEN}module${NC}           Crear módulo Event-Core básico"
        echo -e "  ${GREEN}full-module${NC}      Crear módulo + UI Svelte"
        echo -e "  ${GREEN}from-blueprint${NC}   Generar desde blueprint YAML"
        echo -e "  ${GREEN}svelte-component${NC} Crear componente Svelte"
        echo -e "  ${GREEN}api${NC}              Agregar API a módulo"
        echo -e "  ${GREEN}event${NC}            Agregar evento a módulo"
        echo ""
        echo "Uso: ./dev.sh plop <generator>"
        echo ""

        # Preguntar si quiere ejecutar uno
        read -p "¿Ejecutar generador? (nombre o Enter para cancelar): " choice
        if [ -n "$choice" ]; then
            generator="$choice"
        else
            return 0
        fi
    fi

    cd "$SCRIPT_DIR"
    npx plop "$generator"
}

build_frontend() {
    echo -e "${BLUE}Building frontend...${NC}"
    cd "$SCRIPT_DIR/frontend"
    npm run build
    echo -e "${GREEN}Build completado${NC}"
}

run_tests() {
    echo -e "${BLUE}Ejecutando tests...${NC}"

    # Backend tests
    if [ -f "$SCRIPT_DIR/package.json" ] && grep -q '"test"' "$SCRIPT_DIR/package.json"; then
        echo -e "${CYAN}→ Tests del backend${NC}"
        cd "$SCRIPT_DIR"
        npm test || true
    fi

    # Frontend tests
    if [ -f "$SCRIPT_DIR/frontend/package.json" ]; then
        echo -e "${CYAN}→ Tests del frontend${NC}"
        cd "$SCRIPT_DIR/frontend"
        npm run test 2>/dev/null || npm run check || true
    fi
}

clean_all() {
    echo -e "${BLUE}Limpiando...${NC}"

    # Detener servicios primero
    "$SCRIPT_DIR/stop.sh" --force 2>/dev/null || true

    # Limpiar PIDs
    rm -rf "$SCRIPT_DIR/.pids"
    echo -e "  ${GREEN}✓${NC} PIDs eliminados"

    # Limpiar logs
    rm -rf "$LOG_DIR"
    echo -e "  ${GREEN}✓${NC} Logs eliminados"

    echo -e "${GREEN}Limpieza completada${NC}"
}

show_ports() {
    echo -e "${BLUE}Puertos en uso por Event-Core:${NC}"
    echo ""

    # Puertos comunes
    for port in 3000 3001 3002 5173 5174 5175 1883 9001; do
        local process=$(lsof -i :$port 2>/dev/null | tail -n1)
        if [ -n "$process" ]; then
            local name=$(echo "$process" | awk '{print $1}')
            local pid=$(echo "$process" | awk '{print $2}')
            echo -e "  ${GREEN}●${NC} :$port → $name (PID: $pid)"
        fi
    done

    echo ""
}

###############################################################################
# Main
###############################################################################

COMMAND="${1:-menu}"
shift 2>/dev/null || true

case "$COMMAND" in
    start)
        "$SCRIPT_DIR/start.sh" "$@"
        ;;
    stop)
        "$SCRIPT_DIR/stop.sh" "$@"
        ;;
    restart)
        "$SCRIPT_DIR/restart.sh" "$@"
        ;;
    status)
        "$SCRIPT_DIR/start.sh" status
        ;;
    logs)
        show_logs "$@"
        ;;
    plop)
        run_plop "$@"
        ;;
    build)
        build_frontend
        ;;
    test)
        run_tests
        ;;
    clean)
        clean_all
        ;;
    ports)
        show_ports
        ;;
    help|--help|-h)
        show_banner
        show_menu
        ;;
    menu|"")
        show_banner
        show_menu
        ;;
    *)
        echo -e "${RED}Comando desconocido: $COMMAND${NC}"
        show_menu
        exit 1
        ;;
esac
