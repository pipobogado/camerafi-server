# 🎥 CameraFi Web — Servidor RTMP Bridge

Servidor Node.js que actúa como puente entre tu browser (Android Chrome) y Restream/YouTube/Facebook via RTMP.

```
Android Chrome → WebSocket → Este servidor → FFmpeg → RTMP → Restream → YouTube + Facebook
```

---

## 📁 Estructura del proyecto

```
camerafi-server/
├── server.js          # Servidor principal WebSocket → RTMP
├── package.json
├── Dockerfile         # Para deploy en Railway
├── railway.toml       # Config Railway
└── public/
    └── index.html     # App web CameraFi (opcional, se sirve desde aquí)
```

---

## 🚀 Deploy en Railway (GRATIS)

### Paso 1 — Subir a GitHub

1. Crea un repositorio nuevo en [github.com](https://github.com) (puede ser privado)
2. Sube todos los archivos:

```bash
git init
git add .
git commit -m "CameraFi RTMP Bridge"
git remote add origin https://github.com/TU_USUARIO/camerafi-server.git
git push -u origin main
```

---

### Paso 2 — Crear proyecto en Railway

1. Ve a [railway.app](https://railway.app) e inicia sesión con GitHub
2. Click en **"New Project"**
3. Selecciona **"Deploy from GitHub repo"**
4. Elige tu repositorio `camerafi-server`
5. Railway detecta el `Dockerfile` automáticamente ✓

---

### Paso 3 — Railway instala FFmpeg automáticamente

El `Dockerfile` incluye:
```dockerfile
RUN apk add --no-cache ffmpeg
```
No necesitas configurar nada extra. Railway lo hace solo.

---

### Paso 4 — Obtener tu URL pública

1. Una vez desplegado, ve a tu proyecto en Railway
2. Click en **"Settings"** → **"Networking"**
3. Click en **"Generate Domain"**
4. Obtendrás algo como: `https://camerafi-server-production.up.railway.app`

> ⚠️ Para WebSocket usa `wss://` en lugar de `https://`:
> `wss://camerafi-server-production.up.railway.app`

---

### Paso 5 — Configurar la app web

En tu app CameraFi Web (en el browser), en la sección **"Servidor de Stream"**:

1. Pega tu URL: `wss://camerafi-server-production.up.railway.app`
2. Click **"Conectar servidor"** → debe aparecer ✓ verde
3. En la sección **Restream/RTMP** pega tu URL y Stream Key
4. ¡Click **IR EN VIVO**!

---

## 🔑 Obtener URL y Stream Key de Restream

1. Ve a [restream.io](https://restream.io) y crea cuenta gratis
2. Dashboard → **"Add Channel"** → agrega YouTube y Facebook
3. Ve a **"Stream Setup"**
4. Copia:
   - **Server URL**: `rtmp://live.restream.io/live`
   - **Stream Key**: `re_XXXXXXXXXXXXXXXXXX`

Con una sola stream key de Restream transmites a YouTube + Facebook simultáneamente.

---

## 💻 Probar en local (sin Railway)

### Requisitos
- Node.js 18+
- FFmpeg instalado

### Instalar FFmpeg

**Windows:** Descargar de [ffmpeg.org](https://ffmpeg.org/download.html) y agregar al PATH

**Linux:**
```bash
sudo apt install ffmpeg
```

**Mac:**
```bash
brew install ffmpeg
```

### Correr el servidor

```bash
npm install
npm start
```

El servidor queda en `ws://localhost:3000`

En la app web pon: `ws://localhost:3000`

> ⚠️ En local no puedes usar `wss://` (SSL), solo `ws://`. Para producción siempre usa Railway con `wss://`.

---

## ⚙️ Variables de entorno opcionales

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT`   | `3000`  | Puerto del servidor |

---

## 🎛️ Flujo técnico

```
Browser (Android Chrome)
  │
  │  getUserMedia() → cámara trasera HD
  │  MediaRecorder → chunks WebM cada 250ms
  │  WebSocket.send(chunk)
  │
  ▼
server.js (Node.js en Railway)
  │
  │  ws.on('message') → pipe a FFmpeg stdin
  │
  ▼
FFmpeg
  │  -i pipe:0        ← chunks WebM del browser
  │  -c:v libx264     ← transcodifica a H.264
  │  -preset veryfast ← baja latencia
  │  -tune zerolatency
  │  -f flv           ← formato RTMP
  │
  ▼
rtmp://live.restream.io/live/STREAM_KEY
  │
  ├─→ YouTube Live
  └─→ Facebook Live
```

---

## 🐛 Troubleshooting

**"Sin permisos de cámara"**
→ Abre la app en HTTPS (Railway lo hace automático) o en localhost

**"Error de conexión" al conectar servidor**
→ Verifica que la URL empiece con `wss://` (no `https://`)
→ Verifica que el deploy en Railway está corriendo (ícono verde)

**Stream se corta o no llega**
→ Verifica que el bitrate no supere tu subida de internet
→ En Android recomendado: 3-6 Mbps para 1080p

**FFmpeg no encontrado**
→ En local: instala FFmpeg y agrégalo al PATH del sistema
→ En Railway: el Dockerfile lo instala automáticamente

---

## 📱 Compatibilidad

| Browser | WebRTC | MediaRecorder | Estado |
|---------|--------|---------------|--------|
| Chrome Android | ✅ | ✅ | **Recomendado** |
| Firefox Android | ✅ | ✅ | Compatible |
| Safari iOS | ✅ | ⚠️ Limitado | Parcial |
| Chrome Desktop | ✅ | ✅ | Compatible |

---

## 📊 Límites del tier gratuito de Railway

- **500 horas/mes** de ejecución (suficiente para ~16h de stream/día)
- **1 GB RAM** (más que suficiente para FFmpeg)
- **Bandwidth**: 100 GB/mes saliente
- Se **suspende** si no hay tráfico por inactividad (se reactiva en segundos al reconectar)

Para streams 24/7 considera el plan **Hobby** ($5/mes).
