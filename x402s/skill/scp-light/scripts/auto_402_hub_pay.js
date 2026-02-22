/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { Writable } = require("stream");
const { ethers } = require("ethers");

const ZERO_ADDRESS = ethers.constants.AddressZero.toLowerCase();
const DEFAULT_RPC_TIMEOUT_MS = 8000;
const RPC_PRESETS = {
  1: ["https://eth.llamarpc.com", "https://ethereum-rpc.publicnode.com"],
  8453: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
  11155111: ["https://ethereum-sepolia-rpc.publicnode.com", "https://rpc.sepolia.org"],
  84532: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"]
};
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

const USAGE = `Usage:
  node skill/scp-light/scripts/auto_402_hub_pay.js <url> [options]

Options:
  --route <hub|direct|auto>          Route preference (default: hub)
  --network <base|sepolia|eip155:*>  Network filter for offer selection
  --rpc-url <url>                    Preferred RPC URL (first candidate)
  --rpc-urls <u1,u2,...>             Comma-separated RPC candidates
  --rpc-timeout-ms <n>               RPC probe/read timeout in ms (default: 8000)
  --asset <0xAssetAddress>           Asset filter for offer selection
  --method <GET|POST|...>            HTTP method for paid request (default: GET)
  --json '<json>'                    Request body JSON (for non-GET/HEAD)
  --topup-payments <n>               Target buffered payments in channel (default: 100)
  --target-balance <raw>             Explicit raw target channel balance override
  --challenge-period-sec <n>         New-channel challenge period in seconds (default: 86400)
  --channel-expiry-sec <n>           New-channel expiry horizon in seconds from now (default: 2592000)
  --max-fee <raw>                    Override max fee cap for payment call
  --max-amount <raw>                 Override max amount cap for payment call
  --x402s-root <path>                Explicit x402s project root
  --dry-run                          Plan only, do not open/fund/pay
  --help                             Show this help

Environment:
  AGENT_PRIVATE_KEY (required for non-interactive use; prompted in TTY when missing)
  NETWORK / NETWORKS
  RPC_URL, RPC_URLS, CONTRACT_ADDRESS
  MAX_AMOUNT, MAX_FEE
  AGENT_STATE_DIR
`;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function getFlag(flags, names) {
  for (const name of names) {
    if (flags[name] !== undefined) return flags[name];
  }
  return undefined;
}

function parseCli(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--dry-run") {
      flags["dry-run"] = true;
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    if (key === "json") {
      try {
        flags[key] = JSON.parse(next);
      } catch (_e) {
        throw new Error("Invalid JSON passed to --json");
      }
    } else {
      flags[key] = next;
    }
    i += 1;
  }

  return { flags, positional };
}

function parseUintStrict(value, label) {
  const text = String(value || "").trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return BigInt(text);
}

function parsePositiveInt(value, label) {
  const text = String(value || "").trim();
  if (!/^[0-9]+$/.test(text)) throw new Error(`${label} must be a positive integer`);
  const num = Number(text);
  if (!Number.isInteger(num) || num <= 0) throw new Error(`${label} must be a positive integer`);
  return num;
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

function safeBigInt(value, label) {
  try {
    return BigInt(String(value || "0"));
  } catch (_e) {
    throw new Error(`${label} is not a valid integer`);
  }
}

function normalizePrivateKey(raw) {
  let key = String(raw || "").trim();
  if (!key) return "";
  if (/^[0-9a-fA-F]{64}$/.test(key)) key = `0x${key}`;
  try {
    return new ethers.Wallet(key).privateKey;
  } catch (_e) {
    return "";
  }
}

function prompt(question, options = {}) {
  const hidden = Boolean(options.hidden);
  return new Promise((resolve) => {
    if (!hidden) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true
      });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }

    const mutableStdout = new Writable({
      write(chunk, encoding, callback) {
        if (!mutableStdout.muted) process.stdout.write(chunk, encoding);
        callback();
      }
    });
    mutableStdout.muted = false;
    const rl = readline.createInterface({
      input: process.stdin,
      output: mutableStdout,
      terminal: true
    });
    process.stdout.write(question);
    mutableStdout.muted = true;
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function ensureAgentPrivateKey() {
  const fromEnv = normalizePrivateKey(process.env.AGENT_PRIVATE_KEY);
  if (fromEnv) {
    process.env.AGENT_PRIVATE_KEY = fromEnv;
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("AGENT_PRIVATE_KEY is required (set env var in non-interactive mode)");
  }

  const entered = normalizePrivateKey(await prompt("Enter AGENT_PRIVATE_KEY (0x...): ", { hidden: true }));
  if (!entered) {
    throw new Error("Invalid AGENT_PRIVATE_KEY");
  }
  process.env.AGENT_PRIVATE_KEY = entered;
}

async function resolveTopupPayments(flags) {
  const explicit = getFlag(flags, ["topup-payments"]);
  const fallback = process.env.AUTO_402_TOPUP_PAYMENTS || "100";
  if (explicit !== undefined) return parsePositiveInt(explicit, "--topup-payments");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return parsePositiveInt(fallback, "--topup-payments");
  }

  const answer = String(
    await prompt(`How many payments should top-up cover? [${fallback}]: `)
  ).trim();
  return parsePositiveInt(answer || fallback, "--topup-payments");
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined || process.env[m[1]] === "") {
      process.env[m[1]] = m[2];
    }
  }
}

