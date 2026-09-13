/**
 * Binance Trade Executor — Motor de Ejecución Directa de Órdenes
 *
 * ARQUITECTURA DE CONEXIÓN (sin proxy externo, funciona desde GitHub Pages):
 * ─────────────────────────────────────────────────────────────────────────
 * 1. WebSocket API  wss://testnet.binancefuture.com/ws-fapi/v1
 *    ✅ Sin CORS — los WebSockets NO tienen restricciones de origen
 *    ✅ Funciona desde cualquier navegador, cualquier red, cualquier URL
 *    ✅ Permanente: no depende de servidores locales ni servicios externos
 *
 * 2. HTTP directo  https://testnet.binancefuture.com
 *    ✅ Para consultas GET públicas (exchangeInfo, etc.)
 *    ✅ Binance permite GET desde cualquier origen
 *    ❌ POST bloqueado por CORS en navegadores (por eso usamos WS para órdenes)
 *
 * 3. Node.js local  http://localhost:3000  (solo en PC con servidor activo)
 *    ✅ Chrome/Firefox permiten llamadas a localhost desde páginas HTTPS
 *    ✅ Útil cuando el servidor local está corriendo
 *
 * SEGURIDAD:
 * - Las claves API NUNCA se escriben en el código fuente.
 * - Se almacenan SOLO en el localStorage del dispositivo del usuario.
 * - Se firma cada petición con HMAC-SHA256 usando la Web Crypto API del navegador.
 */

class BinanceTrade {
  constructor() {
    this.storageKey = 'smc_api_config_v1';
    this.config     = this.loadConfig();
    this._wsCache   = {};   // cache de WebSocket por endpoint
  }

  // ─── Persistencia ───────────────────────────────────────────────────────────

