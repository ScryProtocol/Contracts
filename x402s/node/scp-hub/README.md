# SCP Node Hub (Reference)

Minimal Node.js reference service for `statechannel-hub-v1`.

## Run

```bash
node node/scp-hub/server.js
```

Optional env vars:

- `HOST` (default `127.0.0.1`)
- `PORT` (default `4021`)
- `HUB_NAME` (default `pay.eth`)
- `NETWORK` (`sepolia|base|mainnet|eip155:<id>`, recommended over `CHAIN_ID`)
- `CHAIN_ID` (default `11155111` when `NETWORK` is unset)
- `HUB_PRIVATE_KEY` (required, no default)
- `DEFAULT_ASSET` (default Base USDC)
- `FEE_BASE` (default `10`)
- `FEE_BPS` (default `30`)
- `GAS_SURCHARGE` (default `0`)
- `STORE_PATH` (default `node/scp-hub/data/store.json`)
- `REDIS_URL` (optional; if set, hub storage uses Redis instead of `STORE_PATH`, requires `npm install redis`)
- `ALLOW_UNSAFE_PROD_STORAGE` (default unset; set `1` to allow non-Redis storage when `NODE_ENV=production`)
- `HUB_ADMIN_TOKEN` (optional; required for `POST /v1/events/emit` when set)
- `PAYEE_AUTH_MAX_SKEW_SEC` (default `300`, allowed timestamp skew for payee-signed admin routes)
- `SETTLEMENT_MODE` (default `cooperative_close`; one of `cooperative_close|direct`)

## Endpoints

- `GET /.well-known/x402`
- `POST /v1/tickets/quote`
- `POST /v1/tickets/issue`
- `POST /v1/refunds`
- `GET /v1/payments/:paymentId`
- `GET /v1/channels/:channelId`

### Protected Routes

- `POST /v1/hub/open-payee-channel`
- `POST /v1/hub/register-payee-channel`
- `POST /v1/payee/settle`

These require payee-signed headers:

- `x-scp-payee-signature`
- `x-scp-payee-timestamp`

Signature must recover to the `payee` address in request body and is bound to method + path + canonical JSON body.

`POST /v1/payee/settle` supports two settlement modes:

- `cooperative_close` (default): closes hub↔payee channel on-chain with `cooperativeClose`
- `direct`: sends ETH/ERC20 directly from hub wallet to payee

For `cooperative_close`, include `sigB` in request body:

- Body: `{ "payee":"0x...", "asset":"0x...", "sigB":"0x...", "mode":"cooperative_close" }`
- `sigB` must be payee signature over the latest `GET /v1/payee/channel-state` `latestState`.
- Hub validates `sigB` signer and requires channel `balB == unsettled ledger amount` to avoid over/under payout.

`POST /v1/payee/settle` also supports idempotency keys to prevent duplicate payouts on retries:

- Header: `Idempotency-Key: <key>`
- Body: `{ "idempotencyKey": "<key>" }`
- Key format: `[A-Za-z0-9:_-]{6,128}`

When an idempotency key is reused for the same `(payee, asset, mode)` scope:

- completed settlement returns the original settlement response (`idempotentReplay: true`)
- pending or failed settlement returns `409`

Settlement transactions wait for 1 confirmation and require successful receipt status.

- When `HUB_ADMIN_TOKEN` is configured, admin routes require `Authorization: Bearer <HUB_ADMIN_TOKEN>` (or `x-scp-admin-token`):
  - `POST /v1/events/emit`
  - `GET /v1/events`
  - `POST /v1/webhooks`
  - `GET|PATCH|DELETE /v1/webhooks/:id`

## No-Bind Self Test

In environments that block socket binding (EPERM), run:

```bash
node node/scp-hub/http-selftest.js
```

## Notes

- Persistent JSON store on disk (`STORE_PATH`) or shared Redis store (`REDIS_URL`).
- In production (`NODE_ENV=production`), hub requires `REDIS_URL` by default. Override only with `ALLOW_UNSAFE_PROD_STORAGE=1`.
- Strict JSON Schema validation via Ajv using:
  - `docs/schemas/scp.quote-request.v1.schema.json`
  - `docs/schemas/scp.quote-response.v1.schema.json`
  - `docs/schemas/scp.ticket.v1.schema.json`
  - `docs/schemas/scp.channel-state.v1.schema.json`
- Signature format is `eth_sign` over JSON digest for ticket draft.
- Uses artifacts from `docs/openapi/pay-eth-scp-v1.yaml` and `docs/schemas/*`.
