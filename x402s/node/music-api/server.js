/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { createVerifier } = require("../scp-hub/ticket");
const { setDomainDefaults } = require("../scp-hub/state-signing");
const {
  resolveContract,
  resolveHubEndpointForNetwork,
  resolveNetwork
} = require("../scp-common/networks");

let WebSocketServer = null;
try {
  ({ WebSocketServer } = require("ws"));
} catch (_e) {
  WebSocketServer = null;
}

// ── Env ──────────────────────────────────────────────────────────────────────

const envPath = path.resolve(__dirname, "../../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// ── Config ───────────────────────────────────────────────────────────────────

const HOST = process.env.MUSIC_HOST || process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.MUSIC_PORT || process.env.PORT || 4095);
const NETWORK = process.env.NETWORK || "base";
const HUB_NAME = process.env.HUB_NAME || "pay.eth";
const HUB_ENDPOINT =
  process.env.HUB_ENDPOINT ||
  process.env.HUB_URL ||
  resolveHubEndpointForNetwork(NETWORK);
const PRICE_ETH = process.env.MUSIC_PRICE_ETH || "0.0000001";
const STREAM_T_SEC_RAW = Number(
  process.env.MUSIC_STREAM_T_SEC || process.env.STREAM_T_SEC || 5
);
const STREAM_T_SEC =
  Number.isInteger(STREAM_T_SEC_RAW) && STREAM_T_SEC_RAW > 0
    ? STREAM_T_SEC_RAW
    : 5;
const PUBLIC_BASE_URL =
  process.env.MUSIC_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "";
const ASSET_ETH = ethers.constants.AddressZero;

// ── TTL / limits ─────────────────────────────────────────────────────────────

const INVOICE_TTL_SEC = 300;
const CONSUMED_TTL_SEC = 1800;
const SESSION_IDLE_TTL_SEC = 3600;
const EVICTION_INTERVAL_MS = 60_000;
const WS_PING_INTERVAL_MS = 25_000;
const MAX_WS_PER_SESSION = 4;

// ── Validation ───────────────────────────────────────────────────────────────

const payeeKey = process.env.PAYEE_PRIVATE_KEY;
if (!payeeKey) {
  console.error(
    "FATAL: PAYEE_PRIVATE_KEY env var is required. Never use hardcoded keys."
  );
  process.exit(1);
}

let chainId;
if (NETWORK.startsWith("eip155:")) {
  chainId = Number(NETWORK.split(":")[1]);
} else {
  chainId = resolveNetwork(NETWORK).chainId;
}
if (!Number.isInteger(chainId) || chainId <= 0) {
  console.error(
    "FATAL: invalid NETWORK; expected base|sepolia|mainnet|eip155:<id>"
  );
  process.exit(1);
}
{
  let domainContract = ethers.constants.AddressZero;
  try {
    const resolved = resolveContract(chainId) || ethers.constants.AddressZero;
    domainContract = ethers.utils.getAddress(resolved);
  } catch (_e) {
    domainContract = ethers.constants.AddressZero;
  }
  setDomainDefaults(chainId, domainContract);
}

let amountWei;
try {
  amountWei = ethers.utils.parseUnits(PRICE_ETH, 18).toString();
} catch (_e) {
  console.error("FATAL: invalid MUSIC_PRICE_ETH value");
  process.exit(1);
}

const payeeWallet = new ethers.Wallet(payeeKey);
const PAYEE_ADDRESS = payeeWallet.address;

// ── Track catalog ────────────────────────────────────────────────────────────

const TRACKS = [
  {
    id: "neon-sky",
    title: "Neon Skyline",
    artist: "SCP Radio",
    durationSec: 180,
    accent: "#10b981",
    bpm: 120
  },
  {
    id: "city-pulse",
    title: "City Pulse",
    artist: "State Channels",
    durationSec: 210,
    accent: "#22d3ee",
    bpm: 128
  },
  {
    id: "after-hours",
    title: "After Hours",
    artist: "Hub Session",
    durationSec: 195,
    accent: "#f59e0b",
    bpm: 112
  }
];

// ── CORS ─────────────────────────────────────────────────────────────────────

const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const CORS_HEADERS = [
  "Content-Type",
  "Payment-Signature",
  "X-SCP-Access-Token"
].join(", ");

// ── Helpers ──────────────────────────────────────────────────────────────────

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", CORS_HEADERS);
  res.setHeader("Access-Control-Max-Age", "86400");
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

function sendHtml(res, code, html) {
  setCorsHeaders(res);
  res.writeHead(code, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    "Content-Length": Buffer.byteLength(html)
  });
  res.end(html);
}

function wantsHtml(req) {
  return String(req.headers.accept || "")
    .toLowerCase()
    .includes("text/html");
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function trackById(trackId) {
  return TRACKS.find((t) => t.id === trackId) || null;
}

function parseCursor(value, durationSec) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > durationSec) return durationSec;
  return Math.floor(n);
}

function getPaymentHeader(req) {
  return (
    req.headers["payment-signature"] ||
    req.headers["PAYMENT-SIGNATURE"] ||
    null
  );
}

function parseSessionId(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  return /^[a-zA-Z0-9_-]{6,120}$/.test(v) ? v : "";
}

// ── TtlMap — auto-expiring Map for invoices & consumed payments ──────────────

class TtlMap {
  constructor(defaultTtlSec, maxSize = 50_000) {
    this._map = new Map();
    this._defaultTtl = defaultTtlSec;
    this._maxSize = maxSize;
  }
  get size() {
    return this._map.size;
  }
  has(key) {
    const e = this._map.get(key);
    if (!e) return false;
    if (now() > e.exp) {
      this._map.delete(key);
      return false;
    }
    return true;
  }
  get(key) {
    const e = this._map.get(key);
    if (!e) return undefined;
    if (now() > e.exp) {
      this._map.delete(key);
      return undefined;
    }
    return e.v;
  }
  set(key, value, ttlSec) {
    if (this._map.size >= this._maxSize) this._evictBatch();
    this._map.set(key, { v: value, exp: now() + (ttlSec || this._defaultTtl) });
    return this;
  }
  delete(key) {
    return this._map.delete(key);
  }
  _evictBatch() {
    const t = now();
    let count = 0;
    for (const [k, e] of this._map) {
      if (t > e.exp) {
        this._map.delete(k);
        count++;
      }
      if (count >= 500) break;
    }
  }
  sweep() {
    const t = now();
    for (const [k, e] of this._map) {
      if (t > e.exp) this._map.delete(k);
    }
  }
  forEach(fn) {
    const t = now();
    for (const [k, e] of this._map) {
      if (t <= e.exp) fn(e.v, k, this);
    }
  }
}

