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
const ASSET_ETH = ethers.constants.AddressZero;

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

function parsePaymentHeader(req) {
  const raw = req.headers["payment-signature"];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

function resolveResourceUrl(req) {
  if (PUBLIC_BASE_URL) {
    return `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/meow`;
  }
  const protoRaw = req.headers["x-forwarded-proto"];
  const hostRaw = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = typeof protoRaw === "string" && protoRaw.trim() ? protoRaw.split(",")[0].trim() : "http";
  const host = typeof hostRaw === "string" && hostRaw.trim() ? hostRaw.split(",")[0].trim() : `${HOST}:${PORT}`;
  return `${proto}://${host}/meow`;
}

function buildOfferPayload(req, ctx) {
  const invoiceId = randomId("inv");
  const quoteExpiry = now() + 120;
  const resource = resolveResourceUrl(req);
  ctx.invoices.set(invoiceId, {
    createdAt: now(),
    amount: amountWei,
    asset: ASSET_ETH,
    hubEndpoint: HUB_ENDPOINT
  });

  return {
    message: "Payment required for /meow",
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
            quoteExpiry,
            invoiceId,
            payeeAddress: PAYEE_ADDRESS
          }
        }
      }
    ]
  };
}

function issue402(req, res, ctx) {
  return sendJson(res, 402, buildOfferPayload(req, ctx));
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

  if (req.method === "GET" && u.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      network: `eip155:${chainId}`,
      payee: PAYEE_ADDRESS,
      meowPriceEth: PRICE_ETH,
      meowPriceWei: amountWei
    });
  }

  if (req.method === "GET" && u.pathname === "/pay") {
    return sendJson(res, 200, buildOfferPayload(req, ctx));
  }

  if (req.method === "GET" && u.pathname === "/meow") {
    const payment = parsePaymentHeader(req);
    if (!payment) return issue402(req, res, ctx);

    const checked = await validateHubPayment(payment, ctx);
    if (!checked.ok) return sendJson(res, 402, { error: checked.error, retryable: false });

    return sendJson(res, 200, {
      ok: true,
      meow: "meow",
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
    hubAddressCache: new Map(),
    http: new HttpJsonClient({ timeoutMs: 8000, maxSockets: 64 })
  };
  const server = http.createServer((req, res) => {
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
    console.log(`  price: ${PRICE_ETH} ETH (${amountWei} wei)`);
    console.log(`  network: eip155:${chainId}`);
    console.log(`  hub: ${HUB_NAME} @ ${HUB_ENDPOINT}`);
  });
}

module.exports = { createMeowServer, PAYEE_ADDRESS, amountWei, PRICE_ETH };
