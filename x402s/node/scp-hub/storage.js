const fs = require("fs");
const path = require("path");

const LEDGER_MAX = 10000;

function emptyState() {
  return {
    quotes: {},
    payments: {},
    paymentsByTicketId: {},
    paymentIdsByChannel: {},
    paymentIdsByPayee: {},
    channels: {},
    payeeLedger: {},
    nextSeq: 1
  };
}

// --- Memory backend (default for tests / perf mode) ---

class MemoryBackend {
  constructor() {
    this.state = emptyState();
  }
  async get(collection, key) {
    return (this.state[collection] || {})[key] || null;
  }
  async set(collection, key, value) {
    if (!this.state[collection]) this.state[collection] = {};
    this.state[collection][key] = value;
  }
  async incr(key) {
    const v = (this.state[key] || 0) + 1;
    this.state[key] = v;
    return v;
  }
  async getSeq() {
    return this.state.nextSeq || 1;
  }
  async getLedger(payee) {
    return (this.state.payeeLedger || {})[payee] || [];
  }
  async appendLedger(payee, entry) {
    if (!this.state.payeeLedger) this.state.payeeLedger = {};
    if (!this.state.payeeLedger[payee]) this.state.payeeLedger[payee] = [];
    this.state.payeeLedger[payee].push(entry);
    if (this.state.payeeLedger[payee].length > LEDGER_MAX) {
      this.state.payeeLedger[payee] = this.state.payeeLedger[payee].slice(-LEDGER_MAX);
    }
  }
  async tx(mutator) {
    mutator(this.state);
  }
  async listPayments() {
    return this.state.payments || {};
  }
  async close() {}
}

// --- JSON file backend (dev / single-instance) ---

class JsonFileBackend {
  constructor(filePath) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this._saveChain = Promise.resolve();
    this.state = emptyState();
    this._ensureDir();
    this._load();
  }

  _ensureDir() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _normalize(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptyState();
    }
    return {
      ...parsed,
      quotes: parsed.quotes || {},
      payments: parsed.payments || {},
      paymentsByTicketId: parsed.paymentsByTicketId || {},
      paymentIdsByChannel: parsed.paymentIdsByChannel || {},
      paymentIdsByPayee: parsed.paymentIdsByPayee || {},
      channels: parsed.channels || {},
      payeeLedger: parsed.payeeLedger || {},
      nextSeq: parsed.nextSeq || 1
    };
  }

  _reloadFromDisk() {
    if (!fs.existsSync(this.filePath)) {
      this.state = emptyState();
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this.state = this._normalize(JSON.parse(raw));
    } catch (_err) {
      this.state = emptyState();
    }
  }

  _load() {
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify(this.state), "utf8");
      return;
    }
    this._reloadFromDisk();
  }

  async _flushUnlocked() {
    const payload = JSON.stringify(this.state);
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.promises.writeFile(tmpPath, payload, "utf8");
    await fs.promises.rename(tmpPath, this.filePath);
  }

  async _acquireLock(timeoutMs = 5000, retryMs = 10) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const fh = await fs.promises.open(this.lockPath, "wx");
        return fh;
      } catch (err) {
        if (err && err.code !== "EEXIST") throw err;
        await new Promise((r) => setTimeout(r, retryMs));
      }
    }
    throw new Error(`storage lock timeout (${this.lockPath})`);
  }

  async _releaseLock(handle) {
    try {
      await handle.close();
    } catch (_e) { /* ignore */ }
    try {
      await fs.promises.unlink(this.lockPath);
    } catch (_e) { /* ignore */ }
  }

  async _withWrite(mutator) {
    this._saveChain = this._saveChain.then(async () => {
      const lock = await this._acquireLock();
      try {
        this._reloadFromDisk();
        const result = await mutator(this.state);
        await this._flushUnlocked();
        return result;
      } finally {
        await this._releaseLock(lock);
      }
    });
    return this._saveChain;
  }

  async get(collection, key) {
    this._reloadFromDisk();
    return (this.state[collection] || {})[key] || null;
  }
  async set(collection, key, value) {
    return this._withWrite((state) => {
      if (!state[collection]) state[collection] = {};
      state[collection][key] = value;
    });
  }
  async incr(key) {
    return this._withWrite((state) => {
      const v = (state[key] || 0) + 1;
      state[key] = v;
      return v;
    });
  }
  async getSeq() {
    this._reloadFromDisk();
    return this.state.nextSeq || 1;
  }
  async getLedger(payee) {
    this._reloadFromDisk();
    return (this.state.payeeLedger || {})[payee] || [];
  }
  async appendLedger(payee, entry) {
    return this._withWrite((state) => {
      if (!state.payeeLedger) state.payeeLedger = {};
      if (!state.payeeLedger[payee]) state.payeeLedger[payee] = [];
      state.payeeLedger[payee].push(entry);
      if (state.payeeLedger[payee].length > LEDGER_MAX) {
        state.payeeLedger[payee] = state.payeeLedger[payee].slice(-LEDGER_MAX);
      }
    });
  }
  async tx(mutator) {
    return this._withWrite((state) => mutator(state));
  }
  async listPayments() {
    this._reloadFromDisk();
    return this.state.payments || {};
  }
  async close() {}
}