function hasX402Markers(dirPath) {
  if (!dirPath) return false;
  const marker = path.join(dirPath, "node/scp-agent/agent-client.js");
  return fs.existsSync(marker);
}

function detectX402Root(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(path.resolve(explicitPath));
  if (process.env.X402S_ROOT) candidates.push(path.resolve(process.env.X402S_ROOT));
  candidates.push(process.cwd());
  candidates.push(path.resolve(__dirname, "../../.."));
  candidates.push(path.resolve(__dirname, "../../../x402s"));

  for (const candidate of candidates) {
    if (hasX402Markers(candidate)) return candidate;
  }

  throw new Error(
    "Unable to locate x402s root. Run from x402s/ or pass --x402s-root <path>."
  );
}

function buildNetworkAllowlist(rawValue, { toCaip2, resolveNetwork }) {
  const raw = String(rawValue || "").trim();
  if (!raw) return ["eip155:11155111"];
  const out = [];
  for (const token of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (token.startsWith("eip155:")) {
      out.push(token.toLowerCase());
      continue;
    }
    const caip = toCaip2(token);
    if (caip) {
      out.push(caip);
      continue;
    }
    try {
      out.push(`eip155:${resolveNetwork(token).chainId}`);
    } catch (_e) {
      out.push(token.toLowerCase());
    }
  }
  return [...new Set(out)];
}

function preferredAliasForChainId(chainId, networksMap) {
  const preferred = {
    1: "mainnet",
    8453: "base",
    11155111: "sepolia",
    84532: "base-sepolia"
  };
  if (preferred[chainId]) return preferred[chainId];

  for (const [alias, net] of Object.entries(networksMap || {})) {
    if (Number(net.chainId) === Number(chainId)) return alias;
  }
  return null;
}

function computeFee(amount, feePolicy) {
  if (!feePolicy) return 0n;
  const base = safeBigInt(feePolicy.base || "0", "feePolicy.base");
  const bps = BigInt(Number(feePolicy.bps || 0));
  const gas = safeBigInt(feePolicy.gasSurcharge || "0", "feePolicy.gasSurcharge");
  return base + (amount * bps / 10000n) + gas;
}

function resolveRoute(input) {
  const route = String(input || "hub").trim().toLowerCase();
  if (!["hub", "direct", "auto"].includes(route)) {
    throw new Error(`Unsupported route "${route}". Use hub, direct, or auto.`);
  }
  return route;
}

