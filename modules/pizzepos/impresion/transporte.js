/**
 * Transporte Bluetooth para impresora térmica en Termux/Android
 *
 * Soporta 3 modos de envío:
 *   1. "dispositivo" — escribe a /dev/rfcomm0 (requiere rfcomm bind)
 *   2. "comando"     — pipe a un comando shell arbitrario
 *   3. "tcp"         — socket TCP (para apps bridge BT→TCP)
 *
 * Setup Termux (modo dispositivo):
 *   pkg install termux-api bluetooth-utils
 *   bluetoothctl → pair <MAC>
 *   rfcomm bind 0 <MAC> 1
 *   → escribe a /dev/rfcomm0
 */

const fs = require('fs');
const net = require('net');
const { execSync, spawn } = require('child_process');

// Estado de conexión
const ESTADO = {
  DESCONECTADO: 'desconectado',
  CONECTANDO: 'conectando',
  CONECTADO: 'conectado',
  ERROR: 'error'
};

class TransporteBluetooth {
  /**
   * @param {Object} config
   * @param {string} config.modo          - "dispositivo" | "comando" | "tcp"
   * @param {string} config.mac           - MAC del dispositivo BT (AA:BB:CC:DD:EE:FF)
   * @param {string} config.dispositivo   - ruta al device file (default: /dev/rfcomm0)
   * @param {number} config.rfcomm_canal  - canal RFCOMM (default: 1)
   * @param {string} config.comando       - comando shell para modo "comando"
   * @param {string} config.tcp_host      - host para modo TCP (default: 127.0.0.1)
   * @param {number} config.tcp_puerto    - puerto para modo TCP
   * @param {Object} logger
   */
  constructor(config, logger) {
    this.config = {
      modo: 'dispositivo',
      mac: null,
      dispositivo: '/dev/rfcomm0',
      rfcomm_canal: 1,
      comando: null,
      tcp_host: '127.0.0.1',
      tcp_puerto: 9100,
      ...config
    };
    this.logger = logger;
    this.estado = ESTADO.DESCONECTADO;
    this.tcpSocket = null;
  }

  // ==========================================
  // Conexión
  // ==========================================

  /**
   * Prepara la conexión según el modo configurado.
   * En modo "dispositivo": hace rfcomm bind si es necesario.
   * En modo "tcp": abre el socket.
   * En modo "comando": no hace nada (se ejecuta por envío).
   */
  async conectar() {
    this.estado = ESTADO.CONECTANDO;
    const { modo } = this.config;

    try {
      if (modo === 'dispositivo') {
        await this._prepararRfcomm();
      } else if (modo === 'tcp') {
        await this._conectarTcp();
      }
      // modo "comando" no necesita conexión previa

      this.estado = ESTADO.CONECTADO;
      this.logger.info('transporte.conectado', { modo });
    } catch (error) {
      this.estado = ESTADO.ERROR;
      this.logger.error('transporte.conexion.error', { modo, error: error.message });
      throw error;
    }
  }

  async desconectar() {
    if (this.tcpSocket) {
      this.tcpSocket.destroy();
      this.tcpSocket = null;
    }
    this.estado = ESTADO.DESCONECTADO;
    this.logger.info('transporte.desconectado');
  }

  // ==========================================
  // Envío
  // ==========================================

  /**
   * Envía datos raw (ESC/POS) a la impresora.
   * @param {string|Buffer} datos - contenido ESC/POS
   */
  async enviar(datos) {
    const buffer = Buffer.isBuffer(datos) ? datos : Buffer.from(datos, 'binary');
    const { modo } = this.config;

    this.logger.debug('transporte.enviando', { modo, bytes: buffer.length });

    switch (modo) {
      case 'dispositivo':
        return this._enviarDispositivo(buffer);
      case 'comando':
        return this._enviarComando(buffer);
      case 'tcp':
        return this._enviarTcp(buffer);
      default:
        throw new Error(`Modo de transporte desconocido: ${modo}`);
    }
  }

  // ==========================================
  // Modo: Dispositivo (rfcomm)
  // ==========================================

