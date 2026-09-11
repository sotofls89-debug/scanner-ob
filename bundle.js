/* SMC BOT UNIFIED BUNDLE */

/* --- js/binance_api.js --- */
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
    const cleanSymbol = symbol.toUpperCase().replace('/', '');
    const isOnVercel = typeof window !== 'undefined' && window.location?.hostname?.endsWith('vercel.app');

    // Lista de endpoints a intentar en cascada
    const candidates = [
      `${this.restBase}/klines?symbol=${cleanSymbol}&interval=${interval}&limit=${limit}`
    ];
    if (isOnVercel) {
      candidates.push(`/proxy-binance-real/fapi/v1/klines?symbol=${cleanSymbol}&interval=${interval}&limit=${limit}`);
    }
    candidates.push(`https://api.binance.com/api/v3/klines?symbol=${cleanSymbol}&interval=${interval}&limit=${limit}`);

    for (const url of candidates) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined
        });
        if (!response.ok) continue;
        const rawData = await response.json();
        if (!Array.isArray(rawData) || rawData.length === 0) continue;

        return rawData.map(k => ({
          time: Math.floor(Number(k[0]) / 1000),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          isClosed: true
        }));
      } catch (_) {
        // Probar siguiente candidato
      }
    }

    console.warn(`[BinanceAPI] No se pudieron obtener velas para ${cleanSymbol} tras agotar respaldos.`);
    return [];
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

if (typeof window !== 'undefined') {
  window.BinanceAPI = BinanceAPI;
}


/* --- js/trade_tracker.js --- */
/**
 * Trade Tracker & Adaptive Learning Engine + Notificaciones en Vivo de Trades
 */
class TradeTracker {
  constructor(options = {}) {
    this.historyKey = 'smc_trade_history_v1';
    this.memoryKey = 'smc_adaptive_memory_v1';
    this.trades = this.loadTrades();
    this.memory = this.loadMemory();
    this.onTradeEvent = options.onTradeEvent || null; // Callback para eventos (TP1, TP3, SL)
  }

