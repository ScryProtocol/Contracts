/* eslint-disable no-console */
const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { createVerifier } = require("../scp-hub/ticket");
const { HttpJsonClient } = require("../scp-common/http-client");
const { resolveHubEndpointForNetwork, toCaip2 } = require("../scp-common/networks");

const DEFAULT_NETWORK = toCaip2(process.env.NETWORK || "eip155:8453") || "eip155:8453";
const DEFAULT_STREAM_T_RAW = Number(process.env.PAYEE_STREAM_T_SEC || process.env.STREAM_T_SEC || 5);
const DEFAULT_STREAM_T_SEC = Number.isInteger(DEFAULT_STREAM_T_RAW) && DEFAULT_STREAM_T_RAW > 0
  ? DEFAULT_STREAM_T_RAW
  : 5;

const DEFAULTS = {
  host: process.env.PAYEE_HOST || "127.0.0.1",
  port: Number(process.env.PAYEE_PORT || 4042),
  hubUrl: process.env.HUB_URL || resolveHubEndpointForNetwork(DEFAULT_NETWORK),
  network: DEFAULT_NETWORK,
  asset: process.env.DEFAULT_ASSET || "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913",
  price: process.env.PRICE || "1000000",
  hubName: process.env.HUB_NAME || "pay.eth",
  resourcePath: "/v1/data",
  routes: null, // { "/v1/data": { price: "1000000" }, "/v1/premium": { price: "5000000" } }
  perfMode: process.env.PERF_MODE === "1",
  paymentMode: String(process.env.PAYEE_PAYMENT_MODE || process.env.PAYMENT_MODE || "per_request").toLowerCase(),
  streamT: DEFAULT_STREAM_T_SEC,
  payOnceTtlSec: Number(process.env.PAYEE_PAY_ONCE_TTL_SEC || process.env.PAY_ONCE_TTL_SEC || 86400),
  replayStorePath: process.env.PAYEE_REPLAY_STORE_PATH || "",
  replayTtlSec: Number(process.env.PAYEE_REPLAY_TTL_SEC || 2592000),
  replayMaxEntries: Number(process.env.PAYEE_REPLAY_MAX_ENTRIES || 50000),
  payeePrivateKey: process.env.PAYEE_PRIVATE_KEY || null
};
if (!DEFAULTS.payeePrivateKey) {
  console.error("FATAL: PAYEE_PRIVATE_KEY env var is required. Never use hardcoded keys.");
  process.exit(1);
}
const defaultPayeeWallet = new ethers.Wallet(DEFAULTS.payeePrivateKey);
const PAYEE_ADDRESS = defaultPayeeWallet.address;
const RESOURCE_PATH = DEFAULTS.resourcePath;

const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const CORS_HEADERS = [
  "Content-Type",
  "Payment-Signature",
  "X-SCP-Access-Token",
  "X-SCP-Signature"
].join(", ");

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", CORS_HEADERS);
  res.setHeader("Access-Control-Max-Age", "86400");
}

function now() {
  return Math.floor(Date.now() / 1000);
}

class FileReplayCache {
  constructor({ filePath, ttlSec, maxEntries }) {
    this.filePath = path.resolve(filePath);
    this.ttlSec = Math.max(1, Number(ttlSec || 1));
    this.maxEntries = Math.max(1, Number(maxEntries || 1));
    this.records = new Map();
    this.flushTimer = null;
    this._ensureDir();
    this._load();
  }

  _ensureDir() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      const t = now();
      for (const pair of entries) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [k, rec] = pair;
        if (!rec || typeof rec !== "object") continue;
        if (!Number.isFinite(rec.expiresAt)) continue;
        if (rec.expiresAt <= t) continue;
        this.records.set(String(k), rec);
      }
      this._sweep(t);
    } catch (_e) {
      this.records.clear();
    }
  }

  _sweep(t = now()) {
    for (const [k, rec] of this.records) {
      if (!rec || !Number.isFinite(rec.expiresAt) || rec.expiresAt <= t) this.records.delete(k);
    }
    while (this.records.size > this.maxEntries) {
      const first = this.records.keys().next().value;
      if (first === undefined) break;
      this.records.delete(first);
    }
  }

  _scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this._flushNow();
    }, 75);
    if (typeof this.flushTimer.unref === "function") this.flushTimer.unref();
  }

  _flushNow() {
    try {
      this._sweep();
      const payload = JSON.stringify({ entries: [...this.records.entries()] });
      const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      console.error(`[payee] replay cache flush failed: ${e.message}`);
    }
  }

  has(key) {
    const k = String(key);
    const rec = this.records.get(k);
    if (!rec) return false;
    if (rec.expiresAt <= now()) {
      this.records.delete(k);
      this._scheduleFlush();
      return false;
    }
    return true;
  }

  get(key) {
    const k = String(key);
    const rec = this.records.get(k);
    if (!rec) return undefined;
    if (rec.expiresAt <= now()) {
      this.records.delete(k);
      this._scheduleFlush();
      return undefined;
    }
    return rec.value;
  }

  set(key, value) {
    const k = String(key);
    this.records.set(k, { value, expiresAt: now() + this.ttlSec });
    this._sweep();
    this._scheduleFlush();
    return this;
  }

  delete(key) {
    const out = this.records.delete(String(key));
    if (out) this._scheduleFlush();
    return out;
  }

  close() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this._flushNow();
  }
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  setCorsHeaders(res);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function resolvePrice(routeCfg, asset, fallback) {
  const p = (routeCfg && routeCfg.price) || fallback;
  if (typeof p === "object") return p[asset] || p[Object.keys(p)[0]] || fallback;
  return p;
}

