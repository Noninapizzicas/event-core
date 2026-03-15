/**
 * Service Manager (Orchestrator) - Gestor de servicios
 *
 * Orquesta el arranque, parada y gestión del ciclo de vida de servicios
 * con manejo automático de dependencias.
 *
 * Features:
 * - Dependency graph resolution (topological sort)
 * - Arranque ordenado por dependencias
 * - Parada ordenada (orden inverso)
 * - Health checks automáticos
 * - Auto-restart en fallos
 * - Gestión de procesos hijo
 *
 * @example
 * const ServiceManager = require('./core/orchestrator/service-manager');
 * const manager = new ServiceManager();
 *
 * // Definir servicios
 * manager.define('mqtt-broker', {
 *   type: 'MQTT',
 *   command: 'aedes',
 *   args: ['--port', '{PORT}'],
 *   dependsOn: []
 * });
 *
 * manager.define('core-a', {
 *   type: 'EVENT_CORE',
 *   command: 'node',
 *   args: ['index.js'],
 *   dependsOn: ['mqtt-broker']
 * });
 *
 * // Arrancar todos
 * await manager.startAll();
 */

const { spawn } = require('child_process');
const ServiceRegistry = require('../utils/service-registry');

class ServiceManager {
  /**
   * @param {Object} options - Opciones
   * @param {ServiceRegistry} options.registry - Service Registry instance
   * @param {number} options.startDelay - Delay entre servicios en ms (default: 2000)
   * @param {number} options.healthCheckRetries - Reintentos de health check (default: 10)
   * @param {number} options.healthCheckInterval - Intervalo entre health checks en ms (default: 1000)
   * @param {number} options.shutdownTimeout - Timeout para graceful shutdown en ms (default: 10000)
   */
  constructor(options = {}) {
    this.registry = options.registry || new ServiceRegistry();
    this.startDelay = options.startDelay || 2000;
    this.healthCheckRetries = options.healthCheckRetries || 10;
    this.healthCheckInterval = options.healthCheckInterval || 1000;
    this.shutdownTimeout = options.shutdownTimeout || 10000;

    /**
     * Definiciones de servicios
     * Map: serviceId -> serviceDefinition
     */
    this.definitions = new Map();

    /**
     * Procesos activos
     * Map: serviceId -> childProcess
     */
    this.processes = new Map();

    /**
     * Estado de auto-restart
     * Map: serviceId -> { enabled: boolean, restartCount: number }
     */
    this.autoRestartState = new Map();
  }

  /**
   * Define un servicio
   *
   * @param {string} serviceId - ID único del servicio
   * @param {Object} definition - Definición del servicio
   * @param {string} definition.type - Tipo de servicio (EVENT_CORE, MQTT, etc.)
   * @param {string} definition.command - Comando a ejecutar
   * @param {Array<string>} definition.args - Argumentos del comando
   * @param {Object} definition.env - Variables de entorno adicionales
   * @param {Function} definition.healthCheck - Función async de health check
   * @param {Array<string>} definition.dependsOn - IDs de servicios de los que depende
   * @param {number} definition.startDelay - Delay después de dependencias en ms
   * @param {boolean} definition.autoRestart - Habilitar auto-restart
   *
   * @example
   * manager.define('core-a', {
   *   type: 'EVENT_CORE',
   *   command: 'node',
   *   args: ['index.js'],
   *   env: {
   *     CORE_ID: 'core-a',
   *     HTTP_PORT: '{PORT}'
   *   },
   *   healthCheck: async (port) => {
   *     const res = await fetch(`http://localhost:${port}/health`);
   *     return res.ok;
   *   },
   *   dependsOn: ['mqtt-broker'],
   *   autoRestart: true
   * });
   */
  define(serviceId, definition) {
    this.definitions.set(serviceId, {
      id: serviceId,
      ...definition,
      dependsOn: definition.dependsOn || [],
      startDelay: definition.startDelay || this.startDelay,
      autoRestart: definition.autoRestart !== false
    });
  }

  /**
   * Resuelve orden de arranque usando topological sort
   *
   * @returns {Array<string>} Array de service IDs en orden de arranque
   * @throws {Error} Si hay dependencias circulares
   *
   * @example
   * const order = manager.resolveStartOrder();
   * console.log('Start order:', order);
   * // ['mqtt-broker', 'postgres', 'core-a', 'core-b', 'caddy']
   */
  resolveStartOrder() {
    const visited = new Set();
    const visiting = new Set();
    const order = [];

    const visit = (serviceId) => {
      if (visited.has(serviceId)) {
        return;
      }

      if (visiting.has(serviceId)) {
        throw new Error(`Circular dependency detected involving service: ${serviceId}`);
      }

      const definition = this.definitions.get(serviceId);
      if (!definition) {
        throw new Error(`Service ${serviceId} not defined`);
      }

      visiting.add(serviceId);

      // Visitar dependencias primero
      for (const depId of definition.dependsOn) {
        visit(depId);
      }

      visiting.delete(serviceId);
      visited.add(serviceId);
      order.push(serviceId);
    };

    // Visitar todos los servicios
    for (const serviceId of this.definitions.keys()) {
      visit(serviceId);
    }

    return order;
  }