  loadTrades() {
    try {
      const data = localStorage.getItem(this.historyKey);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  saveTrades() {
    try {
      localStorage.setItem(this.historyKey, JSON.stringify(this.trades));
    } catch (e) {}
  }

  loadMemory() {
    try {
      const data = localStorage.getItem(this.memoryKey);
      return data ? JSON.parse(data) : {};
    } catch (e) {
      return {};
    }
  }

  saveMemory() {
    try {
      localStorage.setItem(this.memoryKey, JSON.stringify(this.memory));
    } catch (e) {}
  }

  mergeCloudData(cloudData) {
    if (!cloudData) return false;
    let hasChanges = false;

    if (Array.isArray(cloudData.trades)) {
      cloudData.trades.forEach(remoteTrade => {
        const localIndex = this.trades.findIndex(t => t.id === remoteTrade.id);
        if (localIndex === -1) {
          this.trades.push(remoteTrade);
          hasChanges = true;
        } else {
          const localTrade = this.trades[localIndex];
          if (localTrade.status === 'OPEN' && remoteTrade.status !== 'OPEN') {
            this.trades[localIndex] = remoteTrade;
            hasChanges = true;
          }
        }
      });
      this.trades.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      if (this.trades.length > 200) this.trades = this.trades.slice(0, 200);
    }

    if (cloudData.memory && typeof cloudData.memory === 'object') {
      this.memory = { ...this.memory, ...cloudData.memory };
      this.saveMemory();
      hasChanges = true;
    }

    if (hasChanges) {
      this.saveTrades();
    }
    return hasChanges;
  }

  registerSignal(signal) {
    if (!signal || !signal.id) return;
    const exists = this.trades.some(t => t.id === signal.id);
    if (exists) return;

    const rawTime = signal.timestamp || Date.now();
    const timeSec = rawTime > 1e11 ? Math.floor(rawTime / 1000) : rawTime;

    const trade = {
      id: signal.id,
      symbol: signal.symbol,
      type: signal.type,
      entry: signal.entry,
      stop: signal.stop,
      tp1: signal.tp1 || (signal.type === 'LONG' ? signal.entry + (signal.risk * 1.5) : signal.entry - (signal.risk * 1.5)),
      tp3: signal.takeProfit,
      risk: signal.risk,
      riskPercent: signal.riskPercent,
      timestamp: timeSec,
      createdAt: Date.now(),
      status: 'OPEN', // OPEN, TP1_REACHED, WIN_TP3, LOSS_SL, STOP_HUNT_LOSS
      rMultiple: 0,
      notifiedTP1: false,
      maxFavorablePrice: signal.entry,
      maxAdversePrice: signal.entry
    };

    this.trades.unshift(trade);
    if (this.trades.length > 200) this.trades.pop();
    this.saveTrades();
  }

  updateOpenTrades(symbol, candles15m) {
    if (!Array.isArray(candles15m) || candles15m.length === 0) return;

    const openTrades = this.trades.filter(t => t.symbol === symbol && (t.status === 'OPEN' || t.status === 'TP1_REACHED'));
    if (openTrades.length === 0) return;

    let hasChanges = false;

    openTrades.forEach(trade => {
      const tradeTime = trade.timestamp > 1e11 ? Math.floor(trade.timestamp / 1000) : (trade.timestamp || 0);
      const relevantCandles = candles15m.filter(c => c.time >= (tradeTime > 0 ? tradeTime - 900 : 0));

      for (let candle of relevantCandles) {
        const high = Number(candle.high);
        const low = Number(candle.low);
        const close = Number(candle.close);

        if (trade.type === 'LONG') {
          trade.maxFavorablePrice = Math.max(trade.maxFavorablePrice, high);
          trade.maxAdversePrice = Math.min(trade.maxAdversePrice, low);

          // 1. Verificación de TP1 (1:1.5) - Parcial / Breakeven
          if (high >= trade.tp1 && !trade.notifiedTP1) {
            trade.notifiedTP1 = true;
            trade.status = 'TP1_REACHED';
            hasChanges = true;
            if (typeof this.onTradeEvent === 'function') {
              this.onTradeEvent({ type: 'TP1_HIT', trade, price: high });
            }
          }

          // 2. Verificación de TP Final 1:3 (+3R)
          if (high >= trade.tp3) {
            trade.status = 'WIN_TP3';
            trade.rMultiple = 3.0;
            trade.closedAt = Date.now();
            this.recordLearningOutcome(trade, true, false);
            hasChanges = true;
            if (typeof this.onTradeEvent === 'function') {
              this.onTradeEvent({ type: 'TP3_HIT', trade, price: high });
            }
            break;
          }

          // 3. Verificación de Stop Loss (-1R) o Breakeven (+0.75R)
          if (low <= trade.stop) {
            if (trade.notifiedTP1) {
              trade.status = 'WIN_TP1_BE';
              trade.rMultiple = 0.75; // Ganancia parcial asegurada
              trade.closedAt = Date.now();
              this.recordLearningOutcome(trade, true, false);
              hasChanges = true;
            } else {
              const isStopHunt = close > trade.stop && high >= trade.entry;
              trade.status = isStopHunt ? 'STOP_HUNT_LOSS' : 'LOSS_SL';
              trade.rMultiple = -1.0;
              trade.closedAt = Date.now();
              this.recordLearningOutcome(trade, false, isStopHunt);
              hasChanges = true;
              if (typeof this.onTradeEvent === 'function') {
                this.onTradeEvent({ type: 'SL_HIT', trade, price: low, isStopHunt });
              }
            }
            break;
          }
        } else if (trade.type === 'SHORT') {
          trade.maxFavorablePrice = Math.min(trade.maxFavorablePrice, low);
          trade.maxAdversePrice = Math.max(trade.maxAdversePrice, high);

          if (low <= trade.tp1 && !trade.notifiedTP1) {
            trade.notifiedTP1 = true;
            trade.status = 'TP1_REACHED';
            hasChanges = true;
            if (typeof this.onTradeEvent === 'function') {
              this.onTradeEvent({ type: 'TP1_HIT', trade, price: low });
            }
          }

          if (low <= trade.tp3) {
            trade.status = 'WIN_TP3';
            trade.rMultiple = 3.0;
            trade.closedAt = Date.now();
            this.recordLearningOutcome(trade, true, false);
            hasChanges = true;
            if (typeof this.onTradeEvent === 'function') {
              this.onTradeEvent({ type: 'TP3_HIT', trade, price: low });
            }
            break;
          }

          if (high >= trade.stop) {
            if (trade.notifiedTP1) {
              trade.status = 'WIN_TP1_BE';
              trade.rMultiple = 0.75;
              trade.closedAt = Date.now();
              this.recordLearningOutcome(trade, true, false);
              hasChanges = true;
            } else {
              const isStopHunt = close < trade.stop && low <= trade.entry;
              trade.status = isStopHunt ? 'STOP_HUNT_LOSS' : 'LOSS_SL';
              trade.rMultiple = -1.0;
              trade.closedAt = Date.now();
              this.recordLearningOutcome(trade, false, isStopHunt);
              hasChanges = true;
              if (typeof this.onTradeEvent === 'function') {
                this.onTradeEvent({ type: 'SL_HIT', trade, price: high, isStopHunt });
              }
            }
            break;
          }
        }
      }
    });

    if (hasChanges) {
      this.saveTrades();
    }
  }

  recordLearningOutcome(trade, isWin, isStopHunt) {
    const symbol = trade.symbol;
    if (!this.memory[symbol]) {
      this.memory[symbol] = {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        consecutiveLosses: 0,
        stopHuntCount: 0,
        atrBufferBonus: 0,
        extraVolumeRequired: 0,
        quarantineUntil: 0
      };
    }

    const mem = this.memory[symbol];
    mem.totalTrades++;

    if (isWin) {
      mem.wins++;
      mem.consecutiveLosses = 0;
      if (mem.atrBufferBonus > 0) mem.atrBufferBonus = Math.max(0, mem.atrBufferBonus - 0.05);
      if (mem.extraVolumeRequired > 0) mem.extraVolumeRequired = Math.max(0, mem.extraVolumeRequired - 0.05);
    } else {
      mem.losses++;
      mem.consecutiveLosses++;

      if (isStopHunt) {
        mem.stopHuntCount++;
        mem.atrBufferBonus = Math.min(0.50, mem.atrBufferBonus + 0.15);
      }

      if (mem.consecutiveLosses >= 2) {
        mem.extraVolumeRequired = Math.min(0.40, mem.extraVolumeRequired + 0.15);
        if (mem.consecutiveLosses >= 3) {
          mem.quarantineUntil = Date.now() + (3 * 60 * 60 * 1000);
        }
      }
    }

    this.saveMemory();
  }

  getAdaptiveProfile(symbol) {
    const mem = this.memory[symbol] || {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      consecutiveLosses: 0,
      atrBufferBonus: 0,
      extraVolumeRequired: 0,
      quarantineUntil: 0
    };

    const isQuarantined = Date.now() < mem.quarantineUntil;
    const winRate = mem.totalTrades > 0 ? (mem.wins / mem.totalTrades) * 100 : 50;

    return {
      symbol,
      isQuarantined,
      winRate: Math.round(winRate),
      atrBufferBonus: mem.atrBufferBonus || 0,
      extraVolumeRequired: mem.extraVolumeRequired || 0,
      consecutiveLosses: mem.consecutiveLosses || 0
    };
  }

  getGlobalStats() {
    const closed = this.trades.filter(t => t.status !== 'OPEN' && t.status !== 'TP1_REACHED');
    const wins = closed.filter(t => t.status === 'WIN_TP3' || t.status === 'WIN_TP1_BE').length;
    const losses = closed.filter(t => t.status === 'LOSS_SL' || t.status === 'STOP_HUNT_LOSS').length;
    const total = closed.length;
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';

    const netR = closed.reduce((acc, t) => acc + (t.rMultiple || 0), 0);

    return {
      totalTrades: total,
      openTrades: this.trades.filter(t => t.status === 'OPEN' || t.status === 'TP1_REACHED').length,
      wins,
      losses,
      winRate: `${winRate}%`,
      netR: netR >= 0 ? `+${netR.toFixed(1)}R` : `${netR.toFixed(1)}R`
    };
  }
}

window.TradeTracker = TradeTracker;


/* --- js/smc_detector.js --- */
/**
 * SMC (Smart Money Concepts) High-Precision Detector - Enterprise Grade + Adaptive AI
 * 
 * Reglas Maestras Institucionales:
 * 1. BTC Trend Shield: Bloquea compras en altcoins si BTC se desploma, y bloquea ventas si BTC sube con fuerza.
 * 2. Killzones Institucionales: Identifica Londres (07-10 UTC) y New York (12-16 UTC).
 * 3. Filtro Macro 4H (EMA 20/50) + Major BOS + FVG.
 * 4. Stop Loss Estructural + Buffer de Spread.
 * 5. Invalidación Dinámica Temprana.
 * 6. Ratio Matemático Estricto 1:3.
 */
class SMCDetector {
  constructor(options = {}) {
    this.riskRewardRatio = 3.0; // Multiplicador matemático exacto 1:3
    this.filterMode = options.filterMode || 'estricto';
    this.maxAgeCandles = 16;
    this.minRiskPercent = 0.60;
    this.maxRiskPercent = 2.50;
  }

  setFilterMode(mode) {
    this.filterMode = mode;
  }

  getKillzone() {
    const now = new Date();
    const utcHours = now.getUTCHours();
    
    // Londres: 07:00 - 10:00 UTC
    if (utcHours >= 7 && utcHours < 10) {
      return { name: 'Killzone Londres', tag: '🟢 Killzone Londres (Alta Liquidez)' };
    }
    // New York: 12:00 - 16:00 UTC
    if (utcHours >= 12 && utcHours < 16) {
      return { name: 'Killzone New York', tag: '🟢 Killzone New York (Máxima Liquidez)' };
    }
    // Asia: 00:00 - 06:00 UTC
    if (utcHours >= 0 && utcHours < 6) {
      return { name: 'Sesión Asia', tag: '🟡 Sesión Asia' };
    }
    return { name: 'Sesión Regular', tag: '⚪ Sesión Regular' };
  }

  calculateEMA(candles, period) {
    if (!Array.isArray(candles) || candles.length < period) return null;
    const k = 2 / (period + 1);
    let ema = candles.slice(0, period).reduce((acc, c) => acc + (Number(c.close) || 0), 0) / period;
    for (let i = period; i < candles.length; i++) {
      const close = Number(candles[i].close) || 0;
      ema = (close * k) + (ema * (1 - k));
    }
    return ema;
  }

  calculateATR(candles, period = 14) {
    if (!Array.isArray(candles) || candles.length < period + 1) return 0;
    let trList = [];
    for (let i = 1; i < candles.length; i++) {
      const current = candles[i];
      const prev = candles[i - 1];
      const tr = Math.max(
        current.high - current.low,
        Math.abs(current.high - prev.close),
        Math.abs(current.low - prev.close)
      );
      trList.push(tr);
    }
    const recentTr = trList.slice(-period);
    return recentTr.reduce((acc, v) => acc + v, 0) / period;
  }

  calculateVolumeMA(candles, period = 20) {
    if (!Array.isArray(candles) || candles.length < period) return 0;
    const recent = candles.slice(-period);
    const sum = recent.reduce((acc, c) => acc + (Number(c.volume) || 0), 0);
    return sum / period;
  }

  findPivots(candles, length = 2) {
    const pivotsHigh = [];
    const pivotsLow = [];

    for (let i = length; i < candles.length - length; i++) {
      const current = candles[i];
      let isHigh = true;
      let isLow = true;

      for (let j = 1; j <= length; j++) {
        if (candles[i - j].high >= current.high || candles[i + j].high > current.high) {
          isHigh = false;
        }
        if (candles[i - j].low <= current.low || candles[i + j].low < current.low) {
          isLow = false;
        }
      }

      if (isHigh) pivotsHigh.push({ index: i, price: current.high, time: current.time });
      if (isLow) pivotsLow.push({ index: i, price: current.low, time: current.time });
    }

    return { pivotsHigh, pivotsLow };
  }

  calculateRSI(candles, period = 14) {
    if (!Array.isArray(candles) || candles.length < period + 1) return [];
    const rsiValues = new Array(candles.length).fill(50);
    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
      const change = Number(candles[i].close) - Number(candles[i - 1].close);
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;
    rsiValues[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));

    for (let i = period + 1; i < candles.length; i++) {
      const change = Number(candles[i].close) - Number(candles[i - 1].close);
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;

      avgGain = ((avgGain * (period - 1)) + gain) / period;
      avgLoss = ((avgLoss * (period - 1)) + loss) / period;

      if (avgLoss === 0) {
        rsiValues[i] = 100;
      } else {
        const rs = avgGain / avgLoss;
        rsiValues[i] = 100 - (100 / (1 + rs));
      }
    }
    return rsiValues;
  }

  detectDivergence(candles, pivotsHigh, pivotsLow, rsiArray, type) {
    if (!Array.isArray(rsiArray) || rsiArray.length === 0) return false;

    if (type === 'LONG') {
      // Divergencia Alcista: Precio hace Bajo más Bajo (o igual), RSI hace Bajo más Alto
      const recentLows = pivotsLow.slice(-3);
      if (recentLows.length >= 2) {
        const p1 = recentLows[recentLows.length - 2];
        const p2 = recentLows[recentLows.length - 1];
        const rsi1 = rsiArray[p1.index] || 50;
        const rsi2 = rsiArray[p2.index] || 50;

        if (p2.price <= p1.price * 1.002 && rsi2 > rsi1 + 1.5) {
          return true;
        }
      }
    } else if (type === 'SHORT') {
      // Divergencia Bajista: Precio hace Alto más Alto (o igual), RSI hace Alto más Bajo
      const recentHighs = pivotsHigh.slice(-3);
      if (recentHighs.length >= 2) {
        const p1 = recentHighs[recentHighs.length - 2];
        const p2 = recentHighs[recentHighs.length - 1];
        const rsi1 = rsiArray[p1.index] || 50;
        const rsi2 = rsiArray[p2.index] || 50;

        if (p2.price >= p1.price * 0.998 && rsi2 < rsi1 - 1.5) {
          return true;
        }
      }
    }
    return false;
  }

  detectLiquidityPools(pivotsHigh, pivotsLow, currentPrice) {
    let hasEQH = false;
    let hasEQL = false;

    // Detectar Equal Highs (techos dobles con tolerancia < 0.20%)
    for (let i = 0; i < pivotsHigh.length; i++) {
      for (let j = i + 1; j < pivotsHigh.length; j++) {
        const p1 = pivotsHigh[i].price;
        const p2 = pivotsHigh[j].price;
        const diffPct = Math.abs(p1 - p2) / Math.min(p1, p2);
        if (diffPct <= 0.0020 && p2 > currentPrice) {
          hasEQH = true;
          break;
        }
      }
    }

    // Detectar Equal Lows (suelos dobles con tolerancia < 0.20%)
    for (let i = 0; i < pivotsLow.length; i++) {
      for (let j = i + 1; j < pivotsLow.length; j++) {
        const p1 = pivotsLow[i].price;
        const p2 = pivotsLow[j].price;
        const diffPct = Math.abs(p1 - p2) / Math.min(p1, p2);
        if (diffPct <= 0.0020 && p2 < currentPrice) {
          hasEQL = true;
          break;
        }
      }
    }

    return { hasEQH, hasEQL };
  }

  getMacroTrend(candles4h, candles15m) {
    if (Array.isArray(candles4h) && candles4h.length >= 25) {
      const lastClose = Number(candles4h[candles4h.length - 1].close) || 0;
      const ema20 = this.calculateEMA(candles4h, 20);
      const ema50 = this.calculateEMA(candles4h, Math.min(50, candles4h.length));

      if (ema20 !== null && ema50 !== null) {
        if (lastClose > ema20 && ema20 >= ema50) return 'ALCISTA';
        if (lastClose < ema20 && ema20 <= ema50) return 'BAJISTA';
        if (lastClose > ema20 && lastClose > ema50) return 'ALCISTA';
        if (lastClose < ema20 && lastClose < ema50) return 'BAJISTA';
      }
    }

    if (Array.isArray(candles15m) && candles15m.length >= 50) {
      const lastClose = Number(candles15m[candles15m.length - 1].close) || 0;
      const ema50_15m = this.calculateEMA(candles15m, 50);
      const ema200_15m = this.calculateEMA(candles15m, Math.min(100, candles15m.length));

      if (ema50_15m !== null && ema200_15m !== null) {
        if (lastClose > ema50_15m && ema50_15m > ema200_15m) return 'ALCISTA';
        if (lastClose < ema50_15m && ema50_15m < ema200_15m) return 'BAJISTA';
      }
    }

    return 'RANGO';
  }

  /**
   * Análisis Completo SMC con BTC Trend Shield + Killzones + Memoria Adaptativa
   */
  analyze(symbol, candles15m, candles4h = null, adaptiveProfile = null, btcShield = null) {
    if (!Array.isArray(candles15m) || candles15m.length < 35) return null;

    if (adaptiveProfile && adaptiveProfile.isQuarantined && this.filterMode === 'estricto') {
      return {
        symbol,
        currentPrice: Number(candles15m[candles15m.length - 1].close) || 0,
        trend: 'PAUSADO (CUARENTENA)',
        activeSignal: null
      };
    }

    const len = candles15m.length;
    const currentCandle = candles15m[len - 1];
    const prevCandle = candles15m[len - 2];
    const currentPrice = Number(currentCandle.close) || 0;
    const atr = this.calculateATR(candles15m, 14);
    const volMA = this.calculateVolumeMA(candles15m, 20);
    const killzone = this.getKillzone();

    const atrMultiplier = 0.75 + (adaptiveProfile ? adaptiveProfile.atrBufferBonus : 0);
    const volMultiplier = 1.25 + (adaptiveProfile ? adaptiveProfile.extraVolumeRequired : 0);

    const macroTrend = this.getMacroTrend(candles4h, candles15m);

    // -----------------------------------------------------------------
    // BTC TREND SHIELD: Si BTC está en caída violenta o tendencia opuesta
    // -----------------------------------------------------------------
    const isAltcoin = symbol !== 'BTCUSDT';
    let allowLong = macroTrend !== 'BAJISTA';
    let allowShort = macroTrend !== 'ALCISTA';

    if (isAltcoin && btcShield && this.filterMode === 'estricto') {
      if (btcShield.isDumping || btcShield.trend === 'BAJISTA') {
        allowLong = false; // BTC arrastra al mercado a la baja -> NO compras en Altcoins
      }
      if (btcShield.isPumping || btcShield.trend === 'ALCISTA') {
        allowShort = false; // BTC impulsando con fuerza -> NO ventas en Altcoins
      }
    }

    const windowCandles = candles15m.slice(-35);
    const swingHigh = Math.max(...windowCandles.map(c => Number(c.high) || 0));
    const swingLow = Math.min(...windowCandles.map(c => Number(c.low) || 0));
    const equilibrium = (swingHigh + swingLow) / 2;

    const { pivotsHigh, pivotsLow } = this.findPivots(candles15m, 2);
    const rsiArray = this.calculateRSI(candles15m, 14);
    const liquidity = this.detectLiquidityPools(pivotsHigh, pivotsLow, currentPrice);

    const scanStartIndex = Math.max(5, len - this.maxAgeCandles);
    const validCandidates = [];

    for (let i = scanStartIndex; i < len - 1; i++) {
      const candle = candles15m[i];
      const prev1 = candles15m[i - 1];
      const prev2 = candles15m[i - 2];
      const next1 = candles15m[i + 1];
      const next2 = i + 2 < len ? candles15m[i + 2] : null;

      const minPrevLow = Math.min(Number(prev1.low), Number(prev2.low));
      const maxPrevHigh = Math.max(Number(prev1.high), Number(prev2.high));

      const impulseVol = Math.max(Number(next1.volume) || 0, next2 ? (Number(next2.volume) || 0) : 0);
      const hasInstitutionalVolume = volMA > 0 ? (impulseVol >= volMA * volMultiplier) : true;

      // -----------------------------------------------------------------
      // A. BULLISH ORDER BLOCK (DEMANDA / COMPRAS)
      // -----------------------------------------------------------------
      if (allowLong) {
        const isBearishCandle = Number(candle.close) < Number(candle.open);
        const bullishDisplacement = Number(next1.close) > Number(candle.high) && 
                                    (Number(next1.close) - Number(next1.open)) > (atr * 0.95);

        const priorHighPivots = pivotsHigh.filter(p => p.index < i);
        const lastSwingHigh = priorHighPivots.length > 0 ? priorHighPivots[priorHighPivots.length - 1].price : maxPrevHigh;
        const hasBullishBOS = (Number(next1.close) > lastSwingHigh) || (next2 && Number(next2.close) > lastSwingHigh);
        const hasBullishSweep = Number(candle.low) < minPrevLow && Number(candle.close) >= minPrevLow;
        const hasBullishFVG = next2 ? (Number(next2.low) > Number(candle.high)) : (Number(next1.low) > Number(candle.high));

        if (isBearishCandle && bullishDisplacement) {
          const obTop = Math.max(Number(candle.open), Number(candle.high));
          const obBottom = Number(candle.low);
          const obEquilibrium = (obTop + obBottom) / 2;

          const entry = obTop;

          const structuralLow = Math.min(obBottom, minPrevLow);
          const spreadBuffer = Math.max(atr * atrMultiplier, currentPrice * 0.0008);
          let stop = structuralLow - spreadBuffer;
          let risk = entry - stop;
          let riskPct = (risk / entry) * 100;

          if (riskPct < this.minRiskPercent) {
            stop = entry * (1 - (this.minRiskPercent / 100));
            risk = entry - stop;
            riskPct = this.minRiskPercent;
          }

          if (risk > 0 && riskPct <= this.maxRiskPercent) {
            const tp3 = entry + (risk * 3.0);
            const tp2 = entry + (risk * 2.0);
            const tp1 = entry + (risk * 1.5);
            const beTrigger = tp1;

            let isDynamicallyInvalidated = false;
            let hasAlreadyHitTP = false;
            let hasAlreadyHitSL = false;
            let touchCount = 0;

            for (let k = i + 2; k < len; k++) {
              const bar = candles15m[k];
              if (Number(bar.high) >= tp3) { hasAlreadyHitTP = true; break; }
              if (Number(bar.low) <= stop) { hasAlreadyHitSL = true; break; }
              
              if (Number(bar.close) < obBottom) {
                isDynamicallyInvalidated = true;
                break;
              }

              if (Number(bar.low) <= obTop && Number(bar.high) >= obBottom && k < len - 1) {
                touchCount++;
              }
            }

            if (!isDynamicallyInvalidated && !hasAlreadyHitTP && !hasAlreadyHitSL && touchCount <= 1) {
              const currentRSI = rsiArray.length > 0 ? rsiArray[rsiArray.length - 1] : 50;
              if (currentRSI > 68) continue; // No comprar en sobrecompra extrema

              const inDiscount = Number(candle.low) <= (equilibrium * 1.002);
              const hasDivergence = this.detectDivergence(candles15m, pivotsHigh, pivotsLow, rsiArray, 'LONG');

              // Cálculo de Confluence Score Cuantitativo (0 a 100)
              let score = 40; // Base: Order Block estructural 15m
              if (hasBullishBOS) score += 15;
              if (hasBullishFVG) score += 15;
              if (killzone.name.includes('Londres') || killzone.name.includes('New York')) score += 15;
              if (hasInstitutionalVolume) score += 10;
              if (hasDivergence) score += 15;
              if (btcShield && btcShield.trend === 'ALCISTA') score += 10;
              if (liquidity.hasEQH) score += 10;
              score = Math.min(100, score);

              const grade = score >= 90 ? 'A+' : (score >= 75 ? 'A' : 'B+');
              const gradeBadge = score >= 90 ? '👑 Grado A+ Institucional' : (score >= 75 ? '🎯 Grado A Alta Probabilidad' : '⚡ Grado B+ Válido');

              const passes = this.filterMode === 'suave' ? (score >= 65) : (score >= 80);

              if (passes) {
                validCandidates.push({
                  id: `OB_LONG_${symbol}_${candle.time}`,
                  symbol: symbol,
                  type: 'LONG',
                  time: candle.time,
                  entry: entry,
                  stop: stop,
                  takeProfit: tp3,
                  tp1: tp1,
                  tp2: tp2,
                  tp3: tp3,
                  beTrigger: beTrigger,
                  risk: risk,
                  riskPercent: riskPct,
                  top: obTop,
                  bottom: obBottom,
                  equilibrium: obEquilibrium,
                  hasBOS: hasBullishBOS,
                  hasSweep: hasBullishSweep,
                  hasFVG: hasBullishFVG,
                  hasDivergence: hasDivergence,
                  hasLiquidityTarget: liquidity.hasEQH,
                  score: score,
                  grade: grade,
                  gradeBadge: gradeBadge,
                  zoneTag: inDiscount ? 'Descuento 50%' : 'Zona Media',
                  killzoneTag: killzone.tag,
                  adaptiveBadge: adaptiveProfile && adaptiveProfile.atrBufferBonus > 0 ? '✓ SL Adaptado (+Volatilidad)' : null,
                  btcShieldBadge: isAltcoin ? '✓ Sincronizado con BTC' : null
                });
              }
            }
          }
        }
      }

      // -----------------------------------------------------------------
      // B. BEARISH ORDER BLOCK (OFERTA / VENTAS)
      // -----------------------------------------------------------------
      if (allowShort) {
        const isBullishCandle = Number(candle.close) > Number(candle.open);
        const bearishDisplacement = Number(next1.close) < Number(candle.low) && 
                                    (Number(next1.open) - Number(next1.close)) > (atr * 0.95);

        const priorLowPivots = pivotsLow.filter(p => p.index < i);
        const lastSwingLow = priorLowPivots.length > 0 ? priorLowPivots[priorLowPivots.length - 1].price : minPrevLow;
        const hasBearishBOS = (Number(next1.close) < lastSwingLow) || (next2 && Number(next2.close) < lastSwingLow);
        const hasBearishSweep = Number(candle.high) > maxPrevHigh && Number(candle.close) <= maxPrevHigh;
        const hasBearishFVG = next2 ? (Number(next2.high) < Number(candle.low)) : (Number(next1.high) < Number(candle.low));

        if (isBullishCandle && bearishDisplacement) {
          const obTop = Number(candle.high);
          const obBottom = Math.min(Number(candle.open), Number(candle.low));
          const obEquilibrium = (obTop + obBottom) / 2;

          const entry = obBottom;

          const structuralHigh = Math.max(obTop, maxPrevHigh);
          const spreadBuffer = Math.max(atr * atrMultiplier, currentPrice * 0.0008);
          let stop = structuralHigh + spreadBuffer;
          let risk = stop - entry;
          let riskPct = (risk / entry) * 100;

          if (riskPct < this.minRiskPercent) {
            stop = entry * (1 + (this.minRiskPercent / 100));
            risk = stop - entry;
            riskPct = this.minRiskPercent;
          }

          if (risk > 0 && riskPct <= this.maxRiskPercent) {
            const tp3 = entry - (risk * 3.0);
            const tp2 = entry - (risk * 2.0);
            const tp1 = entry - (risk * 1.5);
            const beTrigger = tp1;

            let isDynamicallyInvalidated = false;
            let hasAlreadyHitTP = false;
            let hasAlreadyHitSL = false;
            let touchCount = 0;

            for (let k = i + 2; k < len; k++) {
              const bar = candles15m[k];
              if (Number(bar.low) <= tp3) { hasAlreadyHitTP = true; break; }
              if (Number(bar.high) >= stop) { hasAlreadyHitSL = true; break; }
              
              if (Number(bar.close) > obTop) {
                isDynamicallyInvalidated = true;
                break;
              }

              if (Number(bar.high) >= obBottom && Number(bar.low) <= obTop && k < len - 1) {
                touchCount++;
              }
            }

            if (!isDynamicallyInvalidated && !hasAlreadyHitTP && !hasAlreadyHitSL && touchCount <= 1) {
              const currentRSI = rsiArray.length > 0 ? rsiArray[rsiArray.length - 1] : 50;
              if (currentRSI < 32) continue; // No vender en sobreventa extrema

              const inPremium = Number(candle.high) >= (equilibrium * 0.998);
              const hasDivergence = this.detectDivergence(candles15m, pivotsHigh, pivotsLow, rsiArray, 'SHORT');

              // Cálculo de Confluence Score Cuantitativo (0 a 100)
              let score = 40; // Base: Order Block estructural 15m
              if (hasBearishBOS) score += 15;
              if (hasBearishFVG) score += 15;
              if (killzone.name.includes('Londres') || killzone.name.includes('New York')) score += 15;
              if (hasInstitutionalVolume) score += 10;
              if (hasDivergence) score += 15;
              if (btcShield && btcShield.trend === 'BAJISTA') score += 10;
              if (liquidity.hasEQL) score += 10;
              score = Math.min(100, score);

              const grade = score >= 90 ? 'A+' : (score >= 75 ? 'A' : 'B+');
              const gradeBadge = score >= 90 ? '👑 Grado A+ Institucional' : (score >= 75 ? '🎯 Grado A Alta Probabilidad' : '⚡ Grado B+ Válido');

              const passes = this.filterMode === 'suave' ? (score >= 65) : (score >= 80);

              if (passes) {
                validCandidates.push({
                  id: `OB_SHORT_${symbol}_${candle.time}`,
                  symbol: symbol,
                  type: 'SHORT',
                  time: candle.time,
                  entry: entry,
                  stop: stop,
                  takeProfit: tp3,
                  tp1: tp1,
                  tp2: tp2,
                  tp3: tp3,
                  beTrigger: beTrigger,
                  risk: risk,
                  riskPercent: riskPct,
                  top: obTop,
                  bottom: obBottom,
                  equilibrium: obEquilibrium,
                  hasBOS: hasBearishBOS,
                  hasSweep: hasBearishSweep,
                  hasFVG: hasBearishFVG,
                  hasDivergence: hasDivergence,
                  hasLiquidityTarget: liquidity.hasEQL,
                  score: score,
                  grade: grade,
                  gradeBadge: gradeBadge,
                  zoneTag: inPremium ? 'Premium 50%' : 'Zona Media',
                  killzoneTag: killzone.tag,
                  adaptiveBadge: adaptiveProfile && adaptiveProfile.atrBufferBonus > 0 ? '✓ SL Adaptado (+Volatilidad)' : null,
                  btcShieldBadge: isAltcoin ? '✓ Sincronizado con BTC' : null
                });
              }
            }
          }
        }
      }
    }

    // -----------------------------------------------------------------
    // 3. SELECCIÓN DE SEÑAL ACTIVA CON GATILLO DE RECHAZO EN VIVO
    // -----------------------------------------------------------------
    let activeSignal = null;

    for (let setup of validCandidates.reverse()) {
      if (setup.type === 'LONG') {
        if (!(setup.stop < setup.entry && setup.entry < setup.takeProfit)) continue;

        const isInDemandZone = currentPrice >= (setup.bottom - (atr * 0.3)) && currentPrice <= (setup.entry * 1.0035);

        const currentClose = Number(currentCandle.close);
        const currentOpen = Number(currentCandle.open);
        const currentLow = Number(currentCandle.low);
        const currentHigh = Number(currentCandle.high);
        const prevClose = Number(prevCandle.close);
        const prevOpen = Number(prevCandle.open);

        const hasRejectionTrigger = (currentClose > currentOpen) ||
                                    ((currentClose - currentLow) > (currentHigh - currentClose)) ||
                                    (prevClose > prevOpen && Number(prevCandle.low) <= setup.entry);

        if (isInDemandZone && hasRejectionTrigger) {
          const tags = [
            setup.gradeBadge,
            setup.hasBOS ? '✓ Major BOS Confirmado' : '✓ Sweep de Liquidez',
            '✓ Desplazamiento + FVG',
            `✓ HTF 4h en ${macroTrend.toLowerCase()}`,
            `✓ ${setup.zoneTag}`,
            setup.killzoneTag
          ];
          if (setup.hasDivergence) tags.push('⚡ Divergencia RSI Alcista');
          if (setup.hasLiquidityTarget) tags.push('🌊 Target: Piscina EQH');
          if (setup.btcShieldBadge) tags.push(setup.btcShieldBadge);
          if (setup.adaptiveBadge) tags.push(setup.adaptiveBadge);

          activeSignal = {
            id: setup.id,
            symbol: symbol,
            type: 'LONG',
            timeframe: '15m',
            timestamp: setup.time,
            entry: setup.entry,
            stop: setup.stop,
            risk: setup.risk,
            takeProfit: setup.takeProfit,
            tp1: setup.tp1,
            tp2: setup.tp2,
            tp3: setup.tp3,
            beTrigger: setup.beTrigger,
            currentPrice: currentPrice,
            riskPercent: setup.riskPercent,
            score: setup.score,
            grade: setup.grade,
            tags: tags
          };
          break;
        }
      } else if (setup.type === 'SHORT') {
        if (!(setup.takeProfit < setup.entry && setup.entry < setup.stop)) continue;

        const isInSupplyZone = currentPrice <= (setup.top + (atr * 0.3)) && currentPrice >= (setup.entry * 0.9965);

        const currentClose = Number(currentCandle.close);
        const currentOpen = Number(currentCandle.open);
        const currentLow = Number(currentCandle.low);
        const currentHigh = Number(currentCandle.high);
        const prevClose = Number(prevCandle.close);
        const prevOpen = Number(prevCandle.open);

        const hasRejectionTrigger = (currentClose < currentOpen) ||
                                    ((currentHigh - currentClose) > (currentClose - currentLow)) ||
                                    (prevClose < prevOpen && Number(prevCandle.high) >= setup.entry);

        if (isInSupplyZone && hasRejectionTrigger) {
          const tags = [
            setup.gradeBadge,
            setup.hasBOS ? '✓ Major BOS Confirmado' : '✓ Sweep de Liquidez',
            '✓ Desplazamiento + FVG',
            `✓ HTF 4h en ${macroTrend.toLowerCase()}`,
            `✓ ${setup.zoneTag}`,
            setup.killzoneTag
          ];
          if (setup.hasDivergence) tags.push('⚡ Divergencia RSI Bajista');
          if (setup.hasLiquidityTarget) tags.push('🌊 Target: Piscina EQL');
          if (setup.btcShieldBadge) tags.push(setup.btcShieldBadge);
          if (setup.adaptiveBadge) tags.push(setup.adaptiveBadge);

          activeSignal = {
            id: setup.id,
            symbol: symbol,
            type: 'SHORT',
            timeframe: '15m',
            timestamp: setup.time,
            entry: setup.entry,
            stop: setup.stop,
            risk: setup.risk,
            takeProfit: setup.takeProfit,
            tp1: setup.tp1,
            tp2: setup.tp2,
            tp3: setup.tp3,
            beTrigger: setup.beTrigger,
            currentPrice: currentPrice,
            riskPercent: setup.riskPercent,
            score: setup.score,
            grade: setup.grade,
            tags: tags
          };
          break;
        }
      }
    }

    return {
      symbol,
      currentPrice,
      trend: macroTrend,
      activeSignal
    };
  }
}

window.SMCDetector = SMCDetector;


/* --- js/scanner.js --- */
/**
 * Crypto Scanner para los 15 Criptoactivos
 * Sistema Antirrepetidor + Auditoría Automática + BTC Trend Shield
 */
class CryptoScanner {
  constructor(api, detector, tracker = null, options = {}) {
    this.api = api;
    this.detector = detector;
    this.tracker = tracker;
    this.symbols = [
      { base: 'BTC', symbol: 'BTCUSDT' },
      { base: 'ETH', symbol: 'ETHUSDT' },
      { base: 'BNB', symbol: 'BNBUSDT' },
      { base: 'SOL', symbol: 'SOLUSDT' },
      { base: 'XRP', symbol: 'XRPUSDT' },
      { base: 'ADA', symbol: 'ADAUSDT' },
      { base: 'AVAX', symbol: 'AVAXUSDT' },
      { base: 'LINK', symbol: 'LINKUSDT' },
      { base: 'DOGE', symbol: 'DOGEUSDT' },
      { base: 'TON', symbol: 'TONUSDT' },
      { base: 'DOT', symbol: 'DOTUSDT' },
      { base: 'LTC', symbol: 'LTCUSDT' },
      { base: 'NEAR', symbol: 'NEARUSDT' },
      { base: 'SUI', symbol: 'SUIUSDT' },
      { base: 'APT', symbol: 'APTUSDT' }
    ];
    this.results = new Map();
    // Pre-poblar los 15 activos para que la tabla sea visible desde el primer milisegundo
    this.symbols.forEach(item => {
      this.results.set(item.symbol, {
        base: item.base,
        symbol: item.symbol,
        price: null,
        trend: 'ESCANEANDO...',
        signal: null,
        adaptiveProfile: null
      });
    });

    try {
      const savedTrades = JSON.parse(localStorage.getItem('smc_user_executed_trades')) || [];
      this.userExecutedTrades = savedTrades;
    } catch(e) {
      this.userExecutedTrades = [];
    }

    try {
      const savedDismissed = JSON.parse(localStorage.getItem('smc_dismissed_signals')) || [];
      this.dismissedSignals = new Set(savedDismissed);
    } catch(e) {
      this.dismissedSignals = new Set();
    }

    try {
      const saved = JSON.parse(localStorage.getItem('smc_notified_signals')) || [];
      this.notifiedSignals = new Set(saved);
    } catch(e) {
      this.notifiedSignals = new Set();
    }

    this.isScanning = false;
    this.isEnabled = true;
    this.lastScanTime = null;
    this.btcShieldState = null;
    this.onUpdate = options.onUpdate || null;
    this.onAlert = options.onAlert || null;
    this.scanIntervalMs = options.scanIntervalMs || 15000;
    this.timeoutId = null;
    this.concurrencyLimit = 5;
  }

