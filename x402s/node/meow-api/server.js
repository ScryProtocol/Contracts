/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { verifyTicket } = require("../scp-hub/ticket");
const { HttpJsonClient } = require("../scp-common/http-client");
const { resolveNetwork, resolveHubEndpointForNetwork } = require("../scp-common/networks");

const envPath = path.resolve(__dirname, "../../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4090);
const NETWORK = process.env.NETWORK || "base";
const HUB_NAME = process.env.HUB_NAME || "pay.eth";
const HUB_ENDPOINT = process.env.HUB_ENDPOINT || process.env.HUB_URL || resolveHubEndpointForNetwork(NETWORK);
const HUB_FEE_BASE = String(process.env.HUB_FEE_BASE || "0");
const HUB_FEE_BPS = Number(process.env.HUB_FEE_BPS || 0);
const PRICE_ETH = process.env.MEOW_PRICE_ETH || "0.0000001";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const STREAM_T_SEC_RAW = Number(process.env.MEOW_STREAM_T_SEC || process.env.STREAM_T_SEC || 5);
const STREAM_T_SEC = Number.isInteger(STREAM_T_SEC_RAW) && STREAM_T_SEC_RAW > 0
  ? STREAM_T_SEC_RAW
  : 5;
const PAYMENT_MODE = String(process.env.MEOW_PAYMENT_MODE || process.env.PAYMENT_MODE || "per_request").toLowerCase();
const PAY_ONCE_TTL_SEC = Number(process.env.MEOW_PAY_ONCE_TTL_SEC || process.env.PAY_ONCE_TTL_SEC || 86400);
const ASSET_ETH = ethers.constants.AddressZero;

if (!["per_request", "pay_once"].includes(PAYMENT_MODE)) {
  console.error("FATAL: invalid payment mode; use per_request or pay_once");
  process.exit(1);
}
if (!Number.isInteger(PAY_ONCE_TTL_SEC) || PAY_ONCE_TTL_SEC <= 0) {
  console.error("FATAL: invalid pay-once TTL; expected positive integer seconds");
  process.exit(1);
}

let chainId;
if (NETWORK.startsWith("eip155:")) {
  chainId = Number(NETWORK.split(":")[1]);
} else {
  chainId = resolveNetwork(NETWORK).chainId;
}
if (!Number.isInteger(chainId) || chainId <= 0) {
  console.error("FATAL: invalid NETWORK; expected base|sepolia|mainnet|eip155:<id>");
  process.exit(1);
}

let amountWei;
try {
  amountWei = ethers.utils.parseUnits(PRICE_ETH, 18).toString();
} catch (_e) {
  console.error("FATAL: invalid MEOW_PRICE_ETH value");
  process.exit(1);
}

const payeeKey = process.env.PAYEE_PRIVATE_KEY;
if (!payeeKey) {
  console.error("FATAL: PAYEE_PRIVATE_KEY env var is required. Never use hardcoded keys.");
  process.exit(1);
}
const payeeWallet = new ethers.Wallet(payeeKey);
const PAYEE_ADDRESS = payeeWallet.address;

function now() {
  return Math.floor(Date.now() / 1000);
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function sendHtml(res, code, html) {
  res.writeHead(code, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Access-Control-Allow-Origin": "*"
  });
  res.end(html);
}

function wantsHtml(req) {
  const accept = String(req.headers.accept || "").toLowerCase();
  return accept.includes("text/html");
}

function buildTreeAppHtml(opts = {}) {
  const priceWei = String(opts.priceWei || "100000000000");
  const baseUrl = String(opts.baseUrl || "").replace(/\/+$/, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Meow Garden</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@400;600;700;800&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --s1:#8ec5fc;--s2:#b8dbff;--s3:#d4edff;--s4:#e6f6ec;
  --g1:#3cc06e;--g2:#58d488;--g3:#78e4a4;--g4:#2aaa58;
  --card:rgba(255,255,255,.75);--bdr:#9ce4b8;
  --deep:#143d28;--mid:#1e6b40;--soft:#48a870;
  --sun:#ffe458;--r:22px;--r2:16px;
}
html{scroll-behavior:smooth}
body{
  min-height:100vh;font-family:'Nunito',sans-serif;font-weight:600;
  color:var(--deep);overflow-x:hidden;
  background:linear-gradient(175deg,var(--s1) 0%,var(--s2) 25%,var(--s3) 50%,var(--s4) 75%,#d0f2d8 100%);
  cursor:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28'><text y='22' font-size='22'>🌿</text></svg>") 4 4,auto;
}

/* sun */
.sun{position:fixed;top:18px;right:28px;z-index:0;pointer-events:none;width:86px;height:86px;border-radius:50%;background:radial-gradient(circle,#fff6a8 20%,#ffe458 55%,#ffca2800 78%);filter:drop-shadow(0 0 40px #ffe45866);animation:sunb 5s ease-in-out infinite}
.sun::before{content:'';position:absolute;inset:-30px;border-radius:50%;background:radial-gradient(circle,#ffe45822 30%,transparent 68%);animation:sunb 5s ease-in-out infinite reverse}
@keyframes sunb{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}

/* rays */
.ray{position:fixed;top:61px;right:71px;width:3px;height:26px;background:linear-gradient(180deg,#ffe458,transparent);border-radius:3px;transform-origin:center -30px;pointer-events:none;z-index:0;animation:rspin 20s linear infinite}
.ray:nth-child(2){animation-delay:-2.5s;opacity:.7}.ray:nth-child(3){animation-delay:-5s;opacity:.5}
.ray:nth-child(4){animation-delay:-7.5s;opacity:.8}.ray:nth-child(5){animation-delay:-10s;opacity:.6}
.ray:nth-child(6){animation-delay:-12.5s;opacity:.5}.ray:nth-child(7){animation-delay:-15s;opacity:.7}
.ray:nth-child(8){animation-delay:-17.5s;opacity:.4}
@keyframes rspin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}

/* clouds */
.cloud{position:fixed;z-index:0;pointer-events:none;opacity:.8}
.cloud i{display:block;position:absolute;background:#fff;border-radius:50%}
.c1{top:7%;left:5%;animation:dr1 42s ease-in-out infinite}
.c1 i:nth-child(1){width:70px;height:36px;top:12px;left:0}.c1 i:nth-child(2){width:48px;height:48px;top:-10px;left:14px}.c1 i:nth-child(3){width:58px;height:50px;top:-16px;left:38px}
.c2{top:4%;left:60%;animation:dr2 56s ease-in-out infinite;transform:scale(.65);opacity:.6}
.c2 i:nth-child(1){width:70px;height:36px;top:12px;left:0}.c2 i:nth-child(2){width:48px;height:48px;top:-10px;left:14px}.c2 i:nth-child(3){width:58px;height:50px;top:-16px;left:38px}
.c3{top:13%;left:35%;animation:dr1 50s 8s ease-in-out infinite reverse;transform:scale(.45);opacity:.5}
.c3 i:nth-child(1){width:70px;height:36px;top:12px;left:0}.c3 i:nth-child(2){width:48px;height:48px;top:-10px;left:14px}.c3 i:nth-child(3){width:58px;height:50px;top:-16px;left:38px}
@keyframes dr1{0%,100%{translate:0 0}50%{translate:50px 8px}}
@keyframes dr2{0%,100%{translate:0 0}50%{translate:-40px 6px}}

/* butterflies */
.bf{position:fixed;z-index:2;pointer-events:none;font-size:20px}
.b1{top:18%;left:12%;animation:fl1 8s ease-in-out infinite}
.b2{top:10%;right:18%;animation:fl2 11s ease-in-out infinite;font-size:16px}
.b3{top:26%;left:68%;animation:fl1 9s 3s ease-in-out infinite reverse;font-size:14px}
@keyframes fl1{0%,100%{transform:translate(0,0) rotate(-5deg)}25%{transform:translate(30px,-20px) rotate(5deg)}50%{transform:translate(60px,5px) rotate(-3deg)}75%{transform:translate(25px,15px) rotate(4deg)}}
@keyframes fl2{0%,100%{transform:translate(0,0) scaleX(1)}25%{transform:translate(-25px,-15px) scaleX(-1)}50%{transform:translate(-50px,8px) scaleX(1)}75%{transform:translate(-20px,20px) scaleX(-1)}}

/* hills */
.hills{position:fixed;bottom:0;left:0;right:0;height:140px;z-index:0;pointer-events:none}
.hl{position:absolute;bottom:0;border-radius:50% 50% 0 0}
.hl1{left:-8%;width:42%;height:120px;background:var(--g4);z-index:2}
.hl2{left:15%;width:46%;height:95px;background:var(--g2);z-index:3}
.hl3{left:44%;width:40%;height:110px;background:var(--g1);z-index:2}
.hl4{left:68%;width:44%;height:90px;background:var(--g3);z-index:3}
.hl5{right:-6%;width:32%;height:115px;background:var(--g4);z-index:2}

/* scene flowers */
.sf{position:fixed;z-index:4;pointer-events:none;font-size:22px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.1))}
.sf1{bottom:70px;left:8%;animation:sw 3s ease-in-out infinite}
.sf2{bottom:58px;left:22%;animation:sw 2.6s .4s ease-in-out infinite;font-size:18px}
.sf3{bottom:65px;right:15%;animation:sw 3.2s .8s ease-in-out infinite}
.sf4{bottom:52px;right:30%;animation:sw 2.8s 1.2s ease-in-out infinite;font-size:16px}
.sf5{bottom:75px;left:48%;animation:sw 2.4s .2s ease-in-out infinite;font-size:26px}
.sf6{bottom:60px;left:62%;animation:sw 3s 1s ease-in-out infinite;font-size:14px}
@keyframes sw{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(6deg)}}

/* garden trees (on hills) */
.garden-tree{position:fixed;z-index:3;pointer-events:none;filter:drop-shadow(0 4px 6px rgba(20,80,40,.2));animation:treegrow .5s cubic-bezier(.34,1.56,.64,1) both}
@keyframes treegrow{0%{opacity:0;transform:scale(0) translateY(20px)}60%{transform:scale(1.15) translateY(-4px)}100%{opacity:1;transform:scale(1) translateY(0)}}

/* cat */
.cat-area{text-align:center;margin:0 0 -6px}
.cat{display:inline-block;position:relative;width:90px;height:78px;cursor:pointer;transition:transform .2s cubic-bezier(.34,1.56,.64,1);animation:catIn .7s cubic-bezier(.34,1.56,.64,1) both;filter:drop-shadow(0 6px 12px rgba(20,60,40,.15))}
@keyframes catIn{0%{opacity:0;transform:scale(.5) translateY(20px)}100%{opacity:1;transform:none}}
.cat:hover{transform:scale(1.1) rotate(-4deg)}.cat:active{transform:scale(.92) rotate(3deg)}
.cat-b{position:absolute;bottom:0;left:50%;translate:-50% 0;width:60px;height:48px;background:#ffecd6;border-radius:50% 50% 44% 44%;border:2.5px solid #ecc8a0}
.cat-h{position:absolute;top:0;left:50%;translate:-50% 0;width:56px;height:48px;background:#ffecd6;border-radius:50%;border:2.5px solid #ecc8a0;z-index:2}
.ear{position:absolute;top:-10px;width:20px;height:24px;background:#ffecd6;border:2.5px solid #ecc8a0;border-radius:50% 50% 6px 6px}
.ear-l{left:4px;transform:rotate(-14deg)}.ear-r{right:4px;transform:rotate(14deg)}
.ear::after{content:'';position:absolute;top:6px;left:50%;translate:-50% 0;width:10px;height:12px;background:#ffb4b4;border-radius:50% 50% 4px 4px}
.eye{position:absolute;top:18px;width:8px;height:9px;background:var(--deep);border-radius:50%;animation:blink 3.8s ease-in-out infinite}
.eye::after{content:'';position:absolute;top:1px;left:2px;width:3px;height:3px;background:#fff;border-radius:50%}
.eye-l{left:12px}.eye-r{right:12px}
@keyframes blink{0%,90%,100%{transform:scaleY(1)}94%{transform:scaleY(.06)}}
.nose{position:absolute;top:27px;left:50%;translate:-50% 0;width:6px;height:4px;background:#f09898;border-radius:50%}
.mouth{position:absolute;top:30px;left:50%;translate:-50% 0;width:14px;height:6px;border-bottom:2.5px solid #e09888;border-radius:0 0 50% 50%}
.wh{position:absolute;top:26px;width:18px;height:0;border-top:1.5px solid #ddb890}
.wh-l1{left:-8px;transform:rotate(-8deg)}.wh-l2{left:-6px;top:30px;transform:rotate(4deg)}
.wh-r1{right:-8px;transform:rotate(8deg)}.wh-r2{right:-6px;top:30px;transform:rotate(-4deg)}
.blush{position:absolute;top:25px;width:11px;height:7px;background:#ffc8c8;border-radius:50%;opacity:.6}
.bl-l{left:2px}.bl-r{right:2px}
.tail{position:absolute;bottom:14px;right:-14px;width:24px;height:24px;border:2.5px solid #ecc8a0;border-color:transparent #ecc8a0 #ecc8a0 transparent;border-radius:0 0 50% 0;transform-origin:left top;animation:wag 1s ease-in-out infinite alternate}
@keyframes wag{0%{transform:rotate(-12deg)}100%{transform:rotate(16deg)}}
.cat-sh{position:absolute;bottom:-6px;left:50%;translate:-50% 0;width:50px;height:10px;background:rgba(0,0,0,.08);border-radius:50%}
.cat-say{position:absolute;top:-32px;left:50%;translate:-50% 0;white-space:nowrap;font-family:'Fredoka',sans-serif;font-size:13px;font-weight:600;color:var(--mid);background:#fff;padding:4px 12px;border-radius:20px;border:2px solid var(--bdr);box-shadow:0 4px 12px rgba(40,120,70,.12);opacity:0;transform:translateY(6px);transition:all .25s cubic-bezier(.34,1.56,.64,1);pointer-events:none;z-index:10}
.cat-say.show{opacity:1;transform:translateY(0)}
.cat-say::after{content:'';position:absolute;bottom:-7px;left:50%;translate:-50% 0;border:6px solid transparent;border-top-color:#fff}

/* layout */
.wrap{max-width:860px;margin:0 auto;padding:18px 14px 150px;position:relative;z-index:5}
.card{background:var(--card);backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);border:2px solid var(--bdr);border-radius:var(--r);padding:22px;margin-bottom:14px;box-shadow:0 2px 0 #fff inset,0 10px 40px rgba(40,120,70,.09);animation:cin .55s cubic-bezier(.34,1.56,.64,1) both}
.card+.card{animation-delay:.1s}
@keyframes cin{0%{opacity:0;transform:translateY(24px) scale(.97)}100%{opacity:1;transform:none}}
.hero{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;overflow:visible}
h1{font-family:'Fredoka',sans-serif;font-weight:700;font-size:clamp(30px,7vw,48px);line-height:1;background:linear-gradient(135deg,#1e8e4e,#28b866,#1e8e4e);background-size:200% 200%;animation:gs 4s ease infinite;-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;filter:drop-shadow(0 2px 4px rgba(30,100,50,.2))}
@keyframes gs{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
.sub{font-size:14px;color:var(--mid);margin-top:6px;line-height:1.55}.sub strong{color:var(--deep)}
.badge{display:inline-flex;align-items:center;gap:5px;margin-top:8px;font-family:'Fredoka',sans-serif;font-size:12px;font-weight:600;padding:5px 14px;border-radius:99px;background:linear-gradient(135deg,#fff8e0,#fff0c8);border:2px solid #ffd26a;color:#8a5e10;animation:bp 2.6s ease-in-out infinite}
@keyframes bp{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-2px) scale(1.03)}}
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px}
.stat{background:linear-gradient(180deg,#fafffe,#eefff4);border:2px dashed #a4e4be;border-radius:var(--r2);padding:12px;transition:all .18s cubic-bezier(.34,1.56,.64,1)}
.stat:hover{transform:translateY(-3px) scale(1.02);box-shadow:0 8px 20px rgba(50,150,80,.1);border-style:solid}
.stat-l{font-family:'Fredoka',sans-serif;font-size:11px;font-weight:600;color:var(--soft);text-transform:uppercase;letter-spacing:.08em}
.stat-v{font-family:'Fredoka',sans-serif;font-size:18px;font-weight:700;color:var(--deep);margin-top:3px;word-break:break-all}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}
.btn{display:inline-flex;align-items:center;gap:6px;border:none;border-radius:14px;font-family:'Fredoka',sans-serif;font-size:15px;font-weight:600;cursor:pointer;padding:11px 18px;color:var(--deep);background:linear-gradient(180deg,#e4ffed,#d0f5de);border-bottom:3px solid #a4ddb8;box-shadow:0 4px 16px rgba(50,140,80,.10);transition:all .14s cubic-bezier(.34,1.56,.64,1);position:relative;text-decoration:none}
.btn::before{content:'';position:absolute;top:0;left:0;right:0;height:40%;background:linear-gradient(180deg,rgba(255,255,255,.4),transparent);pointer-events:none;border-radius:14px 14px 0 0}
.btn:hover{transform:translateY(-2px) scale(1.03);box-shadow:0 8px 24px rgba(50,140,80,.16)}
.btn:active{transform:translateY(1px) scale(.98)}
.btn-go{background:linear-gradient(180deg,#5cda8e,#3cc070);color:#fff;border-bottom-color:#28a058;font-size:17px;padding:12px 22px;box-shadow:0 6px 22px rgba(40,160,80,.22);text-shadow:0 1px 2px rgba(0,50,20,.2)}
.btn-go:hover{box-shadow:0 10px 32px rgba(40,160,80,.30)}
.btn-go .ico{font-size:20px;animation:bp2 1.8s ease-in-out infinite}
@keyframes bp2{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(-2px) rotate(8deg)}}
.msg{margin-top:12px;min-height:36px;font-size:13.5px;color:var(--mid);line-height:1.55;background:linear-gradient(135deg,#f6fff9,#edfff3);border:2px solid #c4eed4;border-radius:14px;padding:12px 16px 12px 40px;position:relative;overflow-wrap:break-word;transition:border-color .3s}
.msg.ok{border-color:#80dda0;background:linear-gradient(135deg,#efffef,#e0ffe8)}
.msg::before{content:'🐾';position:absolute;top:10px;left:14px;font-size:15px;opacity:.3}

/* fx */
.petal{position:fixed;top:-30px;pointer-events:none;z-index:20;animation:pf linear forwards}
@keyframes pf{0%{opacity:1;transform:translateY(0) rotate(0) scale(1)}70%{opacity:.8}100%{opacity:0;transform:translateY(110vh) rotate(400deg) scale(.6)}}
.spark{position:fixed;pointer-events:none;z-index:21;width:60px;height:60px;border-radius:50%;border:3px solid var(--sun);opacity:0;animation:sb .55s ease-out forwards}
@keyframes sb{0%{transform:scale(.2);opacity:1}100%{transform:scale(2.6);opacity:0}}
.cft{position:fixed;pointer-events:none;z-index:21;width:8px;height:8px;border-radius:2px;animation:cf ease-out forwards}
@keyframes cf{0%{opacity:1;transform:translate(0,0) rotate(0)}100%{opacity:0;transform:translate(var(--cx),var(--cy)) rotate(720deg)}}

@media(max-width:680px){.stats{grid-template-columns:1fr}.actions{flex-direction:column}.actions .btn{width:100%;justify-content:center}.hero{justify-content:center;text-align:center}}
</style>
</head>
<body>

<div class="sun"></div>
<div class="ray"></div><div class="ray"></div><div class="ray"></div><div class="ray"></div><div class="ray"></div><div class="ray"></div><div class="ray"></div><div class="ray"></div>
<div class="cloud c1"><i></i><i></i><i></i></div><div class="cloud c2"><i></i><i></i><i></i></div><div class="cloud c3"><i></i><i></i><i></i></div>
<span class="bf b1">🦋</span><span class="bf b2">🦋</span><span class="bf b3">🦋</span>
<div class="hills"><div class="hl hl1"></div><div class="hl hl2"></div><div class="hl hl3"></div><div class="hl hl4"></div><div class="hl hl5"></div></div>
<span class="sf sf1">🌸</span><span class="sf sf2">🌷</span><span class="sf sf3">🌻</span><span class="sf sf4">🌼</span><span class="sf sf5">🌺</span><span class="sf sf6">🌸</span>

<div class="wrap">
  <div class="card">
    <div class="hero">
      <div>
        <h1>Meow Garden</h1>
        <p class="sub">Plant a tree for <strong class="mono" id="priceLabel">${priceWei}</strong> wei.<br>One link. One payment. One tree.</p>
        <span class="badge">☀️ Sunshine Mode</span>
      </div>
      <div class="cat-area">
        <div class="cat" id="theCat" title="Pet me!">
          <div class="cat-say" id="catSay">Meow!</div>
          <div class="cat-b"></div>
          <div class="cat-h">
            <div class="ear ear-l"></div><div class="ear ear-r"></div>
            <div class="eye eye-l"></div><div class="eye eye-r"></div>
            <div class="nose"></div><div class="mouth"></div>
            <div class="wh wh-l1"></div><div class="wh wh-l2"></div><div class="wh wh-r1"></div><div class="wh wh-r2"></div>
            <div class="blush bl-l"></div><div class="blush bl-r"></div>
          </div>
          <div class="tail"></div><div class="cat-sh"></div>
        </div>
      </div>
    </div>
  </div>
  <div class="card">
    <div class="stats">
      <div class="stat"><div class="stat-l">Garden</div><div class="stat-v mono" id="gardenId">...</div></div>
      <div class="stat"><div class="stat-l">Trees Planted</div><div class="stat-v" id="count">0</div></div>
    </div>
    <div class="actions">
      <button class="btn btn-go" id="plantBtn"><span class="ico">🌱</span> Copy Plant Link</button>
      <a class="btn" id="scpLink" href="${baseUrl}/scpapp/" target="_blank" rel="noreferrer"><span class="ico">🔗</span> Open SCP App</a>
    </div>
    <div class="msg" id="msg">Copy the plant link, pay it in the SCP app — a tree grows in your garden!</div>
  </div>
</div>

<script>
(function(){
  var PW="${priceWei}",BASE="${baseUrl}";
  document.getElementById("priceLabel").textContent=PW;
  var K="meow_garden_id",gid=localStorage.getItem(K);
  if(!gid){gid="g_"+Math.random().toString(36).slice(2,12);localStorage.setItem(K,gid)}
  var $gid=document.getElementById("gardenId"),$c=document.getElementById("count"),$m=document.getElementById("msg"),$p=document.getElementById("plantBtn"),$sl=document.getElementById("scpLink"),$cat=document.getElementById("theCat"),$say=document.getElementById("catSay");
  $gid.textContent=gid;if(BASE)$sl.href=BASE+"/scpapp/";
  var knownTrees=0,treeSlots=[];
  function plantUrl(){return(BASE||window.location.origin)+"/meow/plant?garden="+encodeURIComponent(gid)}
  function setM(t,ok){$m.textContent=t;$m.classList.toggle("ok",!!ok)}

  var FL=["🌸","🌼","🍀","✨","🌷","💐","🪻","🏵️"];
  function petals(n){for(var i=0;i<(n||20);i++){var p=document.createElement("span");p.className="petal";p.textContent=FL[~~(Math.random()*FL.length)];p.style.left=(4+Math.random()*92)+"vw";p.style.fontSize=(14+Math.random()*16)+"px";p.style.animationDuration=(1.8+Math.random()*2.4)+"s";p.style.animationDelay=(Math.random()*.4)+"s";document.body.appendChild(p);setTimeout(function(el){return function(){el.remove()}}(p),5500)}}
  function spark(x,y){var s=document.createElement("div");s.className="spark";s.style.left=(x-30)+"px";s.style.top=(y-30)+"px";document.body.appendChild(s);setTimeout(function(){s.remove()},600)}
  var CC=["#ff9eae","#ffe46b","#9ef5bb","#a8d8ff","#e0b8ff","#ffc89e"];
  function confetti(x,y){for(var i=0;i<24;i++){var c=document.createElement("div");c.className="cft";c.style.left=x+"px";c.style.top=y+"px";c.style.background=CC[~~(Math.random()*CC.length)];c.style.setProperty("--cx",(Math.random()*200-100)+"px");c.style.setProperty("--cy",(Math.random()*-180-60)+"px");c.style.animationDuration=(.4+Math.random()*.6)+"s";c.style.width=(5+Math.random()*6)+"px";c.style.height=(5+Math.random()*6)+"px";c.style.borderRadius=Math.random()>.5?"50%":"2px";document.body.appendChild(c);setTimeout(function(el){return function(){el.remove()}}(c),1200)}}

  var petN=0,sayT;
  var SAYS=["Purrrr~","Mrrrow!","*nuzzle*","*happy wiggle*","*slow blink*","Meow~","*headbutt*","nya~!","zzz...","(=^·ω·^=)"];
  function catSay(t){$say.textContent=t;$say.classList.add("show");clearTimeout(sayT);sayT=setTimeout(function(){$say.classList.remove("show")},2000)}
  $cat.addEventListener("click",function(e){petN++;catSay(SAYS[petN%SAYS.length]);petals(8);confetti(e.clientX,e.clientY)});

  var TREES=["🌲","🌳","🌴","🎋","🎄","🪴","🎍","🌵"];
  function placeTree(animate){
    var el=document.createElement("span");
    el.className="garden-tree";
    if(!animate)el.style.animation="none";
    el.textContent=TREES[~~(Math.random()*TREES.length)];
    var left;
    for(var t=0;t<30;t++){left=3+Math.random()*94;var ok=true;for(var j=0;j<treeSlots.length;j++){if(Math.abs(treeSlots[j]-left)<3.5){ok=false;break}}if(ok)break}
    treeSlots.push(left);
    el.style.left=left+"%";
    el.style.bottom=(38+Math.random()*58)+"px";
    el.style.fontSize=(26+Math.random()*26)+"px";
    el.style.transform="rotate("+(-8+Math.random()*16)+"deg)";
    document.body.appendChild(el);
  }

  function pollGarden(){
    var xhr=new XMLHttpRequest();
    xhr.open("GET",BASE+"/meow/garden?garden="+encodeURIComponent(gid));
    xhr.setRequestHeader("Accept","application/json");
    xhr.onload=function(){
      if(xhr.status!==200)return;
      try{var j=JSON.parse(xhr.responseText)}catch(_){return}
      var total=Number(j.treeCount||0);
      if(total>knownTrees){
        var nc=total-knownTrees;
        for(var i=0;i<nc;i++)placeTree(true);
        petals(nc*8);
        var cx=innerWidth/2,cy=innerHeight-120;
        spark(cx,cy);confetti(cx,cy);
        catSay(["Yay!","So pretty!","More trees!","Beautiful~"][total%4]);
        setM("Tree #"+total+" planted! Your garden is growing 🌸",true);
        knownTrees=total;
        $c.textContent=String(total);
      }
    };
    xhr.send();
  }

  function initGarden(){
    var xhr=new XMLHttpRequest();
    xhr.open("GET",BASE+"/meow/garden?garden="+encodeURIComponent(gid));
    xhr.setRequestHeader("Accept","application/json");
    xhr.onload=function(){
      if(xhr.status!==200)return;
      try{var j=JSON.parse(xhr.responseText)}catch(_){return}
      var total=Number(j.treeCount||0);
      for(var i=0;i<total;i++)placeTree(false);
      knownTrees=total;
      $c.textContent=String(total);
    };
    xhr.send();
  }

  function copyText(text){
    if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(text);
    return new Promise(function(res,rej){try{var ta=document.createElement("textarea");ta.value=text;ta.style.cssText="position:fixed;left:-9999px";document.body.appendChild(ta);ta.select();document.execCommand("copy")?res():rej();ta.remove()}catch(e){rej(e)}});
  }
  $p.addEventListener("click",function(){
    var u=plantUrl();
    copyText(u).then(function(){
      setM("Plant link copied! Pay it in the SCP app — your tree will appear here 🌱",true);
      $p.querySelector(".ico").textContent="✅";
      catSay("Go plant~!");
      setTimeout(function(){$p.querySelector(".ico").textContent="🌱"},2200);
    },function(){setM("Plant link: "+u)});
  });

  initGarden();
  setInterval(pollGarden,3000);
})();
</script>
</body>
</html>`;
}

function parsePaymentHeader(req) {
  const raw = req.headers["payment-signature"];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

function parseCookies(req) {
  const raw = req.headers.cookie;
  if (!raw || typeof raw !== "string") return {};
  const out = {};
  for (const pair of raw.split(";")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch (_e) {
      out[key] = value;
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
  const expiresAt = now() + ctx.payOnceTtlSec;
  ctx.accessGrants.set(token, { path: pathname, expiresAt });
  res.setHeader(
    "Set-Cookie",
    `scp_access=${encodeURIComponent(token)}; Max-Age=${ctx.payOnceTtlSec}; Path=/; HttpOnly; SameSite=Lax`
  );
  return { token, expiresAt };
}

function resolveResourceUrl(req, pathname = "/meow") {
  if (PUBLIC_BASE_URL) {
    return `${PUBLIC_BASE_URL.replace(/\/+$/, "")}${pathname}`;
  }
  const protoRaw = req.headers["x-forwarded-proto"];
  const hostRaw = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = typeof protoRaw === "string" && protoRaw.trim() ? protoRaw.split(",")[0].trim() : "http";
  const host = typeof hostRaw === "string" && hostRaw.trim() ? hostRaw.split(",")[0].trim() : `${HOST}:${PORT}`;
  return `${proto}://${host}${pathname}`;
}

function buildOfferPayload(req, ctx, opts = {}) {
  const routePath = String(opts.routePath || "/meow");
  const message = String(opts.message || `Payment required for ${routePath}`);
  const invoiceId = randomId("inv");
  const quoteExpiry = now() + 120;
  const resource = resolveResourceUrl(req, routePath);
  const meta = opts.meta && typeof opts.meta === "object" ? opts.meta : {};
  ctx.invoices.set(invoiceId, {
    createdAt: now(),
    amount: amountWei,
    asset: ASSET_ETH,
    hubEndpoint: HUB_ENDPOINT,
    ...meta
  });

  return {
    message,
    pricing: [{ network: NETWORK, asset: "ETH", human: PRICE_ETH, price: amountWei, decimals: 18 }],
    accepts: [
      {
        scheme: "statechannel-hub-v1",
        network: `eip155:${chainId}`,
        asset: ASSET_ETH,
        maxAmountRequired: amountWei,
        payTo: HUB_NAME,
        resource,
        extensions: {
          "statechannel-hub-v1": {
            hubName: HUB_NAME,
            hubEndpoint: HUB_ENDPOINT,
            mode: "proxy_hold",
            feeModel: { base: HUB_FEE_BASE, bps: HUB_FEE_BPS },
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

function issue402(req, res, ctx, opts = {}) {
  return sendJson(res, 402, buildOfferPayload(req, ctx, opts));
}

async function validateHubPayment(payment, ctx) {
  if (!payment || payment.scheme !== "statechannel-hub-v1") {
    return { ok: false, error: "unsupported scheme" };
  }
  const ticket = payment.ticket;
  if (!ticket) return { ok: false, error: "missing ticket" };
  const invoice = ctx.invoices.get(payment.invoiceId);
  if (!invoice) return { ok: false, error: "unknown invoice" };
  if (payment.invoiceId !== ticket.invoiceId || payment.paymentId !== ticket.paymentId) {
    return { ok: false, error: "id mismatch" };
  }

  const signer = verifyTicket(ticket);
  if (!signer) return { ok: false, error: "bad ticket sig" };

  let hubAddr = ctx.hubAddressCache.get(invoice.hubEndpoint);
  if (!hubAddr) {
    const meta = await ctx.http.request("GET", `${invoice.hubEndpoint}/.well-known/x402`);
    if (meta.statusCode !== 200 || !meta.body || !meta.body.address) {
      return { ok: false, error: "hub unreachable" };
    }
    hubAddr = meta.body.address;
    ctx.hubAddressCache.set(invoice.hubEndpoint, hubAddr);
  }
  if (String(hubAddr).toLowerCase() !== String(signer).toLowerCase()) {
    return { ok: false, error: "hub signer mismatch" };
  }
  if (String(ticket.payee).toLowerCase() !== String(PAYEE_ADDRESS).toLowerCase()) {
    return { ok: false, error: "wrong payee" };
  }
  if (String(ticket.asset).toLowerCase() !== String(invoice.asset).toLowerCase()) {
    return { ok: false, error: "asset mismatch" };
  }
  if (String(ticket.amount) !== String(invoice.amount)) {
    return { ok: false, error: "amount mismatch" };
  }
  if (Number(ticket.expiry) < now()) {
    return { ok: false, error: "expired" };
  }

  const status = await ctx.http.request(
    "GET",
    `${invoice.hubEndpoint}/v1/payments/${encodeURIComponent(payment.paymentId)}`
  );
  if (status.statusCode !== 200 || !status.body || status.body.status !== "issued") {
    return { ok: false, error: "hub not issued" };
  }

  return { ok: true };
}

async function handle(req, res, ctx) {
  const u = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const wallet = String(u.searchParams.get("wallet") || "").trim();
  const walletOk = /^[a-zA-Z0-9_-]{3,80}$/.test(wallet);
  const garden = String(u.searchParams.get("garden") || "").trim();
  const gardenOk = /^[a-zA-Z0-9_-]{3,80}$/.test(garden);

  if (req.method === "GET" && u.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      network: `eip155:${chainId}`,
      payee: PAYEE_ADDRESS,
      meowPriceEth: PRICE_ETH,
      meowPriceWei: amountWei,
      paymentMode: ctx.paymentMode
    });
  }

  if (req.method === "GET" && u.pathname === "/pay") {
    return sendJson(res, 200, buildOfferPayload(req, ctx, { routePath: "/meow" }));
  }

  if (req.method === "GET" && u.pathname === "/meow/wallet") {
    if (!walletOk) return sendJson(res, 400, { error: "wallet query is required (3-80 chars, alnum/_/-)" });
    const bal = ctx.wallets.get(wallet) || "0";
    return sendJson(res, 200, { wallet, balanceWei: String(bal), unitPriceWei: amountWei });
  }

  if (req.method === "POST" && u.pathname === "/meow/tree") {
    if (!walletOk) return sendJson(res, 400, { error: "wallet query is required (3-80 chars, alnum/_/-)" });
    const bal = BigInt(ctx.wallets.get(wallet) || "0");
    const cost = BigInt(amountWei);
    if (bal < cost) return sendJson(res, 402, { error: "insufficient SCP-funded wallet balance", neededWei: amountWei, balanceWei: bal.toString() });
    const next = (bal - cost).toString();
    ctx.wallets.set(wallet, next);
    return sendJson(res, 200, { ok: true, wallet, spentWei: amountWei, balanceWei: next, treeId: randomId("tree") });
  }

  if (req.method === "GET" && u.pathname === "/meow/fund") {
    if (!walletOk) return sendJson(res, 400, { error: "wallet query is required (3-80 chars, alnum/_/-)" });
    const payment = parsePaymentHeader(req);
    if (!payment) {
      return issue402(req, res, ctx, {
        routePath: `/meow/fund?wallet=${encodeURIComponent(wallet)}`,
        message: `Payment required to fund wallet ${wallet}`,
        meta: { kind: "wallet_fund", wallet }
      });
    }

    const checked = await validateHubPayment(payment, ctx);
    if (!checked.ok) return sendJson(res, 402, { error: checked.error, retryable: false });
    if (!ctx.fundedPayments.has(payment.paymentId)) {
      const cur = BigInt(ctx.wallets.get(wallet) || "0");
      const next = (cur + BigInt(amountWei)).toString();
      ctx.wallets.set(wallet, next);
      ctx.fundedPayments.add(payment.paymentId);
    }
    return sendJson(res, 200, {
      ok: true,
      wallet,
      fundedWei: amountWei,
      balanceWei: String(ctx.wallets.get(wallet) || "0"),
      invoiceId: payment.invoiceId,
      paymentId: payment.paymentId,
      receiptId: randomId("rcpt"),
      acceptedAt: now()
    });
  }

  if (req.method === "GET" && u.pathname === "/meow/garden") {
    if (!gardenOk) return sendJson(res, 400, { error: "garden query is required (3-80 chars, alnum/_/-)" });
    const count = ctx.gardens.get(garden) || 0;
    return sendJson(res, 200, { garden, treeCount: count });
  }

  if (req.method === "GET" && u.pathname === "/meow/plant") {
    if (!gardenOk) return sendJson(res, 400, { error: "garden query is required (3-80 chars, alnum/_/-)" });
    const payment = parsePaymentHeader(req);
    if (!payment) {
      return issue402(req, res, ctx, {
        routePath: `/meow/plant?garden=${encodeURIComponent(garden)}`,
        message: `Payment required to plant a tree in garden ${garden}`,
        meta: { kind: "garden_plant", garden }
      });
    }

    const checked = await validateHubPayment(payment, ctx);
    if (!checked.ok) return sendJson(res, 402, { error: checked.error, retryable: false });
    let treeId;
    if (!ctx.plantedPayments.has(payment.paymentId)) {
      const cur = ctx.gardens.get(garden) || 0;
      ctx.gardens.set(garden, cur + 1);
      ctx.plantedPayments.add(payment.paymentId);
      treeId = randomId("tree");
    } else {
      treeId = "already_planted";
    }
    return sendJson(res, 200, {
      ok: true,
      garden,
      treeId,
      treeCount: ctx.gardens.get(garden) || 0,
      invoiceId: payment.invoiceId,
      paymentId: payment.paymentId,
      receiptId: randomId("rcpt"),
      acceptedAt: now()
    });
  }

  if (req.method === "GET" && u.pathname === "/meow") {
    if (wantsHtml(req)) {
      const base = resolveResourceUrl(req, "").replace(/\/+$/, "");
      return sendHtml(res, 200, buildTreeAppHtml({ priceWei: amountWei, unlocked: false, baseUrl: base }));
    }
    const payment = parsePaymentHeader(req);
    if (!payment) {
      if (ctx.paymentMode === "pay_once") {
        const grant = getAccessGrant(req, "/meow", ctx);
        if (grant) {
          return sendJson(res, 200, {
            ok: true,
            meow: "meow",
            access: { mode: "pay_once", token: grant.token, expiresAt: grant.expiresAt }
          });
        }
      }
      return issue402(req, res, ctx, { routePath: "/meow", message: "Payment required for /meow" });
    }

    const checked = await validateHubPayment(payment, ctx);
    if (!checked.ok) return sendJson(res, 402, { error: checked.error, retryable: false });

    let access = null;
    if (ctx.paymentMode === "pay_once") {
      access = issueAccessGrant(res, "/meow", ctx);
      access.mode = "pay_once";
    }

    return sendJson(res, 200, {
      ok: true,
      meow: "meow",
      ...(access ? { access } : {}),
      receipt: {
        invoiceId: payment.invoiceId,
        paymentId: payment.paymentId,
        receiptId: randomId("rcpt"),
        acceptedAt: now()
      }
    });
  }

  return sendJson(res, 404, { error: "not found. use GET /meow" });
}

function createMeowServer() {
  const ctx = {
    invoices: new Map(),
    wallets: new Map(),
    gardens: new Map(),
    fundedPayments: new Set(),
    plantedPayments: new Set(),
    accessGrants: new Map(),
    payOnceTtlSec: PAY_ONCE_TTL_SEC,
    paymentMode: PAYMENT_MODE,
    hubAddressCache: new Map(),
    http: new HttpJsonClient({ timeoutMs: 8000, maxSockets: 64 })
  };
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Payment-Signature, Idempotency-Key, X-SCP-Admin-Token, X-SCP-Payee-Signature, X-SCP-Payee-Timestamp, X-SCP-Access-Token, Authorization",
        "Access-Control-Max-Age": "86400"
      });
      return res.end();
    }

    handle(req, res, ctx).catch((err) => {
      sendJson(res, 500, { error: err.message || "internal error" });
    });
  });
  server.on("close", () => ctx.http.close());
  return server;
}

if (require.main === module) {
  const server = createMeowServer();
  server.listen(PORT, HOST, () => {
    console.log(`Meow API on ${HOST}:${PORT} (payee: ${PAYEE_ADDRESS})`);
    console.log(`  route: /meow`);
    console.log(`  route: /meow/plant?garden=<id> (pay-to-plant)`);
    console.log(`  route: /meow/garden?garden=<id> (poll trees)`);
    console.log(`  price: ${PRICE_ETH} ETH (${amountWei} wei)`);
    console.log(`  network: eip155:${chainId}`);
    console.log(`  hub: ${HUB_NAME} @ ${HUB_ENDPOINT}`);
    console.log(`  payment mode: ${PAYMENT_MODE}`);
  });
}

module.exports = { createMeowServer, PAYEE_ADDRESS, amountWei, PRICE_ETH };
