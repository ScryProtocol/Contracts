# SCP Payee + E2E Demo

This folder provides a runnable payee verifier and end-to-end payment demo:

- `payee-server.js`: resource server with x402 `402` challenge and ticket verification
- `demo-e2e.js`: spins up hub + payee and executes a full payment

## Run Payee

```bash
node node/scp-demo/payee-server.js
```

## Run End-to-End Demo

```bash
node node/scp-demo/demo-e2e.js
```

Expected output includes:

```text
e2e ok
```

## Verification Checks in Payee

1. Requires `PAYMENT-SIGNATURE` retry header.
2. Verifies hub ticket signature.
3. Verifies ticket signer against advertised hub key(s) from one or more hub endpoints.
4. Verifies `payee`, `invoiceId`, `paymentId`, `amount`, and expiry.
5. Verifies hub payment status is `issued` for the payment id.

## Pay Mode

- `PAYEE_PAYMENT_MODE` or `PAYMENT_MODE`:
  - `per_request` (default): paid proof required on each protected request.
  - `pay_once`: paid proof required once, then reuse `x-scp-access-token` (or `scp_access` cookie) for the same path.
- `PAYEE_PAY_ONCE_TTL_SEC` or `PAY_ONCE_TTL_SEC` controls access token lifetime (default `86400`).
- `PAYEE_REPLAY_STORE_PATH` (optional) enables file-backed replay cache persistence.
- `PAYEE_REPLAY_TTL_SEC` sets replay cache retention seconds (default `2592000`).
- `PAYEE_REPLAY_MAX_ENTRIES` sets replay cache max records (default `50000`).

## Multi-Hub Offer Config

If a route advertises multiple hub endpoints in `routes[].accepts[].hub`, the payee verifier now accepts and confirms any of those hubs automatically (instead of assuming only `HUB_URL`).

When `PERF_MODE=1` (which sets `confirmHub=false` internally), verifier now fails closed if hub signer identity cannot be resolved from configured hub metadata.
