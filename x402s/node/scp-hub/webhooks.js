/* eslint-disable no-console */
const crypto = require("crypto");
const http = require("http");
const https = require("https");

// ---- Event types ----
const EVENT = {
  CHANNEL_CLOSE_STARTED: "channel.close_started",
  CHANNEL_CHALLENGED: "channel.challenged",
  CHANNEL_CLOSED: "channel.closed",
  PAYMENT_RECEIVED: "payment.received",
  PAYMENT_REFUNDED: "payment.refunded",
  BALANCE_LOW: "balance.low"
};

// ---- Webhook manager ----

const MAX_RETRIES = 5;
const RETRY_BASE_MS = 2000;
const DELIVERY_TIMEOUT_MS = 5000;
const MAX_HOOKS_PER_CHANNEL = 10;
const EVENT_LOG_MAX = 1000;
const FAIL_THRESHOLD = 3;

function parseWebhookUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch (_e) {
    return null;
  }
}

function normalizeEvents(events) {
  const allowed = new Set(Object.values(EVENT));
  if (!events) return [...allowed];
  if (!Array.isArray(events) || events.length === 0) return null;
  const out = [];
  for (const ev of events) {
    if (!allowed.has(ev)) return null;
    if (!out.includes(ev)) out.push(ev);
  }
  return out;
}

class WebhookManager {
  constructor(store) {
    this.store = store;
    // { webhookId: { id, url, secret, events, channelId, status, createdAt, failCount } }
    this.hooks = {};
    // Ring buffer of recent events for polling
    this.eventLog = [];
    this.eventSeq = 0;
    // Active retry timers
    this._timers = new Set();
    // Load persisted hooks
    this._loadFromStore();
  }

  // ---- Persistence ----

  async _loadFromStore() {
    if (!this.store || !this.store._backend) return;
    try {
      const saved = await this.store._backend.get("webhooks", "_all");
      if (saved && typeof saved === "object") {
        for (const [id, hook] of Object.entries(saved)) {
          this.hooks[id] = hook;
        }
      }
    } catch (_e) { /* no persisted hooks */ }
  }

  _persist() {
    if (!this.store || !this.store._backend) return;
    this.store._backend.set("webhooks", "_all", this.hooks).catch(() => {});
  }

  // ---- CRUD ----

  register({ url, events, channelId, secret }) {
    const parsed = parseWebhookUrl(url);
    if (!parsed) {
      return { error: "invalid webhook url: must be absolute http(s) URL" };
    }
    const normalizedEvents = normalizeEvents(events);
    if (!normalizedEvents) {
      return { error: `events must be a non-empty subset of: ${Object.values(EVENT).join(", ")}` };
    }
    const count = Object.values(this.hooks).filter(
      (h) => h.channelId === channelId && h.status === "active"
    ).length;
    if (count >= MAX_HOOKS_PER_CHANNEL) {
      return { error: "max webhooks reached for this channel" };
    }
    const id = `wh_${crypto.randomBytes(8).toString("hex")}`;
    const hook = {
      id,
      url: parsed.toString(),
      secret: secret || crypto.randomBytes(16).toString("hex"),
      events: normalizedEvents,
      channelId: channelId || "*",
      status: "active",
      createdAt: Math.floor(Date.now() / 1000),
      failCount: 0
    };
    this.hooks[id] = hook;
    this._persist();
    return { webhookId: id, status: "active", secret: hook.secret };
  }

  update(id, patch) {
    const hook = this.hooks[id];
    if (!hook) return null;
    if (patch.url) {
      const parsed = parseWebhookUrl(patch.url);
      if (!parsed) return null;
      hook.url = parsed.toString();
    }
    if (patch.events) {
      const normalizedEvents = normalizeEvents(patch.events);
      if (!normalizedEvents) return null;
      hook.events = normalizedEvents;
    }
    if (patch.secret) hook.secret = patch.secret;
    if (patch.status === "active" || patch.status === "paused") {
      hook.status = patch.status;
      hook.failCount = 0;
    }
    this._persist();
    return hook;
  }

  remove(id) {
    if (!this.hooks[id]) return false;
    delete this.hooks[id];
    this._persist();
    return true;
  }

  get(id) {
    return this.hooks[id] || null;
  }

  list(channelId) {
    return Object.values(this.hooks).filter(
      (h) => !channelId || h.channelId === channelId || h.channelId === "*"
    );
  }

  // ---- Event emission ----

  emit(event, data) {
    this.eventSeq++;
    const entry = {
      seq: this.eventSeq,
      event,
      timestamp: Math.floor(Date.now() / 1000),
      data
    };
    this.eventLog.push(entry);
    if (this.eventLog.length > EVENT_LOG_MAX) {
      this.eventLog = this.eventLog.slice(-EVENT_LOG_MAX);
    }

    const channelId = data.channelId || "*";
    for (const hook of Object.values(this.hooks)) {
      if (hook.status !== "active") continue;
      if (!hook.events.includes(event)) continue;
      if (hook.channelId !== "*" && hook.channelId !== channelId) continue;
      this._deliver(hook, entry, 0);
    }

    return entry;
  }

  // ---- Polling ----

  poll({ since, channelId, limit }) {
    const max = Math.min(limit || 50, 200);
    const sinceSeq = since || 0;
    const items = this.eventLog
      .filter(
        (e) =>
          e.seq > sinceSeq &&
          (!channelId || (e.data && e.data.channelId === channelId))
      )
      .slice(0, max);
    const nextCursor = items.length ? items[items.length - 1].seq : sinceSeq;
    return { since: sinceSeq, count: items.length, nextCursor, items };
  }

  // ---- Delivery ----

  _deliver(hook, entry, attempt) {
    const payload = JSON.stringify({
      event: entry.event,
      timestamp: entry.timestamp,
      webhookId: hook.id,
      seq: entry.seq,
      data: entry.data
    });

    const sig = crypto
      .createHmac("sha256", hook.secret)
      .update(payload)
      .digest("hex");

    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      if (ok) {
        hook.failCount = 0;
      } else {
        this._retry(hook, entry, attempt);
      }
    };
    const u = parseWebhookUrl(hook.url);
    if (!u) {
      settle(false);
      return;
    }
    const client = u.protocol === "https:" ? https : http;

    const req = client.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: `${u.pathname || "/"}${u.search || ""}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "X-SCP-Signature": `sha256=${sig}`,
          "X-SCP-Event": entry.event,
          "X-SCP-Delivery-Attempt": String(attempt + 1)
        }
      },
      (res) => {
        res.resume();
        settle(res.statusCode >= 200 && res.statusCode < 300);
      }
    );

    req.setTimeout(DELIVERY_TIMEOUT_MS, () => {
      req.destroy();
      settle(false);
    });

    req.on("error", () => settle(false));

    req.write(payload);
    req.end();
  }

  _retry(hook, entry, attempt) {
    if (attempt >= MAX_RETRIES) {
      hook.failCount++;
      if (hook.failCount >= FAIL_THRESHOLD) {
        hook.status = "failing";
        this._persist();
        console.log(`[webhooks] hook ${hook.id} marked failing after ${hook.failCount} failed events`);
      }
      return;
    }
    const delay = RETRY_BASE_MS * Math.pow(2, attempt);
    const timer = setTimeout(() => {
      this._timers.delete(timer);
      this._deliver(hook, entry, attempt + 1);
    }, delay);
    this._timers.add(timer);
  }

  // ---- Cleanup ----

  close() {
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
  }
}

module.exports = { WebhookManager, EVENT };
