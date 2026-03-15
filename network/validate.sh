#!/bin/bash

# Network Deployment Validation Script
# Version: 0.5.0
# Description: Validates network configuration for multi-core deployment

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BROKER_HOST="${BROKER_HOST:-localhost}"
BROKER_PORT="${BROKER_PORT:-1883}"
BROKER_WS_PORT="${BROKER_WS_PORT:-9001}"
CORE_PORT="${CORE_PORT:-3000}"
TIMEOUT="${TIMEOUT:-5}"

echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Event Core Network Validation v0.5.0         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════╝${NC}"
echo ""

# Test counter
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Test function
run_test() {
    local test_name="$1"
    local test_command="$2"

    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    echo -ne "${YELLOW}[TEST $TOTAL_TESTS]${NC} $test_name... "

    if eval "$test_command" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ PASS${NC}"
        PASSED_TESTS=$((PASSED_TESTS + 1))
        return 0
    else
        echo -e "${RED}✗ FAIL${NC}"
        FAILED_TESTS=$((FAILED_TESTS + 1))
        return 1
    fi
}

# Required commands check
echo -e "${BLUE}[1/5] Checking Prerequisites...${NC}"
echo ""

run_test "Node.js installed" "command -v node"
run_test "Node.js version >= 18" "node -v | grep -E 'v(1[8-9]|[2-9][0-9])'"
run_test "npm installed" "command -v npm"
run_test "curl installed" "command -v curl"
run_test "nc (netcat) installed" "command -v nc"

echo ""

# Network connectivity check
echo -e "${BLUE}[2/5] Checking Network Connectivity...${NC}"
echo ""

run_test "Ping broker host ($BROKER_HOST)" "ping -c 1 -W $TIMEOUT $BROKER_HOST"

# Measure latency
if ping -c 5 -W $TIMEOUT "$BROKER_HOST" > /tmp/ping_result 2>&1; then
    AVG_LATENCY=$(grep "avg" /tmp/ping_result | awk -F'/' '{print $5}' | cut -d'.' -f1)
    if [ -n "$AVG_LATENCY" ]; then
        if [ "$AVG_LATENCY" -lt 50 ]; then
            echo -e "${GREEN}   Average latency: ${AVG_LATENCY}ms (excellent)${NC}"
        elif [ "$AVG_LATENCY" -lt 100 ]; then
            echo -e "${YELLOW}   Average latency: ${AVG_LATENCY}ms (acceptable)${NC}"
        else
            echo -e "${RED}   Average latency: ${AVG_LATENCY}ms (too high!)${NC}"
        fi
    fi
fi

run_test "TCP connection to broker:$BROKER_PORT" "timeout $TIMEOUT nc -zv $BROKER_HOST $BROKER_PORT 2>&1"
run_test "WebSocket connection to broker:$BROKER_WS_PORT (browsers)" "timeout $TIMEOUT nc -zv $BROKER_HOST $BROKER_WS_PORT 2>&1"

echo ""

# MQTT broker check
echo -e "${BLUE}[3/5] Checking MQTT Broker...${NC}"
echo ""

# Check if mosquitto clients are installed
if command -v mosquitto_pub > /dev/null 2>&1; then
    run_test "Publish test message" "timeout $TIMEOUT mosquitto_pub -h $BROKER_HOST -p $BROKER_PORT -t 'test/validation' -m 'ping' -q 0"

    # Try to subscribe (with timeout)
    if timeout 2 mosquitto_sub -h "$BROKER_HOST" -p "$BROKER_PORT" -t 'test/validation' -C 1 > /tmp/mqtt_test 2>&1; then
        run_test "Subscribe and receive message" "grep -q 'ping' /tmp/mqtt_test"
    else
        echo -e "${YELLOW}   ⚠ mosquitto_sub timeout (broker may be working but subscription slow)${NC}"
    fi

    rm -f /tmp/mqtt_test
else
    echo -e "${YELLOW}   ⚠ mosquitto_pub/sub not installed, skipping MQTT tests${NC}"
    echo -e "${YELLOW}   Install with: sudo apt install mosquitto-clients${NC}"
fi

echo ""

# Event Core check (if running locally)
echo -e "${BLUE}[4/5] Checking Local Event Core...${NC}"
echo ""

if timeout $TIMEOUT curl -f http://localhost:$CORE_PORT/health > /dev/null 2>&1; then
    run_test "Core health endpoint" "curl -f http://localhost:$CORE_PORT/health"
    run_test "Core API accessible" "curl -f http://localhost:$CORE_PORT/api/status"

    # Check if core is connected to broker
    if curl -s http://localhost:$CORE_PORT/api/status | grep -q '"isConnected":true'; then
        echo -e "${GREEN}   ✓ Core connected to MQTT broker${NC}"
    else
        echo -e "${RED}   ✗ Core not connected to broker${NC}"
    fi

    # Check discovery
    CORE_COUNT=$(curl -s http://localhost:$CORE_PORT/api/discovery/cores | grep -o '"total":[0-9]*' | cut -d':' -f2)
    if [ -n "$CORE_COUNT" ]; then
        echo -e "${GREEN}   ✓ Discovery working: $CORE_COUNT core(s) found${NC}"
    fi
else
    echo -e "${YELLOW}   ⚠ Local Event Core not running on port $CORE_PORT${NC}"
    echo -e "${YELLOW}   Start with: node index.js${NC}"
fi

echo ""

# Security check
echo -e "${BLUE}[5/5] Security Checks...${NC}"
echo ""

# Check if .env exists and has required vars
if [ -f ".env" ]; then
    run_test ".env file exists" "test -f .env"
    run_test "EVENT_CORE_ID defined" "grep -q 'EVENT_CORE_ID=' .env"
    run_test "EVENT_CORE_BROKER_URL defined" "grep -q 'EVENT_CORE_BROKER_URL=' .env"

    # Check for insecure settings
    if grep -q "allow_anonymous.*true" /etc/mosquitto/mosquitto.conf 2>/dev/null; then
        echo -e "${RED}   ✗ Broker allows anonymous connections (insecure!)${NC}"
        echo -e "${YELLOW}   For production: set 'allow_anonymous false' in mosquitto.conf${NC}"
    fi
else
    echo -e "${YELLOW}   ⚠ .env file not found (using defaults)${NC}"
fi

echo ""

# Summary
echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                   SUMMARY                      ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Total Tests:  $TOTAL_TESTS"
echo -e "${GREEN}Passed:       $PASSED_TESTS${NC}"
echo -e "${RED}Failed:       $FAILED_TESTS${NC}"
echo ""

if [ $FAILED_TESTS -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed! Network deployment is ready.${NC}"
    exit 0
else
    echo -e "${RED}✗ Some tests failed. Please fix the issues above.${NC}"
    echo ""
    echo "Common solutions:"
    echo "  - Ensure MQTT broker is running: sudo systemctl start mosquitto"
    echo "  - Check firewall: sudo ufw allow 1883/tcp && sudo ufw allow 9001/tcp"
    echo "  - Verify broker address: export BROKER_HOST=192.168.1.12"
    echo "  - Start Event Core: node index.js"
    echo "  - WebSocket port 9001 is required for browser connections"
    exit 1
fi