function resolveRuntimeChainConfig({
  offerNetwork,
  overrideNetwork,
  preferredRpcUrl,
  preferredRpcUrls,
  normalizeChainId,
  resolveNetwork,
  resolveContract,
  networksMap
}) {
  const candidate = overrideNetwork || offerNetwork || process.env.NETWORK || process.env.NETWORKS;
  const chainId = normalizeChainId(candidate);
  if (!chainId) {
    throw new Error(`Could not resolve chain for network "${candidate || ""}"`);
  }

  const alias = preferredAliasForChainId(chainId, networksMap);
  const defaultRpc = alias ? resolveNetwork(alias).rpc : "";
  const rpcCandidates = uniqueStrings([
    ...splitCsv(preferredRpcUrl),
    ...splitCsv(preferredRpcUrls),
    ...splitCsv(process.env.RPC_URL),
    ...splitCsv(process.env.RPC_URLS),
    ...(RPC_PRESETS[chainId] || []),
    defaultRpc
  ]);
  if (!rpcCandidates.length) throw new Error(`No RPC candidates resolved for chain ${chainId}`);

  const contractAddress = process.env.CONTRACT_ADDRESS || resolveContract(chainId);
  if (!contractAddress || !ethers.utils.isAddress(contractAddress)) {
    throw new Error(`Invalid contract address for chain ${chainId}: ${contractAddress}`);
  }

  return { chainId, alias: alias || `eip155:${chainId}`, rpcCandidates, contractAddress };
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

async function selectResponsiveRpc({ chainId, rpcCandidates, timeoutMs }) {
  const failures = [];

  for (const rpcUrl of rpcCandidates) {
    const provider = new ethers.providers.JsonRpcProvider(
      { url: rpcUrl, timeout: timeoutMs },
      chainId
    );
    try {
      const net = await withTimeout(provider.getNetwork(), timeoutMs, `RPC network check ${rpcUrl}`);
      if (Number(net.chainId) !== Number(chainId)) {
        throw new Error(`expected chain ${chainId}, got ${net.chainId}`);
      }
      await withTimeout(provider.getBlockNumber(), timeoutMs, `RPC block check ${rpcUrl}`);
      return { rpcUrl, provider };
    } catch (err) {
      failures.push(`${rpcUrl} (${shortErr(err)})`);
    }
  }

  throw new Error(
    `No responsive RPC for chain ${chainId}. Tried: ${failures.join("; ")}`
  );
}

async function ensureWalletCanFund({
  signer,
  asset,
  contractAddress,
  requiredAmount,
  dryRun,
  rpcTimeoutMs
}) {
  if (requiredAmount <= 0n) return;
  const assetLower = String(asset || "").toLowerCase();

  if (assetLower === ZERO_ADDRESS) {
    const ethBalance = await withTimeout(
      signer.getBalance(),
      rpcTimeoutMs,
      "native balance check"
    );
    if (ethBalance.toBigInt() < requiredAmount) {
      throw new Error(
        `Insufficient native balance: need ${requiredAmount} have ${ethBalance.toString()}`
      );
    }
    return;
  }

  const token = new ethers.Contract(asset, ERC20_ABI, signer);
  const balance = await withTimeout(
    token.balanceOf(signer.address),
    rpcTimeoutMs,
    "erc20 balance check"
  );
  if (balance.toBigInt() < requiredAmount) {
    throw new Error(
      `Insufficient token balance for ${asset}: need ${requiredAmount} have ${balance.toString()}`
    );
  }

  const allowance = await withTimeout(
    token.allowance(signer.address, contractAddress),
    rpcTimeoutMs,
    "erc20 allowance check"
  );
  if (allowance.toBigInt() >= requiredAmount) return;

  if (dryRun) {
    console.log(`Plan: would approve ERC20 spend for contract ${contractAddress}`);
    return;
  }

  const approveTx = await token.approve(contractAddress, ethers.constants.MaxUint256);
  await approveTx.wait(1);
  console.log(`Approved token spend: tx=${approveTx.hash}`);
}

async function ensureHubChannelReady({
  agent,
  offer,
  runtimeRoute,
  networkOverride,
  topupPayments,
  targetBalanceOverride,
  preferredRpcUrl,
  preferredRpcUrls,
  rpcTimeoutMs,
  challengePeriodSec,
  channelExpirySec,
  dryRun,
  networks
}) {
  const ext = (offer.extensions || {})["statechannel-hub-v1"] || {};
  const hubEndpoint = ext.hubEndpoint;
  if (!hubEndpoint) {
    throw new Error("Offer is missing statechannel-hub-v1.hubEndpoint");
  }

  const channelKey = `hub:${hubEndpoint}`;
  const currentChannel = agent.state.channels[channelKey] || null;
  if (currentChannel && !currentChannel.channelId) {
    throw new Error(`Channel state entry ${channelKey} is missing channelId`);
  }
  const hubInfo = await agent.queryHubInfo(hubEndpoint).catch(() => null);
  const amount = safeBigInt(offer.maxAmountRequired, "offer.maxAmountRequired");
  const fee = computeFee(amount, hubInfo ? hubInfo.feePolicy : null);
  const perPaymentDebit = amount + fee;
  const baseTarget = perPaymentDebit * BigInt(topupPayments);
  let targetBalance = targetBalanceOverride
    ? parseUintStrict(targetBalanceOverride, "--target-balance")
    : baseTarget;
  if (targetBalance < perPaymentDebit) targetBalance = perPaymentDebit;

  const currentBal = currentChannel ? safeBigInt(currentChannel.balA, "channel balA") : 0n;
  const additionalFunding = targetBalance > currentBal ? targetBalance - currentBal : 0n;

  console.log("Hub routing selected:");
  console.log(`  endpoint:        ${hubEndpoint}`);
  console.log(`  channel exists:  ${currentChannel ? "yes" : "no"}`);
  console.log(`  route request:   ${runtimeRoute}`);
  console.log(`  offer network:   ${offer.network}`);
  console.log(`  offer asset:     ${offer.asset}`);
  console.log(`  per-payment est: ${perPaymentDebit.toString()} (amount ${amount} + fee ${fee})`);
  console.log(`  target balance:  ${targetBalance.toString()} (${topupPayments} payments)`);
  console.log(`  current balance: ${currentBal.toString()}`);
  console.log(`  top-up needed:   ${additionalFunding.toString()}`);

  if (additionalFunding === 0n) return;

  const chain = resolveRuntimeChainConfig({
    offerNetwork: offer.network,
    overrideNetwork: networkOverride,
    preferredRpcUrl,
    preferredRpcUrls,
    normalizeChainId: networks.normalizeChainId,
    resolveNetwork: networks.resolveNetwork,
    resolveContract: networks.resolveContract,
    networksMap: networks.NETWORKS
  });

  const rpc = await selectResponsiveRpc({
    chainId: chain.chainId,
    rpcCandidates: chain.rpcCandidates,
    timeoutMs: rpcTimeoutMs
  });
  console.log(`  rpc selected:   ${rpc.rpcUrl}`);

  const signer = agent.wallet.connect(rpc.provider);
  await ensureWalletCanFund({
    signer,
    asset: offer.asset,
    contractAddress: chain.contractAddress,
    requiredAmount: additionalFunding,
    dryRun,
    rpcTimeoutMs
  });

  if (dryRun) {
    console.log(`Plan: would ${currentChannel ? "fund" : "open"} channel on ${chain.alias}`);
    return;
  }

  if (!currentChannel) {
    const hubAddress = (hubInfo && hubInfo.address) || ext.hubAddress;
    if (!hubAddress || !ethers.utils.isAddress(hubAddress)) {
      throw new Error(
        "Hub address unavailable from /.well-known/x402; cannot auto-open channel."
      );
    }

    const opened = await agent.openChannel(hubAddress, {
      rpcUrl: rpc.rpcUrl,
      contractAddress: chain.contractAddress,
      asset: offer.asset,
      amount: additionalFunding.toString(),
      challengePeriodSec,
      channelExpiry: nowSec() + channelExpirySec
    });

    agent.state.channels[channelKey] = {
      channelId: opened.channelId,
      nonce: 0,
      balA: additionalFunding.toString(),
      balB: "0",
      endpoint: hubEndpoint
    };
    agent.persist();
    console.log(`Opened channel ${opened.channelId} on ${chain.alias}`);
    return;
  }

  const funded = await agent.fundChannel(
    currentChannel.channelId,
    additionalFunding.toString(),
    { rpcUrl: rpc.rpcUrl, contractAddress: chain.contractAddress }
  );

  const updated = agent.state.channels[channelKey] || currentChannel;
  updated.balA = (currentBal + additionalFunding).toString();
  if (updated.balB === undefined || updated.balB === null) updated.balB = "0";
  if (!updated.endpoint) updated.endpoint = hubEndpoint;
  agent.state.channels[channelKey] = updated;
  agent.persist();

  console.log(`Funded channel ${currentChannel.channelId}: tx=${funded.txHash}`);
}

function offerPassesUserFilters(offer, { requestedNetwork, requestedAsset }) {
  if (requestedNetwork) {
    if (String(offer.network || "").toLowerCase() !== String(requestedNetwork).toLowerCase()) {
      return false;
    }
  }
  if (requestedAsset) {
    if (String(offer.asset || "").toLowerCase() !== String(requestedAsset).toLowerCase()) {
      return false;
    }
  }
  return true;
}

function computeOfferFundingPlan({ agent, offer, topupPayments, targetBalanceOverride, hubInfo }) {
  const ext = (offer.extensions || {})["statechannel-hub-v1"] || {};
  const hubEndpoint = ext.hubEndpoint;
  if (!hubEndpoint) {
    throw new Error("Offer is missing statechannel-hub-v1.hubEndpoint");
  }

  const channelKey = `hub:${hubEndpoint}`;
  const currentChannel = agent.state.channels[channelKey] || null;
  const amount = safeBigInt(offer.maxAmountRequired, "offer.maxAmountRequired");
  const fee = computeFee(amount, hubInfo ? hubInfo.feePolicy : null);
  const perPaymentDebit = amount + fee;
  const baseTarget = perPaymentDebit * BigInt(topupPayments);
  let targetBalance = targetBalanceOverride
    ? parseUintStrict(targetBalanceOverride, "--target-balance")
    : baseTarget;
  if (targetBalance < perPaymentDebit) targetBalance = perPaymentDebit;
  const currentBal = currentChannel ? safeBigInt(currentChannel.balA, "channel balA") : 0n;
  const additionalFunding = targetBalance > currentBal ? targetBalance - currentBal : 0n;

  return {
    hubEndpoint,
    currentChannel,
    amount,
    fee,
    perPaymentDebit,
    targetBalance,
    currentBal,
    additionalFunding
  };
}

async function checkHubOfferAffordability({
  agent,
  offer,
  networkOverride,
  topupPayments,
  targetBalanceOverride,
  preferredRpcUrl,
  preferredRpcUrls,
  rpcTimeoutMs,
  networks
}) {
  const ext = (offer.extensions || {})["statechannel-hub-v1"] || {};
  const hubEndpoint = ext.hubEndpoint;
  if (!hubEndpoint) {
    return { offer, affordable: false, reason: "missing hubEndpoint" };
  }

  try {
    const hubInfo = await agent.queryHubInfo(hubEndpoint).catch(() => null);
    const plan = computeOfferFundingPlan({
      agent,
      offer,
      topupPayments,
      targetBalanceOverride,
      hubInfo
    });

    if (plan.additionalFunding === 0n) {
      return {
        offer,
        affordable: true,
        reason: "channel already sufficiently funded",
        additionalFunding: "0",
        hubEndpoint
      };
    }

    const chain = resolveRuntimeChainConfig({
      offerNetwork: offer.network,
      overrideNetwork: networkOverride,
      preferredRpcUrl,
      preferredRpcUrls,
      normalizeChainId: networks.normalizeChainId,
      resolveNetwork: networks.resolveNetwork,
      resolveContract: networks.resolveContract,
      networksMap: networks.NETWORKS
    });

    const rpc = await selectResponsiveRpc({
      chainId: chain.chainId,
      rpcCandidates: chain.rpcCandidates,
      timeoutMs: rpcTimeoutMs
    });

    let balance;
    const assetLower = String(offer.asset || "").toLowerCase();
    if (assetLower === ZERO_ADDRESS) {
      balance = (await withTimeout(
        rpc.provider.getBalance(agent.wallet.address),
        rpcTimeoutMs,
        "native balance check"
      )).toBigInt();
    } else {
      const token = new ethers.Contract(offer.asset, ERC20_ABI, rpc.provider);
      balance = (await withTimeout(
        token.balanceOf(agent.wallet.address),
        rpcTimeoutMs,
        "erc20 balance check"
      )).toBigInt();
    }

    return {
      offer,
      affordable: balance >= plan.additionalFunding,
      reason: balance >= plan.additionalFunding
        ? "wallet balance is sufficient"
        : `insufficient wallet balance (need ${plan.additionalFunding}, have ${balance})`,
      additionalFunding: plan.additionalFunding.toString(),
      walletBalance: balance.toString(),
      hubEndpoint
    };
  } catch (err) {
    return {
      offer,
      affordable: false,
      reason: shortErr(err),
      hubEndpoint
    };
  }
}

async function maybeFilterHubOffersByAffordability({
  offers,
  route,
  agent,
  requestedNetwork,
  requestedAsset,
  topupPayments,
  targetBalanceOverride,
  preferredRpcUrl,
  preferredRpcUrls,
  rpcTimeoutMs,
  networks
}) {
  const filteredByUser = offers.filter((offer) =>
    offerPassesUserFilters(offer, { requestedNetwork, requestedAsset })
  );
  const hubOffers = filteredByUser.filter((o) => o.scheme === "statechannel-hub-v1");
  if (!hubOffers.length) return offers;

  const hasAnyHubChannel = hubOffers.some((offer) => {
    const endpoint = ((offer.extensions || {})["statechannel-hub-v1"] || {}).hubEndpoint;
    return endpoint && agent.state.channels[`hub:${endpoint}`];
  });
  if (hasAnyHubChannel) return offers;

  if (hubOffers.length < 2) return offers;

  console.log("No hub channel found. Checking wallet funding across hub offers...");
  const checks = [];
  for (const offer of hubOffers) {
    const checked = await checkHubOfferAffordability({
      agent,
      offer,
      networkOverride: requestedNetwork,
      topupPayments,
      targetBalanceOverride,
      preferredRpcUrl,
      preferredRpcUrls,
      rpcTimeoutMs,
      networks
    });
    checks.push(checked);
  }

  for (const item of checks) {
    const endpoint = item.hubEndpoint || "(unknown hub endpoint)";
    const needed = item.additionalFunding || "?";
    const have = item.walletBalance || "?";
    const status = item.affordable ? "affordable" : "not affordable";
    console.log(`  - ${endpoint}`);
    console.log(`    need: ${needed}  have: ${have}  result: ${status}`);
    if (!item.affordable) console.log(`    reason: ${item.reason}`);
  }

  const affordableHubOffers = checks.filter((x) => x.affordable).map((x) => x.offer);
  if (affordableHubOffers.length > 0) {
    const affordableEndpoints = new Set(
      affordableHubOffers.map((offer) => ((offer.extensions || {})["statechannel-hub-v1"] || {}).hubEndpoint)
    );
    return offers.filter((offer) => {
      if (offer.scheme !== "statechannel-hub-v1") return true;
      const endpoint = ((offer.extensions || {})["statechannel-hub-v1"] || {}).hubEndpoint;
      return endpoint && affordableEndpoints.has(endpoint);
    });
  }

  const directOffers = filteredByUser.filter((o) => o.scheme === "statechannel-direct-v1");
  if (route === "hub" || directOffers.length === 0) {
    throw new Error(
      "No affordable hub offers found for current wallet balance. Lower --topup-payments, use --target-balance, or fund wallet."
    );
  }
  return offers.filter((offer) => offer.scheme !== "statechannel-hub-v1");
}

async function main() {
  let parsed;
  try {
    parsed = parseCli(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.log(USAGE);
    process.exit(1);
  }

  const { flags, positional } = parsed;
  if (flags.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const targetUrl = positional[0];
  if (!targetUrl) {
    console.log(USAGE);
    process.exit(1);
  }
  try {
    // Validate basic URL shape up front.
    // eslint-disable-next-line no-new
    new URL(targetUrl);
  } catch (_e) {
    throw new Error(`Invalid URL: ${targetUrl}`);
  }

  const x402Root = detectX402Root(getFlag(flags, ["x402s-root"]));
  loadDotEnv(path.join(x402Root, ".env"));
  await ensureAgentPrivateKey();

  const { ScpAgentClient } = require(path.join(x402Root, "node/scp-agent/agent-client"));
  const networks = require(path.join(x402Root, "node/scp-common/networks"));

  const requestedNetwork = getFlag(flags, ["network"]);
  const route = resolveRoute(getFlag(flags, ["route"]) || process.env.AGENT_DEFAULT_ROUTE || "hub");
  const allowlistRaw = requestedNetwork || process.env.NETWORKS || process.env.NETWORK || "";
  const networkAllowlist = buildNetworkAllowlist(allowlistRaw, {
    toCaip2: networks.toCaip2,
    resolveNetwork: networks.resolveNetwork
  });

  const topupPayments = await resolveTopupPayments(flags);
  const challengePeriodSec = parsePositiveInt(
    getFlag(flags, ["challenge-period-sec"]) || process.env.AUTO_402_CHALLENGE_PERIOD_SEC || "86400",
    "--challenge-period-sec"
  );
  const channelExpirySec = parsePositiveInt(
    getFlag(flags, ["channel-expiry-sec"]) || process.env.AUTO_402_CHANNEL_EXPIRY_SEC || "2592000",
    "--channel-expiry-sec"
  );
  const dryRun = Boolean(getFlag(flags, ["dry-run"]));
  const rpcTimeoutMs = parsePositiveInt(
    getFlag(flags, ["rpc-timeout-ms"]) || process.env.AUTO_402_RPC_TIMEOUT_MS || String(DEFAULT_RPC_TIMEOUT_MS),
    "--rpc-timeout-ms"
  );

  const agent = new ScpAgentClient({
    privateKey: process.env.AGENT_PRIVATE_KEY,
    networkAllowlist,
    maxFeeDefault: process.env.MAX_FEE || "5000",
    maxAmountDefault: process.env.MAX_AMOUNT || "5000000",
    assetAllowlist: process.env.ASSET_ALLOWLIST
      ? process.env.ASSET_ALLOWLIST.split(",").map((x) => x.trim()).filter(Boolean)
      : undefined,
    stateDir: process.env.AGENT_STATE_DIR || undefined
  });

  try {
    const offers = await agent.discoverOffers(targetUrl);
    if (offers.length === 0) throw new Error("No compatible payment offers from payee");

    const offerPool = await maybeFilterHubOffersByAffordability({
      offers,
      route,
      agent,
      requestedNetwork,
      requestedAsset: getFlag(flags, ["asset"]),
      topupPayments,
      targetBalanceOverride: getFlag(flags, ["target-balance"]),
      preferredRpcUrl: getFlag(flags, ["rpc-url"]),
      preferredRpcUrls: getFlag(flags, ["rpc-urls"]),
      rpcTimeoutMs,
      networks
    });

    const offer = agent.chooseOffer(offerPool, route, {
      network: requestedNetwork,
      asset: getFlag(flags, ["asset"])
    });
    if (!offer) {
      throw new Error(`No offer matches route=${route}${requestedNetwork ? ` network=${requestedNetwork}` : ""}`);
    }

    console.log(`Selected offer scheme: ${offer.scheme}`);
    console.log(`Selected offer network: ${offer.network}`);
    console.log(`Selected offer asset: ${offer.asset}`);

    if (offer.scheme === "statechannel-hub-v1") {
      await ensureHubChannelReady({
        agent,
        offer,
        runtimeRoute: route,
        networkOverride: requestedNetwork,
        topupPayments,
        targetBalanceOverride: getFlag(flags, ["target-balance"]),
        preferredRpcUrl: getFlag(flags, ["rpc-url"]),
        preferredRpcUrls: getFlag(flags, ["rpc-urls"]),
        rpcTimeoutMs,
        challengePeriodSec,
        channelExpirySec,
        dryRun,
        networks
      });
    }

    if (dryRun) {
      console.log("Dry run complete. No channel/payment transaction submitted.");
      return;
    }

    const payOpts = {
      route: offer.scheme === "statechannel-direct-v1" ? "direct" : "hub"
    };
    const method = getFlag(flags, ["method"]);
    if (method) payOpts.method = String(method).toUpperCase();
    const body = getFlag(flags, ["json"]);
    if (body !== undefined) payOpts.requestBody = body;
    const maxFee = getFlag(flags, ["max-fee"]);
    if (maxFee !== undefined) payOpts.maxFee = String(maxFee);
    const maxAmount = getFlag(flags, ["max-amount"]);
    if (maxAmount !== undefined) payOpts.maxAmount = String(maxAmount);
    if (requestedNetwork) payOpts.network = requestedNetwork;
    const asset = getFlag(flags, ["asset"]);
    if (asset) payOpts.asset = asset;

    const result = await agent.payResource(targetUrl, payOpts);
    const ticketId = result.ticket ? result.ticket.ticketId : "direct";
    const receipt = (result.response && result.response.receipt) || {};
    const receiptId = receipt.receiptId || receipt.merchantReceiptId || "(none)";

    console.log("Payment complete:");
    console.log(`  route:      ${result.route}`);
    console.log(`  ticketId:   ${ticketId}`);
    console.log(`  receiptId:  ${receiptId}`);
    console.log(`  paymentId:  ${receipt.paymentId || "(not returned)"}`);
    if (result.quote && result.quote.totalDebit) {
      console.log(`  totalDebit: ${result.quote.totalDebit}`);
    }
    console.log(JSON.stringify(result.response, null, 2));
  } finally {
    agent.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`Auto 402 pay failed: ${err.message}`);
    process.exit(1);
  });
