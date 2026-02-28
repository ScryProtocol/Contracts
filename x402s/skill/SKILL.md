---
name: scp-agent
description: Operate the x402 State Channel Protocol (SCP) stack — pay 402-protected URLs, pay Ethereum addresses, open/fund/close on-chain channels, check balances, and run tests. Use when the user wants to make micropayments, manage state channels, or test the SCP system.
license: MIT
compatibility: Requires Node.js, npm, and access to an EVM RPC endpoint for on-chain operations.
metadata:
  author: x402s
  version: "1.0"
---

# SCP Agent

Operate the x402 State Channel Protocol stack. All commands run from the `x402s/` project root.

## Architecture

- **Hub** (`node/scp-hub/server.js`) — payment router, port 4021
- **Payee** (`node/scp-demo/payee-server.js`) — resource server with 402 challenge, port 4042
- **Agent** (`node/scp-agent/agent-client.js`) — `ScpAgentClient` class: discovers offers, quotes, signs state, issues tickets, retries with payment proof
- **Contract** — `X402StateChannel.sol` deployed at CREATE2 canonical address `0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b` across chains

Payment flow: `Agent → 402 → Hub quote → sign state → Hub issue ticket → paid retry to Payee`

Payee payment modes:
- `PAYMENT_MODE=per_request` (default): send `PAYMENT-SIGNATURE` on each paid request.
- `PAYMENT_MODE=pay_once`: pay once, then reuse payee-issued access grant for that path.
- `PAY_ONCE_TTL_SEC`: access grant lifetime for `pay_once` mode (default `86400`).
- Access grant transport: `x-scp-access-token` header or `scp_access` cookie, depending on client/server flow.

Offer selection behavior:
- Filter offers by `network` / `asset` when provided.
- Split into hub and direct candidates.
- Score channel readiness: `2` (channel exists and funded), `1` (channel exists underfunded), `0` (no channel).
- Tie-break by smaller `maxAmountRequired`, then original order.
- `route=hub`: pick best hub only.
- `route=direct`: pick best direct only.
- `route=auto`: pick direct only when direct score is `>= 2`; otherwise pick hub (or fallback direct if no hub exists).
- If multiple hub offers exist and no hub channel exists yet, check wallet affordability per hub offer and keep only affordable hub offers.
- If no hub offer is affordable (and route is `hub`, or no direct fallback exists), fail with a clear error.

First-launch setup:
- `npm run scp:hub`, `npm run scp:payee`, and `npm run scp:agent` auto-run a terminal wizard when `.env` is missing.
- Run `npm run scp:wizard` directly to create or refresh `.env` + offers config.

## Commands

### Pay

| Command | What it does |
|---------|-------------|
| `npm run scp:agent:pay -- <url> [hub\|direct]` | Pay a 402-protected URL |
| `npm run scp:agent:pay -- <channelId> <amount>` | Pay through an open channel |
| `npm run scp:agent:payments` | Show payment history |
| `npm run scp:agent` | Show agent status/help (optional local `/pay` helper) |

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
| `npm run scp:watch:agent` | Watch channel as agent — auto-challenge if counterparty closes with stale nonce |
| `npm run scp:watch:hub` | Watch channel as hub |

Requires: `RPC_URL`, `CONTRACT_ADDRESS`, `CHANNEL_ID`, `WATCHER_PRIVATE_KEY`. Optional: `POLL_MS` (default 5000), `SAFETY_BUFFER_SEC` (default 2).

### On-chain Queries

The contract supports enumeration:
- `getChannelCount()` → total channels ever opened
- `getChannelIds(offset, limit)` → paginated channel ID list
- `getChannelsByParticipant(address)` → all channel IDs for an address
- `getChannel(channelId)` → single channel details

### Infrastructure

| Command | What it does |
|---------|-------------|
| `npm run scp:hub` | Start hub server |
| `npm run scp:wizard` | Interactive first-launch config wizard |
| `npm run scp:payee` | Start payee server |
| `npm run scp:sim` | Multi-node simulation |

## Remote URL Pay Requirements

For `npm run scp:agent:pay -- <url> hub` against public endpoints:

1. Set `AGENT_PRIVATE_KEY` (never pass key as the second positional arg).
2. Agent discovers offers from `<url>` first (`/pay` is optional fallback).
3. Set `NETWORK` to the offer network (`sepolia` for `eip155:11155111` on `http://159.223.150.70/hub/sepolia`).
4. Set `MAX_AMOUNT` high enough for offer `maxAmountRequired`.
5. For `pay.eth` at `http://159.223.150.70/hub/sepolia`, set `MAX_FEE=0` (zero-fee profile).
6. Ensure a funded channel exists for the exact offer `hubEndpoint` value.
7. Ensure offer endpoints are public:
   - `accepts[].resource` must be reachable from the agent machine.
   - `accepts[].extensions["statechannel-hub-v1"].hubEndpoint` must be reachable from the agent machine (use `http://159.223.150.70/hub/sepolia` for `pay.eth` Sepolia route).
   - avoid `127.0.0.1` in offers served to remote agents.
8. Fund channels for expected usage volume, not one payment.

Example command shape:

```bash
AGENT_PRIVATE_KEY=0x... NETWORK=sepolia MAX_AMOUNT=1000000000000 MAX_FEE=0 \
HUB_URL=http://159.223.150.70/hub/sepolia npm run scp:agent:pay -- http://159.223.150.70/meow hub
```

On-chain note: `scp:channel:open` and `scp:channel:fund` require `RPC_URL` (and `CONTRACT_ADDRESS` if not auto-resolved).

## Channel Funding Sizing

Use this sizing for new agents:

```text
required_balance ~= expected_payments * (amount_per_payment + fee_per_payment)
fee_per_payment = base + floor(amount * bps / 10000) + gasSurcharge
```

Example (`amount=100000000000`, `base=0`, `bps=0`, `gasSurcharge=0`):

```text
fee = 0
totalDebit per payment = 100000000000
100 payments ~= 10000000000000 wei
```

Always keep a safety buffer above expected usage.

## New Agent Onboarding

For each new agent wallet:

1. Set `AGENT_PRIVATE_KEY`, `NETWORK`, `RPC_URL`, `CONTRACT_ADDRESS`.
2. Query hub metadata (`/.well-known/x402`) and capture hub address.
3. Open channel from that wallet to hub address.
4. Fund using expected usage sizing formula.
5. Validate via `scp:channel:list`, then run one paid URL call.

## Common Errors -> Fix

- `No compatible payment offers from payee` -> check `NETWORK`, offer network, and endpoint reachability.
- `SCP_003_FEE_EXCEEDS_MAX` -> raise `MAX_FEE`.
- `amount exceeds maxAmount policy` -> raise `MAX_AMOUNT`.
- `Insufficient channel balance` -> fund channel.
- `RPC_URL required for on-chain operations` -> set `RPC_URL`.

## Routing rules

1. **pay \<url\>** → `npm run scp:agent:pay -- <url>` (add `direct` for direct route)
2. **open \<address\> \<network\> \<asset\> \<amount\>** → `npm run scp:channel:open -- <0xAddress> <network> <asset> <amount>` (e.g. `base usdc 20`)
3. **fund \<channelId\> \<amount\>** → `npm run scp:channel:fund -- <channelId> <amount>`
4. **close \<channelId\>** → `npm run scp:channel:close -- <channelId>`
5. **balance** / **list** → `npm run scp:channel:list` then `npm run scp:agent:payments`
6. **verify** / **test** → `npm run scp:test:deep` (fast) or `npm run scp:test:all` (full)
7. **sim** → `npm run scp:sim` with optional `SIM_AGENTS=10 SIM_PAYEES=5 SIM_ROUNDS=5`
8. **start** / **payee** → start payee server in background
9. **state** → read `node/scp-agent/state/agent-state.json`
10. **watch \<channelId\>** → `ROLE=agent RPC_URL=<rpc> CONTRACT_ADDRESS=<addr> CHANNEL_ID=<id> WATCHER_PRIVATE_KEY=<key> npm run scp:watch:agent` (use `ROLE=hub` + `npm run scp:watch:hub` for hub side)
11. **channels for \<address\>** → call `getChannelsByParticipant(address)` on-chain to discover all channels for an address, then `getChannel(id)` for each
12. If unclear → `npm run scp:demo:e2e`

Channel CLI resolves RPCs and token addresses automatically from network/asset names. You can also override with `RPC_URL` and `CONTRACT_ADDRESS` env vars. Default CREATE2 contract in this repo flow (all chains): `0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b`.

After running commands, summarize concisely: what happened, amounts, any errors.
