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
