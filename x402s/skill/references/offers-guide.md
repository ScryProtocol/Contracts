# Offers Configuration Guide

## OFFERS_FILE Format

```json
{
  "offers": [
    {
      "network": "base",
      "asset": ["usdc", "eth"],
      "maxAmountRequired": ["0.01", "0.00001"],
      "mode": "hub",
      "hubName": "pay.eth",
      "hubEndpoint": "https://pogchamp.tv/hub/base"
    }
  ],
  "pathPrices": {
    "/chat": { "usdc": "0.01", "eth": "0.00001" },
    "/weather": { "usdc": "0.50", "eth": "0.0002" }
  },
  "pathPaymentModes": {
    "/chat": "per_request",
    "/weather": "per_request",
    "/premium": "pay_once"
  },
  "pathPayOnceTtls": {
    "/premium": 86400
  }
}
```

## Fields

### offers[]

| Field | Type | Description |
|-------|------|-------------|
| `network` | string | Network alias (`base`, `sepolia`) or CAIP-2 (`eip155:8453`) |
| `asset` | string[] | Asset symbols (`usdc`, `eth`) — resolved to addresses |
| `maxAmountRequired` | string[] | Human-readable prices, one per asset (positional) |
| `mode` | string | `hub`, `direct`, or `hub,direct` |
| `hubName` | string | Hub identity (e.g., `pay.eth`) |
| `hubEndpoint` | string | Hub API URL (must be publicly reachable) |
| `stream` | object | Optional. `{ "t": <seconds> }` for streaming cadence |

### pathPrices

Override `maxAmountRequired` per route. Keys are path prefixes matched against the request path.

### pathPaymentModes

- `per_request` (default): pay on every request
- `pay_once`: pay once, reuse access token for TTL duration

### stream.t

| Value | Meaning |
|-------|---------|
| omitted | One-shot payment (default) |
| 1 | Per-request (explicit, same as omitted) |
| 5 | Pay every 5 seconds for streaming access |
| 30 | Pay every 30 seconds (low-frequency stream) |

## Pricing Guide

Keep ETH and USDC prices roughly USD-equivalent:

| USDC | ETH (at ~$2500) | Use Case |
|------|-----------------|----------|
| 0.001 | 0.0000004 | Streaming music (per tick) |
| 0.01 | 0.000004 | Chat message |
| 0.10 | 0.00004 | API query |
| 0.50 | 0.0002 | Weather/data API |
| 1.00 | 0.0004 | Premium content |

Formula: `eth_price = usdc_price / eth_usd_rate`

## Live Example

Chat API at `https://pogchamp.tv/chat/`:

```json
{
  "offers": [{
    "network": "base",
    "asset": ["usdc", "eth"],
    "maxAmountRequired": ["0.01", "0.00001"],
    "stream": { "t": 1 },
    "hubName": "pay.eth",
    "hubEndpoint": "https://pogchamp.tv/hub/base"
  }],
  "pathPrices": {
    "/chat": { "usdc": "0.01", "eth": "0.00001" }
  }
}
```
