/* eslint-disable no-console */
const http = require("http");
const url = require("url");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const cluster = require("cluster");
const { ethers } = require("ethers");
const { createStorage } = require("./storage");
const { buildValidators, validationMessage } = require("./validator");
const { signTicketDraft } = require("./ticket");
const { buildAgentSummary, buildAgentReceipts } = require("./payment-views");
const {
  signChannelState,
  hashChannelState,
  recoverChannelStateSigner,
  setDomainDefaults
} = require("./state-signing");
const { WebhookManager, EVENT } = require("./webhooks");
const { resolveNetwork, resolveAsset, resolveContract } = require("../scp-common/networks");
const { recoverPayeeAuthSigner } = require("../scp-common/payee-auth");

const PORT = Number(process.env.PORT || 4021);
const HOST = process.env.HOST || "127.0.0.1";
const HUB_NAME = process.env.HUB_NAME || "pay.eth";

// NETWORK=sepolia | base | mainnet  (or CHAIN_ID=11155111 for back-compat)
let CHAIN_ID;
const netInput = process.env.NETWORK;
if (netInput) {
  const net = netInput.startsWith("eip155:")
    ? { chainId: Number(netInput.split(":")[1]) }
    : resolveNetwork(netInput);
  CHAIN_ID = net.chainId;
} else {
  CHAIN_ID = Number(process.env.CHAIN_ID || 11155111);
}
if (!Number.isInteger(CHAIN_ID) || CHAIN_ID <= 0) {
  console.error("FATAL: invalid chain id. Set NETWORK (recommended) or CHAIN_ID.");
  process.exit(1);
}

const SIG_FORMAT = "eth_sign";
const PRIVATE_KEY = process.env.HUB_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("FATAL: HUB_PRIVATE_KEY env var is required. Never use hardcoded keys.");
  process.exit(1);
}
const wallet = new ethers.Wallet(PRIVATE_KEY);
const HUB_ADDRESS = wallet.address;

// DEFAULT_ASSET: resolve by name or use raw address
let DEFAULT_ASSET = process.env.DEFAULT_ASSET;
if (!DEFAULT_ASSET) {
  try { DEFAULT_ASSET = resolveAsset(CHAIN_ID, "usdc").address; }
  catch (_) { DEFAULT_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913"; }
}
const FEE_BASE = BigInt(process.env.FEE_BASE || "10");
const FEE_BPS = BigInt(process.env.FEE_BPS || "30");
const GAS_SURCHARGE = BigInt(process.env.GAS_SURCHARGE || "0");
const RPC_URL = process.env.RPC_URL || "";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "";
const REDIS_URL = process.env.REDIS_URL || "";
const HUB_ADMIN_TOKEN = process.env.HUB_ADMIN_TOKEN || "";
const NODE_ENV = String(process.env.NODE_ENV || "").toLowerCase();
const IS_PRODUCTION = NODE_ENV === "production";
const ALLOW_UNSAFE_PROD_STORAGE = process.env.ALLOW_UNSAFE_PROD_STORAGE === "1";
const PAYEE_AUTH_MAX_SKEW_SEC = Number(process.env.PAYEE_AUTH_MAX_SKEW_SEC || 300);
const RATE_LIMIT_WINDOW_SEC = Math.max(1, Number(process.env.RATE_LIMIT_WINDOW_SEC || 60));
const RATE_LIMIT_DEFAULT = Math.max(0, Number(process.env.RATE_LIMIT_DEFAULT || 600));
const RATE_LIMIT_QUOTE = Math.max(0, Number(process.env.RATE_LIMIT_QUOTE || 240));
const RATE_LIMIT_ISSUE = Math.max(0, Number(process.env.RATE_LIMIT_ISSUE || 240));
const RATE_LIMIT_REFUNDS = Math.max(0, Number(process.env.RATE_LIMIT_REFUNDS || 60));
const QUOTE_SWEEP_INTERVAL_SEC = Math.max(1, Number(process.env.QUOTE_SWEEP_INTERVAL_SEC || 30));
const SETTLEMENT_MODE = String(process.env.SETTLEMENT_MODE || "cooperative_close").toLowerCase();
const CHANNEL_ABI = [
  "function openChannel(address hub, address asset, uint256 amount, uint64 challengePeriodSec, uint64 channelExpiry, bytes32 salt) external payable returns (bytes32 channelId)",
  "function deposit(bytes32 channelId, uint256 amount) external payable",
  "function cooperativeClose(tuple(bytes32 channelId, uint64 stateNonce, uint256 balA, uint256 balB, bytes32 locksRoot, uint64 stateExpiry, bytes32 contextHash) st, bytes sigA, bytes sigB) external",
  "function rebalance(tuple(bytes32 channelId, uint256 stateNonce, uint256 balA, uint256 balB, bytes32 locksRoot, uint256 stateExpiry, bytes32 contextHash) state, bytes32 toChannelId, uint256 amount, bytes sigCounterparty) external",
  "function balance(bytes32 channelId) external view returns (tuple(uint256 totalBalance, uint256 balA, uint256 balB, uint64 latestNonce, bool isClosing))",
  "function getChannel(bytes32 channelId) external view returns (tuple(address participantA, address participantB, address asset, uint64 challengePeriodSec, uint64 channelExpiry, uint256 totalBalance, bool isClosing, uint64 closeDeadline, uint64 latestNonce))",
  "event ChannelOpened(bytes32 indexed channelId, address indexed participantA, address indexed participantB, address asset, uint64 challengePeriodSec, uint64 channelExpiry)",
  "event Deposited(bytes32 indexed channelId, address indexed sender, uint256 amount, uint256 newTotalBalance)",
  "event Rebalanced(bytes32 indexed fromChannelId, bytes32 indexed toChannelId, uint256 amount, uint256 fromNewTotal, uint256 toNewTotal)"
];
const STORE_PATH = process.env.STORE_PATH || path.resolve(__dirname, "./data/store.json");
const WORKERS = Number(process.env.HUB_WORKERS || 0);
const DOMAIN_CONTRACT = (() => {
  const raw = CONTRACT_ADDRESS || resolveContract(CHAIN_ID) || ethers.constants.AddressZero;
  try {
    return ethers.utils.getAddress(raw);
  } catch (_e) {
    return ethers.constants.AddressZero;
  }
})();
setDomainDefaults(CHAIN_ID, DOMAIN_CONTRACT);

if (IS_PRODUCTION && !REDIS_URL && !ALLOW_UNSAFE_PROD_STORAGE) {
  console.error(
    "FATAL: Production mode requires REDIS_URL for hub storage.\n" +
    "File-backed JSON storage is not production-safe for reliability/concurrency.\n" +
    "Set REDIS_URL, or set ALLOW_UNSAFE_PROD_STORAGE=1 to override at your own risk."
  );
  process.exit(1);
}

// Provider + funded wallet for on-chain settlement (lazy init)
let hubSigner = null;
function getHubSigner() {
  if (hubSigner) return hubSigner;
  if (!RPC_URL) return null;
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  hubSigner = wallet.connect(provider);
  return hubSigner;
}

const store = createStorage(REDIS_URL ? { redisUrl: REDIS_URL } : STORE_PATH);
const validate = buildValidators();
const webhooks = new WebhookManager(store);
const rateWindow = new Map();
let lastQuoteSweepAt = 0;

const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const CORS_HEADERS = [
  "Content-Type",
  "Payment-Signature",
  "Authorization",
  "Idempotency-Key",
  "X-SCP-Access-Token",
  "X-SCP-Admin-Token",
  "X-SCP-Payee-Signature",
  "X-SCP-Payee-Timestamp"
].join(", ");
const CORS_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const CORS_EXPOSE_HEADERS = ["Retry-After"].join(", ");

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", CORS_METHODS);
  res.setHeader("Access-Control-Allow-Headers", CORS_HEADERS);
  res.setHeader("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
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

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let data = "";
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.length > 1024 * 1024) {
        const err = new Error("payload too large");
        err.statusCode = 413;
        fail(err);
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return succeed({});
      try {
        succeed(JSON.parse(data));
      } catch (err) {
        err.statusCode = 400;
        fail(err);
      }
    });
    req.on("error", fail);
  });
}