  getSignalKey(sig) {
    if (!sig) return null;
    return sig.id || `${sig.symbol}_${sig.type}_${sig.timestamp}_${sig.entry.toFixed(4)}_${sig.stop.toFixed(4)}`;
  }

  async scanSymbol(item, btcShield = null) {
    try {
      const [res15m, res4h] = await Promise.allSettled([
        this.api.getKlines(item.symbol, '15m', 80),
        this.api.getKlines(item.symbol, '4h', 60)
      ]);

      const candles15m = res15m.status === 'fulfilled' && Array.isArray(res15m.value) ? res15m.value : null;
      const candles4h = res4h.status === 'fulfilled' && Array.isArray(res4h.value) ? res4h.value : null;

      if (!candles15m || candles15m.length < 35) {
        return null;
      }

      // 1. Auditar trades de simulación y trades reales del usuario con velas recientes
      if (this.tracker) {
        this.tracker.updateOpenTrades(item.symbol, candles15m);
      }
      this.updateUserExecutedTrades(item.symbol, candles15m);

      // 2. Extraer estado de BTC para el Shield
      if (item.symbol === 'BTCUSDT') {
        const last15m = candles15m[candles15m.length - 1];
        const prev15m = candles15m[candles15m.length - 2];
        const btcChange = ((Number(last15m.close) - Number(prev15m.open)) / Number(prev15m.open)) * 100;
        const btcTrend = this.detector.getMacroTrend(candles4h, candles15m);

        this.btcShieldState = {
          trend: btcTrend,
          isDumping: btcChange < -0.75,
          isPumping: btcChange > 0.75,
          change15m: btcChange
        };
      }

      const adaptiveProfile = this.tracker ? this.tracker.getAdaptiveProfile(item.symbol) : null;

      // 3. Ejecutar análisis SMC pasando el BTC Trend Shield
      const analysis = this.detector.analyze(item.symbol, candles15m, candles4h, adaptiveProfile, btcShield);
      if (!analysis) return null;

      const res = {
        base: item.base,
        symbol: item.symbol,
        price: analysis.currentPrice,
        trend: analysis.trend,
        signal: analysis.activeSignal,
        adaptiveProfile: adaptiveProfile
      };

      this.results.set(item.symbol, res);

      if (res.signal) {
        const signalKey = this.getSignalKey(res.signal);
        const isExecuted = this.isSignalExecutedOrDismissed(res.signal.id, res.symbol);

        if (signalKey && !this.notifiedSignals.has(signalKey) && !isExecuted) {
          this.notifiedSignals.add(signalKey);
          try {
            const arr = Array.from(this.notifiedSignals).slice(-200);
            localStorage.setItem('smc_notified_signals', JSON.stringify(arr));
          } catch(e) {}

          if (typeof this.onAlert === 'function') {
            this.onAlert(res);
          }
        }
      }

      return res;
    } catch (e) {
      console.warn(`[Scanner] Error procesando ${item.symbol}:`, e);
      return null;
    }
  }

  async scanAll() {
    if (this.isScanning || !this.isEnabled) return;
    this.isScanning = true;

    try {
      // 1. Escanear BTC primero para actualizar el BTC Shield
      const btcItem = this.symbols.find(s => s.symbol === 'BTCUSDT');
      if (btcItem) {
        await this.scanSymbol(btcItem, null);
        if (typeof this.onUpdate === 'function') {
          this.onUpdate(this.getAllResults());
        }
      }

      // 2. Escanear el resto de altcoins aplicando el BTC Shield
      const altcoins = this.symbols.filter(s => s.symbol !== 'BTCUSDT');

      for (let i = 0; i < altcoins.length; i += this.concurrencyLimit) {
        if (!this.isEnabled) break;
        const chunk = altcoins.slice(i, i + this.concurrencyLimit);
        await Promise.allSettled(chunk.map(item => this.scanSymbol(item, this.btcShieldState)));
        if (typeof this.onUpdate === 'function') {
          this.onUpdate(this.getAllResults());
        }
      }

      this.lastScanTime = new Date();

      if (typeof this.onUpdate === 'function') {
        this.onUpdate(this.getAllResults());
      }
    } catch (err) {
      console.error('[Scanner] Error en ciclo scanAll:', err);
    } finally {
      this.isScanning = false;
      if (this.isEnabled) {
        this.scheduleNext();
      }
    }
  }

  scheduleNext() {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.timeoutId = setTimeout(() => {
      if (this.isEnabled) {
        this.scanAll();
      }
    }, this.scanIntervalMs);
  }

  start() {
    this.isEnabled = true;
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.scanAll();
  }

  stop() {
    this.isEnabled = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.isScanning = false;
  }

  toggle() {
    if (this.isEnabled) {
      this.stop();
    } else {
      this.start();
    }
    return this.isEnabled;
  }

  addUserExecutedTrade(signal, extra = {}) {
    if (!signal || !signal.symbol) return;
    const exists = this.userExecutedTrades.some(t => t.id === signal.id && t.status === 'OPEN');
    if (!exists) {
      this.userExecutedTrades.unshift({
        id: signal.id,
        symbol: signal.symbol,
        type: signal.type,
        entry: signal.entry,
        stop: signal.stop,
        takeProfit: signal.takeProfit,
        quantity: extra.quantity || signal.quantity || 0,
        leverage: extra.leverage || signal.leverage || 2,
        status: 'OPEN',
        executedAt: Date.now()
      });
      if (this.userExecutedTrades.length > 100) this.userExecutedTrades.pop();
      this.saveUserExecutedTrades();
    }
  }

  saveUserExecutedTrades() {
    try {
      localStorage.setItem('smc_user_executed_trades', JSON.stringify(this.userExecutedTrades));
    } catch(e) {}
  }

  dismissSignal(signalId) {
    if (!signalId) return;
    this.dismissedSignals.add(signalId);
    try {
      const arr = Array.from(this.dismissedSignals).slice(-200);
      localStorage.setItem('smc_dismissed_signals', JSON.stringify(arr));
    } catch(e) {}
  }

  hasUserOpenTrade(symbol) {
    if (!symbol) return false;
    return this.userExecutedTrades.some(t => t.symbol === symbol && t.status === 'OPEN');
  }

  getUserOpenTrade(symbol) {
    if (!symbol) return null;
    return this.userExecutedTrades.find(t => t.symbol === symbol && t.status === 'OPEN') || null;
  }

  isSignalExecutedOrDismissed(signalId, symbol = '') {
    if (signalId && this.dismissedSignals.has(signalId)) return true;
    if (symbol && this.hasUserOpenTrade(symbol)) return true;
    if (signalId && this.userExecutedTrades.some(t => t.id === signalId && t.status === 'OPEN')) return true;
    return false;
  }