  /**
   * Arranca un servicio específico
   *
   * @param {string} serviceId - ID del servicio
   * @returns {Promise<Object>} Datos del servicio iniciado
   *
   * @example
   * const service = await manager.startService('core-a');
   * console.log(`Started on port ${service.port}`);
   */
  async startService(serviceId) {
    const definition = this.definitions.get(serviceId);

    if (!definition) {
      throw new Error(`Service ${serviceId} not defined`);
    }

    // Verificar si ya está corriendo
    const existing = this.registry.getService(serviceId);
    if (existing && existing.status === 'running') {
      console.log(`[ServiceManager] ${serviceId} is already running`);
      return existing;
    }

    console.log(`[ServiceManager] Starting ${serviceId}...`);

    // Encontrar puerto libre para el tipo de servicio
    const port = await this.registry.findFreePort(definition.type);

    // Preparar comando y args
    const command = definition.command;
    const args = (definition.args || []).map(arg =>
      arg.replace('{PORT}', port.toString())
    );

    // Preparar entorno
    const env = {
      ...process.env,
      ...definition.env
    };

    // Reemplazar {PORT} en variables de entorno
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') {
        env[key] = value.replace('{PORT}', port.toString());
      }
    }

    // Spawn proceso
    const childProcess = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });

    // Capturar output
    childProcess.stdout.on('data', (data) => {
      console.log(`[${serviceId}] ${data.toString().trim()}`);
    });

    childProcess.stderr.on('data', (data) => {
      console.error(`[${serviceId}] ERROR: ${data.toString().trim()}`);
    });

    // Manejar exit
    childProcess.on('exit', (code, signal) => {
      console.log(`[ServiceManager] ${serviceId} exited (code: ${code}, signal: ${signal})`);

      this.processes.delete(serviceId);
      this.registry.unregister(serviceId);

      // Auto-restart si está habilitado
      if (definition.autoRestart && code !== 0) {
        const restartState = this.autoRestartState.get(serviceId) || { enabled: true, restartCount: 0, restarting: false };

        // Prevent concurrent restart attempts
        if (restartState.restarting) {
          console.log(`[ServiceManager] ${serviceId} restart already in progress, skipping`);
          return;
        }

        if (restartState.enabled && restartState.restartCount < 3) {
          restartState.restartCount++;
          restartState.restarting = true;
          this.autoRestartState.set(serviceId, restartState);

          console.log(`[ServiceManager] Auto-restarting ${serviceId} (attempt ${restartState.restartCount}/3) in 5s...`);

          setTimeout(async () => {
            try {
              await this.startService(serviceId);
              restartState.restarting = false;
              this.autoRestartState.set(serviceId, restartState);
            } catch (error) {
              restartState.restarting = false;
              this.autoRestartState.set(serviceId, restartState);
              console.error(`[ServiceManager] Failed to restart ${serviceId}:`, error.message);
            }
          }, 5000);
        }
      }
    });

    // Guardar proceso
    this.processes.set(serviceId, childProcess);

    // Registrar en registry
    const serviceData = this.registry.register(serviceId, definition.type, port, {
      pid: childProcess.pid,
      command,
      args
    });

    // Health check si está definido
    if (definition.healthCheck) {
      console.log(`[ServiceManager] Waiting for ${serviceId} to be healthy...`);

      const healthy = await this.waitForHealthy(serviceId, port, definition.healthCheck);

      if (!healthy) {
        // Matar proceso si health check falla
        this.processes.get(serviceId)?.kill();
        this.processes.delete(serviceId);
        this.registry.unregister(serviceId);
        throw new Error(`${serviceId} failed health check`);
      }

      console.log(`[ServiceManager] ${serviceId} is healthy ✅`);
    }

    // Resetear contador de reintentos si arrancó exitosamente
    this.autoRestartState.set(serviceId, { enabled: true, restartCount: 0 });

    return serviceData;
  }

  /**
   * Espera a que un servicio pase el health check
   *
   * @param {string} serviceId - ID del servicio
   * @param {number} port - Puerto del servicio
   * @param {Function} healthCheckFn - Función de health check
   * @returns {Promise<boolean>} true si healthy, false si timeout
   * @private
   */
  async waitForHealthy(serviceId, port, healthCheckFn) {
    for (let i = 0; i < this.healthCheckRetries; i++) {
      try {
        const healthy = await healthCheckFn(port);

        if (healthy) {
          return true;
        }
      } catch (error) {
        // Ignorar errores, seguir intentando
      }

      await this.sleep(this.healthCheckInterval);
    }

    return false;
  }

  /**
   * Para un servicio
   *
   * @param {string} serviceId - ID del servicio
   * @param {string} signal - Señal a enviar (default: 'SIGTERM')
   * @returns {Promise<void>}
   *
   * @example
   * await manager.stopService('core-a');
   */
  async stopService(serviceId, signal = 'SIGTERM') {
    const childProcess = this.processes.get(serviceId);

    if (!childProcess) {
      console.log(`[ServiceManager] ${serviceId} is not running`);
      return;
    }

    console.log(`[ServiceManager] Stopping ${serviceId}...`);

    // Deshabilitar auto-restart temporalmente
    const restartState = this.autoRestartState.get(serviceId);
    if (restartState) {
      restartState.enabled = false;
    }

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        console.log(`[ServiceManager] ${serviceId} did not stop gracefully, killing...`);
        childProcess.kill('SIGKILL');
        resolve();
      }, this.shutdownTimeout);

      childProcess.once('exit', () => {
        clearTimeout(timeoutId);
        this.processes.delete(serviceId);
        this.registry.unregister(serviceId);
        console.log(`[ServiceManager] ${serviceId} stopped ✅`);
        resolve();
      });

      childProcess.kill(signal);
    });
  }

  /**
   * Arranca todos los servicios en orden de dependencias
   *
   * @returns {Promise<Array>} Array de servicios iniciados
   *
   * @example
   * await manager.startAll();
   */
  async startAll() {
    const order = this.resolveStartOrder();

    console.log(`[ServiceManager] Start order: ${order.join(' → ')}\n`);

    const started = [];

    for (const serviceId of order) {
      try {
        const service = await this.startService(serviceId);
        started.push(service);

        // Delay antes del siguiente servicio
        const definition = this.definitions.get(serviceId);
        if (definition.startDelay > 0) {
          await this.sleep(definition.startDelay);
        }
      } catch (error) {
        console.error(`[ServiceManager] Failed to start ${serviceId}:`, error.message);

        // Parar servicios ya iniciados
        console.log('[ServiceManager] Rolling back started services...');
        await this.stopAll();

        throw error;
      }
    }

    console.log('\n[ServiceManager] ✅ All services started\n');

    return started;
  }

  /**
   * Para todos los servicios en orden inverso
   *
   * @returns {Promise<void>}
   *
   * @example
   * await manager.stopAll();
   */
  async stopAll() {
    const order = this.resolveStartOrder().reverse();

    console.log(`[ServiceManager] Stop order: ${order.join(' → ')}\n`);

    for (const serviceId of order) {
      await this.stopService(serviceId);
    }

    console.log('\n[ServiceManager] ✅ All services stopped\n');
  }

  /**
   * Reinicia un servicio
   *
   * @param {string} serviceId - ID del servicio
   * @returns {Promise<Object>} Datos del servicio reiniciado
   */
  async restartService(serviceId) {
    await this.stopService(serviceId);
    await this.sleep(2000);
    return await this.startService(serviceId);
  }

  /**
   * Muestra estado de todos los servicios
   */
  printStatus() {
    const services = this.registry.getActiveServices();
    const stats = this.registry.getStats();

    console.log('\n📊 Service Status\n');
    console.log(`Total services: ${stats.totalServices}`);
    console.log(`By type:`, stats.byType);
    console.log(`By status:`, stats.byStatus);
    console.log('');

    if (stats.totalServices === 0) {
      console.log('No services running\n');
      return;
    }

    for (const [id, service] of Object.entries(services)) {
      const statusIcon = service.status === 'running' ? '✅' : '⚠️';
      console.log(`${statusIcon} ${id}`);
      console.log(`   Type: ${service.type}`);
      console.log(`   Port: ${service.port}`);
      console.log(`   PID: ${service.pid}`);
      console.log(`   Status: ${service.status}`);
      console.log('');
    }
  }

  /**
   * Helper: sleep
   * @private
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Destruye el manager y limpia recursos
   */
  async destroy() {
    await this.stopAll();
    this.registry.destroy();
  }
}

module.exports = ServiceManager;
