/**
 * Binance API Client - Enterprise Grade
 * Soporta:
 * 1. Auto-reconexión automática con backoff exponencial.
 * 2. Cierre seguro de sockets sin condiciones de carrera.
 * 3. Watchdog / Heartbeat para detectar caídas silenciosas.
 * 4. Normalización transparente entre Spot y Futures.
 * 5. Carga de ExchangeInfo oficial con filtros de precisión de precio (tickSize) exactos de Binance.
 */
class BinanceAPI {
  constructor() {
    this.marketType = 'spot';
    this.restBase = 'https://api.binance.com/api/v3';
    this.wsBase = 'wss://stream.binance.com:9443/ws';
    this.subscriptions = new Map();
    this.symbolPrecisions = new Map(); // Mapa de símbolo -> número exacto de decimales de Binance
    
    // Precisión oficial por defecto de Binance para los 15 pares
    this.defaultPrecisions = {
      'BTCUSDT': 2,
      'ETHUSDT': 2,
      'BNBUSDT': 2,
      'SOLUSDT': 2,
      'XRPUSDT': 4,
      'ADAUSDT': 4,
      'AVAXUSDT': 2,
      'LINKUSDT': 3,
      'DOGEUSDT': 5,
      'TONUSDT': 4,
      'DOTUSDT': 3,
      'LTCUSDT': 2,
      'NEARUSDT': 3,
      'SUIUSDT': 4,
      'APTUSDT': 3
    };

    this.initPrecisions();
  }

  setMarketType(type) {
    const prevType = this.marketType;
    this.marketType = type === 'futures' ? 'futures' : 'spot';
    
    if (this.marketType === 'futures') {
      this.restBase = 'https://fapi.binance.com/fapi/v1';
      this.wsBase = 'wss://fstream.binance.com/ws';
    } else {
      this.restBase = 'https://api.binance.com/api/v3';
      this.wsBase = 'wss://stream.binance.com:9443/ws';
    }

    this.loadExchangeInfo();

    if (prevType !== this.marketType && this.subscriptions.size > 0) {
      const activeSubs = Array.from(this.subscriptions.values());
      activeSubs.forEach(sub => {
        this.unsubscribeKline(sub.symbol, sub.interval);
        this.subscribeKline(sub.symbol, sub.interval, sub.onMessage, sub.onError);
      });
    }
  }

  initPrecisions() {
    Object.entries(this.defaultPrecisions).forEach(([sym, dec]) => {
      this.symbolPrecisions.set(sym, dec);
    });
    this.loadExchangeInfo();
  }

  /**
   * Consulta exchangeInfo oficial de Binance para obtener el tickSize exacto de cada par
   */
  async loadExchangeInfo() {
    try {
      const url = `${this.restBase}/exchangeInfo`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      
      if (data && Array.isArray(data.symbols)) {
        data.symbols.forEach(s => {
          const priceFilter = s.filters ? s.filters.find(f => f.filterType === 'PRICE_FILTER') : null;
          if (priceFilter && priceFilter.tickSize) {
            const tick = parseFloat(priceFilter.tickSize);
            if (tick > 0) {
              const decimals = Math.max(0, -Math.floor(Math.log10(tick)));
              this.symbolPrecisions.set(s.symbol, decimals);
            }
          } else if (typeof s.pricePrecision === 'number') {
            this.symbolPrecisions.set(s.symbol, s.pricePrecision);
          }
        });
      }
    } catch (e) {
      console.warn('[BinanceAPI] Fallback a precisiones por defecto:', e.message);
    }
  }

  /**
   * Obtiene la cantidad de decimales oficial de Binance para un par
   */
  getPrecision(symbol) {
    const clean = symbol.replace('/', '').toUpperCase();
    if (this.symbolPrecisions.has(clean)) {
      return this.symbolPrecisions.get(clean);
    }
    if (this.defaultPrecisions[clean] !== undefined) {
      return this.defaultPrecisions[clean];
    }
    return 4; // Default seguro
  }

