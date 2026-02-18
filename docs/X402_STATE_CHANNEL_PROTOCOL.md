# x402 State Channel Protocol (SCP)

Status: Draft  
Version: `0.1.0`  
Target: EVM chains + HTTP `402 Payment Required` flows

## 1. Goal

Define a state-channel protocol that makes x402-style pay-per-request cheap and fast:

- One on-chain lock (deposit).
- Many off-chain signed payment updates.
- On-chain settlement only when closing or disputing.

## 2. Roles

- `Client`: pays for protected resources.
- `Provider`: serves protected resources.
- `Arbiter`: on-chain settlement contract.
- `Watcher` (optional): monitors chain and submits disputes.

## 3. Core Objects

### 3.1 Channel

```text
channelId = keccak256(
  chainId,
  arbiterAddress,
  client,
  provider,
  token,
  openNonce
)
```

Fields:

- `client`, `provider`
- `token` (`address(0)` for native ETH)
- `clientDeposit`, `providerDeposit` (provider deposit optional)
- `challengePeriod` (seconds)
- `expiry` (unix timestamp, optional)
- `status`: `OPEN | CLOSING | CLOSED`

### 3.2 State

Each signed state is monotonic:

- `channelId`
- `version` (`uint64`, strictly increasing)
- `clientSpent` (`uint256`, cumulative owed to provider)
- `providerCredit` (`uint256`, optional cumulative owed to client)
- `stateExpiry` (optional)
- `metadataHash` (optional request-bundle commitment)

Invariant:

- `clientSpent <= clientDeposit`
- If `providerCredit` used: `providerCredit <= providerDeposit`

## 4. Cryptographic Format

Use EIP-712 typed data signatures.

Domain:

- `name`: `x402-state-channel`
- `version`: `1`
- `chainId`
- `verifyingContract`: `Arbiter`

Primary type:

```solidity
State(
  bytes32 channelId,
  uint64 version,
  uint256 clientSpent,
  uint256 providerCredit,
  uint64 stateExpiry,
  bytes32 metadataHash
)
```

Rules:

- Provider can accept one-sided client signatures for simple streaming.
- Cooperative close requires both signatures on same state.
- Dispute can be answered with higher valid `version`.

## 5. HTTP/x402 Integration

### 5.1 New Request Without Channel

Provider responds:

- `HTTP 402 Payment Required`
- `X402-Method: state-channel`
- `X402-Chain-Id`
- `X402-Arbiter`
- `X402-Token`
- `X402-Price` (base unit, e.g. wei)
- `X402-Channel-Terms` (base64url JSON)

Client opens channel on-chain or uses an existing compatible one.

### 5.2 Paid Request With Channel

Client sends:

- `X402-Channel-Id`
- `X402-State` (base64url JSON state)
- `X402-Signature` (client sig)

Provider verifies and serves response on success.
Provider may return:

- `X402-Ack-Version`
- `X402-Next-Price` (optional dynamic pricing)

### 5.3 Insufficient Value

If state does not cover price:

- `HTTP 402`
- `X402-Required-Total` (new cumulative `clientSpent` required)

## 6. Protocol Lifecycle

### 6.1 Open

1. Client calls `openChannel(...)` in `Arbiter` with deposit and terms.
2. Arbiter emits `ChannelOpened(channelId, ...)`.
3. Client can start sending signed states.

### 6.2 Update (Off-chain)

1. For each payable action, client computes:
   - `nextClientSpent = prevClientSpent + price`
   - `version = prevVersion + 1`
2. Client signs new state and attaches it to request.
3. Provider stores latest valid state per channel.

### 6.3 Cooperative Close

1. Either party proposes latest state.
2. Other party countersigns same state.
3. Submit `cooperativeClose(state, sigClient, sigProvider)`.
4. Arbiter settles immediately and marks closed.

### 6.4 Unilateral Close + Challenge

