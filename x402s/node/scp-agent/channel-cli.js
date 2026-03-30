/* eslint-disable no-console */
const { ethers } = require("ethers");
const { ScpAgentClient } = require("./agent-client");
const { HttpJsonClient } = require("../scp-common/http-client");
const {
  resolveNetwork,
  resolveAsset,
  resolveContract,
  resolveHubEndpointForNetwork,
  normalizeChainId,
  ASSETS,
  parseAmount,
  formatAmount
} = require("../scp-common/networks");

const cmd = process.argv[2];
const args = process.argv.slice(3);

const USAGE = `Simple npm aliases:
  npx scp channel <channelId>
  npx scp channel resync <channelId>
  npx scp open <0xAddr> <network> <asset> <amount>
  npx scp fund <channelId> <amount>
  npx scp close <channelId>
  npx scp channels
  npx scp status

Advanced CLI usage:
  channel inspect  <channelId>                              Show local + hub + on-chain state
  channel resync   <channelId>                              Refresh local hub state from hub latest signed state
  channel open     <0xAddr> <network> <asset> <amount>      Open with friendly names
  channel open     <0xAddr> <rpcUrl> <0xToken> <rawAmount>  Open with raw values
  channel fund     <channelId> <asset> <amount>             Deposit with asset name
  channel fund     <channelId> <rawAmount>                  Deposit raw amount
  channel close    <channelId>                              Close channel
  channel list                                              List all channels
  channel balance  [channelId]                              Balances (on-chain + hub + wallet + credit)
  channel status                                            Quick health check (hubs + channels)
  channel receipts [channelId] [--limit N]                  Recent payment receipts from hub
  channel rpc      [network]                                Test RPC connectivity

Examples:
  npx scp channel 0xChannelId
  npx scp open 0xHub base usdc 20
  npx scp open 0xHub sepolia eth 0.1
  npx scp fund 0xChannelId 50
  npx scp channels
  npx scp status

Local fallback:
  npm run scp -- open 0xHub sepolia eth 0.1

Networks: mainnet, base, sepolia, base-sepolia
Assets:   eth, usdc, usdt`;

if (!cmd || cmd === "help") {
  console.log(USAGE);
  process.exit(0);
}

// Resolve NETWORK env → CAIP-2 allowlist
function resolveNetworkAllowlist() {
  const raw = process.env.NETWORK || process.env.NETWORKS;
  if (!raw) return ["eip155:8453"];
  return raw.split(",").map(s => {
    s = s.trim();
    if (s.startsWith("eip155:")) return s;
    try { return `eip155:${resolveNetwork(s).chainId}`; }
    catch (_) { return s; }
  });
}

// Resolve chain from channel state, hub endpoint path, or NETWORK env
function chainIdFromChannel(ch) {
  if (ch.network) {
    const cid = normalizeChainId(ch.network);
    if (cid) return cid;
  }
  // Infer from hub endpoint path (e.g. /hub/sepolia, /hub/base)
  const endpoint = ch.endpoint || ch.key || "";
  const pathMatch = endpoint.match(/\/hub\/([\w-]+)\/?$/);
  if (pathMatch) {
    const cid = normalizeChainId(pathMatch[1]);
    if (cid) return cid;
  }
  return normalizeChainId(process.env.NETWORK) || 8453;
}

// Look up asset symbol from address + chainId
function assetSymbol(address, chainId) {
  const addr = String(address || "").toLowerCase();
  if (!addr || addr === ethers.constants.AddressZero || addr === "0x") return "ETH";
  for (const [key, val] of Object.entries(ASSETS)) {
    if (key.startsWith(`${chainId}:`) && val.address.toLowerCase() === addr) return val.symbol;
  }
  return addr.slice(0, 10) + "...";
}

function assetDecimals(address, chainId) {
  const addr = String(address || "").toLowerCase();
  if (!addr || addr === ethers.constants.AddressZero || addr === "0x") return 18;
  for (const [key, val] of Object.entries(ASSETS)) {
    if (key.startsWith(`${chainId}:`) && val.address.toLowerCase() === addr) return val.decimals;
  }
  return 18;
}

function fmtHuman(raw, decimals) {
  if (!raw || raw === "0") return "0";
  return formatAmount(raw, decimals);
}

function normalizeAssetAddress(address) {
  const addr = String(address || "").toLowerCase();
  if (!addr || addr === "eth" || addr === ethers.constants.AddressZero.toLowerCase()) {
    return ethers.constants.AddressZero.toLowerCase();
  }
  return addr;
}

function pickCreditAmount(body, asset, legacyField) {
  const map = body && typeof body === "object" ? body.payerCreditsByAsset || body.creditsByAsset || {} : {};
  const assetKey = normalizeAssetAddress(asset);
  if (map && typeof map === "object" && map[assetKey] != null) {
    return String(map[assetKey]);
  }
  return String((body && body[legacyField]) || "0");
}

function formatCreditsMap(body, chainId, fieldName) {
  const map = body && typeof body === "object" ? body[fieldName] || {} : {};
  if (!map || typeof map !== "object") return [];
  const out = [];
  for (const [asset, amount] of Object.entries(map)) {
    if (String(amount || "0") === "0") continue;
    const sym = assetSymbol(asset, chainId);
    const dec = assetDecimals(asset, chainId);
    out.push(`${fmtHuman(String(amount), dec)} ${sym}`);
  }
  return out;
}

function networkLabel(chainId) {
  const labels = { 1: "Ethereum", 8453: "Base", 11155111: "Sepolia", 84532: "Base Sepolia" };
  return labels[chainId] || `chain:${chainId}`;
}

