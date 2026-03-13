---
name: scp-light
description: Lightweight single-command SCP flow to pay HTTP 402-protected URLs through hub routing. Handles offer discovery, smart offer selection, channel funding, and payment automatically. Use when user says "auto-pay", "pay URL", "quick pay", "scp light", or wants one-step 402 payment without manual channel management.
compatibility: Requires Node.js 18+, npm, EVM RPC access, and AGENT_PRIVATE_KEY.
metadata:
  author: x402s
  version: "2.0"
---

# SCP Light

## Overview

Automate 402 URL payment using a single script that handles offer discovery, AI-aware offer selection, channel checks, funding, and payment submission.

## Runbook

Run from the `x402s/` project root:

```bash
node skill/scp-light/scripts/auto_402_hub_pay.js <url>
```

Common options:

```bash
node skill/scp-light/scripts/auto_402_hub_pay.js <url> \
  --topup-payments 100 \
  --method GET \
  --route hub \
  --network base \
  --rpc-urls https://mainnet.base.org,https://base-rpc.publicnode.com
```

POST with JSON body:

```bash
node skill/scp-light/scripts/auto_402_hub_pay.js https://pogchamp.tv/chat/chat \
  --method POST \
  --json '{"message":"hello"}' \
  --network base
```

Dry-run:

```bash
node skill/scp-light/scripts/auto_402_hub_pay.js <url> --network base --dry-run
```

## What The Script Does

1. Load `.env` from `x402s/` if present.
2. Discover offers from the target URL and choose the best route (hub by default).
   - If multiple hub offers and no channel: checks wallet balance viability per offer.
3. For hub offers, check whether a `hub:<endpoint>` channel exists in agent state.
4. If missing or underfunded, calculate target funding, check wallet balance, open/fund channel.
5. If ERC-20 and allowance low, submit `approve(MaxUint256)`.
6. Submit paid request using SCP signing flow.
7. Print summary: route, amount, ticket id, receipt/payment ids.

## AI-Aware Offer Selection

The script scores offers by channel readiness (2=funded, 1=underfunded, 0=none), then by cost. When AI is selecting on behalf of the user:

- **Funded channel always wins** — don't open a new channel when one exists
- **Cross-asset comparison** — 0.01 USDC ≈ $0.01; 0.00001 ETH ≈ $0.025 at $2500/ETH
- **Network gas matters for new channels** — Base gas ~$0.001, mainnet ~$1-5
- **Zero-fee hubs preferred** — `pay.eth` charges 0 base + 0 bps

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

- Alias networks (`base`, `sepolia`) or CAIP (`eip155:*`); script normalizes internally.
- `--topup-payments` controls channel buffer size (default: 100).
- In interactive TTY, the script asks how many payments top-up should cover (unless `--topup-payments` is set).
- If payee uses `PAYMENT_MODE=pay_once`, this script performs the first paid call; follow-up calls reuse the access grant.
- Read `references/env-and-flags.md` for full flag/env details and troubleshooting.