1. Closer submits `startClose(state, sigClient)` or dual-signed state.
2. Arbiter sets `closeDeadline = now + challengePeriod`.
3. Counterparty may call `challenge(newerState, sig...)` with higher version.
4. After deadline, anyone calls `finalizeClose(channelId)`.

### 6.5 Settle

At finalize:

- Provider receives `clientSpent`.
- Client receives `clientDeposit - clientSpent`.
- If provider deposit lane used, symmetric logic applies.

## 7. Smart Contract Interface (Minimal)

```solidity
function openChannel(
  address provider,
  address token,
  uint256 clientDeposit,
  uint256 providerDeposit,
  uint64 challengePeriod,
  uint64 expiry,
  bytes32 openNonce
) external payable returns (bytes32 channelId);

function cooperativeClose(
  State calldata state,
  bytes calldata sigClient,
  bytes calldata sigProvider
) external;

function startClose(
  State calldata state,
  bytes calldata sigClient
) external;

function challenge(
  State calldata newerState,
  bytes calldata sigClient
) external;

function finalizeClose(bytes32 channelId) external;
```

Events:

- `ChannelOpened`
- `CloseStarted`
- `Challenged`
- `ChannelClosed`

## 8. Validation Rules

Provider must reject request if any are false:

- Channel exists and status is `OPEN` or valid `CLOSING`.
- Signature recovers `client`.
- `version` is strictly greater than previously accepted version.
- `clientSpent` is monotonic and sufficient for the requested price.
- `stateExpiry == 0 || now <= stateExpiry`.
- Replay protection: `(channelId, version)` unused.

## 9. Recovery and Safety

- Provider should checkpoint latest state in durable storage.
- Client should store all sent states and provider receipts.
- Watchers should auto-challenge stale close attempts.
- Recommended `challengePeriod`: 1 to 7 days.
- Use session keys only with explicit delegated spend caps.

## 10. Optional Extensions

- Multi-resource bundle settlement via `metadataHash`.
- Batched acknowledgements (`X402-Ack-Batch`).
- Intent-based pre-authorization (`maxVersion`, `maxSpend` window).
- Sponsored channels (third-party funder as `client` delegate).
- Cross-domain identity binding (DID or TLS cert hash in metadata).
- Routed hub payments: `A -> pay.eth -> B` (single payer channel, many recipients).

## 11. Routed Hub Mode (`A -> pay.eth -> B`)

Goal: `A` opens one channel to `pay.eth` and can pay any service `B` registered in `pay.eth`.

### 11.1 Participants

- `A`: payer client.
- `pay.eth`: settlement hub (channel counterparty on-chain).
- `B`: merchant/service beneficiary inside hub namespace.

### 11.2 Model

- On-chain channel exists between `A` and `pay.eth` only.
- Off-chain payment state includes a beneficiary (`B`) and route authorization.
- `pay.eth` is responsible for crediting/settling with `B` off-chain or on its own rails.

### 11.3 Additional State Fields

In routed mode, `metadataHash` MUST commit to:

- `beneficiary` (`B` address or canonical merchant id),
- `resource` (optional endpoint/product id),
- `quoteId` (provider quote commitment),
- `hubNonce` (anti-replay under hub namespace).

Suggested commitment:

```text
metadataHash = keccak256(
  beneficiary,
  resource,
  quoteId,
  hubNonce
)
```

### 11.4 HTTP Fields (Routed)

Provider `B` challenge:

- `X402-Method: state-channel`
- `X402-Hub: pay.eth`
- `X402-Beneficiary: <B-id>`
- `X402-Quote-Id: <quote>`

Client payment:

- `X402-Channel-Id` (channel with `pay.eth`)
- `X402-State`
- `X402-Signature`
- `X402-Beneficiary`
- `X402-Quote-Id`

`B` forwards to `pay.eth` verifier API. Hub validates signature/state and returns authorization result.

### 11.5 Verification Rules

Hub MUST verify:

- channel counterparty is `pay.eth`,
- state monotonicity and spend coverage,
- `metadataHash` binds the same `beneficiary` and `quoteId`,
- quote validity window not expired,
- `hubNonce` unused for `(channelId, beneficiary)`.

