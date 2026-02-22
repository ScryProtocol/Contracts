# x402 SCP v1 Implementation Bundle

This bundle provides concrete implementation artifacts for `statechannel-hub-v1`.

## Included Files

1. Solidity interface:
   - `contracts/interfaces/IX402StateChannel.sol`
2. JSON Schemas:
   - `docs/schemas/scp.channel-state.v1.schema.json`
   - `docs/schemas/scp.quote-request.v1.schema.json`
   - `docs/schemas/scp.quote-response.v1.schema.json`
   - `docs/schemas/scp.ticket.v1.schema.json`
   - `docs/schemas/scp.payment-payload.v1.schema.json`
3. HTTP API reference:
   - `docs/openapi/pay-eth-scp-v1.yaml`
4. End-to-end sample:
   - `docs/examples/scp-peer-simple-payment.json`

## How to Use

1. Hub implementers:
   - Implement the API in `docs/openapi/pay-eth-scp-v1.yaml`.
   - Validate inbound payloads with the JSON schemas.
   - Sign tickets and publish verification key metadata at `/.well-known/x402`.
2. Agent wallet implementers:
   - Build quote requests from `scp.quote-request.v1.schema.json`.
   - Enforce local fee cap (`maxFee`) before signing state updates.
   - Produce payment retry payload from `scp.payment-payload.v1.schema.json`.
3. Payee or peer receivers:
   - Verify ticket signatures and expiry.
   - Enforce idempotency on `paymentId`.
   - Optionally call hub payment status endpoint for live confirmation.
4. Contract implementers:
   - Implement ABI compatibility with `IX402StateChannel`.
   - Enforce highest nonce wins and challenge window safety.

## Recommended Validation Order (Payment Retry)

1. Validate payload schema.
2. Validate `scheme == statechannel-hub-v1`.
3. Verify ticket signature and ticket expiry.
4. Verify `ticket.amount` and `invoiceId` match required payment.
5. Verify `paymentId` has not already been consumed.
6. Verify channel proof signature and nonce freshness if local policy requires it.

## Peer Simple Support

The same artifacts support peer-to-peer payments:

1. Receiver identity replaces storefront payee.
2. `paymentMemo` may be used in quote context.
3. 402 challenge is optional; direct quote-and-submit flow is allowed.

## Notes

1. This bundle defines wire compatibility and interface contracts only.
2. It does not include a full deployed hub or channel contract implementation.
