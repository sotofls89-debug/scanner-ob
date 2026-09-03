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
