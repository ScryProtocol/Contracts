# x402 State Channel Protocol (SCP)

Status: Draft
Version: `1.2.0-draft`
Applies to: x402 HTTP payment flow, EVM-compatible chains, ETH and ERC-20 assets

## 1. Abstract

This document specifies a hub-routed, bidirectional state channel protocol for x402 payments where a payer agent `A` opens one channel with a hub `H` (for example `pay.eth`) and uses that channel to pay many payees `B1..Bn`.

The protocol supports:

- `A -> H -> B` multiplexed payments (single channel, many payees).
- `A -> B` direct channel payments (hub optional).
- ETH and ERC-20 settlement lanes.
- Two-way value movement (payments, refunds, rebates, reverse payouts).
- Optional hub fees with transparent fee bounds.
- x402-compatible HTTP integration through `402` challenge and retry.

This is a normative protocol specification. Keywords `MUST`, `MUST NOT`, `SHOULD`, `MAY` are to be interpreted as described in RFC 2119.

## 2. Design Goals

1. Keep payee integration simple: payee continues using x402 `402` challenge and payment retry.
2. Minimize onchain operations: open/deposit/close onchain, high-frequency updates offchain.
3. Protect agents with bounded risk: spend caps, nonce monotonicity, explicit fee ceilings.
4. Allow bidirectional netting between `A` and `H`.
5. Support interoperability across wallets, agent frameworks, and payee gateways.

## 3. Non-Goals

1. Decentralized multi-hop routing across arbitrary hubs (out of scope for v1).
2. Full trustless payee settlement in proxy mode (v1 assumes hub accountability).
3. Full privacy against hub and payee correlation.

## 4. Entities and Roles

1. `A` (Agent/Payer): LLM agent wallet that buys resources.
2. `H` (Hub): channel counterparty for `A`, routes payments to payees, may charge fee.
3. `B` (Payee): resource server protected by x402.
4. `C` (Channel Contract): onchain adjudicator for `A <-> H` (and `H <-> B`). Generic two-party contract; multiple hubs share one deployment.
5. `F` (Facilitator/Verifier): optional service validating tickets and signatures.

## 5. Trust and Risk Model

### 5.1 Proxy Hold Mode (`proxy_hold`)

In v1 default mode, `B` accepts a hub-issued settlement ticket. `B` trusts that `H` will settle according to ticket terms.

- `A` trust: bounded by signed debit and `maxFee`.
- `B` trust: bounded by hub signature validity, ticket expiry, and hub credit policy.
- `H` trust: protected by valid channel updates proving `A` debit authorization.

### 5.2 Future: Conditional Mode

A future version may introduce lock-based conditional claims (e.g. hash-time-locked) to reduce trust in `H`. This is out of scope for v1.

## 6. Identifiers

- `channelId`: unique channel key.
- `invoiceId`: payee quote instance.
- `paymentId`: idempotency key for a single payment attempt.
- `ticketId`: hub-issued payee settlement promise.
- `stateNonce`: strict monotonic channel sequence number.

All identifiers MUST be unique in their namespace. UUIDv7 or 32-byte random values are RECOMMENDED.

## 7. x402 Scheme Registration

Payees using this protocol MUST advertise one or more schemes:

- `scheme = "statechannel-hub-v1"`
- `scheme = "statechannel-direct-v1"`

Example `402` body fragment:

```json
{
  "accepts": [
    {
      "scheme": "statechannel-hub-v1",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913",
      "maxAmountRequired": "1000000",
      "payTo": "pay.eth",
      "resource": "https://payee.example/v1/data",
      "extensions": {
        "statechannel-hub-v1": {
          "hubName": "pay.eth",
          "hubEndpoint": "https://pay.eth/.well-known/x402",
          "mode": "proxy_hold",
          "feeModel": {
            "base": "10",
            "bps": 30
          },
          "quoteExpiry": 1770000000
        }
      }
    },
    {
      "scheme": "statechannel-direct-v1",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913",
      "maxAmountRequired": "1000000",
      "payTo": "0xPayee...",
      "resource": "https://payee.example/v1/data",
      "extensions": {
        "statechannel-direct-v1": {
          "mode": "direct",
          "invoiceId": "01J...",
          "quoteExpiry": 1770000000,
          "payeeAddress": "0xPayee..."
        }
      }
    }
  ]
}
```

