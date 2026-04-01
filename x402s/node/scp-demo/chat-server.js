/* eslint-disable no-console */
/**
 * SCP Chat API — pay 0.01 USDC or 0.00001 ETH per message
 * Usage: PAYEE_PRIVATE_KEY=0x... [CHAT_NETWORK=base|sepolia] node chat-server.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { createVerifier } = require("../scp-hub/ticket");
const { resolveHubEndpointForNetwork, toCaip2, resolveAsset, resolveContract } = require("../scp-common/networks");

const CHAT_NETWORK = process.env.CHAT_NETWORK || "base";
const NETWORK = toCaip2(CHAT_NETWORK) || "eip155:8453";
const CHAIN_ID = Number(NETWORK.split(":")[1]);
const EXTRA_NETWORKS = (process.env.CHAT_EXTRA_NETWORKS || "sepolia").split(",").map(s => s.trim()).filter(Boolean);
const PORT = Number(process.env.CHAT_PORT || 4044);
const HUB_URL = process.env.HUB_URL || resolveHubEndpointForNetwork(NETWORK);
const PAYEE_KEY = process.env.PAYEE_PRIVATE_KEY;
if (!PAYEE_KEY) { console.error("FATAL: PAYEE_PRIVATE_KEY required"); process.exit(1); }
const payeeWallet = new ethers.Wallet(PAYEE_KEY);
const PAYEE_ADDR = payeeWallet.address;

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const CONTRACT_ADDR = process.env.CONTRACT_ADDRESS || resolveContract(CHAIN_ID);
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const PUBLIC_HUB = process.env.PUBLIC_HUB || HUB_URL;
const SCP_PAY_AUTO_CONFIRM = process.env.SCP_PAY_AUTO_CONFIRM !== "0";

// --- Offer config: OFFERS_FILE > env > defaults ---
function loadOfferConfig() {
  const offersFile = process.env.OFFERS_FILE;
  if (offersFile) {
    const fp = path.isAbsolute(offersFile) ? offersFile : path.resolve(__dirname, "../../", offersFile);
    const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
    const block = (parsed.offers || []).find(o => {
      const nets = [].concat(o.network || []);
      return nets.some(n => n === CHAT_NETWORK || toCaip2(n) === NETWORK);
    });
    const pp = (parsed.pathPrices || {})["/chat"] || {};
    const assets = [].concat(block?.asset || []);
    const amounts = [].concat(block?.maxAmountRequired || []);
    const stream = block?.stream || { t: 1 };
    const hub = block?.hubEndpoint || PUBLIC_HUB;
    const hubName = block?.hubName || "pay.eth";

    // Resolve asset symbols to addresses + raw amounts
    const offers = [];
    for (let i = 0; i < assets.length; i++) {
      const sym = assets[i].toLowerCase();
      const human = pp[sym] || amounts[i] || "0";
      let addr, rawAmount, label;
      if (sym === "eth" || sym === "ether") {
        addr = ZERO_ADDR;
        rawAmount = ethers.utils.parseEther(human).toString();
        label = "ETH";
      } else {
        try {
          const resolved = resolveAsset(CHAIN_ID, sym);
          addr = resolved.address;
          rawAmount = ethers.utils.parseUnits(human, resolved.decimals).toString();
          label = sym.toUpperCase();
        } catch (_e) {
          console.warn("[chat] skipping unknown asset:", sym);
          continue;
        }
      }
      offers.push({ addr, rawAmount, label, stream, hub, hubName });
    }
    if (offers.length) return offers;
  }
  // Fallback: hardcoded defaults
  let usdcAddr;
  try { usdcAddr = resolveAsset(CHAIN_ID, "usdc").address; }
  catch (_e) { usdcAddr = "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913"; }
  return [
    { addr: ZERO_ADDR, rawAmount: "10000000000000", label: "ETH", stream: { t: 1 }, hub: PUBLIC_HUB, hubName: "pay.eth" },
    { addr: usdcAddr, rawAmount: "10000", label: "USDC", stream: { t: 1 }, hub: PUBLIC_HUB, hubName: "pay.eth" }
  ];
}

const OFFER_ASSETS = loadOfferConfig();
const PRICE_LABEL = OFFER_ASSETS.map(o => {
  const dec = o.addr === ZERO_ADDR ? 18 : 6;
  return ethers.utils.formatUnits(o.rawAmount, dec) + " " + o.label;
}).join(" or ");

// Chat state
const messages = [];
const MAX_MESSAGES = 200;

// Invoice store
const invoices = new Map();
const INVOICE_TTL = 300_000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of invoices) if (now - v.ts > INVOICE_TTL) invoices.delete(k);
}, 60_000);

function randomId(pfx = "inv") {
  return pfx + "_" + crypto.randomBytes(12).toString("base64url");
}

function makeOffers(path, req) {
  const invId = randomId("inv");
  invoices.set(invId, { ts: Date.now(), path, assets: OFFER_ASSETS });

  // Use public URL from env or reconstruct from request headers
  let base = PUBLIC_URL;
  if (!base && req) {
    const proto = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers["x-forwarded-host"] || req.headers["host"] || `127.0.0.1:${PORT}`;
    const prefix = req.headers["x-forwarded-prefix"] || "";
    base = `${proto}://${host}${prefix}`;
  }
  if (!base) base = `http://127.0.0.1:${PORT}`;
  const resource = `${base}${path}`;

  // Build offers for primary network
  const accepts = OFFER_ASSETS.map(o => ({
    scheme: "statechannel-hub-v1",
    network: NETWORK,
    asset: o.addr,
    maxAmountRequired: o.rawAmount,
    label: o.label,
    resource,
    extensions: {
      "statechannel-hub-v1": {
        hubName: o.hubName,
        hubEndpoint: o.hub,
        payeeAddress: PAYEE_ADDR,
        invoiceId: invId,
        stream: { amount: o.rawAmount, ...o.stream }
      }
    }
  }));
  // Add extra network offers (e.g. Sepolia testnet)
  const pubBase = (process.env.PUBLIC_HUB_BASE_URL || "https://pogchamp.tv").replace(/\/+$/, "");
  for (const net of EXTRA_NETWORKS) {
    const caip = toCaip2(net);
    if (!caip || caip === NETWORK) continue;
    const hubEp = resolveHubEndpointForNetwork(caip, { baseUrl: pubBase });
    accepts.push({
      scheme: "statechannel-hub-v1",
      network: caip,
      asset: ZERO_ADDR,
      maxAmountRequired: "100000000000",
      label: "ETH",
      resource,
      extensions: {
        "statechannel-hub-v1": {
          hubName: "pay.eth",
          hubEndpoint: hubEp,
          payeeAddress: PAYEE_ADDR,
          invoiceId: invId,
          stream: { amount: "100000000000", t: 1 }
        }
      }
    });
  }
  return {
    error: "payment required",
    message: `Send a chat message (${PRICE_LABEL} on ${CHAT_NETWORK})`,
    accepts
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Payment-Signature, X-SCP-Access-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function getPaymentHeader(req) {
  return req.headers["payment-signature"] || req.headers["x-scp-signature"] || null;
}

// Setup verifier
const consumed = new Map();
const payAcks = new Map();
const verify = createVerifier({
  payee: PAYEE_ADDR,
  hubUrl: HUB_URL,
  hubs: [HUB_URL],
  confirmHub: true,
  seenPayments: consumed,
  chainId: CHAIN_ID,
  contractAddress: CONTRACT_ADDR
});
const verifyPay = createVerifier({
  payee: PAYEE_ADDR,
  hubUrl: HUB_URL,
  hubs: [HUB_URL],
  confirmHub: true,
  seenPayments: payAcks,
  chainId: CHAIN_ID,
  contractAddress: CONTRACT_ADDR
});

// --- Chat HTML UI ---
function serveChatHTML(req, res) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers["host"] || `127.0.0.1:${PORT}`;
  const prefix = req.headers["x-forwarded-prefix"] || "";
  const base = `${proto}://${host}${prefix}`;
  const scpPayBase = process.env.SCP_PAY_URL || "https://statechannel.org/scppay/";
  const chatEndpoint = `${base}/chat`;
  const priceInfo = PRICE_LABEL;
  const networkLabel = CHAT_NETWORK.charAt(0).toUpperCase() + CHAT_NETWORK.slice(1);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>SCP Chat &mdash; Pay to Speak</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap');

*{margin:0;padding:0;box-sizing:border-box}

:root{
  --bg:#0a0a08;--bg2:#12120e;--bg3:#1a1a14;
  --amber:#ffb627;--amber-dim:#c88a1a;--amber-glow:#ffcc5522;
  --green:#39ff14;--green-dim:#2ab80e;
  --red:#ff3333;--red-dim:#cc2222;
  --t1:#ffe8a0;--t2:#c8a860;--t3:#887744;
  --mono:'JetBrains Mono','Courier New',monospace;
  --display:'Space Mono','JetBrains Mono',monospace;
  --radius:3px;
}

html,body{height:100%;background:var(--bg);color:var(--t1);font-family:var(--mono);font-size:13px;overflow:hidden}

/* CRT effect */