// ── WebSocket helpers ────────────────────────────────────────────────────────

function emitSessionEvent(ctx, sessionId, payload) {
  if (!sessionId || !ctx?.wsBySession) return;
  const bucket = ctx.wsBySession.get(sessionId);
  if (!bucket?.size) return;
  const body = JSON.stringify(payload || {});
  for (const ws of Array.from(bucket)) {
    if (ws.readyState === 1) {
      try {
        ws.send(body);
      } catch (_e) {
        bucket.delete(ws);
      }
    } else {
      bucket.delete(ws);
    }
  }
  if (!bucket.size) ctx.wsBySession.delete(sessionId);
}

function sendWs(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload || {}));
  } catch (_e) {
    /* no-op */
  }
}

function getSessionState(ctx, sessionId) {
  if (!sessionId) return null;
  let state = ctx.sessions.get(sessionId);
  if (!state) {
    state = {
      approved: false,
      active: false,
      amount: amountWei,
      t: STREAM_T_SEC,
      approvedAt: 0,
      touchedAt: now()
    };
    ctx.sessions.set(sessionId, state);
  } else {
    state.touchedAt = now();
  }
  return state;
}

// ── URL resolution ───────────────────────────────────────────────────────────

function resolveResourceUrl(req, pathnameWithQuery) {
  if (PUBLIC_BASE_URL) {
    return `${PUBLIC_BASE_URL.replace(/\/+$/, "")}${pathnameWithQuery}`;
  }
  const protoRaw = req.headers["x-forwarded-proto"];
  const hostRaw = req.headers["x-forwarded-host"] || req.headers.host;
  const proto =
    typeof protoRaw === "string" && protoRaw.trim()
      ? protoRaw.split(",")[0].trim()
      : "http";
  const host =
    typeof hostRaw === "string" && hostRaw.trim()
      ? hostRaw.split(",")[0].trim()
      : `${HOST}:${PORT}`;
  return `${proto}://${host}${pathnameWithQuery}`;
}

// ── Offer builder ────────────────────────────────────────────────────────────

function buildOfferPayload(req, ctx, options = {}) {
  const track = options.track || TRACKS[0];
  const cursorSec = Number(options.cursorSec || 0);
  const routePathPrefix = String(
    options.routePathPrefix || "/v1/music/chunk"
  );
  const sessionId = parseSessionId(options.sessionId);
  const sessionPart = sessionId
    ? `&session=${encodeURIComponent(sessionId)}`
    : "";
  const routePath = `${routePathPrefix}?track=${encodeURIComponent(track.id)}&cursor=${cursorSec}${sessionPart}`;
  const invoiceId = randomId("inv");
  const quoteExpiry = now() + 120;

  ctx.invoices.set(invoiceId, {
    createdAt: now(),
    amount: amountWei,
    asset: ASSET_ETH,
    hubEndpoint: HUB_ENDPOINT,
    kind: "music_chunk",
    trackId: track.id,
    sessionId
  });

  return {
    message: `Payment required to stream ${track.title}`,
    pricing: [
      {
        network: `eip155:${chainId}`,
        asset: "ETH",
        human: PRICE_ETH,
        price: amountWei,
        decimals: 18
      }
    ],
    accepts: [
      {
        scheme: "statechannel-hub-v1",
        network: `eip155:${chainId}`,
        asset: ASSET_ETH,
        maxAmountRequired: amountWei,
        payTo: HUB_NAME,
        resource: resolveResourceUrl(req, routePath),
        extensions: {
          "statechannel-hub-v1": {
            hubName: HUB_NAME,
            hubEndpoint: HUB_ENDPOINT,
            mode: "proxy_hold",
            feeModel: { base: "0", bps: 0 },
            stream: { amount: amountWei, t: STREAM_T_SEC },
            quoteExpiry,
            invoiceId,
            payeeAddress: PAYEE_ADDRESS
          }
        }
      }
    ]
  };
}

// ── Frontend HTML ────────────────────────────────────────────────────────────

