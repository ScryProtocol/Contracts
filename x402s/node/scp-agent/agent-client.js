const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { hashChannelState, signChannelState } = require("../scp-hub/state-signing");
const { HttpJsonClient } = require("../scp-common/http-client");
const { resolveAsset, resolveNetwork, resolveHubEndpointForNetwork, toCaip2, ASSETS } = require("../scp-common/networks");

const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDRESS_LOWER = ethers.constants.AddressZero.toLowerCase();
const CAP_ASSET_SYMBOLS = ["eth", "usdc", "usdt"];
const DEFAULT_RPC_TIMEOUT_MS = 8000;
const RPC_PRESETS = {
  1: ["https://eth.llamarpc.com", "https://ethereum-rpc.publicnode.com"],
  8453: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
  11155111: ["https://ethereum-sepolia-rpc.publicnode.com", "https://rpc.sepolia.org"],
  84532: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"]
};

const CHANNEL_ABI = [
  "function openChannel(address participantB, address asset, uint256 amount, uint64 challengePeriodSec, uint64 channelExpiry, bytes32 salt) external payable returns (bytes32 channelId)",
  "function deposit(bytes32 channelId, uint256 amount) external payable",
  "function cooperativeClose(tuple(bytes32 channelId, uint256 stateNonce, uint256 balA, uint256 balB, bytes32 locksRoot, uint256 stateExpiry, bytes32 contextHash) st, bytes sigA, bytes sigB) external",
  "function startClose(tuple(bytes32 channelId, uint256 stateNonce, uint256 balA, uint256 balB, bytes32 locksRoot, uint256 stateExpiry, bytes32 contextHash) st, bytes sigFromCounterparty) external",
  "function getChannel(bytes32 channelId) external view returns (tuple(address participantA, address participantB, address asset, uint64 challengePeriodSec, uint64 channelExpiry, uint256 totalBalance, bool isClosing, uint64 closeDeadline, uint64 latestNonce))",
  "event ChannelOpened(bytes32 indexed channelId, address indexed participantA, address indexed participantB, address asset, uint64 challengePeriodSec, uint64 channelExpiry)",
  "event Deposited(bytes32 indexed channelId, address indexed sender, uint256 amount, uint256 newTotalBalance)",
  "event ChannelClosed(bytes32 indexed channelId, uint256 stateNonce, uint256 payoutA, uint256 payoutB)"
];

function now() {
  return Math.floor(Date.now() / 1000);
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function safeMkdir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_e) {
    return fallback;
  }
}

function saveJson(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function isUintString(value) {
  return /^[0-9]+$/.test(String(value || "").trim());
}

function normalizeAssetKey(rawKey) {
  const key = String(rawKey || "").trim().toLowerCase();
  if (!key) return null;
  return key;
}

function normalizeCapMap(input, label) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = normalizeAssetKey(rawKey);
    const value = String(rawValue || "").trim();
    if (!key || !value) continue;
    if (!isUintString(value)) {
      throw new Error(`${label}.${rawKey} must be a non-negative integer string`);
    }
    out[key] = value;
  }
  return out;
}

function parseCapMapString(raw, label) {
  const value = String(raw || "").trim();
  if (!value) return {};

  if (value.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch (_e) {
      throw new Error(`${label} must be valid JSON object`);
    }
    return normalizeCapMap(parsed, label);
  }

  const out = {};
  const pairs = value.split(",").map((x) => x.trim()).filter(Boolean);
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx <= 0 || idx === pair.length - 1) {
      throw new Error(`${label} entries must be key=value (example: eth=1000000,usdc=5000000)`);
    }
    const key = normalizeAssetKey(pair.slice(0, idx));
    const cap = String(pair.slice(idx + 1)).trim();
    if (!key || !isUintString(cap)) {
      throw new Error(`${label} invalid entry: ${pair}`);
    }
    out[key] = cap;
  }
  return out;
}

function envCapMap(prefix) {
  const out = {};
  for (const symbol of CAP_ASSET_SYMBOLS) {
    const v = process.env[`${prefix}_${symbol.toUpperCase()}`];
    if (!v) continue;
    const cap = String(v).trim();
    if (!isUintString(cap)) {
      throw new Error(`${prefix}_${symbol.toUpperCase()} must be a non-negative integer string`);
    }
    out[symbol] = cap;
  }
  const byAssetRaw = process.env[`${prefix}_BY_ASSET`];
  if (byAssetRaw) Object.assign(out, parseCapMapString(byAssetRaw, `${prefix}_BY_ASSET`));
  return out;
}

function parseChainId(network) {
  const raw = String(network || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw.startsWith("eip155:")) {
    const chainId = Number(raw.split(":")[1]);
    return Number.isInteger(chainId) && chainId > 0 ? chainId : null;
  }
  if (/^\d+$/.test(raw)) {
    const chainId = Number(raw);
    return Number.isInteger(chainId) && chainId > 0 ? chainId : null;
  }
  try {
    return resolveNetwork(raw).chainId;
  } catch (_e) {
    return null;
  }
}

function normalizeNetworkLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return toCaip2(raw) || raw.toLowerCase();
}

function inferAssetSymbol(network, assetAddress) {
  const asset = String(assetAddress || "").trim().toLowerCase();
  if (!asset) return null;
  if (asset === ZERO_ADDRESS_LOWER) return "eth";

  const chainId = parseChainId(network);
  if (chainId) {
    for (const symbol of CAP_ASSET_SYMBOLS) {
      try {
        const known = resolveAsset(chainId, symbol);
        if (String(known.address || "").toLowerCase() === asset) return symbol;
      } catch (_e) {
        // symbol not configured on this chain
      }
    }
  }

  const matches = new Set();
  for (const item of Object.values(ASSETS || {})) {
    if (!item || !item.address) continue;
    if (String(item.address).toLowerCase() !== asset) continue;
    if (item.symbol) matches.add(String(item.symbol).toLowerCase());
  }
  if (matches.size === 1) return [...matches][0];
  return null;
}