  updateUserExecutedTrades(symbol, candles15m) {
    if (!Array.isArray(candles15m) || candles15m.length === 0) return;
    const openTrades = this.userExecutedTrades.filter(t => t.symbol === symbol && t.status === 'OPEN');
    if (openTrades.length === 0) return;

    let changed = false;
    openTrades.forEach(trade => {
      const relevant = candles15m.filter(c => c.time >= (trade.executedAt ? Math.floor(trade.executedAt / 1000) - 900 : 0));
      for (const candle of relevant) {
        const high = Number(candle.high);
        const low = Number(candle.low);
        if (trade.type === 'LONG') {
          if (high >= trade.takeProfit || low <= trade.stop) {
            trade.status = 'CLOSED';
            changed = true;
            break;
          }
        } else if (trade.type === 'SHORT') {
          if (low <= trade.takeProfit || high >= trade.stop) {
            trade.status = 'CLOSED';
            changed = true;
            break;
          }
        }
      }
    });

    if (changed) {
      this.saveUserExecutedTrades();
    }
  }

  getExecutedPayload() {
    return {
      userTrades: this.userExecutedTrades,
      dismissed: Array.from(this.dismissedSignals)
    };
  }

  mergeSyncPayload(payload) {
    if (!payload) return false;
    let changed = false;

    if (Array.isArray(payload.userTrades)) {
      payload.userTrades.forEach(remote => {
        const local = this.userExecutedTrades.find(t => t.id === remote.id);
        if (!local) {
          this.userExecutedTrades.push(remote);
          changed = true;
        } else if (local.status === 'OPEN' && remote.status !== 'OPEN') {
          local.status = remote.status;
          changed = true;
        }
      });
      if (changed) this.saveUserExecutedTrades();
    }

    if (Array.isArray(payload.dismissed)) {
      payload.dismissed.forEach(id => {
        if (id && !this.dismissedSignals.has(id)) {
          this.dismissedSignals.add(id);
          changed = true;
        }
      });
      if (changed) {
        try {
          localStorage.setItem('smc_dismissed_signals', JSON.stringify(Array.from(this.dismissedSignals).slice(-200)));
        } catch(e) {}
      }
    }

    return changed;
  }

  getAllResults() {
    return Array.from(this.results.values());
  }

