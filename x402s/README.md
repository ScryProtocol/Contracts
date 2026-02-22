# x402s v2

State-channel-based HTTP 402 payments for agents and APIs.

`x402s` includes:
- An on-chain dispute contract (`X402StateChannel.sol`)
- A hub server for quote/issue/settlement workflows
- An agent SDK + CLI
- A payee server template for paid APIs
- A challenge watcher service

## What Is x402s (SCP)

`x402s` is an implementation of SCP (State Channel Payments) for HTTP `402 Payment Required`.

- `x402` part: APIs can respond with `402` and advertise payment offers.
- `SCP` part: payment happens off-chain by signing channel state updates, then settles on-chain only when needed.
- Result: API micropayments without sending an on-chain transaction for every request.

In practice:
- Agent asks for a paid resource.
- Payee returns `402` with accepted payment offers.
- Agent and hub/payee exchange signed payment state.
- Agent retries request with payment proof.
- Payee verifies and returns `200`.

## SCP Terms (Quick Glossary)

| Term | Meaning |
|---|---|
| `offer` | Payment options returned by the payee (`network`, `asset`, `maxAmountRequired`, route mode) |
| `quote` | Hub fee calculation and payment draft before issuing a ticket |
| `channel` | Two-party state channel balance tracked off-chain and enforceable on-chain |
| `ticket` | Hub-signed payment authorization used as payment proof |
| `payment proof` | Data attached in `PAYMENT-SIGNATURE` header on the paid retry |
| `receipt` | Payee acknowledgment after accepting payment |

## 5-Minute Quickstart (Most Users)

If you only need to pay 402-protected APIs as an agent, do this:

1. Install and generate config:

```bash
cd x402s
npm install
npm run scp:wizard
```

2. In `.env`, set at minimum:
- `AGENT_PRIVATE_KEY`
- `NETWORK` (or `NETWORKS`)
- `MAX_AMOUNT`
- `MAX_FEE`

3. Open/fund a channel to the hub:

```bash
npm run scp:channel:open -- <hubAddress> base usdc <amount>
```

4. Make a paid call:

```bash
npm run scp:agent:pay -- https://api.example/v1/data
```

## New User Start Here

### Agent (Most Users)

Most users only need payer-agent setup. Use the 5-minute quickstart above first, then use this section for extra knobs.

1. Generate config:

```bash
cd x402s
npm install
npm run scp:wizard
```

2. In the wizard, set your payer wallet in `AGENT_PRIVATE_KEY` and choose:
- Networks (`NETWORK`/`NETWORKS`)
- Safety caps (`MAX_AMOUNT`, `MAX_FEE`, optional per-asset overrides)
- Route and approval mode (`AGENT_DEFAULT_ROUTE`, `AGENT_APPROVAL_MODE`)

3. Optional local helper mode:
- `AGENT_START_PAYEE=1` makes `npm run scp:agent` also start a local `/pay` helper.

4. Make your first paid call to a paid API URL:

```bash
npm run scp:agent:pay -- https://api.example/v1/data
```

Local agent-to-agent `/pay` helper:

```bash
AGENT_START_PAYEE=1 npm run scp:agent
```

### API/Payee Dev (If You Build Paid APIs)

Run this stack only if you are developing paid APIs.

1. Start local services:

```bash
# terminal 1
npm run scp:payee
```

2. Verify payee paid route (expect `402 Payment Required` before payment):
- `curl -i http://127.0.0.1:4042/v1/data`
- `/pay` is discovery-only and mainly used for agent-to-agent offer discovery.

3. Optional local paid-call test (no hub, direct mode; requires a direct channel already open/funded):

```bash
# terminal 2
npm run scp:agent:pay -- http://127.0.0.1:4042/v1/data direct
```

## Real Usage

Use this profile for real usage (not local demo).

### Agent (Most Production Users)

