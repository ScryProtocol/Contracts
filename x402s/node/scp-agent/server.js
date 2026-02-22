/* eslint-disable no-console */
const http = require("http");
const { URL } = require("url");
const { ScpAgentClient } = require("./agent-client");

const HOST = process.env.AGENT_HOST || "127.0.0.1";
const PORT = Number(process.env.AGENT_PORT || 4060);

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
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.length > 1024 * 1024) reject(new Error("payload too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (_e) {
        reject(new Error("invalid json body"));
      }
    });
    req.on("error", reject);
  });
}

function buildAgent() {
  const options = {
    networkAllowlist: (process.env.NETWORKS || process.env.NETWORK || "eip155:11155111")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    maxFeeDefault: process.env.MAX_FEE || "5000",
    maxAmountDefault: process.env.MAX_AMOUNT || "5000000"
  };
  if (process.env.AGENT_PRIVATE_KEY) options.privateKey = process.env.AGENT_PRIVATE_KEY;
  if (process.env.ASSET_ALLOWLIST) {
    options.assetAllowlist = process.env.ASSET_ALLOWLIST.split(",").map((x) => x.trim()).filter(Boolean);
  }
  if (process.env.AGENT_STATE_DIR) options.stateDir = process.env.AGENT_STATE_DIR;
  return new ScpAgentClient(options);
}

function summarizePayments(payments) {
  const rows = Object.entries(payments || {})
    .map(([paymentId, p]) => ({ paymentId, ...p }))
    .sort((a, b) => Number(b.paidAt || 0) - Number(a.paidAt || 0));
  const byApi = {};
  for (const p of rows) {
    if (!p.resourceUrl || !p.amount) continue;
    let key = p.resourceUrl;
    try {
      const u = new URL(p.resourceUrl);
      key = `${u.origin}${u.pathname}`;
    } catch (_e) {
      // keep raw url
    }
    if (!byApi[key]) byApi[key] = { api: key, payments: 0, earned: "0", lastPaidAt: 0 };
    byApi[key].payments += 1;
    byApi[key].earned = (BigInt(byApi[key].earned) + BigInt(p.amount)).toString();
    byApi[key].lastPaidAt = Math.max(byApi[key].lastPaidAt, Number(p.paidAt || 0));
  }
  const api = Object.values(byApi).sort((a, b) => {
    const ae = BigInt(a.earned);
    const be = BigInt(b.earned);
    if (ae !== be) return ae > be ? -1 : 1;
    return b.payments - a.payments;
  });
  return { rows, api };
}

function createAgentServer(options = {}) {
  const agent = options.agent || buildAgent();

  const server = http.createServer((req, res) => {
    (async () => {
      const u = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

      if (req.method === "GET" && u.pathname === "/health") {
        return sendJson(res, 200, { ok: true, wallet: agent.wallet.address });
      }

      if (req.method === "GET" && u.pathname === "/v1/channels") {
        return sendJson(res, 200, { items: agent.listChannels() });
      }

      if (req.method === "GET" && u.pathname === "/v1/payments") {
        const summary = summarizePayments(agent.state.payments || {});
        return sendJson(res, 200, { count: summary.rows.length, items: summary.rows });
      }

      if (req.method === "GET" && u.pathname === "/v1/payments/api-summary") {
        const summary = summarizePayments(agent.state.payments || {});
        return sendJson(res, 200, { count: summary.api.length, items: summary.api });
      }

      if (req.method === "POST" && u.pathname === "/v1/pay-resource") {
        const body = await parseBody(req);
        if (!body.url) return sendJson(res, 400, { error: "url is required" });
        const result = await agent.payResource(body.url, {
          route: body.route || "auto",
          network: body.network,
          asset: body.asset,
          method: body.method || "GET",
          requestHeaders: body.requestHeaders || {},
          requestBody: body.requestBody !== undefined ? body.requestBody : body.body,
          maxFee: body.maxFee,
          maxAmount: body.maxAmount,
          paymentId: body.paymentId
        });
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && u.pathname === "/v1/call-api") {
        const body = await parseBody(req);
        if (!body.url) return sendJson(res, 400, { error: "url is required" });
        const response = await agent.callApi(body.url, {
          route: body.route || "auto",
          network: body.network,
          asset: body.asset,
          method: body.method || "GET",
          requestHeaders: body.requestHeaders || {},
          requestBody: body.requestBody !== undefined ? body.requestBody : body.body,
          maxFee: body.maxFee,
          maxAmount: body.maxAmount,
          paymentId: body.paymentId
        });
        return sendJson(res, 200, response);
      }

      if (req.method === "POST" && u.pathname === "/v1/pay-channel") {
        const body = await parseBody(req);
        if (!body.channelId || !body.amount) {
          return sendJson(res, 400, { error: "channelId and amount are required" });
        }
        const result = await agent.payChannel(body.channelId, body.amount, {
          payee: body.payee,
          hubEndpoint: body.hubEndpoint,
          asset: body.asset
        });
        return sendJson(res, 200, result);
      }

      return sendJson(res, 404, { error: "route not found" });
    })().catch((err) => {
      sendJson(res, 500, { error: err.message || "internal error" });
    });
  });

  server.on("close", () => {
    agent.close();
  });

  return { server, agent };
}

if (require.main === module) {
  const { server } = createAgentServer();
  server.listen(PORT, HOST, () => {
    console.log(`SCP agent API listening on ${HOST}:${PORT}`);
  });
}

module.exports = { createAgentServer };