function isHex32(v) {
  return typeof v === "string" && /^0x[a-fA-F0-9]{64}$/.test(v);
}

function isHexAddress(v) {
  return typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v);
}

function calcFee(amountStr) {
  const amount = BigInt(amountStr);
  const variable = (amount * FEE_BPS) / 10000n;
  const fee = FEE_BASE + variable + GAS_SURCHARGE;
  return {
    fee,
    breakdown: {
      base: FEE_BASE.toString(),
      bps: Number(FEE_BPS),
      variable: variable.toString(),
      gasSurcharge: GAS_SURCHARGE.toString()
    }
  };
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function policyHash(obj) {
  const enc = JSON.stringify(obj);
  return ethers.utils.keccak256(Buffer.from(enc, "utf8"));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function now() {
  return Math.floor(Date.now() / 1000);
}

const ZERO32 = "0x" + "0".repeat(64);

function makeError(code, message, retryable = false) {
  return { errorCode: code, message, retryable };
}

function parseUint(v, fieldName) {
  try {
    return BigInt(v);
  } catch (_e) {
    throw new Error(`invalid ${fieldName}`);
  }
}

function parseIdempotencyKey(req, body) {
  const headerKey = typeof req.headers["idempotency-key"] === "string"
    ? req.headers["idempotency-key"]
    : "";
  const bodyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
  const raw = String(bodyKey || headerKey || "").trim();
  if (!raw) return "";
  if (!/^[A-Za-z0-9:_-]{6,128}$/.test(raw)) {
    throw new Error("idempotencyKey must match [A-Za-z0-9:_-]{6,128}");
  }
  return raw;
}

function parseSettlementMode(value) {
  const raw = String(value || SETTLEMENT_MODE || "cooperative_close").trim().toLowerCase();
  if (raw === "cooperative_close" || raw === "channel_close" || raw === "cooperative") {
    return "cooperative_close";
  }
  if (raw === "direct") return "direct";
  throw new Error("mode must be cooperative_close|direct");
}

function ensureIndexBucket(state, key) {
  if (!state[key] || typeof state[key] !== "object") state[key] = {};
  return state[key];
}

function indexIssuedPayment(state, payment) {
  const paymentId = payment.paymentId;
  const ticketId = payment.ticketId;
  const channelId = payment.channelId;
  const payee = String(payment.payee || "").toLowerCase();
  if (!paymentId || !ticketId || !channelId || !payee) return;

  const byTicket = ensureIndexBucket(state, "paymentsByTicketId");
  byTicket[ticketId] = paymentId;

  const byChannel = ensureIndexBucket(state, "paymentIdsByChannel");
  if (!byChannel[channelId] || typeof byChannel[channelId] !== "object") byChannel[channelId] = {};
  byChannel[channelId][paymentId] = 1;

  const byPayee = ensureIndexBucket(state, "paymentIdsByPayee");
  if (!byPayee[payee] || typeof byPayee[payee] !== "object") byPayee[payee] = {};
  byPayee[payee][paymentId] = 1;
}

function requireAdminAuth(req, res) {
  // SECURITY: if no admin token is configured, block admin endpoints entirely.
  // Previously this returned true (allow-all), enabling unauthenticated webhook
  // registration (SSRF vector) and arbitrary event emission.
  if (!HUB_ADMIN_TOKEN) {
    sendJson(res, 403, makeError("SCP_012_UNAUTHORIZED", "admin endpoints disabled (set HUB_ADMIN_TOKEN)"));
    return false;
  }
  const hdrToken = typeof req.headers["x-scp-admin-token"] === "string"
    ? req.headers["x-scp-admin-token"]
    : "";
  const authz = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const bearer = authz.toLowerCase().startsWith("bearer ") ? authz.slice(7).trim() : "";
  const token = hdrToken || bearer;
  if (!token || token !== HUB_ADMIN_TOKEN) {
    sendJson(res, 401, makeError("SCP_012_UNAUTHORIZED", "admin auth required"));
    return false;
  }
  return true;
}

function requirePayeeAuth(req, res, pathname, payee, body) {
  const sig = typeof req.headers["x-scp-payee-signature"] === "string"
    ? req.headers["x-scp-payee-signature"]
    : "";
  const tsRaw = req.headers["x-scp-payee-timestamp"];
  const ts = Number(tsRaw);
  if (!sig) {
    sendJson(res, 401, makeError("SCP_012_UNAUTHORIZED", "missing x-scp-payee-signature"));
    return false;
  }
  if (!Number.isInteger(ts)) {
    sendJson(res, 401, makeError("SCP_012_UNAUTHORIZED", "invalid x-scp-payee-timestamp"));
    return false;
  }
  if (Math.abs(now() - ts) > PAYEE_AUTH_MAX_SKEW_SEC) {
    sendJson(res, 401, makeError("SCP_012_UNAUTHORIZED", "stale payee auth timestamp"));
    return false;
  }
  let recovered;
  try {
    recovered = recoverPayeeAuthSigner({
      method: req.method,
      path: pathname,
      payee,
      timestamp: ts,
      body,
      signature: sig
    });
  } catch (_e) {
    sendJson(res, 401, makeError("SCP_012_UNAUTHORIZED", "invalid payee auth signature"));
    return false;
  }
  if (String(recovered || "").toLowerCase() !== String(payee || "").toLowerCase()) {
    sendJson(res, 401, makeError("SCP_012_UNAUTHORIZED", "payee signature mismatch"));
    return false;
  }
  return true;
}

function resolveClientIp(req) {
  // Only trust X-Forwarded-For when behind a known reverse proxy.
  // Without this, attackers can spoof the header to bypass rate limits.
  if (TRUST_PROXY) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.trim()) {
      return fwd.split(",")[0].trim();
    }
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
}

function routeRateLimit(req, pathname) {
  if (req.method === "POST" && pathname === "/v1/tickets/quote") return RATE_LIMIT_QUOTE;
  if (req.method === "POST" && pathname === "/v1/tickets/issue") return RATE_LIMIT_ISSUE;
  if (req.method === "POST" && pathname === "/v1/refunds") return RATE_LIMIT_REFUNDS;
  return RATE_LIMIT_DEFAULT;
}

function enforceRateLimit(req, res, pathname) {
  const limit = routeRateLimit(req, pathname);
  if (!Number.isFinite(limit) || limit <= 0) return true;

  const ts = now();
  const key = `${req.method}:${pathname}:${resolveClientIp(req)}`;
  const bucket = rateWindow.get(key);
  if (!bucket || ts >= bucket.resetAt) {
    rateWindow.set(key, { count: 1, resetAt: ts + RATE_LIMIT_WINDOW_SEC });
  } else if (bucket.count >= limit) {
    res.setHeader("Retry-After", String(Math.max(1, bucket.resetAt - ts)));
    sendJson(res, 429, makeError("SCP_011_RATE_LIMITED", "rate limit exceeded", true));
    return false;
  } else {
    bucket.count += 1;
  }

  // Opportunistic cleanup so this map does not grow without bound.
  if (Math.random() < 0.02) {
    for (const [k, b] of rateWindow.entries()) {
      if (ts >= b.resetAt) rateWindow.delete(k);
    }
  }
  return true;
}

async function sweepExpiredQuotes() {
  const ts = now();
  if (ts - lastQuoteSweepAt < QUOTE_SWEEP_INTERVAL_SEC) return 0;
  lastQuoteSweepAt = ts;
  let pruned = 0;
  await store.tx((s) => {
    const quotes = s.quotes || {};
    for (const [key, entry] of Object.entries(quotes)) {
      const expiry = Number(entry && entry.quote && entry.quote.expiry);
      if (!Number.isFinite(expiry) || expiry >= ts) continue;
      delete quotes[key];
      pruned += 1;
      const paymentId = entry && entry.quote && entry.quote.paymentId;
      if (paymentId && s.payments && s.payments[paymentId] && s.payments[paymentId].status === "quoted") {
        s.payments[paymentId].status = "expired";
      }
    }
  });
  return pruned;
}

async function handleRequest(req, res) {
  const { pathname } = url.parse(req.url, true);

  // CORS preflight
  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    return res.end();
  }

  try {
    if (!enforceRateLimit(req, res, pathname)) return;

    if (req.method === "GET" && pathname === "/.well-known/x402") {
      return sendJson(res, 200, {
        hubName: HUB_NAME,
        address: HUB_ADDRESS,
        chainId: CHAIN_ID,
        schemes: ["statechannel-hub-v1"],
        supportedAssets: [DEFAULT_ASSET, ethers.constants.AddressZero],
        modes: ["proxy_hold", "peer_simple"],
        signature: {
          format: SIG_FORMAT,
          keyId: "hub-main-1",
          publicKey: HUB_ADDRESS
        },
        feePolicy: {
          base: FEE_BASE.toString(),
          bps: Number(FEE_BPS),
          gasSurcharge: GAS_SURCHARGE.toString()
        }
      });
    }

    if (req.method === "POST" && pathname === "/v1/tickets/quote") {
      const body = await parseBody(req);
      if (!validate.quoteRequest(body)) {
        return sendJson(
          res,
          400,
          makeError("SCP_009_POLICY_VIOLATION", validationMessage(validate.quoteRequest))
        );
      }
      if (typeof body.quoteExpiry !== "number" || body.quoteExpiry <= now()) {
        return sendJson(
          res,
          400,
          makeError("SCP_009_POLICY_VIOLATION", "quoteExpiry must be future unix ts")
        );
      }
      await sweepExpiredQuotes();
      const existingPayment = await store.getPayment(body.paymentId);
      if (existingPayment) {
        return sendJson(
          res,
          409,
          makeError("SCP_009_POLICY_VIOLATION", "paymentId already exists")
        );
      }

      const { fee, breakdown } = calcFee(body.amount);
      const maxFee = BigInt(body.maxFee);
      if (fee > maxFee) {
        return sendJson(res, 400, makeError("SCP_003_FEE_EXCEEDS_MAX", "fee > maxFee"));
      }

      const amount = BigInt(body.amount);
      const totalDebit = amount + fee;
      const expiry = Math.min(body.quoteExpiry, now() + 120);
      const ticketDraft = {
        ticketId: randomId("tkt"),
        hub: HUB_ADDRESS,
        payee: body.payee,
        invoiceId: body.invoiceId,
        paymentId: body.paymentId,
        asset: body.asset,
        amount: body.amount,
        feeCharged: fee.toString(),
        totalDebit: totalDebit.toString(),
        expiry,
        policyHash: policyHash({
          channelId: body.channelId,
          chainId: CHAIN_ID,
          paymentMemo: body.paymentMemo || ""
        })
      };

      const quote = {
        invoiceId: body.invoiceId,
        paymentId: body.paymentId,
        ticketDraft,
        fee: fee.toString(),
        totalDebit: totalDebit.toString(),
        expiry,
        feeBreakdown: breakdown
      };
      if (!validate.quoteResponse(quote)) {
        return sendJson(
          res,
          500,
          makeError("SCP_009_POLICY_VIOLATION", validationMessage(validate.quoteResponse), true)
        );
      }

      await store.tx((s) => {
        s.quotes[`${body.invoiceId}:${body.paymentId}`] = {
          quote,
          channelId: body.channelId,
          contextHash: body.contextHash || ZERO32,
          createdAt: now()
        };
        s.payments[body.paymentId] = {
          paymentId: body.paymentId,
          status: "quoted"
        };
      });

      return sendJson(res, 200, quote);
    }

    if (req.method === "POST" && pathname === "/v1/tickets/issue") {
      const body = await parseBody(req);
      if (!validate.issueRequest(body)) {
        return sendJson(
          res,
          400,
          makeError("SCP_009_POLICY_VIOLATION", validationMessage(validate.issueRequest))
        );
      }

      const submittedQuote = body.quote;
      const key = `${submittedQuote.invoiceId}:${submittedQuote.paymentId}`;
      const stored = await store.getQuote(key);
      if (!stored) return sendJson(res, 409, makeError("SCP_002_QUOTE_EXPIRED", "quote not found"));
      const quote = stored.quote;
      if (stableStringify(submittedQuote) !== stableStringify(quote)) {
        return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION", "quote mismatch"));
      }

      if (quote.expiry < now()) {
        return sendJson(res, 409, makeError("SCP_002_QUOTE_EXPIRED", "quote expired"));
      }
      if (body.channelState.channelId !== stored.channelId) {
        return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION", "channel mismatch"));
      }
      if (stored.contextHash && body.channelState.contextHash !== stored.contextHash) {
        return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION", "context hash mismatch"));
      }
      if (body.channelState.stateExpiry <= now()) {
        return sendJson(res, 409, makeError("SCP_006_STATE_EXPIRED", "state expired"));
      }
      let recoveredA;
      try {
        recoveredA = recoverChannelStateSigner(body.channelState, body.sigA);
      } catch (_e) {
        return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION", "invalid sigA"));
      }

      const existingChannel = await store.getChannel(body.channelState.channelId);
      let stateBalA;
      let stateBalB;
      let stateTotal;
      let quoteDebit;
      try {
        stateBalA = parseUint(body.channelState.balA, "balA");
        stateBalB = parseUint(body.channelState.balB, "balB");
        stateTotal = stateBalA + stateBalB;
        quoteDebit = parseUint(quote.totalDebit, "totalDebit");
      } catch (e) {
        return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION", e.message));
      }

      if (existingChannel && existingChannel.latestState) {
        if (Number(body.channelState.stateNonce) !== Number(existingChannel.latestNonce) + 1) {
          return sendJson(res, 409, makeError("SCP_005_NONCE_CONFLICT", "stateNonce must increase by 1"));
        }
        if (String(existingChannel.participantA || "").toLowerCase() !== recoveredA.toLowerCase()) {
          return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION", "participantA mismatch"));
        }
        let prevBalA;
        let prevBalB;
        try {
          prevBalA = parseUint(existingChannel.latestState.balA, "prev balA");
          prevBalB = parseUint(existingChannel.latestState.balB, "prev balB");
        } catch (e) {
          return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION", e.message));
        }
        const prevTotal = prevBalA + prevBalB;
        if (stateTotal !== prevTotal) {
          return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION", "channel balance invariant violated"));
        }
        if (prevBalA - stateBalA !== quoteDebit || stateBalB - prevBalB !== quoteDebit) {
          return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION", "state delta must equal quote totalDebit"));
        }
      } else {
        // SECURITY: First-seen channel — verify on-chain before issuing any ticket.
        // Without this, an attacker can submit arbitrary channelIds with fabricated
        // balances and get the hub to sign tickets (creating uncollectible liability).
        if (Number(body.channelState.stateNonce) < 1) {
          return sendJson(res, 409, makeError("SCP_005_NONCE_CONFLICT", "first stateNonce must be >= 1"));
        }
        const hubSigner = getHubSigner();
        if (!hubSigner || !CONTRACT_ADDRESS) {
          return sendJson(res, 503, makeError("SCP_010_SETTLEMENT_UNAVAILABLE",
            "on-chain verification required for first payment on a channel (set RPC_URL, CONTRACT_ADDRESS)"));
        }
        let onChainData;
        try {
          const contract = new ethers.Contract(CONTRACT_ADDRESS, CHANNEL_ABI, hubSigner);
          onChainData = await contract.getChannel(body.channelState.channelId);
        } catch (e) {
          return sendJson(res, 409, makeError("SCP_007_CHANNEL_NOT_FOUND",
            "on-chain channel lookup failed: " + (e.message || "unknown error")));
        }
        // Verify channel exists (participantA != address(0))
        if (!onChainData || !onChainData.participantA ||
            onChainData.participantA === ethers.constants.AddressZero) {
          return sendJson(res, 409, makeError("SCP_007_CHANNEL_NOT_FOUND",
            "channel does not exist on-chain"));
        }
        // Verify hub is a participant
        const pA = onChainData.participantA.toLowerCase();
        const pB = onChainData.participantB.toLowerCase();
        if (pA !== HUB_ADDRESS.toLowerCase() && pB !== HUB_ADDRESS.toLowerCase()) {
          return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION",
            "hub is not a participant in this channel"));
        }
        // Verify the signer is the other participant (not the hub)
        const expectedPayer = pA === HUB_ADDRESS.toLowerCase() ? pB : pA;
        if (recoveredA.toLowerCase() !== expectedPayer) {
          return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION",
            "sigA must recover to the non-hub channel participant"));
        }
        // Verify channel is live (not closing, not expired)
        if (onChainData.isClosing) {
          return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION",
            "channel is closing"));
        }
        const chainExpiry = Number(onChainData.channelExpiry);
        if (chainExpiry > 0 && chainExpiry <= now()) {
          return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION",
            "channel expired on-chain"));
        }
        // Verify balance invariant: balA + balB must equal on-chain totalBalance
        const onChainTotal = BigInt(onChainData.totalBalance.toString());
        if (stateTotal !== onChainTotal) {
          return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION",
            `state balance total (${stateTotal}) != on-chain totalBalance (${onChainTotal})`));
        }
        // Verify debit is correct for first state (starting from full balance on payer side)
        if (onChainTotal - stateBalA !== quoteDebit || stateBalB !== quoteDebit) {
          return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION",
            "first state delta must equal quote totalDebit from full payer balance"));
        }
      }

      const ticket = { ...quote.ticketDraft, sig: await signTicketDraft(quote.ticketDraft, wallet) };
      if (!validate.ticket(ticket)) {
        return sendJson(
          res,
          500,
          makeError("SCP_009_POLICY_VIOLATION", validationMessage(validate.ticket), true)
        );
      }

      const sigB = await signChannelState(body.channelState, wallet);
      const channelAck = {
        stateNonce: body.channelState.stateNonce,
        stateHash: hashChannelState(body.channelState),
        sigB
      };

      await store.tx((s) => {
        // C6: Mark quote as consumed to prevent reuse
        delete s.quotes[key];

        const issuedPayment = {
          paymentId: quote.paymentId,
          status: "issued",
          createdAt: now(),
          invoiceId: quote.invoiceId,
          ticketId: ticket.ticketId,
          stateNonce: body.channelState.stateNonce,
          channelId: body.channelState.channelId,
          payee: ticket.payee,
          asset: ticket.asset,
          amount: ticket.amount,
          fee: ticket.feeCharged,
          totalDebit: ticket.totalDebit
        };
        s.payments[quote.paymentId] = issuedPayment;
        indexIssuedPayment(s, issuedPayment);
        s.channels[body.channelState.channelId] = {
          channelId: body.channelState.channelId,
          latestNonce: body.channelState.stateNonce,
          status: "open",
          latestState: body.channelState,
          participantA: recoveredA,
          sigA: body.sigA,
          sigB
        };
        const payee = String(ticket.payee || "").toLowerCase();
        if (!s.payeeLedger[payee]) s.payeeLedger[payee] = [];
        const seq = Number(s.nextSeq || 1);
        s.payeeLedger[payee].push({
          seq,
          createdAt: now(),
          paymentId: quote.paymentId,
          invoiceId: quote.invoiceId,
          ticketId: ticket.ticketId,
          amount: ticket.amount,
          asset: ticket.asset,
          status: "issued"
        });
        s.nextSeq = seq + 1;
      });

      // Update Hub↔Payee channel state (if open)
      let hubChannelAck = null;
      const payeeKey = String(ticket.payee || "").toLowerCase();
      const hc = await store.getHubChannel(payeeKey);
      if (hc && hc.channelId && hc.status !== "closed") {
        const paymentAmount = BigInt(ticket.amount);
        if (BigInt(hc.balA) < paymentAmount) {
          return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION", "hub-payee channel balance insufficient"));
        }
        const newBalA = (BigInt(hc.balA) - paymentAmount).toString();
        const newBalH = (BigInt(hc.balB) + paymentAmount).toString();
        const newNonce = hc.nonce + 1;
        const hcState = {
          channelId: hc.channelId,
          stateNonce: newNonce,
          balA: newBalA,
          balB: newBalH,
          locksRoot: ZERO32,
          stateExpiry: now() + 3600,
          contextHash: body.channelState.contextHash || ZERO32
        };
        const hcSigA = await signChannelState(hcState, wallet);
        hc.balA = newBalA;
        hc.balB = newBalH;
        hc.nonce = newNonce;
        hc.latestState = hcState;
        hc.sigA = hcSigA;
        hc.status = "open";
        await store.setHubChannel(payeeKey, hc);
        hubChannelAck = { channelId: hc.channelId, stateNonce: newNonce, balB: newBalH, sigA: hcSigA };
      }

      webhooks.emit(EVENT.PAYMENT_RECEIVED, {
        channelId: body.channelState.channelId,
        paymentId: quote.paymentId,
        ticketId: ticket.ticketId,
        payee: ticket.payee,
        amount: ticket.amount,
        asset: ticket.asset
      });

      // Emit balance.low when agent's remaining balance drops below 10% of total
      const balA = BigInt(body.channelState.balA);
      const totalBal = balA + BigInt(body.channelState.balB);
      if (totalBal > 0n && balA * 10n < totalBal) {
        webhooks.emit(EVENT.BALANCE_LOW, {
          channelId: body.channelState.channelId,
          balA: balA.toString(),
          totalBalance: totalBal.toString(),
          pctRemaining: Number((balA * 100n) / totalBal)
        });
      }

      return sendJson(res, 200, {
        ...ticket,
        channelAck,
        ...(hubChannelAck ? { hubChannelAck } : {})
      });
    }

    if (req.method === "POST" && pathname === "/v1/refunds") {
      const body = await parseBody(req);
      if (!validate.refundRequest(body)) {
        return sendJson(
          res,
          400,
          makeError("SCP_009_POLICY_VIOLATION", validationMessage(validate.refundRequest))
        );
      }

      // C4: Validate ticket exists and refund amount doesn't exceed original
      const ticketPayment = await store.getPaymentByTicketId(body.ticketId);
      if (!ticketPayment) {
        return sendJson(res, 404, makeError("SCP_007_CHANNEL_NOT_FOUND", "ticket not found or already refunded"));
      }
      if (ticketPayment.status !== "issued") {
        return sendJson(res, 404, makeError("SCP_007_CHANNEL_NOT_FOUND", "ticket not found or already refunded"));
      }

      // AUTH: require payee auth — only the payee who received the ticket can trigger refunds
      const refundPayee = String(ticketPayment.payee || "").toLowerCase();
      if (!requirePayeeAuth(req, res, pathname, refundPayee, body)) return;

      if (BigInt(body.refundAmount) > BigInt(ticketPayment.amount)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "refund exceeds original amount"));
      }

      // Build a signed refund state so the payer can advance channel state after refund.
      const ch = await store.getChannel(ticketPayment.channelId);
      if (!ch || !ch.latestState) {
        return sendJson(res, 409, makeError("SCP_007_CHANNEL_NOT_FOUND", "channel state unavailable for refund"));
      }
      const latestState = ch.latestState;

      // Refund math: refund the requested amount, plus pro-rata fee portion.
      // If refundAmount == original amount, refund the full totalDebit (amount + fee).
      // If partial, refund amount + proportional fee.
      const originalAmount = BigInt(ticketPayment.amount || "0");
      const originalTotalDebit = BigInt(ticketPayment.totalDebit || ticketPayment.amount || "0");
      const originalFee = originalTotalDebit - originalAmount;
      const refundAmount = BigInt(body.refundAmount);
      let refundDebit;
      if (refundAmount === originalAmount) {
        // Full refund — return amount + entire fee
        refundDebit = originalTotalDebit;
      } else {
        // Partial refund — return amount + pro-rata fee
        const feeRefund = originalAmount > 0n ? (originalFee * refundAmount / originalAmount) : 0n;
        refundDebit = refundAmount + feeRefund;
      }

      const prevBalA = BigInt(latestState.balA || "0");
      const prevBalB = BigInt(latestState.balB || "0");
      if (refundDebit <= 0n) {
        return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION", "invalid refund debit"));
      }
      if (prevBalB < refundDebit) {
        return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION", "insufficient channel balB for refund"));
      }
      const stateNonce = Number(ch.latestNonce) + 1;
      const receiptId = randomId("rfd");
      const refundState = {
        channelId: latestState.channelId,
        stateNonce,
        balA: (prevBalA + refundDebit).toString(),
        balB: (prevBalB - refundDebit).toString(),
        locksRoot: latestState.locksRoot || ZERO32,
        stateExpiry: now() + 120,
        contextHash: ethers.utils.keccak256(
          Buffer.from(`refund:${ticketPayment.paymentId}:${receiptId}:${body.reason || ""}`, "utf8")
        )
      };
      const sigB = await signChannelState(refundState, wallet);
      const channelAck = {
        stateNonce: refundState.stateNonce,
        stateHash: hashChannelState(refundState),
        sigB
      };

      await store.tx((s) => {
        s.payments[ticketPayment.paymentId].status = "refunded";
        s.payments[ticketPayment.paymentId].refundedAt = now();
        s.payments[ticketPayment.paymentId].refundReceiptId = receiptId;
        s.payments[ticketPayment.paymentId].refundAmount = body.refundAmount;
        s.payments[ticketPayment.paymentId].refundTotalDebit = refundDebit.toString();
        s.channels[ticketPayment.channelId] = {
          ...s.channels[ticketPayment.channelId],
          latestNonce: refundState.stateNonce,
          latestState: refundState,
          sigA: null,
          sigB
        };
        const payee = String(ticketPayment.payee || "").toLowerCase();
        const entries = (s.payeeLedger && s.payeeLedger[payee]) || [];
        for (const entry of entries) {
          if (entry.paymentId === ticketPayment.paymentId && entry.status === "issued") {
            entry.status = "refunded";
            entry.refundedAt = now();
            entry.refundReceiptId = receiptId;
            break;
          }
        }
      });

      webhooks.emit(EVENT.PAYMENT_REFUNDED, {
        ticketId: body.ticketId,
        receiptId,
        amount: body.refundAmount,
        stateNonce,
        channelId: refundState.channelId
      });

      return sendJson(res, 200, {
        ticketId: body.ticketId,
        amount: body.refundAmount,
        stateNonce,
        receiptId,
        refundedTotalDebit: refundDebit.toString(),
        channelState: refundState,
        channelAck
      });
    }

    if (req.method === "GET" && pathname.startsWith("/v1/payments/")) {
      const paymentId = pathname.split("/").pop();
      const payment = await store.getPayment(paymentId);
      if (!payment) return sendJson(res, 404, makeError("SCP_007_CHANNEL_NOT_FOUND", "payment not found"));
      return sendJson(res, 200, payment);
    }

    if (req.method === "GET" && pathname.startsWith("/v1/channels/")) {
      const channelId = pathname.split("/").pop();
      if (!isHex32(channelId)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "invalid channel id"));
      }
      const ch = (await store.getChannel(channelId)) || {
        channelId,
        latestNonce: 0,
        status: "open"
      };
      // SECURITY: redact signatures and raw state — these are close authorizations.
      // Exposing both sigA+sigB would let anyone call cooperativeClose on-chain.
      const { sigA, sigB, latestState, ...safe } = ch;
      return sendJson(res, 200, {
        ...safe,
        hasSignedState: !!(sigA || sigB)
      });
    }

    if (req.method === "GET" && pathname === "/v1/payee/inbox") {
      const parsed = url.parse(req.url, true);
      const payee = String((parsed.query && parsed.query.payee) || "").toLowerCase();
      const since = Number((parsed.query && parsed.query.since) || 0);
      const limitRaw = Number((parsed.query && parsed.query.limit) || 50);
      const limit = Math.min(Math.max(limitRaw, 1), 500);
      if (!isHexAddress(payee)) {
        return sendJson(
          res,
          400,
          makeError("SCP_009_POLICY_VIOLATION", "payee query must be 0x address")
        );
      }
      const ledger = await store.getLedger(payee);
      const items = ledger.filter((x) => Number(x.seq) > since).slice(0, limit);
      const nextCursor = items.length ? Number(items[items.length - 1].seq) : since;
      return sendJson(res, 200, {
        payee,
        since,
        count: items.length,
        nextCursor,
        items
      });
    }

    if (req.method === "GET" && pathname === "/v1/agent/summary") {
      const parsed = url.parse(req.url, true);
      const channelId = parsed.query && parsed.query.channelId;
      if (!channelId || !isHex32(channelId)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "channelId required"));
      }
      const ch = await store.getChannel(channelId);
      if (!ch) {
        return sendJson(res, 200, { channelId, payments: 0, totalSpent: "0", totalFees: "0", latestNonce: 0 });
      }
      const payments = await store.listPaymentsByChannel(channelId);
      return sendJson(res, 200, buildAgentSummary(channelId, ch.latestNonce, payments));
    }

    if (req.method === "GET" && pathname === "/v1/agent/receipts") {
      const parsed = url.parse(req.url, true);
      const channelId = (parsed.query && parsed.query.channelId) || null;
      const payeeFilter = String((parsed.query && parsed.query.payee) || "").toLowerCase();
      const since = Number((parsed.query && parsed.query.since) || 0);
      const limitRaw = Number((parsed.query && parsed.query.limit) || 100);
      const limit = Math.min(Math.max(limitRaw, 1), 1000);
      if (channelId && !isHex32(channelId)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "invalid channelId"));
      }
      if (payeeFilter && !isHexAddress(payeeFilter)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "invalid payee"));
      }

      let payments;
      if (channelId) {
        payments = await store.listPaymentsByChannel(channelId);
      } else if (payeeFilter) {
        payments = await store.listPaymentsByPayee(payeeFilter);
      } else {
        payments = Object.values(await store.listPayments());
      }
      return sendJson(res, 200, buildAgentReceipts(payments, {
        since,
        limit,
        channelId,
        payee: payeeFilter
      }));
    }

    if (req.method === "GET" && pathname === "/v1/payee/balance") {
      const parsed = url.parse(req.url, true);
      const payee = String((parsed.query && parsed.query.payee) || "").toLowerCase();
      if (!isHexAddress(payee)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "payee must be 0x address"));
      }
      const ledger = await store.getLedger(payee);
      let earned = 0n;
      let settled = 0n;
      for (const entry of ledger) {
        const amt = BigInt(entry.amount);
        if (entry.status === "refunded") {
          earned -= amt;
          continue;
        }
        earned += amt;
        if (entry.status === "settled") settled += BigInt(entry.amount);
      }
      return sendJson(res, 200, {
        payee,
        earned: earned.toString(),
        settled: settled.toString(),
        unsettled: (earned - settled).toString(),
        payments: ledger.length
      });
    }

    if (req.method === "GET" && pathname === "/v1/payee/receipts") {
      const parsed = url.parse(req.url, true);
      const payee = String((parsed.query && parsed.query.payee) || "").toLowerCase();
      const since = Number((parsed.query && parsed.query.since) || 0);
      const statusFilter = String((parsed.query && parsed.query.status) || "").toLowerCase();
      const limitRaw = Number((parsed.query && parsed.query.limit) || 100);
      const limit = Math.min(Math.max(limitRaw, 1), 1000);
      if (!isHexAddress(payee)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "payee must be 0x address"));
      }
      if (statusFilter && statusFilter !== "issued" && statusFilter !== "settled" && statusFilter !== "refunded") {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "status must be issued|settled|refunded"));
      }

      const ledger = await store.getLedger(payee);
      const filtered = ledger
        .filter((x) => Number(x.createdAt || 0) > since)
        .filter((x) => !statusFilter || String(x.status || "").toLowerCase() === statusFilter)
        .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
        .slice(0, limit);
      const nextCursor = filtered.length ? Number(filtered[filtered.length - 1].createdAt || since) : since;

      return sendJson(res, 200, {
        payee,
        since,
        count: filtered.length,
        nextCursor,
        items: filtered
      });
    }

    // --- Hub↔Payee channel management ---

    if (req.method === "POST" && pathname === "/v1/hub/open-payee-channel") {
      const body = await parseBody(req);
      const payee = String(body.payee || "").toLowerCase();
      if (!isHexAddress(payee)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "payee must be 0x address"));
      }
      if (!requirePayeeAuth(req, res, pathname, payee, body)) return;
      const signer = getHubSigner();
      if (!signer || !CONTRACT_ADDRESS) {
        return sendJson(res, 503, makeError("SCP_010_SETTLEMENT_UNAVAILABLE", "hub has no on-chain provider or contract (set RPC_URL, CONTRACT_ADDRESS)", true));
      }
      const existing = await store.getHubChannel(payee);
      if (existing && existing.channelId && existing.status !== "closed") {
        return sendJson(res, 200, { channelId: existing.channelId, message: "already open", ...existing });
      }
      const asset = body.asset || ethers.constants.AddressZero;
      const deposit = BigInt(body.deposit || "0");
      const challengePeriod = Number(body.challengePeriodSec || 300);
      const expiry = Number(body.channelExpiry || now() + 86400);
      const salt = ethers.utils.formatBytes32String(`hb-${now()}-${payee.slice(2, 8)}`);

      try {
        const contract = new ethers.Contract(CONTRACT_ADDRESS, CHANNEL_ABI, signer);
        const txOpts = asset === ethers.constants.AddressZero
          ? { value: deposit, gasLimit: 200000 }
          : { gasLimit: 200000 };
        const tx = await contract.openChannel(
          ethers.utils.getAddress(payee), asset, deposit,
          challengePeriod, expiry, salt, txOpts
        );
        const rc = await tx.wait(1);
        const ev = rc.events.find(e => e.event === "ChannelOpened");
        const channelId = ev.args.channelId;
        const hubChannel = {
          channelId,
          payee: ethers.utils.getAddress(payee),
          asset,
          totalDeposit: deposit.toString(),
          balA: deposit.toString(),
          balB: "0",
          status: "open",
          nonce: 0,
          latestState: null,
          sigA: null,
          txHash: tx.hash
        };
        await store.setHubChannel(payee, hubChannel);
        return sendJson(res, 200, hubChannel);
      } catch (err) {
        return sendJson(res, 500, makeError("SCP_011_SETTLEMENT_FAILED", err.message || "open channel failed", true));
      }
    }

    if (req.method === "POST" && pathname === "/v1/hub/register-payee-channel") {
      const body = await parseBody(req);
      const payee = String(body.payee || "").toLowerCase();
      if (!isHexAddress(payee) || !body.channelId) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "payee and channelId required"));
      }
      if (!requirePayeeAuth(req, res, pathname, payee, body)) return;
      const existing = await store.getHubChannel(payee);
      if (existing && existing.channelId && existing.status !== "closed") {
        return sendJson(res, 200, { message: "already registered", ...existing });
      }
      const hubChannel = {
        channelId: body.channelId,
        payee: ethers.utils.getAddress(payee),
        asset: body.asset || ethers.constants.AddressZero,
        totalDeposit: body.totalDeposit || "0",
        balA: body.totalDeposit || "0",
        balB: "0",
        status: "open",
        nonce: 0,
        latestState: null,
        sigA: null
      };
      await store.setHubChannel(payee, hubChannel);
      return sendJson(res, 200, hubChannel);
    }

    if (req.method === "GET" && pathname === "/v1/payee/channel-state") {
      const parsed = url.parse(req.url, true);
      const payee = String((parsed.query && parsed.query.payee) || "").toLowerCase();
      if (!isHexAddress(payee)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "payee must be 0x address"));
      }
      const hc = await store.getHubChannel(payee);
      if (!hc || !hc.channelId) {
        return sendJson(res, 404, makeError("SCP_007_CHANNEL_NOT_FOUND", "no hub channel for this payee"));
      }
      return sendJson(res, 200, {
        channelId: hc.channelId,
        payee: hc.payee,
        asset: hc.asset,
        totalDeposit: hc.totalDeposit,
        balA: hc.balA,
        balB: hc.balB,
        status: hc.status || "open",
        nonce: hc.nonce,
        latestState: hc.latestState,
        sigA: hc.sigA
      });
    }

    if (req.method === "POST" && pathname === "/v1/payee/settle") {
      const body = await parseBody(req);
      const payee = String(body.payee || "").toLowerCase();
      if (!isHexAddress(payee)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "payee must be 0x address"));
      }
      if (!requirePayeeAuth(req, res, pathname, payee, body)) return;
      const signer = getHubSigner();
      if (!signer) {
        return sendJson(res, 503, makeError("SCP_010_SETTLEMENT_UNAVAILABLE", "hub has no on-chain provider (set RPC_URL)", true));
      }
      const asset = String(body.asset || ethers.constants.AddressZero);
      let settlementMode;
      try {
        settlementMode = parseSettlementMode(body.mode);
      } catch (e) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", e.message));
      }
      let idemKey;
      try {
        idemKey = parseIdempotencyKey(req, body);
      } catch (e) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", e.message));
      }
      const settlementId = randomId("stl");
      const idemScopeKey = idemKey ? `${payee}:${asset.toLowerCase()}:${settlementMode}:${idemKey}` : "";
      let idemReplay = null;
      if (idemScopeKey) {
        await store.tx((s) => {
          if (!s.settlementsByIdempotency || typeof s.settlementsByIdempotency !== "object") {
            s.settlementsByIdempotency = {};
          }
          if (!s.settlements || typeof s.settlements !== "object") {
            s.settlements = {};
          }
          const existingId = s.settlementsByIdempotency[idemScopeKey];
          if (existingId && s.settlements[existingId]) {
            idemReplay = s.settlements[existingId];
            return;
          }
          s.settlementsByIdempotency[idemScopeKey] = settlementId;
          s.settlements[settlementId] = {
            settlementId,
            payee,
            asset,
            mode: settlementMode,
            idempotencyKey: idemKey,
            status: "pending",
            createdAt: now()
          };
        });
        if (idemReplay) {
          if (idemReplay.status === "completed") {
            return sendJson(res, 200, {
              payee: idemReplay.payee,
              amount: idemReplay.amount,
              asset: idemReplay.asset,
              txHash: idemReplay.txHash,
              settledCount: idemReplay.settledCount,
              mode: idemReplay.mode,
              settlementId: idemReplay.settlementId,
              idempotentReplay: true
            });
          }
          if (idemReplay.status === "pending") {
            return sendJson(
              res,
              409,
              makeError("SCP_011_SETTLEMENT_IN_PROGRESS", "idempotent settlement is still pending", true)
            );
          }
          return sendJson(
            res,
            409,
            makeError("SCP_011_SETTLEMENT_FAILED", "idempotent settlement previously failed; use a new key", true)
          );
        }
      }

      // Atomically reserve unsettled entries to prevent concurrent double-settlement.
      // SECURITY: only sum entries matching the requested asset to prevent cross-asset errors.
      let unsettled = 0n;
      const unsettledEntries = [];
      const normalizedAsset = asset.toLowerCase();
      await store.tx((s) => {
        const entries = s.payeeLedger[payee] || [];
        for (const entry of entries) {
          if (entry.status === "issued" && String(entry.asset || "").toLowerCase() === normalizedAsset) {
            unsettled += BigInt(entry.amount);
            entry.status = "settling";
            entry.settlementId = settlementId;
            unsettledEntries.push({
              paymentId: entry.paymentId,
              amount: entry.amount
            });
          }
        }
      });
      if (unsettled === 0n) {
        if (idemScopeKey) {
          await store.tx((s) => {
            if (!s.settlements) s.settlements = {};
            s.settlements[settlementId] = {
              ...(s.settlements[settlementId] || {}),
              settlementId,
              payee,
              asset,
              status: "completed",
              amount: "0",
              settledCount: 0,
              mode: settlementMode,
              txHash: null,
              completedAt: now()
            };
          });
        }
        return sendJson(res, 200, { payee, amount: "0", message: "nothing to settle", mode: settlementMode });
      }

      // Send on-chain
      let txHash;
      let closeChannelId = null;
      let closeSigB = "";
      const failSettlement = (status, code, message) => {
        const err = new Error(message);
        err.httpStatus = status;
        err.errorCode = code;
        throw err;
      };
      try {
        if (settlementMode === "cooperative_close") {
          if (!CONTRACT_ADDRESS) {
            failSettlement(503, "SCP_010_SETTLEMENT_UNAVAILABLE", "contract address required for cooperative_close settlement");
          }
          const hc = await store.getHubChannel(payee);
          if (!hc || !hc.channelId || hc.status === "closed" || !hc.latestState || !hc.sigA) {
            failSettlement(409, "SCP_007_CHANNEL_NOT_FOUND", "no open hub-payee channel with signed state");
          }
          let channelBalB;
          try {
            channelBalB = BigInt(hc.balB || "0");
          } catch (_e) {
            failSettlement(409, "SCP_009_POLICY_VIOLATION", "invalid hub-payee channel balance");
          }
          if (channelBalB !== unsettled) {
            failSettlement(
              409,
              "SCP_009_POLICY_VIOLATION",
              "hub-payee channel balB does not match unsettled ledger; use direct mode or reopen channel"
            );
          }
          closeSigB = typeof body.sigB === "string" ? body.sigB : "";
          if (!closeSigB) {
            failSettlement(400, "SCP_009_POLICY_VIOLATION", "sigB is required for cooperative_close settlement");
          }
          let recoveredB;
          try {
            recoveredB = recoverChannelStateSigner(hc.latestState, closeSigB);
          } catch (_e) {
            failSettlement(409, "SCP_009_POLICY_VIOLATION", "invalid sigB");
          }
          if (!recoveredB || recoveredB.toLowerCase() !== payee.toLowerCase()) {
            failSettlement(409, "SCP_009_POLICY_VIOLATION", "sigB must recover to payee");
          }
          const contract = new ethers.Contract(CONTRACT_ADDRESS, CHANNEL_ABI, signer);
          const tx = await contract.cooperativeClose(hc.latestState, hc.sigA, closeSigB, { gasLimit: 250000 });
          const receipt = await tx.wait(1);
          if (!receipt || Number(receipt.status) !== 1) {
            failSettlement(500, "SCP_011_SETTLEMENT_FAILED", "cooperative close reverted");
          }
          txHash = tx.hash;
          closeChannelId = hc.channelId;
        } else {
          if (asset === ethers.constants.AddressZero) {
            const tx = await signer.sendTransaction({
              to: ethers.utils.getAddress(payee),
              value: unsettled,
              gasLimit: 21000
            });
            const receipt = await tx.wait(1);
            if (!receipt || Number(receipt.status) !== 1) {
              failSettlement(500, "SCP_011_SETTLEMENT_FAILED", "settlement transaction reverted");
            }
            txHash = tx.hash;
          } else {
            const erc20 = new ethers.Contract(
              asset,
              ["function transfer(address to, uint256 amount) returns (bool)"],
              signer
            );
            const tx = await erc20.transfer(ethers.utils.getAddress(payee), unsettled, { gasLimit: 60000 });
            const receipt = await tx.wait(1);
            if (!receipt || Number(receipt.status) !== 1) {
              failSettlement(500, "SCP_011_SETTLEMENT_FAILED", "settlement token transfer reverted");
            }
            txHash = tx.hash;
          }
        }
      } catch (err) {
        await store.tx((s) => {
          const entries = s.payeeLedger[payee] || [];
          for (const entry of entries) {
            if (entry.status === "settling" && entry.settlementId === settlementId) {
              entry.status = "issued";
              delete entry.settlementId;
            }
          }
          if (idemScopeKey) {
            if (!s.settlements) s.settlements = {};
            s.settlements[settlementId] = {
              ...(s.settlements[settlementId] || {}),
              settlementId,
              payee,
              asset,
              status: "failed",
              mode: settlementMode,
              code: err.errorCode || "SCP_011_SETTLEMENT_FAILED",
              error: err.message || "tx failed",
              failedAt: now()
            };
          }
        });
        const statusCode = Number(err.httpStatus) || 500;
        const errorCode = err.errorCode || "SCP_011_SETTLEMENT_FAILED";
        return sendJson(res, statusCode, makeError(errorCode, err.message || "tx failed", statusCode >= 500));
      }

      // Mark entries as settled
      await store.tx((s) => {
        const entries = s.payeeLedger[payee] || [];
        for (const entry of entries) {
          if (entry.status === "settling" && entry.settlementId === settlementId) {
            entry.status = "settled";
            entry.settleTx = txHash;
            entry.settledAt = now();
            delete entry.settlementId;
          }
        }
        if (idemScopeKey) {
          if (!s.settlements) s.settlements = {};
          s.settlements[settlementId] = {
            ...(s.settlements[settlementId] || {}),
            settlementId,
            payee,
            asset,
            status: "completed",
            mode: settlementMode,
            amount: unsettled.toString(),
            txHash,
            settledCount: unsettledEntries.length,
            completedAt: now()
          };
        }
        if (settlementMode === "cooperative_close") {
          const hc = s.hubChannels && s.hubChannels[payee];
          if (hc && hc.channelId === closeChannelId) {
            hc.status = "closed";
            hc.closedAt = now();
            hc.closeTx = txHash;
            hc.sigB = closeSigB;
          }
        }
      });

      return sendJson(res, 200, {
        payee,
        amount: unsettled.toString(),
        asset,
        mode: settlementMode,
        txHash,
        settledCount: unsettledEntries.length,
        ...(settlementMode === "cooperative_close" ? { channelId: closeChannelId } : {}),
        ...(idemScopeKey ? { settlementId } : {})
      });
    }

    // --- Webhooks ---

    if (req.method === "POST" && pathname === "/v1/webhooks") {
      if (!requireAdminAuth(req, res)) return;
      const body = await parseBody(req);
      const result = webhooks.register({
        url: body.url,
        events: body.events,
        channelId: body.channelId,
        secret: body.secret
      });
      if (result.error) return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", result.error));
      return sendJson(res, 201, result);
    }

    if (pathname.startsWith("/v1/webhooks/")) {
      if (!requireAdminAuth(req, res)) return;
      const webhookId = pathname.split("/").pop();
      if (req.method === "GET") {
        const hook = webhooks.get(webhookId);
        if (!hook) return sendJson(res, 404, makeError("SCP_009_POLICY_VIOLATION", "webhook not found"));
        return sendJson(res, 200, hook);
      }
      if (req.method === "PATCH") {
        const body = await parseBody(req);
        const existing = webhooks.get(webhookId);
        if (!existing) return sendJson(res, 404, makeError("SCP_009_POLICY_VIOLATION", "webhook not found"));
        const hook = webhooks.update(webhookId, body);
        if (!hook) return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "invalid webhook update"));
        return sendJson(res, 200, hook);
      }
      if (req.method === "DELETE") {
        const removed = webhooks.remove(webhookId);
        if (!removed) return sendJson(res, 404, makeError("SCP_009_POLICY_VIOLATION", "webhook not found"));
        return sendJson(res, 200, { deleted: true });
      }
    }

    if (req.method === "POST" && pathname === "/v1/events/emit") {
      if (!requireAdminAuth(req, res)) return;
      const body = await parseBody(req);
      const validEvents = Object.values(EVENT);
      if (!body.event || !validEvents.includes(body.event)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "invalid event type"));
      }
      const entry = webhooks.emit(body.event, body.data || {});
      return sendJson(res, 200, { ok: true, seq: entry.seq });
    }

    if (req.method === "GET" && pathname === "/v1/events") {
      if (!requireAdminAuth(req, res)) return;
      const parsed = url.parse(req.url, true);
      const since = Number(parsed.query.since || 0);
      const channelId = parsed.query.channelId || parsed.query.channel || null;
      const limit = Number(parsed.query.limit || 50);
      return sendJson(res, 200, webhooks.poll({ since, channelId, limit }));
    }

    return sendJson(res, 404, makeError("SCP_009_POLICY_VIOLATION", "route not found"));
  } catch (err) {
    if (err && err.statusCode === 413) {
      return sendJson(res, 413, makeError("SCP_009_POLICY_VIOLATION", "payload too large"));
    }
    if (err && err.statusCode === 400) {
      return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", err.message || "invalid request body"));
    }
    return sendJson(res, 500, makeError("SCP_009_POLICY_VIOLATION", err.message || "internal error", true));
  }
}

function createServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res);
  });
}

// --- Cluster mode ---

function startCluster(numWorkers) {
  const cpus = os.cpus().length;
  const n = numWorkers > 0 ? numWorkers : cpus;

  if (cluster.isMaster) {
    console.log(`SCP hub master pid=${process.pid}, spawning ${n} workers`);
    for (let i = 0; i < n; i++) cluster.fork();
    cluster.on("exit", (w, code) => {
      console.log(`worker ${w.process.pid} exited (${code}), restarting`);
      cluster.fork();
    });
  } else {
    const server = createServer();
    server.listen(PORT, HOST, () => {
      console.log(`SCP hub worker pid=${process.pid} on ${HOST}:${PORT} as ${HUB_NAME} (${HUB_ADDRESS})`);
    });
  }
}

if (require.main === module) {
  if (WORKERS > 1 || process.env.HUB_CLUSTER === "1") {
    if (!REDIS_URL && STORE_PATH === ":memory:") {
      console.error(
        "FATAL: Cluster mode requires shared persistent storage. STORE_PATH=:memory: is process-local.\n" +
        "Set STORE_PATH to a filesystem path (or use a shared backend) before enabling cluster mode."
      );
      process.exit(1);
    }
    if (process.env.ALLOW_UNSAFE_CLUSTER !== "1") {
      console.error(
        "FATAL: Hub cluster mode is disabled by default because some in-memory subsystems are worker-local (for example webhook event logs).\n" +
        "Run single-process (default), or set ALLOW_UNSAFE_CLUSTER=1 to force this at your own risk."
      );
      process.exit(1);
    }
    startCluster(WORKERS);
  } else {
    const server = createServer();
    server.listen(PORT, HOST, () => {
      console.log(`SCP hub listening on ${HOST}:${PORT} as ${HUB_NAME} (${HUB_ADDRESS})`);
    });
  }
}

module.exports = {
  createServer,
  handleRequest,
  webhooks
};
