#!/bin/bash

# Network Latency Testing Script
# Version: 0.5.0
# Description: Measures event propagation latency between cores

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SOURCE_CORE="${SOURCE_CORE:-http://localhost:3000}"
TARGET_CORE="${TARGET_CORE:-http://localhost:3001}"
TEST_COUNT="${TEST_COUNT:-10}"
TEST_INTERVAL="${TEST_INTERVAL:-1}"

echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Event Core Latency Test v0.5.0               ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════╝${NC}"
echo ""

echo "Configuration:"
echo "  Source Core:  $SOURCE_CORE"
echo "  Target Core:  $TARGET_CORE"
echo "  Test Count:   $TEST_COUNT"
echo "  Interval:     ${TEST_INTERVAL}s"
echo ""

# Verify cores are reachable
echo -e "${BLUE}[1/3] Verifying Core Connectivity...${NC}"
echo ""

if ! curl -sf "$SOURCE_CORE/health" > /dev/null; then
    echo -e "${RED}✗ Source core unreachable at $SOURCE_CORE${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Source core reachable${NC}"

if ! curl -sf "$TARGET_CORE/health" > /dev/null; then
    echo -e "${RED}✗ Target core unreachable at $TARGET_CORE${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Target core reachable${NC}"

echo ""

# Get core IDs
echo -e "${BLUE}[2/3] Retrieving Core Information...${NC}"
echo ""

SOURCE_ID=$(curl -s "$SOURCE_CORE/api/status" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
TARGET_ID=$(curl -s "$TARGET_CORE/api/status" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

echo "  Source Core ID: $SOURCE_ID"
echo "  Target Core ID: $TARGET_ID"
echo ""

# Check if cores can see each other via discovery
SOURCE_SEES_TARGET=$(curl -s "$SOURCE_CORE/api/discovery/cores" | grep -c "$TARGET_ID" || echo "0")
TARGET_SEES_SOURCE=$(curl -s "$TARGET_CORE/api/discovery/cores" | grep -c "$SOURCE_ID" || echo "0")

if [ "$SOURCE_SEES_TARGET" -eq "0" ]; then
    echo -e "${YELLOW}⚠ Warning: Source core doesn't see target in discovery${NC}"
fi

if [ "$TARGET_SEES_SOURCE" -eq "0" ]; then
    echo -e "${YELLOW}⚠ Warning: Target core doesn't see source in discovery${NC}"
fi

echo ""

# Run latency tests
echo -e "${BLUE}[3/3] Running Latency Tests...${NC}"
echo ""
echo "Publishing $TEST_COUNT events from $SOURCE_ID..."
echo ""

LATENCIES=()
SUCCESS_COUNT=0

for i in $(seq 1 $TEST_COUNT); do
    # Generate unique event ID
    EVENT_ID="latency-test-$(date +%s%3N)-$i"

    # Record start time (milliseconds)
    START_MS=$(date +%s%3N)

    # Publish event from source core
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$SOURCE_CORE/api/events" \
        -H "Content-Type: application/json" \
        -d "{
            \"event_type\": \"test.latency\",
            \"data\": {
                \"test_id\": \"$EVENT_ID\",
                \"start_ms\": $START_MS,
                \"iteration\": $i
            }
        }")

    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)

    if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "201" ]; then
        echo -e "${RED}✗ Test $i: Failed to publish event (HTTP $HTTP_CODE)${NC}"
        continue
    fi

    # Wait a bit for event to propagate
    sleep 0.5

    # Check target core logs for received event
    # Note: This is simplified - in production you'd use a proper event listener
    TARGET_LOGS=$(curl -s "$TARGET_CORE/api/logs?limit=50" 2>/dev/null || echo "")

    if echo "$TARGET_LOGS" | grep -q "$EVENT_ID"; then
        END_MS=$(date +%s%3N)
        LATENCY=$((END_MS - START_MS))
        LATENCIES+=($LATENCY)
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))

        if [ $LATENCY -lt 50 ]; then
            echo -e "${GREEN}✓ Test $i: ${LATENCY}ms (excellent)${NC}"
        elif [ $LATENCY -lt 100 ]; then
            echo -e "${YELLOW}✓ Test $i: ${LATENCY}ms (good)${NC}"
        else
            echo -e "${RED}✓ Test $i: ${LATENCY}ms (slow)${NC}"
        fi
    else
        echo -e "${RED}✗ Test $i: Event not received within 500ms${NC}"
    fi

    # Wait before next test
    if [ $i -lt $TEST_COUNT ]; then
        sleep $TEST_INTERVAL
    fi
done

echo ""

# Calculate statistics
if [ $SUCCESS_COUNT -gt 0 ]; then
    echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║                  RESULTS                       ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════╝${NC}"
    echo ""

    # Calculate min, max, avg
    MIN_LATENCY=${LATENCIES[0]}
    MAX_LATENCY=${LATENCIES[0]}
    SUM=0

    for lat in "${LATENCIES[@]}"; do
        SUM=$((SUM + lat))
        if [ $lat -lt $MIN_LATENCY ]; then
            MIN_LATENCY=$lat
        fi
        if [ $lat -gt $MAX_LATENCY ]; then
            MAX_LATENCY=$lat
        fi
    done

    AVG_LATENCY=$((SUM / SUCCESS_COUNT))

    echo "Tests Run:       $TEST_COUNT"
    echo "Successful:      $SUCCESS_COUNT"
    echo "Failed:          $((TEST_COUNT - SUCCESS_COUNT))"
    echo ""
    echo "Latency Statistics:"
    echo "  Min:    ${MIN_LATENCY}ms"
    echo "  Max:    ${MAX_LATENCY}ms"
    echo "  Avg:    ${AVG_LATENCY}ms"
    echo ""

    # Verdict
    if [ $AVG_LATENCY -lt 50 ]; then
        echo -e "${GREEN}✓ EXCELLENT: Average latency < 50ms (target met)${NC}"
        exit 0
    elif [ $AVG_LATENCY -lt 100 ]; then
        echo -e "${YELLOW}✓ GOOD: Average latency < 100ms (acceptable)${NC}"
        exit 0
    else
        echo -e "${RED}✗ POOR: Average latency > 100ms (needs improvement)${NC}"
        echo ""
        echo "Suggestions:"
        echo "  - Check network quality (use wired connection)"
        echo "  - Reduce broker load (fewer cores per broker)"
        echo "  - Check CPU usage on cores and broker"
        exit 1
    fi
else
    echo -e "${RED}✗ All tests failed. No latency data collected.${NC}"
    echo ""
    echo "Possible issues:"
    echo "  - Cores not connected to same broker"
    echo "  - Discovery not working (cores can't see each other)"
    echo "  - Firewall blocking MQTT traffic"
    echo "  - Event bus not forwarding events"
    exit 1
fi
