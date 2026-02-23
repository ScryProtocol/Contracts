const { useState, useEffect, useCallback, useRef } = React;

// ═══════════════════════════════════════════════════════════════════
// x402s — SCP Light Agent
// Full serverless state channel micropayment agent in the browser.
// Wallet · Balances · Channels · Offers · Pay · History
// ═══════════════════════════════════════════════════════════════════

const ETHERS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js";
const FONTS_CDN = "https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Instrument+Sans:wght@400;500;600;700&family=Bricolage+Grotesque:wght@500;600;700&display=swap";
const DEFAULT_CONTRACT = "0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b";
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const NETWORKS = {
  sepolia: { chainId: 11155111, caip2: "eip155:11155111", rpcs: [
    "https://rpc.ankr.com/eth_sepolia",
    "https://eth-sepolia.public.blastapi.io",
    "https://1rpc.io/sepolia",
    "https://sepolia.drpc.org",
  ], explorer: "https://sepolia.etherscan.io" },
  "base-sepolia": { chainId: 84532, caip2: "eip155:84532", rpcs: [
    "https://sepolia.base.org",
    "https://base-sepolia.public.blastapi.io",
    "https://rpc.ankr.com/base_sepolia",
  ], explorer: "https://sepolia.basescan.org" },
  base: { chainId: 8453, caip2: "eip155:8453", rpcs: [
    "https://mainnet.base.org",
    "https://rpc.ankr.com/base",
    "https://base.public.blastapi.io",
    "https://1rpc.io/base",
  ], explorer: "https://basescan.org" },
  mainnet: { chainId: 1, caip2: "eip155:1", rpcs: [
    "https://rpc.ankr.com/eth",
    "https://eth.public.blastapi.io",
    "https://1rpc.io/eth",
    "https://eth.drpc.org",
  ], explorer: "https://etherscan.io" },
};