  loadConfig() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? JSON.parse(raw) : this.defaultConfig();
    } catch (e) {
      return this.defaultConfig();
    }
  }

  defaultConfig() {
    return { mode: 'demo', demoKey: '', demoSecret: '', realKey: '', realSecret: '' };
  }

  saveConfig(cfg) {
    const current = this.loadConfig();
    this.config = { ...current, ...cfg };
    localStorage.setItem(this.storageKey, JSON.stringify(this.config));
  }

  isConfigured() {
    this.config = this.loadConfig();
    const isDemo = this.isDemo();
    const key    = isDemo ? this.config.demoKey    : this.config.realKey;
    const secret = isDemo ? this.config.demoSecret : this.config.realSecret;
    return Boolean(key && key.length > 10 && secret && secret.length > 10);
  }

  isDemo() {
    this.config = this.loadConfig();
    return this.config.mode === 'demo';
  }

  // ─── Networking ─────────────────────────────────────────────────────────────

  getBaseUrl() {
    return this.isDemo()
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';
  }

  getWsUrl() {
    return this.isDemo()
      ? 'wss://testnet.binancefuture.com/ws-fapi/v1'
      : 'wss://ws-fapi.binance.com/ws-fapi/v1';
  }

  getApiKey() {
    this.config = this.loadConfig();
    const raw = this.isDemo() ? this.config.demoKey : this.config.realKey;
    return (raw || '').trim().replace(/\s+/g, '');
  }

  getSecret() {
    this.config = this.loadConfig();
    const raw = this.isDemo() ? this.config.demoSecret : this.config.realSecret;
    return (raw || '').trim().replace(/\s+/g, '');
  }

  // ─── Firma HMAC-SHA256 ───────────────────────────────────────────────────────

  async sign(queryString) {
    const enc       = new TextEncoder();
    const keyData   = enc.encode(this.getSecret());
    const msgData   = enc.encode(queryString);
    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
    return Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // ─── WebSocket API (sin CORS, funciona desde GitHub Pages) ──────────────────

  /**
   * Ejecuta una llamada a la WebSocket API de Binance Futures.
   * Los WebSockets no tienen restricciones CORS, funcionan desde cualquier origen.
   *
   * @param {string} wsMethod  - Método WS (ej: "order.place", "account.status")
   * @param {object} wsParams  - Parámetros SIN apiKey, timestamp ni signature (se agregan aquí)
   * @param {number} timeoutMs - Timeout en ms (default 10s)
   */
  async wsRequest(wsMethod, wsParams = {}, timeoutMs = 10000) {
    const apiKey   = this.getApiKey();
    const timestamp = Date.now();

    // Construir objeto de parámetros completo para firmar
    const params = { ...wsParams, apiKey, timestamp, recvWindow: 60000 };

    // Ordenar alfabéticamente y construir query string para firma
    const sorted = Object.keys(params).sort();
    const qs = sorted.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
    const signature = await this.sign(qs);

    const payload = {
      id:     crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
      method: wsMethod,
      params: { ...params, signature }
    };

    return new Promise((resolve, reject) => {
      const wsUrl = this.getWsUrl();
      let ws;

      try {
        ws = new WebSocket(wsUrl);
      } catch (e) {
        return reject(new Error(`WebSocket no disponible: ${e.message}`));
      }

      const timer = setTimeout(() => {
        try { ws.close(); } catch (_) {}
        reject(new Error(`WebSocket timeout (${timeoutMs}ms) en ${wsMethod}`));
      }, timeoutMs);

      ws.onopen = () => {
        ws.send(JSON.stringify(payload));
      };

      ws.onmessage = (event) => {
        clearTimeout(timer);
        try { ws.close(); } catch (_) {}
        try {
          const msg = JSON.parse(event.data);
          // Log completo para diagnóstico — visible en DevTools → Console
          console.log(`[WS ${wsMethod}] Respuesta raw:`, JSON.stringify(msg).slice(0, 400));

          if (msg.status === 200 && msg.result !== undefined) {
            console.log(`[WS ${wsMethod}] ✅ Éxito:`, msg.result);
            resolve(msg.result);
          } else if (msg.error) {
            console.error(`[WS ${wsMethod}] ❌ Error Binance:`, msg.error);
            reject(new Error(`Binance WS (${msg.error.code}): ${msg.error.msg}`));
          } else if (msg.status && msg.status !== 200) {
            console.error(`[WS ${wsMethod}] ❌ Status ${msg.status}:`, msg);
            reject(new Error(`Binance WS status ${msg.status}: ${JSON.stringify(msg)}`));
          } else {
            // Respuesta inesperada — loggear y rechazar para no dar falso positivo
            console.error(`[WS ${wsMethod}] ❌ Respuesta inesperada:`, msg);
            reject(new Error(`Binance WS respuesta inesperada: ${JSON.stringify(msg).slice(0, 200)}`));
          }
        } catch (e) {
          reject(new Error(`Error parseando respuesta WebSocket: ${e.message}`));
        }
      };

      ws.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error('Error de conexión WebSocket con Binance'));
      };

      ws.onclose = (event) => {
        clearTimeout(timer);
        if (event.code !== 1000 && event.code !== 1001) {
          // Cierre inesperado antes de recibir respuesta — puede ignorarse si ya resolvimos
        }
      };
    });
  }

  // ─── HTTP directo (Vercel como canal principal, localhost para desarrollo) ──

  async httpRequest(method, path, params = {}) {
    const apiKey    = this.getApiKey();
    const timestamp = Date.now();
    const allParams = { ...params, timestamp, recvWindow: 60000 };
    const qs = Object.entries(allParams)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const signature    = await this.sign(qs);
    const fullPayload  = `${qs}&signature=${signature}`;
    const baseUrl      = this.getBaseUrl();
    const proxyPrefix  = this.isDemo() ? '/proxy-binance-demo' : '/proxy-binance-real';
    const corsHeaders  = { 'X-MBX-APIKEY': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' };

    // ── Contexto de ejecución ────────────────────────────────────────────────
    const hostname = typeof window !== 'undefined' ? (window.location?.hostname || '') : '';
    const isOnNetlify = hostname.endsWith('netlify.app');
    const isOnVercel  = hostname.endsWith('vercel.app');
    const isHosted    = isOnNetlify || isOnVercel;
    const isLocal     = hostname === 'localhost' || hostname === '127.0.0.1' ||
                        hostname.startsWith('192.168.') || hostname.startsWith('10.');

    // ── URL de Proxy ─────────────────────────────────────────────────────────
    // Si estamos en Netlify o Vercel: usar ruta relativa '/proxy-binance-demo'
    // Si estamos en localhost: usar origin local en puerto 3000
    // Si estamos en GitHub Pages o PWA móvil: usar https://scanner-obb.netlify.app
    let proxyBase = '';
    if (isHosted) {
      proxyBase = '';
    } else if (isLocal) {
      proxyBase = window.location.origin.includes(':3000')
        ? window.location.origin
        : `${window.location.protocol}//${hostname}:3000`;
    } else {
      const customProxy = typeof localStorage !== 'undefined' ? (localStorage.getItem('proxy_url') || localStorage.getItem('vercel_proxy_url')) : null;
      proxyBase = customProxy || 'https://scanner-obb.netlify.app';
    }

    // ── Intento 1: Directo a Binance Futuros (Cuenta Real soporta CORS '*' nativo en <200ms) ──
    if (!this.isDemo()) {
      try {
        const directUrl = `${baseUrl}${path}?${fullPayload}`;
        const res = await fetch(directUrl, {
          method,
          headers: corsHeaders,
          signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined
        });
        const text = await res.text();
        if (text && !text.trim().startsWith('<') && !text.trim().startsWith('<!DOCTYPE')) {
          const data = JSON.parse(text);
          if (data?.code && data.code !== 200 && data.msg) {
            throw new Error(`Binance (${data.code}): ${data.msg}`);
          }
          console.log('[Trade] ✅ Directo Binance Futuros OK:', path);
          return data;
        }
      } catch (errDirect) {
        if (errDirect.message.startsWith('Binance')) throw errDirect;
        console.warn('[Trade] ⚠️ Directo Binance no disponible, usando proxy:', errDirect.message);
      }
    }

    // ── Intento 2: Proxy HTTP (Netlify Edge / Localhost / Vercel) ─────────────
    try {
      const res = await fetch(`${proxyBase}${proxyPrefix}${path}?${fullPayload}`, {
        method,
        headers: corsHeaders,
        signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
      });
      const text = await res.text();
      if (text && !text.trim().startsWith('<') && !text.trim().startsWith('<!DOCTYPE')) {
        let data;
        try {
          data = JSON.parse(text);
        } catch (_) {
          throw new Error(`Respuesta inválida del proxy: ${text.slice(0, 100)}`);
        }
        if (data?.code && data.code !== 200 && data.msg) {
          throw new Error(`Binance (${data.code}): ${data.msg}`);
        }
        console.log('[Trade] ✅ Proxy HTTP OK:', path);
        return data;
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`);
    } catch (err1) {
      if (err1.message.startsWith('Binance')) throw err1;
      console.warn('[Trade] ⚠️ Proxy primario falló:', err1.message);
    }

    // ── Intento 3: Fallback directo a endpoint /api/proxy de Netlify / Vercel ──
    try {
      const fallbackUrl = proxyBase
        ? `${proxyBase}/api/proxy?isDemo=${this.isDemo()}&endpoint=${encodeURIComponent(path)}&${fullPayload}`
        : `/api/proxy?isDemo=${this.isDemo()}&endpoint=${encodeURIComponent(path)}&${fullPayload}`;
      const res = await fetch(fallbackUrl, {
        method,
        headers: corsHeaders,
        signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
      });
      const text = await res.text();
      if (text && !text.trim().startsWith('<')) {
        const data = JSON.parse(text);
        if (data?.code && data.code !== 200 && data.msg) {
          throw new Error(`Binance (${data.code}): ${data.msg}`);
        }
        console.log('[Trade] ✅ Hosted fallback proxy OK');
        return data;
      }
    } catch (err2) {
      if (err2.message.startsWith('Binance')) throw err2;
      console.warn('[Trade] ⚠️ Hosted fallback proxy falló:', err2.message);
    }

    // ── Intento 4: Directo a Binance (último recurso) ────────────────────────
    try {
      const res = await fetch(`${baseUrl}${path}?${fullPayload}`, { method, headers: corsHeaders });
      const text = await res.text();
      if (text && !text.trim().startsWith('<') && !text.trim().startsWith('<!DOCTYPE')) {
        const data = JSON.parse(text);
        if (data?.code && data.code !== 200 && data.msg) throw new Error(`Binance (${data.code}): ${data.msg}`);
        console.log('[Trade] ✅ Directo Binance OK');
        return data;
      }
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    } catch (err3) {
      if (err3.message.startsWith('Binance')) throw err3;
      throw new Error(`Error de conexión con Binance (${err3.message})`);
    }
  }

  // ─── Router principal: WS API directo (CORS-free en móvil y GitHub Pages) ────

  async request(method, path, params = {}) {
    if (!this.isConfigured()) {
      throw new Error('API Keys no configuradas. Ve a ⚙️ Configurar API.');
    }

    // Detectar órdenes condicionales (Stop Loss o Take Profit condicional)
    // NOTA CRÍTICA: Binance WebSocket API (order.place) RECHAZA órdenes condicionales (-4120):
    // "Order type not supported for this endpoint. Please use the Algo Order API endpoints instead."
    // Las órdenes condicionales (STOP_MARKET, STOP, TAKE_PROFIT_MARKET) DEBEN ir obligatoriamente por HTTP Proxy REST.
    const isConditional = params.type === 'STOP_MARKET' || 
                          params.type === 'STOP' || 
                          params.type === 'TAKE_PROFIT_MARKET' || 
                          params.type === 'TAKE_PROFIT' ||
                          params.type === 'TRAILING_STOP_MARKET';

    // Endpoints que requieren autenticación → usar WebSocket API (sin CORS, funciona 100% en GitHub Pages y móvil)
    // EXCEPTO órdenes condicionales que van por HTTP REST
    const WS_ENDPOINTS = {
      'POST /fapi/v1/order':    'order.place',
      'DELETE /fapi/v1/order':  'order.cancel',
      'GET /fapi/v2/account':   'account.status'
    };

    const wsMethod = !isConditional ? WS_ENDPOINTS[`${method} ${path}`] : null;

    if (wsMethod) {
      try {
        const result = await this.wsRequest(wsMethod, params);
        console.log(`[Trade] ✅ WS OK: ${wsMethod}`);
        return result;
      } catch (wsErr) {
        console.warn(`[Trade] ⚠️ WS ${wsMethod} falló (${wsErr.message})`);
        if (wsErr.message.startsWith('Binance')) {
          throw wsErr;
        }
      }
    }

    // Para consultas no soportadas por WS (o condicionales como Stop Loss): usar HTTP Proxy REST
    return this.httpRequest(method, path, params);
  }

  // ─── Consulta de Cuenta ─────────────────────────────────────────────────────

  async getAccountBalance() {
    try {
      const data = await this.request('GET', '/fapi/v2/account');
      // WS devuelve array de assets directamente
      const assets = Array.isArray(data) ? data : data.assets;
      const usdt = assets?.find(a => a.asset === 'USDT');
      return usdt ? parseFloat(usdt.availableBalance || usdt.balance || 100) : 100;
    } catch (e) {
      return 100;
    }
  }

  async getOpenPositions() {
    if (!this.isConfigured()) return [];
    try {
      const data = await this.request('GET', '/fapi/v2/account');
      const rawPositions = Array.isArray(data?.positions)
        ? data.positions
        : (Array.isArray(data?.result?.positions) ? data.result.positions : (Array.isArray(data) ? data : []));

      return rawPositions
        .filter(p => p && parseFloat(p.positionAmt) !== 0)
        .map(p => {
          const amt = parseFloat(p.positionAmt);
          const entryPrice = parseFloat(p.entryPrice);
          const unPnl = parseFloat(p.unrealizedProfit || 0);
          const margin = parseFloat(p.initialMargin || p.positionInitialMargin || p.isolatedWallet || 0);
          const lev = parseFloat(p.leverage || 2);
          const roi = margin > 0 ? (unPnl / margin) * 100 : (entryPrice > 0 && Math.abs(amt) > 0 ? (unPnl / ((entryPrice * Math.abs(amt)) / lev)) * 100 : 0);
          return {
            symbol: p.symbol,
            side: amt > 0 ? 'LONG' : 'SHORT',
            amount: Math.abs(amt),
            entryPrice,
            unrealizedProfit: unPnl,
            margin,
            leverage: lev,
            roi
          };
        });
    } catch (e) {
      console.warn('[BinanceTrade] Error obteniendo posiciones:', e.message);
      return [];
    }
  }

  async getSymbolFilters(symbol) {
    const cleanSym = symbol.replace('/', '').toUpperCase();
    const defaultPricePrecisions = {
      'BTCUSDT': 1, 'ETHUSDT': 2, 'BNBUSDT': 2, 'SOLUSDT': 2, 'XRPUSDT': 4,
      'ADAUSDT': 4, 'AVAXUSDT': 2, 'LINKUSDT': 3, 'DOGEUSDT': 5, 'TONUSDT': 4,
      'DOTUSDT': 3, 'LTCUSDT': 2, 'NEARUSDT': 3, 'SUIUSDT': 4, 'APTUSDT': 3
    };
    const defaultStepSizes = {
      'BTCUSDT': 0.001, 'ETHUSDT': 0.001, 'BNBUSDT': 0.01, 'SOLUSDT': 0.01, 'XRPUSDT': 0.1,
      'ADAUSDT': 1, 'AVAXUSDT': 0.1, 'LINKUSDT': 0.01, 'DOGEUSDT': 1, 'TONUSDT': 0.1,
      'DOTUSDT': 0.1, 'LTCUSDT': 0.001, 'NEARUSDT': 0.1, 'SUIUSDT': 0.1, 'APTUSDT': 0.1
    };
    const defaultTickSizes = {
      'BTCUSDT': 0.1, 'ETHUSDT': 0.01, 'BNBUSDT': 0.01, 'SOLUSDT': 0.01, 'XRPUSDT': 0.0001,
      'ADAUSDT': 0.0001, 'AVAXUSDT': 0.01, 'LINKUSDT': 0.001, 'DOGEUSDT': 0.00001, 'TONUSDT': 0.0001,
      'DOTUSDT': 0.001, 'LTCUSDT': 0.01, 'NEARUSDT': 0.001, 'SUIUSDT': 0.0001, 'APTUSDT': 0.001
    };

    let priceDecimals = defaultPricePrecisions[cleanSym] !== undefined ? defaultPricePrecisions[cleanSym] : 4;
    let stepSize = defaultStepSizes[cleanSym] !== undefined ? defaultStepSizes[cleanSym] : 0.001;
    let tickSize = defaultTickSizes[cleanSym] !== undefined ? defaultTickSizes[cleanSym] : 0.01;
    let minQty = stepSize;

    try {
      // exchangeInfo es un GET público — no necesita autenticación
      const url = `${this.getBaseUrl()}/fapi/v1/exchangeInfo`;
      const res = await fetch(url);
      const data = await res.json();
      const info = data.symbols?.find(s => s.symbol === cleanSym);
      if (info) {
        const priceFilter = info.filters?.find(f => f.filterType === 'PRICE_FILTER');
        const lotFilter   = info.filters?.find(f => f.filterType === 'LOT_SIZE');
        if (priceFilter && priceFilter.tickSize) {
          tickSize = parseFloat(priceFilter.tickSize);
          if (tickSize > 0) priceDecimals = Math.max(0, -Math.floor(Math.log10(tickSize) + 0.00001));
        }
        if (lotFilter && lotFilter.stepSize) {
          stepSize = parseFloat(lotFilter.stepSize);
          minQty   = parseFloat(lotFilter.minQty || stepSize);
        }
      }
    } catch (e) {
      console.warn('[BinanceTrade] Usando filtros locales para', cleanSym);
    }

    const qtyDecimals = stepSize.toString().includes('.') ? stepSize.toString().split('.')[1].length : 0;
    return { priceDecimals, stepSize, tickSize, minQty, qtyDecimals };
  }

  formatPrice(price, tickSize, decimals) {
    const p = parseFloat(price);
    if (isNaN(p)) return '0';
    if (tickSize > 0) {
      const rounded = Math.round(p / tickSize) * tickSize;
      return rounded.toFixed(decimals);
    }
    return p.toFixed(decimals);
  }

  async getPositionMode() {
    try {
      const res = await this.httpRequest('GET', '/fapi/v1/positionSide/dual');
      if (res && typeof res.dualSidePosition === 'boolean') {
        return res.dualSidePosition ? 'HEDGE' : 'ONE_WAY';
      }
    } catch (_) {}
    return 'ONE_WAY';
  }

  // ─── Ejecución de Trade Completo ────────────────────────────────────────────

  async setLeverage(symbol, leverage) {
    const cleanSym = symbol.replace('/', '').toUpperCase();
    const isLocal = typeof window !== 'undefined' && 
      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    const isHosted = typeof window !== 'undefined' && 
      (window.location.hostname.endsWith('netlify.app') || window.location.hostname.endsWith('vercel.app'));
    
    // Leverage solo se puede enviar por HTTP; si no hay servidor local ni host con proxy, omitir para no demorar la orden
    if (!isLocal && !isHosted) {
      return { leverage };
    }
    return this.httpRequest('POST', '/fapi/v1/leverage', { symbol: cleanSym, leverage });
  }

  async executeTrade(signal, { leverage = 10, quantity = null } = {}) {
    const cleanSym  = signal.symbol.replace('/', '').toUpperCase();
    const isLong    = signal.type === 'LONG';
    const side      = isLong ? 'BUY' : 'SELL';
    const closeSide = isLong ? 'SELL' : 'BUY';

    // 1. Obtener filtros oficiales de precio y lote
    const filters = await this.getSymbolFilters(cleanSym);
    let tradeQty  = quantity;

    if (!tradeQty || isNaN(tradeQty)) {
      const balance  = await this.getAccountBalance();
      const riskUSDT = balance * (signal.riskPercent / 100);
      const riskDist = Math.abs(signal.entry - signal.stop);
      const posUSDT  = (riskUSDT / Math.max(0.0001, riskDist)) * signal.entry;
      tradeQty       = posUSDT / signal.entry;
    }

    // Redondeo exacto de cantidad a los decimales de lote permitidos
    const finalQty = parseFloat((Math.floor(tradeQty / filters.stepSize) * filters.stepSize).toFixed(filters.qtyDecimals));

    if (finalQty < filters.minQty) {
      throw new Error(`Cantidad (${finalQty}) menor al mínimo permitido (${filters.minQty} ${cleanSym.replace('USDT', '')}).`);
    }

    // 1b. Obtener precio actual de mercado directamente (GET público sin CORS) para validar SL
    let currentMarkPrice = null;
    try {
      const res = await fetch(`${this.getBaseUrl()}/fapi/v1/ticker/price?symbol=${cleanSym}`);
      if (res.ok) {
        const tickerData = await res.json();
        if (tickerData?.price) currentMarkPrice = parseFloat(tickerData.price);
      }
    } catch (_) {}
    if (!currentMarkPrice || isNaN(currentMarkPrice) || currentMarkPrice <= 0) {
      currentMarkPrice = parseFloat(signal.entry);
    }

    let finalStopPrice = parseFloat(signal.stop);
    if (currentMarkPrice && !isNaN(currentMarkPrice) && currentMarkPrice > 0) {
      if (isLong) {
        // En LONG (cierre SELL STOP), el stopPrice DEBE ser estrictamente menor que el precio de mercado
        if (finalStopPrice >= currentMarkPrice) {
          console.warn(`[Trade] ⚠️ Stop Loss (${finalStopPrice}) >= Precio mercado (${currentMarkPrice}). Ajustando por debajo para evitar error -2021.`);
          finalStopPrice = currentMarkPrice * 0.998;
        }
      } else {
        // En SHORT (cierre BUY STOP), el stopPrice DEBE ser estrictamente mayor que el precio de mercado
        if (finalStopPrice <= currentMarkPrice) {
          console.warn(`[Trade] ⚠️ Stop Loss (${finalStopPrice}) <= Precio mercado (${currentMarkPrice}). Ajustando por encima para evitar error -2021.`);
          finalStopPrice = currentMarkPrice * 1.002;
        }
      }
    }

    // Formatear precios con la cantidad exacta de decimales y múltiplo exacto de tickSize
    const formattedStop = this.formatPrice(finalStopPrice, filters.tickSize, filters.priceDecimals);
    const formattedTP   = this.formatPrice(signal.takeProfit, filters.tickSize, filters.priceDecimals);

    // 2. Comprobar modo de posición (Hedge o One-Way)
    const isDual = (await this.getPositionMode()) === 'HEDGE';
    const positionSide = isDual ? (isLong ? 'LONG' : 'SHORT') : 'BOTH';

    // 3. Establecer apalancamiento
    try {
      await this.setLeverage(cleanSym, leverage);
    } catch (levErr) {
      console.warn('[Trade] Leverage warning:', levErr.message);
    }

    // 4. Orden de Entrada (Market)
    const entryParams = {
      symbol: cleanSym,
      side,
      type: 'MARKET',
      quantity: finalQty
    };
    if (isDual) entryParams.positionSide = positionSide;

    const entryOrder = await this.request('POST', '/fapi/v1/order', entryParams);
    if (!entryOrder || (!entryOrder.orderId && !entryOrder.clientOrderId)) {
      throw new Error(`Binance no confirmó la orden de entrada: ${JSON.stringify(entryOrder)}`);
    }

    // Pequeña pausa para asegurar que el motor de Binance asentó la posición
    await new Promise(r => setTimeout(r, 300));

    let slOrderId  = null;
    let tpOrderId  = null;
    let slErrorMsg = null;
    let tpErrorMsg = null;

    // ─── 5. Stop Loss ─────────────────────────────────────────────────────────
    try {
      // Intento 1: STOP_MARKET con closePosition='true' (Estándar oficial Binance Futures One-Way)
      // En modo One-Way, closePosition='true' cierra el 100% de la posición sin necesidad
      // de calcular contratos ni riesgo de error -1106 (reduceOnly conflicto).
      const slParams = {
        symbol:        cleanSym,
        side:          closeSide,
        type:          'STOP_MARKET',
        stopPrice:     formattedStop,
        workingType:   'MARK_PRICE'
      };

      if (isDual) {
        slParams.positionSide = positionSide;
        slParams.quantity     = finalQty;
      } else {
        slParams.closePosition = 'true';
      }

      // Se usa httpRequest directamente (HTTP Proxy REST) porque Binance WS API no soporta STOP_MARKET (-4120)
      const slOrder = await this.httpRequest('POST', '/fapi/v1/order', slParams);
      slOrderId = slOrder.orderId || slOrder.clientOrderId || 'SL_OK';
      console.log('[Trade] ✅ SL colocado en Binance (STOP_MARKET closePosition):', slOrderId);
    } catch (slErr) {
      console.warn('[Trade] SL Intento 1 falló:', slErr.message, '→ evaluando alternativas...');
      slErrorMsg = slErr.message;

      // Si el fallo fue por trigger inmediato (-2021), recalcular con margen de seguridad del 0.5%
      let safeStopPrice = formattedStop;
      if (slErr.message.includes('-2021') || slErr.message.toLowerCase().includes('immediately')) {
        const buffer = 0.005;
        const safeNum = isLong ? currentMarkPrice * (1 - buffer) : currentMarkPrice * (1 + buffer);
        safeStopPrice = this.formatPrice(safeNum, filters.tickSize, filters.priceDecimals);
        console.log(`[Trade] 🔄 Reintentando SL con precio seguro (-2021): ${safeStopPrice}`);
      }

      // Intento 2 (Fallback): STOP_MARKET con cantidad explícita y reduceOnly
      try {
        const slQtyParams = {
          symbol:        cleanSym,
          side:          closeSide,
          type:          'STOP_MARKET',
          stopPrice:     safeStopPrice,
          quantity:      finalQty,
          reduceOnly:    'true',
          workingType:   'MARK_PRICE'
        };
        if (isDual) {
          delete slQtyParams.reduceOnly;
          slQtyParams.positionSide = positionSide;
        }
        const slOrder2 = await this.httpRequest('POST', '/fapi/v1/order', slQtyParams);
        slOrderId = slOrder2.orderId || slOrder2.clientOrderId || 'SL_OK';
        console.log('[Trade] ✅ SL colocado (STOP_MARKET reduceOnly):', slOrderId);
        slErrorMsg = null;
      } catch (e2) {
        console.warn('[Trade] SL Intento 2 reduceOnly falló:', e2.message);
        slErrorMsg = e2.message;
      }

      // Intento 3 (Fallback): Orden STOP (Stop Limit)
      if (!slOrderId) {
        try {
          const slLimitParams = {
            symbol:        cleanSym,
            side:          closeSide,
            type:          'STOP',
            stopPrice:     safeStopPrice,
            price:         safeStopPrice,
            quantity:      finalQty,
            reduceOnly:    'true',
            timeInForce:   'GTC',
            workingType:   'MARK_PRICE'
          };
          if (isDual) {
            delete slLimitParams.reduceOnly;
            slLimitParams.positionSide = positionSide;
          }
          const slOrder3 = await this.httpRequest('POST', '/fapi/v1/order', slLimitParams);
          slOrderId = slOrder3.orderId || slOrder3.clientOrderId || 'SL_OK';
          console.log('[Trade] ✅ SL colocado (STOP Limit):', slOrderId);
          slErrorMsg = null;
        } catch (e3) {
          console.error('[Trade SL Error definitivo en Binance]', e3.message);
          slErrorMsg = e3.message;
        }
      }

      // Red de Seguridad de Software Local (Emergency Watcher)
      // Si Binance rechazó el SL nativo, activamos el vigilante local para no dejar la posición desprotegida
      if (!slOrderId) {
        console.warn(`[Trade] 🛡️ Activando Stop Loss de Software Local para ${cleanSym} en ${finalStopPrice}`);
        this.registerLocalSL(cleanSym, closeSide, finalQty, finalStopPrice, isLong);
        slOrderId = 'LOCAL_SL_ACTIVO';
        slErrorMsg = null;
      }
    }

    // ─── 6. Take Profit ───────────────────────────────────────────────────────
    // TP usa LIMIT GTC con reduceOnly:true colocado en el libro de órdenes (Maker order sin costo extra)
    try {
      const tpParams = {
        symbol:      cleanSym,
        side:        closeSide,
        type:        'LIMIT',
        price:       formattedTP,
        quantity:    finalQty,
        reduceOnly:  true,
        timeInForce: 'GTC'
      };
      if (isDual) {
        delete tpParams.reduceOnly;
        tpParams.positionSide = positionSide;
      }

      const tpOrder = await this.request('POST', '/fapi/v1/order', tpParams);
      tpOrderId = tpOrder.orderId || tpOrder.clientOrderId || 'TP_OK';
      console.log('[Trade] ✅ TP colocado (LIMIT GTC):', tpOrderId);
    } catch (tpErr) {
      console.warn('[Trade] TP LIMIT GTC falló:', tpErr.message, '→ probando TAKE_PROFIT_MARKET por HTTP...');
      try {
        const tpMkt = {
          symbol:      cleanSym,
          side:        closeSide,
          type:        'TAKE_PROFIT_MARKET',
          stopPrice:   formattedTP,
          quantity:    finalQty,
          reduceOnly:  'true',
          workingType: 'MARK_PRICE'
        };
        if (isDual) {
          delete tpMkt.reduceOnly;
          tpMkt.positionSide = positionSide;
        }
        const tpOrder2 = await this.httpRequest('POST', '/fapi/v1/order', tpMkt);
        tpOrderId = tpOrder2.orderId || tpOrder2.clientOrderId || 'TP_OK';
        console.log('[Trade] ✅ TP colocado (TAKE_PROFIT_MARKET):', tpOrderId);
      } catch (e2) {
        tpErrorMsg = `TP (${e2.message})`;
        console.error('[Trade TP Error definitivo]', e2.message);
      }
    }


    return {
      mode:         this.config.mode,
      symbol:       cleanSym,
      type:         signal.type,
      quantity:     finalQty,
      leverage,
      entryPrice:   signal.entry,
      stopPrice:    formattedStop,
      takeProfit:   formattedTP,
      entryOrderId: entryOrder.orderId,
      slOrderId,
      tpOrderId,
      slErrorMsg,
      tpErrorMsg
    };
  }

  /**
   * Mueve el Stop Loss en Binance automáticamente a Breakeven (+0.1% fees)
   */
  async moveToBreakeven(symbol, entryPrice, type) {
    if (!this.isConfigured()) return false;
    const cleanSym = symbol.replace('/', '').toUpperCase();
    const isLong   = type === 'LONG';
    const closeSide = isLong ? 'SELL' : 'BUY';
    const filters  = await this.getSymbolFilters(cleanSym);

    const isDual = (await this.getPositionMode()) === 'HEDGE';
    const positionSide = isDual ? (isLong ? 'LONG' : 'SHORT') : 'BOTH';

    const bePriceNum = isLong ? entryPrice * 1.0008 : entryPrice * 0.9992;
    const bePrice    = bePriceNum.toFixed(filters.priceDecimals);

    try {
      // 1. Cancelar órdenes de Stop Loss previas (órdenes estándar abiertas)
      try {
        const openOrders = await this.request('GET', '/fapi/v1/openOrders', { symbol: cleanSym });
        if (Array.isArray(openOrders)) {
          for (const ord of openOrders) {
            if (ord.type === 'STOP_MARKET') {
              await this.request('DELETE', '/fapi/v1/order', { symbol: cleanSym, orderId: ord.orderId });
            }
          }
        }
      } catch (delErr) {}

      // 2. Colocar nuevo Stop Loss a Breakeven via orden estándar → WebSocket
      const beParams = {
        symbol:        cleanSym,
        side:          closeSide,
        type:          'STOP_MARKET',
        stopPrice:     bePrice,
        closePosition: 'true',
        workingType:   'MARK_PRICE'
      };
      if (isDual) beParams.positionSide = positionSide;

      const slOrder = await this.request('POST', '/fapi/v1/order', beParams);
      console.log('[Trade] ✅ BE SL colocado:', slOrder.orderId);
      return slOrder;
    } catch (e) {
      console.warn('[BinanceTrade] Error moviendo a BE:', e.message);
      return false;
    }
  }

  // ─── Red de Seguridad: Stop Loss de Software Local ──────────────────────────

  registerLocalSL(symbol, closeSide, quantity, stopPrice, isLong) {
    if (!this.activeLocalSLs) this.activeLocalSLs = new Map();
    const key = symbol.toUpperCase();
    this.activeLocalSLs.set(key, {
      symbol: key,
      closeSide,
      quantity,
      stopPrice: parseFloat(stopPrice),
      isLong,
      triggered: false
    });
    console.log(`[Local SL] 🛡️ Registrado Stop Loss de software para ${key} a precio ${stopPrice}`);
  }

  unregisterLocalSL(symbol) {
    if (this.activeLocalSLs) {
      this.activeLocalSLs.delete(symbol.toUpperCase());
    }
  }

  checkLocalSL(symbol, currentPrice) {
    if (!this.activeLocalSLs || !this.activeLocalSLs.has(symbol.toUpperCase())) return;
    const sl = this.activeLocalSLs.get(symbol.toUpperCase());
    if (sl.triggered) return;

    const p = parseFloat(currentPrice);
    if (!p || isNaN(p) || p <= 0) return;

    let shouldTrigger = false;
    if (sl.isLong && p <= sl.stopPrice) {
      shouldTrigger = true;
    } else if (!sl.isLong && p >= sl.stopPrice) {
      shouldTrigger = true;
    }

    if (shouldTrigger) {
      sl.triggered = true;
      console.warn(`[Local SL] 🚨 Stop Loss alcanzado para ${sl.symbol} (Precio: ${p}, Stop: ${sl.stopPrice}). Ejecutando cierre de mercado inmediato...`);
      if (typeof window !== 'undefined' && window.showToast) {
        window.showToast(`🚨 SL alcanzado en ${sl.symbol} (${p}). Cerrando posición...`, 'warning');
      }
      const params = {
        symbol: sl.symbol,
        side: sl.closeSide,
        type: 'MARKET',
        quantity: sl.quantity,
        reduceOnly: 'true'
      };
      this.wsRequest('order.place', params)
        .then(() => {
          this.activeLocalSLs.delete(symbol.toUpperCase());
          if (typeof window !== 'undefined' && window.showToast) {
            window.showToast(`🛡️ Posición ${sl.symbol} cerrada exitosamente por Stop Loss`, 'success');
          }
        })
        .catch(err => {
          console.error(`[Local SL Error] Fallo al cerrar posición:`, err);
        });
    }
  }
}

window.BinanceTrade = BinanceTrade;

