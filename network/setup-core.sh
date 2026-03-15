#!/bin/bash

# Event Core Setup Script
# Version: 0.5.0
# Description: Quick setup script for deploying a new core on a machine

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Event Core Setup Wizard v0.5.0                ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════╝${NC}"
echo ""

# Interactive mode or environment variables
INTERACTIVE="${INTERACTIVE:-true}"

# Function to prompt for input
prompt() {
    local var_name="$1"
    local prompt_text="$2"
    local default_value="$3"
    local current_value="${!var_name}"

    if [ "$INTERACTIVE" = "true" ] && [ -z "$current_value" ]; then
        if [ -n "$default_value" ]; then
            read -p "$prompt_text [$default_value]: " input
            eval "$var_name=\"${input:-$default_value}\""
        else
            read -p "$prompt_text: " input
            eval "$var_name=\"$input\""
        fi
    elif [ -z "$current_value" ]; then
        eval "$var_name=\"$default_value\""
    fi
}

echo -e "${BLUE}[1/6] Core Configuration${NC}"
echo ""

# Generate default core ID
DEFAULT_CORE_ID="core-$(hostname)-$(date +%s)"

prompt CORE_ID "Enter Core ID" "$DEFAULT_CORE_ID"
prompt CORE_PORT "Enter HTTP API Port" "3000"

echo ""
echo -e "${BLUE}[2/6] MQTT Broker Configuration${NC}"
echo ""

prompt BROKER_URL "Enter MQTT Broker URL (e.g., mqtt://192.168.1.12:1883)" "mqtt://localhost:1883"
prompt BROKER_PORT "Enter Embedded Broker TCP Port (fallback)" "1883"
prompt BROKER_WS_PORT "Enter Embedded Broker WebSocket Port (for browsers)" "9001"

echo ""
echo -e "${BLUE}[3/6] Logging Configuration${NC}"
echo ""

prompt LOG_LEVEL "Enter Log Level (debug/info/warn/error)" "info"

echo ""
echo -e "${BLUE}[4/6] Module Selection${NC}"
echo ""

prompt ENABLE_SECURITY "Enable security-p2p module? (yes/no)" "yes"
prompt ENABLE_FILE_WATCHER "Enable file-watcher module? (yes/no)" "no"

echo ""
echo -e "${BLUE}[5/6] Generating Configuration${NC}"
echo ""

# Create .env file
ENV_FILE=".env"
ENV_BACKUP=".env.backup-$(date +%s)"

if [ -f "$ENV_FILE" ]; then
    echo -e "${YELLOW}⚠ .env file already exists${NC}"
    if [ "$INTERACTIVE" = "true" ]; then
        read -p "Backup and overwrite? (yes/no): " overwrite
        if [ "$overwrite" != "yes" ]; then
            echo "Setup cancelled."
            exit 0
        fi
    fi
    mv "$ENV_FILE" "$ENV_BACKUP"
    echo -e "${GREEN}✓ Backed up to $ENV_BACKUP${NC}"
fi

# Write configuration
cat > "$ENV_FILE" << EOF
# Event Core Configuration
# Generated: $(date)
# Machine: $(hostname)

# Core Identity
EVENT_CORE_ID=$CORE_ID
EVENT_CORE_PORT=$CORE_PORT

# MQTT Broker
EVENT_CORE_BROKER_URL=$BROKER_URL
EVENT_CORE_BROKER_PORT=$BROKER_PORT
EVENT_CORE_BROKER_WS_PORT=$BROKER_WS_PORT
EVENT_CORE_BROKER_TIMEOUT=5000

# Logging
LOG_LEVEL=$LOG_LEVEL

# Modules
EOF

# Add module-specific config
if [ "$ENABLE_SECURITY" = "yes" ]; then
    echo "ENABLE_SECURITY_P2P=true" >> "$ENV_FILE"
else
    echo "ENABLE_SECURITY_P2P=false" >> "$ENV_FILE"
fi

if [ "$ENABLE_FILE_WATCHER" = "yes" ]; then
    echo "ENABLE_FILE_WATCHER=true" >> "$ENV_FILE"
else
    echo "ENABLE_FILE_WATCHER=false" >> "$ENV_FILE"
fi

echo ""
echo -e "${GREEN}✓ Configuration saved to $ENV_FILE${NC}"

echo ""
echo -e "${BLUE}[6/6] Validation${NC}"
echo ""

# Verify Node.js
if ! command -v node > /dev/null 2>&1; then
    echo -e "${RED}✗ Node.js not installed${NC}"
    echo "  Install: https://nodejs.org/"
    exit 1
fi
echo -e "${GREEN}✓ Node.js installed: $(node -v)${NC}"

# Verify npm packages
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}⚠ Dependencies not installed${NC}"
    if [ "$INTERACTIVE" = "true" ]; then
        read -p "Install now? (yes/no): " install
        if [ "$install" = "yes" ]; then
            npm install
            echo -e "${GREEN}✓ Dependencies installed${NC}"
        else
            echo -e "${YELLOW}⚠ Run 'npm install' before starting core${NC}"
        fi
    else
        echo "  Run: npm install"
    fi
else
    echo -e "${GREEN}✓ Dependencies installed${NC}"
fi

# Test broker connectivity
echo ""
echo -n "Testing broker connectivity... "
BROKER_HOST=$(echo "$BROKER_URL" | sed -E 's|mqtt://([^:]+):.*|\1|')
BROKER_PORT_NUM=$(echo "$BROKER_URL" | sed -E 's|mqtt://[^:]+:([0-9]+).*|\1|')

if timeout 3 nc -zv "$BROKER_HOST" "$BROKER_PORT_NUM" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Broker reachable${NC}"
else
    echo -e "${YELLOW}⚠ Broker unreachable (will use embedded broker)${NC}"
fi

echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                SETUP COMPLETE                  ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════╝${NC}"
echo ""

echo "Configuration Summary:"
echo "  Core ID:       $CORE_ID"
echo "  HTTP Port:     $CORE_PORT"
echo "  MQTT Broker:   $BROKER_URL"
echo "  MQTT WS Port:  $BROKER_WS_PORT (for browsers)"
echo "  Log Level:     $LOG_LEVEL"
echo ""

echo "Next Steps:"
echo ""
echo -e "  ${GREEN}1.${NC} Start the core:"
echo "     node index.js"
echo ""
echo -e "  ${GREEN}2.${NC} Verify it's running:"
echo "     curl http://localhost:$CORE_PORT/health"
echo ""
echo -e "  ${GREEN}3.${NC} Check discovered cores:"
echo "     curl http://localhost:$CORE_PORT/api/discovery/cores"
echo ""
echo -e "  ${GREEN}4.${NC} View logs:"
echo "     curl http://localhost:$CORE_PORT/api/logs"
echo ""

if [ "$ENABLE_SECURITY" = "yes" ]; then
    echo -e "  ${GREEN}5.${NC} Get public key for P2P trust:"
    echo "     curl http://localhost:$CORE_PORT/modules/security-p2p/public-key"
    echo ""
fi

echo "For production deployment, see:"
echo "  docs/NETWORK_DEPLOYMENT.md"
echo ""

# Offer to start core
if [ "$INTERACTIVE" = "true" ]; then
    read -p "Start Event Core now? (yes/no): " start_now
    if [ "$start_now" = "yes" ]; then
        echo ""
        echo -e "${BLUE}Starting Event Core...${NC}"
        echo ""
        node index.js
    fi
fi
