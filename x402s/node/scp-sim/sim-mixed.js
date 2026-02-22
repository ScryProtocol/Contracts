/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { hashChannelState } = require("../scp-hub/state-signing");

const HUB_HOST = process.env.SIM_HUB_HOST || "127.0.0.1";
const HUB_PORT = Number(process.env.SIM_HUB_PORT || 4421);
const HUB_URL = `http://${HUB_HOST}:${HUB_PORT}`;
const PAYEE_NODES = Number(process.env.SIM_PAYEES || 3);
const AGENT_NODES = Number(process.env.SIM_AGENTS || 3);
const API_CLIENTS = Number(process.env.SIM_API_CLIENTS || 3);
const ROUNDS = Number(process.env.SIM_ROUNDS || 2);
const BASE_PAYEE_PORT = Number(process.env.SIM_PAYEE_BASE_PORT || 4440);
const BASE_PRICE = BigInt(process.env.SIM_BASE_PRICE || "1000000");
const ASSET =
  process.env.DEFAULT_ASSET || "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913";
const NETWORK = process.env.NETWORK || "eip155:8453";
const PERF_MODE = process.env.SIM_PERF_MODE !== "0";

const simStateDir = path.resolve(__dirname, "./state-mixed");
const hubStorePath = path.join(simStateDir, "hub-store.sim-mixed.json");

function keyFromSeed(seed) {
  return `0x${crypto.createHash("sha256").update(seed).digest("hex")}`;
}

function nowMs() {
  return Date.now();
}

