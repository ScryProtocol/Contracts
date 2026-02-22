/* eslint-disable no-console */
const { createPayeeServer } = require("../scp-demo/payee-server");
const { ScpAgentClient } = require("./agent-client");
const { resolveNetwork } = require("../scp-common/networks");

const HUB_HOST = "127.0.0.1";
const HUB_PORT = 4021;
const PAYEE_HOST = "127.0.0.1";
const PAYEE_PORT = 4042;
const args = process.argv.slice(2);

function resolveNetworks() {
  const raw = process.env.NETWORK || process.env.NETWORKS || "base";
  return raw.split(",").map((item) => {
    const trimmed = String(item || "").trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("eip155:")) return trimmed;
    try {
      return `eip155:${resolveNetwork(trimmed).chainId}`;
    } catch (_e) {
      return trimmed;
    }
  }).filter(Boolean);
}

function isTrue(value) {
  const v = String(value || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "y";
}

function hasArg(name) {
  return args.includes(name);
}

function createHubServerLazy() {
  // Hub server validates HUB_PRIVATE_KEY at module load.
  // Load only when we actually run hub mode.
  // eslint-disable-next-line global-require
  return require("../scp-hub/server").createServer();
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(() => resolve()));
}

async function runServeMode(options = {}) {
  const startHub = options.startHub;
  const startPayee = options.startPayee;

  const servers = [];

  if (startHub) {
    const hubHost = process.env.HOST || HUB_HOST;
    const hubPort = Number(process.env.PORT || HUB_PORT);
    const hub = createHubServerLazy();
    await new Promise((r) => hub.listen(hubPort, hubHost, r));
    servers.push({ name: "hub", host: hubHost, port: hubPort, server: hub });
    console.log(`[scp:agent] hub running at http://${hubHost}:${hubPort}`);
  }

  if (startPayee) {
    const payeeHost = process.env.PAYEE_HOST || PAYEE_HOST;
    const payeePort = Number(process.env.PAYEE_PORT || PAYEE_PORT);
    const payee = createPayeeServer();
    await new Promise((r) => payee.listen(payeePort, payeeHost, r));
    servers.push({ name: "payee", host: payeeHost, port: payeePort, server: payee });
    console.log(`[scp:agent] payee running at http://${payeeHost}:${payeePort}`);
    console.log(`[scp:agent] payee offers: http://${payeeHost}:${payeePort}/pay`);
    console.log(`[scp:agent] paid route:   http://${payeeHost}:${payeePort}/v1/data`);
  }

  if (!servers.length) {
    throw new Error("serve mode requested but no local services selected");
  }

  console.log("[scp:agent] waiting (Ctrl+C to stop)...");

  const shutdown = async () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    for (const s of [...servers].reverse()) {
      await closeServer(s.server);
    }
    process.exit(0);
  };
  const onSignal = () => {
    shutdown().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  await new Promise(() => {});
}

async function run() {
  const startPayeeForA2A = hasArg("--start-payee") || hasArg("--a2a") || isTrue(process.env.AGENT_START_PAYEE);
  const startHubForA2A = hasArg("--start-hub") || isTrue(process.env.AGENT_START_HUB);
  const serveMode = startPayeeForA2A || startHubForA2A;
  const runDemoPay = hasArg("--demo-pay");
  if (serveMode) {
    return runServeMode({ startPayee: startPayeeForA2A, startHub: startHubForA2A });
  }

  if (!runDemoPay) {
    const agent = new ScpAgentClient({
      networkAllowlist: resolveNetworks(),
      maxFeeDefault: process.env.MAX_FEE || "500000000",
      maxAmountDefault: process.env.MAX_AMOUNT || "1000000000000"
    });
    try {
      console.log(`[scp:agent] payer agent ready: ${agent.wallet.address}`);
      console.log("[scp:agent] pay URL: npm run scp:agent:pay -- <url> [hub|direct]");
      console.log("[scp:agent] agent API: npm run scp:agent:server");
      console.log("[scp:agent] local /pay helper: AGENT_START_PAYEE=1 npm run scp:agent");
      console.log("[scp:agent] one-shot local demo payment: npm run scp:agent -- --demo-pay");
    } finally {
      agent.close();
    }
    return;
  }

  const hub = createHubServerLazy();
  const payee = createPayeeServer();
  await new Promise((r) => hub.listen(HUB_PORT, HUB_HOST, r));
  await new Promise((r) => payee.listen(PAYEE_PORT, PAYEE_HOST, r));

  try {
    const agent = new ScpAgentClient({
      networkAllowlist: resolveNetworks(),
      maxFeeDefault: process.env.MAX_FEE || "500000000",
      maxAmountDefault: process.env.MAX_AMOUNT || "1000000000000"
    });

    const resourceUrl = `http://${PAYEE_HOST}:${PAYEE_PORT}/v1/data`;
    const route = String(process.env.AGENT_DEFAULT_ROUTE || "hub").toLowerCase();
    const result = await agent.payResource(resourceUrl, { route });
    console.log("agent pay ok");
    console.log(JSON.stringify(result.response, null, 2));
  } finally {
    await new Promise((r) => payee.close(r));
    await new Promise((r) => hub.close(r));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