function capKeysForOffer(offer) {
  const out = [];
  const assetAddress = normalizeAssetKey((offer || {}).asset);
  const symbol = inferAssetSymbol((offer || {}).network, (offer || {}).asset);
  if (symbol) out.push(symbol);
  if (assetAddress) out.push(assetAddress);
  return [...new Set(out)];
}

function resolveOfferCap({ explicit, offer, byAsset, fallback }) {
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== "") {
    return String(explicit).trim();
  }
  for (const key of capKeysForOffer(offer)) {
    if (byAsset[key]) return byAsset[key];
  }
  return String(fallback || "");
}

function splitCsv(raw) {
  return String(raw || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function uniqueStrings(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const key = String(item || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function shortErr(err) {
  if (!err) return "unknown";
  if (err.reason) return String(err.reason);
  if (err.error && err.error.message) return String(err.error.message);
  return String(err.message || err);
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function preferredAliasForChainId(chainId) {
  const preferred = {
    1: "mainnet",
    8453: "base",
    11155111: "sepolia",
    84532: "base-sepolia"
  };
  return preferred[chainId] || null;
}

class ScpAgentClient {
  constructor(options = {}) {
    if (!options.wallet && !options.privateKey) {
      throw new Error("AGENT_PRIVATE_KEY or wallet required. Never use hardcoded keys.");
    }
    this.wallet = options.wallet
      ? options.wallet
      : new ethers.Wallet(options.privateKey);
    this.networkAllowlist = (options.networkAllowlist || ["eip155:8453"])
      .map((item) => normalizeNetworkLabel(item))
      .filter(Boolean);
    this.assetAllowlist = (options.assetAllowlist || []).map((x) => x.toLowerCase());
    this.maxFeeDefault = options.maxFeeDefault || "5000";
    this.maxAmountDefault = options.maxAmountDefault || "5000000";
    this.maxFeeByAsset = {
      ...envCapMap("MAX_FEE"),
      ...normalizeCapMap(options.maxFeeByAsset, "maxFeeByAsset")
    };
    this.maxAmountByAsset = {
      ...envCapMap("MAX_AMOUNT"),
      ...normalizeCapMap(options.maxAmountByAsset, "maxAmountByAsset")
    };
    this.devMode = options.devMode !== undefined ? options.devMode : !options.privateKey;
    this.persistEnabled = options.persistEnabled !== false;
    this.http = new HttpJsonClient({
      timeoutMs: options.timeoutMs || 8000,
      maxSockets: options.maxSockets || 128
    });
    this.stateDir = options.stateDir || path.resolve(__dirname, "./state");
    safeMkdir(this.stateDir);
    this.stateFile = path.join(this.stateDir, "agent-state.json");
    this.state = loadJson(this.stateFile, {
      sessions: {},
      channels: {},
      payments: {},
      watch: {
        byChannelId: {}
      }
    });
    if (!this.state.sessions) this.state.sessions = {};
    if (!this.state.channels) this.state.channels = {};
    if (!this.state.payments) this.state.payments = {};
    if (!this.state.watch) this.state.watch = {};
    if (!this.state.watch.byChannelId) this.state.watch.byChannelId = {};
  }

  persist() {
    if (!this.persistEnabled) return;
    saveJson(this.stateFile, this.state);
  }

  channelForKey(channelKey) {
    if (!this.state.channels[channelKey]) {
      if (this.devMode) {
        this.state.channels[channelKey] = {
          channelId:
            "0x" + crypto.createHash("sha256").update(`${channelKey}:${this.wallet.address}`).digest("hex"),
          nonce: 0,
          balA: "100000000000",
          balB: "0",
          virtual: true
        };
        this.persist();
      } else {
        return null;
      }
    }
    return this.state.channels[channelKey];
  }

  channelForHub(hubEndpoint) {
    const ch = this.channelForKey(`hub:${hubEndpoint}`);
    if (ch && !ch.endpoint) { ch.endpoint = hubEndpoint; this.persist(); }
    return ch;
  }

  channelForDirect(payeeAddress, endpoint) {
    const ch = this.channelForKey(`direct:${payeeAddress.toLowerCase()}`);
    if (ch && endpoint && !ch.endpoint) { ch.endpoint = endpoint; this.persist(); }
    return ch;
  }

  existingDirectChannel(payeeAddress) {
    return this.state.channels[`direct:${payeeAddress.toLowerCase()}`] || null;
  }

  async queryHubInfo(hubEndpoint) {
    const res = await this.http.request("GET", `${hubEndpoint}/.well-known/x402`);
    if (res.statusCode !== 200) return null;
    return res.body;
  }

  computeFee(amount, feePolicy) {
    const base = BigInt(feePolicy.base || "0");
    const bps = BigInt(feePolicy.bps || 0);
    const gas = BigInt(feePolicy.gasSurcharge || "0");
    return base + (BigInt(amount) * bps / 10000n) + gas;
  }

  formatSetupHint(hubInfo, amount) {
    const fee = this.computeFee(amount, hubInfo.feePolicy);
    const perPayment = BigInt(amount) + fee;
    const for100 = perPayment * 100n;
    const for1000 = perPayment * 1000n;
    const lines = [
      `No channel open with hub ${hubInfo.hubName || hubInfo.address}.`,
      ``,
      `Hub:     ${hubInfo.address}`,
      `Fee:     base=${hubInfo.feePolicy.base} + ${hubInfo.feePolicy.bps}bps + gas=${hubInfo.feePolicy.gasSurcharge}`,
      `Assets:  ${(hubInfo.supportedAssets || []).join(", ")}`,
      ``,
      `Per payment: ${amount} + ${fee} fee = ${perPayment}`,
      `  100 payments ≈ ${for100}`,
      `  1000 payments ≈ ${for1000}`,
      ``,
      `Open a channel:`,
      `  npm run scp:channel:open -- ${hubInfo.address} base usdc <amount>`
    ];
    return lines.join("\n");
  }

  nextChannelState(channelKey, totalDebit, contextHash) {
    const ch = this.channelForKey(channelKey);
    const debit = BigInt(totalDebit);
    const balA = BigInt(ch.balA);
    const balB = BigInt(ch.balB);
    if (debit > balA) {
      throw new Error(
        `Insufficient channel balance: need ${debit} but have ${balA}. ` +
        `Top up with: npm run scp:channel:fund -- ${ch.channelId} <amount>`
      );
    }

    ch.nonce += 1;
    ch.balA = (balA - debit).toString();
    ch.balB = (balB + debit).toString();
    this.persist();
    return {
      channelId: ch.channelId,
      stateNonce: ch.nonce,
      balA: ch.balA,
      balB: ch.balB,
      locksRoot: ZERO32,
      stateExpiry: now() + 120,
      contextHash
    };
  }

  async discoverOffers(resourceUrl) {
    const parseOffers = (res) => (res.body.accepts || []).filter((offer) => {
      const offerNetwork = normalizeNetworkLabel(offer.network);
      if (!offerNetwork || !this.networkAllowlist.includes(offerNetwork)) return false;
      if (this.assetAllowlist.length > 0 && !this.assetAllowlist.includes(offer.asset.toLowerCase())) {
        return false;
      }
      return offer.scheme === "statechannel-hub-v1" || offer.scheme === "statechannel-direct-v1";
    });

    const directRes = await this.http.request("GET", resourceUrl);
    if (directRes.statusCode === 402 || directRes.statusCode === 200) {
      if (directRes.body && Array.isArray(directRes.body.accepts)) {
        const directOffers = parseOffers(directRes);
        if (directOffers.length > 0) return directOffers;
      } else if (directRes.statusCode === 402) {
        throw new Error("payee returned 402 without accepts[] offers");
      }
    } else {
      throw new Error(`expected 402, got ${directRes.statusCode}`);
    }

    const base = resourceUrl.replace(/\/[^/]*$/, "");
    const payUrl = `${base}/pay`;
    try {
      const payRes = await this.http.request("GET", payUrl);
      if (payRes.body && Array.isArray(payRes.body.accepts)) {
        return parseOffers(payRes);
      }
    } catch (_e) {
      // Ignore /pay parse/network errors and rely on direct 402 offers.
    }
    return [];
  }

  buildContextHash(data) {
    const canonical = JSON.stringify(data, Object.keys(data).sort());
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(canonical));
  }

  filterOffersByOptions(offers, options = {}) {
    let filtered = offers;
    if (options.network) {
      const requestedNetwork = normalizeNetworkLabel(options.network);
      if (requestedNetwork) {
        filtered = filtered.filter((o) => normalizeNetworkLabel(o.network) === requestedNetwork);
      }
    }
    if (options.asset) {
      filtered = filtered.filter((o) => o.asset.toLowerCase() === options.asset.toLowerCase());
    }
    return filtered;
  }

  computeHubFundingPlan(offer, options = {}, hubInfo = null) {
    const amount = BigInt(offer.maxAmountRequired || "0");
    const fee = hubInfo ? this.computeFee(amount, hubInfo.feePolicy) : 0n;
    const perPaymentDebit = amount + fee;

    const rawTopup = options.topupPayments !== undefined
      ? String(options.topupPayments)
      : String(process.env.AUTO_402_TOPUP_PAYMENTS || "1");
    const topupPayments = isUintString(rawTopup) && BigInt(rawTopup) > 0n ? BigInt(rawTopup) : 1n;

    let targetBalance = perPaymentDebit * topupPayments;
    if (options.targetBalance !== undefined && options.targetBalance !== null && String(options.targetBalance).trim()) {
      const rawTarget = String(options.targetBalance).trim();
      if (isUintString(rawTarget)) {
        targetBalance = BigInt(rawTarget);
      }
    }
    if (targetBalance < perPaymentDebit) targetBalance = perPaymentDebit;
    return { amount, fee, perPaymentDebit, targetBalance };
  }

  getRpcCandidatesForOffer(offer, options = {}) {
    const chainId = parseChainId(offer.network);
    if (!chainId) return { chainId: null, rpcCandidates: [] };

    let defaultRpc = "";
    const alias = preferredAliasForChainId(chainId);
    if (alias) {
      try {
        defaultRpc = resolveNetwork(alias).rpc || "";
      } catch (_e) {
        defaultRpc = "";
      }
    }

    const rpcCandidates = uniqueStrings([
      ...splitCsv(options.rpcUrl),
      ...splitCsv(options.rpcUrls),
      ...splitCsv(process.env.RPC_URL),
      ...splitCsv(process.env.RPC_URLS),
      ...(RPC_PRESETS[chainId] || []),
      defaultRpc
    ]);
    return { chainId, rpcCandidates };
  }

  async selectResponsiveRpcForChain(chainId, rpcCandidates, timeoutMs) {
    for (const rpcUrl of rpcCandidates) {
      const provider = new ethers.providers.JsonRpcProvider(
        { url: rpcUrl, timeout: timeoutMs },
        chainId
      );
      try {
        const net = await withTimeout(provider.getNetwork(), timeoutMs, `RPC network check ${rpcUrl}`);
        if (Number(net.chainId) !== Number(chainId)) continue;
        await withTimeout(provider.getBlockNumber(), timeoutMs, `RPC block check ${rpcUrl}`);
        return { rpcUrl, provider };
      } catch (_e) {
        // Try next candidate
      }
    }
    return null;
  }

  async assessHubOfferAffordability(offer, options = {}) {
    const ext = (offer.extensions || {})["statechannel-hub-v1"] || {};
    const hubEndpoint = ext.hubEndpoint;
    if (!hubEndpoint) {
      return { offer, affordable: false, reason: "missing hubEndpoint" };
    }

    const channelKey = `hub:${hubEndpoint}`;
    const ch = this.state.channels[channelKey] || null;
    const currentBal = ch ? BigInt(ch.balA || "0") : 0n;
    const hubInfo = await this.queryHubInfo(hubEndpoint).catch(() => null);
    const plan = this.computeHubFundingPlan(offer, options, hubInfo);
    const additionalFunding = plan.targetBalance > currentBal ? plan.targetBalance - currentBal : 0n;
    if (additionalFunding === 0n) {
      return {
        offer,
        affordable: true,
        reason: "channel already sufficiently funded",
        additionalFunding: "0",
        hubEndpoint
      };
    }

    const { chainId, rpcCandidates } = this.getRpcCandidatesForOffer(offer, options);
    if (!chainId) {
      return { offer, affordable: false, reason: `unknown chain from offer network ${offer.network}`, hubEndpoint };
    }
    if (!rpcCandidates.length) {
      return { offer, affordable: false, reason: `no RPC candidates for chain ${chainId}`, hubEndpoint };
    }

    const timeoutMs = options.rpcTimeoutMs || DEFAULT_RPC_TIMEOUT_MS;
    const rpc = await this.selectResponsiveRpcForChain(chainId, rpcCandidates, timeoutMs);
    if (!rpc) {
      return { offer, affordable: false, reason: `no responsive RPC for chain ${chainId}`, hubEndpoint };
    }

    try {
      let walletBalance;
      const asset = String(offer.asset || "").toLowerCase();
      if (asset === ZERO_ADDRESS_LOWER) {
        walletBalance = (await withTimeout(
          rpc.provider.getBalance(this.wallet.address),
          timeoutMs,
          "native balance check"
        )).toBigInt();
      } else {
        const token = new ethers.Contract(offer.asset, ["function balanceOf(address owner) view returns (uint256)"], rpc.provider);
        walletBalance = (await withTimeout(
          token.balanceOf(this.wallet.address),
          timeoutMs,
          "erc20 balance check"
        )).toBigInt();
      }

      return {
        offer,
        affordable: walletBalance >= additionalFunding,
        reason: walletBalance >= additionalFunding
          ? "wallet balance is sufficient"
          : `insufficient wallet balance (need ${additionalFunding}, have ${walletBalance})`,
        additionalFunding: additionalFunding.toString(),
        walletBalance: walletBalance.toString(),
        hubEndpoint
      };
    } catch (err) {
      return { offer, affordable: false, reason: shortErr(err), hubEndpoint };
    }
  }

  async prefilterHubOffersByAffordability(offers, route, options = {}) {
    if (route === "direct") return offers;
    const filteredByUser = this.filterOffersByOptions(offers, options);
    const hubOffers = filteredByUser.filter((o) => o.scheme === "statechannel-hub-v1");
    if (hubOffers.length < 2) return offers;

    const hasAnyHubChannel = hubOffers.some((o) => {
      const endpoint = ((o.extensions || {})["statechannel-hub-v1"] || {}).hubEndpoint;
      return endpoint && this.state.channels[`hub:${endpoint}`];
    });
    if (hasAnyHubChannel) return offers;

    const checks = await Promise.all(hubOffers.map((offer) => this.assessHubOfferAffordability(offer, options)));
    const affordableHubOffers = checks.filter((x) => x.affordable).map((x) => x.offer);
    if (affordableHubOffers.length > 0) {
      const affordableEndpoints = new Set(
        affordableHubOffers.map((o) => ((o.extensions || {})["statechannel-hub-v1"] || {}).hubEndpoint)
      );
      return offers.filter((offer) => {
        if (offer.scheme !== "statechannel-hub-v1") return true;
        const endpoint = ((offer.extensions || {})["statechannel-hub-v1"] || {}).hubEndpoint;
        return endpoint && affordableEndpoints.has(endpoint);
      });
    }

    const directOffers = filteredByUser.filter((o) => o.scheme === "statechannel-direct-v1");
    if (route === "hub" || directOffers.length === 0) {
      const reason = checks.map((x) => x.reason).filter(Boolean)[0] || "wallet balance too low";
      throw new Error(`No affordable hub offers found (${reason})`);
    }
    return offers.filter((offer) => offer.scheme !== "statechannel-hub-v1");
  }

  async chooseOfferSmart(offers, route, options = {}) {
    const pool = await this.prefilterHubOffersByAffordability(offers, route, options);
    return this.chooseOffer(pool, route, options);
  }

  chooseOffer(offers, route, options = {}) {
    let filtered = this.filterOffersByOptions(offers, options);
    const hubs = filtered.filter((o) => o.scheme === "statechannel-hub-v1");
    const directs = filtered.filter((o) => o.scheme === "statechannel-direct-v1");

    const offerAmount = (o) => {
      try { return BigInt(o.maxAmountRequired || "0"); } catch (_e) { return 0n; }
    };

    const rankHub = (o) => {
      const ext = (o.extensions || {})["statechannel-hub-v1"] || {};
      const endpoint = ext.hubEndpoint;
      if (!endpoint) return 0;
      const ch = this.state.channels[`hub:${endpoint}`];
      if (!ch) return 0;
      try {
        return BigInt(ch.balA || "0") >= offerAmount(o) ? 2 : 1;
      } catch (_e) {
        return 1;
      }
    };

    const rankDirect = (o) => {
      const ext = (o.extensions || {})["statechannel-direct-v1"] || {};
      const payee = ext.payeeAddress;
      if (!payee) return 0;
      const ch = this.state.channels[`direct:${payee.toLowerCase()}`];
      if (!ch) return 0;
      try {
        return BigInt(ch.balA || "0") >= offerAmount(o) ? 2 : 1;
      } catch (_e) {
        return 1;
      }
    };

    const pickBest = (list, rankFn) => {
      if (!list.length) return undefined;
      const scored = list.map((offer, idx) => ({ offer, idx, rank: rankFn(offer), amount: offerAmount(offer) }));
      scored.sort((a, b) => {
        if (a.rank !== b.rank) return b.rank - a.rank;
        if (a.amount !== b.amount) return a.amount < b.amount ? -1 : 1;
        return a.idx - b.idx;
      });
      return scored[0].offer;
    };

    if (route === "hub") return pickBest(hubs, rankHub);
    if (route === "direct") return pickBest(directs, rankDirect);
    if (route === "auto") {
      const d = pickBest(directs, rankDirect);
      if (d && rankDirect(d) >= 2) return d;
      const h = pickBest(hubs, rankHub);
      return h || d;
    }
    return pickBest(hubs, rankHub) || pickBest(directs, rankDirect);
  }

  resolveHttpCallOptions(options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const requestHeaders = options.requestHeaders || {};
    const requestBody =
      options.requestBody !== undefined ? options.requestBody : options.body !== undefined ? options.body : null;
    return { method, requestHeaders, requestBody };
  }

  enforceMaxAmount(amount, offer, options = {}) {
    const maxAmount = resolveOfferCap({
      explicit: options.maxAmount,
      offer,
      byAsset: this.maxAmountByAsset,
      fallback: this.maxAmountDefault
    });
    if (BigInt(amount) > BigInt(maxAmount)) {
      throw new Error(`amount exceeds maxAmount policy (${amount} > ${maxAmount})`);
    }
    return maxAmount;
  }

  ensureHubChannel(hubEndpoint, amount) {
    const ch = this.channelForHub(hubEndpoint);
    if (ch) return ch;
    return this.queryHubInfo(hubEndpoint).catch(() => null).then((hubInfo) => {
      if (hubInfo) throw new Error(this.formatSetupHint(hubInfo, amount));
      throw new Error(`No channel open with hub at ${hubEndpoint}. Open one with: npm run scp:channel:open -- <hubAddress> <deposit>`);
    });
  }

  async quoteAndIssueHubTicket(hubEndpoint, contextHash, quoteReq) {
    const quote = await this.http.request("POST", `${hubEndpoint}/v1/tickets/quote`, quoteReq);
    if (quote.statusCode !== 200) {
      throw new Error(`quote failed: ${quote.statusCode} ${JSON.stringify(quote.body)}`);
    }

    const state = this.nextChannelState(`hub:${hubEndpoint}`, quote.body.totalDebit, contextHash);
    const sigA = await signChannelState(state, this.wallet);
    const issueReq = { quote: quote.body, channelState: state, sigA };
    const issued = await this.http.request("POST", `${hubEndpoint}/v1/tickets/issue`, issueReq);
    if (issued.statusCode !== 200) {
      throw new Error(`issue failed: ${issued.statusCode} ${JSON.stringify(issued.body)}`);
    }

    const issuedTicket = { ...issued.body };
    const channelAck = issuedTicket.channelAck || {};
    delete issuedTicket.channelAck;
    return {
      quote: quote.body,
      state,
      stateHash: hashChannelState(state),
      sigA,
      issuedTicket,
      channelAck
    };
  }

  async sendPaidRequest({ method, targetUrl, requestBody, requestHeaders, paymentPayload, rejectionPrefix }) {
    const paid = await this.http.request(
      method,
      targetUrl,
      method === "GET" || method === "HEAD" ? null : requestBody,
      {
        ...requestHeaders,
        "PAYMENT-SIGNATURE": JSON.stringify(paymentPayload)
      }
    );
    if (paid.statusCode !== 200) {
      throw new Error(`${rejectionPrefix}: ${paid.statusCode} ${JSON.stringify(paid.body)}`);
    }
    return paid.body;
  }

  persistHubPayment(paymentId, payment, state, sigA, sigB) {
    this.state.payments[paymentId] = {
      paidAt: now(),
      route: "hub",
      ...payment
    };
    this.state.watch.byChannelId[state.channelId] = {
      role: "agent",
      state,
      sigA,
      sigB: sigB || null,
      updatedAt: now()
    };
    this.persist();
  }

  persistDirectPayment(paymentId, payment) {
    this.state.payments[paymentId] = {
      paidAt: now(),
      route: "direct",
      ...payment
    };
    this.persist();
  }

  async payViaHub(resourceUrl, offer, options = {}) {
    const ext = offer.extensions["statechannel-hub-v1"];
    const hubEndpoint = ext.hubEndpoint;
    const invoiceId = ext.invoiceId || randomId("inv");
    const paymentId = options.paymentId || randomId("pay");
    const { method, requestHeaders, requestBody } = this.resolveHttpCallOptions(options);

    const amount = offer.maxAmountRequired;
    const maxFee = resolveOfferCap({
      explicit: options.maxFee,
      offer,
      byAsset: this.maxFeeByAsset,
      fallback: this.maxFeeDefault
    });
    this.enforceMaxAmount(amount, offer, options);
    await this.ensureHubChannel(hubEndpoint, amount);

    const contextHash = this.buildContextHash({
      payee: ext.payeeAddress || offer.payTo,
      resource: offer.resource || resourceUrl,
      method,
      invoiceId,
      paymentId,
      amount,
      asset: offer.asset
    });

    const quoteReq = {
      invoiceId,
      paymentId,
      channelId: this.channelForHub(hubEndpoint).channelId,
      payee: ext.payeeAddress,
      asset: offer.asset,
      amount,
      maxFee,
      quoteExpiry: now() + 120,
      contextHash
    };
    const issuedBundle = await this.quoteAndIssueHubTicket(hubEndpoint, contextHash, quoteReq);

    const paymentPayload = {
      scheme: "statechannel-hub-v1",
      paymentId,
      invoiceId,
      ticket: issuedBundle.issuedTicket,
      channelProof: {
        channelId: issuedBundle.state.channelId,
        stateNonce: issuedBundle.state.stateNonce,
        stateHash: issuedBundle.stateHash,
        sigA: issuedBundle.sigA,
        channelState: issuedBundle.state
      }
    };

    const targetUrl = offer.resource || resourceUrl;
    const response = await this.sendPaidRequest({
      method,
      targetUrl,
      requestBody,
      requestHeaders,
      paymentPayload,
      rejectionPrefix: "payee rejected payment"
    });

    this.persistHubPayment(
      paymentId,
      {
      resourceUrl: targetUrl,
      invoiceId,
      ticketId: issuedBundle.issuedTicket.ticketId,
      amount,
      payee: ext.payeeAddress || offer.payTo,
      receipt: response.receipt
      },
      issuedBundle.state,
      issuedBundle.sigA,
      issuedBundle.channelAck.sigB
    );

    return {
      offer,
      route: "hub",
      quote: issuedBundle.quote,
      ticket: issuedBundle.issuedTicket,
      response
    };
  }

  async payViaDirect(resourceUrl, offer, options = {}) {
    const ext = offer.extensions["statechannel-direct-v1"];
    const invoiceId = ext.invoiceId || randomId("inv");
    const paymentId = options.paymentId || randomId("pay");
    const { method, requestHeaders, requestBody } = this.resolveHttpCallOptions(options);
    const amount = offer.maxAmountRequired;
    this.enforceMaxAmount(amount, offer, options);

    const ch = this.channelForDirect(ext.payeeAddress, resourceUrl);
    if (!ch) {
      throw new Error(
        `No direct channel open with ${ext.payeeAddress}.\n` +
        `Open one with: npm run scp:channel:open -- ${ext.payeeAddress} <deposit>`
      );
    }

    const contextHash = this.buildContextHash({
      payee: ext.payeeAddress,
      resource: offer.resource || resourceUrl,
      method,
      invoiceId,
      paymentId,
      amount,
      asset: offer.asset
    });

    const state = this.nextChannelState(
      `direct:${ext.payeeAddress.toLowerCase()}`,
      amount,
      contextHash
    );
    const sigA = await signChannelState(state, this.wallet);
    const paymentPayload = {
      scheme: "statechannel-direct-v1",
      paymentId,
      invoiceId,
      direct: {
        payer: this.wallet.address,
        payee: ext.payeeAddress,
        asset: offer.asset,
        amount,
        expiry: now() + 120,
        invoiceId,
        paymentId,
        channelState: state,
        sigA
      }
    };

    const targetUrl = offer.resource || resourceUrl;
    const response = await this.sendPaidRequest({
      method,
      targetUrl,
      requestBody,
      requestHeaders,
      paymentPayload,
      rejectionPrefix: "payee rejected direct payment"
    });

    this.persistDirectPayment(paymentId, {
      resourceUrl: targetUrl,
      invoiceId,
      amount,
      payee: ext.payeeAddress,
      receipt: response.receipt
    });
    return {
      offer,
      route: "direct",
      response
    };
  }

  async payAddress(payeeAddress, amount, options = {}) {
    const hubEndpoint = options.hubEndpoint || resolveHubEndpointForNetwork(options.network || this.networkAllowlist[0]);
    const asset = options.asset || "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913";
    const invoiceId = options.invoiceId || randomId("inv");
    const paymentId = options.paymentId || randomId("pay");
    const capOffer = { network: options.network || this.networkAllowlist[0], asset };
    const maxFee = resolveOfferCap({
      explicit: options.maxFee,
      offer: capOffer,
      byAsset: this.maxFeeByAsset,
      fallback: this.maxFeeDefault
    });
    this.enforceMaxAmount(amount, capOffer, options);
    await this.ensureHubChannel(hubEndpoint, amount);

    const contextHash = this.buildContextHash({
      payee: payeeAddress,
      method: "transfer",
      invoiceId,
      paymentId,
      amount,
      asset
    });

    const quoteReq = {
      invoiceId,
      paymentId,
      channelId: this.channelForHub(hubEndpoint).channelId,
      payee: payeeAddress,
      asset,
      amount,
      maxFee,
      quoteExpiry: now() + 120,
      contextHash
    };
    const issuedBundle = await this.quoteAndIssueHubTicket(hubEndpoint, contextHash, quoteReq);
    this.persistHubPayment(
      paymentId,
      {
        payee: payeeAddress,
        invoiceId,
        ticketId: issuedBundle.issuedTicket.ticketId,
        amount
      },
      issuedBundle.state,
      issuedBundle.sigA,
      issuedBundle.channelAck.sigB
    );

    return {
      route: "hub",
      payee: payeeAddress,
      amount,
      fee: issuedBundle.quote.fee,
      ticket: issuedBundle.issuedTicket,
      quote: issuedBundle.quote
    };
  }

  async payResource(resourceUrl, options = {}) {
    const offers = await this.discoverOffers(resourceUrl);
    if (offers.length === 0) {
      throw new Error("No compatible payment offers from payee.");
    }
    const routes = offers.map((o) => o.scheme.replace("statechannel-", "").replace("-v1", ""));
    const route = options.route || "hub";
    const offer = await this.chooseOfferSmart(offers, route, options);
    if (!offer) {
      throw new Error(
        `Payee does not offer "${route}" route.\n` +
        `Available: ${routes.join(", ")}\n` +
        `Try: agent:pay ${resourceUrl} ${routes[0]}`
      );
    }
    if (offer.scheme === "statechannel-direct-v1") {
      return this.payViaDirect(resourceUrl, offer, options);
    }
    return this.payViaHub(resourceUrl, offer, options);
  }

  async callApi(resourceUrl, options = {}) {
    const result = await this.payResource(resourceUrl, options);
    return result.response;
  }

  // --- On-chain channel operations ---

  getContract(rpcUrl, contractAddress) {
    if (!rpcUrl) throw new Error("RPC_URL required for on-chain operations");
    if (!contractAddress) throw new Error("CONTRACT_ADDRESS required");
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const signer = this.wallet.connect(provider);
    return new ethers.Contract(contractAddress, CHANNEL_ABI, signer);
  }

  async openChannel(participantB, options = {}) {
    const rpcUrl = options.rpcUrl || process.env.RPC_URL;
    const contractAddress = options.contractAddress || process.env.CONTRACT_ADDRESS;
    const contract = this.getContract(rpcUrl, contractAddress);
    const asset = options.asset || ethers.constants.AddressZero;
    const amount = BigInt(options.amount || "0");
    const challengePeriod = Number(options.challengePeriodSec || 86400);
    const channelExpiry = Number(options.channelExpiry || now() + 86400 * 30);
    const salt = options.salt || ethers.utils.formatBytes32String(`ag-${now()}-${participantB.slice(2, 8)}`);

    const baseTxOpts = asset === ethers.constants.AddressZero
      ? { value: amount }
      : {};
    let gasLimit;
    try {
      const estimated = await contract.estimateGas.openChannel(
        ethers.utils.getAddress(participantB), asset, amount, challengePeriod, channelExpiry, salt, baseTxOpts
      );
      gasLimit = estimated.mul(130).div(100);
    } catch (_e) {
      gasLimit = ethers.BigNumber.from("700000");
    }
    const txOpts = { ...baseTxOpts, gasLimit };
    const tx = await contract.openChannel(
      ethers.utils.getAddress(participantB), asset, amount,
      challengePeriod, channelExpiry, salt, txOpts
    );
    const rc = await tx.wait(1);
    const ev = rc.events.find(e => e.event === "ChannelOpened");
    const channelId = ev.args.channelId;

    // Store in agent state
    const channelKey = `onchain:${channelId}`;
    this.state.channels[channelKey] = {
      channelId,
      participantB: ethers.utils.getAddress(participantB),
      asset,
      nonce: 0,
      balA: amount.toString(),
      balB: "0",
      totalDeposit: amount.toString(),
      challengePeriodSec: challengePeriod,
      channelExpiry,
      contractAddress,
      txHash: tx.hash
    };
    this.persist();

    return {
      channelId,
      participantA: this.wallet.address,
      participantB: ethers.utils.getAddress(participantB),
      asset,
      amount: amount.toString(),
      challengePeriodSec: challengePeriod,
      txHash: tx.hash
    };
  }

  async fundChannel(channelId, amount, options = {}) {
    const rpcUrl = options.rpcUrl || process.env.RPC_URL;
    const contractAddress = options.contractAddress || process.env.CONTRACT_ADDRESS;
    const contract = this.getContract(rpcUrl, contractAddress);
    const value = BigInt(amount);

    // Check if ETH or ERC20 by reading on-chain
    const params = await contract.getChannel(channelId);
    const isEth = params.asset === ethers.constants.AddressZero;

    const baseTxOpts = isEth ? { value } : {};
    let gasLimit;
    try {
      const estimated = await contract.estimateGas.deposit(channelId, value, baseTxOpts);
      gasLimit = estimated.mul(130).div(100);
    } catch (_e) {
      gasLimit = ethers.BigNumber.from("200000");
    }
    const txOpts = { ...baseTxOpts, gasLimit };
    const tx = await contract.deposit(channelId, value, txOpts);
    const rc = await tx.wait(1);
    const ev = rc.events.find(e => e.event === "Deposited");

    // Update local state
    const channelKey = `onchain:${channelId}`;
    if (this.state.channels[channelKey]) {
      const ch = this.state.channels[channelKey];
      ch.balA = (BigInt(ch.balA) + value).toString();
      ch.totalDeposit = (BigInt(ch.totalDeposit) + value).toString();
      this.persist();
    }

    return {
      channelId,
      deposited: value.toString(),
      newTotalBalance: ev ? ev.args.newTotalBalance.toString() : null,
      txHash: tx.hash
    };
  }

  async closeChannel(channelId, options = {}) {
    const rpcUrl = options.rpcUrl || process.env.RPC_URL;
    const contractAddress = options.contractAddress || process.env.CONTRACT_ADDRESS;
    const contract = this.getContract(rpcUrl, contractAddress);

    // Find the latest state for this channel
    const channelKey = `onchain:${channelId}`;
    const ch = this.state.channels[channelKey];
    const watchData = this.state.watch.byChannelId[channelId];

    // Try cooperative close if we have both signatures
    if (watchData && watchData.sigA && watchData.sigB) {
      const tx = await contract.cooperativeClose(watchData.state, watchData.sigA, watchData.sigB, { gasLimit: 200000 });
      await tx.wait(1);
      if (ch) ch.status = "closed";
      this.persist();
      return { channelId, method: "cooperative", txHash: tx.hash };
    }

    // Otherwise start unilateral close
    if (watchData && watchData.state && watchData.sigB) {
      const tx = await contract.startClose(watchData.state, watchData.sigB, { gasLimit: 200000 });
      await tx.wait(1);
      if (ch) ch.status = "closing";
      this.persist();
      return { channelId, method: "unilateral", txHash: tx.hash };
    }

    throw new Error("no counterparty signature available; request cooperative close from hub or use challenge watcher");
  }

  channelById(channelId) {
    for (const [key, ch] of Object.entries(this.state.channels)) {
      if (ch.channelId === channelId) return { key, ...ch };
    }
    return null;
  }

  async payChannel(channelId, amount, options = {}) {
    const ch = this.channelById(channelId);
    if (!ch) throw new Error(`Channel ${channelId} not found in agent state.`);

    const hubMatch = ch.key.match(/^hub:(.+)$/);
    const directMatch = ch.key.match(/^direct:(.+)$/);

    if (hubMatch) {
      return this.payAddress(options.payee || this.wallet.address, amount, {
        hubEndpoint: hubMatch[1],
        ...options
      });
    }

    if (directMatch) {
      const payeeAddress = directMatch[1];
      const endpoint = ch.endpoint;
      if (!endpoint) {
        throw new Error(
          `No endpoint stored for direct channel ${channelId.slice(0, 10)}...\n` +
          `Pay a URL first to establish the endpoint, or use: agent:pay <url> direct`
        );
      }
      const paymentId = randomId("pay");
      const contextHash = this.buildContextHash({
        payee: payeeAddress,
        method: "transfer",
        paymentId,
        amount
      });
      const state = this.nextChannelState(ch.key, amount, contextHash);
      const sigA = await signChannelState(state, this.wallet);
      const paymentPayload = {
        scheme: "statechannel-direct-v1",
        paymentId,
        direct: { payer: this.wallet.address, payee: payeeAddress, amount, channelState: state, sigA }
      };
      const response = await this.sendPaidRequest({
        method: "GET",
        targetUrl: endpoint,
        requestBody: null,
        requestHeaders: {},
        paymentPayload,
        rejectionPrefix: "direct payment failed"
      });
      this.persistDirectPayment(paymentId, { payee: payeeAddress, amount });
      return { route: "direct", payee: payeeAddress, amount, response };
    }

    throw new Error(`Unknown channel type (key=${ch.key}).`);
  }

  listChannels() {
    const result = [];
    for (const [key, ch] of Object.entries(this.state.channels)) {
      result.push({ key, ...ch });
    }
    return result;
  }

  // --- Webhooks / event subscription ---

  async subscribeWebhook(hubEndpoint, webhookUrl, options = {}) {
    const channelKey = `hub:${hubEndpoint}`;
    const ch = this.state.channels[channelKey];
    const body = {
      url: webhookUrl,
      events: options.events || [
        "channel.close_started",
        "channel.challenged",
        "channel.closed",
        "payment.refunded",
        "balance.low"
      ],
      channelId: ch ? ch.channelId : "*",
      secret: options.secret || undefined
    };
    const res = await this.http.request("POST", `${hubEndpoint}/v1/webhooks`, body);
    if (res.statusCode !== 201) {
      throw new Error(`webhook registration failed: ${res.statusCode} ${JSON.stringify(res.body)}`);
    }
    if (!this.state.webhooks) this.state.webhooks = {};
    this.state.webhooks[res.body.webhookId] = {
      hubEndpoint,
      webhookId: res.body.webhookId,
      secret: res.body.secret,
      events: body.events,
      createdAt: now()
    };
    this.persist();
    return res.body;
  }

  async pollEvents(hubEndpoint, options = {}) {
    const since = options.since || (this.state._eventCursor || {})[hubEndpoint] || 0;
    const channelId = options.channelId || null;
    const limit = options.limit || 50;
    const qs = `since=${since}&limit=${limit}${channelId ? `&channelId=${channelId}` : ""}`;
    const res = await this.http.request("GET", `${hubEndpoint}/v1/events?${qs}`);
    if (res.statusCode !== 200) {
      throw new Error(`poll failed: ${res.statusCode}`);
    }
    if (!this.state._eventCursor) this.state._eventCursor = {};
    if (res.body.nextCursor > since) {
      this.state._eventCursor[hubEndpoint] = res.body.nextCursor;
      this.persist();
    }
    return res.body;
  }

  close() {
    this.http.close();
  }
}

module.exports = { ScpAgentClient };
