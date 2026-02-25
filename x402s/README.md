# x402s Use Guide

A practical guide to using x402s — state channel payments for agents and APIs.

---

## Contents

- [Who This Guide Is For](#who-this-guide-is-for)
- [Concepts in 60 Seconds](#concepts-in-60-seconds)
- [Installation](#installation)
- [Part 1: Paying APIs as an Agent](#part-1-paying-apis-as-an-agent)
- [Part 2: Building a Paid API (Payee)](#part-2-building-a-paid-api-payee)
- [Part 3: Running a Hub](#part-3-running-a-hub)
- [Part 4: Channel Management](#part-4-channel-management)
- [Part 5: Direct (Hubless) Payments](#part-5-direct-hubless-payments)
- [Part 6: Monitoring and Safety](#part-6-monitoring-and-safety)
- [Part 7: Testing and Development](#part-7-testing-and-development)
- [Part 8: Production Checklist](#part-8-production-checklist)
- [Configuration Reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)

---

## Who This Guide Is For

| If you are... | Start at... |
|---------------|-------------|
| An agent developer who needs to pay for APIs | [Part 1](#part-1-paying-apis-as-an-agent) |
| An API developer who wants to charge for endpoints | [Part 2](#part-2-building-a-paid-api-payee) |
| Running your own payment hub infrastructure | [Part 3](#part-3-running-a-hub) |
| Testing or evaluating the protocol | [Part 7](#part-7-testing-and-development) |

Most users only need **Part 1** — paying APIs as an agent.

---

## Concepts in 60 Seconds

x402s lets you pay for API calls without sending a blockchain transaction every time. Here's how:

1. Your agent requests a paid API endpoint.
2. The API returns `HTTP 402` with payment options (offers).
3. Your agent gets a fee quote from a hub, signs an off-chain balance update, and receives a payment ticket.
4. Your agent retries the request with the ticket attached — the API verifies it and serves the data.

All of this happens off-chain in milliseconds. The only on-chain transactions are opening a payment channel (once) and closing it (when you're done).

**Key terms:**
- **Channel** — A funded on-chain escrow between your wallet and a hub (or payee). Think of it as a prepaid balance.
- **Hub** — A payment router. Open one channel to a hub and pay any API that accepts it.
- **Ticket** — A hub-signed receipt that proves payment. The API trusts this.
- **Offer** — The payment options an API advertises when it returns `402`.

---

## Installation

```bash
git clone https://github.com/Keychain-Inc/x402s.git
cd x402s
npm install
```

**Requirements:** Node.js 18+, npm. For on-chain operations: an EVM wallet with funds and an RPC endpoint.

### First-Time Setup

Run the interactive wizard to generate your `.env` file:

```bash
npm run scp:wizard
```

The wizard walks you through setting your private key, choosing networks, and configuring safety caps. You can also manually create `.env`:

```bash
# .env — minimum agent config
AGENT_PRIVATE_KEY=0xYourPrivateKeyHere
NETWORK=base
RPC_URL=https://mainnet.base.org
MAX_AMOUNT=1000000        # max payment per request (base units)
MAX_FEE=10000             # max fee you'll accept per request
```

---

## Part 1: Paying APIs as an Agent

This is the most common use case. You have an agent that needs to call paid APIs.

### Step 1: Configure Your Agent

Set these in your `.env`:

```bash
AGENT_PRIVATE_KEY=0x...   # Your wallet private key
NETWORK=base              # Network to pay on (base, sepolia, mainnet)
RPC_URL=https://mainnet.base.org
MAX_AMOUNT=1000000        # Safety cap: max payment per request (base units)
MAX_FEE=10000             # Safety cap: max fee per request
```

**Optional per-asset overrides** (if you pay with multiple tokens):

```bash
MAX_AMOUNT_USDC=5000000   # Higher cap for USDC
MAX_AMOUNT_ETH=100000000000000   # Different cap for ETH
MAX_FEE_USDC=5000
```

### Step 2: Open and Fund a Channel

Before you can pay, you need a funded channel with the hub. This is a one-time on-chain operation.

```bash
# Find the hub's address
curl -s http://159.223.150.70/hub/sepolia/.well-known/x402 | jq .address

# Open a channel with 20 USDC to the hub on Base
npm run scp:channel:open -- 0xHubAddress base usdc 20

# Or on Sepolia testnet with ETH
npm run scp:channel:open -- 0xHubAddress sepolia eth 0.01
```

**How much to fund?** Size your channel for expected usage, not one payment:

```
channel_balance ≈ num_payments × (price_per_call + fee_per_call)
```

For a zero-fee hub like `pay.eth` on Sepolia:
```
100 calls at 0.0000001 ETH each = 0.00001 ETH total
```

Check your channels:

```bash
npm run scp:channel:list
```

Top up if needed:

```bash
npm run scp:channel:fund -- 0xChannelId usdc 10
```

### Step 3: Pay an API

```bash
# Let the agent auto-select the best route
npm run scp:agent:pay -- https://api.example.com/v1/data

# Force hub route
npm run scp:agent:pay -- https://api.example.com/v1/data hub

# Force direct route (requires a channel with the payee)
npm run scp:agent:pay -- https://api.example.com/v1/data direct
```

**What happens under the hood:**

1. Agent sends GET to the URL → receives `402` with offers
2. Agent picks the best offer (by readiness score, then price)
3. Agent quotes from the hub → gets fee + ticket draft
4. Agent signs a state update debiting `amount + fee` from its balance
5. Hub issues a signed ticket
6. Agent retries the request with `PAYMENT-SIGNATURE` header → gets `200`

### Step 4: Send Requests with Custom Methods/Payloads

```bash
# POST with JSON body
npm run scp:agent:pay -- https://api.example.com/v1/query --method POST --json '{"prompt":"hello"}'
```

### Step 5: View Payment History

```bash
# All payments
npm run scp:agent:payments

# API earnings summary
npm run scp:agent:payments -- api
```

### Using the Agent as an HTTP Service

If you want other apps to make paid calls through your agent:

```bash
npm run scp:agent:server
# Listening on port 4060

# Other apps can now POST:
curl -s http://127.0.0.1:4060/v1/call-api \
  -H 'content-type: application/json' \
  -d '{"url":"https://api.example.com/v1/data","route":"hub"}'
```

### Agent Dashboard

```bash
npm run scp:dash
```

Shows channel balances, payment history, and agent status in your terminal.

### Stream APIs (Cadence Payments)

For endpoints that expose stream metadata (`accepts[].extensions["statechannel-hub-v1"].stream`), use the stream client:

```bash
npm run scp:agent:stream -- <url> --route hub
```

Example (music demo):

```bash
npm run scp:music
npm run scp:music:stream -- http://127.0.0.1:4095 --track neon-sky
```

How streaming works:

1. Discover `402` offers.
2. Read cadence from `stream.t` and amount from `stream.amount`.
3. Repeat paid calls on cadence, updating cursor from `response.stream.nextCursor`.

Browser music app flow is documented in:

- `x402s/node/music-api/README.md` (`WS /music/ws`, `scp.402`, `stream.start`, `scp.approved` ticks)

---

## Part 2: Building a Paid API (Payee)

You want to charge for your API endpoints.

### Step 1: Configure Your Payee

```bash
# .env
PAYEE_PRIVATE_KEY=0x...     # Your payee wallet key
NETWORK=base                # Which chain to accept payments on
HUB_URL=http://159.223.150.70/hub/sepolia  # Hub endpoint
HUB_NAME=pay.eth
```

### Step 2: Create an Offers File

Create `offers.json`:

```json
{
  "offers": [
    {
      "network": "base",
      "asset": ["usdc", "eth"],
      "maxAmountRequired": ["0.50", "0.005"],
      "mode": "hub",
      "hubName": "pay.eth",
      "hubEndpoint": "http://159.223.150.70/hub/base"
    }
  ],
  "pathPrices": {
    "/v1/weather": { "usdc": "0.50", "eth": "0.005" },
    "/v1/premium": { "usdc": "1.00", "eth": "0.01" }
  }
}
```

Set `OFFERS_FILE=./offers.json` in your `.env`.

**Prices** are in human-readable units (e.g., `"0.50"` means 0.50 USDC). The SDK converts to base units automatically.

### Step 3: Start the Payee Server

```bash
npm run scp:payee
# Listening on 127.0.0.1:4042
```

Test it:

```bash
# Should return 402 with payment offers
curl -i http://127.0.0.1:4042/v1/weather
```

### Step 4: Integrate Into Your Own Server

If you're building your own HTTP server instead of using the template:

```javascript
const { createVerifier } = require("x402s/node/scp-hub/ticket");

// Create a verifier (once, at startup)
const verify = createVerifier({
  payee: "0xYourPayeeAddress",
  hubUrl: "http://159.223.150.70/hub/sepolia"
});

// In your request handler
app.get("/v1/data", async (req, res) => {
  const paymentHeader = req.headers["payment-signature"];

  // No payment? Return 402 with offers
  if (!paymentHeader) {
    return res.status(402).json({
      accepts: [
        {
          scheme: "statechannel-hub-v1",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          maxAmountRequired: "1000000",
          payTo: "pay.eth",
          resource: "https://yourapi.com/v1/data",
          extensions: {
            "statechannel-hub-v1": {
              hubName: "pay.eth",
              hubEndpoint: "http://159.223.150.70/hub/base",
              mode: "proxy_hold",
              feeModel: { base: "0", bps: 0 },
              quoteExpiry: Math.floor(Date.now() / 1000) + 120,
              invoiceId: generateInvoiceId(),
              payeeAddress: "0xYourPayeeAddress"
            }
          }
        }
      ]
    });
  }

  // Verify the payment
  const result = await verify(paymentHeader, invoiceStore);

  if (result.replayed) {
    return res.json(result.response);  // Idempotent replay
  }

  if (!result.ok) {
    return res.status(402).json({ error: result.error });
  }

  // Payment verified — serve the resource
  const response = {
    ok: true,
    data: { weather: "sunny, 72°F" },
    receipt: { paymentId: result.paymentId }
  };

  // Cache for replay protection
  verify.seenPayments.set(result.paymentId, response);

  return res.json(response);
});
```

### Payment Modes

x402s supports two payment modes per route:

**`per_request` (default):** Agent pays on every request. Simple and stateless.

**`pay_once`:** Agent pays once, then receives an access token valid for a configurable TTL. Good for subscriptions or sessions.

```json
{
  "pathPaymentModes": {
    "/v1/weather": "per_request",
    "/v1/premium": "pay_once"
  },
  "pathPayOnceTtls": {
    "/v1/premium": 86400
  }
}
```

The access token is delivered via `Set-Cookie: scp_access=...` header and the `x-scp-access-token` response header. Clients send it back on subsequent requests.

### Multi-Hub Support

Your payee can accept payments from multiple hubs:

```javascript
const verify = createVerifier({
  payee: "0xMyAddr",
  hubs: [
    "http://hub1.example.com:4021",
    "http://hub2.example.com:4021"
  ]
});
```

The verifier auto-discovers hub addresses from their `/.well-known/x402` endpoints and routes verification accordingly.

---

## Part 3: Running a Hub

Only do this if you're operating payment infrastructure.

### Step 1: Configure the Hub

```bash
# .env
HUB_PRIVATE_KEY=0x...         # Hub signing key
NETWORK=base                  # Primary chain
RPC_URL=https://mainnet.base.org
CONTRACT_ADDRESS=0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b

# Identity
HUB_NAME=myhub.eth
HOST=0.0.0.0                  # Bind to all interfaces
PORT=4021

# Fees
FEE_BASE=10                   # Flat fee (base units)
FEE_BPS=30                    # Variable fee: 30 bps = 0.30%
GAS_SURCHARGE=0               # Pass-through gas cost

# Storage
STORE_PATH=./data/store.json  # File storage (default)
# REDIS_URL=redis://localhost:6379  # Use Redis for multi-instance

# Security
HUB_ADMIN_TOKEN=secrettoken   # Protect admin endpoints
PAYEE_AUTH_MAX_SKEW_SEC=60    # Clock skew tolerance
```

### Step 2: Start the Hub

```bash
npm run scp:hub
# Hub listening on 0.0.0.0:4021
```

Verify it's running:

```bash
curl -s http://127.0.0.1:4021/.well-known/x402 | jq .
```

### Step 3: Fee Formula

Your hub charges per payment:

```
fee = FEE_BASE + floor(amount × FEE_BPS / 10000) + GAS_SURCHARGE
```

Example with `base=10, bps=30, gasSurcharge=0` on a 1,000,000 base unit payment:

```
fee = 10 + floor(1000000 × 30 / 10000) + 0 = 10 + 3000 = 3010
```

### Scaling the Hub

For production traffic:

1. **Use Redis** for shared state across instances:
   ```bash
   REDIS_URL=redis://your-redis:6379 npm run scp:hub
   ```

2. **Multi-instance behind a load balancer:**
   ```bash
   # Install redis client first
   npm install redis

   # Each instance shares state via Redis
   REDIS_URL=redis://... PORT=4021 npm run scp:hub &
   REDIS_URL=redis://... PORT=4022 npm run scp:hub &
   ```

3. **Benchmark your setup:**
   ```bash
   BENCH_TOTAL=1000 BENCH_CONCURRENCY=50 npm run scp:bench:tps
   ```

---

## Part 4: Channel Management

### Opening Channels

```bash
# Open to a hub
npm run scp:channel:open -- 0xHubAddress base usdc 20

# Open to a payee (for direct payments)
npm run scp:channel:open -- 0xPayeeAddress base usdc 10

# Open with ETH
npm run scp:channel:open -- 0xHubAddress sepolia eth 0.01
```

The system resolves RPC URLs, contract addresses, and token addresses automatically from the network and asset names.

### Listing Channels

```bash
npm run scp:channel:list
```

Shows all your open channels with balances, nonces, and status.

### Funding (Top-up)

```bash
npm run scp:channel:fund -- 0xChannelId usdc 10
```

**Sizing tip:** Don't fund one payment at a time. Pre-fund for expected volume:

```
balance = expected_calls × (price_per_call + fee_per_call)
```

### Closing Channels

```bash
npm run scp:channel:close -- 0xChannelId
```

This attempts a cooperative close first (instant, both parties agree on final balances). If that fails, it falls back to unilateral close (starts a challenge period, then finalizes).

### Channel Lifecycle

```
Open ──→ Active ──→ Closing ──→ Closed
  │                    │
  │  (cooperative)     │  (challenge period)
  └────────────────────┘
```

- **Open:** On-chain deposit. Channel ready for off-chain updates.
- **Active:** Off-chain balance updates with every payment.
- **Closing:** Either cooperative (instant) or unilateral (challenge window).
- **Closed:** Funds returned to both parties per final state.

---

## Part 5: Direct (Hubless) Payments

Direct mode skips the hub entirely. Agent and payee share a channel directly.

### When to Use Direct

- You have a single payee you pay frequently
- You want zero hub fees
- You're willing to manage a channel per payee

### Setup

1. Open a channel directly with the payee:
   ```bash
   npm run scp:channel:open -- 0xPayeeAddress base usdc 10
   ```

2. Pay with direct route:
   ```bash
   npm run scp:agent:pay -- https://api.example.com/v1/data direct
   ```

### How It Differs

| | Hub Route | Direct Route |
|---|-----------|-------------|
| Channels needed | 1 (to hub) | 1 per payee |
| Fees | Hub fee per payment | Zero |
| Payee verification | Verifies hub ticket | Verifies agent's signed state directly |
| Dispute rights | Agent ↔ Hub only | Agent ↔ Payee directly |

---

## Part 6: Monitoring and Safety

### Challenge Watcher

If someone tries to close your channel with an old (stale) state, the watcher automatically submits the latest state to dispute it.

```bash
# Watch as an agent
ROLE=agent \
  RPC_URL=https://mainnet.base.org \
  CONTRACT_ADDRESS=0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b \
  CHANNEL_ID=0xYourChannelId \
  WATCHER_PRIVATE_KEY=0xYourKey \
  npm run scp:watch:agent

# Watch as a hub
ROLE=hub \
  RPC_URL=https://mainnet.base.org \
  CONTRACT_ADDRESS=0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b \
  CHANNEL_ID=0xYourChannelId \
  WATCHER_PRIVATE_KEY=0xYourKey \
  npm run scp:watch:hub
```

Optional tuning:

```bash
POLL_MS=5000           # How often to check (default: 5s)
SAFETY_BUFFER_SEC=2    # Submit challenge this many seconds before deadline
```

### Webhooks

If you're running a payee or agent server, you can subscribe to hub events:

```bash
curl -X POST http://hub:4021/v1/webhooks \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://myserver.com/hooks/scp",
    "events": ["channel.close_started", "payment.received", "balance.low"],
    "channelId": "0x..."
  }'
```

Events are delivered as JSON POSTs with `X-SCP-Signature` HMAC header for verification.

### Safety Caps

Always set these in your agent config to limit exposure:

```bash
MAX_AMOUNT=1000000    # Never pay more than this per request
MAX_FEE=10000         # Never accept a fee higher than this
```

The agent rejects any offer or quote that exceeds these caps.

---

## Part 7: Testing and Development

### Quick Local Test (No Blockchain)

Run the full end-to-end demo — it spins up a hub, payee, and agent in-process:

```bash
npm run scp:demo:e2e
```

Direct route demo:

```bash
npm run scp:demo:direct
```

### Full Local Stack (3 Terminals)

```bash
# Terminal 1: Hub
npm run scp:hub

# Terminal 2: Payee
npm run scp:payee

# Terminal 3: Agent
npm run scp:agent:server
```

On first launch, each command runs the wizard if `.env` is missing.

### Contract Tests

```bash
# Hardhat contract tests
npm run scp:test

# Integration tests (hub + agent + payee stack)
npm run scp:test:deep

# Everything
npm run scp:test:all
```

### Hub Self-Test

```bash
npm run scp:hub:selftest
```

Runs the hub in-memory without binding to a port and verifies core functionality.

### Simulation

```bash
# Multi-agent simulation
npm run scp:sim

# Mixed hub + direct simulation
npm run scp:sim:mixed

# With custom parameters
SIM_AGENTS=10 SIM_PAYEES=5 SIM_ROUNDS=20 npm run scp:sim
```

### TPS Benchmarks

```bash
# Basic benchmark
npm run scp:bench:tps

# Tuned benchmark
BENCH_TOTAL=5000 BENCH_CONCURRENCY=200 npm run scp:bench:tps

# Multi-instance benchmark
BENCH_INSTANCES=4 BENCH_BASE_PORT=4521 BENCH_TOTAL=5000 npm run scp:bench:tps

# With Redis backend
BENCH_REDIS_URL=redis://127.0.0.1:6379 BENCH_WORKERS=2 npm run scp:bench:tps
```

### Testnet Deployment

Deploy the contract to Sepolia:

```bash
DEPLOYER_KEY=0x... npm run scp:deploy:sepolia
```

Deploy to Base:

```bash
DEPLOYER_KEY=0x... npm run scp:deploy:base
```

Both use CREATE2 for deterministic addresses. The canonical address is `0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b` on all chains.

---

## Part 8: Production Checklist

### Agent

- [ ] `AGENT_PRIVATE_KEY` is set (never hardcode, use env vars or secrets manager)
- [ ] `NETWORK` matches the offers you'll be paying
- [ ] `RPC_URL` points to a reliable RPC provider
- [ ] `MAX_AMOUNT` and `MAX_FEE` are set to reasonable safety caps
- [ ] Channel is open and funded for expected volume
- [ ] Watcher is running for your channel(s)

### Payee

- [ ] `PAYEE_PRIVATE_KEY` is set
- [ ] Offer URLs are publicly reachable (not `127.0.0.1`)
- [ ] `hubEndpoint` in offers is publicly reachable
- [ ] Prices are set correctly in `pathPrices`
- [ ] Invoice store handles cleanup (stale invoices expire)
- [ ] Replay protection via `paymentId` is enforced
- [ ] Webhook registered with hub for `payment.received`

### Hub

- [ ] `HUB_PRIVATE_KEY` is set and backed up
- [ ] `HUB_ADMIN_TOKEN` is set
- [ ] `PAYEE_AUTH_MAX_SKEW_SEC` is set (recommended: 60)
- [ ] Fee policy is configured (`FEE_BASE`, `FEE_BPS`)
- [ ] Redis is configured for multi-instance operation
- [ ] HTTPS/TLS termination is in place (reverse proxy)
- [ ] `/.well-known/x402` returns correct metadata
- [ ] Monitoring is set up for hub health and channel events
- [ ] Watcher is running for hub-side channels

---

## Configuration Reference

### All Commands

| Command | Purpose |
|---------|---------|
| **Setup** | |
| `npm run scp:wizard` | Interactive config wizard |
| **Agent** | |
| `npm run scp:agent:pay -- <url> [hub\|direct]` | Pay a 402 URL |
| `npm run scp:agent:pay -- <url> --method POST --json '{...}'` | Pay with HTTP method + body |
| `npm run scp:agent:pay -- <channelId> <amount>` | Pay through a specific channel |
| `npm run scp:agent:server` | Agent as HTTP service (port 4060) |
| `npm run scp:agent` | Agent status + optional local `/pay` helper |
| `npm run scp:agent:payments` | Payment history |
| `npm run scp:dash` | Agent dashboard |
| **Channels** | |
| `npm run scp:channel:open -- <addr> <network> <asset> <amount>` | Open + fund |
| `npm run scp:channel:fund -- <channelId> <amount>` | Top up |
| `npm run scp:channel:close -- <channelId>` | Close |
| `npm run scp:channel:list` | List all channels |
| **Infrastructure** | |
| `npm run scp:hub` | Start hub (port 4021) |
| `npm run scp:payee` | Start demo payee (port 4042) |
| `npm run scp:weather` | Start weather API template |
| `npm run scp:meow` | Start meow API template |
| **Testing** | |
| `npm run scp:test` | Contract tests |
| `npm run scp:test:deep` | Integration tests |
| `npm run scp:test:all` | All tests |
| `npm run scp:demo:e2e` | End-to-end demo |
| `npm run scp:demo:direct` | Direct route demo |
| `npm run scp:hub:selftest` | Hub self-test |
| `npm run scp:sim` | Multi-node simulation |
| `npm run scp:bench:tps` | TPS benchmark |
| **Monitoring** | |
| `npm run scp:watch:agent` | Watcher (agent role) |
| `npm run scp:watch:hub` | Watcher (hub role) |
| **Deploy** | |
| `npm run scp:deploy:sepolia` | Deploy contract to Sepolia |
| `npm run scp:deploy:base` | Deploy contract to Base |

### Supported Networks

| Name | Aliases | Chain ID |
|------|---------|----------|
| Ethereum | `mainnet`, `ethereum`, `eth` | 1 |
| Base | `base` | 8453 |
| Sepolia | `sepolia` | 11155111 |
| Base Sepolia | `base-sepolia` | 84532 |

### Supported Assets

| Symbol | Ethereum (1) | Base (8453) | Sepolia (11155111) | Base Sepolia (84532) |
|--------|-------------|-------------|-------------------|---------------------|
| ETH | native | native | native | native |
| USDC | `0xA0b869...` | `0x833589...` | `0x1c7D4B...` | `0x036CbD...` |
| USDT | `0xdAC17F...` | `0xfde4C9...` | — | — |

### Default Ports

| Service | Port |
|---------|------|
| Hub | 4021 |
| Payee | 4042 |
| Agent HTTP Server | 4060 |
| Meow API | 4090 |

---

## Troubleshooting

### "No compatible payment offers from payee"

Your agent can't match any offer from the `402` response.

**Fix:** Check that `NETWORK` in your `.env` matches the network in the payee's offers. If the payee advertises `eip155:11155111` (Sepolia), set `NETWORK=sepolia`. Also verify the payee's `hubEndpoint` and `resource` URLs are reachable from your machine.

### "SCP_003_FEE_EXCEEDS_MAX"

The hub's calculated fee is higher than your `MAX_FEE`.

**Fix:** Increase `MAX_FEE` in your `.env`. For the public `pay.eth` Sepolia hub (zero-fee), set `MAX_FEE=0`.

### "amount exceeds maxAmount policy"

The payment amount exceeds your `MAX_AMOUNT` safety cap.

**Fix:** Increase `MAX_AMOUNT` in your `.env`.

### "Insufficient channel balance"

Your channel doesn't have enough funds for the payment + fee.

**Fix:** Top up your channel:
```bash
npm run scp:channel:fund -- 0xChannelId usdc 10
```

Size for volume: if you expect 100 calls at 0.50 USDC + 0.003 fee each, fund at least 50.3 USDC.

### "RPC_URL required for on-chain operations"

You're trying an on-chain action (open, fund, close) without an RPC endpoint.

**Fix:** Set `RPC_URL` in your `.env`:
```bash
RPC_URL=https://mainnet.base.org     # Base
RPC_URL=https://rpc.sepolia.org      # Sepolia
```

### "ticket signer mismatch"

The payee received a ticket signed by a hub it doesn't recognize.

**Fix:** Ensure the payee's `hubUrl` config points to the same hub the agent is using. For multi-hub payees, add all hubs to the `hubs` array in `createVerifier()`.

### "stale direct nonce"

In direct mode, the payee received a state with a nonce it has already seen.

**Fix:** This usually means a replay or out-of-order request. Ensure your agent increments the nonce correctly. If you're debugging, check that the payee's in-memory nonce tracker hasn't been reset (e.g., by a server restart).

### Channel Won't Close

If cooperative close fails (counterparty unresponsive):

1. The close command falls back to unilateral close automatically.
2. A challenge period begins (typically 1–7 days).
3. After the deadline, call `finalizeClose` (the CLI handles this).
4. Run the watcher to protect against stale-state disputes during this window.

### Agent Can't Reach Hub

If you get connection errors to the hub:

1. Verify the hub URL is correct and reachable: `curl http://hub:4021/.well-known/x402`
2. Check firewall rules — the hub must be accessible from the agent's network.
3. Don't use `127.0.0.1` in offers served to remote agents.
