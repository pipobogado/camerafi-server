const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// Prevent unhandled errors from crashing the server
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

// HTTP server
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // Replay conversion endpoint: POST /replay-convert
  // Receives raw WebM body, returns converted MP4
  if (req.method === 'POST' && req.url === '/replay-convert') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const webmBuffer = Buffer.concat(chunks);
      if (!webmBuffer.length) {
        res.writeHead(400); res.end('Empty body'); return;
      }
      convertWebmToMp4(webmBuffer, (err, mp4Buffer) => {
        if (err || !mp4Buffer) {
          console.error('[REPLAY] Conversion error:', err?.message);
          res.writeHead(500); res.end('Conversion failed'); return;
        }
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Disposition': `attachment; filename="replay-${Date.now()}.mp4"`,
          'Content-Length': mp4Buffer.length,
          'Cache-Control': 'no-cache'
        });
        res.end(mp4Buffer);
      });
    });
    req.on('error', () => { res.writeHead(500); res.end('Request error'); });
    return;
  }

  // Serve index.html
  const filePath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('CameraFi Server OK');
  }
});

// Convert WebM buffer → MP4 buffer using FFmpeg via temp files
function convertWebmToMp4(webmBuffer, callback) {
  const tmpId = crypto.randomBytes(6).toString('hex');
  const tmpIn = path.join(os.tmpdir(), `replay-in-${tmpId}.webm`);
  const tmpOut = path.join(os.tmpdir(), `replay-out-${tmpId}.mp4`);

  fs.writeFile(tmpIn, webmBuffer, (writeErr) => {
    if (writeErr) { callback(writeErr); return; }

    const ff = spawn('ffmpeg', [
      '-y',
      '-err_detect', 'ignore_err',   // tolerate incomplete/truncated WebM
      '-i', tmpIn,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      tmpOut
    ]);

    let ffErr = '';
    ff.stderr.on('data', d => { ffErr += d.toString(); });
    ff.stdin.on('error', () => {}); // suppress EPIPE on stdin

    ff.on('close', (code) => {
      // Cleanup input temp file
      fs.unlink(tmpIn, () => {});

      if (code !== 0) {
        fs.unlink(tmpOut, () => {});
        callback(new Error(`FFmpeg exited ${code}: ${ffErr.slice(-200)}`));
        return;
      }

      fs.readFile(tmpOut, (readErr, mp4Buffer) => {
        fs.unlink(tmpOut, () => {});
        if (readErr) { callback(readErr); return; }
        callback(null, mp4Buffer);
      });
    });

    ff.on('error', (err) => {
      fs.unlink(tmpIn, () => {});
      fs.unlink(tmpOut, () => {});
      callback(err);
    });
  });
}

// WebSocket server - live stream bridge
const wss = new WebSocket.Server({ server });
console.log(`[SERVER] CameraFi RTMP Bridge + Replay iniciando en puerto ${PORT}`);

wss.on('connection', (ws, req) => {
  console.log(`[WS] Cliente conectado desde ${req.socket.remoteAddress}`);

  let ffmpegProcess = null;
  let isStreaming = false;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    ws.isAlive = true; // any message keeps connection alive

    if (typeof data === 'string' || (data instanceof Buffer && isJsonBuffer(data))) {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'ping') {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        if (msg.type === 'config') {
          const { rtmpUrl, streamKey, bitrate = '6000k', resolution = '1920x1080' } = msg;
          const destination = `${rtmpUrl}/${streamKey}`;
          console.log(`[STREAM] Iniciando → ${destination} | ${resolution} | ${bitrate}`);

          ffmpegProcess = spawn('ffmpeg', [
            '-re', '-i', 'pipe:0',
            '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
            '-b:v', bitrate, '-maxrate', bitrate,
            '-bufsize', String(parseInt(bitrate) * 2) + 'k',
            '-vf', `scale=${resolution}`,
            '-g', '60',
            '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
            '-f', 'flv', destination
          ]);

          ffmpegProcess.stderr.on('data', d => {
            const line = d.toString();
            if (line.includes('fps') || line.includes('bitrate') || line.includes('Error'))
              console.log(`[FFMPEG] ${line.trim()}`);
          });

          // Prevent EPIPE from crashing the server if FFmpeg dies unexpectedly
          ffmpegProcess.stdin.on('error', (err) => {
            if (err.code !== 'EPIPE') console.error('[FFMPEG stdin]', err.message);
          });

          ffmpegProcess.on('close', code => {
            console.log(`[FFMPEG] Proceso terminado con código ${code}`);
            isStreaming = false;
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ type: 'stopped', code }));
          });

          ffmpegProcess.on('error', err => {
            console.error(`[FFMPEG] Error: ${err.message}`);
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ type: 'error', message: err.message }));
          });

          isStreaming = true;
          ws.send(JSON.stringify({ type: 'started', destination }));
          return;
        }

        if (msg.type === 'stop') { stopStream(); return; }

      } catch (e) {
        pipeToFfmpeg(data);
      }
      return;
    }

    pipeToFfmpeg(data);
  });

  function pipeToFfmpeg(chunk) {
    if (ffmpegProcess && ffmpegProcess.stdin && isStreaming) {
      try { ffmpegProcess.stdin.write(chunk); }
      catch (e) { console.error('[PIPE] Error:', e.message); }
    }
  }

  function stopStream() {
    if (ffmpegProcess) {
      console.log('[STREAM] Deteniendo...');
      try { ffmpegProcess.stdin.end(); } catch(e) {}
      ffmpegProcess.kill('SIGTERM');
      ffmpegProcess = null;
      isStreaming = false;
    }
  }

  ws.on('close', () => { console.log('[WS] Cliente desconectado'); stopStream(); });
  ws.on('error', err => { console.error('[WS] Error:', err.message); stopStream(); });
});

// Heartbeat every 60s
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 60000);

wss.on('close', () => clearInterval(heartbeat));

function isJsonBuffer(buf) {
  return buf[0] === 123 || buf[0] === 91;
}

server.listen(PORT, () => {
  console.log(`[SERVER] ✓ http://0.0.0.0:${PORT}`);
  console.log(`[SERVER] Replay convert: POST /replay-convert`);
});