function buildAppHtml() {
  const catalogJson = JSON.stringify(TRACKS);
  const baseUrl = PUBLIC_BASE_URL
    ? PUBLIC_BASE_URL.replace(/\/+$/, "")
    : `http://${HOST}:${PORT}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SCP Music</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0c0a09;--bg2:#1c1917;--surface:#1c1917;--surface2:#292524;--surface3:#44403c;
  --border:#3f3a36;--border2:#57534e;
  --text:#fafaf9;--text2:#d6d3d1;--text3:#a8a29e;--text4:#78716c;
  --amber:#f59e0b;--amber2:#fbbf24;--amber-dim:#78350f;
  --green:#34d399;--green-dim:#064e3b;
  --red:#fb7185;--red-dim:#4c0519;--cyan:#22d3ee;
  --font:'Outfit',system-ui,sans-serif;--mono:'JetBrains Mono',monospace;
}
html{font-size:15px}
body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden;
  background-image:radial-gradient(ellipse 900px 500px at 10% 0%,#451a0311,transparent),radial-gradient(ellipse 600px 800px at 90% 100%,#42200611,transparent)}
::selection{background:#f59e0b44;color:var(--text)}
input[type=range]{-webkit-appearance:none;appearance:none;height:6px;border-radius:99px;background:var(--surface3);outline:none;cursor:pointer}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--amber);border:2px solid var(--bg);cursor:pointer;box-shadow:0 0 8px #f59e0b55}
input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:var(--amber);border:2px solid var(--bg);cursor:pointer}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border);border-radius:99px}
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:9999;opacity:.022;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-repeat:repeat;background-size:180px}
.shell{max-width:1200px;margin:0 auto;padding:20px 24px 40px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:24px;padding-bottom:18px;border-bottom:1px solid var(--border);animation:fadeUp .35s ease both}
.logo{display:flex;align-items:center;gap:10px}
.logo-text{font-size:1.45rem;font-weight:800;letter-spacing:-.03em;background:linear-gradient(135deg,var(--amber),var(--amber2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.logo-sub{font-size:.72rem;color:var(--text4);font-family:var(--mono);letter-spacing:.04em}
.tag{font-family:var(--mono);font-size:.7rem;padding:5px 10px;border:1px solid var(--border);border-radius:99px;color:var(--text3);white-space:nowrap}
.main{display:grid;grid-template-columns:320px 1fr;gap:20px}
@media(max-width:900px){.main{grid-template-columns:1fr}}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:16px;position:relative;overflow:hidden;animation:fadeUp .4s ease both}
.panel::before{content:'';position:absolute;inset:0;background:linear-gradient(180deg,#ffffff03,transparent 40%);pointer-events:none;border-radius:inherit}
.main>:nth-child(2){animation-delay:.1s}
.lbl{font-size:.65rem;font-family:var(--mono);color:var(--text4);text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px}
.search-wrap{position:relative;margin-bottom:12px}
.search{width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:10px;padding:9px 12px 9px 34px;font-family:var(--mono);font-size:.75rem;outline:none;transition:border-color .15s}
.search:focus{border-color:var(--amber)}
.search-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text4);pointer-events:none}
.tracklist{display:flex;flex-direction:column;gap:6px}
.tc{display:grid;grid-template-columns:36px 1fr auto;align-items:center;gap:10px;padding:8px 10px;border:1px solid transparent;border-radius:10px;cursor:pointer;transition:all .15s;background:var(--bg)}
.tc:hover{border-color:var(--border2);background:var(--surface2)}
.tc.on{border-color:var(--amber);background:var(--amber-dim)}
.tc.on .tnum{color:var(--amber)}
.tnum{font-family:var(--mono);font-size:.72rem;color:var(--text4);text-align:center;font-weight:500}
.ti .tt{font-size:.82rem;font-weight:600;line-height:1.25}
.ti .tm{font-size:.68rem;color:var(--text3);font-family:var(--mono);margin-top:1px}
.fav{background:none;border:none;cursor:pointer;color:var(--text4);font-size:1rem;padding:2px 4px;transition:color .15s}
.fav:hover,.fav.on{color:var(--amber)}
.ctrls{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
.cb{font-family:var(--mono);font-size:.68rem;font-weight:500;padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--text2);cursor:pointer;transition:all .15s;white-space:nowrap}
.cb:hover{border-color:var(--border2);background:var(--surface3)}
.cb.on{border-color:var(--amber);color:var(--amber);background:var(--amber-dim)}
.cb.pri{background:var(--amber);color:#000;border-color:var(--amber);font-weight:700}
.cb.pri:hover{background:var(--amber2)}
.cb.danger{border-color:var(--red-dim);color:var(--red);background:var(--red-dim)}
.queue{margin-top:10px;display:flex;flex-direction:column;gap:4px;max-height:160px;overflow:auto}
.qi{font-family:var(--mono);font-size:.68rem;color:var(--text3);padding:5px 8px;background:var(--bg);border-radius:6px;border:1px solid #292524}
.sess{font-family:var(--mono);font-size:.62rem;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text4);margin-top:8px;word-break:break-all}
.hero{display:flex;align-items:center;gap:20px;margin-bottom:16px}
@media(max-width:600px){.hero{flex-direction:column;text-align:center}}
.vw{position:relative;width:140px;height:140px;flex-shrink:0}
.vc{width:140px;height:140px;border-radius:50%}
.hi{flex:1;min-width:0}
.ht{font-size:1.5rem;font-weight:800;letter-spacing:-.02em;line-height:1.15}
.ha{font-size:.85rem;color:var(--text3);margin-top:4px}
.hb{display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:.65rem;padding:4px 10px;border-radius:99px;border:1px solid var(--border);color:var(--text3);margin-top:8px}
.hb .dot{width:7px;height:7px;border-radius:50%;background:var(--text4)}
.hb.live .dot{background:var(--green);box-shadow:0 0 6px var(--green);animation:pulseDot 1.5s ease infinite}
.hb.err .dot{background:var(--red);box-shadow:0 0 6px var(--red)}
.pw{margin-bottom:4px}
.pb{height:6px;background:var(--bg);border:1px solid var(--border);border-radius:99px;overflow:hidden}
.pf{height:100%;width:0%;background:linear-gradient(90deg,var(--amber),var(--amber2));border-radius:99px;transition:width .3s linear}
.pm{display:flex;justify-content:space-between;font-family:var(--mono);font-size:.65rem;color:var(--text4);margin-top:4px}
.mr{display:flex;align-items:center;gap:10px;margin-top:10px}
.ml{font-family:var(--mono);font-size:.65rem;color:var(--text4);min-width:46px}
.mt{flex:1;height:4px;background:var(--bg);border:1px solid var(--border);border-radius:99px;overflow:hidden}
.mf{height:100%;width:0%;background:linear-gradient(90deg,var(--green),var(--cyan),var(--amber));transition:width .06s linear;border-radius:99px}
.vr{display:flex;align-items:center;gap:8px;margin-top:8px}
.vr input[type=range]{flex:1}
.vv{font-family:var(--mono);font-size:.65rem;color:var(--text4);min-width:32px;text-align:right}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:14px}
@media(max-width:600px){.stats{grid-template-columns:repeat(2,1fr)}}
.st{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px}
.sk{font-size:.6rem;font-family:var(--mono);color:var(--text4);text-transform:uppercase;letter-spacing:.08em}
.sv{font-size:1rem;font-weight:700;font-family:var(--mono);margin-top:3px}
.lw{margin-top:14px;max-height:220px;overflow:auto}
.li{font-family:var(--mono);font-size:.66rem;padding:6px 8px;border-radius:6px;background:var(--bg);border:1px solid var(--border);margin-bottom:4px;color:var(--text3);line-height:1.35;word-break:break-all}
.li.err{border-color:#6d3348;color:var(--red);background:#1a0a10}
.li .ts{color:var(--text4);margin-right:6px}
.kh-row{display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;padding-top:8px;border-top:1px solid var(--border)}
.kh{font-family:var(--mono);font-size:.6rem;color:var(--text4);display:flex;align-items:center;gap:4px}
.kh kbd{background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 5px;font-size:.58rem;color:var(--text3)}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulseDot{0%,100%{opacity:1}50%{opacity:.4}}
</style>
</head>
<body>
<div class="shell">
  <header>
    <div class="logo">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><circle cx="14" cy="14" r="13" stroke="#f59e0b" stroke-width="2"/><circle cx="14" cy="14" r="4" fill="#f59e0b"/><path d="M14 1a13 13 0 0 1 0 26" stroke="#fbbf2466" stroke-width="1"/><circle cx="14" cy="14" r="8.5" stroke="#f59e0b33" stroke-width="1"/></svg>
      <div><div class="logo-text">SCP Music</div><div class="logo-sub">pay-per-second streaming</div></div>
    </div>
    <div class="tag">${baseUrl}/music/chunk</div>
  </header>
  <div class="main">
    <div class="panel">
      <div class="lbl">Library</div>
      <div class="search-wrap">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="search" class="search" placeholder="Search tracks\u2026" autocomplete="off"/>
      </div>
      <div id="tracks" class="tracklist"></div>
      <div class="ctrls" style="margin-top:14px">
        <button class="cb" id="bShuf">\u21C4 off</button>
        <button class="cb" id="bRep">\u21BB off</button>
        <button class="cb" id="bAuto">auto \u2713</button>
      </div>
      <div class="lbl" style="margin-top:14px">Up Next</div>
      <div id="queue" class="queue"></div>
      <div class="lbl" style="margin-top:12px">Session</div>
      <div class="sess" id="sessLbl"></div>
      <div class="ctrls" style="margin-top:12px">
        <button class="cb pri" id="bPlay">\u25B6 Start</button>
        <button class="cb" id="bNext">\u23ED Next</button>
        <button class="cb" id="bTest">\u266A Test</button>
        <button class="cb danger" id="bStop">\u25A0 Stop</button>
      </div>
      <div class="kh-row">
        <div class="kh"><kbd>Space</kbd> play/stop</div>
        <div class="kh"><kbd>\u2192</kbd> next</div>
        <div class="kh"><kbd>/</kbd> search</div>
        <div class="kh"><kbd>M</kbd> mute</div>
      </div>
    </div>
    <div class="panel">
      <div class="hero">
        <div class="vw"><canvas id="vinyl" class="vc" width="280" height="280"></canvas></div>
        <div class="hi">
          <div class="ht" id="nTitle">Select a track</div>
          <div class="ha" id="nArtist">Pick from the library and press Start</div>
          <div class="hb" id="badge"><span class="dot"></span><span id="status">idle</span></div>
        </div>
      </div>
      <div class="pw"><div class="pb"><div class="pf" id="fill"></div></div>
        <div class="pm"><span id="clock">0:00 / 0:00</span><span id="cadLbl">cadence ${STREAM_T_SEC}s</span></div>
      </div>
      <div class="mr"><span class="ml" id="aState">audio off</span><div class="mt"><div class="mf" id="aFill"></div></div></div>
      <div class="vr"><span class="ml">vol</span><input id="vol" type="range" min="0" max="100" value="85"/><span class="vv" id="vLbl">85%</span><button class="cb" id="bMute" style="padding:4px 8px">mute</button></div>
      <div class="stats">
        <div class="st"><div class="sk">Ticks</div><div class="sv" id="xTk">0</div></div>
        <div class="st"><div class="sk">Charged</div><div class="sv" id="xCh">0</div></div>
        <div class="st"><div class="sk">Failures</div><div class="sv" id="xFl">0</div></div>
        <div class="st"><div class="sk">Cursor</div><div class="sv" id="xCu">0s</div></div>
      </div>
      <div class="lbl" style="margin-top:14px">Event Log</div>
      <div id="log" class="lw"></div>
    </div>
  </div>
</div>
<script>
const TRACKS=${catalogJson},T_DEF=${STREAM_T_SEC},AMT_DEF="${amountWei}";
const $=id=>document.getElementById(id);
function rndId(){return'sess_'+Math.random().toString(36).slice(2,10)+Date.now().toString(36)}
function fmt(s){const m=Math.floor(s/60);return m+':'+(''+(s%60)).padStart(2,'0')}
function lp(k,fb){try{const r=localStorage.getItem(k);return r?JSON.parse(r):fb}catch(_){return fb}}
function sp(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(_){}}
const P=lp('scpV2',{vol:85,mut:false,fav:[],shuf:false,rep:'off'});
function pp(){sp('scpV2',{vol:S.vol,mut:S.mut,fav:S.fav,shuf:S.shuf,rep:S.rep})}

const S={
  sel:TRACKS[0]||null,con:false,cur:0,ns:0,pId:null,wId:null,lp:0,
  auto:true,q:'',shuf:!!P.shuf,rep:(P.rep==='one'||P.rep==='all')?P.rep:'off',
  mut:!!P.mut,vol:Math.max(0,Math.min(100,+(P.vol||85))),
  fav:Array.isArray(P.fav)?P.fav:[],cad:T_DEF,
  tk:0,ch:0,fl:0,sid:rndId(),appr:false,off:null,
  ws:null,wsOk:false,wsP:null,wsR:0,wsT:null
};

const A={ctx:null,mas:null,an:null,bId:null,pO:null,pG:null,mId:null,lv:0,da:null};
function bHz(t){const b=Math.min(170,Math.max(70,+(t&&t.bpm||120)));return 150+(b-70)*1.6}
function eA(){
  const C=window.AudioContext||window.webkitAudioContext;if(!C)return null;
  if(!A.ctx){A.ctx=new C();A.mas=A.ctx.createGain();A.mas.gain.value=.01;
    A.an=A.ctx.createAnalyser();A.an.fftSize=256;A.an.smoothingTimeConstant=.78;
    A.da=new Uint8Array(A.an.frequencyBinCount);
    A.mas.connect(A.an);A.an.connect(A.ctx.destination);sG()}
  if(A.ctx.state==='suspended')A.ctx.resume().catch(()=>{});return A.ctx;
}
function sG(){if(!A.mas||!A.ctx)return;const v=S.mut?0:(Math.max(0,Math.min(100,+S.vol||0))/100)*.35;A.mas.gain.setValueAtTime(v,A.ctx.currentTime)}
function pu(f,d,l){const c=eA();if(!c||!A.mas)return;const o=c.createOscillator(),g=c.createGain(),t=c.currentTime;o.type='triangle';o.frequency.setValueAtTime(f,t);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(l,t+.01);g.gain.exponentialRampToValueAtTime(.0001,t+d);o.connect(g);g.connect(A.mas);o.start(t);o.stop(t+d+.02);A.lv=Math.max(A.lv,Math.min(1,l*9))}
function stA(){if(A.bId){clearInterval(A.bId);A.bId=null}if(A.pO){try{A.pO.stop()}catch(_){}try{A.pO.disconnect()}catch(_){}A.pO=null}if(A.pG){try{A.pG.disconnect()}catch(_){}A.pG=null}if(A.mId){clearInterval(A.mId);A.mId=null}A.lv=0;sM(0,'off')}
function sM(l,s){const f=$('aFill'),t=$('aState');if(f)f.style.width=(Math.max(0,Math.min(1,+l||0))*100).toFixed(0)+'%';if(t&&s)t.textContent='audio '+s}
function smr(){if(A.mId)clearInterval(A.mId);A.mId=setInterval(()=>{A.lv*=.84;sM(A.lv,S.con?(A.lv>.07?'active':'quiet'):'off')},80)}
function goA(){const c=eA();if(!c||!S.con)return;stA();smr();const t=S.sel||TRACKS[0]||{bpm:120};const bpm=Math.max(60,Math.min(180,+(t.bpm||120)));const ms=Math.max(220,Math.floor(60000/bpm));const hz=bHz(t);let b=0;
  A.pO=c.createOscillator();A.pG=c.createGain();A.pO.type='sine';A.pO.frequency.setValueAtTime(hz*.45,c.currentTime);A.pG.gain.setValueAtTime(.016,c.currentTime);A.pO.connect(A.pG);A.pG.connect(A.mas);A.pO.start();
  A.bId=setInterval(()=>{if(!S.con)return;const s=(b%4)===0;pu(s?hz:hz*.72,s?.12:.08,s?.08:.045);b++},ms)}

let vA=0,vR=null;
function dV(){
  const cv=$('vinyl');if(!cv)return;const c=cv.getContext('2d');const W=cv.width,H=cv.height,cx=W/2,cy=H/2,R=W/2-4;c.clearRect(0,0,W,H);
  c.beginPath();c.arc(cx,cy,R,0,Math.PI*2);c.fillStyle='#1c1917';c.fill();c.strokeStyle='#3f3a36';c.lineWidth=2;c.stroke();
  const ac=S.sel&&S.sel.accent||'#f59e0b';
  for(let i=0;i<8;i++){const r=R*.35+i*(R*.55/8);c.beginPath();c.arc(cx,cy,r,0,Math.PI*2);c.strokeStyle=i%3===0?ac+'22':'#ffffff08';c.lineWidth=.8;c.stroke()}
  if(A.an&&A.da&&S.con){A.an.getByteFrequencyData(A.da);const bins=A.da.length,iR=R*.42,oR=R*.88;
    c.save();c.translate(cx,cy);c.rotate(vA);
    for(let i=0;i<bins;i++){const a=(i/bins)*Math.PI*2-Math.PI/2,v=A.da[i]/255,r1=iR,r2=iR+(oR-iR)*v;
      c.beginPath();c.moveTo(Math.cos(a)*r1,Math.sin(a)*r1);c.lineTo(Math.cos(a)*r2,Math.sin(a)*r2);
      c.strokeStyle=ac;c.globalAlpha=.15+v*.7;c.lineWidth=Math.max(1,(Math.PI*2*iR/bins)*.65);c.lineCap='round';c.stroke()}
    c.restore();c.globalAlpha=1}
  const gr=c.createRadialGradient(cx,cy,0,cx,cy,R*.18);gr.addColorStop(0,'#292524');gr.addColorStop(.7,'#1c1917');gr.addColorStop(1,'#0c0a09');
  c.beginPath();c.arc(cx,cy,R*.18,0,Math.PI*2);c.fillStyle=gr;c.fill();
  c.beginPath();c.arc(cx,cy,R*.05,0,Math.PI*2);c.fillStyle=ac;c.fill();
  if(S.sel){c.save();c.translate(cx,cy);c.font='600 '+(W*.065)+'px Outfit,sans-serif';c.fillStyle='#fafaf9';c.textAlign='center';c.textBaseline='middle';c.fillText(S.sel.title,0,-W*.07);c.font='400 '+(W*.045)+'px Outfit,sans-serif';c.fillStyle='#a8a29e';c.fillText(S.sel.artist,0,W*.01);c.restore()}
  if(S.con)vA+=.008;vR=requestAnimationFrame(dV)}

function setSt(v){$('status').textContent=v;const b=$('badge');b.className='hb'+(v==='connected'||v==='awaiting payment'?' live':'')+(v==='error'||v==='stopped'||v==='rejected'?' err':'')}
function sC(){const d=S.sel?S.sel.durationSec:0,n=Math.min(S.ns,d);$('clock').textContent=fmt(n)+' / '+fmt(d);$('fill').style.width=d?((n/d)*100).toFixed(2)+'%':'0%'}
function rS(){$('xTk').textContent=S.tk;$('xCh').textContent=S.ch;$('xFl').textContent=S.fl;$('xCu').textContent=S.cur+'s';$('cadLbl').textContent='cadence '+S.cad+'s'}
function lg(m,e){const d=$('log');if(!d)return;const r=document.createElement('div');r.className='li'+(e?' err':'');r.innerHTML='<span class="ts">'+new Date().toLocaleTimeString()+'</span>'+m;d.prepend(r);while(d.children.length>80)d.removeChild(d.lastChild)}

function filt(){const q=(S.q||'').trim().toLowerCase();if(!q)return TRACKS.slice();return TRACKS.filter(t=>(t.title||'').toLowerCase().includes(q)||(t.artist||'').toLowerCase().includes(q))}
function rT(){const l=filt(),b=$('tracks');b.innerHTML='';l.forEach((t,i)=>{const e=document.createElement('div');e.className='tc'+(S.sel&&S.sel.id===t.id?' on':'');e.innerHTML='<div class="tnum">'+(i+1)+'</div><div class="ti"><div class="tt">'+t.title+'</div><div class="tm">'+t.artist+' \\u00B7 '+fmt(t.durationSec)+' \\u00B7 '+t.bpm+' bpm</div></div><button class="fav'+(S.fav.includes(t.id)?' on':'')+'" data-id="'+t.id+'">'+(S.fav.includes(t.id)?'\\u2605':'\\u2606')+'</button>';e.onclick=()=>{if(!S.con)selT(t)};const f=e.querySelector('.fav');if(f)f.onclick=ev=>{ev.stopPropagation();const i=S.fav.indexOf(t.id);if(i>=0)S.fav.splice(i,1);else S.fav.push(t.id);pp();rT();rQ()};b.appendChild(e)});if(!l.length)b.innerHTML='<div class="qi">No matching tracks</div>'}
function rQ(){const l=filt(),b=$('queue');if(!b)return;if(l.length<=1){b.innerHTML='<div class="qi">No upcoming</div>';return}const ix=l.findIndex(t=>S.sel&&t.id===S.sel.id);const q=[];for(let i=1;i<=Math.min(5,l.length-1);i++){const n=ix>=0?(ix+i)%l.length:(i-1);q.push(l[n])}b.innerHTML=q.map((t,i)=>'<div class="qi">'+(i+1)+'. '+t.title+' \\u00B7 '+t.artist+'</div>').join('')}
function rC(){$('bShuf').textContent='\\u21C4 '+(S.shuf?'on':'off');$('bShuf').className='cb'+(S.shuf?' on':'');$('bRep').textContent='\\u21BB '+S.rep;$('bRep').className='cb'+(S.rep!=='off'?' on':'');$('bAuto').textContent='auto '+(S.auto?'\\u2713':'\\u2717');$('bAuto').className='cb'+(S.auto?' on':'');$('bMute').textContent=S.mut?'unmute':'mute';$('bMute').className='cb'+(S.mut?' on':'');$('vol').value=S.vol;$('vLbl').textContent=S.vol+'%'}
function selT(t){if(!t)return;S.sel=t;S.cur=0;S.ns=0;$('nTitle').textContent=t.title;$('nArtist').textContent=t.artist;sC();rT();rQ();rS();if(S.con)goA()}
function nxT(){const l=filt().length?filt():TRACKS.slice();if(!l.length)return null;if(S.rep==='one'&&S.sel)return S.sel;if(S.shuf&&l.length>1){let p=l[Math.floor(Math.random()*l.length)],g=0;while(S.sel&&p.id===S.sel.id&&g<8){p=l[Math.floor(Math.random()*l.length)];g++}selT(p);return p}const ix=l.findIndex(t=>S.sel&&t.id===S.sel.id);if(ix<0){selT(l[0]);return l[0]}if(ix>=l.length-1){if(S.rep==='all'){selT(l[0]);return l[0]}return null}const n=l[ix+1];selT(n);return n}

function wU(){const p=location.protocol==='https:'?'wss':'ws';return p+'://'+location.host+'/music/ws?session='+encodeURIComponent(S.sid)}
function wS(type,pl){if(!S.ws||S.ws.readyState!==1)return;try{S.ws.send(JSON.stringify({type,...(pl||{})}))}catch(_){}}
function schRe(){if(S.wsT)return;const d=Math.min(30000,1000*Math.pow(1.5,S.wsR));S.wsR++;lg('reconnecting in '+(d/1000).toFixed(1)+'s\\u2026');S.wsT=setTimeout(()=>{S.wsT=null;cWs().catch(()=>{})},d)}
function cWs(){
  if(S.wsOk&&S.ws&&S.ws.readyState===1)return Promise.resolve();
  if(S.wsP)return S.wsP;
  S.wsP=new Promise((res,rej)=>{let done=false;const ws=new WebSocket(wU());S.ws=ws;
    ws.onopen=()=>{S.wsOk=true;S.wsR=0;lg('ws connected');wS('offer.get',{track:S.sel?S.sel.id:'',cursor:S.cur});if(!done){done=true;res()}};
    ws.onmessage=ev=>{let m={};try{m=JSON.parse(String(ev.data||'{}'))}catch(_){return}hWs(m)};
    ws.onclose=()=>{S.wsOk=false;S.wsP=null;if(S.con){stopC('ws lost');schRe()}};
    ws.onerror=()=>{if(!done){done=true;rej(new Error('ws unavailable'))}}
  }).finally(()=>{S.wsP=null});return S.wsP}

function hWs(m){
  const t=String(m.type||'');
  if(t==='offer'||t==='scp.402'){S.off=m.offer||null;const e=(((S.off||{}).accepts||[])[0]||{}).extensions||{};const h=e['statechannel-hub-v1']||{};const s=h.stream||{};if(+s.t>0)S.cad=+s.t;rS();lg(t==='scp.402'?'402 \\u00B7 amt='+(s.amount||AMT_DEF):'offer \\u00B7 amt='+(s.amount||AMT_DEF));return}
  if(t==='scp.approved'){S.appr=true;S.lp=Date.now();const c=+m.t;if(Number.isInteger(c)&&c>0)S.cad=c;S.ch+=(+(m.amount||AMT_DEF)||0);S.tk++;const st=m.stream||{};const nc=+st.nextCursor;if(Number.isFinite(nc)&&nc>=0){S.cur=Math.floor(nc);S.ns=S.cur}rS();sC();setSt('connected');lg('tick \\u00B7 id='+(m.paymentId||'?')+' cur='+S.cur+'s');const hm=st.hasMore!==false;if(!hm||(S.sel&&S.cur>=S.sel.durationSec)){if(S.auto){const n=nxT();if(n){S.cur=0;S.ns=0;rS();sC();wS('control.start',{track:n.id,cursor:0});lg('done \\u2192 next');return}}wS('control.stop');stopC('track complete')}return}
  if(t==='scp.rejected'){S.appr=false;lg('rejected \\u00B7 '+(m.error||'?'),true);stopC('rejected');return}
  if(t==='stream.start'){if(!S.con)S.con=true;if(!S.pId)stPr();if(!S.wId)stWa();setSt('awaiting payment');goA();lg('stream started');return}
  if(t==='stream.stop'||t==='control.stop'){stopC('stopped');lg('stream stopped');return}
  if(t==='error'){lg(m.error||m.message||'ws error',true)}}

function stPr(){if(S.pId)clearInterval(S.pId);S.pId=setInterval(()=>{if(S.con){S.ns++;sC()}},1000)}
function stWa(){if(S.wId)clearInterval(S.wId);S.wId=setInterval(()=>{if(!S.con||!S.lp)return;const g=Math.max(7000,S.cad*2000+1500);if(Date.now()-S.lp<=g)return;S.fl++;rS();lg('payment timeout',true);wS('control.stop');stopC('payment timeout')},1000)}
function stopC(r){S.con=false;if(S.pId){clearInterval(S.pId);S.pId=null}if(S.wId){clearInterval(S.wId);S.wId=null}stA();setSt(r||'stopped')}
async function go(){if(!S.sel){lg('select a track',true);return}S.con=true;S.appr=false;S.cur=0;S.ns=0;S.tk=0;S.fl=0;S.ch=0;S.lp=0;rS();sC();setSt('starting');eA();try{await cWs()}catch(e){lg(e.message,true);setSt('ws required');return}wS('offer.get',{track:S.sel.id,cursor:0});wS('control.start',{track:S.sel.id,cursor:0})}

$('bPlay').onclick=()=>go();
$('bStop').onclick=()=>{wS('control.stop');stopC('stopped');lg('stopped by user')};
$('bNext').onclick=()=>{const n=nxT();lg('next \\u2192 '+(n?n.title:'none'));if(S.con&&n){S.cur=0;S.ns=0;rS();sC();wS('control.start',{track:n.id,cursor:0})}};
$('bTest').onclick=()=>{eA();pu(bHz(S.sel||TRACKS[0]),.18,.09);lg('test tone')};
$('bShuf').onclick=()=>{S.shuf=!S.shuf;pp();rC();rQ()};
$('bRep').onclick=()=>{S.rep=S.rep==='off'?'all':S.rep==='all'?'one':'off';pp();rC()};
$('bAuto').onclick=()=>{S.auto=!S.auto;rC()};
$('bMute').onclick=()=>{S.mut=!S.mut;sG();pp();rC()};
$('vol').oninput=e=>{S.vol=Math.max(0,Math.min(100,+(e.target.value)));sG();pp();rC()};
$('search').oninput=e=>{S.q=(e.target.value||'').trim();rT();rQ()};
window.addEventListener('keydown',e=>{const tg=(document.activeElement&&document.activeElement.tagName||'').toLowerCase();if(tg==='input'||tg==='textarea')return;if(e.key===' '){e.preventDefault();S.con?$('bStop').click():go()}else if(e.key==='ArrowRight'){e.preventDefault();$('bNext').click()}else if(e.key==='/'||e.key==='f'){e.preventDefault();$('search').focus()}else if(e.key==='m'||e.key==='M'){e.preventDefault();$('bMute').click()}});
window.addEventListener('beforeunload',()=>{try{S.ws&&S.ws.close()}catch(_){}});
window.addEventListener('pointerdown',()=>eA(),{once:true});
if(S.sel)selT(S.sel);$('sessLbl').textContent=S.sid;rT();rQ();rC();rS();sC();dV();cWs().catch(()=>setSt('ws offline'));
</script>
</body>
</html>`;
}

