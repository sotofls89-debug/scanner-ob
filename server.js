/**
 * SMC Bot — Servidor Local & Binance Proxy con Zero-Dependencies
 * Usa módulos nativos de Node.js (http, https, fs, path, url)
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import url, { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const ROOT = path.resolve(__dirname);

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

export default async function handler(req, res) {
  // CORS Headers para todas las peticiones
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MBX-APIKEY, Authorization, *');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // ─── 1. PROXY DIRECTO PARA BINANCE (Sin restricciones CORS de navegador) ───
  if (pathname.startsWith('/proxy-binance') || pathname.startsWith('/api/proxy')) {
    let targetHost = 'fapi.binance.com';
    let targetPath = '';

    if (pathname.startsWith('/proxy-binance-demo')) {
      targetHost = 'testnet.binancefuture.com';
      targetPath = req.url.replace('/proxy-binance-demo', '');
    } else if (pathname.startsWith('/proxy-binance-real')) {
      targetHost = 'fapi.binance.com';
      targetPath = req.url.replace('/proxy-binance-real', '');
    } else if (pathname.startsWith('/api/proxy')) {
      const q = { ...parsedUrl.query };
      const isDemo = q.isDemo === 'true' || (req.url && req.url.includes('isDemo=true'));
      targetHost = isDemo ? 'testnet.binancefuture.com' : 'fapi.binance.com';
      const endpoint = q.endpoint || '/fapi/v1/order';
      delete q.isDemo;
      delete q.endpoint;
      const restQs = new URLSearchParams(q).toString();
      targetPath = endpoint + (restQs ? (endpoint.includes('?') ? '&' : '?') + restQs : '');
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

    if (req.body) {
      const bodyData = typeof req.body === 'string' ? req.body : (Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body));
      proxyReq.write(bodyData);
      proxyReq.end();
    } else {
      req.pipe(proxyReq);
    }
    return;
  }

  // ─── 2. SERVIDOR DE ARCHIVOS ESTÁTICOS (Zero-404 con fallback a index.html) ───
  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\' || safePath === '') {
    safePath = 'index.html';
  }
  if (safePath.startsWith('/') || safePath.startsWith('\\')) {
    safePath = safePath.slice(1);
  }

  const filePath = path.join(ROOT, safePath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      // Fallback a index.html para soportar rutas SPA
      const indexPath = path.join(ROOT, 'index.html');
      fs.readFile(indexPath, (indexErr, indexContent) => {
        if (!indexErr) {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache'
          });
          res.end(indexContent);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
        }
      });
      return;
    }

    const isCacheable = ext === '.png' || ext === '.jpg' || ext === '.svg' || ext === '.ico';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': isCacheable ? 'public, max-age=86400' : 'no-cache'
    });
    res.end(content);
  });
}

// ─── 3. MODO SERVIDOR LOCAL (Desktop PC) ───
import os from 'os';

function getLocalIp() {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  } catch (_) {}
  return 'localhost';
}

const server = http.createServer((req, res) => {
  handler(req, res);
});

// En Vercel Serverless Function no se ejecuta server.listen (Vercel usa export default handler)
if (!process.env.VERCEL) {
  server.listen(PORT, '0.0.0.0', () => {
    const localIp = getLocalIp();
    console.log('============================================================');
    console.log(`⚡ Servidor SMC Bot & Proxy Binance Activo en puerto ${PORT}`);
    console.log(`💻 En tu PC:     http://localhost:${PORT}`);
    console.log(`📱 En tu Móvil:  http://${localIp}:${PORT}`);
    console.log('============================================================');
  });
}

