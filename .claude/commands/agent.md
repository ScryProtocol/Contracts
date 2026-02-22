# SCP Agent Skill

You are operating the x402 State Channel Protocol (SCP) agent. The project lives at `/workspaces/Contracts/x402s/`.

## Context

The SCP stack implements HTTP 402 micropayments over EVM state channels:
- **Hub** (`node/scp-hub/server.js`) — payment router, runs on port 4021
- **Payee** (`node/scp-demo/payee-server.js`) — resource server with 402 challenge, runs on port 4042
- **Agent** (`node/scp-agent/agent-client.js`) — `ScpAgentClient` class that discovers offers, quotes, signs state, issues tickets, and retries with payment proof
- **Contract** — `X402StateChannel.sol` deployed at `0x6F858C7120290431B606bBa343E3A8737B3dfCB4` on Sepolia

Payment flow: `Agent → 402 → Hub quote → sign state → Hub issue ticket → paid retry to Payee`

## Quick commands (run from `x402s/`)

### Pay
| Command | What it does |
|---------|-------------|
| `npm run agent:pay -- <url> [hub\|direct]` | **Pay a 402-protected URL** |
| `npm run agent:pay -- <0xAddr> <amount> [hubUrl]` | **Pay an address via hub** |
| `npm run agent:payments` | Show payment history |
| `npm run agent` | Run demo payment (auto-starts hub + payee) |

### Channels
| Command | What it does |
|---------|-------------|
| `npm run channel:open -- <0xAddr> [amount]` | **Open channel on-chain with deposit** |
| `npm run channel:fund -- <channelId> <amount>` | **Deposit into existing channel** |
| `npm run channel:close -- <channelId>` | **Close channel (cooperative or unilateral)** |
| `npm run channel:list` | List all channels + balances |

### Verify & Test
| Command | What it does |
|---------|-------------|
| `npm run test:deep` | 8-test deep stack integration suite |
| `npm run test:all` | Hardhat contract tests + deep stack |
| `npm run demo:e2e` | Full end-to-end payment test |
| `npm run demo:direct` | Direct peer-to-peer payment test |
| `npm run hub:selftest` | Hub HTTP self-test |

### Watch
| Command | What it does |
|---------|-------------|
| `npm run watch:agent` | Watch channel as agent — auto-challenge stale closes |
| `npm run watch:hub` | Watch channel as hub |

### Infrastructure
| Command | What it does |
|---------|-------------|
| `npm run hub` | Start hub server |
| `npm run payee` | Start payee server |
| `npm run sim` | Multi-node simulation |

## What to do

Based on the user's request: $ARGUMENTS

Follow these rules:
1. All commands run from `/workspaces/Contracts/x402s/`
2. **pay \<url\>** → `npm run agent:pay -- <url>` (add `direct` as second arg for direct route)
3. **pay \<address\> \<amount\>** → `npm run agent:pay -- <0xAddress> <amount> [hubUrl]` (hub must be running)
4. **pay** (no args) → start hub + payee in background, then `npm run agent:pay -- http://127.0.0.1:4042/v1/data`
5. **open \<address\> [amount]** → `RPC_URL=<rpc> CONTRACT_ADDRESS=<addr> npm run channel:open -- <0xAddress> <amount>`
6. **fund \<channelId\> \<amount\>** → `RPC_URL=<rpc> CONTRACT_ADDRESS=<addr> npm run channel:fund -- <channelId> <amount>`
7. **close \<channelId\>** → `RPC_URL=<rpc> CONTRACT_ADDRESS=<addr> npm run channel:close -- <channelId>`
8. **balance** / **list** → `npm run channel:list` to show channels + balances, then `npm run agent:payments` for payment history. If hub is running, also query `curl -s http://127.0.0.1:4021/v1/agent/summary?channelId=<id>` per channel.
9. **verify** / **test** → `npm run test:deep` (fast) or `npm run test:all` (full). For a quick smoke test, `npm run demo:e2e`.
10. **sim** → `npm run sim` with optional env vars `SIM_AGENTS=10 SIM_PAYEES=5 SIM_ROUNDS=5`
11. **hub** / **start** → start hub and/or payee servers in background
12. **state** → read `x402s/node/scp-agent/state/agent-state.json`
13. **watch \<channelId\>** → `ROLE=agent RPC_URL=<rpc> CONTRACT_ADDRESS=<addr> CHANNEL_ID=<id> WATCHER_PRIVATE_KEY=<key> npm run watch:agent`
14. If unclear, run `npm run demo:e2e`

For on-chain operations (open/fund/close), RPC_URL and CONTRACT_ADDRESS env vars are required. Default Sepolia contract: `0x6F858C7120290431B606bBa343E3A8737B3dfCB4`.

After running commands, summarize concisely: what happened, amounts, any errors.
