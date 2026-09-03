/**
 * Chart Manager - Optimizado y Robusto
 * 1. Sanitización de datos: ordenamiento cronológico estricto y deduplicación de timestamps.
 * 2. Manejo seguro y defensivo de propiedades numéricas en drawTradeLevels.
 * 3. Compatibilidad total de tipos (LONG/BULLISH y SHORT/BEARISH).
 * 4. Limpieza completa de memoria en destroy().
 */
class ChartManager {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.chart = null;
    this.candleSeries = null;
    this.priceLines = [];
    this.currentData = [];
    this.timeframe = options.timeframe || '15m';
    this.onCrosshairMove = options.onCrosshairMove || null;
    this.resizeObserver = null;

    this.initChart();
  }

  initChart() {
    if (!this.container || typeof LightweightCharts === 'undefined') return;

    this.container.innerHTML = '';

    const chartOptions = {
      layout: {
        background: { color: '#080c14' },
        textColor: '#8b949e',
        fontSize: 12,
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
      },
      grid: {
        vertLines: { color: '#131b2c', style: 1 },
        horzLines: { color: '#131b2c', style: 1 }
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: {
          color: '#388bfd',
          width: 1,
          style: 3,
          labelBackgroundColor: '#1f6feb'
        },
        horzLine: {
          color: '#388bfd',
          width: 1,
          style: 3,
          labelBackgroundColor: '#1f6feb'
        }
      },
      rightPriceScale: {
        borderColor: '#1c273c',
        autoScale: true,
        scaleMargins: {
          top: 0.1,
          bottom: 0.15
        }
      },
      timeScale: {
        borderColor: '#1c273c',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 12,
        barSpacing: 8
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true
      }
    };

    this.chart = LightweightCharts.createChart(this.container, chartOptions);

    this.candleSeries = this.chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      borderUpColor: '#10b981',
      borderDownColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444'
    });

    // ResizeObserver seguro
    this.resizeObserver = new ResizeObserver(entries => {
      if (entries.length === 0 || entries[0].target !== this.container || !this.chart) { return; }
      const newRect = entries[0].contentRect;
      if (newRect.width > 0 && newRect.height > 0) {
        this.chart.applyOptions({ width: newRect.width, height: newRect.height });
      }
    });
    this.resizeObserver.observe(this.container);

    if (this.onCrosshairMove) {
      this.chart.subscribeCrosshairMove(this.onCrosshairMove);
    }
  }

  /**
   * Sanitiza las velas: Orden ascendente estricto y eliminación de duplicados por timestamp
   */
  sanitizeCandles(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return [];

    // 1. Filtrar objetos válidos con time numérico
    const valid = candles.filter(c => c && typeof c.time === 'number' && !isNaN(c.time));

    // 2. Ordenar cronológicamente
    valid.sort((a, b) => a.time - b.time);

    // 3. Deduplicar timestamps manteniendo el último valor actualizado
    const uniqueMap = new Map();
    for (const c of valid) {
      uniqueMap.set(c.time, {
        time: c.time,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      });
    }

    return Array.from(uniqueMap.values());
  }

  /**
   * Actualiza el conjunto de velas en el gráfico
   */
  setData(candles) {
    if (!this.candleSeries || !this.chart) return;
    const sanitized = this.sanitizeCandles(candles);
    this.currentData = sanitized;
    try {
      this.candleSeries.setData(sanitized);
    } catch (err) {
      console.warn('[ChartManager] Error al aplicar setData:', err);
    }
  }

  /**
   * Actualiza la última vela en tiempo real (Tick) con validación de timestamp
   */
  updateCandle(candle) {
    if (!this.candleSeries || !candle || typeof candle.time !== 'number') return;

    const formatted = {
      time: candle.time,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close)
    };

    const len = this.currentData.length;
    if (len > 0) {
      const lastTime = this.currentData[len - 1].time;
      // Lightweight Charts requiere que el nuevo tick sea >= al último tiempo registrado
      if (formatted.time < lastTime) {
        return; // Descartar ticks desfasados
      }
      if (formatted.time === lastTime) {
        this.currentData[len - 1] = formatted;
      } else {
        this.currentData.push(formatted);
      }
    } else {
      this.currentData.push(formatted);
    }

    try {
      this.candleSeries.update(formatted);
    } catch (err) {
      console.warn('[ChartManager] Error en updateCandle:', err);
    }
  }

  /**
   * Limpia las líneas de precios (Entry, SL, TP)
   */
  clearPriceLines() {
    if (!this.candleSeries) return;
    this.priceLines.forEach(line => {
      try {
        this.candleSeries.removePriceLine(line);
      } catch (e) {}
    });
    this.priceLines = [];
  }

  /**
   * Dibuja los niveles de Trade con formateo seguro contra valores undefined
   */
  drawTradeLevels(setup) {
    this.clearPriceLines();
    if (!setup || !this.candleSeries) return;

    const entry = Number(setup.entry) || 0;
    const stopLoss = Number(setup.stop || setup.stopLoss) || 0;
    const takeProfit = Number(setup.tp3 || setup.takeProfit) || 0;
    const riskPercent = Number(setup.riskPercent) || (entry > 0 ? (Math.abs(entry - stopLoss) / entry) * 100 : 0);
    const rewardPercent = Number(setup.rewardPercent) || (riskPercent * 3);

    if (entry <= 0 || stopLoss <= 0 || takeProfit <= 0) return;

    try {
      // Línea de Entrada
      const entryLine = this.candleSeries.createPriceLine({
        price: entry,
        color: '#38bdf8',
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: `ENTRADA: $${entry.toFixed(4)}`
      });
      this.priceLines.push(entryLine);

      // Línea de Stop Loss
      const slLine = this.candleSeries.createPriceLine({
        price: stopLoss,
        color: '#ef4444',
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Solid,
        axisLabelVisible: true,
        title: `SL (-${riskPercent.toFixed(2)}%): $${stopLoss.toFixed(4)}`
      });
      this.priceLines.push(slLine);

      // Línea de Take Profit 1:3
      const tpLine = this.candleSeries.createPriceLine({
        price: takeProfit,
        color: '#10b981',
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Solid,
        axisLabelVisible: true,
        title: `TP 1x3 (+${rewardPercent.toFixed(2)}%): $${takeProfit.toFixed(4)}`
      });
      this.priceLines.push(tpLine);
    } catch (err) {
      console.warn('[ChartManager] Error dibujando niveles de precio:', err);
    }
  }

  /**
   * Dibuja marcas de Order Blocks soportando ambos formatos (LONG/BULLISH y SHORT/BEARISH)
   */
  drawOrderBlockMarkers(orderBlocks) {
    if (!this.candleSeries || !Array.isArray(orderBlocks)) return;

    const markers = [];
    const recentBlocks = orderBlocks.slice(-8);

    recentBlocks.forEach(ob => {
      if (!ob || !ob.time) return;

      const isBull = ob.type === 'BULLISH' || ob.type === 'LONG';
      const isBear = ob.type === 'BEARISH' || ob.type === 'SHORT';

      if (isBull) {
        markers.push({
          time: ob.time,
          position: 'belowBar',
          color: ob.isMitigated ? '#4b5563' : '#10b981',
          shape: 'arrowUp',
          text: ob.isMitigated ? 'OB Alcista (Mitigado)' : '🔥 OB Alcista (15m)'
        });
      } else if (isBear) {
        markers.push({
          time: ob.time,
          position: 'aboveBar',
          color: ob.isMitigated ? '#4b5563' : '#ef4444',
          shape: 'arrowDown',
          text: ob.isMitigated ? 'OB Bajista (Mitigado)' : '❄️ OB Bajista (15m)'
        });
      }
    });

    // Orden cronológico estricto para markers
    markers.sort((a, b) => a.time - b.time);

    try {
      this.candleSeries.setMarkers(markers);
    } catch (err) {
      console.warn('[ChartManager] Error al aplicar markers:', err);
    }
  }

  fitContent() {
    if (this.chart) {
      try {
        this.chart.timeScale().fitContent();
      } catch (e) {}
    }
  }

  /**
   * Limpieza completa de memoria
   */
  destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.clearPriceLines();
    if (this.chart) {
      try {
        this.chart.remove();
      } catch (e) {}
      this.chart = null;
    }
    this.candleSeries = null;
    this.currentData = [];
  }
}

window.ChartManager = ChartManager;
