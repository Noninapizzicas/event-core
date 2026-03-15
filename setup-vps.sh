#!/bin/bash
###############################################################################
# Event-Core - Setup VPS con Caddy
#
# Script de configuración inicial para VPS. Ejecutar UNA sola vez.
# Instala Caddy, crea servicios systemd, configura el dominio.
#
# Uso:
#   ./setup-vps.sh                    # Setup interactivo
#   DOMAIN=midominio.com ./setup-vps.sh  # Setup con dominio
#
# Requisitos:
#   - VPS con Ubuntu/Debian (o similar)
#   - DNS del dominio apuntando a la IP del VPS
#   - Puertos 80 y 443 abiertos
#   - Node.js >= 18 instalado
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

###############################################################################
# Banner
###############################################################################
echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}         Event-Core - Setup VPS con Caddy (HTTPS)         ${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

###############################################################################
# Verificaciones previas
###############################################################################
if [ "$EUID" -eq 0 ]; then
    log_error "No ejecutes este script como root. Usa tu usuario normal."
    log_info "El script pedirá sudo cuando lo necesite."
    exit 1
fi

if ! command -v node &> /dev/null; then
    log_error "Node.js no está instalado. Ejecuta primero:"
    echo "  bash scripts/install-linux.sh"
    exit 1
fi

NODE_MAJOR=$(node -v | cut -d'.' -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ]; then
    log_error "Se requiere Node.js >= 18. Versión actual: $(node -v)"
    exit 1
fi

###############################################################################
# PASO 1: Configurar dominio
###############################################################################
log_info "[1/5] Configurando dominio..."

if [ -z "$DOMAIN" ]; then
    echo ""
    echo -e "  ${YELLOW}¿Cuál es tu dominio?${NC} (ej: miapp.com, core.miapp.com)"
    echo -e "  Debe tener un registro DNS A/AAAA apuntando a esta IP."
    echo ""
    read -p "  Dominio: " DOMAIN
    echo ""
fi

if [ -z "$DOMAIN" ]; then
    log_error "Dominio no puede estar vacío"
    exit 1
fi

log_success "Dominio: $DOMAIN"

# Verificar DNS (opcional, no bloquea)
SERVER_IP=$(curl -s -4 ifconfig.me 2>/dev/null || echo "desconocida")
DNS_IP=$(dig +short "$DOMAIN" 2>/dev/null | head -1 || echo "")

if [ -n "$DNS_IP" ] && [ "$DNS_IP" != "$SERVER_IP" ]; then
    log_warn "DNS de $DOMAIN ($DNS_IP) no coincide con IP del servidor ($SERVER_IP)"
    log_warn "Caddy no podrá obtener certificados hasta que el DNS esté configurado"
    echo ""
    read -p "  ¿Continuar de todas formas? (y/N): " CONTINUE
    if [[ ! "$CONTINUE" =~ ^[Yy]$ ]]; then
        exit 1
    fi
elif [ -n "$DNS_IP" ]; then
    log_success "DNS verificado: $DOMAIN → $DNS_IP"
fi

###############################################################################
# PASO 2: Instalar Caddy
###############################################################################
log_info "[2/5] Instalando Caddy..."

if command -v caddy &> /dev/null; then
    log_success "Caddy ya instalado: $(caddy version 2>/dev/null || echo 'version desconocida')"
else
    log_info "Instalando Caddy desde repositorio oficial..."

    # Detectar distro
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        DISTRO=$ID
    fi

    case "${DISTRO:-unknown}" in
        ubuntu|debian|linuxmint|pop)
            sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
            curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
            curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
            sudo apt-get update
            sudo apt-get install -y caddy
            ;;
        fedora|rhel|centos|rocky|almalinux)
            sudo dnf install -y 'dnf-command(copr)'
            sudo dnf copr enable -y @caddy/caddy
            sudo dnf install -y caddy
            ;;
        arch|manjaro)
            sudo pacman -S --noconfirm caddy
            ;;
        alpine)
            sudo apk add caddy
            ;;
        *)
            log_error "Distro no reconocida. Instala Caddy manualmente:"
            echo "  https://caddyserver.com/docs/install"
            exit 1
            ;;
    esac

    log_success "Caddy instalado: $(caddy version)"
fi

###############################################################################
# PASO 3: Instalar dependencias y build frontend
###############################################################################
log_info "[3/5] Instalando dependencias y construyendo frontend..."

cd "$SCRIPT_DIR"

# Backend
if [ ! -d "node_modules" ]; then
    log_info "Instalando dependencias del backend..."
    npm install --production
fi

# Frontend
if [ -d "frontend" ]; then
    cd frontend
    if [ ! -d "node_modules" ]; then
        log_info "Instalando dependencias del frontend..."
        npm install
    fi
    log_info "Construyendo frontend (SvelteKit)..."
    npm run build
    cd "$SCRIPT_DIR"

    # Copiar build a /srv/event-core/frontend/build
    sudo mkdir -p /srv/event-core/frontend
    sudo cp -r frontend/build /srv/event-core/frontend/
    sudo chown -R "$USER":"$USER" /srv/event-core
    log_success "Frontend construido y copiado a /srv/event-core/frontend/build"
else
    log_warn "Directorio frontend/ no encontrado, saltando build"
fi

###############################################################################
# PASO 4: Configurar servicios systemd
###############################################################################
log_info "[4/5] Configurando servicios systemd..."