// --- Redis backend (production / multi-instance) ---

class RedisBackend {
  constructor(redisClient, readyPromise) {
    this.r = redisClient;
    this.ready = Promise.resolve(readyPromise || null);
    this.stateKey = "scp:state";
  }
  async _ensureReady() {
    await this.ready;
  }
  _normalizeState(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptyState();
    }
    const out = {
      ...parsed,
      quotes: parsed.quotes || {},
      payments: parsed.payments || {},
      paymentsByTicketId: parsed.paymentsByTicketId || {},
      paymentIdsByChannel: parsed.paymentIdsByChannel || {},
      paymentIdsByPayee: parsed.paymentIdsByPayee || {},
      channels: parsed.channels || {},
      payeeLedger: parsed.payeeLedger || {},
      nextSeq: Number(parsed.nextSeq || 1)
    };
    if (!Number.isInteger(out.nextSeq) || out.nextSeq < 1) out.nextSeq = 1;
    return out;
  }
  async _loadState() {
    await this._ensureReady();
    const raw = await this.r.get(this.stateKey);
    if (!raw) return emptyState();
    try {
      return this._normalizeState(JSON.parse(raw));
    } catch (_e) {
      return emptyState();
    }
  }
  async tx(mutator, maxRetries = 25) {
    await this._ensureReady();
    let lastErr = null;
    for (let i = 0; i < maxRetries; i++) {
      await this.r.watch(this.stateKey);
      try {
        const state = await this._loadState();
        await mutator(state);
        const multi = this.r.multi();
        multi.set(this.stateKey, JSON.stringify(state));
        const result = await multi.exec();
        if (result !== null) return;
      } catch (err) {
        lastErr = err;
        try {
          await this.r.unwatch();
        } catch (_e) { /* ignore */ }
        throw err;
      }
    }
    throw lastErr || new Error("redis tx conflict");
  }
  async get(collection, key) {
    const state = await this._loadState();
    return (state[collection] || {})[key] || null;
  }
  async set(collection, key, value) {
    return this.tx((state) => {
      if (!state[collection] || typeof state[collection] !== "object") state[collection] = {};
      state[collection][key] = value;
    });
  }
  async incr(key) {
    let next = 0;
    await this.tx((state) => {
      const current = Number(state[key] || 0);
      next = current + 1;
      state[key] = next;
    });
    return next;
  }
  async getSeq() {
    const state = await this._loadState();
    return Number(state.nextSeq || 1);
  }
  async getLedger(payee) {
    const state = await this._loadState();
    return (state.payeeLedger || {})[payee] || [];
  }
  async appendLedger(payee, entry) {
    return this.tx((state) => {
      if (!state.payeeLedger) state.payeeLedger = {};
      if (!state.payeeLedger[payee]) state.payeeLedger[payee] = [];
      state.payeeLedger[payee].push(entry);
      if (state.payeeLedger[payee].length > LEDGER_MAX) {
        state.payeeLedger[payee] = state.payeeLedger[payee].slice(-LEDGER_MAX);
      }
    });
  }
  async listPayments() {
    const state = await this._loadState();
    return state.payments || {};
  }
  async close() {
    await this._ensureReady();
    await this.r.quit();
  }
}

