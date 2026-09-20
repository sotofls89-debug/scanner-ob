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

  recordLearningOutcome(trade, isWin, isStopHunt = false, extra = {}) {
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
        quarantineUntil: 0,
        lessons: []
      };
    }

    const mem = this.memory[symbol];
    mem.totalTrades++;

    let lesson = '';
    const rMult = trade.rMultiple !== undefined ? trade.rMultiple : (isWin ? 3.0 : -1.0);

    if (isWin) {
      mem.wins++;
      mem.consecutiveLosses = 0;
      // Reducir gradualmente buffers si el mercado responde favorablemente
      if (mem.atrBufferBonus > 0) mem.atrBufferBonus = Math.max(0, mem.atrBufferBonus - 0.05);
      if (mem.extraVolumeRequired > 0) mem.extraVolumeRequired = Math.max(0, mem.extraVolumeRequired - 0.05);

      lesson = `✅ Trade ganador (+${rMult}R). Estructura SMC validada con éxito. Confianza del activo reforzada.`;
    } else {
      mem.losses++;
      mem.consecutiveLosses++;

      if (isStopHunt) {
        mem.stopHuntCount++;
        // Si fue cacería de liquidez (mecha), aumentar buffer de holgura para el SL
        mem.atrBufferBonus = Math.min(0.50, (mem.atrBufferBonus || 0) + 0.15);
        lesson = `⚠️ Cacería de liquidez detectada (Stop Hunt). Buffer de SL aumentado (+15% ATR) para filtrar mechazos en ${symbol}.`;
      } else {
        lesson = `🛑 Stop Loss alcanzado (${rMult}R). Pérdida controlada por gestión de riesgo.`;
      }

      if (mem.consecutiveLosses >= 2) {
        // Exigir mayor volumen institucional para validar próximas entradas
        mem.extraVolumeRequired = Math.min(0.40, (mem.extraVolumeRequired || 0) + 0.15);
        lesson += ` Filtro de volumen aumentado (+15%) por 2 pérdidas consecutivas.`;

        if (mem.consecutiveLosses >= 3) {
          // Poner activo en cuarentena de protección por 3 horas
          mem.quarantineUntil = Date.now() + (3 * 60 * 60 * 1000);
          lesson += ` 🔒 Activo puesto en Cuarentena de Protección por 3 horas para evitar drawdown.`;
        }
      }
    }

    if (!Array.isArray(mem.lessons)) mem.lessons = [];
    mem.lessons.unshift({
      date: Date.now(),
      isWin,
      rMultiple: rMult,
      lesson
    });
    if (mem.lessons.length > 20) mem.lessons.pop();

    // Guardar en la lista global de experiencias de trading
    if (!Array.isArray(this.experiences)) this.experiences = this.loadExperiences();
    this.experiences.unshift({
      id: trade.id || `exp_${Date.now()}`,
      symbol: trade.symbol,
      type: trade.type,
      entry: trade.entry,
      isWin,
      isStopHunt: Boolean(isStopHunt),
      rMultiple: rMult,
      lesson,
      timestamp: Date.now()
    });
    if (this.experiences.length > 100) this.experiences.pop();
    this.saveExperiences();

    this.saveMemory();
    console.log(`[Adaptive AI] 🧠 Experiencia registrada para ${symbol}:`, lesson);
  }

  loadExperiences() {
    try {
      const data = localStorage.getItem('smc_experiences_v1');
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  saveExperiences() {
    try {
      localStorage.setItem('smc_experiences_v1', JSON.stringify(this.experiences || []));
    } catch (e) {}
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

    const isQuarantined = Date.now() < (mem.quarantineUntil || 0);
    const winRate = mem.totalTrades > 0 ? (mem.wins / mem.totalTrades) * 100 : 50;

    return {
      symbol,
      isQuarantined,
      quarantineUntil: mem.quarantineUntil || 0,
      winRate: Math.round(winRate),
      totalTrades: mem.totalTrades || 0,
      wins: mem.wins || 0,
      losses: mem.losses || 0,
      atrBufferBonus: mem.atrBufferBonus || 0,
      extraVolumeRequired: mem.extraVolumeRequired || 0,
      consecutiveLosses: mem.consecutiveLosses || 0,
      lessons: mem.lessons || []
    };
  }

  getLearningReport() {
    if (!this.experiences) this.experiences = this.loadExperiences();
    const stats = this.getGlobalStats();
    const symbolProfiles = Object.keys(this.memory).map(sym => this.getAdaptiveProfile(sym));

    return {
      stats,
      experiences: this.experiences || [],
      symbolProfiles,
      totalExperiences: (this.experiences || []).length
    };
  }

  clearLearningMemory() {
    this.memory = {};
    this.experiences = [];
    this.saveMemory();
    this.saveExperiences();
  }

  getGlobalStats() {
    const closed = this.trades.filter(t => t.status !== 'OPEN' && t.status !== 'TP1_REACHED');
    const wins = closed.filter(t => t.status === 'WIN_TP3' || t.status === 'WIN_TP1_BE' || t.status === 'CLOSED_TP').length;
    const losses = closed.filter(t => t.status === 'LOSS_SL' || t.status === 'STOP_HUNT_LOSS' || t.status === 'CLOSED_SL').length;
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