`B` MUST verify:

- hub attestation/JWT or signed approval from `pay.eth`,
- `beneficiary` in approval matches itself,
- amount/quote/resource match request.

### 11.6 Signature Chain (`A owes pay.eth`, `pay.eth owes B`)

Use two signed obligations:

1. `ClientState` signed by `A` (already defined in this spec): proves cumulative amount owed by `A` to `pay.eth`.
2. `HubReceipt` signed by `pay.eth`: proves amount credited/owed by `pay.eth` to `B` for this request.

Suggested `HubReceipt` typed data:

```solidity
HubReceipt(
  bytes32 channelId,
  uint64 clientVersion,
  address beneficiary,
  bytes32 quoteId,
  uint256 amount,
  uint64 receiptExpiry,
  bytes32 requestHash
)
```

`B` accepts payment only if all checks pass:

- `sigA` over `ClientState` is valid and channel counterparty is `pay.eth`.
- `sigHub` over `HubReceipt` is from hub signing key for `pay.eth`.
- `HubReceipt.channelId == ClientState.channelId`.
- `HubReceipt.clientVersion == ClientState.version`.
- `HubReceipt.beneficiary == B`.
- `HubReceipt.quoteId`/`amount`/`requestHash` match the current request.
- `receiptExpiry` valid and receipt id not replayed.

### 11.7 Trust + Risk

- `A` trusts `pay.eth` as routing/settlement operator.
- `B` takes hub credit risk, not direct `A` on-chain risk, unless using direct-close proofs accepted by `pay.eth`.
- Dispute on chain remains only between `A` and `pay.eth`.

### 11.8 Dual-Channel Variant (`B` also has a channel)

If `B` also uses a channel, run two independent channels:

- upstream: `A <-> pay.eth`
- downstream: `pay.eth <-> B`

Flow:

1. `A` sends signed `ClientState` for upstream channel.
2. `pay.eth` validates and updates its upstream ledger.
3. `pay.eth` issues signed `HubReceipt` for `B`.
4. `B` countersigns or accepts and updates downstream channel state with `pay.eth`.

Required bindings:

- `HubReceipt` MUST include both `upstreamChannelId` and `downstreamChannelId`.
- `HubReceipt.amount` MUST equal the credited delta on downstream update.
- `HubReceipt.beneficiary` MUST map to the downstream channel counterparty (`B`).
- `quoteId` and `requestHash` MUST match across upstream proof and downstream credit.

Settlement:

- `A <-> pay.eth` settles per base SCP rules.
- `pay.eth <-> B` settles per base SCP rules.
- No direct on-chain claim by `B` against `A` in this variant.

## 12. Reference State JSON (wire)

```json
{
  "channelId": "0x8b...f2",
  "version": 42,
  "clientSpent": "1250000000000000",
  "providerCredit": "0",
  "stateExpiry": 0,
  "metadataHash": "0x0000000000000000000000000000000000000000000000000000000000000000"
}
```

## 13. Interop Profile: `scp-basic-1`

A minimal interoperable profile:

- One-way value flow (`providerCredit = 0`).
- Client-only signed updates.
- Cooperative close optional, unilateral close required.
- Single token per channel.
- EIP-712 required.

This profile is the recommended first implementation for x402 services.

## 14. Interop Profile: `scp-hub-1`

For `A -> pay.eth -> B`:

- Requires `scp-basic-1` compatibility.
- Requires `X402-Hub` and `X402-Beneficiary`.
- Requires `metadataHash` beneficiary/quote binding.
- Hub-signed authorization to beneficiary is required per request.

## 15. Interop Profile: `scp-hub-dual-1`

For routed payments where `B` also runs a settlement channel:

- Requires `scp-hub-1`.
- Requires distinct upstream/downstream channel ids in hub receipt.
- Requires downstream credit amount to exactly match hub receipt amount.
- Requires quote/request binding equality across both legs.