/* Layout */
.shell{display:flex;flex-direction:column;height:100vh;max-width:720px;margin:0 auto;padding:12px 16px}

/* Header */
.hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--t3);margin-bottom:8px;flex-shrink:0}
.hdr-l{display:flex;align-items:center;gap:10px}
.logo{font-family:var(--display);font-size:15px;font-weight:700;color:var(--amber);letter-spacing:1px;text-shadow:0 0 12px var(--amber-glow)}
.dot{width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.net-badge{font-size:9px;font-weight:600;padding:2px 7px;border-radius:10px;border:1px solid var(--t3);color:var(--t2);text-transform:uppercase;letter-spacing:1.5px}
.price-tag{font-size:10px;color:var(--t3);font-family:var(--mono)}
.price-tag b{color:var(--amber)}

/* Messages */
.msgs{flex:1;overflow-y:auto;padding:8px 0;display:flex;flex-direction:column;gap:2px;scroll-behavior:smooth}
.msgs::-webkit-scrollbar{width:4px}
.msgs::-webkit-scrollbar-track{background:var(--bg)}
.msgs::-webkit-scrollbar-thumb{background:var(--t3);border-radius:2px}
.msg{padding:4px 0;animation:fadeIn .3s ease;font-size:12px;line-height:1.6;word-wrap:break-word}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.msg-addr{color:var(--amber);font-weight:600;cursor:default}
.msg-time{color:var(--t3);font-size:10px;margin-left:4px}
.msg-txt{color:var(--t1)}
.msg-sys{color:var(--t3);font-style:italic;padding:6px 0;font-size:11px}

/* Empty state */
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:12px;opacity:.5}
.empty-coin{font-size:48px;animation:bob 3s ease-in-out infinite}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
.empty-txt{font-size:11px;color:var(--t3);text-align:center;max-width:280px;line-height:1.6}

