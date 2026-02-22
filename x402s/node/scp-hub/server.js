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
const PAYEE_AUTH_MAX_SKEW_SEC = Number(process.env.PAYEE_AUTH_MAX_SKEW_SEC || 300);
const CHANNEL_ABI = [
  "function openChannel(address hub, address asset, uint256 amount, uint64 challengePeriodSec, uint64 channelExpiry, bytes32 salt) external payable returns (bytes32 channelId)",
  "event ChannelOpened(bytes32 indexed channelId, address indexed participantA, address indexed participantB, address asset, uint64 challengePeriodSec, uint64 channelExpiry)"
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

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
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
  if (!HUB_ADMIN_TOKEN) return true;
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

async function handleRequest(req, res) {
  const { pathname } = url.parse(req.url, true);

  try {
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
        if (Number(body.channelState.stateNonce) < 1) {
          return sendJson(res, 409, makeError("SCP_005_NONCE_CONFLICT", "first stateNonce must be >= 1"));
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
      if (hc && hc.channelId) {
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
      if (BigInt(body.refundAmount) > BigInt(ticketPayment.amount)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "refund exceeds original amount"));
      }

      // Use sequential nonce from channel state, not random
      const ch = await store.getChannel(ticketPayment.channelId);
      const stateNonce = ch ? Number(ch.latestNonce) + 1 : 1;
      const receiptId = randomId("rfd");

      await store.tx((s) => {
        s.payments[ticketPayment.paymentId].status = "refunded";
      });

      webhooks.emit(EVENT.PAYMENT_REFUNDED, {
        ticketId: body.ticketId,
        receiptId,
        amount: body.refundAmount,
        stateNonce
      });

      return sendJson(res, 200, {
        ticketId: body.ticketId,
        amount: body.refundAmount,
        stateNonce,
        receiptId
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
      return sendJson(res, 200, ch);
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
        earned += BigInt(entry.amount);
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
      if (statusFilter && statusFilter !== "issued" && statusFilter !== "settled") {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "status must be issued|settled"));
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
      if (existing && existing.channelId) {
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
      if (existing && existing.channelId) {
        return sendJson(res, 200, { message: "already registered", ...existing });
      }
      const hubChannel = {
        channelId: body.channelId,
        payee: ethers.utils.getAddress(payee),
        asset: body.asset || ethers.constants.AddressZero,
        totalDeposit: body.totalDeposit || "0",
        balA: body.totalDeposit || "0",
        balB: "0",
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

      // Atomically reserve unsettled entries to prevent concurrent double-settlement.
      let unsettled = 0n;
      const unsettledEntries = [];
      const settlementId = randomId("stl");
      await store.tx((s) => {
        const entries = s.payeeLedger[payee] || [];
        for (const entry of entries) {
          if (entry.status === "issued") {
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
        return sendJson(res, 200, { payee, amount: "0", message: "nothing to settle" });
      }

      // Send on-chain
      let txHash;
      try {
        if (asset === ethers.constants.AddressZero) {
          const tx = await signer.sendTransaction({
            to: ethers.utils.getAddress(payee),
            value: unsettled,
            gasLimit: 21000
          });
          await tx.wait(1);
          txHash = tx.hash;
        } else {
          const erc20 = new ethers.Contract(
            asset,
            ["function transfer(address to, uint256 amount) returns (bool)"],
            signer
          );
          const tx = await erc20.transfer(ethers.utils.getAddress(payee), unsettled, { gasLimit: 60000 });
          await tx.wait(1);
          txHash = tx.hash;
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
        });
        return sendJson(res, 500, makeError("SCP_011_SETTLEMENT_FAILED", err.message || "tx failed", true));
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
      });

      return sendJson(res, 200, {
        payee,
        amount: unsettled.toString(),
        asset,
        txHash,
        settledCount: unsettledEntries.length
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