function compareNumericStrings(a, b) {
  const left = BigInt(String(a || "0"));
  const right = BigInt(String(b || "0"));
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function summarizeChannelDiff({ localEntry, localHubEntry, watchState, onchain, hubState }) {
  const notes = [];

  if (!onchain.ok) {
    return {
      verdict: "onchain unavailable",
      notes: [onchain.error || "could not read on-chain state"]
    };
  }

  if (onchain.isClosing) {
    const localSignedNonce = watchState && watchState.state ? String(watchState.state.stateNonce || 0) : null;
    const onchainNonce = String(onchain.latestNonce || 0);
    if (localSignedNonce && compareNumericStrings(localSignedNonce, onchainNonce) > 0) {
      return {
        verdict: "challenge needed",
        notes: [
          `on-chain close is active at nonce ${onchainNonce}`,
          `local signed state is newer at nonce ${localSignedNonce}`
        ]
      };
    }
    notes.push(`channel is closing on-chain at nonce ${onchainNonce}`);
  }

  if (watchState && watchState.state) {
    const localSignedNonce = String(watchState.state.stateNonce || 0);
    const onchainNonce = String(onchain.latestNonce || 0);
    const nonceCmp = compareNumericStrings(localSignedNonce, onchainNonce);
    if (nonceCmp > 0) {
      notes.push(`off-chain signed state is ahead of on-chain by ${BigInt(localSignedNonce) - BigInt(onchainNonce)} nonce steps`);
    } else if (nonceCmp < 0) {
      notes.push(`on-chain nonce is ahead of local signed state by ${BigInt(onchainNonce) - BigInt(localSignedNonce)} nonce steps`);
    }
  }

  if (hubState) {
    const localNonce = String(
      localHubEntry && localHubEntry.nonce != null
        ? localHubEntry.nonce
        : localEntry && localEntry.nonce != null
          ? localEntry.nonce
          : 0
    );
    const hubNonce = String(hubState.latestNonce ?? hubState.stateNonce ?? 0);
    const hubCmp = compareNumericStrings(localNonce, hubNonce);
    if (hubCmp < 0) {
      notes.push(`hub is ahead of local cache by ${BigInt(hubNonce) - BigInt(localNonce)} nonce steps`);
    } else if (hubCmp > 0) {
      notes.push(`local cache is ahead of hub by ${BigInt(localNonce) - BigInt(hubNonce)} nonce steps`);
    }

    if (hubState.status && String(hubState.status).toLowerCase() !== "open") {
      notes.push(`hub reports status ${hubState.status}`);
    }
  }

  const totalCmp = compareNumericStrings(
    localEntry && localEntry.totalDeposit ? localEntry.totalDeposit : onchain.totalBalance,
    onchain.totalBalance
  );
  if (totalCmp !== 0) {
    notes.push("local deposit snapshot differs from on-chain total");
  }

  return {
    verdict: notes.length ? "diff detected" : "synced enough",
    notes: notes.length ? notes : ["local, hub, and on-chain views are aligned for normal open-channel operation"]
  };
}

async function fetchOnchainChannelState(agent, ch) {
  const chainId = chainIdFromChannel(ch);
  const contractAddress = ch.contractAddress || process.env.CONTRACT_ADDRESS || resolveContract(chainId);
  const rpcs = [process.env.RPC_URL, ...(RPC_PRESETS[chainId] || [])].filter(Boolean);
  let lastError = null;

  if (!contractAddress) {
    return { ok: false, error: "missing contract address" };
  }

  for (const rpc of rpcs) {
    try {
      const contract = agent.getContract(rpc, contractAddress);
      const legacyContract = agent.getLegacyContract(rpc, contractAddress);
      const params = await agent.getChannelParams(contract, ch.channelId, { legacyContract });
      return {
        ok: true,
        rpc,
        contractAddress,
        participantA: params.participantA,
        participantB: params.participantB,
        asset: params.asset,
        challengePeriodSec: params.challengePeriodSec.toString(),
        channelExpiry: params.channelExpiry.toString(),
        totalBalance: params.totalBalance.toString(),
        isClosing: !!params.isClosing,
        closeDeadline: params.closeDeadline.toString(),
        latestNonce: params.latestNonce.toString(),
        hubFlags: Number(params.hubFlags || 0)
      };
    } catch (err) {
      lastError = err;
    }
  }

  return {
    ok: false,
    contractAddress,
    error: lastError ? lastError.message : "all RPCs failed"
  };
}

async function fetchHubSnapshotsForChannel(httpClient, hubEntries, channelId) {
  const snapshots = [];
  for (const entry of hubEntries) {
    const hubUrl = entry.key.slice(4);
    try {
      const res = await httpClient.request("GET", `${hubUrl}/v1/channels/${encodeURIComponent(channelId)}`);
      if (res.statusCode === 200 && res.body) {
        snapshots.push({ hubUrl, ok: true, body: res.body });
      } else {
        snapshots.push({ hubUrl, ok: false, error: `HTTP ${res.statusCode}` });
      }
    } catch (err) {
      snapshots.push({ hubUrl, ok: false, error: err.message });
    }
  }
  return snapshots;
}

function applyHubResync(agent, entry, body, channelId) {
  const latestState = body && body.latestState ? body.latestState : null;
  const latestNonce = latestState && latestState.stateNonce != null
    ? Number(latestState.stateNonce)
    : body && body.latestNonce != null
      ? Number(body.latestNonce)
      : null;
  if (!latestState || !Number.isFinite(latestNonce)) {
    throw new Error(`hub ${entry.key.slice(4)} did not return a latest signed state`);
  }

  const existing = agent.state.channels[entry.key] || {};
  agent.state.channels[entry.key] = {
    ...existing,
    ...entry,
    nonce: latestNonce,
    balA: String(latestState.balA),
    balB: String(latestState.balB),
    endpoint: entry.key.slice(4),
    participantA: body.participantA || existing.participantA,
    status: body.status || existing.status
  };

  const existingWatch = agent.state.watch && agent.state.watch.byChannelId
    ? agent.state.watch.byChannelId[channelId]
    : null;
  agent.state.watch.byChannelId[channelId] = {
    role: "agent",
    source: "hub-resync",
    updatedAt: Math.floor(Date.now() / 1000),
    state: {
      channelId,
      stateNonce: latestNonce,
      balA: String(latestState.balA),
      balB: String(latestState.balB),
      locksRoot:
        existingWatch && existingWatch.state && existingWatch.state.locksRoot
          ? existingWatch.state.locksRoot
          : ethers.constants.HashZero,
      stateExpiry:
        existingWatch && existingWatch.state && existingWatch.state.stateExpiry
          ? existingWatch.state.stateExpiry
          : 0,
      contextHash:
        existingWatch && existingWatch.state && existingWatch.state.contextHash
          ? existingWatch.state.contextHash
          : ethers.constants.HashZero
    },
    sigA: null,
    sigB: null
  };

  return {
    hubUrl: entry.key.slice(4),
    latestNonce,
    balA: String(latestState.balA),
    balB: String(latestState.balB)
  };
}

async function matchingHubEndpoint(agent, participantB, candidateEndpoint) {
  const endpoint = String(candidateEndpoint || "").trim();
  if (!endpoint) return null;

  const hubInfo = await agent.queryHubInfo(endpoint).catch(() => null);
  const hubAddress = String((hubInfo || {}).address || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(hubAddress)) return null;
  return hubAddress === String(participantB || "").trim().toLowerCase() ? endpoint : null;
}

const RPC_PRESETS = {
  1: ["https://eth.llamarpc.com", "https://ethereum-rpc.publicnode.com"],
  8453: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
  11155111: ["https://ethereum-sepolia-rpc.publicnode.com", "https://1rpc.io/sepolia"],
  84532: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"]
};

async function main() {
  const opts = {
    networkAllowlist: resolveNetworkAllowlist(),
    maxFeeDefault: process.env.MAX_FEE || "5000",
    maxAmountDefault: process.env.MAX_AMOUNT || "5000000"
  };
  if (process.env.AGENT_PRIVATE_KEY) opts.privateKey = process.env.AGENT_PRIVATE_KEY;
  if (process.env.AGENT_STATE_DIR) opts.stateDir = process.env.AGENT_STATE_DIR;
  const agent = new ScpAgentClient(opts);

  try {
    if (cmd === "open") {
      const participantB = args[0];
      if (!participantB || !/^0x[a-fA-F0-9]{40}$/.test(participantB)) {
        console.error("Address required: channel open <0xAddress> <network> <asset> <amount>");
        process.exit(1);
      }

      const arg1 = args[1];
      const arg2 = args[2];
      const arg3 = args[3];

      if (!arg1 || !arg2 || !arg3) {
        console.error("Usage: channel open <0xAddr> <network> <asset> <amount>");
        console.error("   or: channel open <0xAddr> <rpcUrl> <0xToken> <rawAmount>");
        process.exit(1);
      }

      // Detect raw mode: arg1 starts with http or arg2 starts with 0x
      const isRaw = arg1.startsWith("http") || /^0x[a-fA-F0-9]{40}$/.test(arg2);

      let rpcUrl, rawAmount;
      if (isRaw) {
        rpcUrl = arg1;
        const assetAddr = arg2;
        rawAmount = arg3;
        const contract = process.env.CONTRACT_ADDRESS;
        const hubEndpoint = await matchingHubEndpoint(agent, participantB, process.env.HUB_URL);
        if (!contract) {
          console.error("CONTRACT_ADDRESS env var required for raw mode.");
          process.exit(1);
        }
        console.log(`Opening channel (raw)...`);
        console.log(`  partner:  ${participantB}`);
        console.log(`  asset:    ${assetAddr}`);
        console.log(`  deposit:  ${rawAmount}`);
        console.log(`  rpc:      ${rpcUrl}`);
        console.log(`  contract: ${contract}`);
        console.log();
        const result = await agent.openChannel(participantB, {
          rpcUrl,
          contractAddress: contract,
          asset: assetAddr,
          amount: rawAmount,
          ...(hubEndpoint ? { hubEndpoint } : {})
        });
      console.log("Channel opened!");
      console.log(`  channelId: ${result.channelId}`);
      console.log(`  deposit:   ${rawAmount}`);
      if (result.approval && result.approval.txHash) {
        console.log(`  approval:  ${result.approval.txHash}`);
      }
      console.log(`  txHash:    ${result.txHash}`);
      return;
      }

      // Friendly mode: network asset amount
      const network = resolveNetwork(arg1);
      const asset = resolveAsset(network.chainId, arg2);
      const contract = resolveContract(network.chainId);
      rpcUrl = process.env.RPC_URL || network.rpc;
      rawAmount = parseAmount(arg3, asset.decimals);
      const candidateHubEndpoint = process.env.HUB_URL || resolveHubEndpointForNetwork(network.chainId);
      const hubEndpoint = await matchingHubEndpoint(agent, participantB, candidateHubEndpoint);

      if (!contract) {
        console.error(`No contract address for ${network.name}. Set CONTRACT_ADDRESS env var.`);
        process.exit(1);
      }

      console.log(`Opening channel on ${network.name}...`);
      console.log(`  partner:  ${participantB}`);
      console.log(`  asset:    ${asset.symbol} (${asset.address})`);
      console.log(`  deposit:  ${arg3} ${asset.symbol} (${rawAmount} raw)`);
      console.log(`  rpc:      ${rpcUrl}`);
      console.log(`  contract: ${contract}`);
      console.log();

      const result = await agent.openChannel(participantB, {
        rpcUrl,
        contractAddress: contract,
        asset: asset.address,
        amount: rawAmount,
        network: network.chainId,
        ...(hubEndpoint ? { hubEndpoint } : {})
      });
      console.log("Channel opened!");
      console.log(`  channelId: ${result.channelId}`);
      console.log(`  deposit:   ${arg3} ${asset.symbol}`);
      if (result.approval && result.approval.txHash) {
        console.log(`  approval:  ${result.approval.txHash}`);
      }
      console.log(`  txHash:    ${result.txHash}`);

    } else if (cmd === "fund") {
      const channelId = args[0];
      const arg1 = args[1];
      const arg2 = args[2];
      if (!channelId || !arg1) {
        console.error("Usage: channel fund <channelId> <asset> <amount>");
        console.error("   or: channel fund <channelId> <rawAmount>");
        process.exit(1);
      }

      // Find channel to determine the right chain for asset resolution
      const ch = Object.values(agent.state.channels).find(c => c.channelId === channelId);
      const fundChainId = ch ? chainIdFromChannel(ch) : (normalizeChainId(process.env.NETWORK) || 8453);

      let amount, label;
      if (arg2) {
        // fund <channelId> <asset> <amount> — friendly
        const asset = resolveAsset(fundChainId, arg1);
        amount = parseAmount(arg2, asset.decimals);
        label = `${arg2} ${asset.symbol} (${amount} raw)`;
      } else if (/^\d+$/.test(arg1)) {
        // fund <channelId> <rawAmount> — raw
        amount = arg1;
        label = amount;
      } else {
        console.error("Usage: channel fund <channelId> <asset> <amount>");
        console.error("   or: channel fund <channelId> <rawAmount>");
        process.exit(1);
      }

      console.log(`Funding ${channelId.slice(0, 18)}... with ${label}...`);
      const result = await agent.fundChannel(channelId, amount);
      console.log("Funded!");
      if (result.approval && result.approval.txHash) {
        console.log(`Approval tx: ${result.approval.txHash}`);
      }
      console.log(JSON.stringify(result, null, 2));

    } else if (cmd === "close") {
      const channelId = args[0];
      if (!channelId) {
        console.error("Usage: channel close <channelId>");
        process.exit(1);
      }
      console.log(`Closing ${channelId.slice(0, 18)}...`);
      const result = await agent.closeChannel(channelId);
      console.log(`Closed via ${result.method}!`);
      console.log(JSON.stringify(result, null, 2));

    } else if (cmd === "inspect") {
      const channelId = args[0];
      if (!channelId) {
        console.error("Usage: channel inspect <channelId>");
        process.exit(1);
      }

      const entries = Object.entries(agent.state.channels)
        .filter(([, ch]) => ch && ch.channelId === channelId)
        .map(([key, ch]) => ({ key, ...ch }));

      if (entries.length === 0) {
        console.log(`Channel not found in local state: ${channelId}`);
        process.exit(1);
      }

      const primary = entries.find((entry) => entry.key.startsWith("onchain:")) || entries[0];
      const chainId = chainIdFromChannel(primary);
      const net = networkLabel(chainId);
      const sym = assetSymbol(primary.asset, chainId);
      const dec = assetDecimals(primary.asset, chainId);
      const httpClient = new HttpJsonClient({ timeoutMs: 5000 });
      const watchState = agent.state.watch && agent.state.watch.byChannelId
        ? agent.state.watch.byChannelId[channelId]
        : null;
      const onchain = await fetchOnchainChannelState(agent, primary);
      const hubEntries = entries.filter((entry) => entry.key.startsWith("hub:"));
      const hubSnapshots = await fetchHubSnapshotsForChannel(httpClient, hubEntries, channelId);
      const primaryHubSnapshot = hubSnapshots.find((snapshot) => snapshot.ok) || null;
      const verdict = summarizeChannelDiff({
        localEntry: primary,
        localHubEntry: hubEntries[0] || null,
        watchState,
        onchain,
        hubState: primaryHubSnapshot
          ? {
              latestNonce: primaryHubSnapshot.body.latestNonce,
              stateNonce: primaryHubSnapshot.body.latestState && primaryHubSnapshot.body.latestState.stateNonce,
              status: primaryHubSnapshot.body.status
            }
          : null
      });

      console.log(`\nChannel Inspect\n`);
      console.log(`  channelId: ${channelId}`);
      console.log(`  network:   ${net}`);
      console.log(`  asset:     ${sym}`);
      if (primary.participantB) console.log(`  partner:   ${primary.participantB}`);
      console.log(`  verdict:   ${verdict.verdict}`);
      for (const note of verdict.notes) {
        console.log(`  note:      ${note}`);
      }
      console.log();

      console.log(`  Local entries (${entries.length}):`);
      for (const entry of entries) {
        console.log(`    ${entry.key}`);
        console.log(`      balA:    ${fmtHuman(entry.balA, dec)} ${sym} (${entry.balA} raw)`);
        console.log(`      balB:    ${fmtHuman(entry.balB, dec)} ${sym} (${entry.balB} raw)`);
        console.log(`      nonce:   ${entry.nonce || 0}`);
        if (entry.status) console.log(`      status:  ${entry.status}`);
        if (entry.endpoint) console.log(`      endpoint:${entry.endpoint}`);
        if (entry.txHash) console.log(`      txHash:  ${entry.txHash}`);
      }
      console.log();

      if (watchState && watchState.state) {
        console.log(`  Local signed state:`);
        console.log(`    stateNonce: ${watchState.state.stateNonce}`);
        console.log(`    balA:       ${fmtHuman(watchState.state.balA, dec)} ${sym}`);
        console.log(`    balB:       ${fmtHuman(watchState.state.balB, dec)} ${sym}`);
        console.log(`    stateExpiry:${watchState.state.stateExpiry}`);
        console.log(`    sigA:       ${watchState.sigA ? "present" : "missing"}`);
        console.log(`    sigB:       ${watchState.sigB ? "present" : "missing"}`);
        console.log();
      }

      console.log(`  On-chain:`);
      if (onchain.ok) {
        console.log(`    contract:   ${onchain.contractAddress}`);
        console.log(`    rpc:        ${onchain.rpc}`);
        console.log(`    participantA:${onchain.participantA}`);
        console.log(`    participantB:${onchain.participantB}`);
        console.log(`    total:      ${fmtHuman(onchain.totalBalance, dec)} ${sym} (${onchain.totalBalance} raw)`);
        console.log(`    latestNonce:${onchain.latestNonce}`);
        console.log(`    isClosing:  ${onchain.isClosing}`);
        console.log(`    closeDeadline:${onchain.closeDeadline}`);
        console.log(`    challenge:  ${onchain.challengePeriodSec}s`);
        console.log(`    expiry:     ${onchain.channelExpiry}`);
      } else {
        console.log(`    unavailable: ${onchain.error}`);
      }
      console.log();

      if (hubEntries.length === 0) {
        console.log(`  Hub: no hub-tracked local entry`);
      } else {
        console.log(`  Hub views (${hubEntries.length}):`);
        for (const entry of hubEntries) {
          const hubUrl = entry.key.slice(4);
          const snapshot = hubSnapshots.find((item) => item.hubUrl === hubUrl) || null;
          console.log(`    ${hubUrl}`);
          console.log(`      localNonce: ${entry.nonce || 0}`);
          console.log(`      localBalA:  ${fmtHuman(entry.balA, dec)} ${sym}`);
          console.log(`      localBalB:  ${fmtHuman(entry.balB, dec)} ${sym}`);
          if (snapshot && snapshot.ok) {
            const body = snapshot.body;
            const latestState = body.latestState || {};
            console.log(`      hubStatus:  ${body.status || "unknown"}`);
            console.log(`      hubNonce:   ${body.latestNonce ?? latestState.stateNonce ?? "-"}`);
            if (body.onChainTotalBalance != null) {
              console.log(`      hubOnChain: ${fmtHuman(String(body.onChainTotalBalance), dec)} ${sym}`);
            }
            if (latestState.balA != null) {
              console.log(`      hubBalA:    ${fmtHuman(String(latestState.balA), dec)} ${sym}`);
            }
            if (latestState.balB != null) {
              console.log(`      hubBalB:    ${fmtHuman(String(latestState.balB), dec)} ${sym}`);
            }
            const payerCredits = formatCreditsMap(body, chainId, "payerCreditsByAsset");
            if (payerCredits.length) {
              console.log(`      payerCredits:${payerCredits.join(", ")}`);
            } else if (body.payerCredit != null && body.payerCredit !== "0") {
              console.log(`      payerCredit:${fmtHuman(String(body.payerCredit), dec)} ${sym} (legacy)`);
            }
            console.log(`      signed:     ${body.hasSignedState ? "yes" : "no"}`);
          } else {
            console.log(`      unavailable: ${snapshot ? snapshot.error : "unknown error"}`);
          }
        }
      }

      httpClient.close();

    } else if (cmd === "resync") {
      const channelId = args[0];
      if (!channelId) {
        console.error("Usage: channel resync <channelId>");
        process.exit(1);
      }

      const entries = Object.entries(agent.state.channels)
        .filter(([, ch]) => ch && ch.channelId === channelId)
        .map(([key, ch]) => ({ key, ...ch }));

      if (entries.length === 0) {
        console.error(`Channel not found in local state: ${channelId}`);
        process.exit(1);
      }

      const primary = entries.find((entry) => entry.key.startsWith("onchain:")) || entries[0];
      let hubEntries = entries.filter((entry) => entry.key.startsWith("hub:"));

      if (hubEntries.length === 0 && primary.participantB) {
        const candidateHubEndpoint =
          process.env.HUB_URL || resolveHubEndpointForNetwork(chainIdFromChannel(primary));
        if (candidateHubEndpoint) {
          const matchedEndpoint = await matchingHubEndpoint(
            agent,
            primary.participantB,
            candidateHubEndpoint
          );
          if (matchedEndpoint) {
            const aliased = agent.aliasHubChannel(matchedEndpoint, primary);
            if (aliased) {
              hubEntries = [{ key: `hub:${matchedEndpoint}`, ...aliased }];
            }
          }
        }
      }

      if (hubEntries.length === 0) {
        console.error("No hub-tracked local entry found for this channel.");
        process.exit(1);
      }

      const httpClient = new HttpJsonClient({ timeoutMs: 5000 });
      const hubSnapshots = await fetchHubSnapshotsForChannel(httpClient, hubEntries, channelId);
      httpClient.close();

      const successful = hubEntries
        .map((entry) => ({
          entry,
          snapshot: hubSnapshots.find((item) => item.hubUrl === entry.key.slice(4))
        }))
        .filter((item) => item.snapshot && item.snapshot.ok);

      if (successful.length === 0) {
        console.error("Could not fetch latest channel state from any tracked hub endpoint.");
        for (const snapshot of hubSnapshots) {
          console.error(`  ${snapshot.hubUrl}: ${snapshot.error || "unknown error"}`);
        }
        process.exit(1);
      }

      const applied = [];
      for (const { entry, snapshot } of successful) {
        applied.push(applyHubResync(agent, entry, snapshot.body, channelId));
      }
      agent.persist();

      console.log("Channel resynced from hub.");
      console.log(`  channelId: ${channelId}`);
      for (const item of applied) {
        console.log(`  hub:       ${item.hubUrl}`);
        console.log(`  nonce:     ${item.latestNonce}`);
        console.log(`  balA:      ${item.balA}`);
        console.log(`  balB:      ${item.balB}`);
      }
      console.log("  watch:     refreshed from hub snapshot; signatures cleared until next successful payment");

    } else if (cmd === "list") {
      const channels = agent.listChannels();
      if (channels.length === 0) {
        console.log("No channels.");
      } else {
        console.log(`\nChannels: ${channels.length}\n`);
        for (const ch of channels) {
          const hubMatch = ch.key.match(/^hub:(.+)$/);
          const chainId = chainIdFromChannel(ch);
          const sym = assetSymbol(ch.asset, chainId);
          const dec = assetDecimals(ch.asset, chainId);
          const net = networkLabel(chainId);
          console.log(`  ┌─ ${ch.key}`);
          console.log(`  │  channelId: ${ch.channelId}`);
          if (hubMatch) console.log(`  │  hub:       ${hubMatch[1]}`);
          console.log(`  │  network:   ${net}`);
          console.log(`  │  asset:     ${sym}`);
          console.log(`  │  balA:      ${fmtHuman(ch.balA, dec)} ${sym} (${ch.balA} raw)`);
          console.log(`  │  balB:      ${fmtHuman(ch.balB, dec)} ${sym} (${ch.balB} raw)`);
          console.log(`  │  nonce:     ${ch.nonce || 0}`);
          if (ch.participantB) console.log(`  │  partner:   ${ch.participantB}`);
          if (ch.status) console.log(`  │  status:    ${ch.status}`);
          if (ch.txHash) console.log(`  │  txHash:    ${ch.txHash}`);
          console.log(`  └──`);
          console.log();
        }
      }

    } else if (cmd === "balance") {
      const targetChannelId = args[0] || null;
      const channels = agent.listChannels();
      const httpClient = new HttpJsonClient({ timeoutMs: 5000 });

      if (channels.length === 0) {
        console.log("No channels. Open one first:");
        console.log("  npx scp open <0xHubAddr> <network> <asset> <amount>");
        process.exit(0);
      }

      // Wallet balance
      console.log(`\nAgent: ${agent.wallet.address}\n`);

      // Check wallet balance on each chain that has a channel
      const chainsSeen = new Set();
      for (const ch of channels) {
        const chainId = chainIdFromChannel(ch);
        if (chainsSeen.has(chainId)) continue;
        chainsSeen.add(chainId);
        const net = networkLabel(chainId);
        const rpcs = [
          process.env.RPC_URL,
          ...(RPC_PRESETS[chainId] || [])
        ].filter(Boolean);

        let walletBal = null;
        let rpcUsed = null;
        for (const rpc of rpcs) {
          try {
            const provider = new ethers.providers.JsonRpcProvider({ url: rpc, timeout: 5000 }, chainId);
            walletBal = await provider.getBalance(agent.wallet.address);
            rpcUsed = rpc;
            break;
          } catch (_e) { /* try next */ }
        }
        if (walletBal !== null) {
          console.log(`  Wallet (${net}): ${ethers.utils.formatEther(walletBal)} ETH  [rpc: ${rpcUsed}]`);
        } else {
          console.log(`  Wallet (${net}): unreachable (tried ${rpcs.length} RPCs)`);
        }
      }
      console.log();

      // Per-channel balances
      for (const ch of channels) {
        if (targetChannelId && ch.channelId !== targetChannelId) continue;
        const chainId = chainIdFromChannel(ch);
        const sym = assetSymbol(ch.asset, chainId);
        const dec = assetDecimals(ch.asset, chainId);
        const net = networkLabel(chainId);
        const hubMatch = ch.key.match(/^hub:(.+)$/);

        console.log(`  ┌─ ${ch.key}`);
        console.log(`  │  channelId: ${ch.channelId}`);
        console.log(`  │  network:   ${net}  asset: ${sym}`);
        console.log(`  │`);

        // Local state balance
        console.log(`  │  Local state:`);
        console.log(`  │    balA (yours):  ${fmtHuman(ch.balA, dec)} ${sym}`);
        console.log(`  │    balB (hub):    ${fmtHuman(ch.balB, dec)} ${sym}`);
        console.log(`  │    nonce:         ${ch.nonce || 0}`);

        // On-chain balance
        if (ch.channelId && ch.contractAddress) {
          const rpcs = [process.env.RPC_URL, ...(RPC_PRESETS[chainId] || [])].filter(Boolean);
          let onchainData = null;
          for (const rpc of rpcs) {
            try {
              const provider = new ethers.providers.JsonRpcProvider({ url: rpc, timeout: 5000 }, chainId);
              const contract = new ethers.Contract(ch.contractAddress, [
                "function balance(bytes32 channelId) external view returns (tuple(uint256 totalBalance, uint256 balA, uint256 balB, uint64 latestNonce, bool isClosing))",
                "function getChannel(bytes32 channelId) external view returns (tuple(address participantA, address participantB, address asset, uint64 challengePeriodSec, uint64 channelExpiry, uint256 totalBalance, bool isClosing, uint64 closeDeadline, uint64 latestNonce, uint8 hubFlags))"
              ], provider);
              onchainData = await contract.balance(ch.channelId);
              break;
            } catch (_e) { /* try next */ }
          }
          if (onchainData) {
            console.log(`  │`);
            console.log(`  │  On-chain:`);
            console.log(`  │    totalBalance:  ${fmtHuman(onchainData.totalBalance.toString(), dec)} ${sym}`);
            console.log(`  │    balA:          ${fmtHuman(onchainData.balA.toString(), dec)} ${sym}`);
            console.log(`  │    balB:          ${fmtHuman(onchainData.balB.toString(), dec)} ${sym}`);
            console.log(`  │    latestNonce:   ${onchainData.latestNonce.toString()}`);
            console.log(`  │    isClosing:     ${onchainData.isClosing}`);
          } else {
            console.log(`  │`);
            console.log(`  │  On-chain: unreachable`);
          }
        }

        // Hub summary
        if (hubMatch) {
          const hubUrl = hubMatch[1];
          try {
            const hubInfoRes = await httpClient.request("GET", `${hubUrl}/.well-known/x402`);
            const hubInfo = hubInfoRes.statusCode === 200 ? hubInfoRes.body : null;
            const summaryRes = await httpClient.request("GET", `${hubUrl}/v1/agent/summary?channelId=${encodeURIComponent(ch.channelId)}`);
            const summary = summaryRes.statusCode === 200 ? summaryRes.body : null;

            console.log(`  │`);
            console.log(`  │  Hub (${hubUrl}):`);
            if (hubInfo) {
              console.log(`  │    address:       ${hubInfo.address}`);
              console.log(`  │    fee:           base=${hubInfo.feePolicy.base} + ${hubInfo.feePolicy.bps}bps`);
              console.log(`  │    assets:        ${(hubInfo.supportedAssets || []).join(", ")}`);
            }
            if (summary) {
              console.log(`  │    totalSpent:    ${fmtHuman(summary.totalSpent, dec)} ${sym}`);
              console.log(`  │    totalFees:     ${fmtHuman(summary.totalFees, dec)} ${sym}`);
              console.log(`  │    payments:      ${summary.payments}`);
            } else {
              console.log(`  │    summary:       unavailable`);
            }

            // Credit balance
            const creditRes = await httpClient.request("GET", `${hubUrl}/v1/credit/balance?address=${encodeURIComponent(agent.wallet.address)}`).catch(() => null);
            if (creditRes && creditRes.statusCode === 200 && creditRes.body) {
              const credit = creditRes.body;
              const creditLines = formatCreditsMap(credit, chainId, "creditsByAsset");
              const creditBal = pickCreditAmount(credit, ch.asset, "credit");
              if (creditLines.length) {
                console.log(`  │    credit:        ${creditLines.join(", ")}`);
              } else if (creditBal !== "0") {
                console.log(`  │    credit:        ${fmtHuman(creditBal, dec)} ${sym} (legacy)`);
              }
            }
          } catch (_e) {
            console.log(`  │`);
            console.log(`  │  Hub: unreachable (${hubUrl})`);
          }
        }

        console.log(`  └──`);
        console.log();
      }
      httpClient.close();

    } else if (cmd === "status") {
      const channels = agent.listChannels();
      const httpClient = new HttpJsonClient({ timeoutMs: 4000 });

      console.log(`\nSCP Status\n`);
      console.log(`  Agent: ${agent.wallet.address}`);
      console.log(`  Channels: ${channels.length}\n`);

      if (channels.length === 0) {
        console.log("  No channels. Run: npx scp open <0xHubAddr> <network> <asset> <amount>");
        httpClient.close();
        process.exit(0);
      }

      // Group channels by hub
      const byHub = {};
      for (const ch of channels) {
        const hubMatch = ch.key.match(/^hub:(.+)$/);
        const hubUrl = hubMatch ? hubMatch[1] : "local";
        if (!byHub[hubUrl]) byHub[hubUrl] = [];
        byHub[hubUrl].push(ch);
      }

      for (const [hubUrl, hubChannels] of Object.entries(byHub)) {
        let hubOk = false;
        let hubInfo = null;
        if (hubUrl !== "local") {
          try {
            const res = await httpClient.request("GET", `${hubUrl}/.well-known/x402`);
            hubOk = res.statusCode === 200;
            hubInfo = hubOk ? res.body : null;
          } catch (_e) { /* unreachable */ }
        }

        console.log(`  ${hubOk ? "OK" : "DOWN"}  ${hubUrl}`);
        if (hubInfo) {
          console.log(`       address: ${hubInfo.address}  fee: ${hubInfo.feePolicy.base}+${hubInfo.feePolicy.bps}bps`);
        }

        for (const ch of hubChannels) {
          const chainId = chainIdFromChannel(ch);
          const sym = assetSymbol(ch.asset, chainId);
          const dec = assetDecimals(ch.asset, chainId);
          const net = networkLabel(chainId);
          const balA = fmtHuman(ch.balA, dec);
          console.log(`       ${net} ${sym}  balA=${balA}  nonce=${ch.nonce || 0}  ${(ch.channelId || "").slice(0, 18)}...`);

          // Quick hub channel check
          if (hubUrl !== "local" && hubOk && ch.channelId) {
            try {
              const chRes = await httpClient.request("GET", `${hubUrl}/v1/channels/${encodeURIComponent(ch.channelId)}`);
              if (chRes.statusCode === 200 && chRes.body) {
                const hc = chRes.body;
                const hubNonce = hc.nonce || hc.latestNonce || 0;
                const localNonce = ch.nonce || 0;
                const nonceDiff = Number(hubNonce) - Number(localNonce);
                const syncLabel = nonceDiff === 0 ? "synced" : nonceDiff > 0 ? `hub ahead +${nonceDiff}` : `local ahead ${nonceDiff}`;
                const payerCredits = formatCreditsMap(hc, chainId, "payerCreditsByAsset");
                const legacyCredit = String(hc.payerCredit || "0");
                const creditLabel = payerCredits.length ? payerCredits.join(", ") : legacyCredit !== "0" ? `${legacyCredit} legacy` : "0";
                console.log(`       hub: nonce=${hubNonce} ${syncLabel}  credit=${creditLabel}`);
              }
            } catch (_e) { /* skip */ }
          }
        }
        console.log();
      }

      // Credit balances
      const hubUrls = Object.keys(byHub).filter(h => h !== "local");
      if (hubUrls.length > 0) {
        let hasCredit = false;
        for (const hubUrl of hubUrls) {
          try {
            const res = await httpClient.request("GET", `${hubUrl}/v1/credit/balance?address=${encodeURIComponent(agent.wallet.address)}`);
            if (res.statusCode === 200 && res.body) {
              const creditLines = formatCreditsMap(res.body, normalizeChainId(process.env.NETWORK) || 8453, "creditsByAsset");
              const bal = res.body.balance || res.body.credit || "0";
              if (creditLines.length) {
                if (!hasCredit) { console.log("  Credit:"); hasCredit = true; }
                console.log(`    ${hubUrl}: ${creditLines.join(", ")}`);
              } else if (bal !== "0") {
                if (!hasCredit) { console.log("  Credit:"); hasCredit = true; }
                console.log(`    ${hubUrl}: ${bal} (legacy)`);
              }
            }
          } catch (_e) { /* skip */ }
        }
        if (hasCredit) console.log();
      }

      httpClient.close();

    } else if (cmd === "receipts") {
      // Parse args: receipts [channelId] [--limit N]
      let targetChannelId = null;
      let limit = 10;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--limit" && args[i + 1]) {
          limit = parseInt(args[++i], 10) || 10;
        } else if (args[i].startsWith("0x")) {
          targetChannelId = args[i];
        }
      }

      const channels = agent.listChannels();
      const httpClient = new HttpJsonClient({ timeoutMs: 5000 });

      if (channels.length === 0) {
        console.log("No channels.");
        httpClient.close();
        process.exit(0);
      }

      console.log(`\nRecent Receipts (limit=${limit})\n`);

      for (const ch of channels) {
        if (targetChannelId && ch.channelId !== targetChannelId) continue;
        const hubMatch = ch.key.match(/^hub:(.+)$/);
        if (!hubMatch) continue;

        const hubUrl = hubMatch[1];
        const chainId = chainIdFromChannel(ch);
        const sym = assetSymbol(ch.asset, chainId);
        const dec = assetDecimals(ch.asset, chainId);

        try {
          const res = await httpClient.request("GET", `${hubUrl}/v1/agent/receipts?channelId=${encodeURIComponent(ch.channelId)}&limit=${limit}`);
          if (res.statusCode !== 200 || !res.body) {
            console.log(`  ${ch.key}: unavailable (${res.statusCode})`);
            continue;
          }
          const data = res.body;
          const items = data.items || [];
          if (items.length === 0) {
            console.log(`  ${ch.key}: no receipts`);
            continue;
          }

          console.log(`  ${ch.key} (${items.length} receipts):`);
          for (const r of items) {
            const ts = r.issuedAt ? new Date(r.issuedAt * 1000).toISOString().replace("T", " ").slice(0, 19) : "-";
            const amt = fmtHuman(r.amount || r.netAmount, dec);
            const fee = r.fee ? ` fee=${fmtHuman(r.fee, dec)}` : "";
            const payee = r.payee ? ` → ${r.payee.slice(0, 10)}...` : "";
            const url = r.resourceUrl ? ` ${r.resourceUrl}` : "";
            const status = r.status && r.status !== "issued" ? ` [${r.status}]` : "";
            console.log(`    ${ts}  ${amt} ${sym}${fee}${payee}${url}${status}`);
          }
          console.log();
        } catch (_e) {
          console.log(`  ${ch.key}: hub unreachable`);
        }
      }
      httpClient.close();

    } else if (cmd === "rpc") {
      const targetNetwork = args[0] || null;
      const chains = targetNetwork
        ? [resolveNetwork(targetNetwork)]
        : [
            { chainId: 1, name: "Ethereum" },
            { chainId: 8453, name: "Base" },
            { chainId: 11155111, name: "Sepolia" },
            { chainId: 84532, name: "Base Sepolia" }
          ];

      console.log(`\nRPC Health Check\n`);
      for (const net of chains) {
        const rpcs = [
          ...(process.env.RPC_URL ? [process.env.RPC_URL] : []),
          ...(RPC_PRESETS[net.chainId] || [])
        ];
        console.log(`  ${net.name} (chain ${net.chainId}):`);
        if (rpcs.length === 0) {
          console.log(`    No RPCs configured\n`);
          continue;
        }
        for (const rpc of rpcs) {
          const start = Date.now();
          try {
            const provider = new ethers.providers.JsonRpcProvider({ url: rpc, timeout: 5000 }, net.chainId);
            const [network, blockNum] = await Promise.all([
              provider.getNetwork(),
              provider.getBlockNumber()
            ]);
            const latency = Date.now() - start;
            const chainOk = Number(network.chainId) === net.chainId;
            console.log(`    ${chainOk ? "OK" : "CHAIN MISMATCH"}  ${rpc}  block=${blockNum}  ${latency}ms`);
          } catch (err) {
            const latency = Date.now() - start;
            console.log(`    FAIL  ${rpc}  ${err.message.slice(0, 60)}  ${latency}ms`);
          }
        }
        console.log();
      }

    } else {
      console.error(`Unknown command: ${cmd}\n`);
      console.log(USAGE);
      process.exit(1);
    }
  } finally {
    agent.close();
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