/* Input area */
.input-area{flex-shrink:0;border-top:1px solid var(--t3);padding:10px 0 4px}
.input-row{display:flex;gap:8px;align-items:flex-end}
.input-wrap{flex:1;position:relative}
.input-wrap textarea{width:100%;background:var(--bg2);border:1px solid var(--t3);border-radius:var(--radius);color:var(--t1);font-family:var(--mono);font-size:12px;padding:10px 12px;resize:none;outline:none;transition:border-color .2s;min-height:40px;max-height:120px}
.input-wrap textarea:focus{border-color:var(--amber)}
.input-wrap textarea::placeholder{color:var(--t3)}
.char-count{position:absolute;right:8px;bottom:4px;font-size:9px;color:var(--t3)}

/* Send button */
.btn-send{background:var(--bg3);border:1px solid var(--amber-dim);border-radius:var(--radius);color:var(--amber);font-family:var(--mono);font-size:11px;font-weight:600;padding:10px 16px;cursor:pointer;transition:all .15s;white-space:nowrap;display:flex;align-items:center;gap:6px;letter-spacing:.5px}
.btn-send:hover:not(:disabled){background:var(--amber);color:var(--bg);box-shadow:0 0 16px var(--amber-glow)}
.btn-send:disabled{opacity:.4;cursor:not-allowed}
.btn-send:active:not(:disabled){transform:scale(.97)}
.coin-ico{font-size:14px}

