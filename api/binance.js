export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const { path = '', isDemo = 'false', ...queryParams } = req.query;
  const baseUrl = isDemo === 'true' ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
  
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const qs = new URLSearchParams(queryParams).toString();
  const targetUrl = `${baseUrl}${cleanPath}${qs ? '?' + qs : ''}`;

  const forwardHeaders = {};
  const apiKey = req.headers['x-mbx-apikey'];
  if (apiKey) forwardHeaders['X-MBX-APIKEY'] = apiKey;
  if (req.headers['content-type']) forwardHeaders['content-type'] = req.headers['content-type'];

  try {
    const fetchOptions = {
      method: req.method,
      headers: forwardHeaders
    };

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      fetchOptions.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOptions);
    const text = await response.text();

    res.status(response.status);
    try {
      res.json(JSON.parse(text));
    } catch {
      res.send(text);
    }
  } catch (err) {
    res.status(500).json({ code: -1, msg: err.message });
  }
}
