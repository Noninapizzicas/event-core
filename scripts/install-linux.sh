#!/bin/bash
# =============================================================================
# EVENT-CORE - Script de Instalacion para Linux
# =============================================================================
# Soporta: Debian/Ubuntu, Fedora/RHEL/CentOS, Arch Linux, Alpine
# Uso: curl -fsSL https://raw.githubusercontent.com/.../install-linux.sh | bash
#      o: bash install-linux.sh
# =============================================================================

set -e

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Funciones de utilidad
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Banner
echo -e "${CYAN}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║            EVENT-CORE - Instalador para Linux                ║"
echo "║                     Version 0.2.0                            ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# =============================================================================
# Detectar distribucion
# =============================================================================
detect_distro() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        DISTRO=$ID
        DISTRO_LIKE=$ID_LIKE
        VERSION=$VERSION_ID
    elif [ -f /etc/debian_version ]; then
        DISTRO="debian"
    elif [ -f /etc/redhat-release ]; then
        DISTRO="rhel"
    elif [ -f /etc/arch-release ]; then
        DISTRO="arch"
    elif [ -f /etc/alpine-release ]; then
        DISTRO="alpine"
    else
        DISTRO="unknown"
    fi

    log_info "Distribucion detectada: $DISTRO"
}

# =============================================================================
# Instalar dependencias segun distribucion
# =============================================================================
install_deps_debian() {
    log_info "Instalando dependencias para Debian/Ubuntu..."

    sudo apt-get update
    sudo apt-get install -y \
        curl \
        wget \
        git \
        build-essential \
        python3 \
        ca-certificates \
        gnupg

    # Instalar Node.js 20.x LTS via NodeSource
    if ! command -v node &> /dev/null || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 18 ]; then
        log_info "Instalando Node.js 20.x..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    fi

    # Dependencias opcionales para OCR/PDF
    log_info "Instalando dependencias para OCR/PDF..."
    sudo apt-get install -y \
        tesseract-ocr \
        tesseract-ocr-spa \
        poppler-utils \
        imagemagick || log_warn "Algunas dependencias opcionales fallaron"
}

install_deps_fedora() {
    log_info "Instalando dependencias para Fedora/RHEL/CentOS..."

    sudo dnf install -y \
        curl \
        wget \
        git \
        gcc-c++ \
        make \
        python3 \
        ca-certificates

    # Instalar Node.js
    if ! command -v node &> /dev/null || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 18 ]; then
        log_info "Instalando Node.js 20.x..."
        curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
        sudo dnf install -y nodejs
    fi

    # Dependencias opcionales
    sudo dnf install -y \
        tesseract \
        tesseract-langpack-spa \
        poppler-utils \
        ImageMagick || log_warn "Algunas dependencias opcionales fallaron"
}

install_deps_arch() {
    log_info "Instalando dependencias para Arch Linux..."

    sudo pacman -Syu --noconfirm
    sudo pacman -S --noconfirm \
        nodejs \
        npm \
        git \
        base-devel \
        python \
        curl \
        wget

    # Dependencias opcionales
    sudo pacman -S --noconfirm \
        tesseract \
        tesseract-data-spa \
        poppler \
        imagemagick || log_warn "Algunas dependencias opcionales fallaron"
}

install_deps_alpine() {
    log_info "Instalando dependencias para Alpine Linux..."

    sudo apk update
    sudo apk add \
        nodejs \
        npm \
        git \
        build-base \
        python3 \
        curl \
        wget

    # Dependencias opcionales
    sudo apk add \
        tesseract-ocr \
        tesseract-ocr-data-spa \
        poppler-utils \
        imagemagick || log_warn "Algunas dependencias opcionales fallaron"
}

# =============================================================================
# PASO 1: Detectar sistema
# =============================================================================
log_info "[1/6] Detectando sistema operativo..."
detect_distro

# =============================================================================
# PASO 2: Instalar dependencias
# =============================================================================
log_info "[2/6] Instalando dependencias del sistema..."

case $DISTRO in
    ubuntu|debian|linuxmint|pop)
        install_deps_debian
        ;;
    fedora|rhel|centos|rocky|almalinux)
        install_deps_fedora
        ;;
    arch|manjaro|endeavouros)
        install_deps_arch
        ;;
    alpine)
        install_deps_alpine
        ;;
    *)
        # Intentar detectar por ID_LIKE
        if [[ "$DISTRO_LIKE" == *"debian"* ]]; then
            install_deps_debian
        elif [[ "$DISTRO_LIKE" == *"fedora"* ]] || [[ "$DISTRO_LIKE" == *"rhel"* ]]; then
            install_deps_fedora
        elif [[ "$DISTRO_LIKE" == *"arch"* ]]; then
            install_deps_arch
        else
            log_error "Distribucion no soportada: $DISTRO"
            log_info "Instala manualmente: Node.js 18+, git, build-essential"
            exit 1
        fi
        ;;