/* Payment overlay */
.pay-overlay{position:fixed;inset:0;background:rgba(0,0,0,.121095);z-index:1000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);opacity:0;pointer-events:none;transition:opacity .2s}
.pay-overlay.show{opacity:1;pointer-events:auto}
.pay-frame{width:min(420px,94vw);height:min(620px,88vh);border:none;border-radius:8px;box-shadow:0 0 12px rgba(0,0,0,.5);}
.pay-overlay:not(.show) .pay-frame{position:fixed;left:-9999px}

/* Status bar */
.status{display:flex;align-items:center;justify-content:space-between;padding:4px 0;font-size:9px;color:var(--t3);letter-spacing:.5px}
.status-l{display:flex;align-items:center;gap:8px}
.online-count{color:var(--green-dim)}
.total-paid{color:var(--amber-dim)}

/* Coin drop animation */
.coin-drop{position:fixed;z-index:2000;font-size:28px;pointer-events:none;animation:coinFall .8s cubic-bezier(.2,.8,.3,1) forwards}
@keyframes coinFall{
  0%{opacity:1;transform:translateY(-40px) rotate(0deg) scale(1.2)}
  60%{opacity:1;transform:translateY(20px) rotate(360deg) scale(1)}
  100%{opacity:0;transform:translateY(60px) rotate(540deg) scale(.6)}
}