// --- Storage (unified API, wraps any backend) ---

class Storage {
  constructor(backend) {
    if (typeof backend === "string") {
      if (backend === ":memory:") {
        this._backend = new MemoryBackend();
      } else {
        this._backend = new JsonFileBackend(backend);
      }
    } else if (backend && typeof backend.get === "function") {
      this._backend = backend;
    } else {
      this._backend = new MemoryBackend();
    }

    // Expose state for backward compat (json/memory backends)
    Object.defineProperty(this, "state", {
      enumerable: true,
      get: () => this._backend.state || {}
    });
  }

  getQuote(key) {
    return this._backend.get("quotes", key);
  }
  setQuote(key, value) {
    return this._backend.set("quotes", key, value);
  }
  getPayment(paymentId) {
    return this._backend.get("payments", paymentId);
  }
  setPayment(paymentId, value) {
    return this._backend.set("payments", paymentId, value);
  }
  async getPaymentByTicketId(ticketId) {
    const paymentId = await this._backend.get("paymentsByTicketId", ticketId);
    if (!paymentId) return null;
    return this.getPayment(paymentId);
  }
  async listPaymentsByChannel(channelId) {
    return this._listPaymentsByIndex("paymentIdsByChannel", channelId);
  }
  async listPaymentsByPayee(payee) {
    return this._listPaymentsByIndex("paymentIdsByPayee", String(payee || "").toLowerCase());
  }
  getChannel(channelId) {
    return this._backend.get("channels", channelId);
  }
  setChannel(channelId, value) {
    return this._backend.set("channels", channelId, value);
  }

  async tx(mutator) {
    if (typeof this._backend.tx === "function") {
      return this._backend.tx(mutator);
    }
    throw new Error("tx() not supported on this backend");
  }

  async nextSeq() {
    return this._backend.incr("nextSeq");
  }
  getHubChannel(payee) {
    return this._backend.get("hubChannels", payee.toLowerCase());
  }
  setHubChannel(payee, value) {
    return this._backend.set("hubChannels", payee.toLowerCase(), value);
  }
  getLedger(payee) {
    return this._backend.getLedger(payee);
  }
  appendLedger(payee, entry) {
    return this._backend.appendLedger(payee, entry);
  }
  listPayments() {
    if (typeof this._backend.listPayments === "function") {
      return this._backend.listPayments();
    }
    return Promise.resolve((this.state && this.state.payments) || {});
  }
  async _listPaymentsByIndex(indexCollection, indexKey) {
    const index = await this._backend.get(indexCollection, indexKey);
    if (!index || typeof index !== "object") return [];
    const payments = await this.listPayments();
    const out = [];
    for (const paymentId of Object.keys(index)) {
      const item = payments[paymentId];
      if (item) out.push(item);
    }
    return out;
  }
  close() {
    return this._backend.close();
  }
}

function createStorage(config) {
  if (!config || config === ":memory:") return new Storage(":memory:");
  if (typeof config === "string") return new Storage(config);
  if (config.redis) return new Storage(new RedisBackend(config.redis, config.ready));
  if (config.redisUrl) {
    let createClient;
    try {
      ({ createClient } = require("redis"));
    } catch (_err) {
      throw new Error(
        "REDIS_URL is set but the 'redis' package is not installed. Run: npm install redis"
      );
    }
    const client = createClient({ url: config.redisUrl });
    let connectError = null;
    const connectPromise = typeof client.connect === "function" ? client.connect() : Promise.resolve();
    const ready = connectPromise.catch((err) => {
      connectError = err;
    });
    const guardedReady = (async () => {
      await ready;
      if (connectError) {
        throw new Error(`redis connection failed: ${connectError.message || String(connectError)}`);
      }
    })();
    return new Storage(new RedisBackend(client, guardedReady));
  }
  return new Storage(config.path || ":memory:");
}

module.exports = { Storage, MemoryBackend, JsonFileBackend, RedisBackend, createStorage };