  getActiveSignals() {
    return this.getAllResults()
      .filter(r => r.signal !== null && !this.isSignalExecutedOrDismissed(r.signal.id, r.symbol))
      .map(r => r.signal);
  }
}

window.CryptoScanner = CryptoScanner;


/* --- js/binance_trade.js --- */
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
    const targetHost   = this.isDemo() ? 'testnet.binancefuture.com' : 'fapi.binance.com';
    const proxyPrefix  = this.isDemo() ? '/proxy-binance-demo' : '/proxy-binance-real';
    const corsHeaders  = { 'X-MBX-APIKEY': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' };

    // ── Contexto ─────────────────────────────────────────────────────────────
    const hostname = typeof window !== 'undefined' ? (window.location?.hostname || '') : '';
    const isOnVercel = hostname.endsWith('vercel.app');
    const isLocal  = hostname === 'localhost' || hostname === '127.0.0.1' ||
                     hostname.startsWith('192.168.') || hostname.startsWith('10.');

    // ── Intento 1: Vercel Proxy (mismo origen — funciona en PC y móvil sin CORS) ──
    if (isOnVercel) {
      try {
        const res = await fetch(`${proxyPrefix}${path}?${fullPayload}`, {
          method,
          headers: corsHeaders,
          signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
        });
        const text = await res.text();
        if (text && !text.trim().startsWith('<')) {
          const data = JSON.parse(text);
          if (data?.code && data.code !== 200 && data.msg) throw new Error(`Binance (${data.code}): ${data.msg}`);
          console.log('[Trade] ✅ Vercel proxy OK');
          return data;
        }
      } catch (ve) {
        if (ve.message.startsWith('Binance')) throw ve;
        console.warn('[Trade] ⚠️ Vercel proxy falló:', ve.message);
      }
    }

    // ── Intento 2: localhost:3000 (desarrollo en PC con server.js) ───────────
    if (isLocal) {
      try {
        const origin = window.location.origin.includes(':3000')
          ? window.location.origin
          : `${window.location.protocol}//${hostname}:3000`;
        const res  = await fetch(`${origin}${proxyPrefix}${path}?${fullPayload}`, {
          method, headers: { 'X-MBX-APIKEY': apiKey, 'X-Target-Host': targetHost }
        });
        const text = await res.text();
        if (res.ok && text && !text.trim().startsWith('<')) {
          console.log('[Trade] ✅ localhost proxy OK');
          return JSON.parse(text);
        }
      } catch (_) {}

      try {
        const res  = await fetch(`http://localhost:3000${proxyPrefix}${path}?${fullPayload}`, {
          method, headers: { 'X-MBX-APIKEY': apiKey, 'X-Target-Host': targetHost },
          signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined
        });
        const text = await res.text();
        if (res.ok && text && !text.trim().startsWith('<')) {
          console.log('[Trade] ✅ localhost:3000 OK');
          return JSON.parse(text);
        }
      } catch (_) {}
    }

    // ── Intento 3: Directo Binance (GET públicos sin CORS, POST directo) ──────
    try {
      const res  = await fetch(`${baseUrl}${path}?${fullPayload}`, { method, headers: corsHeaders });
      const text = await res.text();
      if (text && !text.trim().startsWith('<') && !text.trim().startsWith('<!DOCTYPE')) {
        const data = JSON.parse(text);
        if (data?.code && data.code !== 200 && data.msg) throw new Error(`Binance (${data.code}): ${data.msg}`);
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


/* --- js/cloud_sync.js --- */
/**
 * Cloud Sync Engine — Sincronización en Tiempo Real entre PC y Móvil
 * Sincroniza: Win Rate, Historial de Trades, Memoria Adaptativa y Capital
 */
class CloudSync {
  constructor(options = {}) {
    this.syncKeyName = 'smc_sync_room_id';
    this.roomId = this.getOrCreateRoomId();
    this.onSyncCallback = options.onSync || null;
    this.syncIntervalMs = 12000; // Sincroniza cada 12s
    this.timer = null;
    this.eventSource = null;
  }

  getOrCreateRoomId() {
    let id = localStorage.getItem(this.syncKeyName);
    // Si no está configurado o tenía un ID aleatorio previo, unificar en la sala compartida
    if (!id || id.startsWith('LICEISTAS-')) {
      id = 'LICEISTAS_PRO_SYNC';
      localStorage.setItem(this.syncKeyName, id);
    }
    return id;
  }

  getChannelName() {
    const clean = this.roomId.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    return `smc_sync_${clean}`;
  }

  setRoomId(newId) {
    if (!newId || newId.trim().length < 3) return;
    this.roomId = newId.trim().toUpperCase();
    localStorage.setItem(this.syncKeyName, this.roomId);
    this.connectLiveStream();
    this.pullFromCloud();
  }

  getRoomId() {
    return this.roomId;
  }

  // ─── PUSH: Envía el estado local a la nube ───────────────────────────────
  async pushToCloud(data) {
    try {
      const channel = this.getChannelName();
      const payload = {
        roomId: this.roomId,
        updatedAt: Date.now(),
        trades: data.trades || [],
        memory: data.memory || {},
        stats: data.stats || null,
        syncPayload: data.syncPayload || null,
        userCapital: data.userCapital || 500,
        userRiskPct: data.userRiskPct || 1.0,
        filterMode: data.filterMode || 'suave'
      };

      // Guardar también copia local de respaldo
      localStorage.setItem('smc_cloud_backup', JSON.stringify(payload));

      await fetch(`https://ntfy.sh/${channel}`, {
        method: 'POST',
        headers: {
          'Title': `SMC Sync ${this.roomId}`,
          'Priority': 'low',
          'Tags': 'cloud,sync'
        },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      console.warn('[CloudSync] Error push:', e.message);
    }
  }

  // ─── PULL: Descarga y fusiona el estado más reciente de la nube ───────────
  async pullFromCloud() {
    try {
      const channel = this.getChannelName();
      const res = await fetch(`https://ntfy.sh/${channel}/json?poll=1&since=24h`);
      if (res.ok) {
        const text = await res.text();
        const lines = text.trim().split('\n').filter(Boolean);
        if (lines.length > 0) {
          // Obtener el último mensaje publicado
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const msgObj = JSON.parse(lines[i]);
              if (msgObj.event === 'message' && msgObj.message) {
                const cloudData = JSON.parse(msgObj.message);
                if (cloudData && typeof this.onSyncCallback === 'function') {
                  this.onSyncCallback(cloudData);
                }
                return cloudData;
              }
            } catch (pErr) {}
          }
        }
      }
    } catch (e) {
      console.warn('[CloudSync] Error pull:', e.message);
    }
    return null;
  }

  connectLiveStream() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    try {
      const channel = this.getChannelName();
      this.eventSource = new EventSource(`https://ntfy.sh/${channel}/sse`);
      this.eventSource.onmessage = (e) => {
        try {
          const raw = JSON.parse(e.data);
          if (raw.event === 'message' && raw.message) {
            const cloudData = JSON.parse(raw.message);
            if (cloudData && cloudData.roomId === this.roomId && typeof this.onSyncCallback === 'function') {
              this.onSyncCallback(cloudData);
            }
          }
        } catch (err) {}
      };
      this.eventSource.onerror = () => {};
    } catch (err) {
      console.warn('[CloudSync SSE]', err.message);
    }
  }

  startAutoSync(getDataCallback) {
    if (this.timer) clearInterval(this.timer);
    
    // Conectar flujo en vivo SSE + Pull inicial
    this.connectLiveStream();
    this.pullFromCloud();

    this.timer = setInterval(async () => {
      // Si hay datos locales, enviar actualización periódica
      if (typeof getDataCallback === 'function') {
        const local = getDataCallback();
        if (local) {
          await this.pushToCloud(local);
        }
      }
    }, this.syncIntervalMs);
  }

  stopAutoSync() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }
}

window.CloudSync = CloudSync;


/* --- js/app.js --- */
/**
 * Controlador de Señales Order Block + Integración Discord Webhooks + Binance USDT-M Futuros + Calculadora de Apalancamiento
 */
document.addEventListener('DOMContentLoaded', () => {
  const binanceAPI = new BinanceAPI();
  binanceAPI.setMarketType('futures');

  const smcDetector = new SMCDetector({ filterMode: localStorage.getItem('smc_filter_mode') || 'estricto' });
  window._smcDetector = smcDetector; // Expuesto para el script inline de filtros

  // Motor de Ejecución Directa de Órdenes (API Binance Futuros)
  const binanceTrade = new BinanceTrade();

  // Signal pendiente de confirmación en el modal de trade
  let pendingTradeSignal = null;
  let pendingBEEvent = null;

  // Parámetros de Capital y Riesgo del Usuario
  let userCapital = parseFloat(localStorage.getItem('user_trading_capital')) || 500;
  let userRiskPct = parseFloat(localStorage.getItem('user_trading_risk_pct')) || 1.0;

  // Declarar scanner tempranamente para evitar ReferenceError en callbacks asíncronos
  let scanner = null;

  // Mapa de Posiciones en Tiempo Real de Binance Futuros
  let binancePositionsMap = {};

  async function syncBinancePositions() {
    if (!binanceTrade || !binanceTrade.isConfigured() || !scanner) return;
    try {
      const positions = await binanceTrade.getOpenPositions();
      if (Array.isArray(positions)) {
        const newMap = {};
        positions.forEach(p => {
          newMap[p.symbol] = p;
        });
        binancePositionsMap = newMap;

        // Auto-sincronizar posiciones existentes de Binance con el scanner
        positions.forEach(p => {
          const fmtSymbol = p.symbol.endsWith('USDT') ? `${p.symbol.replace('USDT', '')}/USDT` : p.symbol;
          if (scanner && !scanner.hasUserOpenTrade(fmtSymbol)) {
            scanner.addUserExecutedTrade({
              id: `binance_${p.symbol}`,
              symbol: fmtSymbol,
              type: p.side,
              entry: p.entryPrice,
              stop: 0,
              takeProfit: 0
            }, {
              quantity: p.amount,
              leverage: p.leverage
            });
          }
        });
      }
    } catch (err) {
      // Silencioso
    }
  }

  // Inicializar TradeTracker con Callback de Eventos en Vivo
  const tradeTracker = new TradeTracker({
    onTradeEvent: (event) => {
      handleTradeLifeEvent(event);
      if (window._cloudSync && scanner) {
        window._cloudSync.pushToCloud({
          trades: tradeTracker.trades,
          memory: tradeTracker.memory,
          syncPayload: scanner.getExecutedPayload(),
          userCapital,
          userRiskPct,
          filterMode: smcDetector.filterMode
        });
      }
    }
  });

  // Instanciar CryptoScanner de inmediato para que esté disponible para todos los callbacks
  scanner = new CryptoScanner(binanceAPI, smcDetector, tradeTracker, {
    scanIntervalMs: 15000,
    onUpdate: (results) => {
      try { renderApp(results); } catch (e) { console.warn('[App] Error en renderApp:', e); }
    },
    onAlert: handleAlert
  });

  // Motor de Sincronización en la Nube (PC ↔ Móvil)
  const cloudSync = new CloudSync({
    onSync: (cloudData) => {
      let changed = false;
      if (cloudData.syncPayload && scanner && typeof scanner.mergeSyncPayload === 'function') {
        if (scanner.mergeSyncPayload(cloudData.syncPayload)) changed = true;
      }
      if (tradeTracker.mergeCloudData(cloudData)) changed = true;

      if (changed && scanner) {
        try { renderApp(scanner.getAllResults()); } catch (_) {}
      }
    }
  });
  window._cloudSync = cloudSync;

  cloudSync.startAutoSync(() => ({
    trades: tradeTracker.trades,
    memory: tradeTracker.memory,
    syncPayload: scanner ? scanner.getExecutedPayload() : null,
    userCapital,
    userRiskPct,
    filterMode: smcDetector.filterMode
  }));

  // Polling de posiciones cada 8s
  setTimeout(syncBinancePositions, 1500);
  setInterval(syncBinancePositions, 8000);
  
  let audioEnabled = true;
  let audioCtx = null;
  let discordWebhookUrl = localStorage.getItem('discord_webhook_url') || '';

  function playChime(type = 'LONG') {
    if (!audioEnabled) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      const now = audioCtx.currentTime;
      if (type === 'LONG') {
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.exponentialRampToValueAtTime(880.00, now + 0.15); // A5
      } else {
        osc.frequency.setValueAtTime(880.00, now);
        osc.frequency.exponentialRampToValueAtTime(587.33, now + 0.15);
      }
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
      osc.start(now);
      osc.stop(now + 0.5);
    } catch (e) {
      console.warn('Audio Context error:', e);
    }
  }

  function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const t = document.createElement('div');
    const borderCol = type === 'success' ? 'border-emerald-500' : (type === 'danger' ? 'border-rose-500' : 'border-indigo-500');
    t.className = `bg-gray-900 border ${borderCol} text-white text-xs font-semibold px-4 py-2.5 rounded-xl shadow-2xl animate-fade mb-2 flex items-center gap-2`;
    t.innerHTML = `<span>${type === 'success' ? '✅' : (type === 'danger' ? '⚠️' : '💬')}</span><span>${msg}</span>`;
    container.appendChild(t);
    setTimeout(() => {
      t.remove();
    }, 3500);
  }

  function sendBrowserNotification(title, body) {
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        try {
          new Notification(title, { body, icon: 'icons/icon-192.png' });
        } catch (e) {}
      } else if (Notification.permission === 'default') {
        Notification.requestPermission();
      }
    }
  }

  function copyText(val, label) {
    if (!navigator.clipboard) {
      showToast(`Portapapeles no disponible`, 'danger');
      return;
    }
    navigator.clipboard.writeText(val).then(() => {
      showToast(`¡${label} copiado! (${val})`, 'success');
    }).catch(() => {
      showToast(`No se pudo copiar`, 'danger');
    });
  }

  function formatPrice(val, symbol = '') {
    if (val === null || val === undefined || isNaN(val)) return '...';
    const num = Number(val);
    
    if (symbol) {
      const decimals = binanceAPI.getPrecision(symbol);
      return num.toFixed(decimals);
    }

    if (num >= 1000) return num.toFixed(2);
    if (num >= 50) return num.toFixed(2);
    if (num >= 1) return num.toFixed(4);
    if (num >= 0.01) return num.toFixed(5);
    if (num >= 0.0001) return num.toFixed(6);
    return num.toFixed(8);
  }

  /**
   * Calculadora de Posición y Apalancamiento
   */
  function calculatePosition(entry, riskPercent) {
    const maxLossUSDT = userCapital * (userRiskPct / 100);
    const distDecimal = Math.max(0.001, riskPercent / 100);
    const totalPositionUSDT = maxLossUSDT / distDecimal;
    const quantity = totalPositionUSDT / entry;
    const rawLeverage = totalPositionUSDT / userCapital;
    const suggestedLeverage = Math.min(50, Math.max(2, Math.ceil(rawLeverage)));
    const requiredMargin = totalPositionUSDT / suggestedLeverage;

    return {
      maxLossUSDT: maxLossUSDT.toFixed(2),
      totalPositionUSDT: totalPositionUSDT.toFixed(1),
      quantity: quantity,
      suggestedLeverage: `${suggestedLeverage}x`,
      requiredMargin: requiredMargin.toFixed(1)
    };
  }

  /**
   * Notificación a Discord de Eventos en Vivo (TP1 Hit, TP3 Hit, SL)
   */
  async function handleTradeLifeEvent(event) {
    const trade = event.trade;
    // Solo procesar avisos de TP1/TP3/SL si el usuario ejecutó la orden
    if (!scanner.hasUserOpenTrade(trade.symbol)) return;

    const cleanPair = trade.symbol.replace('/', '').toUpperCase();
    const formattedPrice = formatPrice(event.price, trade.symbol);
    const binanceUrl = `https://www.binance.com/es/futures/${cleanPair}`;

    let title = '';
    let description = '';
    let colorCode = 0x10b981;

    if (event.type === 'TP1_HIT') {
      title = `🎉 ¡TP1 ALCANZADO (+1.5R): ${cleanPair}!`;
      description = `El precio de **${cleanPair}** alcanzó **$${formattedPrice}**.\n\n🛡️ **ACCIÓN RECOMENDADA:**\n1. Cierra el **50% de tu posición** para asegurar ganancias.\n2. Mueve tu Stop Loss al precio de entrada (**$${formatPrice(trade.entry, trade.symbol)}** - Breakeven).`;
      colorCode = 0x3b82f6; // Azul

      playChime('LONG');
      if (navigator.vibrate) {
        try { navigator.vibrate([200, 100, 200]); } catch(e) {}
      }

      // Preparar datos para el modal de decisión interactivo
      pendingBEEvent = { symbol: trade.symbol, entry: trade.entry, type: trade.type, price: event.price };
      const beModal = document.getElementById('modal-tp1-be');
      const bePairEl = document.getElementById('be-modal-pair');
      const beCurrentEl = document.getElementById('be-modal-current-price');
      const beEntryEl = document.getElementById('be-modal-entry-price');
      const btnApplyBE = document.getElementById('btn-apply-be');

      if (bePairEl) bePairEl.textContent = `${cleanPair} (${trade.type})`;
      if (beCurrentEl) beCurrentEl.textContent = `$${formattedPrice}`;
      if (beEntryEl) beEntryEl.textContent = `$${formatPrice(trade.entry, trade.symbol)}`;

      if (btnApplyBE) {
        btnApplyBE.disabled = false;
        btnApplyBE.className = 'w-full py-3 bg-yellow-500 hover:bg-yellow-400 text-black font-extrabold rounded-xl text-sm transition-all active:scale-95 flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-yellow-500/20';
        btnApplyBE.innerHTML = '<span>🛡️</span> Mover SL a Breakeven en Binance';
      }

      showToast(`🎉 ¡TP1 alcanzado en ${cleanPair} (+1.5R)! Ganancia asegurada.`, 'success');
      sendBrowserNotification(`🎉 ¡TP1 Alcanzado (+1.5R): ${cleanPair}!`, `🎯 Precio: $${formattedPrice}. Puedes mover tu SL a Breakeven.`);

      if (beModal) beModal.classList.remove('hidden');

    } else if (event.type === 'TP3_HIT') {
      title = `🚀 ¡OBJETIVO FINAL 1:3 ALCANZADO: ${cleanPair} (+3.0R)!`;
      description = `🎯 El precio de **${cleanPair}** completó el recorrido institucional hasta **$${formattedPrice}**.\n\n💰 **TRADE GANADOR CERRADO CON ÉXITO (+3.0R)**.`;
      colorCode = 0x10b981; // Verde

      showToast(`🚀 ¡TAKE PROFIT 1:3 ALCANZADO en ${cleanPair} (+3.0R)!`, 'success');
      playChime('LONG');
      if (navigator.vibrate) {
        try { navigator.vibrate([200, 100, 200, 100, 200]); } catch(e) {}
      }
      sendBrowserNotification(`🚀 ¡Take Profit 1:3: ${cleanPair}!`, `🎯 Precio: $${formattedPrice} (+3.0R Ganancia).`);

    } else if (event.type === 'SL_HIT') {
      title = `🛑 Stop Loss Tocado en ${cleanPair}`;
      description = `El precio tocó el Stop Loss en **$${formattedPrice}**.\n*Pérdida máxima controlada por gestión de riesgo.*`;
      colorCode = 0xef4444; // Rojo

      showToast(`🛑 Stop Loss tocado en ${cleanPair} ($${formattedPrice})`, 'danger');
      playChime('SHORT');
      if (navigator.vibrate) {
        try { navigator.vibrate([300, 150, 300]); } catch(e) {}
      }
      sendBrowserNotification(`🛑 Stop Loss: ${cleanPair}`, `Precio tocó SL en $${formattedPrice}. Pérdida controlada.`);
    }

    if (!discordWebhookUrl || !discordWebhookUrl.startsWith('http')) return;

    const payload = {
      username: 'Binance SMC Bot',
      avatar_url: 'https://bin.bnbstatic.com/static/images/common/favicon.ico',
      embeds: [
        {
          title: title,
          url: binanceUrl,
          description: description,
          color: colorCode,
          fields: [
            { name: 'Entrada Original', value: `\`$${formatPrice(trade.entry, trade.symbol)}\``, inline: true },
            { name: 'Tipo', value: `\`${trade.type}\``, inline: true },
            { name: 'Enlace', value: `[Abrir ${cleanPair} en Binance](${binanceUrl})`, inline: true }
          ],
          timestamp: new Date().toISOString()
        }
      ]
    };

    try {
      await fetch(discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {}
  }

  async function sendDiscordSignal(signal) {
    if (!discordWebhookUrl || !discordWebhookUrl.startsWith('http')) return false;

    const isLong = signal.type === 'LONG';
    const colorCode = isLong ? 0x10b981 : 0xef4444;
    const typeEmoji = isLong ? '🟢 LONG (COMPRA)' : '🔴 SHORT (VENTA)';
    const arrowEmoji = isLong ? '↗️' : '↘️';

    const cleanPair = signal.symbol.replace('/', '').toUpperCase();
    const binanceFuturesUrl = `https://www.binance.com/es/futures/${cleanPair}`;
    const tradingViewUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${cleanPair}PERP`;

    const formattedEntry = formatPrice(signal.entry, signal.symbol);
    const formattedStop = formatPrice(signal.stop, signal.symbol);
    const formattedTP = formatPrice(signal.takeProfit, signal.symbol);
    
    const tp1Val = signal.tp1 !== undefined ? signal.tp1 : (isLong ? signal.entry + (signal.risk * 1.5) : signal.entry - (signal.risk * 1.5));
    const formattedTP1 = formatPrice(tp1Val, signal.symbol);

    // Cálculo de Posición
    const pos = calculatePosition(signal.entry, signal.riskPercent);
    const qtyFormatted = formatPrice(pos.quantity, signal.symbol);

    const tagsFormatted = signal.tags && signal.tags.length > 0 
      ? signal.tags.join('\n') 
      : '✓ Order Block Institucional 15m\n✓ Ratio Riesgo/Beneficio 1:3';

    const embedPayload = {
      username: 'Binance SMC Bot',
      avatar_url: 'https://bin.bnbstatic.com/static/images/common/favicon.ico',
      embeds: [
        {
          title: `⚡ ${signal.symbol} (${arrowEmoji} ${signal.type}) - ABRIR EN BINANCE FUTUROS`,
          url: binanceFuturesUrl,
          description: `🚀 **[CLIC AQUÍ PARA ABRIR ${cleanPair} EN BINANCE FUTUROS](${binanceFuturesUrl})**\n\nSe ha detectado un **Order Block Institucional (15m)** con confirmación **BOS** y ratio **1:3** en **Binance Futuros USDT-M**.`,
          color: colorCode,
          fields: [
            {
              name: '📌 Tipo de Orden',
              value: `\`${typeEmoji}\``,
              inline: true
            },
            {
              name: '🎯 Entrada (Futuros)',
              value: `\`\`\`${formattedEntry}\`\`\``,
              inline: true
            },
            {
              name: '🛑 Stop Loss Estructural',
              value: `\`\`\`${formattedStop}\`\`\``,
              inline: true
            },
            {
              name: '💰 Take Profit (1:3)',
              value: `\`\`\`${formattedTP}\`\`\``,
              inline: true
            },
            {
              name: '📏 Distancia SL',
              value: `\`${signal.riskPercent.toFixed(2)}%\``,
              inline: true
            },
            {
              name: '🛡️ Gestión de Posición',
              value: `\`Toma 50% parcial en: ${formattedTP1}\``,
              inline: true
            },
            {
              name: '⚡ GESTIÓN DE CAPITAL Y APALANCAMIENTO:',
              value: `• **Apalancamiento sugerido:** \`${pos.suggestedLeverage}\`\n• **Margen necesario:** \`$${pos.requiredMargin} USDT\`\n• **Tamaño de orden:** \`${qtyFormatted} ${signal.symbol.replace('USDT','')}\` (~$${pos.totalPositionUSDT} USDT)\n• **Pérdida Máxima al SL:** \`-$${pos.maxLossUSDT} USDT\` (Controlada al ${userRiskPct}%)`,
              inline: false
            },
            {
              name: '📋 VALORES LISTOS PARA PEGAR EN FUTUROS:',
              value: `**Entrada:** \`${formattedEntry}\`\n**Stop Loss:** \`${formattedStop}\`\n**TP1 (Toma 50% en 1:1.5):** \`${formattedTP1}\`\n**TP Final (1:3):** \`${formattedTP}\``,
              inline: false
            },
            {
              name: '🔗 Enlace Directo a Futuros:',
              value: `👉 [**Abrir ${cleanPair} en Binance Futuros**](${binanceFuturesUrl})\n${binanceFuturesUrl}`,
              inline: false
            },
            {
              name: '🔍 Confluencias Validadas',
              value: tagsFormatted,
              inline: false
            }
          ],
          footer: {
            text: 'Binance USDT-M Futures Signals · SMC Engine + Adaptive AI',
            icon_url: 'https://bin.bnbstatic.com/static/images/common/favicon.ico'
          },
          timestamp: new Date().toISOString()
        }
      ],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: `🚀 Abrir ${cleanPair} en Binance Futuros`,
              url: binanceFuturesUrl
            },
            {
              type: 2,
              style: 5,
              label: '📊 Ver en TradingView',
              url: tradingViewUrl
            }
          ]
        }
      ]
    };

    try {
      const response = await fetch(discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(embedPayload)
      });

      return response.ok;
    } catch (e) {
      console.warn('[Discord] Error enviando webhook:', e);
      return false;
    }
  }

  function handleAlert(item) {
    if (item.signal) {
      playChime(item.signal.type);
      showToast(`Nueva señal ${item.signal.type} en ${item.symbol}`, 'success');
      sendDiscordSignal(item.signal);
    }
  }

  function updateDiscordBadge() {
    const badge = document.getElementById('discord-status-badge');
    if (badge) {
      if (discordWebhookUrl && discordWebhookUrl.startsWith('http')) {
        badge.className = 'px-2 py-0.5 text-[9px] font-bold rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 animate-pulse';
        badge.textContent = '● Webhook Conectado';
      } else {
        badge.className = 'px-2 py-0.5 text-[9px] font-bold rounded bg-gray-800 text-gray-400';
        badge.textContent = 'Sin Webhook';
      }
    }
  }

  function updateCapitalKPIs() {
    const elMaxLoss = document.getElementById('kpi-max-loss');
    if (elMaxLoss) {
      const loss = (userCapital * (userRiskPct / 100)).toFixed(2);
      elMaxLoss.textContent = `$${loss}`;
    }
  }

  function renderApp(results) {
    const timeEl = document.getElementById('last-scan-time');
    if (timeEl) {
      const now = new Date();
      timeEl.textContent = `Último escaneo: ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
    }

    const trackerStats = tradeTracker.getGlobalStats();
    const elWinRate = document.getElementById('tracker-win-rate');
    const elTotalTrades = document.getElementById('tracker-total-trades');
    const elNetR = document.getElementById('tracker-net-r');

    if (elWinRate) elWinRate.textContent = trackerStats.totalTrades > 0 ? trackerStats.winRate : '100%';
    if (elTotalTrades) elTotalTrades.textContent = `${trackerStats.totalTrades} (${trackerStats.wins}W / ${trackerStats.losses}L)`;
    if (elNetR) elNetR.textContent = `${trackerStats.netR} Ganancia`;

    const activeSignals = scanner.getActiveSignals();
    
    const kpiCount = document.getElementById('kpi-signals-count');
    if (kpiCount) kpiCount.textContent = activeSignals.length;

    const signalsContainer = document.getElementById('active-signals-container');
    if (signalsContainer) {
      signalsContainer.innerHTML = '';

      if (activeSignals.length === 0) {
        signalsContainer.innerHTML = `
          <div class="card-box p-6 text-center text-xs text-gray-500">
            No hay señales pendientes de ejecución en este momento.<br>
            <span class="text-[11px] text-gray-600">El sistema monitorea zonas de liquidez y FVG de 15m con BTC Shield y Killzones.</span>
          </div>
        `;
      } else {
        activeSignals.forEach(s => {
          const isLong = s.type === 'LONG';
          const card = document.createElement('div');
          card.className = 'card-box p-4 flex flex-col gap-3';

          const dateStr = new Date(s.timestamp * 1000).toLocaleString('es-ES', {
            day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
          });

          const formattedEntry = formatPrice(s.entry, s.symbol);
          const formattedStop = formatPrice(s.stop, s.symbol);
          const formattedTP = formatPrice(s.takeProfit, s.symbol);
          const currentTP1 = s.tp1 !== undefined ? s.tp1 : (isLong ? s.entry + (s.risk * 1.5) : s.entry - (s.risk * 1.5));
          const formattedCardTP1 = formatPrice(currentTP1, s.symbol);

          // Cálculo de Posición
          const pos = calculatePosition(s.entry, s.riskPercent);
          const qtyFormatted = formatPrice(pos.quantity, s.symbol);

          const cleanPair = s.symbol.replace('/', '').toUpperCase();
          const binanceFuturesUrl = `https://www.binance.com/es/futures/${cleanPair}`;
          const tradingViewUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${cleanPair}PERP`;

          const tagsHTML = s.tags.map(t => `<span class="tag-pill">${t}</span>`).join('');

          card.innerHTML = `
            <div class="flex items-center justify-between">
              <div>
                <a href="${binanceFuturesUrl}" target="_blank" class="font-extrabold text-base text-white hover:text-amber-400 flex items-center gap-1.5 transition-colors group" title="Haz clic para abrir ${cleanPair} en Binance Futuros">
                  <span>${s.symbol.replace('USDT', '')}</span><span class="text-xs font-normal text-amber-400">/USDT (Futuros)</span>
                  <span class="text-xs opacity-60 group-hover:opacity-100">↗</span>
                </a>
                <div class="text-[10px] text-gray-400 mt-0.5">
                  Order Block · 15m · ${dateStr}
                </div>
              </div>
              <div class="flex items-center gap-2">
                ${s.score ? `
                  <div class="px-2.5 py-1 rounded-lg text-[11px] font-black border ${
                    s.grade === 'A+' 
                      ? 'bg-amber-500/15 border-yellow-500/40 text-yellow-300 shadow-sm shadow-yellow-500/20' 
                      : (s.grade === 'A' ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300' : 'bg-gray-800 border-gray-700 text-gray-300')
                  }">
                    ${s.grade === 'A+' ? '👑' : '🎯'} ${s.score} pts · ${s.grade || 'A'}
                  </div>
                ` : ''}
                <div class="px-3 py-1 rounded-lg text-xs font-black flex items-center gap-1 ${
                  isLong ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
                }">
                  <span>${isLong ? '↗' : '↘'}</span> ${s.type}
                </div>
              </div>
            </div>

            <!-- 3 Botoncitos de Copia en 1 Clic con Decimales Exactos de Binance -->
            <div class="flex gap-2">
              <div class="metric-pill-copy group" data-copy="${formattedEntry}" data-label="Precio de Entrada" title="Haz clic para copiar con decimales exactos">
                <div class="text-[10px] font-bold text-gray-400 uppercase flex items-center justify-center gap-1">
                  <span>ENTRADA</span> <span class="text-[9px] opacity-60 group-hover:opacity-100">📋</span>
                </div>
                <div class="text-xs font-mono font-bold text-white mt-1">${formattedEntry}</div>
              </div>

              <div class="metric-pill-copy group" data-copy="${formattedStop}" data-label="Stop Loss" title="Haz clic para copiar con decimales exactos">
                <div class="text-[10px] font-bold text-rose-400 uppercase flex items-center justify-center gap-1">
                  <span>STOP</span> <span class="text-[9px] opacity-60 group-hover:opacity-100">📋</span>
                </div>
                <div class="text-xs font-mono font-bold text-rose-400 mt-1">${formattedStop}</div>
              </div>

              <div class="metric-pill-copy group" data-copy="${formattedTP}" data-label="Take Profit 1:3" title="Haz clic para copiar con decimales exactos">
                <div class="text-[10px] font-bold text-emerald-400 uppercase flex items-center justify-center gap-1">
                  <span>TP (1:3)</span> <span class="text-[9px] opacity-60 group-hover:opacity-100">📋</span>
                </div>
                <div class="text-xs font-mono font-bold text-emerald-400 mt-1">${formattedTP}</div>
              </div>
            </div>

            <!-- Panel de Capital y Apalancamiento Sugerido -->
            <div class="p-3 bg-bgDark rounded-xl border border-borderSubtle grid grid-cols-3 gap-2">
              <div>
                <div class="text-[10px] text-gray-400 font-bold uppercase">APALANCAMIENTO</div>
                <div class="text-yellow-400 font-mono font-bold text-xs mt-0.5">${pos.suggestedLeverage}</div>
              </div>

              <div class="text-center border-x border-gray-800 px-1">
                <div class="text-[10px] text-gray-400 font-bold uppercase">TAMAÑO POSICIÓN</div>
                <div class="text-white font-mono font-bold text-xs mt-0.5 truncate" title="${qtyFormatted} ${s.symbol.replace('USDT','')}">${qtyFormatted} <span class="text-[10px] text-gray-400 font-normal">($${pos.totalPositionUSDT})</span></div>
              </div>

              <div class="text-right">
                <div class="text-[10px] text-gray-400 font-bold uppercase">MARGEN NECESARIO</div>
                <div class="text-emerald-400 font-mono font-bold text-xs mt-0.5">$${pos.requiredMargin} USDT</div>
              </div>
            </div>

            <!-- Metas Parciales y Gestión de Riesgo Profesional -->
            <div class="bg-[#131b2c] p-2.5 rounded-lg border border-borderSubtle text-[11px] flex items-center justify-between text-gray-300 leading-snug">
              <span>🛡️ <strong>Gestión:</strong> Toma 50% de ganancia en <strong>$${formattedCardTP1}</strong> (1:1.5) y deja correr a 1:3</span>
            </div>

            <!-- Tags SMC + Badges -->
            <div class="flex flex-wrap gap-1.5 pt-1">
              ${tagsHTML}
            </div>

            <!-- Botones de Acción Directa a Binance Futuros -->
            <div class="flex items-center gap-2 pt-1">
              <a href="${binanceFuturesUrl}" target="_blank" class="py-2 px-3 bg-amber-500/15 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-1.5 shadow-md active:scale-95" title="Abrir terminal de Futuros USDT-M en Binance">
                <span>🚀</span> Binance
              </a>
              <a href="${tradingViewUrl}" target="_blank" class="py-2 px-3 bg-blue-500/15 hover:bg-blue-500/30 border border-blue-500/40 text-blue-300 text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-1.5 shadow-md active:scale-95">
                <span>📊</span> Chart
              </a>
              <button class="btn-copy-card-plan px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-bold rounded-xl transition-all flex items-center gap-1 active:scale-95" data-entry="${formattedEntry}" data-stop="${formattedStop}" data-tp="${formattedTP}" data-tp1="${formattedCardTP1}" data-symbol="${s.symbol}" data-type="${s.type}">
                <span>📋</span>
              </button>
              <!-- ⚡ BOTÓN PRINCIPAL: EJECUTAR ORDEN DIRECTA -->
              <button class="btn-execute-trade flex-1 py-2 px-3 ${isLong ? 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/30' : 'bg-rose-600 hover:bg-rose-500 shadow-rose-600/30'} text-white text-xs font-black rounded-xl transition-all flex items-center justify-center gap-1.5 shadow-md active:scale-95">
                <span>⚡</span> Ejecutar ${s.type}
              </button>
              <!-- ✕ BOTÓN DESCARTAR SEÑAL -->
              <button class="btn-dismiss-signal py-2 px-2.5 bg-gray-800/80 hover:bg-rose-900/40 text-gray-400 hover:text-rose-300 text-xs font-bold rounded-xl transition-all border border-gray-700 active:scale-95" title="Descartar esta señal">
                ✕
              </button>
            </div>

            <!-- Footer: Precio y Distancia SL -->
            <div class="flex items-center justify-between pt-2 border-t border-gray-800 text-[11px] text-gray-400">
              <span>Precio ${formatPrice(s.currentPrice, s.symbol)}</span>
              <span class="font-semibold text-gray-300">Distancia SL: ${s.riskPercent.toFixed(2)}% (Pérdida: -$${pos.maxLossUSDT})</span>
            </div>
          `;

          const pills = card.querySelectorAll('.metric-pill-copy');
          pills.forEach(p => {
            p.addEventListener('click', () => {
              const val = p.getAttribute('data-copy');
              const label = p.getAttribute('data-label');
              copyText(val, label);
            });
          });

          const btnPlan = card.querySelector('.btn-copy-card-plan');
          btnPlan?.addEventListener('click', () => {
            const sym = btnPlan.getAttribute('data-symbol') || s.symbol;
            const typ = btnPlan.getAttribute('data-type') || s.type;
            const ent = btnPlan.getAttribute('data-entry') || formattedEntry;
            const stp = btnPlan.getAttribute('data-stop') || formattedStop;
            const tpp = btnPlan.getAttribute('data-tp') || formattedTP;
            const tp1Safe = btnPlan.getAttribute('data-tp1') || formattedCardTP1;
            const fullPlan = `⚡ SEÑAL FUTUROS: ${sym} (${typ})\nEntrada: ${ent}\nStop Loss: ${stp}\nTP1 (50% en 1:1.5): $${tp1Safe}\nTP Final (1:3): ${tpp}\nApalancamiento: ${pos.suggestedLeverage}\nTamaño Orden: ${qtyFormatted}`;
            copyText(fullPlan, `Plan de ${sym}`);
          });

          const btnExec = card.querySelector('.btn-execute-trade');
          btnExec?.addEventListener('click', () => {
            openTradeConfirmModal(s);
          });

          const btnDismiss = card.querySelector('.btn-dismiss-signal');
          btnDismiss?.addEventListener('click', () => {
            scanner.dismissSignal(s.id);
            if (window._cloudSync) {
              window._cloudSync.pushToCloud({
                trades: tradeTracker.trades,
                memory: tradeTracker.memory,
                syncPayload: scanner.getExecutedPayload(),
                userCapital,
                userRiskPct,
                filterMode: smcDetector.filterMode
              });
            }
            renderApp(scanner.getAllResults());
            showToast(`Señal ${s.symbol} descartada`, 'info');
          });

          signalsContainer.appendChild(card);
        });
      }
    }

    const tbody = document.getElementById('crypto-table-tbody');
    if (tbody) {
      tbody.innerHTML = '';

      results.forEach(item => {
        const tr = document.createElement('tr');
        tr.className = 'crypto-table-row text-xs cursor-pointer group hover:bg-bgCardHover/30 transition-colors border-b border-borderSubtle/30';
        const cleanPair = item.symbol.replace('/', '').toUpperCase();
        const binanceFuturesUrl = `https://www.binance.com/es/futures/${cleanPair}`;

        let trendClass = 'text-gray-400';
        if (item.trend === 'ALCISTA') trendClass = 'text-emerald-400';
        if (item.trend === 'BAJISTA') trendClass = 'text-rose-400';
        if (item.trend.includes('CUARENTENA')) trendClass = 'text-amber-400 font-bold';

        let signalBadge = `<span class="text-gray-600 font-mono">-</span>`;
        const userTrade = scanner.getUserOpenTrade(item.symbol);
        const binancePos = binancePositionsMap[cleanPair];
        const isTradeActive = Boolean(userTrade || binancePos);

        if (isTradeActive) {
          signalBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">✓ EN CURSO</span>`;
        } else if (item.signal && !scanner.isSignalExecutedOrDismissed(item.signal.id, item.symbol)) {
          const isLong = item.signal.type === 'LONG';
          signalBadge = `<span class="font-extrabold ${isLong ? 'text-amber-400' : 'text-amber-500'} font-mono">${item.signal.type}</span>`;
        }

        // Columna PnL (%ROI) — Solamente a los criptos en curso
        let pnlHtml = `<span class="text-gray-600 font-mono text-xs">-</span>`;

        if (isTradeActive) {
          const isLong = (binancePos ? binancePos.side : userTrade?.type) === 'LONG';
          const entryPrice = binancePos ? binancePos.entryPrice : Number(userTrade?.entry || 0);
          const currentPrice = Number(item.price || 0);
          const lev = binancePos ? binancePos.leverage : (Number(userTrade?.leverage) || 2);
          const amount = binancePos ? binancePos.amount : (Number(userTrade?.quantity) || 0);
          const margin = binancePos && binancePos.margin > 0 ? binancePos.margin : (entryPrice > 0 && amount > 0 ? (entryPrice * amount) / lev : 0);

          let pnl = 0;
          let roi = 0;

          if (entryPrice > 0 && currentPrice > 0) {
            const diff = isLong ? (currentPrice - entryPrice) : (entryPrice - currentPrice);
            if (amount > 0) {
              pnl = diff * amount;
            } else if (binancePos && typeof binancePos.unrealizedProfit === 'number') {
              pnl = binancePos.unrealizedProfit;
            }
            if (margin > 0) {
              roi = (pnl / margin) * 100;
            } else if (entryPrice > 0) {
              roi = (diff / entryPrice) * lev * 100;
            }
          } else if (binancePos) {
            pnl = binancePos.unrealizedProfit || 0;
            roi = binancePos.roi || 0;
          }

          const isPositive = pnl >= 0;
          const pnlSign = isPositive ? '+' : '';
          const roiSign = isPositive ? '+' : '';
          const colorClass = isPositive ? 'text-emerald-400' : 'text-rose-400';

          pnlHtml = `
            <div class="flex flex-col items-end leading-tight">
              <span class="font-mono text-xs font-bold ${colorClass}">${pnlSign}${pnl.toFixed(2)} USDT</span>
              <span class="font-mono text-[10px] font-semibold ${colorClass}">${roiSign}${roi.toFixed(2)}%</span>
            </div>
          `;
        }

        tr.innerHTML = `
          <td class="py-2.5 px-3 font-bold text-gray-200 group-hover:text-amber-400 transition-colors">
            <a href="${binanceFuturesUrl}" target="_blank" class="flex items-center gap-1.5">
              <span>${item.base}</span>
              <span class="text-[10px] text-gray-500 group-hover:text-amber-400 font-normal">↗</span>
            </a>
          </td>
          <td class="py-2.5 px-3 font-mono text-gray-300 text-xs">${formatPrice(item.price, item.symbol)}</td>
          <td class="py-2.5 px-3 text-[10px] font-bold ${trendClass}">4H ${item.trend}</td>
          <td class="py-2.5 px-3 text-right">${pnlHtml}</td>
          <td class="py-2.5 px-3 text-right font-bold">${signalBadge}</td>
        `;

        tbody.appendChild(tr);
      });
    }
  }

  function setupEvents() {
    // Escuchadores de Capital y Riesgo
    const inputCapital = document.getElementById('input-user-capital');
    const inputRisk = document.getElementById('input-user-risk-pct');

    if (inputCapital) {
      inputCapital.value = userCapital;
      inputCapital.addEventListener('input', (e) => {
        userCapital = Math.max(10, parseFloat(e.target.value) || 100);
        localStorage.setItem('user_trading_capital', userCapital);
        updateCapitalKPIs();
        renderApp(scanner.getAllResults());
      });
    }

    if (inputRisk) {
      inputRisk.value = userRiskPct;
      inputRisk.addEventListener('input', (e) => {
        userRiskPct = Math.max(0.1, Math.min(10, parseFloat(e.target.value) || 1.0));
        localStorage.setItem('user_trading_risk_pct', userRiskPct);
        updateCapitalKPIs();
        renderApp(scanner.getAllResults());
      });
    }

    updateCapitalKPIs();

    const refreshBtn = document.getElementById('btn-refresh');
    refreshBtn?.addEventListener('click', async () => {
      refreshBtn.classList.add('opacity-70', 'pointer-events-none');
      await scanner.scanAll();
      showToast('Datos actualizados de Binance Futuros', 'info');
      refreshBtn.classList.remove('opacity-70', 'pointer-events-none');
    });

    const powerBtn = document.getElementById('btn-power-toggle');
    const statusText = document.getElementById('scanner-status-text');
    powerBtn?.addEventListener('click', () => {
      const isEnabled = scanner.toggle();
      if (isEnabled) {
        powerBtn.className = 'w-10 h-10 rounded-xl power-btn-active flex items-center justify-center font-bold text-lg transition-all active:scale-95';
        statusText.innerHTML = '<span>Escáner encendido</span>';
        showToast('Escáner activado', 'success');
      } else {
        powerBtn.className = 'w-10 h-10 rounded-xl power-btn-inactive flex items-center justify-center font-bold text-lg transition-all active:scale-95';
        statusText.innerHTML = '<span class="text-rose-400">Escáner pausado</span>';
        showToast('Escáner pausado', 'danger');
      }
    });

    const filterBtn = document.getElementById('btn-toggle-filters');
    const filterText = document.getElementById('kpi-filter-mode');
    filterBtn?.addEventListener('click', () => {
      const current = smcDetector.filterMode;
      const next = current === 'estricto' ? 'suave' : 'estricto';
      smcDetector.setFilterMode(next);
      if (filterText) filterText.textContent = next;
      showToast(`Filtros cambiados a modo: ${next}`, 'info');
      scanner.scanAll();
    });

    // ─── Modal de Configuración de API Keys (Binance Futuros) ───
    const apiModal = document.getElementById('modal-api-settings');
    const btnOpenAPI = document.getElementById('btn-open-api');
    const btnCloseAPI = document.getElementById('btn-close-api');
    const btnSaveAPI = document.getElementById('btn-save-api');
    const inputDemoKey = document.getElementById('input-api-demo-key');
    const inputDemoSecret = document.getElementById('input-api-demo-secret');
    const inputRealKey = document.getElementById('input-api-real-key');
    const inputRealSecret = document.getElementById('input-api-real-secret');
    const btnModeToggle = document.getElementById('btn-mode-toggle');
    const modeIcon = document.getElementById('mode-icon');
    const modeLabel = document.getElementById('mode-label');
    const btnModalDemo = document.getElementById('btn-api-modal-mode-demo');
    const btnModalReal = document.getElementById('btn-api-modal-mode-real');
    const boxDemo = document.getElementById('box-demo-keys');
    const boxReal = document.getElementById('box-real-keys');

    function updateModeUI() {
      const isDemo = binanceTrade.isDemo();
      if (btnModeToggle) {
        btnModeToggle.className = `flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black border transition-all active:scale-95 cursor-pointer select-none ${
          isDemo ? 'bg-yellow-500/15 border-yellow-500/40 text-yellow-300 shadow-sm shadow-yellow-500/10' : 'bg-rose-600/20 border-rose-500/40 text-rose-300 shadow-sm shadow-rose-500/10'
        }`;
      }
      if (modeIcon) modeIcon.textContent = isDemo ? '🟡' : '🔴';
      if (modeLabel) modeLabel.textContent = isDemo ? 'DEMO' : 'REAL';

      if (btnModalDemo) {
        btnModalDemo.className = `flex-1 py-2 rounded-lg text-xs font-black transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
          isDemo ? 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/50 shadow-sm' : 'text-gray-400 hover:text-white border border-transparent'
        }`;
      }
      if (btnModalReal) {
        btnModalReal.className = `flex-1 py-2 rounded-lg text-xs font-black transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
          !isDemo ? 'bg-rose-600/25 text-rose-300 border border-rose-500/50 shadow-sm' : 'text-gray-400 hover:text-white border border-transparent'
        }`;
      }

      if (boxDemo) {
        boxDemo.className = `space-y-2 p-3 rounded-xl transition-all ${
          isDemo ? 'bg-yellow-500/10 border-2 border-yellow-500/50 shadow-md' : 'bg-yellow-500/5 border border-yellow-500/20 opacity-60'
        }`;
      }
      if (boxReal) {
        boxReal.className = `space-y-2 p-3 rounded-xl transition-all ${
          !isDemo ? 'bg-rose-500/10 border-2 border-rose-500/50 shadow-md' : 'bg-rose-500/5 border border-rose-500/20 opacity-60'
        }`;
      }
    }

    updateModeUI();

    function setAppMode(targetMode) {
      binanceTrade.saveConfig({ mode: targetMode });
      updateModeUI();
      showToast(targetMode === 'real' ? '🔴 Modo REAL activado' : '🟡 Modo DEMO activado', 'info');
    }

    btnModeToggle?.addEventListener('click', (e) => {
      e.preventDefault();
      const current = binanceTrade.isDemo();
      setAppMode(current ? 'real' : 'demo');
    });

    btnModalDemo?.addEventListener('click', (e) => {
      e.preventDefault();
      setAppMode('demo');
    });

    btnModalReal?.addEventListener('click', (e) => {
      e.preventDefault();
      setAppMode('real');
    });

    btnOpenAPI?.addEventListener('click', () => {
      const cfg = binanceTrade.loadConfig();
      if (inputDemoKey) inputDemoKey.value = cfg.demoKey || '';
      if (inputDemoSecret) inputDemoSecret.value = cfg.demoSecret || '';
      if (inputRealKey) inputRealKey.value = cfg.realKey || '';
      if (inputRealSecret) inputRealSecret.value = cfg.realSecret || '';
      const vercelInput = document.getElementById('input-vercel-url');
      if (vercelInput) vercelInput.value = localStorage.getItem('vercel_proxy_url') || '';
      updateModeUI();
      apiModal?.classList.remove('hidden');
    });

    btnCloseAPI?.addEventListener('click', () => {
      apiModal?.classList.add('hidden');
    });

    apiModal?.addEventListener('click', (e) => {
      if (e.target === apiModal) apiModal.classList.add('hidden');
    });

    btnSaveAPI?.addEventListener('click', () => {
      binanceTrade.saveConfig({
        demoKey: inputDemoKey ? inputDemoKey.value.trim() : '',
        demoSecret: inputDemoSecret ? inputDemoSecret.value.trim() : '',
        realKey: inputRealKey ? inputRealKey.value.trim() : '',
        realSecret: inputRealSecret ? inputRealSecret.value.trim() : ''
      });
      // Guardar URL de Vercel proxy
      const vercelInput = document.getElementById('input-vercel-url');
      if (vercelInput) {
        const vercelUrl = vercelInput.value.trim().replace(/\/$/, ''); // quitar trailing slash
        if (vercelUrl) {
          localStorage.setItem('vercel_proxy_url', vercelUrl);
          console.log('[Config] Vercel proxy URL guardada:', vercelUrl);
        } else {
          localStorage.removeItem('vercel_proxy_url');
        }
      }
      apiModal?.classList.add('hidden');
      updateModeUI();
      showToast('🔐 Claves API de Binance guardadas con éxito', 'success');
    });

    // ─── Transferencia Instantánea de Claves por Código QR (PC ↔ Móvil) ───
    const modalQRExport = document.getElementById('modal-qr-export');
    const modalQRScan = document.getElementById('modal-qr-scan');
    const btnOpenQRExport = document.getElementById('btn-open-qr-export');
    const btnOpenQRScan = document.getElementById('btn-open-qr-scan');
    const btnCloseQRExport = document.getElementById('btn-close-qr-export');
    const btnDoneQRExport = document.getElementById('btn-done-qr-export');
    const btnCloseQRScan = document.getElementById('btn-close-qr-scan');
    const btnCancelQRScan = document.getElementById('btn-cancel-qr-scan');
    const qrExportTarget = document.getElementById('qr-export-target');

    let html5QrScannerInstance = null;

    btnOpenQRExport?.addEventListener('click', () => {
      const savedCfg = binanceTrade.loadConfig();
      const cfg = {
        demoKey: (inputDemoKey && inputDemoKey.value.trim()) || savedCfg.demoKey || '',
        demoSecret: (inputDemoSecret && inputDemoSecret.value.trim()) || savedCfg.demoSecret || '',
        realKey: (inputRealKey && inputRealKey.value.trim()) || savedCfg.realKey || '',
        realSecret: (inputRealSecret && inputRealSecret.value.trim()) || savedCfg.realSecret || '',
        mode: binanceTrade.isDemo() ? 'demo' : 'real'
      };

      if (!cfg.demoKey && !cfg.realKey) {
        showToast('Guarda o escribe tus claves API antes de exportar', 'danger');
        return;
      }

      if (qrExportTarget) {
        qrExportTarget.innerHTML = '';
        try {
          const payload = 'SMC_KEYS:' + JSON.stringify(cfg);
          new QRCode(qrExportTarget, {
            text: payload,
            width: 210,
            height: 210,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
          });
        } catch (qrErr) {
          showToast('Error generando QR: ' + qrErr.message, 'danger');
          return;
        }
      }

      modalQRExport?.classList.remove('hidden');
    });

    btnCloseQRExport?.addEventListener('click', () => {
      modalQRExport?.classList.add('hidden');
    });
    btnDoneQRExport?.addEventListener('click', () => {
      modalQRExport?.classList.add('hidden');
    });

    async function stopQRScanner() {
      if (html5QrScannerInstance) {
        try {
          await html5QrScannerInstance.stop();
        } catch (e) {}
        html5QrScannerInstance = null;
      }
      modalQRScan?.classList.add('hidden');
    }

    btnCloseQRScan?.addEventListener('click', stopQRScanner);
    btnCancelQRScan?.addEventListener('click', stopQRScanner);

    btnOpenQRScan?.addEventListener('click', async () => {
      if (typeof Html5Qrcode === 'undefined') {
        showToast('Cargando librería de escáner... Intenta de nuevo en 2s', 'info');
        return;
      }

      modalQRScan?.classList.remove('hidden');

      try {
        if (html5QrScannerInstance) {
          try { await html5QrScannerInstance.stop(); } catch (e) {}
        }

        html5QrScannerInstance = new Html5Qrcode('qr-reader');
        const cameras = await Html5Qrcode.getCameras();

        if (!cameras || cameras.length === 0) {
          showToast('No se detectó cámara en este dispositivo', 'danger');
          stopQRScanner();
          return;
        }

        // Seleccionar cámara trasera en móviles preferentemente
        const cameraId = cameras.length > 1 ? cameras[cameras.length - 1].id : cameras[0].id;

        // Configuración de escáner perfectamente cuadrado (1:1)
        const config = {
          fps: 15,
          qrbox: { width: 220, height: 220 },
          aspectRatio: 1.0,
          showTorchButtonIfSupported: true
        };

        await html5QrScannerInstance.start(
          cameraId,
          config,
          (decodedText) => {
            if (decodedText && decodedText.startsWith('SMC_KEYS:')) {
              try {
                const jsonStr = decodedText.replace('SMC_KEYS:', '');
                const keysData = JSON.parse(jsonStr);

                binanceTrade.saveConfig({
                  demoKey: keysData.demoKey || '',
                  demoSecret: keysData.demoSecret || '',
                  realKey: keysData.realKey || '',
                  realSecret: keysData.realSecret || '',
                  mode: keysData.mode || 'demo'
                });

                if (inputDemoKey) inputDemoKey.value = keysData.demoKey || '';
                if (inputDemoSecret) inputDemoSecret.value = keysData.demoSecret || '';
                if (inputRealKey) inputRealKey.value = keysData.realKey || '';
                if (inputRealSecret) inputRealSecret.value = keysData.realSecret || '';

                updateModeUI();
                stopQRScanner();
                showToast('🎉 ¡Claves API importadas exitosamente desde el QR!', 'success');
              } catch (parseErr) {
                showToast('Formato QR no válido', 'danger');
              }
            }
          },
          (errorMessage) => {
            // Ignorar errores por frame sin QR
          }
        );
      } catch (camErr) {
        showToast('Error al acceder a la cámara: ' + camErr.message, 'danger');
        stopQRScanner();
      }
    });

    const discordModal = document.getElementById('discord-modal');
    const btnOpenDiscord = document.getElementById('btn-open-discord');
    const btnCloseDiscord = document.getElementById('btn-close-discord');
    const inputWebhook = document.getElementById('input-discord-webhook');
    const btnSaveDiscord = document.getElementById('btn-save-discord');
    const btnTestDiscord = document.getElementById('btn-test-discord');

    btnOpenDiscord?.addEventListener('click', () => {
      if (inputWebhook) inputWebhook.value = discordWebhookUrl;
      discordModal?.classList.remove('hidden');
    });

    btnCloseDiscord?.addEventListener('click', () => {
      discordModal?.classList.add('hidden');
    });

    btnSaveDiscord?.addEventListener('click', () => {
      discordWebhookUrl = inputWebhook.value.trim();
      localStorage.setItem('discord_webhook_url', discordWebhookUrl);
      updateDiscordBadge();
      discordModal?.classList.add('hidden');
      showToast('Webhook de Discord guardado con éxito', 'success');
    });

    btnTestDiscord?.addEventListener('click', async () => {
      const url = inputWebhook.value.trim();
      if (!url || !url.startsWith('http')) {
        showToast('Pega primero una URL válida de Discord Webhook', 'danger');
        return;
      }

      btnTestDiscord.textContent = 'Enviando...';
      const tempUrl = discordWebhookUrl;
      discordWebhookUrl = url;

      const testSignal = {
        symbol: 'ETH/USDT',
        type: 'LONG',
        entry: 1913.86,
        stop: 1901.40,
        takeProfit: 1951.24,
        tp1: 1932.55,
        riskPercent: 0.65,
        tags: [
          '✓ Major BOS Confirmado',
          '✓ Desplazamiento + FVG',
          '✓ HTF 4h en alcista',
          '✓ Descuento 50%',
          '🟢 Killzone New York (Máxima Liquidez)',
          '✓ Sincronizado con BTC'
        ]
      };

      const ok = await sendDiscordSignal(testSignal);
      discordWebhookUrl = tempUrl;
      btnTestDiscord.innerHTML = '<span>🔔</span> Probar Alerta';

      if (ok) {
        showToast('¡Alerta de prueba enviada a tu Discord!', 'success');
      } else {
        showToast('Error al enviar al Webhook. Verifica la URL.', 'danger');
      }
    });

    // ─── Modal de Sincronización en la Nube (PC ↔ Móvil) ───
    const syncModal = document.getElementById('modal-sync');
    const btnOpenSync = document.getElementById('btn-open-sync');
    const btnCloseSync = document.getElementById('btn-close-sync');
    const inputSyncCode = document.getElementById('input-sync-code');
    const btnCopySyncCode = document.getElementById('btn-copy-sync-code');
    const btnSaveSync = document.getElementById('btn-save-sync');

    btnOpenSync?.addEventListener('click', () => {
      if (inputSyncCode) inputSyncCode.value = cloudSync.getRoomId();
      syncModal?.classList.remove('hidden');
    });

    btnCloseSync?.addEventListener('click', () => {
      syncModal?.classList.add('hidden');
    });

    syncModal?.addEventListener('click', (e) => {
      if (e.target === syncModal) syncModal.classList.add('hidden');
    });

    btnCopySyncCode?.addEventListener('click', () => {
      if (inputSyncCode && inputSyncCode.value) {
        copyText(inputSyncCode.value, 'Código de Sincronización');
      }
    });

    btnSaveSync?.addEventListener('click', async () => {
      const code = inputSyncCode?.value.trim().toUpperCase();
      if (!code || code.length < 3) {
        showToast('Introduce un código de sincronización válido', 'danger');
        return;
      }
      btnSaveSync.textContent = 'Conectando...';
      btnSaveSync.disabled = true;

      cloudSync.setRoomId(code);
      showToast(`☁️ Conectando a sala: ${code}...`, 'info');

      const remote = await cloudSync.pullFromCloud();
      if (remote) {
        tradeTracker.mergeCloudData(remote);
        renderApp(scanner.getAllResults());
        showToast('✅ ¡Win Rate e Historial sincronizados con éxito!', 'success');
      } else {
        await cloudSync.pushToCloud({
          trades: tradeTracker.trades,
          memory: tradeTracker.memory,
          userCapital,
          userRiskPct,
          filterMode: smcDetector.filterMode
        });
        showToast(`✅ Sala "${code}" creada. Pon este código en tu otro dispositivo.`, 'success');
      }

      btnSaveSync.textContent = '🔄 Conectar y Sincronizar Ahora';
      btnSaveSync.disabled = false;
      syncModal?.classList.add('hidden');
    });

    // ─── Modal de Alerta TP1 / Decisión Breakeven ───
    const beModal = document.getElementById('modal-tp1-be');
    const btnCloseBE = document.getElementById('btn-close-be-modal');
    const btnDismissBE = document.getElementById('btn-dismiss-be');
    const btnApplyBE = document.getElementById('btn-apply-be');
    const checkAutoBE = document.getElementById('check-auto-breakeven');

    if (checkAutoBE) {
      checkAutoBE.checked = localStorage.getItem('smc_auto_breakeven') !== 'false';
      checkAutoBE.addEventListener('change', (e) => {
        localStorage.setItem('smc_auto_breakeven', e.target.checked);
        showToast(e.target.checked ? '🛡️ Breakeven Automático activado' : '🔔 Preguntarme antes de mover a Breakeven', 'info');
      });
    }

    btnCloseBE?.addEventListener('click', () => {
      beModal?.classList.add('hidden');
    });

    btnDismissBE?.addEventListener('click', () => {
      beModal?.classList.add('hidden');
      showToast('Trade sigue corriendo sin modificar Stop Loss', 'info');
    });

    beModal?.addEventListener('click', (e) => {
      if (e.target === beModal) beModal.classList.add('hidden');
    });

    btnApplyBE?.addEventListener('click', async () => {
      if (!pendingBEEvent) {
        beModal?.classList.add('hidden');
        return;
      }
      btnApplyBE.textContent = 'Moviendo SL...';
      btnApplyBE.disabled = true;

      if (binanceTrade && binanceTrade.isConfigured()) {
        try {
          const res = await binanceTrade.moveToBreakeven(pendingBEEvent.symbol, pendingBEEvent.entry, pendingBEEvent.type);
          if (res) {
            showToast(`🛡️ Stop Loss movido a Breakeven ($${formatPrice(pendingBEEvent.entry, pendingBEEvent.symbol)}) en Binance`, 'success');
          } else {
            showToast('⚠️ No se pudo mover en Binance automáticamente. Modifícalo en Binance.', 'danger');
          }
        } catch (e) {
          showToast(`❌ Error: ${e.message}`, 'danger');
        }
      } else {
        showToast(`🛡️ Stop Loss fijado a Breakeven ($${formatPrice(pendingBEEvent.entry, pendingBEEvent.symbol)})`, 'success');
      }

      btnApplyBE.innerHTML = '<span>✅</span> SL Movido a Breakeven';
      setTimeout(() => {
        beModal?.classList.add('hidden');
        btnApplyBE.disabled = false;
        btnApplyBE.innerHTML = '<span>🛡️</span> Mover SL a Breakeven en Binance';
      }, 1000);
    });
  }

  try { updateDiscordBadge(); } catch (e) { console.warn('[App] updateDiscordBadge:', e); }
  try { setupEvents(); } catch (e) { console.warn('[App] setupEvents:', e); }
  try { renderApp(scanner.getAllResults()); } catch (e) { console.warn('[App] initial renderApp:', e); }
  try { scanner.start(); } catch (e) { console.warn('[App] scanner.start:', e); }

  // ─────────────────────────────────────────────────────────────────────
  // PAGE VISIBILITY API: Detecta cuando la app vuelve al primer plano
  // y reinicia el escáner de inmediato mostrando cuánto tiempo estuvo pausada
  // ─────────────────────────────────────────────────────────────────────
  let pausedAt = null;
  const pauseBanner = document.getElementById('pause-banner');
  const pauseElapsed = document.getElementById('pause-elapsed');

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // La app pasó a segundo plano
      pausedAt = Date.now();
      if (pauseBanner) pauseBanner.classList.remove('hidden');
    } else {
      // La app volvió al primer plano
      const elapsed = pausedAt ? Math.round((Date.now() - pausedAt) / 1000) : 0;
      pausedAt = null;
      if (pauseBanner) pauseBanner.classList.add('hidden');

      if (elapsed > 5) {
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const label = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        showToast(`App reanudada (+${label} pausada) — Actualizando datos...`, 'info');
      }

      // Reinicio inmediato del escáner al volver
      if (scanner.isEnabled) {
        scanner.scanAll();
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // WAKE LOCK & ANTI-SUSPENSIÓN: Pantalla siempre encendida en Móvil y PC
  // ─────────────────────────────────────────────────────────────────────
  let wakeLock = null;
  let isWakeLockRequested = true;
  const btnWakeLock = document.getElementById('btn-toggle-wakelock');
  const wakeLockIcon = document.getElementById('wakelock-icon');
  const wakeLockLabel = document.getElementById('wakelock-label');

  function updateWakeLockUI(isActive) {
    if (!btnWakeLock) return;
    if (isActive) {
      btnWakeLock.className = 'flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-bold border transition-all active:scale-95 bg-yellow-500/20 border-yellow-500/50 text-yellow-300 shadow-sm shadow-yellow-500/20';
      if (wakeLockIcon) wakeLockIcon.textContent = '💡';
      if (wakeLockLabel) wakeLockLabel.textContent = 'Pantalla ON';
    } else {
      btnWakeLock.className = 'flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-bold border transition-all active:scale-95 bg-gray-800 border-gray-700 text-gray-400';
      if (wakeLockIcon) wakeLockIcon.textContent = '💤';
      if (wakeLockLabel) wakeLockLabel.textContent = 'Pantalla Auto';
    }
  }

  // Fallback para navegadores que bloquean WakeLock (ej. iOS Safari): reproducción de audio inaudible
  let dummyAudio = null;
  function ensureAudioKeepAwake() {
    if (!dummyAudio) {
      try {
        dummyAudio = document.createElement('audio');
        dummyAudio.setAttribute('loop', '');
        dummyAudio.setAttribute('playsinline', '');
        // WAV inaudible de 1 muestra en silencio (base64)
        dummyAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
      } catch (e) {}
    }
    if (dummyAudio && dummyAudio.paused) {
      dummyAudio.play().catch(() => {});
    }
  }

  async function requestWakeLock() {
    if (!isWakeLockRequested) return;
    if ('wakeLock' in navigator) {
      try {
        if (wakeLock) {
          try { await wakeLock.release(); } catch (e) {}
          wakeLock = null;
        }
        wakeLock = await navigator.wakeLock.request('screen');
        updateWakeLockUI(true);
        console.log('[WakeLock] Pantalla bloqueada activa.');
        wakeLock.addEventListener('release', () => {
          console.log('[WakeLock] Pantalla liberada.');
          if (isWakeLockRequested && !document.hidden) {
            updateWakeLockUI(false);
            setTimeout(requestWakeLock, 1000);
          } else {
            updateWakeLockUI(false);
          }
        });
      } catch (err) {
        console.warn('[WakeLock API Error]:', err.message);
        ensureAudioKeepAwake();
        updateWakeLockUI(true);
      }
    } else {
      ensureAudioKeepAwake();
      updateWakeLockUI(true);
    }
  }

  // Re-solicitar WakeLock cada vez que la app vuelve al primer plano
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden && isWakeLockRequested) {
      await requestWakeLock();
    }
  });

  // Cualquier toque en la pantalla activa el permiso de pantalla encendida si estaba pendiente
  const activateWakeLockOnTouch = () => {
    if (isWakeLockRequested && !wakeLock) {
      requestWakeLock();
    }
    ensureAudioKeepAwake();
  };
  window.addEventListener('click', activateWakeLockOnTouch, { passive: true });
  window.addEventListener('touchstart', activateWakeLockOnTouch, { passive: true });

  btnWakeLock?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isWakeLockRequested) {
      isWakeLockRequested = false;
      if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
      }
      if (dummyAudio) {
        dummyAudio.pause();
      }
      updateWakeLockUI(false);
      showToast('💤 Modo reposo automático permitido', 'info');
    } else {
      isWakeLockRequested = true;
      requestWakeLock();
      updateWakeLockUI(true);
      showToast('💡 Pantalla siempre encendida activada', 'success');
    }
  });

  requestWakeLock();

  // ─────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────
  // MODAL DE CONFIRMACIÓN DE TRADE
  // ─────────────────────────────────────────────────────────────────────
  // MODAL DE CONFIRMACIÓN DE TRADE
  // ─────────────────────────────────────────────────────────────────────
  function openTradeConfirmModal(signal) {
    if (!binanceTrade.isConfigured()) {
      const isDemo = binanceTrade.isDemo();
      showToast(`🔑 Configura tus claves de Binance (${isDemo ? 'DEMO' : 'REAL'}) en la ventana que se abrió`, 'danger');
      const cfg = binanceTrade.loadConfig();
      const inputDemoKey = document.getElementById('input-api-demo-key');
      const inputDemoSecret = document.getElementById('input-api-demo-secret');
      const inputRealKey = document.getElementById('input-api-real-key');
      const inputRealSecret = document.getElementById('input-api-real-secret');
      if (inputDemoKey) inputDemoKey.value = cfg.demoKey || '';
      if (inputDemoSecret) inputDemoSecret.value = cfg.demoSecret || '';
      if (inputRealKey) inputRealKey.value = cfg.realKey || '';
      if (inputRealSecret) inputRealSecret.value = cfg.realSecret || '';
      document.getElementById('modal-api-settings')?.classList.remove('hidden');
      return;
    }

    pendingTradeSignal = { ...signal };
    const pos = calculatePosition(signal.entry, signal.riskPercent);

    document.getElementById('confirm-trade-title').textContent = `Ejecutar ${signal.type} en ${signal.symbol}`;
    document.getElementById('ct-symbol').textContent = signal.symbol;
    document.getElementById('ct-type').textContent   = signal.type;
    document.getElementById('ct-type').className     = `font-bold ${signal.type === 'LONG' ? 'text-emerald-400' : 'text-rose-400'}`;
    document.getElementById('ct-entry').textContent  = formatPrice(signal.entry, signal.symbol);
    document.getElementById('ct-sl').textContent     = formatPrice(signal.stop, signal.symbol);
    document.getElementById('ct-tp').textContent     = formatPrice(signal.takeProfit, signal.symbol);
    document.getElementById('ct-qty').textContent    = `${formatPrice(pos.quantity, signal.symbol)} ${signal.symbol.replace('USDT','')} (~$${pos.totalPositionUSDT})`;
    document.getElementById('ct-lev').textContent    = pos.suggestedLeverage;

    updateConfirmModalUI();
    document.getElementById('modal-confirm-trade')?.classList.remove('hidden');
  }

  function updateConfirmModalUI() {
    const isDemo = binanceTrade.isDemo();
    const modeLabel = document.getElementById('confirm-trade-mode-label');
    if (modeLabel) {
      modeLabel.textContent = isDemo ? 'Modo: 🟡 DEMO (Testnet)' : 'Modo: 🔴 REAL (Dinero Real)';
      modeLabel.className = `text-[11px] font-black ${isDemo ? 'text-yellow-400' : 'text-rose-400'}`;
    }

    const btnCtDemo = document.getElementById('btn-ct-mode-demo');
    const btnCtReal = document.getElementById('btn-ct-mode-real');
    if (btnCtDemo) {
      btnCtDemo.className = `flex-1 py-1.5 rounded-lg text-xs font-black transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
        isDemo ? 'bg-yellow-500/25 text-yellow-300 border border-yellow-500/50 shadow-sm' : 'text-gray-400 hover:text-white border border-transparent'
      }`;
    }
    if (btnCtReal) {
      btnCtReal.className = `flex-1 py-1.5 rounded-lg text-xs font-black transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
        !isDemo ? 'bg-rose-600/25 text-rose-300 border border-rose-500/50 shadow-sm' : 'text-gray-400 hover:text-white border border-transparent'
      }`;
    }

    const warning = document.getElementById('ct-real-warning');
    if (warning) {
      if (isDemo) warning.classList.add('hidden');
      else        warning.classList.remove('hidden');
    }

    const confirmBtn = document.getElementById('btn-confirm-trade');
    if (confirmBtn) {
      confirmBtn.className = `flex-1 py-2.5 rounded-xl text-xs font-black transition-all active:scale-95 flex items-center justify-center gap-2 shadow-lg ${
        isDemo ? 'bg-yellow-500 hover:bg-yellow-400 text-black shadow-yellow-500/20' : 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/30'
      }`;
    }
    const label = document.getElementById('confirm-btn-label');
    if (label) label.textContent = isDemo ? '⚡ Ejecutar en DEMO' : '⚠️ Ejecutar con DINERO REAL';
  }

  document.getElementById('btn-ct-mode-demo')?.addEventListener('click', (e) => {
    e.preventDefault();
    binanceTrade.saveConfig({ mode: 'demo' });
    updateConfirmModalUI();
    const btnModeToggle = document.getElementById('btn-mode-toggle');
    const modeIcon = document.getElementById('mode-icon');
    const modeLabel = document.getElementById('mode-label');
    if (btnModeToggle) btnModeToggle.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black border transition-all active:scale-95 cursor-pointer select-none bg-yellow-500/15 border-yellow-500/40 text-yellow-300 shadow-sm shadow-yellow-500/10';
    if (modeIcon) modeIcon.textContent = '🟡';
    if (modeLabel) modeLabel.textContent = 'DEMO';
    showToast('🟡 Modo DEMO activado para esta orden', 'info');
  });

  document.getElementById('btn-ct-mode-real')?.addEventListener('click', (e) => {
    e.preventDefault();
    binanceTrade.saveConfig({ mode: 'real' });
    updateConfirmModalUI();
    const btnModeToggle = document.getElementById('btn-mode-toggle');
    const modeIcon = document.getElementById('mode-icon');
    const modeLabel = document.getElementById('mode-label');
    if (btnModeToggle) btnModeToggle.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black border transition-all active:scale-95 cursor-pointer select-none bg-rose-600/20 border-rose-500/40 text-rose-300 shadow-sm shadow-rose-500/10';
    if (modeIcon) modeIcon.textContent = '🔴';
    if (modeLabel) modeLabel.textContent = 'REAL';
    showToast('🔴 Modo REAL activado para esta orden', 'info');
  });

  document.getElementById('btn-close-confirm')?.addEventListener('click', () => {
    document.getElementById('modal-confirm-trade')?.classList.add('hidden');
    pendingTradeSignal = null;
  });

  document.getElementById('btn-cancel-trade')?.addEventListener('click', () => {
    document.getElementById('modal-confirm-trade')?.classList.add('hidden');
    pendingTradeSignal = null;
  });

  document.getElementById('btn-confirm-trade')?.addEventListener('click', async () => {
    if (!pendingTradeSignal) return;

    const targetSignal = { ...pendingTradeSignal };
    const confirmBtn = document.getElementById('btn-confirm-trade');
    const label      = document.getElementById('confirm-btn-label');
    if (confirmBtn) confirmBtn.disabled = true;
    if (label)      label.textContent   = 'Enviando orden...';

    try {
      const pos = calculatePosition(targetSignal.entry, targetSignal.riskPercent);
      const leverage = parseInt(pos.suggestedLeverage.replace('x', '')) || 10;

      showToast('⚡ Enviando orden a Binance Futuros...', 'info');

      const result = await binanceTrade.executeTrade(targetSignal, { 
        leverage, 
        quantity: pos.quantity 
      });

      document.getElementById('modal-confirm-trade')?.classList.add('hidden');

      // Toast principal: estado de la orden de entrada
      const allOk = result.slOrderId && result.tpOrderId;
      showToast(
        `✅ Orden ${result.symbol} ${result.type} (${result.quantity} contratos) | ` +
        (result.slOrderId ? `SL ✓` : `⚠️ SL FALLIDO`) + ` | ` +
        (result.tpOrderId ? `TP ✓` : `⚠️ TP FALLIDO`),
        allOk ? 'success' : 'info'
      );

      // Toasts separados para errores SL/TP — visibles en móvil
      if (!result.slOrderId) {
        const slMsg = result.slErrorMsg || 'No se pudo colocar SL (sin mensaje)';
        setTimeout(() => showToast(`🛑 SL NO COLOCADO: ${slMsg}`, 'danger'), 1200);
      }
      if (!result.tpOrderId) {
        const tpMsg = result.tpErrorMsg || 'No se pudo colocar TP (sin mensaje)';
        setTimeout(() => showToast(`🎯 TP NO COLOCADO: ${tpMsg}`, 'danger'), 2400);
      }

      playChime(targetSignal.type);

      // 1. Registrar trade en el tracker para seguimiento de auditoría en vivo
      tradeTracker.registerSignal(targetSignal);

      // 2. Registrar orden REAL del usuario para marcar ✓ EN CURSO únicamente en este activo
      scanner.addUserExecutedTrade(targetSignal, {
        quantity: result.quantity || pos.quantity,
        leverage: result.leverage || leverage
      });
      setTimeout(syncBinancePositions, 1000);

      if (window._cloudSync) {
        window._cloudSync.pushToCloud({
          trades: tradeTracker.trades,
          memory: tradeTracker.memory,
          syncPayload: scanner.getExecutedPayload(),
          userCapital,
          userRiskPct,
          filterMode: smcDetector.filterMode
        });
      }
      renderApp(scanner.getAllResults());

      pendingTradeSignal = null;
    } catch (err) {
      showToast(`❌ Error: ${err.message}`, 'danger');
      console.error('[Trade]', err);
    } finally {
      if (confirmBtn) confirmBtn.disabled = false;
      if (label)      label.textContent   = document.getElementById('confirm-btn-label')?.textContent.includes('REAL') ? '⚠️ Ejecutar REAL' : 'Ejecutar en DEMO';
    }
  });

  document.getElementById('btn-reset-tracker')?.addEventListener('click', () => {
    if (confirm('¿Deseas reiniciar el contador numérico de trades a cero? (El aprendizaje adaptativo y protecciones de mercado se conservarán al 100%)')) {
      tradeTracker.trades = [];
      tradeTracker.saveTrades();
      // NOTA: tradeTracker.memory se preserva intacto para no perder la inteligencia aprendida
      scanner.userExecutedTrades = [];
      scanner.dismissedSignals = new Set();
      scanner.saveUserExecutedTrades();
      localStorage.removeItem('smc_dismissed_signals');
      localStorage.removeItem('smc_executed_signals');
      if (window._cloudSync) {
        window._cloudSync.pushToCloud({
          trades: [],
          memory: tradeTracker.memory,
          syncPayload: { userTrades: [], dismissed: [] },
          userCapital,
          userRiskPct,
          filterMode: smcDetector.filterMode
        });
      }
      showToast('🔢 Contador numérico reiniciado a 0 (Aprendizaje adaptativo conservado)', 'success');
      renderApp(scanner.getAllResults());
    }
  });

  // Exponer función para que los botones de las tarjetas la llamen
  window.openTradeConfirmModal = openTradeConfirmModal;

});


