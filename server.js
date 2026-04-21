const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 3000;

// HTTP server - sirve la app web estática y health check
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // Sirve index.html para cualquier otra ruta
  const fs = require('fs');
  const filePath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('CameraFi Server OK - conecta tu app web via WebSocket');
  }
});

// WebSocket server - recibe stream desde el browser
const wss = new WebSocket.Server({ server });

console.log(`[SERVER] CameraFi RTMP Bridge iniciando en puerto ${PORT}`);

wss.on('connection', (ws, req) => {
  console.log(`[WS] Cliente conectado desde ${req.socket.remoteAddress}`);

  let ffmpegProcess = null;
  let rtmpUrl = null;
  let streamKey = null;
  let isStreaming = false;

  ws.on('message', (data) => {
    // Primer mensaje: configuración JSON
    if (typeof data === 'string' || (data instanceof Buffer && isJsonBuffer(data))) {
      try {
        const msg = JSON.parse(data.toString());

        // Keepalive ping from client — just respond and do nothing
        if (msg.type === 'ping') {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
          return;
        }

        if (msg.type === 'config') {
          rtmpUrl = msg.rtmpUrl;
          streamKey = msg.streamKey;
          const bitrate = msg.bitrate || '6000k';
          const resolution = msg.resolution || '1920x1080';

          console.log(`[STREAM] Iniciando → ${rtmpUrl}`);
          console.log(`[STREAM] Resolución: ${resolution} | Bitrate: ${bitrate}`);

          // Construir destino RTMP completo
          const destination = `${rtmpUrl}/${streamKey}`;

          // Lanzar FFmpeg
          ffmpegProcess = spawn('ffmpeg', [
            '-re',
            '-i', 'pipe:0',            // Input desde stdin (WebSocket chunks)
            '-c:v', 'libx264',         // Codec video H.264
            '-preset', 'veryfast',     // Balance velocidad/calidad
            '-tune', 'zerolatency',    // Latencia mínima para live
            '-b:v', bitrate,           // Bitrate de video
            '-maxrate', bitrate,
            '-bufsize', String(parseInt(bitrate) * 2) + 'k',
            '-vf', `scale=${resolution}`,
            '-g', '60',                // Keyframe cada 2s a 30fps
            '-c:a', 'aac',             // Codec audio AAC
            '-b:a', '128k',
            '-ar', '44100',
            '-f', 'flv',               // Formato FLV para RTMP
            destination
          ]);

          ffmpegProcess.stderr.on('data', (d) => {
            const line = d.toString();
            // Solo loggear líneas con info útil
            if (line.includes('fps') || line.includes('bitrate') || line.includes('Error')) {
              console.log(`[FFMPEG] ${line.trim()}`);
            }
          });

          ffmpegProcess.on('close', (code) => {
            console.log(`[FFMPEG] Proceso terminado con código ${code}`);
            isStreaming = false;
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'stopped', code }));
            }
          });

          ffmpegProcess.on('error', (err) => {
            console.error(`[FFMPEG] Error: ${err.message}`);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'error', message: err.message }));
            }
          });

          isStreaming = true;
          ws.send(JSON.stringify({ type: 'started', destination }));
        }

        if (msg.type === 'stop') {
          stopStream();
        }

      } catch (e) {
        // No es JSON, tratar como chunk de video binario
        pipeToFfmpeg(data);
      }
      return;
    }

    // Datos binarios → pipe directo a FFmpeg
    pipeToFfmpeg(data);
  });

  function pipeToFfmpeg(chunk) {
    if (ffmpegProcess && ffmpegProcess.stdin && isStreaming) {
      try {
        ffmpegProcess.stdin.write(chunk);
      } catch (e) {
        console.error('[PIPE] Error escribiendo a FFmpeg:', e.message);
      }
    }
  }

  function stopStream() {
    if (ffmpegProcess) {
      console.log('[STREAM] Deteniendo stream...');
      ffmpegProcess.stdin.end();
      ffmpegProcess.kill('SIGTERM');
      ffmpegProcess = null;
      isStreaming = false;
    }
  }

  ws.on('close', () => {
    console.log('[WS] Cliente desconectado');
    stopStream();
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
    stopStream();
  });

  // Ping/pong para mantener conexión viva
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', () => { ws.isAlive = true; }); // cualquier mensaje mantiene viva la conexión
});

// Heartbeat cada 60s para detectar conexiones realmente muertas
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 60000);

wss.on('close', () => clearInterval(heartbeat));

function isJsonBuffer(buf) {
  const first = buf[0];
  return first === 123 || first === 91; // { o [
}

server.listen(PORT, () => {
  console.log(`[SERVER] ✓ Escuchando en http://0.0.0.0:${PORT}`);
  console.log(`[SERVER] WebSocket en ws://0.0.0.0:${PORT}`);
});