## 8. Core Data Structures

### 8.1 Channel Terms

```json
{
  "channelId": "0x...",
  "chainId": 8453,
  "asset": "0x0000000000000000000000000000000000000000",
  "participantA": "0xA...",
  "participantB": "0xH...",
  "challengePeriodSec": 86400,
  "channelExpiry": 1771000000
}
```

### 8.2 Channel State (Offchain)

```json
{
  "channelId": "0x...",
  "stateNonce": 42,
  "balA": "993000000000000000",
  "balB": "7000000000000000",
  "locksRoot": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "stateExpiry": 1770000100,
  "contextHash": "0x..."
}
```

Rules:

1. `stateNonce` MUST strictly increase by 1 per accepted update.
2. `balA + balB` MUST equal total channel balance for this asset lane.
3. `contextHash` SHOULD commit to `{payee, resource, method, invoiceId, paymentId}` for audit binding.
4. A state with expired `stateExpiry` MUST be rejected.

### 8.3 Hub Ticket (Payee Settlement Promise)

```json
{
  "ticketId": "01J...",
  "hub": "0xH...",
  "payee": "0xB...",
  "invoiceId": "01J...",
  "paymentId": "01J...",
  "asset": "0x...",
  "amount": "1000000",
  "feeCharged": "3010",
  "totalDebit": "1003010",
  "expiry": 1770000150,
  "policyHash": "0x..."
}
```

`H` MUST sign this ticket with an advertised key.

## 9. Cryptography

### 9.1 Signature Scheme

- Implementations MUST support at least one of:
  1. `eip712` (RECOMMENDED for production).
  2. `eth_sign` compatibility profile over the canonical state hash.
- Hub ticket MAY use EIP-712 or JWS, but format MUST be explicit in hub metadata.
  1. Current reference implementation uses `eth_sign` style signatures for both channel state and ticket draft.

### 9.2 Domain Separation

State domain MUST include:

1. `name = "x402-statechannel-hub"`
2. `version = "1"`
3. `chainId`
4. `verifyingContract = C`

### 9.3 Replay Protection

Replay safety MUST include all of:

1. `channelId`
2. `stateNonce`
3. `chainId`
4. `contextHash` or equivalent request binding

## 10. Protocol Flows

### 10.1 Discovery

1. `A -> B`: unauthenticated request.
2. `B -> A`: `HTTP 402` containing one or more SCP offers (`statechannel-hub-v1`, `statechannel-direct-v1`).
3. `A` verifies network and asset policy, then chooses route policy (`hub`, `direct`, or `auto`).

### 10.2 Ticket and Debit Authorization

1. `A -> H`: `POST /v1/tickets/quote` with `{invoiceId, amount, payee, asset}`.
2. `H -> A`: quote `{fee, totalDebit, expiry, ticketDraft}`.
3. `A` verifies `fee <= maxFee`.
4. `A` creates next channel state debiting `totalDebit` from `balA` to `balB`.
5. `A -> H`: signed state update.
6. `H` validates and responds with signed `ticket` and `channelAck`.

### 10.3 Payee Payment Submission

1. `A -> B`: retry request with payment header carrying:
   - `paymentId`
   - hub `ticket`
   - signed channel state proof (or reference)
2. `B` verifies ticket signature, expiry, invoice binding, amount, and optional revocation status.
3. `B -> A`: resource response plus payment receipt.

### 10.4 Refund / Reverse Transfer

1. `B` decides refund amount.
2. `B -> H`: refund request bound to `ticketId`.
   - v1 wire fields: `{ ticketId, refundAmount, reason }`
3. `H` issues reverse channel update crediting `A`.
4. `H -> A`: signed refund receipt with new `stateNonce`.

### 10.5 Channel Closure