const INVOICE_TTL = 300; // seconds — generous buffer over 120s quote expiry
let lastSweep = 0;

function sweepInvoices(invoiceStore) {
  const t = now();
  if (t - lastSweep < 60) return; // sweep at most once per minute
  lastSweep = t;
  for (const [id, inv] of invoiceStore) {
    if (t - inv.createdAt > INVOICE_TTL) invoiceStore.delete(id);
  }
}

function makeOffers(cfg, payeeAddress, routePath, routeCfg, invoiceStore) {
  sweepInvoices(invoiceStore);
  const resource = `http://${cfg.host}:${cfg.port}${routePath || cfg.resourcePath}`;
  const acceptsList = (routeCfg && routeCfg.accepts) || [
    { network: cfg.network, asset: cfg.asset, hub: cfg.hubUrl, hubName: cfg.hubName }
  ];
  const offers = [];
  for (const entry of acceptsList) {
    const network = toCaip2(entry.network || cfg.network) || cfg.network;
    const asset = entry.asset || cfg.asset;
    const hubEndpoint = entry.hub || cfg.hubUrl;
    const hubName = entry.hubName || cfg.hubName;
    const price = entry.price || resolvePrice(routeCfg, asset, cfg.price);
    const routeStream = routeCfg && typeof routeCfg.stream === "object" ? routeCfg.stream : null;
    const entryStream = entry && typeof entry.stream === "object" ? entry.stream : null;
    const streamAmount = String(
      (entryStream && entryStream.amount) ||
      (routeStream && routeStream.amount) ||
      price
    );
    const streamTCandidate = Number(
      (entryStream && entryStream.t) ??
      (routeStream && routeStream.t)
    );
    const streamT = Number.isInteger(streamTCandidate) && streamTCandidate > 0
      ? streamTCandidate
      : cfg.streamT;
    const invoiceId = randomId("inv");
    invoiceStore.set(invoiceId, {
      createdAt: now(),
      path: routePath || cfg.resourcePath,
      amount: price,
      asset,
      network,
      hubEndpoint
    });
    offers.push({
      scheme: "statechannel-hub-v1",
      network,
      asset,
      maxAmountRequired: price,
      payTo: hubName,
      resource,
      extensions: {
        "statechannel-hub-v1": {
          hubName,
          hubEndpoint,
          mode: "proxy_hold",
          feeModel: { base: "10", bps: 30 },
          stream: { amount: streamAmount, t: streamT },
          quoteExpiry: now() + 120,
          invoiceId,
          payeeAddress
        }
      }
    });
    offers.push({
      scheme: "statechannel-direct-v1",
      network,
      asset,
      maxAmountRequired: price,
      payTo: payeeAddress,
      resource,
      extensions: {
        "statechannel-direct-v1": {
          mode: "direct",
          quoteExpiry: now() + 120,
          invoiceId,
          payeeAddress
        }
      }
    });
  }
  return { accepts: offers };
}

function collectHubUrls(cfg) {
  const routeMap = cfg.routes || { [cfg.resourcePath]: { price: cfg.price } };
  const set = new Set();
  set.add(cfg.hubUrl);
  for (const routeCfg of Object.values(routeMap)) {
    const accepts = (routeCfg && routeCfg.accepts) || [];
    for (const entry of accepts) {
      if (entry && entry.hub) set.add(entry.hub);
    }
  }
  return [...set].filter(Boolean);
}

function getPaymentHeader(req) {
  return req.headers["payment-signature"] || req.headers["PAYMENT-SIGNATURE"] || null;
}

