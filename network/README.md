# Network Deployment Scripts

This directory contains scripts for deploying and testing Event Core in multi-machine network configurations.

---

## Scripts Overview

### 1. `setup-core.sh` - Core Setup Wizard

Interactive wizard for quickly setting up a new Event Core instance.

**Usage:**

```bash
# Interactive mode (recommended for first-time setup)
./network/setup-core.sh

# Non-interactive with environment variables
INTERACTIVE=false \
CORE_ID=core-prod-1 \
CORE_PORT=3000 \
BROKER_URL=mqtt://192.168.1.12:1883 \
LOG_LEVEL=info \
./network/setup-core.sh
```

**Features:**
- Generates unique core ID automatically
- Creates `.env` configuration file
- Validates dependencies
- Tests broker connectivity
- Optional auto-start

**Output:**
- Creates `.env` file with configuration
- Backs up existing `.env` if present

---

### 2. `validate.sh` - Network Validation

Validates network configuration and readiness for multi-core deployment.

**Usage:**

```bash
# Validate localhost (default)
./network/validate.sh

# Validate remote broker
BROKER_HOST=192.168.1.12 \
BROKER_PORT=1883 \
./network/validate.sh

# Quick validation with custom timeout
TIMEOUT=10 ./network/validate.sh
```

**Tests Performed:**
1. **Prerequisites**: Node.js, npm, curl, netcat
2. **Network**: Ping, TCP connection, latency measurement
3. **MQTT Broker**: Publish/subscribe test
4. **Event Core**: Health check, API access, discovery
5. **Security**: Configuration checks

**Exit Codes:**
- `0`: All tests passed
- `1`: One or more tests failed

**Example Output:**

```
╔════════════════════════════════════════════════╗
║  Event Core Network Validation v0.5.0         ║
╚════════════════════════════════════════════════╝

[1/5] Checking Prerequisites...
[TEST 1] Node.js installed... ✓ PASS
[TEST 2] Node.js version >= 18... ✓ PASS
...

[5/5] Security Checks...
✓ .env file exists
✓ EVENT_CORE_ID defined

╔════════════════════════════════════════════════╗
║                   SUMMARY                      ║
╚════════════════════════════════════════════════╝

Total Tests:  15
Passed:       15
Failed:       0

✓ All tests passed! Network deployment is ready.
```

---

### 3. `latency-test.sh` - Latency Testing

Measures event propagation latency between two cores.

**Usage:**

```bash
# Test between two local cores
SOURCE_CORE=http://localhost:3000 \
TARGET_CORE=http://localhost:3001 \
./network/latency-test.sh

# Test between remote cores
SOURCE_CORE=http://192.168.1.10:3000 \
TARGET_CORE=http://192.168.1.11:3000 \
TEST_COUNT=20 \
./network/latency-test.sh

# Stress test with many iterations
TEST_COUNT=100 \
TEST_INTERVAL=0.5 \
./network/latency-test.sh
```

**Environment Variables:**

| Variable | Description | Default |
|----------|-------------|---------|
| `SOURCE_CORE` | Source core HTTP URL | `http://localhost:3000` |
| `TARGET_CORE` | Target core HTTP URL | `http://localhost:3001` |
| `TEST_COUNT` | Number of test iterations | `10` |
| `TEST_INTERVAL` | Delay between tests (seconds) | `1` |

**Output:**

```
╔════════════════════════════════════════════════╗
║  Event Core Latency Test v0.5.0               ║
╚════════════════════════════════════════════════╝

[3/3] Running Latency Tests...
✓ Test 1: 23ms (excellent)
✓ Test 2: 18ms (excellent)
✓ Test 3: 31ms (excellent)
...

╔════════════════════════════════════════════════╗
║                  RESULTS                       ║
╚════════════════════════════════════════════════╝

Tests Run:       10
Successful:      10
Failed:          0

Latency Statistics:
  Min:    18ms
  Max:    45ms
  Avg:    27ms

✓ EXCELLENT: Average latency < 50ms (target met)
```

**Interpreting Results:**

| Average Latency | Verdict | Action |
|----------------|---------|--------|
| < 50ms | Excellent ✅ | No action needed |
| 50-100ms | Good ⚠️ | Acceptable for most use cases |
| > 100ms | Poor ❌ | Investigate network or broker issues |

---

## Quick Start Guide

### Scenario 1: Two Cores on Same Machine (Development)

**Terminal 1 (Core A):**
```bash
./network/setup-core.sh
# Use defaults, Core ID: core-a, Port: 3000
```

**Terminal 2 (Core B):**
```bash
CORE_ID=core-b \
CORE_PORT=3001 \
./network/setup-core.sh
```

**Terminal 3 (Validate):**
```bash
./network/validate.sh
```

**Terminal 4 (Test Latency):**
```bash
SOURCE_CORE=http://localhost:3000 \
TARGET_CORE=http://localhost:3001 \
./network/latency-test.sh
```

---

### Scenario 2: Three Cores on Different Machines (Production)

**Prerequisite**: Setup Mosquitto broker on Machine C (192.168.1.12)

**Machine A (192.168.1.10) - Core A:**
```bash
# Clone repo
git clone https://github.com/YOUR_ORG/event-core.git
cd event-core

# Setup
CORE_ID=core-a \
BROKER_URL=mqtt://192.168.1.12:1883 \
./network/setup-core.sh

# Validate
BROKER_HOST=192.168.1.12 ./network/validate.sh

# Start
node index.js
```