1. Cooperative close: both sides sign same final state; immediate settlement.
2. Unilateral close: submit latest known state, wait challenge window.
3. Challenge: counterparty submits higher valid nonce.
4. Finalize: highest valid state wins.

### 10.6 Channel State Machine

```
  openChannel()
       │
       ▼
   ┌────────┐  cooperativeClose()   ┌────────┐
   │  OPEN  │──────────────────────►│ CLOSED │
   └────────┘                       └────────┘
       │                                 ▲
       │ startClose()                    │ finalizeClose()
       ▼                                 │  (after deadline)
   ┌─────────┐  challenge()         ┌────────────┐
   │ CLOSING │─────────────────────►│ CHALLENGED │
   └─────────┘                      └────────────┘
       │                                 │
       │  finalizeClose()                │ challenge()
       │  (after deadline)               │ (higher nonce replaces)
       ▼                                 ▼
   ┌────────┐                       ┌────────────┐
   │ CLOSED │                       │ CHALLENGED │ (updated state)
   └────────┘                       └────────────┘
```

| From | Event | To | Condition |
|------|-------|----|-----------|
| — | `openChannel()` | `OPEN` | Valid deposit and params |
| `OPEN` | Off-chain state updates | `OPEN` | `stateNonce` strictly increases; `balA + balB` preserved |
| `OPEN` | `cooperativeClose(state, sigA, sigB)` | `CLOSED` | Both signatures valid; immediate settlement |
| `OPEN` | `startClose(state, sigCounterparty)` | `CLOSING` | Valid counterparty sig; sets `deadline = now + challengePeriod` |
| `CLOSING` | `challenge(newerState, sigCounterparty)` | `CHALLENGED` | `newerState.nonce > currentState.nonce`; `deadline` unchanged |
| `CHALLENGED` | `challenge(newerState, sigCounterparty)` | `CHALLENGED` | Higher nonce replaces again; `deadline` unchanged |
| `CLOSING` | `finalizeClose(channelId)` | `CLOSED` | `now >= deadline`; settles on-chain per last accepted state |
| `CHALLENGED` | `finalizeClose(channelId)` | `CLOSED` | `now >= deadline`; settles on-chain per highest challenged state |

Rules:

1. `CLOSED` is terminal — no further transitions.
2. Challenge does NOT reset the deadline. The original `challengePeriod` from `startClose` governs.
3. Multiple `challenge()` calls are valid as long as each provides a strictly higher nonce.
4. `cooperativeClose` is only valid from `OPEN` — once unilateral close starts, the challenge window must play out.

## 11. Fee Model

### 11.1 Formula

`fee = base + floor(amount * bps / 10000) + gasSurcharge`

Where:

- `base`: fixed integer minor units.
- `bps`: basis points.
- `gasSurcharge`: optional, explicit in quote.

### 11.2 Constraints

1. `A` MUST set `maxFee` per payment request.
2. `H` MUST NOT settle a debit where `fee > maxFee`.
3. Quote and ticket MUST contain full fee breakdown.
4. Fee asset defaults to payment asset; mixed-asset fee is out of scope for v1.

## 12. HTTP Binding

### 12.1 Required Payee `402` Fields

1. `scheme = statechannel-hub-v1` or `scheme = statechannel-direct-v1`
2. `network`
3. `asset`
4. `payTo` (hub identity for hub route, payee identity for direct route)
5. protocol extension blob for this spec

### 12.2 Payment Retry Header Payload

Header name SHOULD remain compatible with x402 (`PAYMENT-SIGNATURE` or implementation equivalent). Payload MUST include:

```json
{
  "scheme": "statechannel-hub-v1",
  "paymentId": "01J...",
  "invoiceId": "01J...",
  "ticket": {
    "...": "...",
    "sig": "0x..."
  },
  "channelProof": {
    "channelId": "0x...",
    "stateNonce": 42,
    "stateHash": "0x...",
    "sigA": "0x..."
  }
}
```

### 12.3 Hub Issue Ack (`/v1/tickets/issue`)

Hub response MAY include:

