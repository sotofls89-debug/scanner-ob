/**
 * Netlify Edge Function — Proxy Binance
 * Intercepta /proxy-binance-demo/* y /proxy-binance-real/* y los reenvía
 * al host de Binance correcto, conservando método, headers y body.
 *
 * Las Edge Functions corren en Deno (V8), NO Node.js.
 * Soportan POST con headers personalizados — los redirects simples de netlify.toml NO.
 */
export default async (request, context) => {
  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-MBX-APIKEY, x-mbx-apikey, X-Target-Host',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const url = new URL(request.url);
  const pathname = url.pathname;

  // ── Determinar host destino y limpiar el path ───────────────────────────────
  let targetBase;
  let cleanPath;

  if (pathname.includes('/proxy-binance-demo')) {
    targetBase = 'https://testnet.binancefuture.com';
    cleanPath = pathname.replace(/^.*\/proxy-binance-demo/, '');
  } else if (pathname.includes('/proxy-binance-real')) {
    targetBase = 'https://fapi.binance.com';
    cleanPath = pathname.replace(/^.*\/proxy-binance-real/, '');
  } else {
    targetBase = 'https://fapi.binance.com';
    cleanPath = pathname.replace(/^.*\/proxy-binance/, '');
  }

  // Asegurar que el path comience con /
  if (!cleanPath.startsWith('/')) cleanPath = '/' + cleanPath;

  const targetUrl = `${targetBase}${cleanPath}${url.search}`;

  // ── Construir headers para reenviar ─────────────────────────────────────────
  const forwardHeaders = new Headers();
  const apiKey = request.headers.get('X-MBX-APIKEY') 
             || request.headers.get('x-mbx-apikey') 
             || '';
  if (apiKey) {
    forwardHeaders.set('X-MBX-APIKEY', apiKey);
  }
  const contentType = request.headers.get('content-type') || 'application/x-www-form-urlencoded';
  forwardHeaders.set('content-type', contentType);
  forwardHeaders.set('User-Agent', 'Mozilla/5.0');

  // ── Construir opciones de la petición ───────────────────────────────────────
  const init = {
    method: request.method,
    headers: forwardHeaders,
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      const bodyText = await request.text();
      if (bodyText) init.body = bodyText;
    } catch (_) {}
  }

  // ── Hacer la petición a Binance ─────────────────────────────────────────────
  try {
    const response = await fetch(targetUrl, init);
    const bodyText = await response.text();

    return new Response(bodyText, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ code: -1, msg: `Edge proxy error: ${err.message}` }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
};

// Rutas que intercepta esta Edge Function
export const config = {
  path: ['/proxy-binance-demo/*', '/proxy-binance-real/*', '/proxy-binance/*'],
};
