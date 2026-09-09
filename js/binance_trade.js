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

  // ─── HTTP directo (para GETs públicos + fallback en PC con localhost) ─────────

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
    const targetHost   = this.isDemo() ? 'testnet.binancefuture.com' : 'fapi.binance.com';
    const proxyPrefix  = this.isDemo() ? '/proxy-binance-demo' : '/proxy-binance-real';
    const corsHeaders  = { 'X-MBX-APIKEY': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' };

    // Intento 1: Localhost (Chrome/Firefox permiten HTTP→localhost desde páginas HTTPS)
    const isLocalCtx = typeof window !== 'undefined' && (
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname.startsWith('192.168.') ||
      window.location.hostname.startsWith('10.') ||
      window.location.port === '3000'
    );

    if (isLocalCtx) {
      try {
        const origin = window.location.origin.includes(':3000')
          ? window.location.origin
          : `${window.location.protocol}//${window.location.hostname}:3000`;
        const res  = await fetch(`${origin}${proxyPrefix}${path}?${fullPayload}`, {
          method, headers: { 'X-MBX-APIKEY': apiKey, 'X-Target-Host': targetHost }
        });
        const text = await res.text();
        if (res.ok && text && !text.trim().startsWith('<')) return JSON.parse(text);
      } catch (_) {}
    }

    // Intento 2: localhost:3000 desde cualquier página (Chrome permite llamadas a localhost desde HTTPS)
    try {
      const res  = await fetch(`http://localhost:3000${proxyPrefix}${path}?${fullPayload}`, {
        method, headers: { 'X-MBX-APIKEY': apiKey, 'X-Target-Host': targetHost },
        signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined
      });
      const text = await res.text();
      if (res.ok && text && !text.trim().startsWith('<')) {
        console.log('[Trade] ✅ localhost:3000 proxy OK');
        return JSON.parse(text);
      }
    } catch (_) {}

    // Intento 3: Vercel proxy (funciona desde móvil y PC, sin CORS)
    // El usuario configura la URL en ⚙️ → campo "Vercel Proxy"
    const vercelBase = typeof localStorage !== 'undefined' && localStorage.getItem('vercel_proxy_url');
    if (vercelBase) {
      try {
        const vercelUrl = `${vercelBase}${proxyPrefix}${path}?${fullPayload}`;
        console.log('[Trade] 🔄 Intentando Vercel proxy:', vercelUrl.split('?')[0]);
        const res  = await fetch(vercelUrl, {
          method,
          headers: { 'X-MBX-APIKEY': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
        });
        const text = await res.text();
        if (text && !text.trim().startsWith('<')) {
          const data = JSON.parse(text);
          if (data && data.code && data.code !== 200 && data.msg) {
            throw new Error(`Binance (${data.code}): ${data.msg}`);
          }
          console.log('[Trade] ✅ Vercel proxy OK');
          return data;
        }
      } catch (vercelErr) {
        if (vercelErr.message.startsWith('Binance')) throw vercelErr;
        console.warn('[Trade] ⚠️ Vercel proxy falló:', vercelErr.message);
      }
    }

    // Intento 4: Directo a Binance (GET sin problemas de CORS, POST puede fallar)
    try {
      const res  = await fetch(`${baseUrl}${path}?${fullPayload}`, { method, headers: corsHeaders });
      const text = await res.text();
      if (text && !text.trim().startsWith('<') && !text.trim().startsWith('<!DOCTYPE')) {
        const data = JSON.parse(text);
        if (data && data.code && data.code !== 200 && data.msg) {
          throw new Error(`Binance (${data.code}): ${data.msg}`);
        }
        console.log('[Trade] ✅ Directo Binance OK');
        return data;
      }
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    } catch (err) {
      throw new Error(`Error de conexión con Binance (${err.message})`);
    }
  }

  // ─── Router principal: WS para órdenes autenticadas, HTTP para consultas ─────

  async request(method, path, params = {}) {
    if (!this.isConfigured()) {
      throw new Error('API Keys no configuradas. Ve a ⚙️ Configurar API.');
    }

    // Endpoints que requieren POST/DELETE autenticado → usar WebSocket API (sin CORS)
    const WS_ENDPOINTS = {
      'POST /fapi/v1/order':              'order.place',
      'DELETE /fapi/v1/order':            'order.cancel',
      'POST /fapi/v1/leverage':           'account.changeInitialLeverage',
      'GET /fapi/v2/account':             'account.status',
      'GET /fapi/v1/positionSide/dual':   'account.getPositionSideDual',
    };

    const wsMethod = WS_ENDPOINTS[`${method} ${path}`];

    if (wsMethod) {
      try {
        const result = await this.wsRequest(wsMethod, params);
        console.log(`[Trade] ✅ WS OK: ${wsMethod}`);
        return result;
      } catch (wsErr) {
        console.warn(`[Trade] ⚠️ WS ${wsMethod} falló (${wsErr.message}), intentando HTTP...`);
        // Si el error es de Binance (no de conexión), lanzarlo directamente
        if (wsErr.message.startsWith('Binance')) throw wsErr;
        // Si es error de conexión WS, caer al HTTP como respaldo
      }
    }

    // Para todo lo demás (GET públicos, algoOrders, etc.): usar HTTP directo
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
      const data = await this.request('GET', '/fapi/v1/positionSide/dual');
      return data && data.dualSidePosition === true ? 'HEDGE' : 'ONE_WAY';
    } catch (e) {
      return 'ONE_WAY';
    }
  }

  // ─── Ejecución de Trade Completo ────────────────────────────────────────────

  async setLeverage(symbol, leverage) {
    const cleanSym = symbol.replace('/', '').toUpperCase();
    return this.request('POST', '/fapi/v1/leverage', { symbol: cleanSym, leverage });
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

    // Formatear precios con la cantidad exacta de decimales y múltiplo exacto de tickSize
    const formattedStop = this.formatPrice(signal.stop, filters.tickSize, filters.priceDecimals);
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
    // REGLA BINANCE: Solo puede existir UNA orden "closePosition" por posición.
    // SL usa closePosition:true (cierra todo). TP usa reduceOnly:true + quantity (coexisten).
    // CRÍTICO: reduceOnly y closePosition deben ser BOOLEAN true, no string 'true'
    try {
      const slParams = {
        symbol:        cleanSym,
        side:          closeSide,
        type:          'STOP_MARKET',
        stopPrice:     formattedStop,
        closePosition: true,          // ← BOOLEAN, no string
        workingType:   'MARK_PRICE'
      };
      if (isDual) slParams.positionSide = positionSide;

      const slOrder = await this.request('POST', '/fapi/v1/order', slParams);
      slOrderId = slOrder.orderId || slOrder.clientOrderId || 'SL_OK';
      console.log('[Trade] ✅ SL colocado (closePosition):', slOrderId);
    } catch (slErr) {
      console.warn('[Trade] SL closePosition falló:', slErr.message, '→ probando reduceOnly...');
      // Fallback: reduceOnly:true con cantidad (boolean correcto)
      try {
        const slFallback = {
          symbol:      cleanSym,
          side:        closeSide,
          type:        'STOP_MARKET',
          stopPrice:   formattedStop,
          quantity:    finalQty,
          workingType: 'MARK_PRICE'
        };
        if (isDual) {
          slFallback.positionSide = positionSide;
        } else {
          slFallback.reduceOnly = true;   // ← BOOLEAN, no string
        }
        const slOrder2 = await this.request('POST', '/fapi/v1/order', slFallback);
        slOrderId = slOrder2.orderId || slOrder2.clientOrderId || 'SL_OK';
        console.log('[Trade] ✅ SL colocado (reduceOnly):', slOrderId);
      } catch (e2) {
        slErrorMsg = `SL (${e2.message})`;
        console.error('[Trade SL Error definitivo]', e2.message);
      }
    }

    // ─── 6. Take Profit ───────────────────────────────────────────────────────
    // TP usa reduceOnly:true + quantity → coexiste con el SL closePosition
    // CRÍTICO: reduceOnly debe ser BOOLEAN true, no string 'true'
    try {
      const tpParams = {
        symbol:      cleanSym,
        side:        closeSide,
        type:        'TAKE_PROFIT_MARKET',
        stopPrice:   formattedTP,
        quantity:    finalQty,
        workingType: 'MARK_PRICE'
      };
      if (isDual) {
        tpParams.positionSide = positionSide;
      } else {
        tpParams.reduceOnly = true;   // ← BOOLEAN, no string
      }

      const tpOrder = await this.request('POST', '/fapi/v1/order', tpParams);
      tpOrderId = tpOrder.orderId || tpOrder.clientOrderId || 'TP_OK';
      console.log('[Trade] ✅ TP colocado (TAKE_PROFIT_MARKET):', tpOrderId);
    } catch (tpErr) {
      console.warn('[Trade] TP MARKET falló:', tpErr.message, '→ probando LIMIT GTC...');
      // Fallback: LIMIT GTC con reduceOnly boolean
      try {
        const tpFallback = {
          symbol:      cleanSym,
          side:        closeSide,
          type:        'LIMIT',
          price:       formattedTP,
          quantity:    finalQty,
          timeInForce: 'GTC'
        };
        if (isDual) {
          tpFallback.positionSide = positionSide;
        } else {
          tpFallback.reduceOnly = true;   // ← BOOLEAN, no string
        }
        const tpOrder2 = await this.request('POST', '/fapi/v1/order', tpFallback);
        tpOrderId = tpOrder2.orderId || tpOrder2.clientOrderId || 'TP_OK';
        console.log('[Trade] ✅ TP colocado (LIMIT GTC):', tpOrderId);
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
}

window.BinanceTrade = BinanceTrade;