```json
{
  "channelAck": {
    "stateNonce": 42,
    "stateHash": "0x...",
    "sigB": "0x..."
  }
}
```

`sigB` SHOULD be persisted by the payer for challenge-watch proofs.

### 12.4 Direct Scheme Retry Payload (`statechannel-direct-v1`)

```json
{
  "scheme": "statechannel-direct-v1",
  "paymentId": "01J...",
  "invoiceId": "01J...",
  "direct": {
    "payer": "0xA...",
    "payee": "0xB...",
    "asset": "0x...",
    "amount": "1000000",
    "expiry": 1770000100,
    "invoiceId": "01J...",
    "paymentId": "01J...",
    "channelState": {
      "...": "..."
    },
    "sigA": "0x..."
  }
}
```

### 12.5 Payee Receipt

Payee response SHOULD include receipt metadata:

```json
{
  "paymentId": "01J...",
  "receiptId": "01J...",
  "acceptedAt": 1770000101,
  "ticketId": "01J..."
}
```

For direct route, receipt MAY use:

```json
{
  "paymentId": "01J...",
  "receiptId": "01J...",
  "acceptedAt": 1770000101,
  "directChannelId": "0x..."
}
```

## 13. Smart Contract Requirements (C)

The contract (`X402StateChannel`) is a generic two-party state channel. It has no concept of "hub" — any address pair (`A`, `B`) can open a channel. This means multiple hubs can share one deployed contract, and non-hub use cases (direct A-to-B channels) use the same contract.

Minimum interface:

```solidity
function openChannel(
  address participantB,
  address asset,
  uint256 amount,
  uint64 challengePeriodSec,
  uint64 expiry,
  bytes32 salt
) external payable returns (bytes32 channelId);

function deposit(bytes32 channelId, uint256 amount) external payable;

function cooperativeClose(
  ChannelState calldata st,
  bytes calldata sigA,
  bytes calldata sigB
) external;

function startClose(
  ChannelState calldata st,
  bytes calldata sigFromCounterparty
) external;

function challenge(
  ChannelState calldata newer,
  bytes calldata sigFromCounterparty
) external;

function finalizeClose(bytes32 channelId) external;
```

Contract invariants:

1. Highest valid `stateNonce` MUST determine settlement.
2. Challenge period MUST be enforced.
3. Channel asset MUST be immutable after open.
4. Reentrancy-safe withdraw logic is REQUIRED.

## 14. Agent Wallet Policy Requirements

Implementations for AI agents SHOULD enforce:

1. Per-domain spend cap.
2. Per-session spend cap.
3. Allowed chain and token allowlist.
4. Human-approval threshold above configurable amount.
5. Durable nonce/state persistence across restarts.
6. Idempotent `paymentId` generation and retry semantics.
7. Route policy: `hub`, `direct`, or `auto`.
8. Route fallback policy (for example `direct -> hub`) with explicit user limits.

## 15. Error Model

Standardized codes:

1. `SCP_001_UNSUPPORTED_ASSET`
2. `SCP_002_QUOTE_EXPIRED`
3. `SCP_003_FEE_EXCEEDS_MAX`
4. `SCP_004_INVALID_TICKET_SIG`
5. `SCP_005_NONCE_CONFLICT`
6. `SCP_006_STATE_EXPIRED`
7. `SCP_007_CHANNEL_NOT_FOUND`
8. `SCP_008_CHALLENGE_WINDOW_OPEN`
9. `SCP_009_POLICY_VIOLATION`

Errors SHOULD include machine-readable details and retryability hints.

## 16. Security Considerations

1. All signed objects MUST include expiry.
2. `A` MUST bind debit authorization to payee and resource context.
3. `B` MUST verify ticket not expired and not already consumed where single-use policy applies.
4. `H` SHOULD publish signing key rotation metadata and overlap windows.
5. Implementations MUST handle chain reorg safety when observing onchain closure events.
6. Watcher services SHOULD monitor close events and auto-submit highest state on behalf of owners.
7. For direct route, payee MUST validate:
   1. signer recovery (`sigA`) equals claimed payer.
   2. direct channel nonce monotonicity.
   3. balance delta is at least requested payment amount.
