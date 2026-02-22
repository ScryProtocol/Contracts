/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");

const HUB_HOST = process.env.SIM_HUB_HOST || "127.0.0.1";
const HUB_PORT = Number(process.env.SIM_HUB_PORT || 4321);
const HUB_URL = `http://${HUB_HOST}:${HUB_PORT}`;
const PAYEE_NODES = Number(process.env.SIM_PAYEES || 3);
const AGENT_NODES = Number(process.env.SIM_AGENTS || 4);
const ROUNDS = Number(process.env.SIM_ROUNDS || 2);
const BASE_PAYEE_PORT = Number(process.env.SIM_PAYEE_BASE_PORT || 4340);
const BASE_PRICE = BigInt(process.env.SIM_BASE_PRICE || "1000000");
const ASSET =
  process.env.DEFAULT_ASSET || "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913";
const NETWORK = process.env.NETWORK || "eip155:8453";

const simStateDir = path.resolve(__dirname, "./state");
const hubStorePath = path.join(simStateDir, "hub-store.sim.json");

function keyFromSeed(seed) {
  return `0x${crypto.createHash("sha256").update(seed).digest("hex")}`;
}

function nowMs() {
  return Date.now();
}

async function run() {
  fs.mkdirSync(simStateDir, { recursive: true });
  if (fs.existsSync(hubStorePath)) fs.rmSync(hubStorePath, { force: true });

  process.env.HOST = HUB_HOST;
  process.env.PORT = String(HUB_PORT);
  process.env.STORE_PATH = hubStorePath;
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
    const payeePrivateKey = keyFromSeed(`payee-${i}`);
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
      price
    });
    await new Promise((r) => server.listen(port, HUB_HOST, r));
    payees.push({
      id: `p${i}`,
      port,
      price,
      payeeAddress,
      url: `http://${HUB_HOST}:${port}/v1/data`,
      server
    });
  }

  const agents = [];
  for (let i = 0; i < AGENT_NODES; i += 1) {
    const stateDir = path.join(simStateDir, `agent-${i}`);
    fs.mkdirSync(stateDir, { recursive: true });
    const privateKey = keyFromSeed(`agent-${i}`);
    const agent = new ScpAgentClient({
      privateKey,
      stateDir,
      networkAllowlist: [NETWORK],
      assetAllowlist: [ASSET],
      maxFeeDefault: "15000",
      maxAmountDefault: "10000000"
    });
    agents.push({ id: `a${i}`, client: agent, stateDir });
  }

  const started = nowMs();
  const results = [];

  async function runAgent(agentObj) {
    for (let r = 0; r < ROUNDS; r += 1) {
      for (const p of payees) {
        const t0 = nowMs();
        const paymentId = `pay_${agentObj.id}_${p.id}_r${r}_${nowMs()}`;
        try {
          const out = await agentObj.client.payResource(p.url, {
            paymentId,
            maxAmount: (BigInt(p.price) + 1000n).toString()
          });
          results.push({
            agent: agentObj.id,
            payee: p.id,
            round: r,
            ok: true,
            ms: nowMs() - t0,
            ticketId: out.ticket.ticketId
          });
        } catch (err) {
          results.push({
            agent: agentObj.id,
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

  await Promise.all(agents.map(runAgent));
  const elapsedMs = nowMs() - started;

  await Promise.all(payees.map((p) => new Promise((r) => p.server.close(r))));
  await new Promise((r) => hub.close(r));

  const ok = results.filter((x) => x.ok).length;
  const fail = results.length - ok;
  const p95 = (() => {
    const arr = results.map((x) => x.ms).sort((a, b) => a - b);
    if (!arr.length) return 0;
    return arr[Math.floor(arr.length * 0.95) - 1] || arr[arr.length - 1];
  })();

  const summary = {
    hub: { url: HUB_URL, store: hubStorePath },
    payees: payees.map((p) => ({
      id: p.id,
      url: p.url,
      address: p.payeeAddress,
      price: p.price
    })),
    agents: agents.map((a) => ({ id: a.id, stateDir: a.stateDir })),
    totals: {
      attempted: results.length,
      ok,
      fail,
      elapsedMs,
      perSecond: Number((results.length / (elapsedMs / 1000 || 1)).toFixed(2)),
      p95Ms: p95
    },
    failures: results.filter((x) => !x.ok).slice(0, 10)
  };

  console.log("sim ok");
  console.log(JSON.stringify(summary, null, 2));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