esac

log_success "Dependencias del sistema instaladas"

# =============================================================================
# PASO 3: Verificar Node.js
# =============================================================================
log_info "[3/6] Verificando Node.js..."

NODE_VERSION=$(node -v 2>/dev/null || echo "none")
NPM_VERSION=$(npm -v 2>/dev/null || echo "none")

if [[ "$NODE_VERSION" == "none" ]]; then
    log_error "Node.js no esta instalado"
    exit 1
fi

NODE_MAJOR=$(echo $NODE_VERSION | cut -d'.' -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ]; then
    log_error "Se requiere Node.js >= 18. Version actual: $NODE_VERSION"
    exit 1
fi

log_success "Node.js $NODE_VERSION | npm $NPM_VERSION"

# =============================================================================
# PASO 4: Configurar repositorio
# =============================================================================
log_info "[4/6] Configurando repositorio..."

# Detectar directorio de trabajo
if [ -f "./package.json" ] && grep -q "event-core" ./package.json 2>/dev/null; then
    EVENT_CORE_DIR=$(pwd)
    log_info "Ejecutando desde el repositorio local"
elif [ -d "$HOME/event-core" ]; then
    EVENT_CORE_DIR="$HOME/event-core"
    log_info "Usando directorio existente: $EVENT_CORE_DIR"
else
    log_warn "Repositorio no encontrado."
    log_info "Por favor clona el repositorio primero:"
    echo ""
    echo "  git clone <url-del-repositorio> ~/event-core"
    echo "  cd ~/event-core"
    echo "  bash scripts/install-linux.sh"
    echo ""
    exit 1
fi

cd "$EVENT_CORE_DIR"
log_success "Directorio: $EVENT_CORE_DIR"

# =============================================================================
# PASO 5: Instalar dependencias Node.js
# =============================================================================
log_info "[5/6] Instalando dependencias de Node.js..."

npm install --production

log_success "Dependencias instaladas"

# =============================================================================
# PASO 6: Configurar entorno
# =============================================================================
log_info "[6/6] Configurando entorno..."

# Crear .env si no existe
if [ ! -f ".env" ]; then
    cp .env.example .env
    log_success "Archivo .env creado"
    log_warn "Edita .env para agregar tus credenciales"
else
    log_info "Archivo .env ya existe"
fi

# Crear directorios
mkdir -p data logs

# Permisos
chmod +x scripts/*.sh 2>/dev/null || true
chmod +x cli/index.js 2>/dev/null || true

# =============================================================================
# Crear servicio systemd (opcional)
# =============================================================================
create_systemd_service() {
    log_info "Creando servicio systemd..."

    SERVICE_FILE="/etc/systemd/system/event-core.service"

    sudo tee $SERVICE_FILE > /dev/null << EOF
[Unit]
Description=Event-Core Meta Framework
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$EVENT_CORE_DIR
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=event-core
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    log_success "Servicio systemd creado: event-core.service"
    echo ""
    echo "  Comandos del servicio:"
    echo "    sudo systemctl start event-core    # Iniciar"
    echo "    sudo systemctl stop event-core     # Detener"
    echo "    sudo systemctl enable event-core   # Auto-inicio"
    echo "    sudo systemctl status event-core   # Estado"
    echo "    journalctl -u event-core -f        # Ver logs"
}

# Preguntar si crear servicio systemd
echo ""
read -p "Crear servicio systemd para auto-inicio? (y/N): " CREATE_SERVICE
if [[ "$CREATE_SERVICE" =~ ^[Yy]$ ]]; then
    create_systemd_service
fi

# =============================================================================
# RESUMEN FINAL
# =============================================================================
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║            INSTALACION COMPLETADA EXITOSAMENTE               ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}Sistema:${NC} $DISTRO"
echo -e "${BLUE}Node.js:${NC} $NODE_VERSION"
echo -e "${BLUE}Directorio:${NC} $EVENT_CORE_DIR"
echo ""
echo -e "${YELLOW}Comandos disponibles:${NC}"
echo ""
echo "  # Iniciar servidor"
echo "  npm start"
echo ""
echo "  # Modo desarrollo"
echo "  npm run dev"
echo ""
echo "  # Ejecutar tests"
echo "  npm test"
echo ""
echo "  # CLI"
echo "  node cli/index.js health"
echo "  node cli/index.js modules"
echo ""
echo -e "${YELLOW}Configuracion:${NC}"
echo "  nano .env"
echo ""
echo -e "${YELLOW}Puertos:${NC}"
echo "  HTTP:      3000"
echo "  MQTT:      1883"
echo "  Frontend:  ${FRONTEND_PORT:-5173}"
echo ""
echo -e "${BLUE}Para iniciar ahora:${NC}"
echo "  cd $EVENT_CORE_DIR && npm start"
echo ""