8. Payer and hub SHOULD persist watcher proof material:
   1. latest channel state.
   2. counterparty signature (`sigB` for payer, `sigA` for hub).

## 17. Privacy Considerations

1. Hub observes payer-payee graph in proxy mode.
2. Payers SHOULD use scoped channel identities to reduce linkability.
3. Payees SHOULD avoid including sensitive plaintext in signed contexts.

## 18. Conformance Profiles

### 18.1 Profile P0 (MVP)

1. `proxy_hold` only.
2. One asset per channel.
3. Basic fee formula.
4. Cooperative/unilateral close and challenge.

### 18.2 Profile P1

1. Multi-asset lanes.
2. Refund and partial-fill standardization.
3. Payee-side revocation checks.

### 18.3 Profile P2

1. Multi-hub discovery and route preference.
2. Conditional claim mode (deferred — not specified in v1).

### 18.4 Profile P3 (`direct`)

1. Supports `statechannel-direct-v1`.
2. Payee verifies direct signed state and nonce monotonicity.
3. Agent supports route selection and optional direct-first fallback.

## 19. Reference API Surface (Hub)

Recommended endpoints:

1. `GET /.well-known/x402`
2. `POST /v1/tickets/quote`
3. `POST /v1/tickets/issue`
4. `POST /v1/refunds`
5. `GET /v1/payments/{paymentId}`
6. `GET /v1/channels/{channelId}`

`/.well-known/x402` SHOULD publish:

1. supported modes
2. assets
3. keyset and signature algorithm
4. fee policy
5. max quote TTL

Reference implementation currently also exposes:

1. `GET /v1/payee/inbox?payee=0x...&since=...&limit=...`
2. `GET /v1/payee/balance?payee=0x...`
3. `GET /v1/payee/channel-state?payee=0x...`
4. `POST /v1/payee/settle`
5. `POST /v1/hub/open-payee-channel`
6. `POST /v1/hub/register-payee-channel`
7. `GET /v1/agent/summary?channelId=0x...`

## 20. Async Notifications (Webhooks)

The core protocol is request-response, but several events happen asynchronously and require out-of-band notification.

### 20.1 Event Types

| Event | Source | Recipient | Description |
|-------|--------|-----------|-------------|
| `channel.close_started` | Chain / Watcher | `A`, `H` | Counterparty submitted `startClose` on-chain |
| `channel.challenged` | Chain / Watcher | `A`, `H` | Higher nonce submitted during challenge window |
| `channel.closed` | Chain / Watcher | `A`, `H` | Channel finalized and settled |
| `payment.refunded` | `H` | `A` | Hub issued a reverse transfer crediting `A` |
| `payment.received` | `H` | `B` | New ticket credited to payee's hub balance |
| `balance.low` | `H` | `A` | Agent's channel balance below threshold |

### 20.2 Delivery

Implementations SHOULD support at least one of:

1. **Webhook (RECOMMENDED)**: Hub sends `POST` to a URL registered by the subscriber. Payload is JSON with `{ event, timestamp, data }`. Hub MUST retry with exponential backoff on `5xx` or timeout. Hub MUST include an HMAC signature header (`X-SCP-Signature`) so the receiver can verify authenticity.

2. **Polling**: Subscriber calls `GET /v1/events?since={cursor}&channelId={channelId}`. Hub returns ordered event list. This is the fallback for clients that cannot receive inbound HTTP.
   - Reference implementation also accepts `channel` as an alias for `channelId`.

3. **WebSocket**: Hub accepts `ws` upgrade on `/v1/events/stream`. Hub pushes events as JSON frames. Client sends `subscribe` messages to filter by channel or event type.

### 20.3 Webhook Registration

```
POST /v1/webhooks
{
  "url": "https://agent.example/hooks/scp",
  "events": ["channel.close_started", "payment.refunded", "balance.low"],
  "channelId": "0x...",
  "secret": "shared-hmac-secret"
}
```