// ── Request handlers ─────────────────────────────────────────────────────────

async function handleMusicChunkRequest(req, res, ctx, u, offerPathPrefix) {
  const trackId = String(u.searchParams.get("track") || "").trim();
  const track = trackById(trackId) || (!trackId ? TRACKS[0] : null);
  if (!track) {
    return sendJson(res, 400, {
      error: "track query is required",
      available: TRACKS.map((t) => t.id)
    });
  }

  const cursorSec = parseCursor(u.searchParams.get("cursor"), track.durationSec);
  const sessionId = parseSessionId(u.searchParams.get("session"));
  const session = getSessionState(ctx, sessionId);
  const paymentHeader = getPaymentHeader(req);

  if (!paymentHeader) {
    const offer = buildOfferPayload(req, ctx, {
      track, cursorSec, routePathPrefix: offerPathPrefix, sessionId
    });
    emitSessionEvent(ctx, sessionId, { type: "offer", sessionId, offer, at: now() });
    emitSessionEvent(ctx, sessionId, { type: "scp.402", code: 402, sessionId, offer, at: now() });
    return sendJson(res, 402, offer);
  }

  const check = await ctx.verifyPayment(paymentHeader, (invoiceId, paymentProof) => {
    const inv = ctx.invoices.get(invoiceId);
    if (!inv) return false;
    if (inv.kind !== "music_chunk") return false;
    if (inv.trackId && inv.trackId !== track.id) return false;
    if (inv.sessionId && sessionId && inv.sessionId !== sessionId) return false;
    if (inv.amount && String(paymentProof?.amount || "") !== String(inv.amount)) return false;
    if (inv.asset && String(paymentProof?.asset || "").toLowerCase() !== String(inv.asset).toLowerCase()) return false;
    return true;
  });

  if (check.replayed) {
    const rr = check.response || {};
    emitSessionEvent(ctx, sessionId, {
      type: "scp.approved", sessionId, paymentId: check.paymentId || "",
      amount: amountWei, t: STREAM_T_SEC,
      stream: rr.stream || null, track: rr.track || null,
      chunk: rr.chunk || null, receipt: rr.receipt || null,
      replayed: true, at: now()
    });
    return sendJson(res, 200, check.response);
  }
  if (!check.ok) {
    console.warn(`[music] rejected track=${track.id} session=${sessionId || "-"} err=${check.error || "unknown"}`);
    emitSessionEvent(ctx, sessionId, { type: "scp.rejected", sessionId, error: check.error, at: now() });
    return sendJson(res, 402, { error: check.error, retryable: false });
  }

  const startSec = cursorSec;
  const endSec = Math.min(track.durationSec, startSec + STREAM_T_SEC);
  const hasMore = endSec < track.durationSec;

  const response = {
    ok: true,
    connection: { mode: "stream", cadenceSec: STREAM_T_SEC, amountWei, hub: HUB_NAME, sessionId: sessionId || null },
    track: { id: track.id, title: track.title, artist: track.artist, durationSec: track.durationSec, bpm: track.bpm, accent: track.accent },
    chunk: { startSec, endSec, lengthSec: Math.max(0, endSec - startSec), text: `Unlocked ${startSec}s\u2013${endSec}s` },
    stream: { amount: amountWei, t: STREAM_T_SEC, nextCursor: endSec, hasMore },
    receipt: { paymentId: check.paymentId, receiptId: randomId("rcpt"), acceptedAt: now() }
  };

  ctx.invoices.delete(check.ticket?.invoiceId || "");
  ctx.consumed.set(check.paymentId, response);
  if (session) {
    session.approved = true;
    session.approvedAt = now();
    session.amount = amountWei;
    session.t = STREAM_T_SEC;
    session.active = true;
  }
  emitSessionEvent(ctx, sessionId, {
    type: "scp.approved", sessionId, paymentId: check.paymentId || "",
    amount: amountWei, t: STREAM_T_SEC,
    stream: response.stream, track: response.track,
    chunk: response.chunk, receipt: response.receipt, at: now()
  });
  return sendJson(res, 200, response);
}

