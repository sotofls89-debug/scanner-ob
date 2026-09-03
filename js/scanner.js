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

  addUserExecutedTrade(signal) {
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