Hub responds with `{ webhookId, status: "active" }`. Subscriber MAY update or delete via `PATCH /v1/webhooks/{id}` and `DELETE /v1/webhooks/{id}`.

### 20.4 Payload Format

```json
{
  "event": "channel.close_started",
  "timestamp": 1770000200,
  "webhookId": "wh_abc123",
  "data": {
    "channelId": "0x...",
    "submittedBy": "0xCounterparty...",
    "stateNonce": 42,
    "deadline": 1770086600
  }
}
```

### 20.5 Requirements

1. Hub MUST deliver events in causal order per channel.
2. Hub MUST deduplicate by `(event, channelId, stateNonce)` — receiver may see the same event at most once per delivery attempt.
3. Receiver MUST respond `200` within 5 seconds or hub will retry.
4. Hub SHOULD cap retries at 5 attempts over 1 hour, then mark webhook as `failing`.
5. Watcher-originated events (on-chain) SHOULD include `txHash` and `blockNumber` in `data`.

## 21. Example End-to-End

1. Agent opens channel with `pay.eth` on Base with USDC.
2. Agent accesses `B1`, gets `402`, receives invoice.
3. Agent obtains quote from `H`, approves fee, signs new state nonce 101.
4. Hub issues ticket for `B1`.
5. Agent retries request with ticket and channel proof; `B1` serves.
6. Agent later pays `B2` and `B3` through same channel nonces 102, 103.
7. `B2` issues refund; hub posts reverse transfer at nonce 104.
8. Day-end cooperative close settles net result onchain.

Direct variant:

1. Agent accesses `B`, gets `402` with `statechannel-direct-v1`.
2. Agent signs direct channel state update for `B`.
3. Agent retries with direct payload and `sigA`.
4. Payee verifies signer, nonce, and value delta, then serves response.

## 22. Backward Compatibility

These schemes are additive to x402 and do not alter baseline `402` semantics. Payees MAY offer multiple schemes in `accepts`, allowing wallets to select direct state channel route or hub route.

## 23. Non-Payee and Peer Payment Profile

This protocol MAY be used for simple non-payee transfers (for example person-to-person, agent-to-agent, subscription pull, or reimbursement) without a payee storefront.

### 23.1 Profile `peer_simple`

1. Receiver acts as `B` but MAY be only a wallet endpoint or static identity record.
2. `HTTP 402` challenge is OPTIONAL.
3. `invoiceId` MAY be generated by payer if receiver does not host invoices.
4. `resource` binding MAY be replaced by `paymentMemo` binding.
5. Hub ticket and signed channel state remain REQUIRED.

### 23.2 Minimal Flow

1. `A -> H`: request quote for `{recipient, amount, asset, paymentMemo}`.
2. `H -> A`: quote with `fee`, `totalDebit`, expiry.
3. `A -> H`: signed next state authorizing debit.
4. `H`: issues signed ticket naming recipient as `payee` field value.
5. `A -> recipient endpoint` or `A -> H`: submit ticket for credit notification.
6. Recipient verifies signature or queries `H/F` and marks payment received.

### 23.3 Required Safety

1. `contextHash` MUST include recipient identity and `paymentMemo` (or equivalent).
2. `paymentId` idempotency MUST still be enforced.
3. Receiver acceptance policy MUST define ticket expiry tolerance and replay handling.

## 24. Open Questions (for standardization process)

1. Canonical header field naming for payment retry payload.
2. Single-use vs multi-use ticket policy defaults.
3. Standard revocation endpoint semantics.
4. Cross-chain channel portability model.

## 25. Appendix A: EIP-712 Type Suggestion

```text
ChannelState(
  bytes32 channelId,
  uint64 stateNonce,
  uint256 balA,
  uint256 balB,
  bytes32 locksRoot,
  uint64 stateExpiry,
  bytes32 contextHash
)
```

## 26. Appendix B: `contextHash` Recommendation

`contextHash = keccak256(abi.encode(
  payee,
  resourceUriHash,
  httpMethod,
  invoiceId,
  paymentId,
  amount,
  asset,
  quoteExpiry
))`

This binding reduces replay across payees, routes, and invoices.
