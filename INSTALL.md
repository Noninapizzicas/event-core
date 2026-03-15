# Event-Core - Guia de Instalacion

## Instalacion Rapida

### Termux (Android)

```bash
# 1. Instalar Termux desde F-Droid (recomendado) o Play Store

# 2. Clonar el repositorio
pkg install git
git clone <url-del-repositorio> ~/event-core
cd ~/event-core

# 3. Ejecutar instalador
bash scripts/install-termux.sh

# 4. Iniciar
npm start
```

### Linux (Debian/Ubuntu/Fedora/Arch)

```bash
# 1. Clonar el repositorio
git clone <url-del-repositorio> ~/event-core
cd ~/event-core

# 2. Ejecutar instalador
bash scripts/install-linux.sh

# 3. Iniciar
npm start
```

### Instalador Universal

```bash
# Detecta automaticamente Termux o Linux
bash install.sh
```

---

## Requisitos

| Componente | Version Minima |
|------------|----------------|
| Node.js    | 18.0.0+        |
| npm        | 8.0.0+         |
| RAM        | 512 MB         |
| Disco      | 100 MB         |

### Dependencias Opcionales

- **tesseract** - OCR para imagenes
- **poppler** - Procesamiento de PDFs
- **imagemagick** - Manipulacion de imagenes

---

## Configuracion Post-Instalacion

### 1. Editar variables de entorno

```bash
nano .env
```

### 2. Agregar API Keys (opcional)

```env
# AI Providers
OPENAI_API_KEY=sk-...
DEEPSEEK_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Telegram Bot
TELEGRAM_BOT_TOKEN=123456:ABC...
```

### 3. Configurar puertos (opcional)

```env
EVENT_CORE_PORT=3000       # HTTP
EVENT_CORE_BROKER_PORT=1883 # MQTT
```

---

## Comandos Utiles

```bash
# Iniciar servidor
npm start

# Modo desarrollo (mas logs)
npm run dev

# Verificar estado
node cli/index.js health

# Ver modulos cargados
node cli/index.js modules

# Ejecutar tests
npm test
```

---

## Puertos

| Servicio | Puerto | Descripcion |
|----------|--------|-------------|
| HTTP     | 3000   | API Gateway |
| MQTT     | 1883   | Broker MQTT |
| MQTT WS  | 9001   | MQTT sobre WebSocket |

---

## Termux - Notas Especiales

### Mantener activo en segundo plano

```bash
# Instalar termux-services
pkg install termux-services

# O usar tmux/screen
pkg install tmux
tmux new -s eventcore
npm start
# Ctrl+B, D para desconectar
# tmux attach -t eventcore para reconectar
```

### Acceso desde red local

```bash
# Ver IP del dispositivo
ip addr show wlan0

# El servidor estara disponible en:
# http://<IP>:3000
```

### Notificaciones

```bash
pkg install termux-api
# Permite enviar notificaciones al sistema Android
```

---

## Linux - Servicio Systemd

El instalador puede crear un servicio systemd automaticamente.

```bash
# Iniciar servicio
sudo systemctl start event-core

# Detener
sudo systemctl stop event-core

# Habilitar auto-inicio
sudo systemctl enable event-core

# Ver logs
journalctl -u event-core -f
```

---

## Troubleshooting

### Error: Node.js version menor a 18

```bash
# Termux
pkg upgrade nodejs

# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Error: EACCES permission denied

```bash
# Configurar npm para usuario local
npm config set prefix "$HOME/.npm-global"
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

### Error: Puerto en uso

```bash
# Ver que usa el puerto
lsof -i :3000

# Cambiar puerto en .env
EVENT_CORE_PORT=3001
```

### Termux: Storage permission

```bash
termux-setup-storage
```

---

## Estructura de Directorios Post-Instalacion

```
~/event-core/
├── .env              # Configuracion local (creado)
├── data/             # Datos persistentes (creado)
├── logs/             # Archivos de log (creado)
├── modules/          # Modulos del sistema
├── core/             # Nucleo del framework
└── frontend/         # Interfaz web (SvelteKit)
```
