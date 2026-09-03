const https = require('https');

exports.handler = async function(event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-MBX-APIKEY, X-Target-Host',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
      },
      body: ''
    };
  }

  const isDemo = event.queryStringParameters?.target === 'demo' || (event.path && event.path.includes('demo'));
  const targetHost = isDemo ? 'testnet.binancefuture.com' : 'fapi.binance.com';

  let cleanPath = event.path
    .replace('/.netlify/functions/binance-proxy', '')
    .replace('/proxy-binance-demo', '')
    .replace('/proxy-binance-real', '')
    .replace('/proxy-binance', '');

  if (!cleanPath.startsWith('/fapi/')) {
    cleanPath = '/fapi' + (cleanPath.startsWith('/') ? cleanPath : '/' + cleanPath);
  }

  const qParams = { ...event.queryStringParameters };
  delete qParams.target;
  delete qParams[':splat'];

  const searchParams = new URLSearchParams(qParams).toString();
  const fullPath = searchParams ? `${cleanPath}?${searchParams}` : cleanPath;

  const apiKey = event.headers['x-mbx-apikey'] || event.headers['X-MBX-APIKEY'] || '';

  return new Promise((resolve) => {
    const reqOptions = {
      hostname: targetHost,
      port: 443,
      path: fullPath,
      method: event.httpMethod,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    };

    if (apiKey) {
      reqOptions.headers['X-MBX-APIKEY'] = apiKey;
    }

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Methods': '*'
          },
          body: data
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        statusCode: 502,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ code: -1, msg: `Proxy Error: ${err.message}` })
      });
    });

    if (event.body) {
      req.write(event.body);
    }
    req.end();
  });
};