function parseCookies(req) {
  const raw = req.headers.cookie;
  if (!raw || typeof raw !== "string") return {};
  const out = {};
  for (const pair of raw.split(";")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(pair.slice(idx + 1).trim());
    } catch (_e) {
      out[key] = pair.slice(idx + 1).trim();
    }
  }
  return out;
}

function getAccessToken(req) {
  const headerToken = req.headers["x-scp-access-token"];
  if (typeof headerToken === "string" && headerToken.trim()) return headerToken.trim();
  const cookies = parseCookies(req);
  return cookies.scp_access || null;
}

function getAccessGrant(req, pathname, ctx) {
  const token = getAccessToken(req);
  if (!token) return null;
  const grant = ctx.accessGrants.get(token);
  if (!grant) return null;
  if (grant.expiresAt <= now()) {
    ctx.accessGrants.delete(token);
    return null;
  }
  if (grant.path !== pathname) return null;
  return { token, expiresAt: grant.expiresAt };
}

function issueAccessGrant(res, pathname, ctx) {
  const token = randomId("acc");
  const expiresAt = now() + ctx.cfg.payOnceTtlSec;
  ctx.accessGrants.set(token, { path: pathname, expiresAt });
  res.setHeader(
    "Set-Cookie",
    `scp_access=${encodeURIComponent(token)}; Max-Age=${ctx.cfg.payOnceTtlSec}; Path=/; HttpOnly; SameSite=Lax`
  );
  return { mode: "pay_once", token, expiresAt };
}

function verifyWebhookSig(payload, secret, sigHeader) {
  if (!sigHeader || !secret) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return sigHeader === expected;
}

async function handle(req, res, ctx) {
  const { cfg, payeeAddress, invoiceStore, consumed } = ctx;
  const u = new URL(req.url, `http://${req.headers.host || `${cfg.host}:${cfg.port}`}`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    return res.end();
  }

  // Webhook receiver — hub pushes events here
  if (req.method === "POST" && u.pathname === "/webhooks/hub") {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (ctx.webhookSecret && !verifyWebhookSig(body, ctx.webhookSecret, req.headers["x-scp-signature"])) {
      return sendJson(res, 401, { error: "invalid webhook signature" });
    }
    try {
      const event = JSON.parse(body);
      if (!ctx.webhookEvents) ctx.webhookEvents = [];
      ctx.webhookEvents.push(event);
      if (ctx.webhookEvents.length > 500) ctx.webhookEvents = ctx.webhookEvents.slice(-500);
      console.log(`[payee] webhook event: ${event.event} seq=${event.seq}`);
    } catch (_e) { /* ignore malformed */ }
    return sendJson(res, 200, { ok: true });
  }

  const routeMap = cfg.routes || { [cfg.resourcePath]: { price: cfg.price } };
  const matchedRoute = routeMap[u.pathname];
  const isPay = req.method === "GET" && u.pathname === "/pay";

  if (!isPay && !matchedRoute) {
    return sendJson(res, 404, { error: "not found" });
  }

  const rawHeader = getPaymentHeader(req);
  const expectedPath = isPay ? null : u.pathname;
  if (!rawHeader) {
    if (isPay) {
      const allOffers = [];
      for (const [rPath, rCfg] of Object.entries(routeMap)) {
        const offers = makeOffers(cfg, payeeAddress, rPath, rCfg, invoiceStore);
        allOffers.push(...offers.accepts);
      }
      return sendJson(res, 200, { accepts: allOffers });
    }
    if (cfg.paymentMode === "pay_once") {
      const grant = getAccessGrant(req, u.pathname, ctx);
      if (grant) {
        return sendJson(res, 200, {
          ok: true,
          data: { value: "premium-resource", payee: payeeAddress },
          access: { mode: "pay_once", token: grant.token, expiresAt: grant.expiresAt }
        });
      }
    }
    return sendJson(res, 402, makeOffers(cfg, payeeAddress, u.pathname, matchedRoute, invoiceStore));
  }

  const invoiceLookup = (invoiceId, paymentProof) => {
    const inv = invoiceStore.get(invoiceId);
    if (!inv) return false;
    if (expectedPath && inv.path && inv.path !== expectedPath) return false;
    if (!paymentProof) return true;
    if (inv.amount && paymentProof.amount !== inv.amount) return false;
    if (inv.asset && String(paymentProof.asset || "").toLowerCase() !== String(inv.asset).toLowerCase()) return false;
    return true;
  };
  const result = await ctx.verifyPayment(rawHeader, invoiceLookup);

  if (result.replayed) return sendJson(res, 200, result.response);

  if (!result.ok) {
    return sendJson(res, 402, { error: result.error, retryable: false });
  }

  let access = null;
  if (cfg.paymentMode === "pay_once") {
    let grantPath = u.pathname;
    if (isPay) {
      const invoiceId = result.scheme === "direct" ? result.direct.invoiceId : result.ticket.invoiceId;
      const inv = invoiceStore.get(invoiceId);
      if (inv && inv.path) grantPath = inv.path;
    }
    access = issueAccessGrant(res, grantPath, ctx);
  }

  const receipt = {
    paymentId: result.paymentId,
    receiptId: randomId("rcpt"),
    acceptedAt: now()
  };
  if (result.scheme === "direct") {
    receipt.directChannelId = result.direct.channelState.channelId;
  } else {
    receipt.ticketId = result.ticket.ticketId;
  }
  const payload = {
    ok: true,
    data: { value: "premium-resource", payee: payeeAddress },
    ...(access ? { access } : {}),
    receipt
  };
  consumed.set(result.paymentId, payload);
  return sendJson(res, 200, payload);
}

