/* eslint-disable no-console */
const { ScpAgentClient } = require("./agent-client");
const { resolveNetwork, resolveAsset, resolveContract, parseAmount, formatAmount } = require("../scp-common/networks");

const cmd = process.argv[2];
const args = process.argv.slice(3);

const USAGE = `Usage:
  channel open  <0xAddr> <network> <asset> <amount>       Open with friendly names
  channel open  <0xAddr> <rpcUrl> <0xToken> <rawAmount>   Open with raw values
  channel fund  <channelId> <asset> <amount>                Deposit with asset name
  channel fund  <channelId> <rawAmount>                    Deposit raw amount
  channel close <channelId>                                 Close channel
  channel list                                              List all channels

Examples:
  channel open  0xHub base usdc 20                                          # 20 USDC on Base
  channel open  0xHub sepolia eth 0.1                                       # 0.1 ETH on Sepolia
  channel open  0xHub https://rpc.example 0x833589f...02913 20000000        # raw RPC + token + amount
  channel fund  0xChannelId usdc 50                                         # fund 50 USDC
  channel fund  0xChannelId 50000000                                        # fund raw amount

Networks: mainnet, base, sepolia, base-sepolia
Assets:   eth, usdc, usdt`;

if (!cmd || cmd === "help") {
  console.log(USAGE);
  process.exit(0);
}

async function main() {
  const opts = {
    networkAllowlist: ["eip155:8453"],
    maxFeeDefault: process.env.MAX_FEE || "5000",
    maxAmountDefault: process.env.MAX_AMOUNT || "5000000"
  };
  if (process.env.AGENT_PRIVATE_KEY) opts.privateKey = process.env.AGENT_PRIVATE_KEY;
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

      let rpcUrl, assetAddr, rawAmount, label;
      if (isRaw) {
        rpcUrl = arg1;
        assetAddr = arg2;
        rawAmount = arg3;
        const contract = process.env.CONTRACT_ADDRESS;
        if (!contract) {
          console.error("CONTRACT_ADDRESS env var required for raw mode.");
          process.exit(1);
        }
        label = `${assetAddr.slice(0, 10)}...`;
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
          amount: rawAmount
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
        amount: rawAmount
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

      let amount, label;
      if (arg2) {
        // fund <channelId> <asset> <amount> — friendly
        const asset = resolveAsset(8453, arg1); // default chain for decimals lookup
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

      console.log(`Funding ${channelId} with ${label}...`);
      const result = await agent.fundChannel(channelId, amount);
      console.log("Funded!");
      console.log(JSON.stringify(result, null, 2));

    } else if (cmd === "close") {
      const channelId = args[0];
      if (!channelId) {
        console.error("Usage: channel close <channelId>");
        process.exit(1);
      }
      console.log(`Closing ${channelId}...`);
      const result = await agent.closeChannel(channelId);
      console.log(`Closed via ${result.method}!`);
      console.log(JSON.stringify(result, null, 2));

    } else if (cmd === "list") {
      const channels = agent.listChannels();
      if (channels.length === 0) {
        console.log("No channels.");
      } else {
        console.log(`Channels: ${channels.length}`);
        for (const ch of channels) {
          const hubMatch = ch.key.match(/^hub:(.+)$/);
          console.log("-----");
          console.log(`  channelId: ${ch.channelId}`);
          if (hubMatch) console.log(`  hub:       ${hubMatch[1]}`);
          console.log(`  balA:      ${ch.balA}`);
          console.log(`  balB:      ${ch.balB}`);
          console.log(`  nonce:     ${ch.nonce}`);
          if (ch.participantB) console.log(`  partner:   ${ch.participantB}`);
          if (ch.status) console.log(`  status:    ${ch.status}`);
          if (ch.txHash) console.log(`  txHash:    ${ch.txHash}`);
        }
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
