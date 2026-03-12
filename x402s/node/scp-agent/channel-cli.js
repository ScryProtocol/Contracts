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

const USAGE = `Usage:
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
  channel open     0xHub base usdc 20
  channel open     0xHub sepolia eth 0.1
  channel fund     0xChannelId usdc 50
  channel balance                                           # all channels
  channel balance  0xChannelId                              # specific channel
  channel status                                            # quick overview
  channel receipts                                          # last 10 receipts
  channel receipts 0xChannelId --limit 25                   # 25 receipts for channel
  channel rpc      base                                     # test Base RPCs
  channel rpc                                               # test all RPCs

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

function networkLabel(chainId) {
  const labels = { 1: "Ethereum", 8453: "Base", 11155111: "Sepolia", 84532: "Base Sepolia" };
  return labels[chainId] || `chain:${chainId}`;
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
        console.log("  npm run scp:channel:open -- <0xHubAddr> <network> <asset> <amount>");
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
              const creditBal = credit.balance || credit.credit || "0";
              if (creditBal !== "0") {
                console.log(`  │    credit:        ${fmtHuman(creditBal, dec)} ${sym}`);
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
        console.log("  No channels. Run: npm run scp:channel:open");
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
                console.log(`       hub: nonce=${hubNonce} ${syncLabel}  credit=${hc.payerCredit || "0"}`);
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
              const bal = res.body.balance || res.body.credit || "0";
              if (bal !== "0") {
                if (!hasCredit) { console.log("  Credit:"); hasCredit = true; }
                console.log(`    ${hubUrl}: ${bal}`);
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
