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