  /**
   * Obtiene velas históricas (Klines)
   */
  async getKlines(symbol, interval = '15m', limit = 100) {
    try {
      const cleanSymbol = symbol.toUpperCase().replace('/', '');
      const url = `${this.restBase}/klines?symbol=${cleanSymbol}&interval=${interval}&limit=${limit}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`[BinanceAPI] HTTP ${response.status}: ${response.statusText}`);
      }
      
      const rawData = await response.json();
      if (!Array.isArray(rawData)) return [];
      
      return rawData.map(k => ({
        time: Math.floor(Number(k[0]) / 1000),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        isClosed: true
      }));
    } catch (error) {
      console.warn(`[BinanceAPI] Error obteniendo klines (${symbol} ${interval}):`, error.message);
      return [];
    }
  }

  /**
   * Suscripción WebSocket con auto-reconexión y watchdog
   */
  subscribeKline(symbol, interval, onMessage, onError) {
    const cleanSymbol = symbol.toLowerCase().replace('/', '');
    const wsKey = `${cleanSymbol}_${interval}`;

    if (this.subscriptions.has(wsKey)) {
      this.unsubscribeKline(symbol, interval);
    }

    const subInfo = {
      ws: null,
      streamName: `${cleanSymbol}@kline_${interval}`,
      symbol: cleanSymbol,
      interval: interval,
      onMessage: onMessage,
      onError: onError,
      reconnectAttempts: 0,
      isManualClose: false,
      watchdogTimer: null,
      lastMessageTime: Date.now()
    };

    this.subscriptions.set(wsKey, subInfo);
    this._connectSocket(wsKey);
  }

  _connectSocket(wsKey) {
    const sub = this.subscriptions.get(wsKey);
    if (!sub || sub.isManualClose) return;

    try {
      const url = `${this.wsBase}/${sub.streamName}`;
      const ws = new WebSocket(url);
      sub.ws = ws;

      this._resetWatchdog(wsKey);

      ws.onopen = () => {
        sub.reconnectAttempts = 0;
      };

      ws.onmessage = (event) => {
        sub.lastMessageTime = Date.now();
        this._resetWatchdog(wsKey);

        try {
          const data = JSON.parse(event.data);
          if (data && data.k) {
            const k = data.k;
            const candle = {
              time: Math.floor(Number(k.t) / 1000),
              open: parseFloat(k.o),
              high: parseFloat(k.h),
              low: parseFloat(k.l),
              close: parseFloat(k.c),
              volume: parseFloat(k.v),
              isClosed: Boolean(k.x)
            };

            if (typeof sub.onMessage === 'function') {
              sub.onMessage(candle, sub.symbol, sub.interval);
            }
          }
        } catch (err) {
          console.warn(`[BinanceAPI] Error procesando JSON de ${sub.streamName}:`, err);
        }
      };

      ws.onerror = (err) => {
        if (typeof sub.onError === 'function') sub.onError(err);
      };

      ws.onclose = () => {
        this._clearWatchdog(sub);
        if (!sub.isManualClose && this.subscriptions.has(wsKey)) {
          const delay = Math.min(1000 * Math.pow(1.5, sub.reconnectAttempts), 15000);
          sub.reconnectAttempts++;
          setTimeout(() => {
            if (this.subscriptions.has(wsKey) && !sub.isManualClose) {
              this._connectSocket(wsKey);
            }
          }, delay);
        }
      };

    } catch (err) {
      console.warn(`[BinanceAPI] Error al crear WebSocket para ${sub.streamName}:`, err);
    }
  }

  _resetWatchdog(wsKey) {
    const sub = this.subscriptions.get(wsKey);
    if (!sub) return;

    this._clearWatchdog(sub);

    sub.watchdogTimer = setTimeout(() => {
      if (sub.ws && !sub.isManualClose) {
        try {
          sub.ws.close();
        } catch (e) {}
      }
    }, 45000);
  }

  _clearWatchdog(sub) {
    if (sub && sub.watchdogTimer) {
      clearTimeout(sub.watchdogTimer);
      sub.watchdogTimer = null;
    }
  }

  unsubscribeKline(symbol, interval) {
    const cleanSymbol = symbol.toLowerCase().replace('/', '');
    const wsKey = `${cleanSymbol}_${interval}`;

    if (!this.subscriptions.has(wsKey)) return;

    const sub = this.subscriptions.get(wsKey);
    sub.isManualClose = true;
    this._clearWatchdog(sub);

    if (sub.ws) {
      const ws = sub.ws;
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.onopen = () => {
          try { ws.close(); } catch (e) {}
        };
      } else if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
        try { ws.close(); } catch (e) {}
      }
      sub.ws = null;
    }

    this.subscriptions.delete(wsKey);
  }

  disconnectAll() {
    const keys = Array.from(this.subscriptions.keys());
    keys.forEach(k => {
      const sub = this.subscriptions.get(k);
      if (sub) this.unsubscribeKline(sub.symbol, sub.interval);
    });
    this.subscriptions.clear();
  }
}

window.BinanceAPI = BinanceAPI;