async function handle(req, res, ctx) {
  const u = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && u.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true, payee: PAYEE_ADDRESS, network: `eip155:${chainId}`,
      musicPriceEth: PRICE_ETH, musicPriceWei: amountWei, streamT: STREAM_T_SEC,
      tracks: TRACKS.length,
      websocket: { enabled: !!WebSocketServer, sessions: ctx.sessions.size },
      maps: { invoices: ctx.invoices.size, consumed: ctx.consumed.size, sessions: ctx.sessions.size }
    });
  }

  if (req.method === "GET" && (u.pathname === "/v1/music/catalog" || u.pathname === "/music/catalog")) {
    return sendJson(res, 200, { ok: true, tracks: TRACKS });
  }

  if (req.method === "GET" && (u.pathname === "/app" || (u.pathname === "/music" && wantsHtml(req)))) {
    return sendHtml(res, 200, buildAppHtml());
  }

  if (req.method === "GET" && u.pathname === "/pay") {
    const track = trackById(String(u.searchParams.get("track") || "").trim()) || TRACKS[0];
    const cursorSec = parseCursor(u.searchParams.get("cursor"), track.durationSec);
    const sessionId = parseSessionId(u.searchParams.get("session"));
    return sendJson(res, 200, buildOfferPayload(req, ctx, { track, cursorSec, sessionId }));
  }

  if (req.method === "GET" && u.pathname === "/music") return handleMusicChunkRequest(req, res, ctx, u, "/music");
  if (req.method === "GET" && u.pathname === "/music/chunk") return handleMusicChunkRequest(req, res, ctx, u, "/music/chunk");
  if (req.method === "GET" && u.pathname === "/v1/music/chunk") return handleMusicChunkRequest(req, res, ctx, u, "/v1/music/chunk");

  return sendJson(res, 404, {
    error: "not found",
    routes: ["/app", "/music", "/health", "/v1/music/catalog", "/music/catalog", "/v1/music/chunk", "/music/chunk", "/pay", "/music/ws"]
  });
}