/* Toast */
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);padding:8px 16px;border-radius:var(--radius);font-size:11px;font-family:var(--mono);z-index:3000;animation:toastIn .3s ease}
.toast.ok{background:var(--green-dim);color:#000}
.toast.err{background:var(--red-dim);color:#fff}
@keyframes toastIn{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}

/* Mobile */
@media(max-width:520px){
  .shell{padding:8px 10px}
  .hdr{flex-wrap:wrap;gap:6px}
  .btn-send{padding:10px 12px}
}
</style>
</head>
<body>
<div class="shell">
  <div class="hdr">
    <div class="hdr-l">
      <span class="logo">SCP CHAT</span>
      <span class="dot"></span>
      <span class="net-badge">${networkLabel}</span>
    </div>
    <div class="price-tag"><b>${priceInfo}</b> / msg</div>
  </div>

  <div class="msgs" id="msgs">
    <div class="empty" id="emptyState">
      <div class="empty-coin">\u{1FA99}</div>
      <div class="empty-txt">Insert coin to speak.<br>Every message is paid, permanent, and signed.</div>
    </div>
  </div>

  <div class="status">
    <div class="status-l">
      <span class="online-count" id="onlineCount">-- msgs</span>
      <span>&middot;</span>
      <span class="total-paid" id="totalPaid">0 paid</span>
    </div>
    <span>x402s protocol</span>
  </div>

  <div class="input-area">
    <div class="input-row">
      <div class="input-wrap">
        <textarea id="msgInput" rows="1" maxlength="500" placeholder="Type a message... (costs ${priceInfo})"></textarea>
        <span class="char-count" id="charCount">0/500</span>
      </div>
      <button class="btn-send" id="sendBtn" disabled>
        <span class="coin-ico">\u{1FA99}</span>
        <span>PAY &amp; SEND</span>
      </button>
    </div>
  </div>
</div>

<!-- Payment iframe overlay -->
<div class="pay-overlay" id="payOverlay">
  <iframe class="pay-frame" id="payFrame" allow="clipboard-write"></iframe>
</div>

<script>
var BASE = ${JSON.stringify(base)};
var CHAT_EP = ${JSON.stringify(chatEndpoint)};
var SCPPAY = ${JSON.stringify(scpPayBase)};

var $msgs = document.getElementById("msgs");
var $input = document.getElementById("msgInput");
var $send = document.getElementById("sendBtn");
var $count = document.getElementById("charCount");
var $empty = document.getElementById("emptyState");
var $payOv = document.getElementById("payOverlay");
var $payFr = document.getElementById("payFrame");
var $online = document.getElementById("onlineCount");
var $paid = document.getElementById("totalPaid");

var knownIds = new Set();
var totalPaid = 0;
var pendingMsg = null;
var paymentRevealTimer = null;
var AUTO_CONFIRM = ${JSON.stringify(SCP_PAY_AUTO_CONFIRM)};

function buildScpPaySrc(base, params) {
  var u = new URL(base, window.location.href);
  for (var key in params) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
    var value = params[key];
    if (value === null || value === undefined || value === "") continue;
    u.searchParams.set(key, String(value));
  }
  return u.toString();
}

// Textarea auto-resize
$input.addEventListener("input", function() {
  $count.textContent = $input.value.length + "/500";
  $send.disabled = !$input.value.trim();
  $input.style.height = "auto";
  $input.style.height = Math.min($input.scrollHeight, 120) + "px";
});

$input.addEventListener("keydown", function(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if ($input.value.trim()) sendMessage();
  }
});

$send.addEventListener("click", sendMessage);

function sendMessage() {
  var msg = $input.value.trim();
  if (!msg) return;
  pendingMsg = msg;
  $send.disabled = true;
  toast("Paying...", "ok");
  clearTimeout(paymentRevealTimer);
  var payUrl = BASE + "/pay";
  $payFr.src = buildScpPaySrc(SCPPAY, { autopay: 1, url: payUrl });
  $payFr.onload = function() {
    $payFr.contentWindow.postMessage({
      type: "x402:config",
      url: payUrl,
      autoLim: 0.001,
      autoConfirmUrl: AUTO_CONFIRM
    }, "*");
  };
}

$payOv.addEventListener("click", function(e) {
  if (e.target === $payOv) { closePay(); $send.disabled = !$input.value.trim(); pendingMsg = null; }
});

function closePay() {
  clearTimeout(paymentRevealTimer);
  paymentRevealTimer = null;
  $payOv.classList.remove("show");
  $payFr.src = "";
}

window.addEventListener("message", function(e) {
  if (e.data && e.data.type === "x402:status") {
    if (e.data.message) toast(e.data.message, "ok");
    return;
  }
  if (e.data && e.data.type === "x402:needs-confirm") {
    clearTimeout(paymentRevealTimer);
    paymentRevealTimer = null;
    $payOv.classList.add("show");
    return;
  }
  if (e.data && e.data.type === "x402:payment:error") {
    closePay();
    pendingMsg = null;
    $send.disabled = !$input.value.trim();
    toast("Payment failed: " + (e.data.message || "unknown error"), "err");
    return;
  }
  if (e.data && e.data.type === "x402:payment:success" && pendingMsg) {
    closePay();
    // Post the message with payment proof
    var xhr = new XMLHttpRequest();
    xhr.open("POST", CHAT_EP);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Payment-Signature", JSON.stringify({
      scheme: "credit",
      paymentId: e.data.payId || "cpay",
      asset: e.data.asset || "0x0000000000000000000000000000000000000000",
      amount: e.data.amount || "0",
      payer: e.data.payer || "anon"
    }));
    xhr.onload = function() {
      if (xhr.status === 200) {
        dropCoin();
        toast("Message sent!", "ok");
        $input.value = "";
        $input.style.height = "auto";
        $count.textContent = "0/500";
        $send.disabled = true;
        pollChat();
      } else {
        toast("Send failed: " + xhr.status, "err");
      }
    };
    xhr.onerror = function() { toast("Network error", "err"); };
    xhr.send(JSON.stringify({ message: pendingMsg }));
    pendingMsg = null;
  }
});

