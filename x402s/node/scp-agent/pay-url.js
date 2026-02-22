/* eslint-disable no-console */
const readline = require("readline");
const { URL } = require("url");
const { ScpAgentClient } = require("./agent-client");
const { resolveNetwork } = require("../scp-common/networks");

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--asset" && args[i + 1]) {
    flags.asset = args[++i];
  } else if (args[i] === "--network" && args[i + 1]) {
    flags.network = args[++i];
  } else if (args[i] === "--method" && args[i + 1]) {
    flags.method = args[++i];
  } else if (args[i] === "--json" && args[i + 1]) {
    try {
      flags.json = JSON.parse(args[++i]);
    } catch (_e) {
      console.error("Invalid JSON for --json");
      process.exit(1);
    }
  } else {
    positional.push(args[i]);
  }
}

const target = positional[0];
const arg2 = positional[1];

if (!target) {
  console.error(`Usage:
  agent:pay <url> [hub|direct] [--asset <addr>] [--network <chain>] [--method <verb>] [--json <json>]
  agent:pay <channelId> <amount>

Examples:
  agent:pay https://api.example/pay                  # pay via hub (default)
  agent:pay https://api.example/pay direct            # pay directly
  agent:pay https://api.example/pay --asset 0xUSDC    # pay with specific asset
  agent:pay https://api.example/v1/run --method POST --json '{"q":"hello"}'
  agent:pay 0xChannelId... 5000000                    # pay through channel`);
  process.exit(1);
}

const isChannelId = /^0x[a-fA-F0-9]{64}$/.test(target);

// NETWORK=sepolia | base | mainnet  (or NETWORKS=eip155:11155111 for back-compat)
function resolveNetworks() {
  const raw = process.env.NETWORK || process.env.NETWORKS;
  if (!raw) return ["eip155:11155111"];
  return raw.split(",").map(s => {
    s = s.trim();
    if (s.startsWith("eip155:")) return s;
    try { return `eip155:${resolveNetwork(s).chainId}`; }
    catch (_) { return s; }
  });
}

function normalizeApprovalMode(value) {
  const mode = String(value || "auto").trim().toLowerCase();
  if (mode === "auto" || mode === "per_payment" || mode === "per_api") return mode;
  return "auto";
}

function apiApprovalKey(targetUrl) {
  try {
    const u = new URL(targetUrl);
    return `${u.origin}${u.pathname}`;
  } catch (_e) {
    return targetUrl;
  }
}

function askApproval(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("approval mode requires interactive terminal");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} [y/N]: `, (answer) => {
      rl.close();
      const v = String(answer || "").trim().toLowerCase();
      resolve(v === "y" || v === "yes");
    });
  });
}

function ensureApprovalState(agent) {
  if (!agent.state.approvals || typeof agent.state.approvals !== "object") {
    agent.state.approvals = {};
  }
  if (!agent.state.approvals.byApi || typeof agent.state.approvals.byApi !== "object") {
    agent.state.approvals.byApi = {};
  }
  return agent.state.approvals;
}

async function enforceApprovalPolicy(agent, targetUrl, route, mode) {
  if (mode === "auto") return;

  if (mode === "per_payment") {
    const ok = await askApproval(`Approve payment to ${targetUrl} via ${route}?`);
    if (!ok) throw new Error("payment rejected by user approval policy");
    return;
  }

  if (mode === "per_api") {
    const key = apiApprovalKey(targetUrl);
    const approvals = ensureApprovalState(agent);
    if (approvals.byApi[key] && approvals.byApi[key].approved === true) return;
    const ok = await askApproval(`Approve API ${key} for automatic future payments?`);
    if (!ok) throw new Error("API not approved by user");
    approvals.byApi[key] = { approved: true, approvedAt: Math.floor(Date.now() / 1000), route };
    agent.persist();
  }
}

async function main() {
  const opts = {
    networkAllowlist: resolveNetworks(),
    maxFeeDefault: process.env.MAX_FEE || "5000",
    maxAmountDefault: process.env.MAX_AMOUNT || "5000000"
  };
  if (process.env.AGENT_PRIVATE_KEY) opts.privateKey = process.env.AGENT_PRIVATE_KEY;
  if (process.env.ASSET_ALLOWLIST) opts.assetAllowlist = process.env.ASSET_ALLOWLIST.split(",");
  if (process.env.AGENT_STATE_DIR) opts.stateDir = process.env.AGENT_STATE_DIR;
  const agent = new ScpAgentClient(opts);

  try {
    if (isChannelId) {
      if (!arg2) {
        console.error("Usage: agent:pay <channelId> <amount>");
        process.exit(1);
      }
      console.log(`Paying ${arg2} through channel ${target.slice(0, 10)}...`);
      const result = await agent.payChannel(target, arg2);
      console.log(`Paid! ticket=${result.ticket.ticketId} fee=${result.fee}`);
      console.log(JSON.stringify(result, null, 2));
    } else {
      const envRoute = String(process.env.AGENT_DEFAULT_ROUTE || "hub").toLowerCase();
      const route = arg2 || envRoute;
      const approvalMode = normalizeApprovalMode(process.env.AGENT_APPROVAL_MODE || "auto");
      const payOpts = { route };
      if (flags.asset) payOpts.asset = flags.asset;
      if (flags.network) payOpts.network = flags.network;
      if (flags.method) payOpts.method = flags.method;
      if (flags.json !== undefined) payOpts.requestBody = flags.json;
      await enforceApprovalPolicy(agent, target, route, approvalMode);
      console.log(`Paying ${target} via ${route}${flags.asset ? ` (asset: ${flags.asset})` : ""}...`);
      const result = await agent.payResource(target, payOpts);
      console.log(`Paid! route=${result.route} ticket=${(result.ticket || {}).ticketId || "direct"}`);
      console.log(JSON.stringify(result.response, null, 2));
    }
  } finally {
    agent.close();
  }
}

main().catch((err) => {
  console.error("Payment failed:", err.message);
  process.exit(1);
});
