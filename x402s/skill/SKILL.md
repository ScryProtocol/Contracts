---
name: scp-agent
description: Operate the x402 State Channel Protocol (SCP) stack — pay 402-protected URLs, manage state channels, run chat/music/weather APIs. Use when user says "pay", "send payment", "open channel", "fund channel", "check balance", "chat message", "stream music", "402", "SCP", "state channel", "describe offers", or wants to make micropayments on Base/Sepolia/Ethereum.
license: MIT
compatibility: Requires Node.js 18+, npm, and access to an EVM RPC endpoint for on-chain operations.
metadata:
  author: x402s
  version: "3.0"
---

# SCP Agent

Operate the x402 State Channel Protocol stack. All commands run from `x402s/`.

## Architecture

- **Hub** — payment router, port 4021
- **Agent** — discovers offers, quotes, signs state, issues tickets, retries with payment proof
- **Contract** — `0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b` (CREATE2, all chains)

Flow: `Agent → 402 → Hub quote → sign state → Hub issue → paid retry`

For full protocol details, consult `references/protocol.md`.

## Scripts

### Describe Offers (AI-Aware)

Before paying, inspect what a URL offers:

```bash
node skill/scripts/describe-offers.js <url>
```

Outputs a table: network, asset, human-readable amount, ~USD equivalent, hub fee, channel status. Includes a recommendation for the best offer based on readiness scoring and cost.

Use this when:
- Multiple offers exist and you need to compare
- User asks "what does this cost?" or "show me the offers"
- You want to verify pricing before paying

### Auto-Pay

```bash
npm run scp:light -- <url> [--method POST --json '{...}'] [--network base] [--dry-run]
```

Handles everything: discover → select best offer → fund channel if needed → pay.

## Offer Selection

When choosing between multiple 402 offers:

1. **Readiness first** — funded channel (score 2) > underfunded (1) > no channel (0)
2. **Cost** — convert to USD for cross-asset comparison. See `references/offers-guide.md` for pricing table.
3. **Network gas** — Base (~$0.001) beats mainnet (~$1-5) for new channels
4. **Hub fees** — zero-fee hubs preferred. Fee: `base + floor(amount × bps / 10000)`

If funded channels exist for multiple offers, pick the cheapest in USD. If no channel exists, prefer USDC on Base (lowest gas, stable pricing).

## Commands

### Pay
| Command | What it does |
|---------|-------------|
| `npm run scp:agent:pay -- <url> [hub\|direct]` | Pay a 402 URL |
| `npm run scp:agent:pay -- <url> --method POST --json '{...}'` | Pay with POST body |
| `npm run scp:light -- <url>` | Auto-pay (fund channel + pay) |
| `npm run scp:light -- <url> --dry-run` | Plan only |
| `npm run scp:agent:stream -- <url>` | Stream (pay in a loop) |
| `npm run scp:agent:payments` | Payment history |
| `npm run scp:dash` | Dashboard |

### Channels
| Command | What it does |
|---------|-------------|
| `npm run scp:channel:open -- <0xAddr> <network> <asset> <amount>` | Open + fund |
| `npm run scp:channel:fund -- <channelId> <amount>` | Top up |
| `npm run scp:channel:close -- <channelId>` | Close |
| `npm run scp:channel:list` | List channels |

### APIs
| Command | Port |
|---------|------|
| `npm run scp:chat` | 4044 |
| `npm run scp:music` | 4095 |
| `npm run scp:payee` | 4042 |
| `npm run scp:hub` | 4021 |

### Test
| Command | What it does |
|---------|-------------|
| `npm run scp:test:deep` | Integration tests |
| `npm run scp:demo:e2e` | End-to-end demo |

## Routing Rules

1. **pay \<url\>** → `npm run scp:agent:pay -- <url>`
2. **auto-pay \<url\>** → `npm run scp:light -- <url>`
3. **chat \<message\>** → `npm run scp:agent:pay -- https://pogchamp.tv/chat/chat --method POST --json '{"message":"..."}'`
4. **stream \<url\>** → `npm run scp:agent:stream -- <url>`
5. **describe \<url\>** → `node skill/scripts/describe-offers.js <url>`
6. **open / fund / close / list** → `npm run scp:channel:<cmd> -- ...`
7. **balance** → `npm run scp:channel:list` + `npm run scp:agent:payments`
8. **state** → read `node/scp-agent/state/agent-state.json`

## Live Endpoints

| Service | URL |
|---------|-----|
| Chat | `https://pogchamp.tv/chat/` |
| Hub (Base) | `https://pogchamp.tv/hub/base/` |
| Hub (Sepolia) | `https://pogchamp.tv/hub/sepolia/` |
| Pay (browser) | `https://pogchamp.tv/pay/` |

## References

- `references/protocol.md` — Full payment flow, 402 format, EIP-712 domain, context hash, fee formula
- `references/offers-guide.md` — Offers config format, pricing guide, stream.t values, live examples

## Errors

| Error | Fix |
|-------|-----|
| `No compatible payment offers` | Check `NETWORK` matches offer |
| `SCP_003_FEE_EXCEEDS_MAX` | Raise `MAX_FEE` |
| `amount exceeds maxAmount` | Raise `MAX_AMOUNT` |
| `Insufficient channel balance` | `npm run scp:channel:fund` |
| `ticket signer mismatch` | Payee `hubUrl` must match agent's hub |

Contract: `0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b`. After commands, summarize: what happened, amounts, errors.
