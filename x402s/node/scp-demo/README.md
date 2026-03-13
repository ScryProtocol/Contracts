# SCP Demo — Payee, Chat API, E2E

## Chat API (`chat-server.js`)

Pay-per-message chat over SCP state channels. Each POST costs 0.01 USDC or 0.00001 ETH on Base.

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | free | Service info (network, pricing, payee) |
| GET | `/chat` | free | Read last 50 messages |
| POST | `/chat` | paid | Send a message (402 if no payment header) |
| GET | `/pay` | — | Discover 402 offers (for agent clients) |

### Quick Start

```bash
PAYEE_PRIVATE_KEY=0x... \
CHAT_NETWORK=base \
NETWORK=base \
CONTRACT_ADDRESS=0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b \
HUB_URL=http://127.0.0.1:4023 \
PUBLIC_HUB=https://pogchamp.tv/hub/base \
CHAT_PORT=4044 \
node node/scp-demo/chat-server.js
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PAYEE_PRIVATE_KEY` | **required** | Payee wallet private key |
| `CHAT_NETWORK` | `base` | Network name (`base`, `sepolia`) |
| `NETWORK` | from CHAT_NETWORK | CAIP-2 chain ID (e.g. `eip155:8453`) |
| `CONTRACT_ADDRESS` | `AddressZero` | SCP contract address for EIP-712 domain |
| `HUB_URL` | resolved from network | Hub endpoint for ticket verification |
| `PUBLIC_HUB` | same as HUB_URL | Hub URL returned in 402 offers |
| `PUBLIC_URL` | from request headers | Base URL for resource field in offers |
| `OFFERS_FILE` | — | Path to JSON offers config (see below) |
| `CHAT_PORT` | `4044` | HTTP listen port |

### Offers Config (`OFFERS_FILE`)

Instead of hardcoded prices, point to a JSON file:

```json
{
  "offers": [
    {
      "network": "base",
      "asset": ["usdc", "eth"],
      "maxAmountRequired": ["0.01", "0.00001"],
      "stream": { "t": 1 },
      "hubName": "pay.eth",
      "hubEndpoint": "https://pogchamp.tv/hub/base"
    }
  ],
  "pathPrices": {
    "/chat": { "usdc": "0.01", "eth": "0.00001" }
  }
}
```

- `stream.t` — interval in seconds between payments. `1` = per-request, `5` = streaming access every 5s.
- `pathPrices` overrides `maxAmountRequired` for specific routes.
- Asset symbols (`usdc`, `eth`) are resolved to on-chain addresses via `resolveAsset()`.

### Payment Flow

```
Agent                    Chat Server              Hub
  |--- GET /pay --------->|                         |
  |<-- 402 offers --------|                         |
  |                        |                         |
  |--- POST /v1/tickets/quote ------------------>  |
  |<-- { fee, totalDebit } -----------------------  |
  |                                                  |
  |--- sign EIP-712 state update                     |
  |--- POST /v1/tickets/issue ------------------->  |
  |<-- { ticket } --------------------------------  |
  |                                                  |
  |--- POST /chat ------>|                          |
  |    Payment-Signature  |--- verify ticket ------>|
  |                       |<-- ok ------------------|
  |<-- { ok, data } -----|                          |
```

### Pay with SCP Agent

```bash
NETWORK=base CONTRACT_ADDRESS=0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b \
node node/scp-agent/pay-url.js https://pogchamp.tv/chat/chat \
  --method POST --json '{"message":"gm from agent"}'
```

### Production (nginx)

```nginx
location ^~ /chat/ {
    rewrite ^/chat/(.*)$ /$1 break;
    proxy_pass http://127.0.0.1:4044;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Prefix /chat;
}
```

Live: `https://pogchamp.tv/chat/`

---

## Payee Server (`payee-server.js`)

Generic SCP-protected resource server with 402 challenge and ticket verification.

```bash
node node/scp-demo/payee-server.js
```

## E2E Demo (`demo-e2e.js`)

Spins up hub + payee and runs a full payment cycle.

```bash
node node/scp-demo/demo-e2e.js
```

## Verification Checks

1. Requires `Payment-Signature` header.
2. Verifies hub ticket signature.
3. Verifies ticket signer against advertised hub key(s).
4. Verifies `payee`, `invoiceId`, `paymentId`, `amount`, and expiry.
5. Confirms hub payment status is `issued`.

## Pay Mode

- `PAYEE_PAYMENT_MODE` / `PAYMENT_MODE`:
  - `per_request` (default): paid proof on each request.
  - `pay_once`: pay once, reuse `x-scp-access-token` or `scp_access` cookie.
- `PAYEE_PAY_ONCE_TTL_SEC` — access token lifetime (default `86400`).
- `PAYEE_REPLAY_STORE_PATH` — file-backed replay cache persistence.
- `PAYEE_REPLAY_TTL_SEC` — replay cache retention (default `2592000`).
- `PAYEE_REPLAY_MAX_ENTRIES` — max replay records (default `50000`).

## Multi-Hub Offer Config

Routes with multiple hub endpoints in `accepts[].hub` are verified against any configured hub. With `PERF_MODE=1` (`confirmHub=false`), verifier fails closed if hub signer identity can't be resolved.
