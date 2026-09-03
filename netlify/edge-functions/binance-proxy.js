export default async (request, context) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      },
    });
  }

  const url = new URL(request.url);
  const isDemo = url.pathname.includes('demo');
  const targetBase = isDemo ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
  
  const cleanPath = url.pathname.replace(/^\/proxy-binance(-demo|-real)?/, '');
  const targetUrl = `${targetBase}${cleanPath}${url.search}`;

  const forwardHeaders = new Headers();
  const apiKey = request.headers.get('X-MBX-APIKEY') || request.headers.get('x-mbx-apikey');
  if (apiKey) {
    forwardHeaders.set('X-MBX-APIKEY', apiKey);
  }
  const contentType = request.headers.get('content-type');
  if (contentType) {
    forwardHeaders.set('content-type', contentType);
  }

  const init = {
    method: request.method,
    headers: forwardHeaders,
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      const bodyText = await request.text();
      if (bodyText) init.body = bodyText;
    } catch (e) {}
  }

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
    return new Response(JSON.stringify({ code: 500, msg: err.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
};

export const config = {
  path: ['/proxy-binance-demo/*', '/proxy-binance-real/*', '/proxy-binance/*'],
};
