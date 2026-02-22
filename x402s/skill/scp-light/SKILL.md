---
name: scp-light
description: Lightweight SCP flow to automatically pay HTTP 402-protected URLs through hub routing without manual command choreography. Use when a user wants one workflow to discover offers, ensure channel funding, and submit payment.
---

# SCP Light

## Overview

Automate 402 URL payment using a single script that handles offer discovery, channel checks, funding checks, and payment submission.

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
  --network sepolia \
  --rpc-urls https://ethereum-sepolia-rpc.publicnode.com,https://rpc.sepolia.org
```

Dry-run planning:

```bash
node skill/scp-light/scripts/auto_402_hub_pay.js <url> \
  --network base \
  --dry-run
```

## What The Script Does

1. Load `.env` from `x402s/` if present.
2. Discover offers from the target URL and choose the best route (hub by default).
   - If multiple hub offers exist and no hub channel exists yet, it checks wallet balance viability per offer before choosing.
3. For hub offers, check whether a `hub:<endpoint>` channel exists in agent state.
4. If missing or underfunded, calculate target funding, check wallet balance on the offer network/asset, and open/fund channel.
5. If asset is ERC-20 and allowance is low, submit `approve(MaxUint256)` to the SCP contract.
6. Submit paid request using existing `ScpAgentClient` signing/payment flow.
7. Print summary with route, amount, ticket id, and receipt/payment ids.

## Inputs

Required:
- `AGENT_PRIVATE_KEY` (or enter it interactively when prompted in a TTY session)

Optional:
- `NETWORK` or `NETWORKS`
- `RPC_URL`
- `CONTRACT_ADDRESS`
- `MAX_AMOUNT`, `MAX_FEE`
- `AGENT_STATE_DIR`
- `X402S_ROOT` (defaults to workspace `x402s`)

## Notes

- Keep alias networks (`base`, `sepolia`) or CAIP (`eip155:*`); script normalizes internally.
- Use `--topup-payments` to control channel buffer size.
- In interactive TTY sessions, the script asks at startup how many payments top-up should cover (unless `--topup-payments` is set).
- Use `--rpc-url` or `--rpc-urls` to force preferred RPCs.
- Read `references/env-and-flags.md` for full flag/env details and troubleshooting.
