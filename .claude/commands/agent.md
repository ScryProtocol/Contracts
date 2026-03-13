# SCP Agent Skill

You are operating the x402 State Channel Protocol (SCP) agent. The project lives at `/workspaces/Contracts/x402s/`.

## Context

The SCP stack implements HTTP 402 micropayments over EVM state channels:
- **Hub** (`node/scp-hub/server.js`) — payment router, port 4021
- **Payee** (`node/scp-demo/payee-server.js`) — resource server with 402 challenge, port 4042
- **Chat** (`node/scp-demo/chat-server.js`) — pay-per-message chat API, port 4044
- **Music** (`node/music-api/server.js`) — pay-per-second streaming music API, port 4095
- **Agent** (`node/scp-agent/agent-client.js`) — `ScpAgentClient` class that discovers offers, quotes, signs state, issues tickets, and retries with payment proof
- **Contract** — `X402StateChannel.sol` deployed at CREATE2 canonical `0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b` on all chains

Payment flow: `Agent → 402 → Hub quote → sign state → Hub issue ticket → paid retry to Payee`

## Quick commands (run from `x402s/`)

### Pay
| Command | What it does |
|---------|-------------|
| `npm run scp:agent:pay -- <url> [hub\|direct]` | Pay a 402-protected URL |
| `npm run scp:agent:pay -- <url> --method POST --json '{...}'` | Pay with POST body |
| `npm run scp:agent:stream -- <url> [options]` | Stream (pay in a loop) any 402 URL |
| `npm run scp:agent:payments` | Show payment history |
| `npm run scp:dash` | Agent dashboard |

### Channels
| Command | What it does |
|---------|-------------|
| `npm run scp:channel:open -- <0xAddr> <network> <asset> <amount>` | Open channel with deposit |
| `npm run scp:channel:fund -- <channelId> <amount>` | Deposit into existing channel |
| `npm run scp:channel:close -- <channelId>` | Close channel (cooperative or unilateral) |
| `npm run scp:channel:list` | List all channels + balances |

Networks: `mainnet`, `base`, `sepolia`, `base-sepolia`. Assets: `eth`, `usdc`, `usdt`. RPCs and token addresses resolve automatically.

### Verify & Test
| Command | What it does |
|---------|-------------|
| `npm run scp:test:deep` | 8-test deep stack integration suite |
| `npm run scp:test:all` | Hardhat contract tests + deep stack |
| `npm run scp:demo:e2e` | Full end-to-end payment test |
| `npm run scp:demo:direct` | Direct peer-to-peer payment test |
| `npm run scp:hub:selftest` | Hub HTTP self-test |

### Watch
| Command | What it does |
|---------|-------------|
| `npm run scp:watch:agent` | Watch channel as agent — auto-challenge stale closes |
| `npm run scp:watch:hub` | Watch channel as hub |

### Infrastructure
| Command | What it does |
|---------|-------------|
| `npm run scp:hub` | Start hub server |
| `npm run scp:payee` | Start payee server |
| `npm run scp:chat` | Start chat API (port 4044) |
| `npm run scp:music` | Start music streaming API (port 4095) |
| `npm run scp:wizard` | Interactive first-launch config wizard |
| `npm run scp:sim` | Multi-node simulation |

### Auto-Pay (handles everything)
| Command | What it does |
|---------|-------------|
| `npm run scp:light -- <url>` | Auto-discover, fund channel if needed, pay |
| `npm run scp:light -- <url> --dry-run` | Plan only, show what would happen |
| `npm run scp:light -- <url> --method POST --json '{...}'` | Auto-pay with POST body |

## Offer Selection (AI-Aware)

When the agent discovers multiple 402 offers, choose the best one by reasoning about:

1. **Readiness** — prefer offers where a funded channel already exists (score 2 > 1 > 0)
2. **Cost** — compare total cost: `amount + fee`. Lower is better. Convert to USD-equivalent when comparing USDC vs ETH offers.
3. **Network** — Base has lower gas than Ethereum mainnet. Sepolia is testnet (free gas).
4. **Hub fees** — check `feeModel.base` + `feeModel.bps`. Zero-fee hubs (like pay.eth) are preferred.
5. **Affordability** — if no channel exists, check if wallet can afford to open one for the offer's network/asset.

Default tie-break: smaller `maxAmountRequired`, then original array order.

When presenting offers to the user, show: network, asset, amount (human-readable), hub fee, and whether a channel exists.

## What to do

Based on the user's request: $ARGUMENTS

Follow these rules:
1. All commands run from `/workspaces/Contracts/x402s/`
2. **pay \<url\>** → `npm run scp:agent:pay -- <url>` (add `direct` for direct route)
3. **pay \<url\> with body** → `npm run scp:agent:pay -- <url> --method POST --json '{...}'`
4. **auto-pay \<url\>** → `npm run scp:light -- <url>` (handles channel funding automatically)
5. **open \<address\> \<network\> \<asset\> \<amount\>** → `npm run scp:channel:open -- <0xAddress> <network> <asset> <amount>`
6. **fund \<channelId\> \<amount\>** → `npm run scp:channel:fund -- <channelId> <amount>`
7. **close \<channelId\>** → `npm run scp:channel:close -- <channelId>`
8. **balance** / **list** → `npm run scp:channel:list` then `npm run scp:agent:payments`
9. **verify** / **test** → `npm run scp:test:deep` (fast) or `npm run scp:test:all` (full)
10. **chat \<message\>** → `npm run scp:agent:pay -- https://pogchamp.tv/chat/chat --method POST --json '{"message":"..."}'`
11. **stream \<url\>** → `npm run scp:agent:stream -- <url>`
12. **sim** → `npm run scp:sim` with optional `SIM_AGENTS=10 SIM_PAYEES=5 SIM_ROUNDS=5`
13. **state** → read `node/scp-agent/state/agent-state.json`
14. **watch \<channelId\>** → `ROLE=agent RPC_URL=<rpc> CONTRACT_ADDRESS=<addr> CHANNEL_ID=<id> WATCHER_PRIVATE_KEY=<key> npm run scp:watch:agent`
15. If unclear → `npm run scp:demo:e2e`

Default CREATE2 contract (all chains): `0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b`.

For on-chain operations (open/fund/close), set `AGENT_PRIVATE_KEY`, `NETWORK`, and `RPC_URL`.

After running commands, summarize concisely: what happened, amounts, any errors.