- Use `npm run scp:agent:pay -- <url>` or `npm run scp:agent:server`.
- `npm run scp:agent` shows payer-agent status/help; optionally it can start local payee if `AGENT_START_PAYEE=1`.
- Configure:
  - `AGENT_PRIVATE_KEY`
  - `NETWORK` and `NETWORKS` for where this agent should pay
  - `RPC_URL` and `CONTRACT_ADDRESS` for on-chain channel operations
  - `MAX_AMOUNT` and `MAX_FEE` safety caps
  - Optional per-asset caps (`MAX_AMOUNT_ETH`, `MAX_FEE_USDC`, etc.) when different assets need different limits
  - `AGENT_APPROVAL_MODE` (`auto`, `per_payment`, `per_api`)
  - `AGENT_DEFAULT_ROUTE` (`hub`, `direct`, `auto`)

### Payee API (If You Operate Paid APIs)

- Use public URLs in offers:
  - `resource` must be publicly reachable by the payer.
  - `hubEndpoint` must be publicly reachable by the payer (for hub route).
  - Do not advertise `127.0.0.1` to remote users.
- Configure:
  - `PAYEE_PRIVATE_KEY`
  - `OFFERS_FILE` (networks/assets/modes/prices)
  - `pathPrices` in `OFFERS_FILE` sets per-route prices in human units by asset.
    Example: `"/weather": { "usdc": "0.50", "eth": "0.005" }` means `/weather` costs either `0.50 USDC` or `0.005 ETH`.
  - `HUB_URL` and `HUB_NAME` only if offering hub route

### Hub (Only If You Operate Hub Infrastructure)

- Configure:
  - `HUB_PRIVATE_KEY`
  - `RPC_URL`, `NETWORK`, `CONTRACT_ADDRESS`
  - `HUB_ADMIN_TOKEN` (recommended)
  - `PAYEE_AUTH_MAX_SKEW_SEC` (recommended)
- For multi-instance/worker operation:
  - Use shared storage (`REDIS_URL`) before enabling multi-worker mode.
  - Do not use unsafe cluster settings in production without shared state.

### Channel Funding

- Payments do not auto-fund channels.
- Open/fund channels explicitly with `scp:channel:open` and `scp:channel:fund`.
- Size channel balance for expected volume (amount + fee), not a single payment.

### Offer Selection Rules

These rules apply to `scp:agent:pay` and `scp:light`:

1. Filter offers by `--network` / `--asset` when provided.
2. Split offers into hub (`statechannel-hub-v1`) and direct (`statechannel-direct-v1`).
3. Score offer readiness by local channel state:
   - `2`: channel exists and `balA >= offer.maxAmountRequired`
   - `1`: channel exists but is underfunded
   - `0`: no channel exists
4. Tie-break by smaller `maxAmountRequired`, then original offer order.
5. Route behavior:
   - `--route hub`: choose the best hub offer only.
   - `--route direct`: choose the best direct offer only.
   - `--route auto`: choose direct only if direct score is `>= 2`; otherwise choose hub (or fallback direct if no hub exists).
6. Extra hub-affordability guard:
   - If multiple hub offers exist and no hub channel exists yet, the agent checks wallet affordability for each hub offer's required top-up and keeps only affordable hub offers before final selection.
   - If none are affordable (and route is `hub`, or no direct fallback exists), selection fails with a clear error.

## Architecture

```text
Agent                 Hub                        Payee API
  |                     |                            |
  | GET /resource       |                            |
  |-------------------->|                            |
  |<------ 402 + offers |                            |
  |                     |                            |
  | POST /v1/tickets/quote ------------------------->|
  |-------------------->|                            |
  |<----------- quote + draft                        |
  |                     |                            |
  | POST /v1/tickets/issue (signed channel state)    |
  |-------------------->|                            |
  |<----------- ticket + channelAck                  |
  |                     |                            |
  | GET /resource + PAYMENT-SIGNATURE -------------> |
  |<------------------------ 200 + receipt           |
```

## Local Stack (3 Terminals, Infra Testing)

Run this only when you want to host/test your own hub + payee locally.

Run each component in separate terminals:

```bash
# terminal 1
npm run scp:hub

# terminal 2
npm run scp:payee

# terminal 3
npm run scp:agent:server
```

First launch behavior:
- If `.env` is missing, these commands start an interactive terminal wizard.
- The wizard collects settings and writes `.env` plus an offers config file.
- You can run it directly with `npm run scp:wizard`.

## Role Reference

Most users only need the `agent (payer)` role.