// Coin drop animation
function dropCoin() {
  var coin = document.createElement("span");
  coin.className = "coin-drop";
  coin.textContent = "\\u{1FA99}";
  coin.style.left = (30 + Math.random() * 60) + "vw";
  coin.style.top = "30vh";
  document.body.appendChild(coin);
  totalPaid++;
  $paid.textContent = totalPaid + " paid";
  setTimeout(function() { coin.remove(); }, 900);
}

// Poll for messages
function pollChat() {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", CHAT_EP);
  xhr.setRequestHeader("Accept", "application/json");
  xhr.onload = function() {
    if (xhr.status !== 200) return;
    try { var data = JSON.parse(xhr.responseText); } catch(_) { return; }
    var msgs = data.messages || [];
    if (msgs.length > 0 && $empty) { $empty.style.display = "none"; }
    $online.textContent = msgs.length + " msgs";
    var added = false;
    for (var i = 0; i < msgs.length; i++) {
      if (knownIds.has(msgs[i].id)) continue;
      knownIds.add(msgs[i].id);
      appendMsg(msgs[i]);
      added = true;
    }
    if (added) scrollBottom();
  };
  xhr.send();
}

function appendMsg(m) {
  var div = document.createElement("div");
  div.className = "msg";
  var addr = (m.from || "anon").slice(0, 6) + "..." + (m.from || "anon").slice(-4);
  var time = new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  var escaped = escapeHtml(m.message);
  div.innerHTML = '<span class="msg-addr">' + addr + '</span>'
    + '<span class="msg-time">' + time + '</span> '
    + '<span class="msg-txt">' + escaped + '</span>';
  $msgs.appendChild(div);
}

