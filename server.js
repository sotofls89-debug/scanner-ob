/**
 * SMC Bot — Servidor Local & Binance Proxy con Zero-Dependencies
 * Usa módulos nativos de Node.js (http, https, fs, path, url)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  // CORS Headers para todas las peticiones
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MBX-APIKEY, X-Target-Host');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // ─── 1. PROXY DIRECTO PARA BINANCE (Sin restricciones CORS de navegador) ───
  if (pathname.startsWith('/proxy-binance')) {
    let targetHost = 'fapi.binance.com';
    let targetPath = '';

    if (pathname.startsWith('/proxy-binance-demo')) {
      targetHost = 'testnet.binancefuture.com';
      targetPath = req.url.replace('/proxy-binance-demo', '');
    } else if (pathname.startsWith('/proxy-binance-real')) {
      targetHost = 'fapi.binance.com';
      targetPath = req.url.replace('/proxy-binance-real', '');
    } else {
      targetHost = req.headers['x-target-host'] || 'fapi.binance.com';
      targetPath = req.url.replace('/proxy-binance', '');
    }

    const proxyOptions = {
      hostname: targetHost,
      port: 443,
      path: targetPath,
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    };

    if (req.headers['x-mbx-apikey']) {
      proxyOptions.headers['X-MBX-APIKEY'] = req.headers['x-mbx-apikey'];
    }

    const proxyReq = https.request(proxyOptions, proxyRes => {
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', err => {
      console.error('[Proxy Error]', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ code: -1, msg: `Proxy Error: ${err.message}` }));
    });

    req.pipe(proxyReq);
    return;
  }

  // ─── 2. SERVIDOR DE ARCHIVOS ESTÁTICOS ───
  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') {
    safePath = '/index.html';
  }

  const filePath = path.join(ROOT, safePath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`500 Internal Server Error: ${err.code}`);
      }
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  });
});

const os = require('os');

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '192.168.100.3';
}

server.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  console.log('============================================================');
  console.log(`⚡ Servidor SMC Bot & Proxy Binance Activo`);
  console.log(`💻 En tu PC:     http://localhost:${PORT}`);
  console.log(`📱 En tu Móvil:  http://${localIp}:${PORT}`);
  console.log('============================================================');
  console.log(`(Asegúrate de que tu Móvil esté conectado al mismo Wi-Fi)`);
});