  async _prepararRfcomm() {
    const { mac, dispositivo, rfcomm_canal } = this.config;

    // Verificar si el device file ya existe
    if (fs.existsSync(dispositivo)) {
      this.logger.info('transporte.rfcomm.existe', { dispositivo });
      return;
    }

    // Necesitamos MAC para hacer bind
    if (!mac) {
      throw new Error(
        `No existe ${dispositivo} y no se proporcionó MAC para rfcomm bind. ` +
        `Ejecuta manualmente: rfcomm bind 0 <MAC> ${rfcomm_canal}`
      );
    }

    // Extraer número de dispositivo de la ruta (/dev/rfcomm0 → 0)
    const match = dispositivo.match(/rfcomm(\d+)/);
    const devNum = match ? match[1] : '0';

    try {
      this.logger.info('transporte.rfcomm.bind', { mac, canal: rfcomm_canal, dev: devNum });
      execSync(`rfcomm bind ${devNum} ${mac} ${rfcomm_canal}`, { timeout: 5000 });

      // Esperar un momento a que el device aparezca
      await this._esperarDispositivo(dispositivo, 3000);
    } catch (error) {
      throw new Error(
        `Error al hacer rfcomm bind: ${error.message}. ` +
        `Verifica que el dispositivo está emparejado y bluetooth-utils instalado.`
      );
    }
  }

  async _esperarDispositivo(ruta, timeoutMs) {
    const inicio = Date.now();
    while (Date.now() - inicio < timeoutMs) {
      if (fs.existsSync(ruta)) return;
      await new Promise(r => setTimeout(r, 200));
    }
    if (!fs.existsSync(ruta)) {
      throw new Error(`Timeout esperando ${ruta}`);
    }
  }

  async _enviarDispositivo(buffer) {
    const { dispositivo } = this.config;

    return new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(dispositivo, { flags: 'a' });

      stream.on('error', (err) => {
        this.estado = ESTADO.ERROR;
        reject(new Error(`Error escribiendo a ${dispositivo}: ${err.message}`));
      });

      stream.write(buffer, () => {
        stream.end(() => {
          this.logger.debug('transporte.dispositivo.enviado', { bytes: buffer.length });
          resolve();
        });
      });
    });
  }

  // ==========================================
  // Modo: Comando shell
  // ==========================================

  async _enviarComando(buffer) {
    const { comando } = this.config;

    if (!comando) {
      throw new Error('No se configuró comando para modo "comando"');
    }

    return new Promise((resolve, reject) => {
      const proc = spawn('sh', ['-c', comando], { stdio: ['pipe', 'ignore', 'pipe'] });

      let stderr = '';
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      proc.on('error', (err) => {
        reject(new Error(`Error ejecutando comando: ${err.message}`));
      });

      proc.on('close', (code) => {
        if (code === 0) {
          this.logger.debug('transporte.comando.enviado', { bytes: buffer.length });
          resolve();
        } else {
          reject(new Error(`Comando salió con código ${code}: ${stderr}`));
        }
      });

      proc.stdin.write(buffer);
      proc.stdin.end();
    });
  }

  // ==========================================
  // Modo: TCP socket
  // ==========================================

  async _conectarTcp() {
    const { tcp_host, tcp_puerto } = this.config;

    return new Promise((resolve, reject) => {
      this.tcpSocket = new net.Socket();

      const timeout = setTimeout(() => {
        this.tcpSocket.destroy();
        reject(new Error(`Timeout conectando a ${tcp_host}:${tcp_puerto}`));
      }, 5000);

      this.tcpSocket.connect(tcp_puerto, tcp_host, () => {
        clearTimeout(timeout);
        this.logger.info('transporte.tcp.conectado', { host: tcp_host, puerto: tcp_puerto });
        resolve();
      });

      this.tcpSocket.on('error', (err) => {
        clearTimeout(timeout);
        this.estado = ESTADO.ERROR;
        this.logger.error('transporte.tcp.error', { error: err.message });
        reject(err);
      });

      this.tcpSocket.on('close', () => {
        this.tcpSocket = null;
        this.estado = ESTADO.DESCONECTADO;
        this.logger.info('transporte.tcp.cerrado');
      });
    });
  }

  async _enviarTcp(buffer) {
    if (!this.tcpSocket || this.tcpSocket.destroyed) {
      await this._conectarTcp();
    }

    return new Promise((resolve, reject) => {
      this.tcpSocket.write(buffer, (err) => {
        if (err) {
          reject(new Error(`Error enviando por TCP: ${err.message}`));
        } else {
          this.logger.debug('transporte.tcp.enviado', { bytes: buffer.length });
          resolve();
        }
      });
    });
  }

  // ==========================================
  // Utilidades
  // ==========================================

  getEstado() {
    return {
      modo: this.config.modo,
      estado: this.estado,
      dispositivo: this.config.modo === 'dispositivo' ? this.config.dispositivo : undefined,
      mac: this.config.mac || null,
      tcp: this.config.modo === 'tcp'
        ? `${this.config.tcp_host}:${this.config.tcp_puerto}`
        : undefined
    };
  }
}

module.exports = TransporteBluetooth;
module.exports.ESTADO = ESTADO;