const ASSETS = {
  1: { usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  8453: { usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  11155111: { usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  84532: { usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
};

const DECIMALS = { usdc: 6, usdt: 6, eth: 18, dai: 18, weth: 18 };
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)","function allowance(address,address) view returns (uint256)","function approve(address,uint256) returns (bool)"];
const CHANNEL_ABI = ["function openChannel(address,address,uint256,uint64,uint64,bytes32) external payable returns (bytes32)","function deposit(bytes32,uint256) external payable","function getChannel(bytes32) external view returns (tuple(address,address,address,uint64,uint64,uint256,bool,uint64,uint64))","event ChannelOpened(bytes32 indexed,address indexed,address indexed,address,uint64,uint64)","event Deposited(bytes32 indexed,address indexed,uint256,uint256)"];

// ── Helpers ──
function resolveNet(name) {
  const k = String(name||"").trim().toLowerCase();
  if (NETWORKS[k]) return { ...NETWORKS[k], name: k };
  for (const [n, v] of Object.entries(NETWORKS)) { if (v.caip2 === k || String(v.chainId) === k) return { ...v, name: n }; }
  return null;
}
function toCaip2(n) { const r = resolveNet(n); return r?.caip2 || null; }
function normalizeEndpoint(u) { return String(u || "").trim().replace(/\/+$/, ""); }
function getAssetAddr(chainId, sym) { return ASSETS[chainId]?.[sym.toLowerCase()] || null; }
function resolveAsset(assetOrSym, chainId) {
  if (!assetOrSym) return { address: ZERO_ADDR, symbol: "eth", decimals: 18, isEth: true };
  const l = String(assetOrSym).toLowerCase().trim();
  if (l === "eth" || l === ZERO_ADDR) return { address: ZERO_ADDR, symbol: "eth", decimals: 18, isEth: true };
  const a = getAssetAddr(chainId, l);
  if (a) return { address: a, symbol: l, decimals: DECIMALS[l]||18, isEth: false };
  if (l.startsWith("0x") && l.length === 42) {
    for (const assets of Object.values(ASSETS)) for (const [s, addr] of Object.entries(assets)) if (addr.toLowerCase() === l) return { address: addr, symbol: s, decimals: DECIMALS[s]||18, isEth: false };
    return { address: assetOrSym, symbol: "token", decimals: 18, isEth: false };
  }
  return { address: ZERO_ADDR, symbol: "eth", decimals: 18, isEth: true };
}
function fmtAmt(raw, dec = 6) {
  if (!raw || raw === "0") return "0";
  try {
    const n = BigInt(raw), d = 10n**BigInt(dec), w = n/d;
    const frac = (n % d).toString().padStart(dec, "0");
    if (w === 0n) {
      const nz = frac.search(/[1-9]/);
      if (nz === -1) return "0";
      const end = Math.min(dec, nz + 6);
      const tiny = frac.slice(0, end).replace(/0+$/, "");
      return tiny ? `0.${tiny}` : "0";
    }
    const f = frac.slice(0, 4).replace(/0+$/, "");
    return f ? `${w}.${f}` : `${w}`;
  } catch {
    return raw;
  }
}
function fmtToken(raw, sym) { return fmtAmt(raw, DECIMALS[sym?.toLowerCase()]||18); }
function shortAddr(a) { return a ? `${a.slice(0,6)}…${a.slice(-4)}` : "—"; }
function shortHash(h) { return h ? `${h.slice(0,10)}…${h.slice(-4)}` : "—"; }
function ago(ts) { const d = Date.now()-ts; if(d<60000)return "now"; if(d<3600000)return `${Math.floor(d/60000)}m ago`; if(d<86400000)return `${Math.floor(d/3600000)}h ago`; return `${Math.floor(d/86400000)}d ago`; }
function guessAssetSym(o) {
  if (!o?.asset) return "ETH";
  const a = String(o.asset).toLowerCase();
  if (a===ZERO_ADDR||a==="eth") return "ETH";
  for (const assets of Object.values(ASSETS)) for (const [s,addr] of Object.entries(assets)) if (addr.toLowerCase()===a) return s.toUpperCase();
  return "TOKEN";
}
function humanToRaw(human, dec) {
  const h = String(human).trim();
  if (!h) return "";
  const parts = h.split(".");
  const whole = (parts[0] || "0").replace(/[^\d]/g, "") || "0";
  let frac = (parts[1] || "").replace(/[^\d]/g, "");
  frac = frac.slice(0, dec).padEnd(dec, "0");
  return (BigInt(whole) * 10n**BigInt(dec) + BigInt(frac || "0")).toString();
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

// ═══════════════════════════════════════════════════════════════════
// SCP AGENT CLASS (runs in-browser with ethers.js)
// ═══════════════════════════════════════════════════════════════════
class SCPAgent {
  constructor(ethers, opts) {
    this.ethers = ethers;
    this.wallet = new ethers.Wallet(opts.privateKey);
    this.address = this.wallet.address;
    this.network = opts.network || "sepolia";
    this.maxAmount = opts.maxAmount || "5000000000000";
    this.maxFee = opts.maxFee || "5000";
    this.contractAddress = opts.contractAddress || DEFAULT_CONTRACT;
    this.state = { channels: {}, payments: [] };
    this._provider = null;
    this._providerTs = 0;
    this._customRpc = opts.customRpc || "";
    this.loadPersistedState();
  }

  stateStorageKey() {
    return `x402s.scp-agent.state.v1:${this.address.toLowerCase()}:${String(this.network||"").toLowerCase()}:${String(this.contractAddress||"").toLowerCase()}`;
  }

  loadPersistedState() {
    try {
      if (typeof window === "undefined" || !window.localStorage) return;
      const raw = window.localStorage.getItem(this.stateStorageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const saved = parsed?.state || parsed;
      const channels = saved?.channels && typeof saved.channels === "object" ? saved.channels : {};
      const payments = Array.isArray(saved?.payments) ? saved.payments : [];
      this.state = { channels, payments };
    } catch {}
  }

  persistState() {
    try {
      if (typeof window === "undefined" || !window.localStorage) return;
      window.localStorage.setItem(this.stateStorageKey(), JSON.stringify({
        v: 1,
        updatedAt: Date.now(),
        state: this.state
      }));
    } catch {}
  }

  getNetInfo() { return resolveNet(this.network); }

  async getProvider() {
    // Cache for 5 min, then re-validate
    if (this._provider && Date.now() - this._providerTs < 300000) return this._provider;
    this._provider = null;

    const net = this.getNetInfo();
    const chainId = net?.chainId || 11155111;

    // Build RPC candidate list: custom first, then defaults
    const rpcs = [
      ...(this._customRpc ? [this._customRpc] : []),
      ...(net?.rpcs || []),
    ];

    const errors = [];

    for (const rpc of rpcs) {
      try {
        // StaticJsonRpcProvider skips the eth_chainId validation call
        // that JsonRpcProvider does — avoids double-round-trip and
        // chainId mismatch rejections from some RPCs
        const p = new this.ethers.providers.StaticJsonRpcProvider(
          { url: rpc, timeout: 8000 },
          chainId
        );

        // Validate with a timeout
        const blockNum = await withTimeout(p.getBlockNumber(), 8000);
        if (typeof blockNum !== "number" || blockNum < 1) throw new Error("Bad block number");

        this._provider = p;
        this._providerTs = Date.now();
        console.log(`[x402s] RPC connected: ${rpc} (block ${blockNum})`);
        return p;
      } catch (e) {
        const reason = e?.reason || e?.error?.message || e?.message || String(e);
        errors.push(`${rpc}: ${reason.slice(0, 80)}`);
      }
    }

    throw new Error(`No responsive RPC for chain ${chainId}.\nTried:\n${errors.join("\n")}\n\nThis is usually a CORS issue. Add a custom RPC with CORS support (Alchemy/Infura/QuickNode) in wallet config.`);
  }

  async getBalances() {
    const p = await this.getProvider();
    const net = this.getNetInfo();
    const cid = net?.chainId || 11155111;
    const ethBal = await withTimeout(p.getBalance(this.address), 10000);
    const tokens = {};
    for (const [sym, addr] of Object.entries(ASSETS[cid]||{})) {
      try {
        const t = new this.ethers.Contract(addr, ERC20_ABI, p);
        const b = await withTimeout(t.balanceOf(this.address), 10000);
        tokens[sym] = { raw: b.toString(), formatted: fmtAmt(b.toString(), DECIMALS[sym]||18), address: addr };
      } catch (e) { tokens[sym] = { raw: "0", formatted: "0", address: addr, error: e.message }; }
    }
    return { eth: { raw: ethBal.toString(), formatted: this.ethers.utils.formatEther(ethBal) }, tokens, chainId: cid };
  }

  async discoverOffers(url) {
    const res = await withTimeout(fetch(url, { method: "GET", redirect: "manual" }), 15000);
    if (res.status !== 402) return { status: res.status, offers: [] };
    const body = await res.json().catch(()=>null);
    let offers = body?.accepts || body?.offers || [];
    offers = offers.map(o => {
      const ext = o.extensions||{};
      const hub = ext["statechannel-hub-v1"], dir = ext["statechannel-direct-v1"];
      return { ...o, scheme: hub?"statechannel-hub-v1":dir?"statechannel-direct-v1":o.scheme||"unknown",
        hubEndpoint: normalizeEndpoint(hub?.hubEndpoint||null), payeeAddress: hub?.payeeAddress||dir?.payeeAddress||o.payeeAddress||null,
        invoiceId: hub?.invoiceId||o.invoiceId||null };
    });
    return { status: 402, offers, raw: body };
  }

  scoreOffers(offers) {
    const nc = toCaip2(this.network);
    return offers.map((o, idx) => {
      const matchNet = !nc || !toCaip2(o.network) || toCaip2(o.network) === nc;
      const isHub = o.scheme === "statechannel-hub-v1", isDir = o.scheme === "statechannel-direct-v1";
      let score = 0, chKey = null, chBal = "0";
      if (isHub && o.hubEndpoint) {
        chKey = `hub:${normalizeEndpoint(o.hubEndpoint)}`;
        const ch = this.state.channels[chKey];
        if (ch) { chBal = ch.balA||"0"; try { score = BigInt(chBal) >= BigInt(o.maxAmountRequired||"0") ? 2 : 1; } catch { score=1; } }
      } else if (isDir && o.payeeAddress) {
        chKey = `direct:${o.payeeAddress.toLowerCase()}`;
        const ch = this.state.channels[chKey];
        if (ch) { chBal = ch.balA||"0"; try { score = BigInt(chBal) >= BigInt(o.maxAmountRequired||"0") ? 2 : 1; } catch { score=1; } }
      }
      return { idx, offer: o, matchNet, route: isHub?"hub":isDir?"direct":"?", score, chKey, chBal,
        status: score===2?"ready":score===1?"underfunded":"no-channel", amount: o.maxAmountRequired||"0" };
    });
  }

  chooseOffer(offers, route = "auto") {
    const nc = toCaip2(this.network);
    const filtered = offers.filter(o => { const oc = toCaip2(o.network); return !nc || !oc || oc === nc; });
    const hubs = filtered.filter(o => o.scheme === "statechannel-hub-v1");
    const dirs = filtered.filter(o => o.scheme === "statechannel-direct-v1");
    const amt = o => { try { return BigInt(o.maxAmountRequired||"0"); } catch { return 0n; } };
    const rankHub = o => { const ep = normalizeEndpoint(o.hubEndpoint); if(!ep)return 0; const ch=this.state.channels[`hub:${ep}`]; if(!ch)return 0; try{return BigInt(ch.balA||"0")>=amt(o)?2:1;}catch{return 1;} };
    const rankDir = o => { const pa = o.payeeAddress; if(!pa)return 0; const ch=this.state.channels[`direct:${pa.toLowerCase()}`]; if(!ch)return 0; try{return BigInt(ch.balA||"0")>=amt(o)?2:1;}catch{return 1;} };
    const pick = (list, fn) => { if(!list.length)return null; const s=list.map((o,i)=>({o,i,r:fn(o),a:amt(o)})); s.sort((a,b)=>a.r!==b.r?b.r-a.r:a.a!==b.a?(a.a<b.a?-1:1):a.i-b.i); return s[0].o; };
    if (route==="hub") return pick(hubs, rankHub);
    if (route==="direct") return pick(dirs, rankDir);
    const d = pick(dirs, rankDir); if (d && rankDir(d)>=2) return d;
    return pick(hubs, rankHub) || d;
  }

  async hydrateHubChannel(ep, hubInfoHint = null) {
    const endpoint = normalizeEndpoint(ep);
    if (!endpoint) return null;
    const chKey = `hub:${endpoint}`;
    if (this.state.channels[chKey]) return this.state.channels[chKey];

    const toAddr = (v) => {
      try { return this.ethers.utils.getAddress(v); } catch { return null; }
    };

    let hubInfo = hubInfoHint || null;
    if (!hubInfo) {
      try {
        const r = await withTimeout(fetch(`${endpoint}/.well-known/x402`), 10000);
        if (r.ok) hubInfo = await r.json();
      } catch {}
    }
    const hubAddr = toAddr(hubInfo?.address);

    // 1) Alias an existing locally-known channel to this hub endpoint.
    for (const v of Object.values(this.state.channels || {})) {
      if (!v?.channelId || v.channelId === ZERO32) continue;
      const sameEndpoint = normalizeEndpoint(v.hubEndpoint || "") === endpoint;
      const peer = toAddr(v.participantB);
      const samePeer = !!(hubAddr && peer && peer.toLowerCase() === hubAddr.toLowerCase());
      if (!sameEndpoint && !samePeer) continue;
      this.state.channels[chKey] = {
        ...v,
        participantB: hubAddr || v.participantB,
        hubEndpoint: endpoint
      };
      this.persistState();
      return this.state.channels[chKey];
    }

    // 2) Legacy hub API (if available).
    try {
      const chanRes = await withTimeout(fetch(`${endpoint}/v1/channels?payer=${this.address}`), 8000);
      if (chanRes.ok) {
        const data = await chanRes.json();
        const chs = data.channels || data;
        if (Array.isArray(chs) && chs.length) {
          const ch = chs[0];
          this.state.channels[chKey] = {
            channelId: ch.channelId,
            participantB: hubAddr || ch.participantB || null,
            asset: ch.asset || ZERO_ADDR,
            assetSymbol: guessAssetSym({ asset: ch.asset || ZERO_ADDR }).toLowerCase(),
            nonce: Number(ch.stateNonce || 0),
            balA: String(ch.balA || "0"),
            balB: String(ch.balB || "0"),
            hubEndpoint: endpoint
          };
          this.persistState();
          return this.state.channels[chKey];
        }
      }
    } catch {}

    // 3) Discover on-chain channel by payer+hub ChannelOpened logs, then pull
    // latest off-chain state from hub channel endpoint.
    if (!hubAddr) return null;
    const payerAddr = toAddr(this.address);
    if (!payerAddr) return null;

    let channelId = null;
    try {
      const p = await this.getProvider();
      const c = new this.ethers.Contract(this.contractAddress, CHANNEL_ABI, p);
      const filter = c.filters.ChannelOpened(null, payerAddr, hubAddr);
      const latestBlock = await withTimeout(p.getBlockNumber(), 10000);
      let step = 9000;
      let found = null;
      for (let to = latestBlock; to >= 0 && !found;) {
        const from = Math.max(0, to - step + 1);
        try {
          const logs = await withTimeout(c.queryFilter(filter, from, to), 12000);
          if (logs.length) found = logs[logs.length - 1];
          to = from - 1;
        } catch (e) {
          const m = String(e?.reason || e?.error?.message || e?.message || e);
          if (/eth_getlogs|block(?:s)? range|limited to|more than/i.test(m) && step > 1000) {
            step = Math.max(1000, Math.floor(step / 2));
            continue;
          }
          throw e;
        }
      }
      channelId = found?.args?.channelId || found?.args?.[0] || null;
    } catch {}
    if (!channelId || channelId === ZERO32) return null;

    let latest = null;
    try {
      const chRes = await withTimeout(fetch(`${endpoint}/v1/channels/${encodeURIComponent(channelId)}`), 10000);
      if (chRes.ok) latest = await chRes.json();
    } catch {}
    const st = latest?.latestState || {};
    const asset = st.asset || latest?.asset || ZERO_ADDR;
    this.state.channels[chKey] = {
      channelId,
      participantB: hubAddr,
      asset,
      assetSymbol: guessAssetSym({ asset }).toLowerCase(),
      nonce: Number(st.stateNonce ?? latest?.latestNonce ?? 0),
      balA: String(st.balA ?? "0"),
      balB: String(st.balB ?? "0"),
      hubEndpoint: endpoint
    };
    this.persistState();
    return this.state.channels[chKey];
  }

  async analyzeOffer(offer, opts={}) {
    const ep = normalizeEndpoint(offer.hubEndpoint), chKey = ep?`hub:${ep}`:null;
    const ch = chKey ? this.state.channels[chKey] : null;
    const net = this.getNetInfo(), cid = net?.chainId||11155111;
    let hubInfo = null;
    if (ep) try { const r = await withTimeout(fetch(`${ep}/.well-known/x402`), 10000); if(r.ok) hubInfo = await r.json(); } catch {}
    const amount = BigInt(offer.maxAmountRequired||"0");
    const fp = hubInfo?.fee||hubInfo?.feePolicy;
    const fee = fp ? BigInt(fp.base||"0") + (amount*BigInt(fp.bps||"0")/10000n) + BigInt(fp.gasSurcharge||"0") : 0n;
    const topupRaw = Number(opts.topupPayments);
    const lowRaw = Number(opts.lowWaterPayments);
    const topup = Number.isFinite(topupRaw) && topupRaw > 0 ? Math.floor(topupRaw) : 100;
    const lowWater = Number.isFinite(lowRaw) && lowRaw > 0 ? Math.floor(lowRaw) : 10;
    const refillThreshold = Math.min(lowWater, topup);
    const perPay = amount + fee;
    const target = perPay * BigInt(topup);
    const refillAt = perPay * BigInt(refillThreshold);
    const curBal = ch ? BigInt(ch.balA||"0") : 0n;
    const neededToTarget = target > curBal ? target - curBal : 0n;
    const needsOpen = !ch && neededToTarget > 0n;
    const needsFund = !!ch && curBal < refillAt;
    const needed = (needsOpen || needsFund) ? neededToTarget : 0n;
    let walBal = null; try { walBal = await this.getBalances(); } catch {}
    const resolved = resolveAsset(offer.asset||"eth", cid);
    return {
      hasChannel: !!ch, chKey, channelId: ch?.channelId, hubEndpoint: ep,
      hubAddress: hubInfo?.address, hubName: hubInfo?.hubName||hubInfo?.name,
      feePolicy: fp,
      offer: { network: offer.network, asset: offer.asset, sym: resolved.symbol, amount: amount.toString(), fee: fee.toString(), perPay: perPay.toString() },
      funding: { curBal: curBal.toString(), target: target.toString(), needed: needed.toString(), topup,
        lowWater: refillThreshold, refillAt: refillAt.toString(),
        needsOpen, needsFund, ready: !needsOpen && !needsFund },
      walBal, chainId: cid, contractAddress: this.contractAddress
    };
  }

  async openChannel(peerAddr, asset, amount, opts={}) {
    const p = await this.getProvider();
    const signer = this.wallet.connect(p);
    const contract = new this.ethers.Contract(this.contractAddress, CHANNEL_ABI, signer);
    const net = this.getNetInfo(), cid = net?.chainId||11155111;
    const resolved = resolveAsset(asset, cid);
    const amtBN = this.ethers.BigNumber.from(amount);
    const challenge = opts.challengePeriodSec||86400;
    const expiry = Math.floor(Date.now()/1000) + (opts.channelExpirySec||2592000);
    const salt = this.ethers.utils.hexlify(this.ethers.utils.randomBytes(32));
    if (!resolved.isEth) {
      const token = new this.ethers.Contract(resolved.address, ERC20_ABI, signer);
      const allow = await withTimeout(token.allowance(this.address, this.contractAddress), 10000);
      if (allow.lt(amtBN)) {
        opts.onStatus?.("Approving token spend…");
        const tx = await withTimeout(token.approve(this.contractAddress, this.ethers.constants.MaxUint256), 30000);
        await withTimeout(tx.wait(1), 120000);
      }
    }
    const txOpts = resolved.isEth ? { value: amtBN, gasLimit: 350000 } : { gasLimit: 350000 };
    opts.onStatus?.("Sending openChannel tx…");
    const tx = await withTimeout(contract.openChannel(this.ethers.utils.getAddress(peerAddr), resolved.address, amtBN, challenge, expiry, salt, txOpts), 30000);
    opts.onStatus?.(`Waiting for confirmation (tx: ${tx.hash.slice(0,10)}…)`);
    const rc = await withTimeout(tx.wait(1), 120000);
    const ev = rc.events?.find(e=>e.event==="ChannelOpened");
    return { channelId: ev?.args?.channelId||ZERO32, txHash: tx.hash, amount: amount.toString(), asset: resolved.address, sym: resolved.symbol, participantB: peerAddr, blockNumber: rc.blockNumber };
  }

  async fundChannel(channelId, amount) {
    const p = await this.getProvider();
    const signer = this.wallet.connect(p);
    const contract = new this.ethers.Contract(this.contractAddress, CHANNEL_ABI, signer);
    const ch = await withTimeout(contract.getChannel(channelId), 10000);
    const assetAddr = ch[2], isEth = assetAddr === ZERO_ADDR;
    const amtBN = this.ethers.BigNumber.from(amount);
    if (!isEth) {
      const token = new this.ethers.Contract(assetAddr, ERC20_ABI, signer);
      const allow = await withTimeout(token.allowance(this.address, this.contractAddress), 10000);
      if (allow.lt(amtBN)) {
        const tx = await withTimeout(token.approve(this.contractAddress, this.ethers.constants.MaxUint256), 30000);
        await withTimeout(tx.wait(1), 120000);
      }
    }
    const txOpts = isEth ? { value: amtBN, gasLimit: 200000 } : { gasLimit: 200000 };
    const tx = await withTimeout(contract.deposit(channelId, amtBN, txOpts), 30000);
    const rc = await withTimeout(tx.wait(1), 120000);
    return { channelId, txHash: tx.hash, amount: amount.toString(), blockNumber: rc.blockNumber };
  }

  async ensureChannelForOffer(offer, opts={}) {
    const ep = normalizeEndpoint(offer?.hubEndpoint || "");
    if (ep && !this.state.channels[`hub:${ep}`]) {
      opts.onStatus?.("Checking hub for existing channel…");
      await this.hydrateHubChannel(ep);
    }
    const plan = await this.analyzeOffer(offer, opts);
    if (plan.funding.ready) return { action: "none", plan };
    const needed = BigInt(plan.funding.needed);
    if (plan.funding.needsOpen) {
      if (!plan.hubAddress) throw new Error("Hub address not found");
      opts.onStatus?.("Opening channel on-chain…");
      const result = await this.openChannel(plan.hubAddress, offer.asset||"eth", needed.toString());
      this.state.channels[plan.chKey] = { channelId: result.channelId, participantB: result.participantB, asset: result.asset, assetSymbol: result.sym, nonce: 0, balA: needed.toString(), balB: "0", hubEndpoint: plan.hubEndpoint, txHash: result.txHash, openedAt: Date.now() };
      this.persistState();
      return { action: "opened", plan, result };
    }
    if (plan.funding.needsFund) {
      opts.onStatus?.("Funding channel on-chain…");
      const result = await this.fundChannel(plan.channelId, needed.toString());
      const ch = this.state.channels[plan.chKey];
      if (ch) ch.balA = (BigInt(ch.balA||"0") + needed).toString();
      this.persistState();
      return { action: "funded", plan, result };
    }
    return { action: "none", plan };
  }

  // EIP-712 state signing
  buildDomainSep(chainId) {
    const e = this.ethers;
    return e.utils.keccak256(e.utils.defaultAbiCoder.encode(["bytes32","bytes32","bytes32","uint256","address"],[
      e.utils.keccak256(e.utils.toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
      e.utils.keccak256(e.utils.toUtf8Bytes("X402StateChannel")),
      e.utils.keccak256(e.utils.toUtf8Bytes("1")), chainId, this.contractAddress ]));
  }
  signState(state, chainId) {
    const e = this.ethers;
    const TH = e.utils.keccak256(e.utils.toUtf8Bytes("ChannelState(bytes32 channelId,uint64 stateNonce,uint256 balA,uint256 balB,bytes32 locksRoot,uint64 stateExpiry,bytes32 contextHash)"));
    const struct = e.utils.keccak256(e.utils.defaultAbiCoder.encode(["bytes32","bytes32","uint64","uint256","uint256","bytes32","uint64","bytes32"],
      [TH, state.channelId, state.stateNonce, state.balA, state.balB, state.locksRoot||ZERO32, state.stateExpiry||0, state.contextHash||ZERO32]));
    const domain = this.buildDomainSep(chainId);
    const digest = e.utils.keccak256(e.utils.solidityPack(["string","bytes32","bytes32"],["\x19\x01",domain,struct]));
    return e.utils.joinSignature(this.wallet._signingKey().signDigest(digest));
  }

  async payUrl(url, opts={}) {
    const disc = await this.discoverOffers(url);
    if (disc.status !== 402) return { skipped: true, status: disc.status };
    if (!disc.offers.length) throw new Error("No offers found");
    const offer = this.chooseOffer(disc.offers, opts.route||"auto");
    if (!offer) throw new Error("No compatible offer");
    if (offer.scheme !== "statechannel-hub-v1" || !offer.hubEndpoint) throw new Error("Only hub route supported in app");
    if (!offer.payeeAddress || !String(offer.payeeAddress).startsWith("0x")) throw new Error("Offer missing payee address");
    const ep = normalizeEndpoint(offer.hubEndpoint), chKey = `hub:${ep}`;
    const net = this.getNetInfo(), cid = net?.chainId||11155111;

    // Auto-ensure channel
    if (!this.state.channels[chKey]) {
      await this.ensureChannelForOffer(offer, { topupPayments: opts.topupPayments||100, lowWaterPayments: opts.lowWaterPayments||10, onStatus: opts.onStatus });
    }
    if (!this.state.channels[chKey]) throw new Error("Channel setup failed");
    const ch = this.state.channels[chKey];
    const assetInfo = resolveAsset(offer.asset||"eth", cid);

    // Best-effort state sync from hub to avoid stale local balances/nonces.
    if (ch?.channelId) {
      try {
        const stRes = await withTimeout(fetch(`${ep}/v1/channels/${encodeURIComponent(ch.channelId)}`), 10000);
        if (stRes.ok) {
          const stBody = await stRes.json().catch(()=>null);
          const ls = stBody?.latestState;
          if (ls) {
            ch.nonce = Number(ls.stateNonce ?? ch.nonce ?? 0);
            ch.balA = String(ls.balA ?? ch.balA ?? "0");
            ch.balB = String(ls.balB ?? ch.balB ?? "0");
          }
        }
      } catch {}
    }
    const payId = `pay_${Date.now().toString(36)}`;
    const invoiceId = offer.invoiceId || `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
    const ctxHash = this.ethers.utils.keccak256(this.ethers.utils.defaultAbiCoder.encode(
      ["address","string","string","string"],
      [offer.payeeAddress||ZERO_ADDR, "GET", payId, invoiceId]
    ));

    opts.onStatus?.("Getting quote from hub…");
    const quoteExpiry = Math.floor(Date.now()/1000) + 120;
    const qRes = await withTimeout(fetch(`${ep}/v1/tickets/quote`, { method: "POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        invoiceId,
        paymentId: payId,
        channelId: ch.channelId,
        payee: offer.payeeAddress,
        asset: offer.asset,
        amount: offer.maxAmountRequired,
        maxFee: this.maxFee,
        quoteExpiry,
        contextHash: ctxHash
      }) }), 15000);
    if (!qRes.ok) {
      const err = await qRes.json().catch(()=>({}));
      throw new Error(err.error || err.message || `Quote failed: ${qRes.status}`);
    }
    const quote = await qRes.json();
    const totalDebit = quote.totalDebit || quote.ticketDraft?.totalDebit || quote.amount || offer.maxAmountRequired;

    // Build state
    let curA = BigInt(ch.balA||"0");
    const curB = BigInt(ch.balB||"0");
    const debit = BigInt(totalDebit||"0");
    if (curA < debit) {
      // If hub-side state shows lower balance than local cache, top up using
      // the configured prepay horizon (default 100 payments), not just one.
      await this.ensureChannelForOffer(offer, { topupPayments: opts.topupPayments||100, lowWaterPayments: opts.lowWaterPayments||10, onStatus: opts.onStatus });
      const ch2 = this.state.channels[chKey];
      curA = BigInt(ch2?.balA||"0");
      if (curA < debit) {
        throw new Error(`Insufficient channel balance (${fmtToken(curA.toString(), assetInfo.symbol)} < ${fmtToken(debit.toString(), assetInfo.symbol)})`);
      }
      ch.nonce = ch2.nonce;
      ch.balA = ch2.balA;
      ch.balB = ch2.balB;
    }
    const balA = (curA - debit).toString();
    const balB = (curB + debit).toString();
    const newState = {
      channelId: ch.channelId,
      stateNonce: (ch.nonce||0)+1,
      balA,
      balB,
      locksRoot: ZERO32,
      stateExpiry: Math.floor(Date.now()/1000) + 3600,
      contextHash: ctxHash
    };

    opts.onStatus?.("Signing channel state (EIP-712)…");
    const sigA = this.signState(newState, cid);

    opts.onStatus?.("Issuing ticket from hub…");
    const iRes = await withTimeout(fetch(`${ep}/v1/tickets/issue`, { method: "POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ quote, channelState: newState, sigA }) }), 15000);
    if (!iRes.ok) {
      const err = await iRes.json().catch(()=>({}));
      throw new Error(err.error || err.message || `Issue failed: ${iRes.status}`);
    }
    const issue = await iRes.json();
    const ticket = {
      ticketId: issue.ticketId,
      hub: issue.hub,
      payee: issue.payee,
      invoiceId: issue.invoiceId,
      paymentId: issue.paymentId,
      asset: issue.asset,
      amount: issue.amount,
      feeCharged: issue.feeCharged,
      totalDebit: issue.totalDebit,
      expiry: issue.expiry,
      policyHash: issue.policyHash,
      sig: issue.sig
    };
    const channelAck = issue.channelAck || {};
    if (!channelAck.stateHash) throw new Error("Hub issue response missing channelAck.stateHash");

    const payload = JSON.stringify({ scheme: "statechannel-hub-v1", paymentId: payId,
      invoiceId,
      ticket,
      channelProof: {
        channelId: newState.channelId,
        stateNonce: newState.stateNonce,
        stateHash: channelAck.stateHash,
        sigA,
        channelState: newState
      }
    });

    opts.onStatus?.("Retrying with payment signature…");
    const paidRes = await withTimeout(fetch(url, { method: "GET", headers: { "PAYMENT-SIGNATURE": payload } }), 15000);
    const response = await paidRes.json().catch(()=>({ status: paidRes.status }));

    if (paidRes.ok) { ch.nonce = newState.stateNonce; ch.balA = newState.balA; ch.balB = newState.balB; }
    this.state.payments.unshift({ url, amount: totalDebit, fee: quote.fee||"0", network: this.network, status: paidRes.ok?"completed":"failed",
      timestamp: Date.now(), route: "hub", ticketId: ticket.ticketId||ticket.id, payId, invoiceId });
    if (this.state.payments.length > 200) this.state.payments.length = 200;
    this.persistState();

    return { ok: paidRes.ok, status: paidRes.status, route: "hub", payId, amount: totalDebit, fee: quote.fee, response, ticket };
  }
}

// ═══════════════════════════════════════════════════════════════════
// APP
// ═══════════════════════════════════════════════════════════════════

function App() {
  const [ethersLib, setEthersLib] = useState(null);
  const [loading, setLoading] = useState(true);
  const [agent, setAgent] = useState(null);
  const [tab, setTab] = useState("wallet");
  const [toast, setToast] = useState(null);
  const [isMobile, setIsMobile] = useState(typeof window !== "undefined" ? window.innerWidth < 980 : false);
  const toastTimer = useRef(null);

  // Load fonts + ethers.js + global CSS
  useEffect(() => {
    const font = document.createElement("link");
    font.rel = "stylesheet";
    font.href = FONTS_CDN;
    document.head.appendChild(font);

    const style = document.createElement("style");
    style.textContent = `@keyframes spin{to{transform:rotate(360deg)}}@keyframes slideUp{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translate(-50%,0)}}@keyframes pulseGlow{0%,100%{opacity:.8}50%{opacity:1}}*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Instrument Sans',-apple-system,system-ui,sans-serif;background:#050608;color:#e4e7ed}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:3px}select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%237a8294' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:24px!important;cursor:pointer}input:focus,select:focus{border-color:rgba(0,255,171,.5)!important;box-shadow:0 0 0 2px rgba(0,255,171,.12)!important;outline:none}button:hover:not(:disabled){opacity:.95}button:disabled{opacity:.55;cursor:not-allowed}`;
    document.head.appendChild(style);

    const onResize = () => setIsMobile(window.innerWidth < 980);
    window.addEventListener("resize", onResize);
    onResize();

    let script = null;
    if (window.ethers) {
      setEthersLib(window.ethers);
      setLoading(false);
    } else {
      script = document.createElement("script");
      script.src = ETHERS_CDN;
      script.onload = () => { setEthersLib(window.ethers); setLoading(false); };
      script.onerror = () => setLoading(false);
      document.head.appendChild(script);
    }

    return () => {
      window.removeEventListener("resize", onResize);
      style.remove();
      font.remove();
      if (script) script.remove();
    };
  }, []);

  const notify = useCallback((msg, type="info") => {
    clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  if (loading) return <div style={S.loadWrap}><div style={S.loadSpin}/><span style={S.loadTxt}>Loading ethers.js…</span></div>;
  if (!ethersLib) return <div style={S.loadWrap}><span style={{...S.loadTxt,color:"#f87171"}}>Failed to load ethers.js</span></div>;

  const TABS = [
    { id:"wallet", label:"Wallet", icon:"◈" },
    { id:"channels", label:"Channels", icon:"⚡" },
    { id:"open", label:"Open", icon:"⛓" },
    { id:"discover", label:"Discover", icon:"◉" },
    { id:"pay", label:"Pay", icon:"→" },
    { id:"history", label:"History", icon:"▤" },
  ];

  const netName = agent ? (resolveNet(agent.network)?.name || agent.network) : "not set";
  const channelCount = agent ? Object.keys(agent.state.channels || {}).length : 0;
  const payCount = agent?.state?.payments?.length || 0;
  const latestPay = payCount ? agent.state.payments[0] : null;
  const shellStyle = isMobile ? { ...S.shell, ...S.shellMobile } : S.shell;
  const navStyle = isMobile ? { ...S.nav, ...S.navMobile } : S.nav;
  const navItemsStyle = isMobile ? { ...S.navItems, ...S.navItemsMobile } : S.navItems;
  const navFootStyle = isMobile ? { ...S.navFoot, ...S.navFootMobile } : S.navFoot;
  const mainStyle = isMobile ? { ...S.main, ...S.mainMobile } : S.main;

  return (
    <div style={S.root}>
      <div style={S.gridBg}/>
      <div style={{...S.glowOrb,...S.glowA}}/>
      <div style={{...S.glowOrb,...S.glowB}}/>
      <div style={shellStyle}>
        {/* Sidebar */}
        <nav style={navStyle}>
          <div style={S.brand}>
            <div style={S.logo}>402</div>
            <div><div style={S.brandName}>x402s</div><div style={S.brandSub}>SCP Light Agent</div></div>
          </div>
          <div style={navItemsStyle}>
            {TABS.map(t => (
              <button key={t.id} style={{...S.navBtn, ...(tab===t.id?S.navBtnOn:{})}} onClick={()=>setTab(t.id)}>
                <span style={S.navIco}>{t.icon}</span>{t.label}
              </button>
            ))}
          </div>
          <div style={navFootStyle}>
            <div style={{...S.dot, background: agent?"#10b981":"#ef4444", boxShadow: agent?"0 0 8px rgba(16,185,129,.5)":"none"}}/>
            <span style={S.navFootTxt}>{agent ? shortAddr(agent.address) : "Not configured"}</span>
          </div>
        </nav>

        {/* Main */}
        <main style={mainStyle}>
          <AgentOverview
            tab={tab}
            netName={netName}
            contract={agent?.contractAddress || DEFAULT_CONTRACT}
            address={agent?.address || ""}
            channels={channelCount}
            payments={payCount}
            latestPay={latestPay}
          />
          {tab==="wallet" && <WalletTab ethers={ethersLib} agent={agent} setAgent={setAgent} notify={notify}/>}
          {tab==="channels" && <ChannelsTab agent={agent} notify={notify}/>}
          {tab==="open" && <OpenTab agent={agent} notify={notify} setAgent={setAgent}/>}
          {tab==="discover" && <DiscoverTab agent={agent} notify={notify}/>}
          {tab==="pay" && <PayTab agent={agent} notify={notify} setAgent={setAgent}/>}
          {tab==="history" && <HistoryTab agent={agent} notify={notify}/>}
        </main>
      </div>

      {/* Toast */}
      {toast && <div style={{...S.toast, background: toast.type==="error"?"#dc2626":toast.type==="ok"?"#059669":"#3b82f6"}}>{toast.msg}</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// WALLET TAB
// ═══════════════════════════════════════════════════════════════════
function WalletTab({ ethers, agent, setAgent, notify }) {
  const [pk, setPk] = useState("");
  const [net, setNet] = useState("sepolia");
  const [contract, setContract] = useState("");
  const [customRpc, setCustomRpc] = useState("");
  const [bals, setBals] = useState(null);
  const [loadingBal, setLoadingBal] = useState(false);
  const [rpcStatus, setRpcStatus] = useState("");

  const initAgent = () => {
    if (!pk.trim()) return notify("Enter private key","error");
    try {
      const a = new SCPAgent(ethers, { privateKey: pk.trim(), network: net, contractAddress: contract.trim()||undefined, customRpc: customRpc.trim()||undefined });
      setAgent(a);
      setPk("");
      notify(`Agent initialized: ${shortAddr(a.address)}`,"ok");
    } catch (e) { notify(e.message,"error"); }
  };

  const fetchBal = async () => {
    if (!agent) return;
    setLoadingBal(true); setRpcStatus("Connecting to RPC…");
    try {
      setBals(await agent.getBalances());
      setRpcStatus("");
    } catch (e) {
      setRpcStatus("");
      notify(e.message,"error");
    }
    setLoadingBal(false);
  };

  const testRpc = async () => {
    if (!agent) return notify("Initialize agent first","error");
    setRpcStatus("Testing RPC connection…");
    agent._provider = null; // Force reconnect
    agent._providerTs = 0;
    if (customRpc.trim()) agent._customRpc = customRpc.trim();
    try {
      const p = await agent.getProvider();
      const block = await p.getBlockNumber();
      setRpcStatus(`✓ Connected — block ${block}`);
      notify("RPC connected","ok");
    } catch (e) {
      setRpcStatus(`✕ ${e.message}`);
      notify("RPC failed","error");
    }
  };

  useEffect(() => { if (agent) fetchBal(); }, [agent]);

  return (
    <div>
      <SectionHead title="Wallet Configuration" sub="Private key stays in browser memory only" />
      {agent && bals && (
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardLabel}>On-Chain Balances</span><Badge color="#10b981">{resolveNet(agent.network)?.name||agent.network}</Badge></div>
          <div style={S.mono}>{agent.address}</div>
          <div style={{...S.sep,margin:"10px 0"}}/>
          <Row label="ETH" value={parseFloat(bals.eth.formatted).toFixed(6)} />
          {Object.entries(bals.tokens).map(([sym,v]) => <Row key={sym} label={sym.toUpperCase()} value={v.formatted} />)}
          <button style={{...S.btn,background:"rgba(255,255,255,.04)",marginTop:12,width:"auto",padding:"6px 14px"}} onClick={fetchBal} disabled={loadingBal}>
            {loadingBal?"Loading…":"↻ Refresh"}
          </button>
        </div>
      )}
      <div style={S.card}>
        <Field label="Private Key" type="password" value={pk} onChange={setPk} placeholder="0x…" />
        <div style={S.warn}>⚠ Use a dedicated agent wallet or testnet key.</div>
        <div style={{display:"flex",gap:10}}>
          <Field label="Network" type="select" value={net} onChange={setNet} options={Object.keys(NETWORKS)} half />
          <Field label="Contract" value={contract} onChange={setContract} placeholder={shortAddr(DEFAULT_CONTRACT)} half />
        </div>
        <Field label="Custom RPC (optional, recommended)" value={customRpc} onChange={setCustomRpc} placeholder="https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY" />
        <div style={{fontSize:10,color:"#52525b",marginTop:-6,marginBottom:10,lineHeight:1.4}}>
          Public RPCs may have CORS issues or rate limits. Use Alchemy, Infura, or QuickNode for reliability.
        </div>
        {rpcStatus && <div style={{fontSize:11,color: rpcStatus.startsWith("✓")?"#10b981":rpcStatus.startsWith("✕")?"#f87171":"#71717a",marginBottom:8,fontFamily:"monospace",whiteSpace:"pre-wrap",lineHeight:1.4}}>{rpcStatus}</div>}
        <div style={{display:"flex",gap:8}}>
          <button style={S.btnP} onClick={initAgent}>Initialize Agent</button>
        </div>
        {agent && <button style={{...S.btn,marginTop:8}} onClick={testRpc}>Test RPC Connection</button>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CHANNELS TAB
// ═══════════════════════════════════════════════════════════════════
function ChannelsTab({ agent, notify }) {
  const [hubUrl, setHubUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [fundInputs, setFundInputs] = useState({});
  const [fundingKey, setFundingKey] = useState("");
  const [fundStatus, setFundStatus] = useState("");
  const [, forceRender] = useState(0);
  const channels = agent ? Object.entries(agent.state.channels).map(([k,v])=>({key:k,...v})) : [];

  const getChannelSym = (ch) => {
    if (!ch) return "eth";
    if (ch.asset === ZERO_ADDR) return "eth";
    const guess = (ch.assetSymbol || guessAssetSym({ asset: ch.asset }) || "eth").toLowerCase();
    return guess === "token" ? "eth" : guess;
  };

  const fundChannel = async (ch) => {
    if (!agent || !ch?.channelId) return;
    const h = String(fundInputs[ch.key] || "").trim();
    if (!h) return notify("Enter amount to fund","error");

    const sym = getChannelSym(ch);
    const dec = DECIMALS[sym] || 18;
    let raw = "";
    try {
      raw = agent.ethers.utils.parseUnits(h, dec).toString();
    } catch {
      return notify("Invalid fund amount","error");
    }
    if (!raw || raw === "0") return notify("Amount must be greater than 0","error");

    setFundingKey(ch.key);
    setFundStatus(`Funding ${shortHash(ch.channelId)}…`);
    try {
      const res = await agent.fundChannel(ch.channelId, raw);
      const cur = agent.state.channels[ch.key];
      if (cur) {
        cur.balA = (BigInt(cur.balA || "0") + BigInt(raw)).toString();
        cur.txHash = res.txHash || cur.txHash;
        cur.lastFundedAt = Date.now();
      }
      agent.persistState?.();
      setFundInputs(prev => ({ ...prev, [ch.key]: "" }));
      setFundStatus("");
      notify("Channel funded","ok");
      forceRender(n=>n+1);
    } catch (e) {
      setFundStatus("");
      notify(e.message,"error");
    }
    setFundingKey("");
  };

  const importCh = async () => {
    if (!agent || !hubUrl.trim()) return;
    setImporting(true);
    try {
      const ep = normalizeEndpoint(hubUrl);
      const chKey = `hub:${ep}`;
      if (agent.state.channels[chKey]) { notify("Already registered"); setImporting(false); return; }
      const infoRes = await withTimeout(fetch(`${ep}/.well-known/x402`), 10000);
      if (!infoRes.ok) throw new Error(`Hub returned ${infoRes.status}`);
      const info = await infoRes.json();
      let imported = null;

      // Legacy hub API (if available)
      try {
        const chanRes = await withTimeout(fetch(`${ep}/v1/channels?payer=${agent.address}`), 8000);
        if (chanRes.ok) {
          const data = await chanRes.json();
          const chs = data.channels || data;
          if (Array.isArray(chs) && chs.length) {
            const ch = chs[0];
            imported = {
              channelId: ch.channelId,
              participantB: info.address,
              asset: ch.asset || ZERO_ADDR,
              nonce: ch.stateNonce || 0,
              balA: ch.balA || "0",
              balB: ch.balB || "0",
              hubEndpoint: ep
            };
          }
        }
      } catch {}

      // Current API: discover channelId on-chain from ChannelOpened logs,
      // then fetch latest off-chain state from /v1/channels/:channelId.
      if (!imported) {
        if (!info.address) throw new Error("Hub address missing in .well-known/x402");
        const hubAddr = agent.ethers.utils.getAddress(info.address);
        const payerAddr = agent.ethers.utils.getAddress(agent.address);
        const p = await agent.getProvider();
        const c = new agent.ethers.Contract(agent.contractAddress, CHANNEL_ABI, p);
        const filter = c.filters.ChannelOpened(null, payerAddr, hubAddr);
        const latestBlock = await withTimeout(p.getBlockNumber(), 10000);
        let step = 9000; // keep under common 10k RPC log-window caps
        let found = null;
        for (let to = latestBlock; to >= 0 && !found;) {
          const from = Math.max(0, to - step + 1);
          try {
            const logs = await withTimeout(c.queryFilter(filter, from, to), 12000);
            if (logs.length) found = logs[logs.length - 1];
            to = from - 1;
          } catch (e) {
            const m = String(e?.reason || e?.error?.message || e?.message || e);
            // Some RPCs reject wide eth_getLogs ranges; shrink and retry same window.
            if (/eth_getlogs|block(?:s)? range|limited to|more than/i.test(m) && step > 1000) {
              step = Math.max(1000, Math.floor(step / 2));
              continue;
            }
            throw e;
          }
        }
        if (!found) throw new Error("No on-chain channel found for this payer+hub");
        const channelId = found?.args?.channelId || found?.args?.[0];
        if (!channelId || channelId === ZERO32) throw new Error("Invalid discovered channelId");

        let latest = null;
        try {
          const chRes = await withTimeout(fetch(`${ep}/v1/channels/${encodeURIComponent(channelId)}`), 10000);
          if (chRes.ok) latest = await chRes.json();
        } catch {}
        const st = latest?.latestState || {};
        imported = {
          channelId,
          participantB: hubAddr,
          asset: st.asset || latest?.asset || ZERO_ADDR,
          assetSymbol: guessAssetSym({ asset: st.asset || latest?.asset || ZERO_ADDR }).toLowerCase(),
          nonce: Number(st.stateNonce ?? latest?.latestNonce ?? 0),
          balA: String(st.balA ?? "0"),
          balB: String(st.balB ?? "0"),
          hubEndpoint: ep
        };
      }

      agent.state.channels[chKey] = imported;
      agent.persistState?.();
      notify("Channel imported","ok");
      forceRender(n=>n+1);
    } catch (e) { notify(e.message,"error"); }
    setImporting(false);
  };

  return (
    <div>
      <SectionHead title="State Channels" sub={`${channels.length} registered`} />
      {channels.length === 0 && <Empty icon="⚡" text="No channels. Open one or import from hub." />}
      {channels.map(ch => (
        <div key={ch.key} style={S.card}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{...S.mono,fontSize:11,maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ch.key}</span>
            <span style={{fontWeight:700,color:"#10b981",fontSize:14}}>{ch.balA||"0"} <span style={{fontSize:10,color:"#71717a"}}>{ch.assetSymbol?.toUpperCase()||"?"}</span></span>
          </div>
          <div style={{fontSize:10,color:"#52525b",fontFamily:"monospace",marginTop:4}}>
            nonce {ch.nonce||0} · {ch.channelId ? shortHash(ch.channelId) : "—"}{ch.txHash ? ` · tx:${shortHash(ch.txHash)}` : ""}
          </div>
          {!!ch.channelId && (
            <div style={{marginTop:10}}>
              <div style={{display:"flex",gap:8}}>
                <input
                  style={{...S.input, marginBottom:0}}
                  value={fundInputs[ch.key] || ""}
                  onChange={e=>setFundInputs(prev => ({ ...prev, [ch.key]: e.target.value }))}
                  placeholder={`Fund amount (${getChannelSym(ch).toUpperCase()})`}
                />
                <button
                  style={{...S.btn, width:"auto", padding:"9px 14px", whiteSpace:"nowrap"}}
                  onClick={()=>fundChannel(ch)}
                  disabled={!agent || fundingKey === ch.key}
                >
                  {fundingKey === ch.key ? "Funding…" : "Fund"}
                </button>
              </div>
              <div style={{fontSize:10,color:"#71717a",marginTop:6}}>
                Top up this channel manually. Amount is human units (e.g. `0.01` ETH or `10` USDC).
              </div>
            </div>
          )}
        </div>
      ))}
      {fundStatus && <Progress text={fundStatus} />}
      <div style={{...S.sep,margin:"18px 0"}}/>
      <SectionHead title="Import from Hub" />
      <Field label="Hub Endpoint" value={hubUrl} onChange={setHubUrl} placeholder="http://159.223.150.70/hub/sepolia" />
      <button style={S.btn} onClick={importCh} disabled={importing||!agent}>{importing?"Importing…":"Import Channel"}</button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// OPEN CHANNEL TAB
// ═══════════════════════════════════════════════════════════════════
function OpenTab({ agent, notify, setAgent }) {
  const [hubUrl, setHubUrl] = useState("");
  const [hubInfo, setHubInfo] = useState(null);
  const [peer, setPeer] = useState("");
  const [asset, setAsset] = useState("usdc");
  const [amtH, setAmtH] = useState("");
  const [challenge, setChallenge] = useState("86400");
  const [expiry, setExpiry] = useState("2592000");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [, forceRender] = useState(0);

  const rawAmt = (() => { try { return amtH ? humanToRaw(amtH, DECIMALS[asset]||18) : ""; } catch { return ""; } })();

  const discover = async () => {
    if (!agent || !hubUrl.trim()) return;
    setStatus("Discovering…");
    try {
      const r = await withTimeout(fetch(`${hubUrl.trim()}/.well-known/x402`), 10000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const info = await r.json();
      setHubInfo(info);
      if (info.address) setPeer(info.address);
      setStatus("");
      notify("Hub discovered","ok");
    } catch (e) { setStatus(""); notify(e.message,"error"); }
  };

  const open = async () => {
    if (!agent || !peer || !amtH || !String(amtH).trim()) return;
    let amountRaw;
    try {
      amountRaw = agent.ethers.utils.parseUnits(String(amtH).trim(), DECIMALS[asset] || 18).toString();
    } catch (e) {
      notify("Invalid amount", "error");
      return;
    }
    if (!amountRaw || amountRaw === "0") {
      notify("Amount must be greater than 0", "error");
      return;
    }
    setBusy(true); setResult(null); setStatus("Checking allowance…");
    try {
      setStatus("Sending openChannel tx…");
      const res = await agent.openChannel(peer, asset, amountRaw, { challengePeriodSec: parseInt(challenge), channelExpirySec: parseInt(expiry) });
      const ep = normalizeEndpoint(hubUrl);
      const chKey = ep ? `hub:${ep}` : `onchain:${res.channelId}`;
      agent.state.channels[chKey] = { channelId: res.channelId, participantB: res.participantB, asset: res.asset, assetSymbol: res.sym, nonce: 0, balA: amountRaw, balB: "0", hubEndpoint: ep||null, txHash: res.txHash, openedAt: Date.now() };
      agent.persistState?.();
      setResult(res);
      setStatus("");
      notify("Channel opened on-chain!","ok");
      forceRender(n=>n+1);
    } catch (e) { setStatus(""); notify(e.message,"error"); }
    setBusy(false);
  };

  return (
    <div>
      <SectionHead title="Open Channel On-Chain" sub="Approve + openChannel in one flow" />
      <div style={S.card}>
        <Field label="Hub Endpoint (optional)" value={hubUrl} onChange={setHubUrl} placeholder="http://159.223.150.70/hub/sepolia" />
        <button style={S.btn} onClick={discover} disabled={!agent||!hubUrl.trim()}>Discover Hub</button>
        {hubInfo && (
          <div style={{...S.infoBox,marginTop:10}}>
            <Row label="Hub" value={hubInfo.hubName||hubInfo.name||"SCP Hub"} />
            <Row label="Address" value={shortAddr(hubInfo.address)} mono />
            <Row label="Fee" value={hubInfo.fee ? `base=${hubInfo.fee.base||0} bps=${hubInfo.fee.bps||0}` : "—"} />
          </div>
        )}
      </div>
      <div style={S.card}>
        <Field label="Counterparty Address" value={peer} onChange={setPeer} placeholder="0x…" />
        <div style={{display:"flex",gap:10}}>
          <Field label="Asset" type="select" value={asset} onChange={setAsset} options={["usdc","eth","usdt"]} half />
          <Field label="Amount (human)" value={amtH} onChange={setAmtH} placeholder="10.00" half />
        </div>
        <Field label="Amount (raw)" value={rawAmt} readOnly />
        <div style={{display:"flex",gap:10}}>
          <Field label="Challenge" type="select" value={challenge} onChange={setChallenge} options={[{v:"86400",l:"1 day"},{v:"259200",l:"3 days"},{v:"604800",l:"7 days"}]} half />
          <Field label="Expiry" type="select" value={expiry} onChange={setExpiry} options={[{v:"2592000",l:"30 days"},{v:"7776000",l:"90 days"},{v:"15552000",l:"180 days"}]} half />
        </div>
        {status && <Progress text={status} />}
        {result && (
          <div style={S.resultBox}>
            <div style={{color:"#10b981",fontWeight:600,marginBottom:4}}>✓ Channel Opened</div>
            <Row label="Channel" value={shortHash(result.channelId)} mono />
            <Row label="Tx" value={shortHash(result.txHash)} mono />
            <Row label="Block" value={result.blockNumber} />
          </div>
        )}
        <button style={S.btnP} onClick={open} disabled={busy||!agent||!peer||!amtH||!String(amtH).trim()}>{busy?"Opening…":"Open Channel On-Chain"}</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// DISCOVER TAB
// ═══════════════════════════════════════════════════════════════════
function DiscoverTab({ agent, notify }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [offers, setOffers] = useState([]);
  const [scored, setScored] = useState([]);
  const [bestIdx, setBestIdx] = useState(-1);
  const [analysis, setAnalysis] = useState(null);
  const [selIdx, setSelIdx] = useState(-1);

  const discover = async () => {
    if (!agent || !url.trim()) return;
    setBusy(true); setOffers([]); setScored([]); setAnalysis(null);
    try {
      const disc = await agent.discoverOffers(url.trim());
      if (disc.status !== 402) { notify(`Got ${disc.status}, not 402`); setBusy(false); return; }
      if (!disc.offers.length) { notify("No offers found"); setBusy(false); return; }
      setOffers(disc.offers);
      const sc = agent.scoreOffers(disc.offers);
      setScored(sc);
      const best = agent.chooseOffer(disc.offers, "auto");
      const bi = best ? disc.offers.indexOf(best) : 0;
      setBestIdx(bi);
      setSelIdx(bi);
      notify(`${disc.offers.length} offers found`,"ok");
    } catch (e) { notify(e.message,"error"); }
    setBusy(false);
  };

  const analyze = async () => {
    if (!agent || selIdx < 0 || !offers[selIdx]) return;
    setAnalysis(null);
    try {
      const a = await agent.analyzeOffer(offers[selIdx]);
      setAnalysis(a);
    } catch (e) { notify(e.message,"error"); }
  };

  return (
    <div>
      <SectionHead title="Discover 402 Offers" sub="Enter a 402-protected URL to see payment options" />
      <div style={S.card}>
        <Field label="URL" value={url} onChange={setUrl} placeholder="http://159.223.150.70/meow" />
        <button style={S.btnP} onClick={discover} disabled={busy||!agent||!url.trim()}>{busy?"Discovering…":"Discover Offers"}</button>
      </div>
      {scored.length > 0 && (
        <>
          <div style={{fontSize:12,color:"#71717a",margin:"12px 0 6px"}}>
            {scored.length} offer{scored.length!==1?"s":""} · {scored.filter(s=>s.status==="ready").length} ready · {scored.filter(s=>s.route==="hub").length} hub · {scored.filter(s=>s.route==="direct").length} direct
          </div>
          {scored.map(s => {
            const o = s.offer;
            const sym = guessAssetSym(o);
            const isSel = s.idx === selIdx;
            const isBest = s.idx === bestIdx;
            return (
              <div key={s.idx} onClick={()=>setSelIdx(s.idx)} style={{...S.card, cursor:"pointer",
                borderColor: isSel ? "rgba(99,102,241,.5)" : "rgba(255,255,255,.04)",
                background: isSel ? "rgba(99,102,241,.06)" : "rgba(255,255,255,.015)",
                boxShadow: isSel ? "0 0 0 1px rgba(99,102,241,.2)" : "none" }}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                    <Badge color="#3b82f6">{shortNetLabel(o.network)}</Badge>
                    <Badge color="#10b981">{s.route}</Badge>
                    <Badge color={s.status==="ready"?"#10b981":s.status==="underfunded"?"#f59e0b":"#ef4444"}>{s.status==="ready"?"Ready":s.status==="underfunded"?"Low":"No Ch"}</Badge>
                    {isBest && <Badge color="#eab308">★ Best</Badge>}
                  </div>
                  <div style={{fontSize:18,fontWeight:700,letterSpacing:"-.03em"}}>{fmtToken(o.maxAmountRequired, sym)} <span style={{fontSize:11,color:"#71717a"}}>{sym}</span></div>
                </div>
                {s.score > 0 && <div style={{fontSize:10,color:"#52525b",fontFamily:"monospace",marginTop:4}}>Channel bal: {s.chBal}</div>}
                {!s.matchNet && <div style={{fontSize:10,color:"#f59e0b",marginTop:3}}>⚠ Network mismatch</div>}
              </div>
            );
          })}
          <button style={{...S.btn,marginTop:8}} onClick={analyze} disabled={selIdx<0||!agent}>Analyze Selected Offer</button>
          {analysis && <AnalysisCard a={analysis} />}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PAY TAB
// ═══════════════════════════════════════════════════════════════════
function PayTab({ agent, notify, setAgent }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState(null);
  const [, forceRender] = useState(0);

  const pay = async () => {
    if (!agent || !url.trim()) return;
    setBusy(true); setResult(null); setStatus("Discovering offers…");
    try {
      const res = await agent.payUrl(url.trim(), { route: "auto", topupPayments: 100, lowWaterPayments: 10, onStatus: setStatus });
      setResult(res);
      setStatus("");
      notify(res.ok ? "Payment successful!" : "Payment failed","ok");
      forceRender(n=>n+1);
    } catch (e) { setStatus(""); notify(e.message,"error"); }
    setBusy(false);
  };

  return (
    <div>
      <SectionHead title="Pay 402 URL" sub="Full flow: discover → channel setup → sign → pay" />
      <div style={S.card}>
        <Field label="402-Protected URL" value={url} onChange={setUrl} placeholder="http://159.223.150.70/meow" />
        {status && <Progress text={status} />}
        {result && (
          <div style={{...S.resultBox, borderColor: result.ok ? "rgba(16,185,129,.2)" : "rgba(239,68,68,.2)"}}>
            <div style={{color: result.ok ? "#10b981" : "#ef4444", fontWeight: 600, marginBottom: 4}}>{result.ok ? "✓ Payment Complete" : "✕ Payment Failed"}</div>
            <Row label="Amount" value={fmtToken(result.amount, "usdc")} />
            <Row label="Fee" value={result.fee||"0"} />
            <Row label="Route" value={result.route} />
            {result.ticket && <Row label="Ticket" value={shortHash(result.ticket.id || result.ticket.ticketId || "—")} mono />}
            <Row label="Status" value={result.status} />
          </div>
        )}
        <button style={S.btnP} onClick={pay} disabled={busy||!agent||!url.trim()}>{busy?"Paying…":"Pay URL"}</button>
      </div>
      <div style={{fontSize:11,color:"#52525b",marginTop:8,lineHeight:1.5}}>
        This executes the full SCP light agent flow: discover offers → score & pick best → auto-open/fund channel if needed → EIP-712 sign state → get hub ticket → retry with payment header.
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// HISTORY TAB
// ═══════════════════════════════════════════════════════════════════
function HistoryTab({ agent, notify }) {
  const payments = agent?.state.payments || [];
  const clear = () => {
    if (agent) {
      agent.state.payments = [];
      agent.persistState?.();
      notify("Cleared","ok");
    }
  };
  return (
    <div>
      <SectionHead title="Payment History" sub={`${payments.length} payment${payments.length!==1?"s":""}`} />
      {payments.length === 0 && <Empty icon="▤" text="No payments yet. Use Pay tab." />}
      {payments.map((p,i) => (
        <div key={i} style={S.card}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{...S.hiIco, background: p.status==="completed" ? "rgba(16,185,129,.1)" : "rgba(239,68,68,.1)",
              color: p.status==="completed" ? "#10b981" : "#ef4444"}}>{p.status==="completed"?"✓":"✕"}</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:12,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.url}</div>
              <div style={{fontSize:10,color:"#52525b",fontFamily:"monospace"}}>{ago(p.timestamp)} · {p.network} · {p.route} · fee:{p.fee||"0"}</div>
            </div>
            <div style={{fontSize:13,fontWeight:700,whiteSpace:"nowrap"}}>{fmtToken(p.amount,"usdc")}</div>
          </div>
        </div>
      ))}
      {payments.length > 0 && <button style={{...S.btn,background:"rgba(239,68,68,.06)",color:"#f87171",border:"1px solid rgba(239,68,68,.12)",marginTop:8}} onClick={clear}>Clear History</button>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SHARED COMPONENTS
// ═══════════════════════════════════════════════════════════════════
function AgentOverview({ tab, netName, contract, address, channels, payments, latestPay }) {
  const tabLabel = tab === "discover" ? "Offer Discovery" : tab === "pay" ? "Payment Execution" : tab === "open" ? "On-Chain Channel Ops" : tab === "channels" ? "Channel Registry" : tab === "history" ? "Signed Payment History" : "Wallet + RPC Control";
  return (
    <div style={S.hero}>
      <div style={S.heroTop}>
        <div>
          <div style={S.heroEyebrow}>State Channel Control Plane</div>
          <h1 style={S.heroTitle}>x402s SCP Agent</h1>
          <p style={S.heroSub}>Discover 402 offers, verify funding plans, and submit signed channel state for instant access.</p>
        </div>
        <div style={S.heroTab}>{tabLabel}</div>
      </div>
      <div style={S.heroGrid}>
        <div style={S.heroCell}><span style={S.heroK}>Network</span><span style={S.heroV}>{String(netName).toUpperCase()}</span></div>
        <div style={S.heroCell}><span style={S.heroK}>Channels</span><span style={S.heroV}>{channels}</span></div>
        <div style={S.heroCell}><span style={S.heroK}>Payments</span><span style={S.heroV}>{payments}</span></div>
        <div style={S.heroCell}><span style={S.heroK}>Contract</span><span style={{...S.heroV,...S.heroMono}}>{shortAddr(contract)}</span></div>
      </div>
      <div style={S.heroFoot}>
        <span style={{...S.heroMono, color:"#7a8294"}}>{address ? `Agent ${shortAddr(address)}` : "Agent not initialized"}</span>
        {latestPay && <span style={{...S.heroMono, color:"#7a8294"}}>last {fmtToken(latestPay.amount, "usdc")} · {ago(latestPay.timestamp)}</span>}
      </div>
    </div>
  );
}
function SectionHead({ title, sub }) {
  return <div style={{marginBottom:16}}><h2 style={S.h2}>{title}</h2>{sub && <p style={S.sub}>{sub}</p>}</div>;
}
function Field({ label, value, onChange, placeholder, type, options, half, readOnly }) {
  const wrap = { marginBottom: 10, flex: half ? 1 : undefined };
  if (type === "select") {
    return <div style={wrap}><label style={S.label}>{label}</label>
      <select style={S.input} value={value} onChange={e=>onChange(e.target.value)}>
        {(options||[]).map(o => typeof o==="string" ? <option key={o} value={o}>{o}</option> : <option key={o.v} value={o.v}>{o.l}</option>)}
      </select></div>;
  }
  return <div style={wrap}><label style={S.label}>{label}</label>
    <input style={{...S.input,opacity:readOnly?0.6:1}} type={type||"text"} value={value} onChange={e=>onChange?.(e.target.value)} placeholder={placeholder} readOnly={readOnly}/></div>;
}
function Row({ label, value, mono }) {
  return <div style={S.row}><span style={S.rowL}>{label}</span><span style={{...S.rowV,...(mono?{fontFamily:"monospace"}:{})}}>{value}</span></div>;
}
function Badge({ children, color }) {
  return <span style={{fontSize:9,fontWeight:600,textTransform:"uppercase",letterSpacing:".05em",padding:"2px 6px",borderRadius:4,background:`${color}18`,color}}>{children}</span>;
}
function Empty({ icon, text }) {
  return <div style={{textAlign:"center",padding:"36px 20px",color:"#3f3f46"}}><div style={{fontSize:28,marginBottom:6,opacity:.4}}>{icon}</div><div style={{fontSize:12}}>{text}</div></div>;
}
function Progress({ text }) {
  return <div style={S.prog}><div style={S.spin}/><span>{text}</span></div>;
}
function AnalysisCard({ a }) {
  const f = a.funding, o = a.offer;
  const w = a.walBal;
  const ethBal = w?.eth?.formatted ? parseFloat(w.eth.formatted).toFixed(6) : "?";
  const tokenBals = Object.entries(w?.tokens||{}).map(([s,v])=>`${v.formatted} ${s.toUpperCase()}`).join(", ");
  return (
    <div style={{...S.card,marginTop:10,borderColor: f.ready ? "rgba(16,185,129,.2)" : "rgba(245,158,11,.2)"}}>
      <div style={{fontWeight:600,fontSize:13,marginBottom:8,color: f.ready?"#10b981":"#f59e0b"}}>{f.ready ? "✓ Channel Ready" : f.needsOpen ? "⚡ Channel Needed (Open)" : "⚡ Channel Underfunded"}</div>
      <Row label="Hub" value={a.hubName || shortAddr(a.hubEndpoint)||"—"} />
      <Row label="Network" value={o.network||"?"} />
      <Row label="Asset" value={o.sym?.toUpperCase()||"?"} />
      <Row label="Per-payment" value={`${fmtToken(o.perPay,o.sym)} (amt ${fmtToken(o.amount,o.sym)} + fee ${fmtToken(o.fee,o.sym)})`} />
      <Row label="Prepay for" value={`${f.topup} payments`} />
      <Row label="Refill when below" value={`${f.lowWater||10} payments (${fmtToken(f.refillAt||"0", o.sym)})`} />
      <Row label="Channel bal" value={fmtToken(f.curBal, o.sym)} />
      {!f.ready && <Row label="Additional needed" value={fmtToken(f.needed, o.sym)} />}
      <div style={{...S.infoBox,marginTop:8,background:"rgba(59,130,246,.04)",borderColor:"rgba(59,130,246,.1)"}}>
        <div style={{fontSize:9,fontWeight:600,color:"#60a5fa",textTransform:"uppercase",letterSpacing:".05em",marginBottom:2}}>Wallet</div>
        <div style={{fontSize:11,color:"#a1a1aa",fontFamily:"monospace"}}>{ethBal} ETH{tokenBals ? " · " + tokenBals : ""}</div>
      </div>
    </div>
  );
}
function shortNetLabel(n) {
  if (!n) return "?";
  const s = String(n).toLowerCase();
  if (s.includes("84532")||s==="base-sepolia") return "BaseSep";
  if (s.includes("8453")||s==="base") return "Base";
  if (s.includes("11155111")||s==="sepolia") return "Sepolia";
  if ((s.includes(":1")&&!s.includes("11"))||s==="mainnet") return "Mainnet";
  return n.length>14?n.slice(0,11)+"…":n;
}

// ═══════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════
const S = {
  root: { position:"relative", minHeight:"100vh", background:"#050608", color:"#e4e7ed", fontFamily:"'Instrument Sans',-apple-system,system-ui,sans-serif" },
  gridBg: {
    position:"fixed", inset:0, pointerEvents:"none", zIndex:0, opacity:.45,
    backgroundImage:"linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px)",
    backgroundSize:"52px 52px", maskImage:"radial-gradient(ellipse 78% 62% at 50% 18%, black 0%, transparent 72%)"
  },
  glowOrb: { position:"fixed", borderRadius:"50%", pointerEvents:"none", filter:"blur(100px)", zIndex:0 },
  glowA: { width:540, height:540, background:"radial-gradient(circle, rgba(0,255,171,.14) 0%, rgba(0,255,171,0) 70%)", top:-180, left:"44%" },
  glowB: { width:500, height:500, background:"radial-gradient(circle, rgba(88,166,255,.13) 0%, rgba(88,166,255,0) 70%)", top:120, right:-170 },
  shell: { position:"relative", zIndex:1, display:"flex", minHeight:"100vh", maxWidth:1240, margin:"0 auto" },
  shellMobile: { display:"block", maxWidth:860 },
  nav: {
    width:230, borderRight:"1px solid #151a21", padding:"20px 14px", display:"flex", flexDirection:"column", flexShrink:0,
    position:"sticky", top:0, height:"100vh", backdropFilter:"blur(14px) saturate(1.2)", background:"rgba(6,8,12,.75)"
  },
  navMobile: { width:"100%", height:"auto", position:"sticky", top:0, padding:"14px 12px", borderRight:"none", borderBottom:"1px solid #151a21", zIndex:12 },
  brand: { display:"flex", alignItems:"center", gap:10, marginBottom:24 },
  logo: {
    width:36, height:36, borderRadius:10, border:"1px solid rgba(0,255,171,.32)", background:"linear-gradient(150deg,#0d1518,#06100d)",
    display:"flex", alignItems:"center", justifyContent:"center", fontWeight:700, fontSize:11, color:"#00ffab",
    fontFamily:"'DM Mono',monospace", letterSpacing:"-0.04em", boxShadow:"0 0 20px rgba(0,255,171,.18)"
  },
  brandName: { fontSize:17, fontWeight:700, letterSpacing:"-0.02em", fontFamily:"'Bricolage Grotesque','Instrument Sans',sans-serif" },
  brandSub: { fontSize:10, color:"#7a8294", fontWeight:500, letterSpacing:".04em", textTransform:"uppercase" },
  navItems: { flex:1, display:"flex", flexDirection:"column", gap:4 },
  navItemsMobile: { flexDirection:"row", flexWrap:"wrap", gap:6, marginBottom:6 },
  navBtn: {
    display:"flex", alignItems:"center", gap:9, padding:"9px 12px", background:"transparent", border:"1px solid transparent", borderRadius:8,
    color:"#7a8294", fontSize:12.5, fontWeight:500, cursor:"pointer", fontFamily:"inherit", textAlign:"left", transition:"all .14s"
  },
  navBtnOn: { background:"rgba(0,255,171,.08)", color:"#d8fff2", borderColor:"rgba(0,255,171,.2)", boxShadow:"inset 0 0 0 1px rgba(0,255,171,.08)" },
  navIco: { fontSize:13, width:18, textAlign:"center", opacity:.85 },
  navFoot: { display:"flex", alignItems:"center", gap:8, padding:"12px 4px", borderTop:"1px solid #151a21" },
  navFootMobile: { borderTop:"none", paddingTop:2 },
  dot: { width:7, height:7, borderRadius:"50%", flexShrink:0, animation:"pulseGlow 1.6s ease-in-out infinite" },
  navFootTxt: { fontSize:10, color:"#7a8294", fontFamily:"'DM Mono',monospace" },
  main: { flex:1, padding:"28px 34px 42px", maxWidth:780, overflow:"auto" },
  mainMobile: { maxWidth:"100%", padding:"18px 14px 28px" },
  hero: {
    background:"linear-gradient(165deg, rgba(10,13,18,.94), rgba(8,10,15,.78))", border:"1px solid #1a212c", borderRadius:14,
    padding:"16px 18px 14px", marginBottom:16, boxShadow:"0 18px 42px rgba(0,0,0,.35)"
  },
  heroTop: { display:"flex", justifyContent:"space-between", gap:14, alignItems:"flex-start", flexWrap:"wrap" },
  heroEyebrow: { fontSize:10, color:"#00ffab", textTransform:"uppercase", letterSpacing:".1em", fontFamily:"'DM Mono',monospace", marginBottom:5 },
  heroTitle: { fontSize:27, lineHeight:1, letterSpacing:"-0.04em", marginBottom:7, fontFamily:"'Bricolage Grotesque','Instrument Sans',sans-serif" },
  heroSub: { fontSize:12.5, color:"#9ba6bc", maxWidth:540, lineHeight:1.45 },
  heroTab: {
    fontSize:10.5, color:"#7a8294", border:"1px solid #242d3a", borderRadius:8, padding:"6px 8px",
    textTransform:"uppercase", letterSpacing:".07em", fontFamily:"'DM Mono',monospace"
  },
  heroGrid: { display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))", gap:8, marginTop:12 },
  heroCell: { background:"rgba(255,255,255,.02)", border:"1px solid #1a212c", borderRadius:8, padding:"8px 10px", display:"flex", flexDirection:"column", gap:4 },
  heroK: { fontSize:9, color:"#6d7890", textTransform:"uppercase", letterSpacing:".08em", fontFamily:"'DM Mono',monospace" },
  heroV: { fontSize:13, color:"#e4e7ed", fontWeight:600 },
  heroMono: { fontFamily:"'DM Mono',monospace", fontSize:11.5 },
  heroFoot: { marginTop:10, borderTop:"1px solid #151a21", paddingTop:10, display:"flex", justifyContent:"space-between", gap:10, flexWrap:"wrap" },
  card: { background:"linear-gradient(165deg, rgba(11,14,20,.95), rgba(9,12,18,.82))", border:"1px solid #19202b", borderRadius:12, padding:"14px 16px", marginBottom:10, boxShadow:"0 10px 30px rgba(0,0,0,.22)" },
  cardHead: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 },
  cardLabel: { fontSize:9.5, fontWeight:600, color:"#6d7890", textTransform:"uppercase", letterSpacing:".08em", fontFamily:"'DM Mono',monospace" },
  h2: { fontSize:20, fontWeight:700, letterSpacing:"-0.03em", color:"#f5f7fb", margin:0, fontFamily:"'Bricolage Grotesque','Instrument Sans',sans-serif" },
  sub: { fontSize:12, color:"#7a8294", marginTop:4, lineHeight:1.45 },
  label: { display:"block", fontSize:9.5, fontWeight:600, color:"#6d7890", textTransform:"uppercase", letterSpacing:".08em", marginBottom:4, fontFamily:"'DM Mono',monospace" },
  input: { width:"100%", padding:"9px 10px", background:"rgba(255,255,255,.02)", border:"1px solid #1f2733", borderRadius:7, color:"#e4e7ed", fontFamily:"'DM Mono',monospace", fontSize:11.5, outline:"none" },
  btn: {
    width:"100%", padding:"9px 16px", background:"rgba(255,255,255,.03)", border:"1px solid #243041", borderRadius:8,
    color:"#b7bfce", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"inherit", transition:"all .14s"
  },
  btnP: {
    width:"100%", padding:"10px 16px", background:"linear-gradient(135deg,#00d593,#1f8fff)", border:"none", borderRadius:8, color:"#02130e",
    fontSize:12.5, fontWeight:700, cursor:"pointer", fontFamily:"inherit", boxShadow:"0 8px 28px rgba(0,255,171,.2)", transition:"all .15s", marginTop:4
  },
  mono: { fontFamily:"'DM Mono',monospace", fontSize:11.5, color:"#b7bfce", wordBreak:"break-all" },
  sep: { height:1, background:"#171d28" },
  row: { display:"flex", justifyContent:"space-between", gap:10, padding:"4px 0", fontSize:11.5 },
  rowL: { color:"#7a8294", fontWeight:500 },
  rowV: { color:"#e4e7ed", textAlign:"right", wordBreak:"break-word" },
  warn: { fontSize:10, color:"#ffb86c", margin:"4px 0 10px", lineHeight:1.4 },
  infoBox: { background:"rgba(255,255,255,.018)", border:"1px solid #1b2430", borderRadius:8, padding:"8px 12px" },
  resultBox: { background:"rgba(0,255,171,.045)", border:"1px solid rgba(0,255,171,.18)", borderRadius:8, padding:"10px 12px", margin:"10px 0" },
  prog: { display:"flex", alignItems:"center", gap:8, padding:"9px 12px", background:"rgba(88,166,255,.08)", border:"1px solid rgba(88,166,255,.2)", borderRadius:8, fontSize:11, color:"#bfd6ff", margin:"8px 0" },
  spin: { width:13, height:13, border:"2px solid rgba(88,166,255,.24)", borderTopColor:"#58a6ff", borderRadius:"50%", animation:"spin .6s linear infinite", flexShrink:0 },
  hiIco: { width:24, height:24, borderRadius:6, display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, flexShrink:0 },
  toast: { position:"fixed", bottom:16, left:"50%", transform:"translateX(-50%)", padding:"9px 20px", borderRadius:10, fontSize:12, fontWeight:700, color:"#fff", boxShadow:"0 14px 30px rgba(0,0,0,.4)", animation:"slideUp .2s", zIndex:9999 },
  loadWrap: { minHeight:"100vh", background:"#050608", display:"flex", alignItems:"center", justifyContent:"center", gap:12 },
  loadSpin: { width:18, height:18, border:"2px solid rgba(0,255,171,.24)", borderTopColor:"#00ffab", borderRadius:"50%", animation:"spin .6s linear infinite" },
  loadTxt: { color:"#7a8294", fontSize:13, fontFamily:"'Instrument Sans',-apple-system,system-ui,sans-serif" },
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
