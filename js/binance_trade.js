/**
 * Binance Trade Executor — Motor de Ejecución Directa de Órdenes
 * 
 * SEGURIDAD:
 * - Las claves API NUNCA se escriben en el código fuente.
 * - Se almacenan SOLO en el localStorage del dispositivo del usuario.
 * - Se firma cada petición con HMAC-SHA256 usando la Web Crypto API del navegador.
 * - Las claves NUNCA se envían a ningún servidor externo propio.
 */
class BinanceTrade {
  constructor() {
    this.storageKey = 'smc_api_config_v1';
    this.config = this.loadConfig();
  }

  // ─── Persistencia ───────────────────────────────────────────────────────────

  loadConfig() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      const cfg = raw ? JSON.parse(raw) : this.defaultConfig();
      // Si el usuario configuró claves reales pero no de demo, activar modo real automáticamente
      if (cfg.mode === 'demo' && (!cfg.demoKey || cfg.demoKey.length < 10) && cfg.realKey && cfg.realKey.length > 10) {
        cfg.mode = 'real';
      }
      return cfg;
    } catch (e) {
      return this.defaultConfig();
    }
  }

  defaultConfig() {
    return { mode: 'real', demoKey: '', demoSecret: '', realKey: '', realSecret: '' };
  }

  saveConfig(cfg) {
    this.config = { ...this.loadConfig(), ...cfg };
    localStorage.setItem(this.storageKey, JSON.stringify(this.config));
  }

  isConfigured() {
    this.config = this.loadConfig();
    const key    = this.config.mode === 'demo' ? this.config.demoKey    : this.config.realKey;
    const secret = this.config.mode === 'demo' ? this.config.demoSecret : this.config.realSecret;
    return key && key.length > 10 && secret && secret.length > 10;
  }

  isDemo() {
    this.config = this.loadConfig();
    return this.config.mode === 'demo';
  }

  // ─── Networking ─────────────────────────────────────────────────────────────

  getBaseUrl() {
    this.config = this.loadConfig();
    return this.config.mode === 'demo'
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';
  }

  getApiKey()  {
    this.config = this.loadConfig();
    const raw = this.config.mode === 'demo' ? this.config.demoKey : this.config.realKey;
    return (raw || '').trim().replace(/\s+/g, '');
  }
  getSecret()  {
    this.config = this.loadConfig();
    const raw = this.config.mode === 'demo' ? this.config.demoSecret : this.config.realSecret;
    return (raw || '').trim().replace(/\s+/g, '');
  }

  async sign(queryString) {
    const enc     = new TextEncoder();
    const keyData = enc.encode(this.getSecret());
    const msgData = enc.encode(queryString);
    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
    return Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async request(method, path, params = {}) {
    if (!this.isConfigured()) {
      throw new Error('API Keys no configuradas. Ve a ⚙️ Configurar API.');
    }

    const apiKey = this.getApiKey();
    const timestamp = Date.now();
    const allParams = { ...params, apiKey, timestamp };
    const qs = Object.entries(allParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const signature = await this.sign(qs);
    const fullPayload = `${qs}&signature=${signature}`;

    const isDemo = this.isDemo();
    const isFile = typeof window !== 'undefined' && window.location && window.location.protocol === 'file:';
    const proxyPrefix = isDemo ? '/proxy-binance-demo' : '/proxy-binance-real';
    const targetHost  = isDemo ? 'testnet.binancefuture.com' : 'fapi.binance.com';
    const directBase  = this.getBaseUrl();

    let data = null;
    let isSuccess = false;
    let lastStatusCode = 0;

    // 1. Intento Directo Nativo Simple Request (CORS universal sin preflight OPTIONS)
    try {
      let fetchUrl = `${directBase}${path}`;
      const fetchOptions = { method };

      if (method === 'GET' || method === 'DELETE') {
        fetchUrl += `?${fullPayload}`;
      } else {
        fetchOptions.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        fetchOptions.body = fullPayload;
      }

      const res = await fetch(fetchUrl, fetchOptions);
      lastStatusCode = res.status;
      const text = await res.text();

      if (text && !text.trim().startsWith('<') && !text.trim().startsWith('<!DOCTYPE')) {
        try {
          data = JSON.parse(text);
          isSuccess = true;
        } catch (e) {}
      }
    } catch (err) {
      console.warn('[Trade] Intento directo sin headers falló:', err.message);
    }

    // 2. Intento Directo con Header X-MBX-APIKEY
    if (!isSuccess) {
      try {
        const fetchUrl = `${directBase}${path}?${fullPayload}`;
        const res = await fetch(fetchUrl, {
          method,
          headers: { 'X-MBX-APIKEY': apiKey }
        });
        lastStatusCode = res.status;
        const text = await res.text();

        if (text && !text.trim().startsWith('<') && !text.trim().startsWith('<!DOCTYPE')) {
          try {
            data = JSON.parse(text);
            isSuccess = true;
          } catch (e) {}
        }
      } catch (err) {
        console.warn('[Trade] Intento con headers falló:', err.message);
      }
    }

    // 3. Intento Localhost Proxy (si se ejecuta en entorno local)
    if (!isSuccess && isFile) {
      try {
        const localUrl = `http://localhost:3000${proxyPrefix}${path}?${fullPayload}`;
        const res = await fetch(localUrl, {
          method,
          headers: { 'X-MBX-APIKEY': apiKey, 'X-Target-Host': targetHost }
        });
        lastStatusCode = res.status;
        const text = await res.text();

        if (text && !text.trim().startsWith('<')) {
          try {
            data = JSON.parse(text);
            isSuccess = true;
          } catch (e) {}
        }
      } catch (err) {}
    }

    if (!isSuccess || !data) {
      throw new Error(`Error de conexión con Binance (${lastStatusCode || 500}). Verifica tus claves API en ⚙️ Configurar API.`);
    }

    if (data && data.code && data.code !== 200 && data.msg) {
      throw new Error(`Binance: ${data.msg} (código ${data.code})`);
    }

    return data;
  }

  // ─── Consulta de Cuenta ─────────────────────────────────────────────────────

  async getAccountBalance() {
    try {
      const data = await this.request('GET', '/fapi/v2/account');
      const usdt = data.assets?.find(a => a.asset === 'USDT');
      return usdt ? parseFloat(usdt.availableBalance) : 100;
    } catch (e) {
      return 100;
    }
  }

  async getSymbolFilters(symbol) {
    const cleanSym = symbol.replace('/', '').toUpperCase();
    const defaultPricePrecisions = {
      'BTCUSDT': 2, 'ETHUSDT': 2, 'BNBUSDT': 2, 'SOLUSDT': 2, 'XRPUSDT': 4,
      'ADAUSDT': 4, 'AVAXUSDT': 2, 'LINKUSDT': 3, 'DOGEUSDT': 5, 'TONUSDT': 4,
      'DOTUSDT': 4, 'LTCUSDT': 2, 'NEARUSDT': 3, 'SUIUSDT': 4, 'APTUSDT': 3
    };
    const defaultStepSizes = {
      'BTCUSDT': 0.001, 'ETHUSDT': 0.001, 'BNBUSDT': 0.01, 'SOLUSDT': 0.01, 'XRPUSDT': 0.1,
      'ADAUSDT': 1, 'AVAXUSDT': 0.1, 'LINKUSDT': 0.01, 'DOGEUSDT': 1, 'TONUSDT': 0.1,
      'DOTUSDT': 0.1, 'LTCUSDT': 0.001, 'NEARUSDT': 0.1, 'SUIUSDT': 0.1, 'APTUSDT': 0.1
    };

    let priceDecimals = defaultPricePrecisions[cleanSym] !== undefined ? defaultPricePrecisions[cleanSym] : 4;
    let stepSize = defaultStepSizes[cleanSym] !== undefined ? defaultStepSizes[cleanSym] : 0.001;
    let minQty = stepSize;

    try {
      const data = await this.request('GET', '/fapi/v1/exchangeInfo');
      const info = data.symbols?.find(s => s.symbol === cleanSym);
      if (info) {
        const priceFilter = info.filters?.find(f => f.filterType === 'PRICE_FILTER');
        const lotFilter   = info.filters?.find(f => f.filterType === 'LOT_SIZE');
        if (priceFilter && priceFilter.tickSize) {
          const tick = parseFloat(priceFilter.tickSize);
          if (tick > 0) priceDecimals = Math.max(0, -Math.floor(Math.log10(tick)));
        }
        if (lotFilter && lotFilter.stepSize) {
          stepSize = parseFloat(lotFilter.stepSize);
          minQty = parseFloat(lotFilter.minQty || stepSize);
        }
      }
    } catch (e) {
      console.warn('[BinanceTrade] Usando filtros locales para', cleanSym);
    }

    const qtyDecimals = stepSize.toString().includes('.') ? stepSize.toString().split('.')[1].length : 0;
    return { priceDecimals, stepSize, minQty, qtyDecimals };
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

    // Formatear precios con la cantidad exacta de decimales permitidos por Binance
    const formattedStop = Number(signal.stop).toFixed(filters.priceDecimals);
    const formattedTP   = Number(signal.takeProfit).toFixed(filters.priceDecimals);

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

    let slOrderId = null;
    let tpOrderId = null;
    let slErrorMsg = null;
    let tpErrorMsg = null;

    // 5. Stop Loss via Algo Order API (/fapi/v1/algoOrder)
    const slParams = {
      algoType: 'CONDITIONAL',
      symbol: cleanSym,
      side: closeSide,
      type: 'STOP_MARKET',
      triggerPrice: formattedStop,
      workingType: 'MARK_PRICE',
      quantity: finalQty
    };
    if (isDual) {
      slParams.positionSide = positionSide;
    } else {
      slParams.reduceOnly = 'true';
    }

    try {
      const slOrder = await this.request('POST', '/fapi/v1/algoOrder', slParams);
      slOrderId = slOrder.algoId || slOrder.orderId || 'ALGO_SL';
    } catch (slErr) {
      console.warn('[Trade SL Fallback closePosition]', slErr.message);
      try {
        const slParams2 = {
          algoType: 'CONDITIONAL',
          symbol: cleanSym,
          side: closeSide,
          type: 'STOP_MARKET',
          triggerPrice: formattedStop,
          workingType: 'MARK_PRICE',
          closePosition: 'true'
        };
        if (isDual) slParams2.positionSide = positionSide;
        const slOrder2 = await this.request('POST', '/fapi/v1/algoOrder', slParams2);
        slOrderId = slOrder2.algoId || slOrder2.orderId || 'ALGO_SL';
      } catch (e2) {
        slErrorMsg = e2.message;
        console.error('[Trade SL Error]', e2.message);
      }
    }

    // 6. Take Profit Final 1:3 via Algo Order API (/fapi/v1/algoOrder)
    const tpParams = {
      algoType: 'CONDITIONAL',
      symbol: cleanSym,
      side: closeSide,
      type: 'TAKE_PROFIT_MARKET',
      triggerPrice: formattedTP,
      workingType: 'MARK_PRICE',
      quantity: finalQty
    };
    if (isDual) {
      tpParams.positionSide = positionSide;
    } else {
      tpParams.reduceOnly = 'true';
    }

    try {
      const tpOrder = await this.request('POST', '/fapi/v1/algoOrder', tpParams);
      tpOrderId = tpOrder.algoId || tpOrder.orderId || 'ALGO_TP';
    } catch (tpErr) {
      console.warn('[Trade TP Fallback closePosition]', tpErr.message);
      try {
        const tpParams2 = {
          algoType: 'CONDITIONAL',
          symbol: cleanSym,
          side: closeSide,
          type: 'TAKE_PROFIT_MARKET',
          triggerPrice: formattedTP,
          workingType: 'MARK_PRICE',
          closePosition: 'true'
        };
        if (isDual) tpParams2.positionSide = positionSide;
        const tpOrder2 = await this.request('POST', '/fapi/v1/algoOrder', tpParams2);
        tpOrderId = tpOrder2.algoId || tpOrder2.orderId || 'ALGO_TP';
      } catch (e2) {
        tpErrorMsg = e2.message;
        console.error('[Trade TP Error]', e2.message);
      }
    }

    return {
      mode: this.config.mode,
      symbol: cleanSym,
      type: signal.type,
      quantity: finalQty,
      leverage,
      entryPrice: signal.entry,
      stopPrice: formattedStop,
      takeProfit: formattedTP,
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
    const isLong = type === 'LONG';
    const closeSide = isLong ? 'SELL' : 'BUY';
    const filters = await this.getSymbolFilters(cleanSym);

    const isDual = (await this.getPositionMode()) === 'HEDGE';
    const positionSide = isDual ? (isLong ? 'LONG' : 'SHORT') : 'BOTH';

    const bePriceNum = isLong ? entryPrice * 1.0008 : entryPrice * 0.9992;
    const bePrice = bePriceNum.toFixed(filters.priceDecimals);

    try {
      // 1. Cancelar órdenes de Stop Loss previas en Algo Orders
      try {
        const openAlgos = await this.request('GET', '/fapi/v1/openAlgoOrders', { symbol: cleanSym });
        if (Array.isArray(openAlgos)) {
          for (const ord of openAlgos) {
            if (ord.algoType === 'STOP_MARKET' || ord.type === 'STOP_MARKET') {
              await this.request('DELETE', '/fapi/v1/algoOrder', { algoId: ord.algoId });
            }
          }
        }
      } catch (delErr) {}

      // 2. Colocar nuevo Stop Loss a Breakeven via Algo API
      const beParams = {
        algoType: 'CONDITIONAL',
        symbol: cleanSym,
        side: closeSide,
        type: 'STOP_MARKET',
        triggerPrice: bePrice,
        closePosition: 'true',
        workingType: 'MARK_PRICE'
      };
      if (isDual) beParams.positionSide = positionSide;

      const slOrder = await this.request('POST', '/fapi/v1/algoOrder', beParams);
      return slOrder;
    } catch (e) {
      console.warn('[BinanceTrade] Error moviendo a BE:', e.message);
      return false;
    }
  }
}

window.BinanceTrade = BinanceTrade;
