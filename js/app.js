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

  // Inicializar TradeTracker con Callback de Eventos en Vivo
  const tradeTracker = new TradeTracker({
    onTradeEvent: (event) => {
      handleTradeLifeEvent(event);
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
    }
  });

  // Motor de Sincronización en la Nube (PC ↔ Móvil)
  const cloudSync = new CloudSync({
    onSync: (cloudData) => {
      let changed = false;
      if (cloudData.syncPayload && typeof scanner.mergeSyncPayload === 'function') {
        if (scanner.mergeSyncPayload(cloudData.syncPayload)) changed = true;
      }
      if (tradeTracker.mergeCloudData(cloudData)) changed = true;

      if (changed) {
        renderApp(scanner.getAllResults());
      }
    }
  });
  window._cloudSync = cloudSync;

  cloudSync.startAutoSync(() => ({
    trades: tradeTracker.trades,
    memory: tradeTracker.memory,
    syncPayload: scanner.getExecutedPayload(),
    userCapital,
    userRiskPct,
    filterMode: smcDetector.filterMode
  }));
  
  let audioEnabled = true;
  let audioCtx = null;
  
  let discordWebhookUrl = localStorage.getItem('discord_webhook_url') || '';

  const scanner = new CryptoScanner(binanceAPI, smcDetector, tradeTracker, {
    scanIntervalMs: 15000,
    onUpdate: renderApp,
    onAlert: handleAlert
  });

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
        tr.className = 'crypto-table-row text-xs cursor-pointer group';
        const cleanPair = item.symbol.replace('/', '').toUpperCase();
        const binanceFuturesUrl = `https://www.binance.com/es/futures/${cleanPair}`;

        let trendClass = 'text-gray-400';
        if (item.trend === 'ALCISTA') trendClass = 'text-emerald-400';
        if (item.trend === 'BAJISTA') trendClass = 'text-rose-400';
        if (item.trend.includes('CUARENTENA')) trendClass = 'text-amber-400 font-bold';

        let signalBadge = `<span class="text-gray-600 font-mono">-</span>`;
        const userTrade = scanner.getUserOpenTrade(item.symbol);

        if (userTrade) {
          signalBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">✓ EN CURSO</span>`;
        } else if (item.signal && !scanner.isSignalExecutedOrDismissed(item.signal.id, item.symbol)) {
          const isLong = item.signal.type === 'LONG';
          signalBadge = `<span class="font-extrabold ${isLong ? 'text-amber-400' : 'text-amber-500'} font-mono">${item.signal.type}</span>`;
        }

        tr.innerHTML = `
          <td class="py-3 px-4 font-bold text-gray-200 group-hover:text-amber-400 transition-colors">
            <a href="${binanceFuturesUrl}" target="_blank" class="flex items-center gap-1.5">
              <span>${item.base}</span>
              <span class="text-[10px] text-gray-500 group-hover:text-amber-400 font-normal">↗</span>
            </a>
          </td>
          <td class="py-3 px-4 font-mono text-gray-300">${formatPrice(item.price, item.symbol)}</td>
          <td class="py-3 px-4 text-[10px] font-bold ${trendClass}">4H ${item.trend}</td>
          <td class="py-3 px-4 text-right font-bold">${signalBadge}</td>
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
      apiModal?.classList.add('hidden');
      updateModeUI();
      showToast('🔐 Claves API de Binance guardadas con éxito', 'success');
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

  updateDiscordBadge();
  setupEvents();
  renderApp(scanner.getAllResults()); // Renderizado instantáneo de los 15 activos
  scanner.start();

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
  // WAKE LOCK: Evita que la pantalla se apague mientras la app está abierta
  // (funciona en Android Chrome + Chrome PC, no en iOS)
  // ─────────────────────────────────────────────────────────────────────
  let wakeLock = null;

  async function requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        console.log('[WakeLock] Pantalla bloqueada activa.');
        wakeLock.addEventListener('release', () => {
          console.log('[WakeLock] Pantalla desbloqueada.');
        });
      } catch (err) {
        console.warn('[WakeLock] No disponible:', err.message);
      }
    }
  }

  // Re-solicitar WakeLock cada vez que la app vuelve al primer plano
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden && wakeLock === null) {
      await requestWakeLock();
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

      const slStatus = result.slOrderId ? `SL: $${result.stopPrice}` : (result.slErrorMsg ? `⚠️ SL: ${result.slErrorMsg}` : '⚠️ SL manual');
      const tpStatus = result.tpOrderId ? `TP: $${result.takeProfit}` : (result.tpErrorMsg ? `⚠️ TP: ${result.tpErrorMsg}` : '⚠️ TP manual');
      showToast(`✅ Orden ${result.symbol} ${result.type} (${result.quantity} contratos) | ${slStatus} | ${tpStatus}`, result.slOrderId ? 'success' : 'info');
      playChime(targetSignal.type);

      // 1. Registrar trade en el tracker para seguimiento de auditoría en vivo
      tradeTracker.registerSignal(targetSignal);

      // 2. Registrar orden REAL del usuario para marcar ✓ EN CURSO únicamente en este activo
      scanner.addUserExecutedTrade(targetSignal);

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