**Machine B (192.168.1.11) - Core B:**
```bash
# Clone repo
git clone https://github.com/YOUR_ORG/event-core.git
cd event-core

# Setup
CORE_ID=core-b \
BROKER_URL=mqtt://192.168.1.12:1883 \
./network/setup-core.sh

# Validate
BROKER_HOST=192.168.1.12 ./network/validate.sh

# Start
node index.js
```

**Machine A (Test Latency to B):**
```bash
SOURCE_CORE=http://localhost:3000 \
TARGET_CORE=http://192.168.1.11:3000 \
./network/latency-test.sh
```

---

## Troubleshooting

### `validate.sh` Reports Broker Unreachable

**Problem**: Can't connect to MQTT broker

**Solutions:**

1. **Check broker is running:**
   ```bash
   # On broker machine
   sudo systemctl status mosquitto
   ```

2. **Check firewall:**
   ```bash
   # On broker machine
   sudo ufw allow 1883/tcp
   sudo ufw reload
   ```

3. **Verify broker listens on external interface:**
   ```bash
   # Check mosquitto.conf has:
   listener 1883 0.0.0.0
   ```

4. **Test with mosquitto_pub:**
   ```bash
   mosquitto_pub -h 192.168.1.12 -t test -m "hello"
   ```

---

### `latency-test.sh` Shows High Latency (> 100ms)

**Problem**: Events are slow to propagate

**Solutions:**

1. **Check network latency:**
   ```bash
   ping -c 10 192.168.1.11
   # Should be < 10ms on LAN
   ```

2. **Check broker load:**
   ```bash
   # On broker machine
   top -p $(pgrep mosquitto)
   ```

3. **Reduce QoS level** (if custom configured):
   - Event Core uses QoS 0 by default (fastest)

4. **Use wired network** instead of WiFi

---

### Cores Don't Discover Each Other

**Problem**: `/api/discovery/cores` shows only local core

**Solutions:**

1. **Verify same broker:**
   ```bash
   # Check .env on both cores
   cat .env | grep BROKER_URL
   # Must be identical!
   ```

2. **Check discovery logs:**
   ```bash
   curl http://localhost:3000/api/logs | grep discovery
   ```

3. **Wait 60 seconds** for heartbeat cycle

4. **Check MQTT retained messages:**
   ```bash
   # On broker machine
   mosquitto_sub -h localhost -t 'core/+/status' -v
   # Should see ALL cores
   ```

---

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Network Deployment Test

on: [push, pull_request]

jobs:
  network-test:
    runs-on: ubuntu-latest

    services:
      mosquitto:
        image: eclipse-mosquitto:2
        ports:
          - 1883:1883

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm install

      - name: Setup Core A
        run: |
          CORE_ID=core-a \
          CORE_PORT=3000 \
          BROKER_URL=mqtt://localhost:1883 \
          INTERACTIVE=false \
          ./network/setup-core.sh

      - name: Setup Core B
        run: |
          CORE_ID=core-b \
          CORE_PORT=3001 \
          BROKER_URL=mqtt://localhost:1883 \
          INTERACTIVE=false \
          ./network/setup-core.sh

      - name: Start Cores
        run: |
          node index.js &
          CORE_PORT=3001 node index.js &
          sleep 10

      - name: Validate Network
        run: ./network/validate.sh

      - name: Test Latency
        run: |
          SOURCE_CORE=http://localhost:3000 \
          TARGET_CORE=http://localhost:3001 \
          ./network/latency-test.sh
```

---

## Advanced Usage

### Automated Multi-Core Setup

```bash
#!/bin/bash
# deploy-cluster.sh - Deploy N cores automatically

BROKER_URL="mqtt://192.168.1.12:1883"
CORE_COUNT=5
BASE_PORT=3000

for i in $(seq 1 $CORE_COUNT); do
  PORT=$((BASE_PORT + i - 1))
  CORE_ID="core-cluster-$i"

  echo "Setting up $CORE_ID on port $PORT..."

  INTERACTIVE=false \
  CORE_ID=$CORE_ID \
  CORE_PORT=$PORT \
  BROKER_URL=$BROKER_URL \
  ./network/setup-core.sh

  # Start in background
  EVENT_CORE_PORT=$PORT node index.js &

  sleep 2
done

echo "Cluster deployed! $CORE_COUNT cores running."
```

### Performance Monitoring Loop

```bash
#!/bin/bash
# monitor-latency.sh - Continuously monitor latency

while true; do
  echo "[$(date)] Running latency test..."

  SOURCE_CORE=http://localhost:3000 \
  TARGET_CORE=http://localhost:3001 \
  TEST_COUNT=5 \
  ./network/latency-test.sh | grep "Avg:" >> latency.log

  sleep 60
done
```

---

## References

- [Network Deployment Guide](../docs/NETWORK_DEPLOYMENT.md)
- [Event Core Architecture](../docs/ARCHITECTURE_FINAL.md)
- [Discovery System](../core/discovery/README.md)
- [Mosquitto Documentation](https://mosquitto.org/man/mosquitto-conf-5.html)

---

**Questions or Issues?**

Open an issue on GitHub or consult the main documentation.