| Role | Purpose | Start command | Required key | Default port | Quick check |
|---|---|---|---|---|---|
| `hub` | Quote fees, issue tickets, track payments/settlement state | `npm run scp:hub` | `HUB_PRIVATE_KEY` | `4021` | `curl -sS http://127.0.0.1:4021/.well-known/x402` |
| `api payee` | Protect API routes with 402 and validate payment proofs | `npm run scp:payee` | `PAYEE_PRIVATE_KEY` | `4042` | `curl -i http://127.0.0.1:4042/v1/data` (expect `402`) |
| `agent (payer)` | Discover offers and pay paid APIs from wallet/channel state | `npm run scp:agent:pay -- <url>` (`scp:agent` shows status/help; with `AGENT_START_PAYEE=1` it also serves local `/pay`) | `AGENT_PRIVATE_KEY` | n/a | `npm run scp:channel:list` |
| `agent API server` (optional) | Expose payer agent as HTTP endpoints for other apps/services | `npm run scp:agent:server` | `AGENT_PRIVATE_KEY` | `4060` | `curl -sS http://127.0.0.1:4060/health` |

Useful extras:

```bash
npm run scp:agent:server   # agent HTTP wrapper
npm run scp:dash           # agent dashboard
```

Set keys only for roles you run:
- `HUB_PRIVATE_KEY`: hub operator key
- `AGENT_PRIVATE_KEY`: payer agent key
- `PAYEE_PRIVATE_KEY`: API payee server key

### Shared Prereqs (Sepolia)

Run once:

```bash
cd x402s
npm run scp:wizard
```

Manual fallback (non-interactive):

```bash
cp .env.example .env
# then edit .env directly
```

### Wizard: Hub

Terminal A:

```bash
npm run scp:hub
```

Health check:

```bash
curl -sS http://127.0.0.1:4021/.well-known/x402
```

### Wizard: Agent API Server

Terminal B:

```bash
npm run scp:agent:server
```

Health check:

```bash
curl -sS http://127.0.0.1:4060/health
```

### Wizard: Agent CLI

Terminal C:

```bash
# discover hub wallet address
HUB_ADDRESS=$(node -e "fetch('http://127.0.0.1:4021/.well-known/x402').then(r=>r.json()).then(j=>console.log(j.address))")

# open/fund agent -> hub channel
npm run scp:channel:open -- "$HUB_ADDRESS" sepolia usdc 20
npm run scp:channel:list

# optional top-up
npm run scp:channel:fund -- <channelId> usdc 10
```

Funding tip (important): size channels for expected usage, not a single request.

```text
required_channel_balance ~= expected_payments * (amount_per_payment + fee_per_payment)
```

Where fee is:

```text
fee = base + floor(amount * bps / 10000) + gasSurcharge
```

Example (`/meow` at `100000000000` wei, pay.eth ETH hub profile `base=0, bps=0, gas=0`):

```text
fee = 0
totalDebit per payment = 100000000000
100 payments ~= 10000000000000 wei
```

Pay examples:

```bash
# direct CLI payment flow
npm run scp:agent:pay -- https://api.example/pay hub

# call the agent API server instead of direct CLI flow
curl -sS http://127.0.0.1:4060/v1/call-api \
  -H 'content-type: application/json' \
  -d '{"url":"https://api.example/v1/data","route":"hub"}'
```

### Quick Reference

```bash
npm run scp:wizard
# or: cp .env.example .env && edit manually
```

Open channels:

```bash
# hub-routed channel
npm run scp:channel:open -- 0xHubAddress base usdc 20

# direct channel to a payee
npm run scp:channel:open -- 0xPayeeAddress base usdc 10
```

Pay:

```bash
npm run scp:agent:pay -- https://api.example/v1/data           # default route selection
npm run scp:agent:pay -- https://api.example/v1/data hub       # force hub route
npm run scp:agent:pay -- https://api.example/v1/data direct    # force direct route
npm run scp:agent:pay -- 0xChannelId... 5000000                # channel payment
```

### Remote URL Pay Checklist

For paying a public URL (for example a remote `/meow` endpoint), make sure:

1. `AGENT_PRIVATE_KEY` is set (second positional arg is route, not private key).
2. The agent discovers offers from the target URL first; `/pay` is optional fallback.
3. `NETWORK` matches the offer network (for `http://159.223.150.70/hub/sepolia`: `NETWORK=sepolia`).
4. `MAX_AMOUNT` is high enough for `maxAmountRequired` in the 402 offer.
5. For the public `pay.eth` Sepolia hub (`http://159.223.150.70/hub/sepolia`), set `MAX_FEE=0` (zero-fee profile).
6. You have a funded channel for the exact `hubEndpoint` in the offer.
7. Offer URLs are public:
   - `accepts[].resource` must be reachable by the agent.
   - `accepts[].extensions["statechannel-hub-v1"].hubEndpoint` must be reachable by the agent (use `http://159.223.150.70/hub/sepolia` for `pay.eth` Sepolia route).
   - Do not advertise `127.0.0.1` to remote clients.
8. Channel funding is sized for expected volume:
   - avoid opening for one-payment minimum unless this is intentional.
   - pre-fund for expected calls (`N * totalDebit_per_call`) to avoid frequent refills and failed payments.

Example:

```bash
AGENT_PRIVATE_KEY=0x... \
NETWORK=sepolia \
MAX_AMOUNT=1000000000000 \
MAX_FEE=0 \
HUB_URL=http://159.223.150.70/hub/sepolia \
npm run scp:agent:pay -- http://159.223.150.70/meow hub
```

Note: `scp:channel:open` and `scp:channel:fund` are on-chain operations and require `RPC_URL` (and `CONTRACT_ADDRESS` if not resolved by network defaults).

### Pay Troubleshooting

- `No compatible payment offers from payee`:
  - `NETWORK` mismatch or offer endpoints unreachable.
- `SCP_003_FEE_EXCEEDS_MAX`:
  - increase `MAX_FEE`.
- `amount exceeds maxAmount policy`:
  - increase `MAX_AMOUNT`.
- `Insufficient channel balance`:
  - top up channel via `npm run scp:channel:fund -- <channelId> <amount>`.
  - for new agents, compute top-up using expected volume (`N * (amount + fee)`), not one request.
- `RPC_URL required for on-chain operations`:
  - set `RPC_URL` before open/fund/close commands.

### New Agent Bootstrap

For each new agent wallet:

1. Set `AGENT_PRIVATE_KEY`, `NETWORK`, `RPC_URL`, `CONTRACT_ADDRESS`.
2. Discover hub address from `http://159.223.150.70/hub/sepolia/.well-known/x402`.
3. Open a fresh channel from that agent wallet.
4. Fund based on expected call volume and fee policy (not one-payment minimum).
5. Verify with `npm run scp:channel:list` and then test one paid call.

## Route Modes

### Hub Route (`statechannel-hub-v1`)

```text
Agent <-> Hub <-> Payee
```

Pros:
- One funded agent-hub channel can pay many payees
- Better operational UX for agents

Tradeoff:
- Hub fee per payment (for `pay.eth` at `http://159.223.150.70/hub/sepolia`, configured as 0)

### Direct Route (`statechannel-direct-v1`)

```text
Agent <-> Payee
```

Pros:
- No hub fee

Tradeoff:
- Need a channel per payee

## Protecting an API with 402

`x402s` supports file-based multi-network, multi-asset offers.

In `.env`:

```bash
OFFERS_FILE=./offers.example.json
```

`offers.example.json` drives:
- accepted networks/assets/modes (`offers[]`)
- per-path pricing (`pathPrices`)

Example:

```json
{
  "offers": [
    {
      "network": "base",
      "asset": ["usdc", "eth"],
      "maxAmountRequired": ["0.50", "0.005"],
      "mode": "hub",
      "hubName": "pay.eth",
      "hubEndpoint": "http://159.223.150.70/hub/sepolia"
    }
  ],
  "pathPrices": {
    "/weather": { "usdc": "0.50", "eth": "0.005" },
    "/boop": { "usdc": "0.20", "eth": "0.002" }
  }
}
```

Verification helper for payee servers:

```js
const { createVerifier } = require("x402s/node/scp-hub/ticket");

const verify = createVerifier({
  payee: "0xMyPayeeAddress",
  hubUrl: "http://159.223.150.70/hub/sepolia"
});

const result = await verify(req.headers["payment-signature"], invoiceStore);
if (result.replayed) return res.json(result.response);
if (!result.ok) return res.status(402).json({ error: result.error });

const response = { ok: true, receipt: { paymentId: result.paymentId } };
verify.seenPayments.set(result.paymentId, response);
return res.json(response);
```

## Hub Configuration

### Core Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Hub bind address |
| `PORT` | `4021` | Hub port |
| `HUB_NAME` | `pay.eth` | Display identity |
| `HUB_PRIVATE_KEY` | required | Hub signing key |
| `NETWORK` | `sepolia` | Chain selector |
| `DEFAULT_ASSET` | auto | Fallback payment asset |
| `FEE_BASE` | `10` (repo default), `0` (pay.eth ETH profile) | Flat fee component |
| `FEE_BPS` | `30` (repo default), `0` (pay.eth ETH profile) | Variable fee component (bps) |
| `GAS_SURCHARGE` | `0` | Extra gas pass-through |
| `RPC_URL` | unset | Required for on-chain actions |
| `CONTRACT_ADDRESS` | unset | Channel contract address |
| `STORE_PATH` | `./data/store.json` | File-backed store path |
| `REDIS_URL` | unset | Optional shared Redis backend |
| `HUB_WORKERS` | `0` | Cluster workers (`0` = single process) |
| `ALLOW_UNSAFE_CLUSTER` | unset | Must be `1` to force cluster mode |

Fee formula:

```text
fee = base + floor(amount * bps / 10000) + gasSurcharge
```

## Scaling Notes

If you want real horizontal scaling:
1. Use shared storage (`REDIS_URL`) instead of file-only storage.
2. Run multiple hub workers/instances behind a load balancer.
3. Move worker-local subsystems to shared transport/state where needed.
4. Load-test with `scp:bench:tps` after each change.

Cluster mode is intentionally guarded and requires `ALLOW_UNSAFE_CLUSTER=1`.

## TPS Benchmark

Command:

```bash
npm run scp:bench:tps
```

Common benchmark variants:

```bash
# single worker, file store
BENCH_TOTAL=1000 BENCH_CONCURRENCY=50 npm run scp:bench:tps

# clustered workers, file store
BENCH_WORKERS=2 BENCH_TOTAL=1000 BENCH_CONCURRENCY=50 npm run scp:bench:tps

# clustered workers, Redis backend
BENCH_WORKERS=2 BENCH_REDIS_URL=redis://127.0.0.1:6379 npm run scp:bench:tps

# spawn multiple hub instances and distribute load across them
BENCH_INSTANCES=4 BENCH_BASE_PORT=4521 BENCH_TOTAL=5000 BENCH_CONCURRENCY=400 npm run scp:bench:tps

# target an existing hub fleet (for example behind a load balancer or manual endpoints)
BENCH_HUB_URLS=http://127.0.0.1:4521,http://127.0.0.1:4522 BENCH_TOTAL=5000 BENCH_CONCURRENCY=400 npm run scp:bench:tps
```

Main benchmark env knobs:
- `BENCH_TOTAL`
- `BENCH_CONCURRENCY`
- `BENCH_WORKERS`
- `BENCH_INSTANCES`
- `BENCH_BASE_PORT`
- `BENCH_REDIS_URL`
- `BENCH_HUB_URLS`
- `BENCH_STORE_PATH`
- `BENCH_PORT`
- `BENCH_HOST`

If `REDIS_URL`/`BENCH_REDIS_URL` is set, install redis client first:

```bash
npm install redis
```

## Commands

### Payments

| Command | Purpose |
|---|---|
| `npm run scp:agent:pay -- <url> [hub|direct]` | Pay a URL |
| `npm run scp:agent:pay -- <url> --method POST --json '{"x":1}'` | Paid API call with payload |
| `npm run scp:agent:pay -- <channelId> <amount>` | Pay through specific channel |
| `npm run scp:agent:payments` | Show payment history |
| `npm run scp:agent:payments -- api` | Show API earnings summary |

### Channels