# --- Servicio event-core ---
EVENT_CORE_SERVICE="/etc/systemd/system/event-core.service"
log_info "Creando servicio event-core..."

sudo tee "$EVENT_CORE_SERVICE" > /dev/null << EOF
[Unit]
Description=Event-Core Meta Framework
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$(which node) index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=event-core
Environment=NODE_ENV=production
Environment=EVENT_CORE_PORT=3000
Environment=EVENT_CORE_BROKER_PORT=1883
EnvironmentFile=-$SCRIPT_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

log_success "Servicio event-core.service creado"

# --- Configurar Caddy ---
log_info "Configurando Caddy con dominio $DOMAIN..."

# Crear directorio de logs
sudo mkdir -p /var/log/caddy

# Generar Caddyfile de producción con el dominio real
CADDY_CONFIG="/etc/caddy/Caddyfile"
sudo tee "$CADDY_CONFIG" > /dev/null << EOF
# Event Core - Generado por setup-vps.sh
# Dominio: $DOMAIN
# Caddy obtiene HTTPS automáticamente via Let's Encrypt

$DOMAIN {
	# Frontend - archivos estáticos del build de SvelteKit
	root * /srv/event-core/frontend/build
	file_server

	# API REST → event-core HTTP gateway
	handle /modules/* {
		reverse_proxy localhost:3000
	}

	handle /health {
		reverse_proxy localhost:3000
	}

	handle /api/* {
		reverse_proxy localhost:3000
	}

	# MQTT WebSocket → broker Aedes
	handle /mqtt {
		reverse_proxy localhost:9001
	}

	# SPA fallback: rutas que no matchean archivos → index.html
	try_files {path} /index.html

	# Logs
	log {
		output file /var/log/caddy/event-core.log
		format json
	}
}
EOF

log_success "Caddy configurado en $CADDY_CONFIG"

# --- Recargar systemd ---
sudo systemctl daemon-reload

# --- Habilitar servicios ---
sudo systemctl enable event-core
sudo systemctl enable caddy

log_success "Servicios habilitados (auto-inicio con el sistema)"

###############################################################################
# PASO 5: Guardar configuración del dominio
###############################################################################
log_info "[5/5] Guardando configuración..."

# Guardar dominio en .env si no existe
if [ -f "$SCRIPT_DIR/.env" ]; then
    if ! grep -q "^DOMAIN=" "$SCRIPT_DIR/.env" 2>/dev/null; then
        echo "" >> "$SCRIPT_DIR/.env"
        echo "# VPS Domain (configurado por setup-vps.sh)" >> "$SCRIPT_DIR/.env"
        echo "DOMAIN=$DOMAIN" >> "$SCRIPT_DIR/.env"
    else
        sed -i "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" "$SCRIPT_DIR/.env"
    fi
else
    cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
    echo "" >> "$SCRIPT_DIR/.env"
    echo "DOMAIN=$DOMAIN" >> "$SCRIPT_DIR/.env"
fi

# Guardar configuración de producción
cat > "$SCRIPT_DIR/.production" << EOF
# Generado por setup-vps.sh — $(date)
DOMAIN=$DOMAIN
INSTALL_DIR=$SCRIPT_DIR
SERVE_DIR=/srv/event-core
SERVER_IP=$SERVER_IP
EOF

log_success "Configuración guardada en .production"

###############################################################################
# Iniciar servicios
###############################################################################
echo ""
read -p "¿Iniciar servicios ahora? (Y/n): " START_NOW
if [[ ! "$START_NOW" =~ ^[Nn]$ ]]; then
    log_info "Iniciando event-core..."
    sudo systemctl start event-core
    sleep 2

    if systemctl is-active --quiet event-core; then
        log_success "event-core corriendo"
    else
        log_error "event-core falló. Ver: journalctl -u event-core -n 20"
    fi

    log_info "Iniciando Caddy..."
    sudo systemctl restart caddy
    sleep 2

    if systemctl is-active --quiet caddy; then
        log_success "Caddy corriendo"
    else
        log_error "Caddy falló. Ver: journalctl -u caddy -n 20"
    fi
fi

###############################################################################
# Resumen
###############################################################################
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}              Setup VPS completado                         ${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BLUE}Dominio:${NC}   https://$DOMAIN"
echo -e "  ${BLUE}API:${NC}       https://$DOMAIN/health"
echo -e "  ${BLUE}MQTT WS:${NC}   wss://$DOMAIN/mqtt"
echo ""
echo -e "  ${YELLOW}Gestión rápida:${NC}"
echo -e "    ./start.sh production      # Iniciar todo"
echo -e "    ./stop.sh production       # Parar todo"
echo -e "    ./restart.sh production    # Reiniciar todo"
echo -e "    ./deploy.sh                # Actualizar (pull + build + restart)"
echo ""
echo -e "  ${YELLOW}Servicios systemd:${NC}"
echo -e "    sudo systemctl status event-core"
echo -e "    sudo systemctl status caddy"
echo -e "    journalctl -u event-core -f"
echo -e "    journalctl -u caddy -f"
echo ""
echo -e "  ${YELLOW}Caddy (HTTPS):${NC}"
echo -e "    Los certificados Let's Encrypt se obtienen automáticamente."
echo -e "    Config: /etc/caddy/Caddyfile"
echo ""
