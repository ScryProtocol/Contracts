---
name: auto-402-hub-pay
description: Automatically pay HTTP 402-protected URLs through SCP hub routing. Handles offer discovery, AI-aware offer selection, channel funding, and payment in one step. Use when user says "pay this URL", "auto-pay", "402 payment", "buy access", or wants to call a paid API without manual channel management.
license: MIT
compatibility: Requires Node.js 18+, npm, EVM RPC access, and AGENT_PRIVATE_KEY.
metadata:
  author: x402s
  version: "2.0"
---

# Auto 402 Hub Pay

## Overview

Single-command payment for any 402-protected URL. Discovers offers, selects the best one, opens/funds a channel if needed, and submits payment.

## Runbook

Run from the `x402s/` project root:

```bash
node ../skills/auto-402-hub-pay/scripts/auto_402_hub_pay.js <url>
```

Common options:

```bash
node ../skills/auto-402-hub-pay/scripts/auto_402_hub_pay.js <url> \
  --topup-payments 100 \
  --method GET \
  --route hub \
  --network base \
  --rpc-urls https://mainnet.base.org,https://base-rpc.publicnode.com
```

POST with JSON body:

```bash
node ../skills/auto-402-hub-pay/scripts/auto_402_hub_pay.js https://pogchamp.tv/chat/chat \
  --method POST \
  --json '{"message":"hello from auto-pay"}' \
  --network base
```

Dry-run planning:

```bash
node ../skills/auto-402-hub-pay/scripts/auto_402_hub_pay.js <url> \
  --network base \
  --dry-run
```

## What The Script Does

1. Load `.env` from `x402s/` if present.
2. Discover offers from the target URL (GET → 402 response).
3. **Select best offer** using readiness scoring:
   - Score 2: funded channel exists (prefer these)
   - Score 1: channel exists but underfunded
   - Score 0: no channel yet
   - Tie-break: smaller `maxAmountRequired`, then original order
4. If multiple hub offers and no channel: check wallet affordability per offer, keep only affordable ones.
5. For hub offers, check/open/fund channel automatically.
6. If ERC-20 asset and allowance insufficient, submit `approve(MaxUint256)`.
7. Submit paid request using SCP signing flow.
8. Print summary: route, amount, ticket id, receipt/payment ids.

## AI-Aware Offer Selection

When reasoning about which offer to select, consider:

- **Readiness first** — a funded channel (score 2) always beats opening a new one
- **Cost comparison** — for cross-asset offers, convert to USD-equivalent:
  - 0.01 USDC = $0.01
  - 0.00001 ETH ≈ $0.025 at $2500/ETH
  - Prefer the cheaper option when readiness is equal
- **Network gas** — Base has ~$0.001 gas, Ethereum mainnet ~$1-5. Matters for channel open/fund.
- **Hub fees** — zero-fee hubs (like `pay.eth`) save money. Fee: `base + floor(amount × bps / 10000)`

If the user doesn't specify a preference, auto-select the cheapest funded option. If no channel exists, prefer USDC on Base (lowest gas + most predictable pricing).

## Inputs

Required:
- `AGENT_PRIVATE_KEY` (or enter interactively in TTY)

Optional:
- `NETWORK` or `NETWORKS`
- `RPC_URL`, `CONTRACT_ADDRESS`
- `MAX_AMOUNT`, `MAX_FEE`
- `AGENT_STATE_DIR`
- `X402S_ROOT` (defaults to workspace `x402s`)

## Notes

- Network aliases (`base`, `sepolia`) and CAIP (`eip155:8453`) both work.
- `--topup-payments` controls how many payments worth of balance to fund (default: 100).
- `--dry-run` shows the plan without executing any transactions.
- Read `references/env-and-flags.md` for full flag/env details.

## Examples

Example 1: Pay a chat API
User says: "send a message to the chat"
Actions:
1. Discover offers from `https://pogchamp.tv/chat/chat`
2. Select cheapest funded offer (USDC or ETH on Base)
3. Submit POST with `{"message":"..."}`
Result: Message posted, payment receipt returned

Example 2: Pay a weather API
User says: "get the weather"
Actions:
1. Discover offers from weather endpoint
2. Auto-fund channel if needed
3. Submit GET request
Result: Weather data returned

## Troubleshooting

Error: "No compatible payment offers from payee"
Cause: Network mismatch or endpoint unreachable
Solution: Check `NETWORK` matches offer, verify URL is accessible

Error: "Insufficient wallet balance"
Cause: Wallet can't afford channel funding
Solution: Fund wallet with enough ETH/USDC for `topup-payments × amount`

Error: "SCP_003_FEE_EXCEEDS_MAX"
Cause: Hub fee higher than `MAX_FEE` cap
Solution: Increase `MAX_FEE` or use a zero-fee hub