function reqJson(method, endpoint, body, headers = {}) {
  const u = new URL(endpoint);
  const payload = body ? JSON.stringify(body) : "";
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        headers: {
          "content-type": "application/json",
          ...headers,
          ...(payload ? { "content-length": Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString("utf8");
        });
        res.on("end", () => {
          try {
            resolve({
              statusCode: res.statusCode,
              body: data ? JSON.parse(data) : {}
            });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  fs.mkdirSync(simStateDir, { recursive: true });
  if (fs.existsSync(hubStorePath)) fs.rmSync(hubStorePath, { force: true });

  process.env.HOST = HUB_HOST;
  process.env.PORT = String(HUB_PORT);
  process.env.STORE_PATH = PERF_MODE ? ":memory:" : hubStorePath;
  process.env.NETWORK = NETWORK;
  process.env.DEFAULT_ASSET = ASSET;

  delete require.cache[require.resolve("../scp-hub/server")];
  delete require.cache[require.resolve("../scp-demo/payee-server")];
  delete require.cache[require.resolve("../scp-agent/agent-client")];

  const { createServer: createHubServer } = require("../scp-hub/server");
  const { createPayeeServer } = require("../scp-demo/payee-server");
  const { ScpAgentClient } = require("../scp-agent/agent-client");

  const hub = createHubServer();
  await new Promise((r) => hub.listen(HUB_PORT, HUB_HOST, r));

  const payees = [];
  for (let i = 0; i < PAYEE_NODES; i += 1) {
    const payeePrivateKey = keyFromSeed(`mixed-payee-${i}`);
    const payeeAddress = new ethers.Wallet(payeePrivateKey).address;
    const port = BASE_PAYEE_PORT + i;
    const price = (BASE_PRICE + BigInt(i * 25000)).toString();
    const server = createPayeeServer({
      host: HUB_HOST,
      port,
      hubUrl: HUB_URL,
      payeePrivateKey,
      network: NETWORK,
      asset: ASSET,
      price,
      perfMode: PERF_MODE
    });
    await new Promise((r) => server.listen(port, HUB_HOST, r));
    payees.push({
      id: `p${i}`,
      url: `http://${HUB_HOST}:${port}/v1/data`,
      payeeAddress,
      price,
      server
    });
  }

  const agents = [];
  for (let i = 0; i < AGENT_NODES; i += 1) {
    const stateDir = path.join(simStateDir, `agent-${i}`);
    fs.mkdirSync(stateDir, { recursive: true });
    agents.push({
      id: `a${i}`,
      type: "agent",
      client: new ScpAgentClient({
        privateKey: keyFromSeed(`mixed-agent-${i}`),
        stateDir,
        networkAllowlist: [NETWORK],
        assetAllowlist: [ASSET],
        maxFeeDefault: "15000",
        maxAmountDefault: "20000000",
        persistEnabled: !PERF_MODE
      })
    });
  }

  const apiClients = [];
  for (let i = 0; i < API_CLIENTS; i += 1) {
    apiClients.push({
      id: `x${i}`,
      type: "x402-api",
      channelId: `0x${crypto
        .createHash("sha256")
        .update(`mixed-api-${i}`)
        .digest("hex")}`,
      nonce: 0,
      balA: 1_000_000_000n,
      balB: 0n
    });
  }

  async function payWithApiClient(client, payeeNode, round) {
    const first = await reqJson("GET", payeeNode.url);
    if (first.statusCode !== 402) {
      throw new Error(`expected 402, got ${first.statusCode}`);
    }
    const offer = first.body.accepts[0];
    const ext = offer.extensions["statechannel-hub-v1"];
    const paymentId = `pay_${client.id}_${payeeNode.id}_r${round}_${Date.now()}`;
    const contextHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(
        JSON.stringify({
          payee: payeeNode.payeeAddress,
          invoiceId: ext.invoiceId,
          paymentId
        })
      )
    );
    const quoteReq = {
      invoiceId: ext.invoiceId,
      paymentId,
      channelId: client.channelId,
      payee: payeeNode.payeeAddress,
      asset: offer.asset,
      amount: offer.maxAmountRequired,
      maxFee: "20000",
      quoteExpiry: Math.floor(Date.now() / 1000) + 120,
      contextHash
    };
    const quote = await reqJson("POST", `${HUB_URL}/v1/tickets/quote`, quoteReq);
    if (quote.statusCode !== 200) {
      throw new Error(`quote failed ${quote.statusCode}`);
    }

    const totalDebit = BigInt(quote.body.totalDebit);
    client.nonce += 1;
    client.balA -= totalDebit;
    client.balB += totalDebit;
    const state = {
      channelId: client.channelId,
      stateNonce: client.nonce,
      balA: client.balA.toString(),
      balB: client.balB.toString(),
      locksRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
      stateExpiry: Math.floor(Date.now() / 1000) + 120,
      contextHash
    };
    const issue = await reqJson("POST", `${HUB_URL}/v1/tickets/issue`, {
      quote: quote.body,
      channelState: state,
      sigA: "0x1234"
    });
    if (issue.statusCode !== 200) {
      throw new Error(`issue failed ${issue.statusCode}`);
    }

    const ticket = { ...issue.body };
    delete ticket.channelAck;
    const paymentPayload = {
      scheme: "statechannel-hub-v1",
      paymentId,
      invoiceId: ext.invoiceId,
      ticket,
      channelProof: {
        channelId: state.channelId,
        stateNonce: state.stateNonce,
        stateHash: hashChannelState(state),
        sigA: "0x1234"
      }
    };
    const paid = await reqJson("GET", payeeNode.url, null, {
      "PAYMENT-SIGNATURE": JSON.stringify(paymentPayload)
    });
    if (paid.statusCode !== 200) {
      throw new Error(`payee rejected ${paid.statusCode}`);
    }
    return paid.body;
  }

  const clients = [...agents, ...apiClients];
  const results = [];
  const started = nowMs();

  async function runClient(c) {
    for (let r = 0; r < ROUNDS; r += 1) {
      for (const p of payees) {
        const t0 = nowMs();
        try {
          if (c.type === "agent") {
            await c.client.payResource(p.url, {
              paymentId: `pay_${c.id}_${p.id}_r${r}_${Date.now()}`,
              maxAmount: (BigInt(p.price) + 1000n).toString()
            });
          } else {
            await payWithApiClient(c, p, r);
          }
          results.push({
            client: c.id,
            type: c.type,
            payee: p.id,
            round: r,
            ok: true,
            ms: nowMs() - t0
          });
        } catch (err) {
          results.push({
            client: c.id,
            type: c.type,
            payee: p.id,
            round: r,
            ok: false,
            ms: nowMs() - t0,
            error: String(err.message || err)
          });
        }
      }
    }
  }

  await Promise.all(clients.map(runClient));
  const elapsedMs = nowMs() - started;

  await Promise.all(payees.map((p) => new Promise((r) => p.server.close(r))));
  agents.forEach((a) => {
    if (a.client && typeof a.client.close === "function") a.client.close();
  });
  await new Promise((r) => hub.close(r));

  const ok = results.filter((x) => x.ok).length;
  const fail = results.length - ok;
  const byType = ["agent", "x402-api"].reduce((acc, t) => {
    const r = results.filter((x) => x.type === t);
    acc[t] = {
      attempted: r.length,
      ok: r.filter((x) => x.ok).length,
      fail: r.filter((x) => !x.ok).length
    };
    return acc;
  }, {});

  const summary = {
    setup: {
      hub: HUB_URL,
      payees: PAYEE_NODES,
      agents: AGENT_NODES,
      apiClients: API_CLIENTS,
      rounds: ROUNDS,
      perfMode: PERF_MODE
    },
    totals: {
      attempted: results.length,
      ok,
      fail,
      elapsedMs,
      perSecond: Number((results.length / (elapsedMs / 1000 || 1)).toFixed(2))
    },
    byType,
    failures: results.filter((x) => !x.ok).slice(0, 10)
  };

  console.log("mixed sim ok");
  console.log(JSON.stringify(summary, null, 2));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