// ── Server factory ───────────────────────────────────────────────────────────

function createMusicServer() {
  const ctx = {
    invoices: new TtlMap(INVOICE_TTL_SEC, 20_000),
    consumed: new TtlMap(CONSUMED_TTL_SEC, 50_000),
    directChannels: new Map(),
    sessions: new Map(),
    wsBySession: new Map()
  };

  const evictionTimer = setInterval(() => {
    ctx.invoices.sweep();
    ctx.consumed.sweep();
    const t = now();
    for (const [sid, state] of ctx.sessions) {
      const bucket = ctx.wsBySession.get(sid);
      const hasWs = bucket && bucket.size > 0;
      if (!hasWs && t - (state.touchedAt || 0) > SESSION_IDLE_TTL_SEC) {
        ctx.sessions.delete(sid);
        ctx.wsBySession.delete(sid);
      }
    }
  }, EVICTION_INTERVAL_MS);

  ctx.verifyPayment = createVerifier({
    payee: PAYEE_ADDRESS,
    hubs: [HUB_ENDPOINT],
    confirmHub: true,
    seenPayments: ctx.consumed,
    directChannels: ctx.directChannels
  });

  const server = http.createServer((req, res) => {
    handle(req, res, ctx).catch((err) => {
      sendJson(res, 500, { error: err.message || "internal error" });
    });
  });

  let pingTimer = null;

  if (WebSocketServer) {
    const wss = new WebSocketServer({ noServer: true });
    ctx.wss = wss;

    wss.on("connection", (ws, _req, meta = {}) => {
      const sessionId = parseSessionId(meta.sessionId);
      if (!sessionId) { try { ws.close(); } catch (_e) {} return; }

      getSessionState(ctx, sessionId);
      let bucket = ctx.wsBySession.get(sessionId);
      if (!bucket) { bucket = new Set(); ctx.wsBySession.set(sessionId, bucket); }

      if (bucket.size >= MAX_WS_PER_SESSION) {
        sendWs(ws, { type: "error", error: `max ${MAX_WS_PER_SESSION} connections per session` });
        try { ws.close(); } catch (_e) {} return;
      }
      bucket.add(ws);

      ws._alive = true;
      ws.on("pong", () => { ws._alive = true; });

      sendWs(ws, { type: "ws.connected", sessionId, amount: amountWei, t: STREAM_T_SEC, at: now() });

      ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw || "{}")); } catch (_e) { sendWs(ws, { type: "error", error: "invalid json" }); return; }
        const type = String(msg.type || "");
        const session = getSessionState(ctx, sessionId);

        if (type === "offer.get") {
          const track = trackById(String(msg.track || "").trim()) || TRACKS[0];
          const cursorSec = parseCursor(msg.cursor, track.durationSec);
          const fakeReq = { headers: { "x-forwarded-proto": "http", host: `${HOST}:${PORT}` } };
          const offer = buildOfferPayload(fakeReq, ctx, { track, cursorSec, routePathPrefix: "/music/chunk", sessionId });
          sendWs(ws, { type: "offer", sessionId, offer, at: now() });
          sendWs(ws, { type: "scp.402", code: 402, sessionId, offer, at: now() });
          return;
        }
        if (type === "scp.approve") {
          const amount = String(msg.amount || "").trim();
          const t = Number(msg.t);
          if (amount !== String(amountWei) || !Number.isInteger(t) || t !== STREAM_T_SEC) {
            sendWs(ws, { type: "scp.rejected", sessionId, error: `mismatch: amount=${amountWei}, t=${STREAM_T_SEC}`, at: now() });
            return;
          }
          session.approved = true; session.active = false; session.amount = amountWei;
          session.t = STREAM_T_SEC; session.approvedAt = now();
          emitSessionEvent(ctx, sessionId, { type: "scp.approved", sessionId, amount: amountWei, t: STREAM_T_SEC, at: session.approvedAt });
          return;
        }
        if (type === "control.start") {
          session.active = true;
          const track = trackById(String(msg.track || "").trim()) || TRACKS[0];
          const cursorSec = parseCursor(msg.cursor, track.durationSec);
          const fakeReq = { headers: { "x-forwarded-proto": "http", host: `${HOST}:${PORT}` } };
          const offer = buildOfferPayload(fakeReq, ctx, { track, cursorSec, routePathPrefix: "/music/chunk", sessionId });
          emitSessionEvent(ctx, sessionId, { type: "scp.402", code: 402, sessionId, offer, at: now() });
          emitSessionEvent(ctx, sessionId, { type: "stream.start", sessionId, amount: session.amount, t: session.t, at: now() });
          return;
        }
        if (type === "control.stop") {
          session.active = false;
          emitSessionEvent(ctx, sessionId, { type: "stream.stop", sessionId, at: now() });
          return;
        }
        if (type === "ping") { sendWs(ws, { type: "pong", at: now() }); }
      });

      ws.on("close", () => {
        const cur = ctx.wsBySession.get(sessionId);
        if (!cur) return;
        cur.delete(ws);
        if (!cur.size) ctx.wsBySession.delete(sessionId);
      });
    });

    pingTimer = setInterval(() => {
      if (!wss.clients) return;
      for (const ws of wss.clients) {
        if (ws._alive === false) { try { ws.terminate(); } catch (_e) {} continue; }
        ws._alive = false;
        try { ws.ping(); } catch (_e) {}
      }
    }, WS_PING_INTERVAL_MS);

    server.on("upgrade", (req, socket, head) => {
      let u;
      try { u = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`); } catch (_e) { socket.destroy(); return; }
      if (!(u.pathname === "/music/ws" || u.pathname === "/ws")) { socket.destroy(); return; }
      const sessionId = parseSessionId(u.searchParams.get("session"));
      if (!sessionId) { socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => { wss.emit("connection", ws, req, { sessionId }); });
    });
  }

  server.on("close", () => {
    clearInterval(evictionTimer);
    if (pingTimer) clearInterval(pingTimer);
    if (ctx.verifyPayment?.close) ctx.verifyPayment.close();
    if (ctx.wss) ctx.wss.close();
  });

  return server;
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const server = createMusicServer();
  server.listen(PORT, HOST, () => {
    console.log(`Music API on ${HOST}:${PORT} (payee: ${PAYEE_ADDRESS})`);
    console.log(`  app:     http://${HOST}:${PORT}/music`);
    console.log(`  catalog: http://${HOST}:${PORT}/music/catalog`);
    console.log(`  stream:  ${amountWei} wei / ${STREAM_T_SEC}s`);
  });
}

module.exports = { createMusicServer, PAYEE_ADDRESS, TRACKS, STREAM_T_SEC };
