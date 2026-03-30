# addrs-api

Small address-book and CCIP gateway service for `*.hey.eth`.

## What it does

- Reads handle records from the existing Firebase Realtime Database used by `addrs.to`
- Checks whether a handle is available
- Lets an agent claim an unclaimed ENS-safe label for free
- Stores optional ENS text records like `com.twitter`
- Exposes a Sepolia `pay.eth`/hub check endpoint
- Serves CCIP-read responses for `addr()` and basic `text()` lookups under `*.hey.eth`

## Endpoints

- `GET /`
- `GET /docs`
- `GET /health`
- `GET /pay/sepolia`
- `GET /admin/status`
- `GET /check/:handle`
- `GET /info/:handle`
- `GET /info/:handle/:coin`
- `POST /claim`
- `POST /ccip`

## Claim example

```bash
curl -sS http://127.0.0.1:3002/claim \
  -H 'content-type: application/json' \
  --data '{
    "handle": "agent007",
    "owner": "0x1234567890123456789012345678901234567890",
    "texts": {
      "com.twitter": "agent007"
    }
  }'
```

That reserves `agent007.hey.eth` in the Firebase-backed directory and, by default, writes the owner address to `ETH` and `BAL`.

## API discovery

`GET /` and `GET /docs` return an agent-friendly JSON description of the service, including:

- the live zone and Sepolia hub status
- example URLs for handle checks
- the request body shape for `POST /claim`
- the request body shape for `POST /ccip`

## Runtime env

- `HOST`
- `PORT`
- `CORS_ORIGIN`
- `PUBLIC_BASE_URL`
- `ZONE_NAME`
- `ROOT_HANDLE`
- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `FIREBASE_DATABASE_URL`
- `PAY_HUB_SEPOLIA_URL`
- `ENS_RPC_URL`
- `GATEWAY_SIGNER_PRIVATE_KEY`
- `ENABLE_PUBLIC_CLAIMS`

## Deploy shape

This matches the host layout we inspected:

1. Run the service on `127.0.0.1:3002`
2. Point `api.addrs.to` nginx routes `/health`, `/info`, `/admin`, and `/ccip` at `127.0.0.1:3002`
3. Keep `pogchamp.tv /api/*` on `127.0.0.1:3001`

## Important live note

This service can answer CCIP-read requests now, but ENS clients will only use it after `hey.eth` is moved to an offchain-capable resolver on Ethereum mainnet. `GET /admin/status` reports the current owner, resolver, and whether the resolver already supports extended resolution.
