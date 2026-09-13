/**
 * Binance API Edge Proxy for Vercel
 * Ejecuta en la red Edge de Vercel (0ms cold start, ultra-rápido, sin límites de crédito).
 * Intercepta y reenvía peticiones a Binance Futures REST API (Testnet y Real).
 */

export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-MBX-APIKEY, x-mbx-apikey, Authorization, *',
    'Access-Control-Max-Age': '86400',
  };

  // 1. Manejo instantáneo de preflight CORS (OPTIONS)
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  try {
    const url = new URL(request.url);
    const searchParams = new URLSearchParams(url.search);

    const isDemo = searchParams.get('isDemo') === 'true' || 
                   url.pathname.includes('demo') || 
                   searchParams.get('target') === 'demo';
    const targetBase = isDemo ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';

    let endpoint = searchParams.get('endpoint') || searchParams.get('path') || '';
    if (!endpoint) {
      if (url.pathname.includes('/fapi/')) {
        endpoint = url.pathname.substring(url.pathname.indexOf('/fapi/'));
      } else {
        endpoint = '/fapi/v1/order';
      }
    }
    if (!endpoint.startsWith('/')) endpoint = '/' + endpoint;

    // Eliminar parámetros internos del proxy para que no contaminen la firma de Binance
    searchParams.delete('isDemo');
    searchParams.delete('target');
    searchParams.delete('endpoint');
    searchParams.delete('path');

    const qs = searchParams.toString();
    const targetUrl = `${targetBase}${endpoint}${qs ? '?' + qs : ''}`;

    const forwardHeaders = new Headers();
    const apiKey = request.headers.get('X-MBX-APIKEY') || 
                   request.headers.get('x-mbx-apikey') || '';
    if (apiKey) {
      forwardHeaders.set('X-MBX-APIKEY', apiKey);
    }
    const contentType = request.headers.get('content-type') || 'application/x-www-form-urlencoded';
    forwardHeaders.set('content-type', contentType);
    forwardHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');

    const fetchInit = {
      method: request.method,
      headers: forwardHeaders,
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try {
        const bodyText = await request.text();
        if (bodyText && bodyText.length > 0) {
          fetchInit.body = bodyText;
        }
      } catch (_) {}
    }

    const response = await fetch(targetUrl, fetchInit);
    const responseBody = await response.text();

    return new Response(responseBody, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...corsHeaders,
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ code: -1, msg: 'Error en Vercel Proxy: ' + err.message }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...corsHeaders,
      },
    });
  }
}