function escapeHtml(s) {
  var d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function scrollBottom() {
  $msgs.scrollTop = $msgs.scrollHeight;
}

function toast(text, type) {
  var t = document.createElement("div");
  t.className = "toast " + (type || "ok");
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(function() { t.remove(); }, 3000);
}

// Initial load + poll
pollChat();
setInterval(pollChat, 3000);
</script>
</body>
</html>`;

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache, no-store, must-revalidate"
  });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});

  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // GET /chat — HTML for browsers, JSON for API clients
  if (u.pathname === "/chat" && req.method === "GET") {
    const accept = req.headers["accept"] || "";
    if (accept.includes("text/html") && !req.headers["payment-signature"]) {
      return serveChatHTML(req, res);
    }
    return sendJson(res, 200, { ok: true, messages: messages.slice(-50) });
  }

  // POST /chat — send message (paid)
  if (u.pathname === "/chat" && req.method === "POST") {
    const rawHeader = getPaymentHeader(req);

    if (!rawHeader) {
      return sendJson(res, 402, makeOffers("", req));
    }

    // Parse body
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "invalid JSON body" }); }
    const msg = String(parsed.message || "").trim();
    if (!msg) return sendJson(res, 400, { error: "message is required" });
    if (msg.length > 500) return sendJson(res, 400, { error: "message too long (max 500 chars)" });

    // Verify payment
    let payment;
    try { payment = JSON.parse(rawHeader); } catch { payment = null; }

    // Accept credit scheme — hub already verified and debited the payer
    let result;
    if (payment && payment.scheme === "credit") {
      if (!payment.paymentId) return sendJson(res, 402, { error: "missing paymentId" });
      if (consumed.has(payment.paymentId)) return sendJson(res, 200, consumed.get(payment.paymentId).response);
      result = { ok: true, payer: payment.payer || "anon", paymentId: payment.paymentId };
    } else {
      const invoiceLookup = (invoiceId) => {
        const inv = invoices.get(invoiceId);
        return !!inv;
      };
      try {
        result = await verify(rawHeader, invoiceLookup);
      } catch (e) {
        return sendJson(res, 402, { error: "verification failed: " + e.message });
      }
      if (result.replayed) return sendJson(res, 200, result.response);
      if (!result.ok) return sendJson(res, 402, { error: result.error, retryable: false });
    }

    // Payment verified — store message
    const entry = {
      id: randomId("msg"),
      from: result.payer || "anon",
      message: msg,
      ts: Date.now(),
      paymentId: result.paymentId
    };
    messages.push(entry);
    if (messages.length > MAX_MESSAGES) messages.shift();

    const response = { ok: true, data: entry, receipt: { paymentId: result.paymentId } };
    consumed.set(result.paymentId, { response, ts: Date.now() });

    console.log(`[chat] ${entry.from.slice(0, 10)}...: "${msg}" (${result.paymentId})`);
    return sendJson(res, 200, response);
  }

  // GET /pay — offer discovery for agent clients
  if (u.pathname === "/pay" && req.method === "GET") {
    const rawHeader = getPaymentHeader(req);
    if (!rawHeader) {
      return sendJson(res, 402, makeOffers("", req));
    }

    let payment;
    try { payment = JSON.parse(rawHeader); } catch { payment = null; }

    let result;
    if (payment && payment.scheme === "credit") {
      if (!payment.paymentId) return sendJson(res, 402, { error: "missing paymentId" });
      if (payAcks.has(payment.paymentId)) return sendJson(res, 200, payAcks.get(payment.paymentId).response);
      result = { ok: true, payer: payment.payer || "anon", paymentId: payment.paymentId };
    } else {
      const invoiceLookup = (invoiceId) => {
        const inv = invoices.get(invoiceId);
        return !!inv;
      };
      try {
        result = await verifyPay(rawHeader, invoiceLookup);
      } catch (e) {
        return sendJson(res, 402, { error: "verification failed: " + e.message });
      }
      if (result.replayed) return sendJson(res, 200, result.response);
      if (!result.ok) return sendJson(res, 402, { error: result.error, retryable: false });
    }

    const response = {
      ok: true,
      receipt: { paymentId: result.paymentId },
      payer: result.payer || "anon"
    };
    payAcks.set(result.paymentId, { response, ts: Date.now() });
    return sendJson(res, 200, response);
  }

  // GET / — HTML chat UI for browsers, JSON for API clients
  if (u.pathname === "/" && req.method === "GET") {
    const accept = req.headers["accept"] || "";
    if (accept.includes("text/html")) {
      return serveChatHTML(req, res);
    }
    return sendJson(res, 200, {
      service: "SCP Chat",
      network: CHAT_NETWORK,
      pricing: PRICE_LABEL,
      endpoints: { read: "GET /chat (free)", send: "POST /chat (paid)" },
      hub: HUB_URL,
      payee: PAYEE_ADDR
    });
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[SCP Chat] listening on http://127.0.0.1:${PORT}`);
  console.log(`[SCP Chat] network: ${CHAT_NETWORK} (${NETWORK})`);
  console.log(`[SCP Chat] payee: ${PAYEE_ADDR}`);
  console.log(`[SCP Chat] hub: ${HUB_URL}`);
  console.log(`[SCP Chat] domain: chainId=${CHAIN_ID} contract=${CONTRACT_ADDR}`);
  console.log(`[SCP Chat] pricing: ${PRICE_LABEL} per message`);
  console.log(`[SCP Chat] GET /chat (free) | POST /chat (paid)`);
});