function createPayeeServer(options = {}) {
  const cfg = {
    ...DEFAULTS,
    ...options
  };
  if (!["per_request", "pay_once"].includes(cfg.paymentMode)) {
    throw new Error("invalid payment mode; use per_request or pay_once");
  }
  if (!Number.isInteger(cfg.payOnceTtlSec) || cfg.payOnceTtlSec <= 0) {
    throw new Error("invalid pay-once TTL; expected positive integer seconds");
  }
  if (!Number.isInteger(cfg.replayTtlSec) || cfg.replayTtlSec <= 0) {
    throw new Error("invalid replay TTL; expected positive integer seconds");
  }
  if (!Number.isInteger(cfg.replayMaxEntries) || cfg.replayMaxEntries <= 0) {
    throw new Error("invalid replay max entries; expected positive integer");
  }
  const payeeWallet = new ethers.Wallet(cfg.payeePrivateKey);
  const payeeAddress = payeeWallet.address;
  const invoiceStore = new Map();
  const consumed = cfg.replayStorePath
    ? new FileReplayCache({
      filePath: cfg.replayStorePath,
      ttlSec: cfg.replayTtlSec,
      maxEntries: cfg.replayMaxEntries
    })
    : new Map();
  if (!cfg.replayStorePath && String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    // SECURITY: In-memory replay cache is wiped on restart, allowing payment replays.
    // Previously this was a warning; now it's a hard failure in production.
    throw new Error(
      "FATAL: production requires persistent replay cache. " +
      "Set PAYEE_REPLAY_STORE_PATH to a file path. " +
      "In-memory cache allows replays after restart."
    );
  }
  const ctx = {
    cfg,
    payeeAddress,
    invoiceStore,
    consumed,
    accessGrants: new Map(),
    directChannels: new Map(),
    hubUrls: collectHubUrls(cfg),
    http: new HttpJsonClient({ timeoutMs: 8000, maxSockets: 128 })
  };
  ctx.verifyPayment = createVerifier({
    payee: payeeAddress,
    hubs: ctx.hubUrls,
    confirmHub: !cfg.perfMode,
    seenPayments: consumed,
    directChannels: ctx.directChannels
  });

  const server = http.createServer((req, res) => {
    handle(req, res, ctx).catch((err) => {
      sendJson(res, 500, { error: err.message || "internal error" });
    });
  });

  // Auto-register webhook with hub after listening
  const origListen = server.listen.bind(server);
  server.listen = function (...args) {
    const s = origListen(...args);
    s.once("listening", () => {
      const addr = s.address();
      const selfUrl = `http://${cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host}:${addr.port}`;
      const webhookUrl = `${selfUrl}/webhooks/hub`;
      ctx.http
        .request("POST", `${cfg.hubUrl}/v1/webhooks`, {
          url: webhookUrl,
          events: ["payment.received", "payment.refunded"],
          channelId: "*"
        })
        .then((res) => {
          if (res.statusCode === 201) {
            ctx.webhookSecret = res.body.secret;
            ctx.webhookId = res.body.webhookId;
            console.log(`[payee] registered webhook ${res.body.webhookId} with hub`);
          }
        })
        .catch(() => {
          /* hub may not be up yet — non-fatal */
        });
    });
    return s;
  };

  server.on("close", () => {
    ctx.http.close();
    if (ctx.verifyPayment && ctx.verifyPayment.close) ctx.verifyPayment.close();
  });
  return server;
}

if (require.main === module) {
  const server = createPayeeServer();
  server.listen(DEFAULTS.port, DEFAULTS.host, () => {
    console.log(
      `Payee server listening on ${DEFAULTS.host}:${DEFAULTS.port} (${PAYEE_ADDRESS})`
    );
  });
}

module.exports = {
  createPayeeServer,
  PAYEE_ADDRESS,
  RESOURCE_PATH
};