| Command | Purpose |
|---|---|
| `npm run scp:channel:open -- <0xAddr> <network> <asset> <amount>` | Open and fund channel |
| `npm run scp:channel:fund -- <channelId> <amount>` | Add funds |
| `npm run scp:channel:close -- <channelId>` | Close channel |
| `npm run scp:channel:list` | List channels |

### Infra and Testing

| Command | Purpose |
|---|---|
| `npm run scp:hub` | Start hub |
| `npm run scp:wizard` | Interactive first-launch config wizard |
| `npm run scp:hub:selftest` | No-bind hub self-test |
| `npm run scp:payee` | Start payee demo server |
| `npm run scp:weather` | Start weather API template |
| `npm run scp:meow` | Start paid `/meow` API template |
| `npm run scp:agent` | Agent runner (status/help; optional local `/pay` helper) |
| `npm run scp:agent:server` | Agent HTTP service |
| `npm run scp:dash` | Agent dashboard |
| `npm run scp:sim` | Simulation |
| `npm run scp:sim:mixed` | Mixed simulation |
| `npm run scp:demo:e2e` | End-to-end demo |
| `npm run scp:demo:direct` | Direct-route demo |
| `npm run scp:bench:tps` | Hub TPS benchmark |
| `npm run scp:watch:agent` | Watcher as agent |
| `npm run scp:watch:hub` | Watcher as hub |
| `npm run scp:test` | Contract tests |
| `npm run scp:test:deep` | Integration tests |
| `npm run scp:test:all` | Full test suite |
| `npm run scp:compile` | Compile contracts |
| `npm run scp:deploy:sepolia` | Deterministic CREATE2 deploy (Sepolia) |
| `npm run scp:deploy:base` | Deterministic CREATE2 deploy (Base) |

## Contract

Contract: `contracts/X402StateChannel.sol`

### Deterministic Deploy (CREATE2)

`scripts/deploy.js` deploys with CREATE2 through a factory (`CREATE2_FACTORY`).
If you keep these identical across chains, the contract address is identical:

- CREATE2 factory address
- contract bytecode
- CREATE2 salt

Useful env vars:

```bash
# required to sign/send deployment tx
DEPLOYER_KEY=0x...

# optional overrides
BASE_RPC=https://mainnet.base.org
SEPOLIA_RPC=https://rpc.sepolia.org
CREATE2_FACTORY=0x4e59b44847b379578588920ca78fbf26c0b4956c
CREATE2_SALT=x402s:X402StateChannel:v1
```

Core methods:

```text
openChannel(participantB, asset, amount, challengePeriodSec, channelExpiry, salt)
deposit(channelId, amount)
cooperativeClose(state, sigA, sigB)
startClose(state, sigFromCounterparty)
challenge(newerState, sigFromCounterparty)
finalizeClose(channelId)
```

State fields:

```text
channelId
stateNonce
balA
balB
locksRoot
stateExpiry
contextHash
```

Invariant: `balA + balB` must match total channel balance.

## Challenge Watcher

Use watcher to challenge stale closes:

```bash
# as agent
ROLE=agent RPC_URL=... CONTRACT_ADDRESS=0x... CHANNEL_ID=0x... WATCHER_PRIVATE_KEY=0x... npm run scp:watch:agent

# as hub
ROLE=hub RPC_URL=... CONTRACT_ADDRESS=0x... CHANNEL_ID=0x... WATCHER_PRIVATE_KEY=0x... npm run scp:watch:hub
```

Important vars:
- `ROLE`
- `RPC_URL`
- `CONTRACT_ADDRESS`
- `CHANNEL_ID`
- `WATCHER_PRIVATE_KEY`
- `POLL_MS`
- `SAFETY_BUFFER_SEC`

## Project Structure

```text
x402s/
├── contracts/
├── node/
│   ├── scp-agent/
│   ├── scp-common/
│   ├── scp-demo/
│   ├── scp-hub/
│   ├── scp-sim/
│   ├── scp-watch/
│   └── weather-api/
├── docs/
├── scripts/
├── skill/
└── test/
```

## Spec

- Protocol spec: `docs/X402_STATE_CHANNEL_V1.md`
- OpenAPI: `docs/openapi/pay-eth-scp-v1.yaml`
- Schemas: `docs/schemas/`

## License

MIT
