# Meow API (Paid `/meow`)

Standalone paid API that protects `GET /meow` with `statechannel-hub-v1`.

Price is fixed to `0.0000001 ETH` by default.

## Run

```bash
node node/meow-api/server.js
```

Required env:

- `PAYEE_PRIVATE_KEY`

Optional env:

- `HOST` (default `127.0.0.1`)
- `PORT` (default `4090`)
- `NETWORK` (default `base`)
- `HUB_NAME` (default `pay.eth`)
- `HUB_ENDPOINT` (default `http://127.0.0.1:4021`)
- `MEOW_PRICE_ETH` (default `0.0000001`)
- `MEOW_STREAM_T_SEC` or `STREAM_T_SEC` (default `5`; emitted as `extensions["statechannel-hub-v1"].stream.t`)
- `MEOW_PAYMENT_MODE` or `PAYMENT_MODE` (`per_request` default, `pay_once` to unlock `/meow` per access token)
- `MEOW_PAY_ONCE_TTL_SEC` or `PAY_ONCE_TTL_SEC` (default `86400`)

## Endpoints

- `GET /health`
- `GET /meow` (returns 402 challenge when unpaid)
