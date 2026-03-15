# Event Core Dockerfile
# Multi-stage build for minimal production image

# ============================================================================
# Stage 1: Dependencies
# ============================================================================
FROM node:18-alpine AS deps

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && \
    npm cache clean --force

# ============================================================================
# Stage 2: Production Image
# ============================================================================
FROM node:18-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules

# Copy application code
COPY --chown=nodejs:nodejs . .

# Create directories for runtime data
RUN mkdir -p /app/data && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose ports
# HTTP Gateway
EXPOSE 3000
# MQTT Broker
EXPOSE 1883

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Environment variables with defaults
ENV NODE_ENV=production \
    EVENT_CORE_ID=event-core \
    EVENT_CORE_PORT=3000 \
    EVENT_CORE_BROKER_PORT=1883 \
    EVENT_CORE_LOG_LEVEL=info

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "index.js"]
