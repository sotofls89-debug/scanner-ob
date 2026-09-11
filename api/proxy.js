/**
 * Binance API Serverless Proxy for Vercel
 * Resuelve problemas de CORS y preflight OPTIONS para Binance Futuros (Testnet y Real).
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-MBX-APIKEY, Content-Type, Authorization, *');

  // Responder inmediatamente 200 OK al preflight OPTIONS del navegador
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const urlObj = new URL(req.url, 'http://localhost');
    const params = new URLSearchParams(urlObj.search);

    const isDemo = params.get('isDemo') === 'true' || params.get('target') === 'demo' || req.url.includes('demo');
    const baseUrl = isDemo ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';

    let endpoint = params.get('endpoint') || params.get('path') || '';
    if (!endpoint) {
      const pathname = urlObj.pathname;
      if (pathname.includes('/fapi/')) {
        endpoint = pathname.substring(pathname.indexOf('/fapi/'));
      } else {
        endpoint = '/fapi/v1/order';
      }
    }
    if (!endpoint.startsWith('/')) endpoint = '/' + endpoint;

    // Eliminar parametros de enrutamiento interno
    params.delete('isDemo');
    params.delete('target');
    params.delete('endpoint');
    params.delete('path');

    const qs = params.toString();
    const targetUrl = `${baseUrl}${endpoint}${qs ? '?' + qs : ''}`;

    const forwardHeaders = {};
    const apiKey = req.headers['x-mbx-apikey'] || req.headers['X-MBX-APIKEY'];
    if (apiKey) forwardHeaders['X-MBX-APIKEY'] = apiKey;
    if (req.headers['content-type']) forwardHeaders['Content-Type'] = req.headers['content-type'];

    const fetchOptions = {
      method: req.method,
      headers: forwardHeaders
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.body) {
        fetchOptions.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      }
    }

    const response = await fetch(targetUrl, fetchOptions);
    const text = await response.text();

    res.status(response.status);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    try {
      res.json(JSON.parse(text));
    } catch {
      res.send(text);
    }
  } catch (err) {
    res.status(500).json({ code: -1, msg: 'Error en Proxy Vercel: ' + err.message });
  }
}
