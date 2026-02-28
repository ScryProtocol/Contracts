# x402s — State Channel Protocol (SCP) Specification

**Version:** 2.0.0-draft  
**Status:** Draft  
**Repository:** [github.com/Keychain-Inc/x402s](https://github.com/Keychain-Inc/x402s)  
**License:** MIT  
**Date:** February 2026  
**Keywords:** MUST, MUST NOT, SHOULD, MAY per RFC 2119

---

## Table of Contents

1. [Abstract](#1-abstract)
2. [Motivation](#2-motivation)
3. [Design Goals](#3-design-goals)
4. [Non-Goals](#4-non-goals)
5. [Terminology](#5-terminology)
6. [Architecture Overview](#6-architecture-overview)
7. [Entities and Roles](#7-entities-and-roles)
8. [Trust and Risk Model](#8-trust-and-risk-model)
9. [Identifiers](#9-identifiers)
10. [Supported Networks and Assets](#10-supported-networks-and-assets)
11. [x402 Scheme Registration](#11-x402-scheme-registration)
12. [Core Data Structures](#12-core-data-structures)
13. [Cryptography](#13-cryptography)
14. [Smart Contract Interface](#14-smart-contract-interface)
15. [Protocol Flows](#15-protocol-flows)
16. [Hub HTTP API](#16-hub-http-api)
17. [Payment Header Format](#17-payment-header-format)
18. [Fee Model](#18-fee-model)
19. [Offer Configuration](#19-offer-configuration)
20. [Agent Offer Selection](#20-agent-offer-selection)
21. [Async Notifications (Webhooks)](#21-async-notifications-webhooks)
22. [Challenge Watcher](#22-challenge-watcher)
23. [Peer-to-Peer Payment Profile](#23-peer-to-peer-payment-profile)
24. [Error Codes](#24-error-codes)
25. [Security Considerations](#25-security-considerations)
26. [Privacy Considerations](#26-privacy-considerations)
27. [Conformance Profiles](#27-conformance-profiles)
28. [JSON Schemas](#28-json-schemas)
29. [Deterministic Contract Deployment](#29-deterministic-contract-deployment)
30. [Example End-to-End Flow](#30-example-end-to-end-flow)
31. [Backward Compatibility](#31-backward-compatibility)
32. [Open Questions](#32-open-questions)
33. [Appendices](#33-appendices)

---

## 1. Abstract

x402s is a state-channel-based payment protocol for HTTP `402 Payment Required` flows. It enables high-frequency micropayments between AI agents, APIs, and services without requiring an on-chain transaction for every request. Payments are negotiated via signed off-chain state channel updates and only settle on-chain when channels are opened, funded, disputed, or closed.

The protocol defines two routing modes:

- **Hub-routed** (`statechannel-hub-v1`): Agent opens one channel with a hub (e.g. `pay.eth`) and pays many payees through that single channel.
- **Direct** (`statechannel-direct-v1`): Agent opens a channel directly with each payee, with no intermediary.

x402s is compatible with the broader x402 open standard for internet-native payments, extending it with an off-chain state channel layer for throughput and cost efficiency.

---

## 2. Motivation

On-chain per-request payments for APIs are impractical at scale due to gas costs, confirmation latency, and throughput limitations. x402s addresses this:

- **x402 layer:** APIs respond with `402 Payment Required` and advertise payment offers in the response body.
- **SCP layer:** Payment happens off-chain by signing state channel updates. On-chain settlement occurs only when opening, closing, or disputing channels.
- **Result:** API micropayments at high throughput with minimal on-chain overhead.

---

## 3. Design Goals

1. Keep payee integration simple: payee continues using the x402 `402` challenge-and-retry model.
2. Minimize on-chain operations: open/deposit/close on-chain; high-frequency updates off-chain.
3. Protect agents with bounded risk: spend caps, nonce monotonicity, explicit fee ceilings.
4. Allow bidirectional netting between agent and hub.
5. Support interoperability across wallets, agent frameworks, and payee gateways.

---

## 4. Non-Goals

1. Decentralized multi-hop routing across arbitrary hubs (out of scope for v1).
2. Full trustless payee settlement in proxy mode (v1 assumes hub accountability).
3. Full privacy against hub-payee correlation.

---

## 5. Terminology

| Term | Definition |
|------|-----------|
| **Offer** | Payment options returned by the payee in a `402` response: network, asset, maxAmountRequired, route mode |
| **Quote** | Hub fee calculation and payment draft before issuing a ticket |
| **Channel** | Two-party state channel with balances tracked off-chain and enforceable on-chain |
| **Ticket** | Hub-signed payment authorization used as payment proof by the payee |
| **Payment Proof** | Data attached in the `PAYMENT-SIGNATURE` header on the paid retry request |
| **Receipt** | Payee acknowledgment after accepting payment |
| **State Nonce** | Strictly monotonic sequence number on channel state updates |
| **Challenge Period** | Time window during which a counterparty can dispute a unilateral close with a newer state |

---

## 6. Architecture Overview

### 6.1 Hub-Routed Flow

```
Agent (A)              Hub (H)                   Payee API (B)
  │                      │                            │
  │  GET /resource       │                            │
  │─────────────────────────────────────────────────>│
  │<─────────────── 402 + offers ────────────────────│
  │                      │                            │
  │  POST /v1/tickets/quote                           │
  │─────────────────────>│                            │
  │<──── quote + draft ──│                            │
  │                      │                            │
  │  POST /v1/tickets/issue (signed channel state)    │
  │─────────────────────>│                            │
  │<── ticket + ack ─────│                            │
  │                      │                            │
  │  GET /resource + PAYMENT-SIGNATURE ──────────────>│
  │<──────────────── 200 + receipt ───────────────────│
```

### 6.2 Direct Flow

```
Agent (A)              Payee API (B)
  │                        │
  │  GET /resource         │
  │───────────────────────>│
  │<─── 402 + offers ──────│
  │                        │
  │  (sign direct state)   │
  │                        │
  │  GET /resource + PAYMENT-SIGNATURE
  │───────────────────────>│
  │<──── 200 + receipt ────│
```

---

## 7. Entities and Roles

| Role | Symbol | Description |
|------|--------|-------------|
| **Agent / Payer** | `A` | LLM agent or client wallet that purchases resources. Holds `AGENT_PRIVATE_KEY`. |
| **Hub** | `H` | Channel counterparty for `A`. Routes payments to payees, may charge a fee. Holds `HUB_PRIVATE_KEY`. |
| **Payee** | `B` | Resource server protected by x402. Holds `PAYEE_PRIVATE_KEY`. |
| **Channel Contract** | `C` | On-chain adjudicator (`X402StateChannel.sol`). Generic two-party contract; multiple hubs share one deployment. |
| **Facilitator / Verifier** | `F` | Optional service validating tickets and signatures. |
| **Watcher** | `W` | Service monitoring on-chain close events and auto-submitting challenges with the highest known state. |

---

## 8. Trust and Risk Model

### 8.1 Proxy Hold Mode (`proxy_hold`) — Default in v1

In the default hub-routed mode, `B` accepts a hub-issued settlement ticket. `B` trusts that `H` will settle according to ticket terms.

- **A risk:** Bounded by signed debit and `maxFee`. Agent never authorizes more than `totalDebit` per payment.
- **B risk:** Bounded by hub signature validity, ticket expiry, and hub credit policy.
- **H risk:** Protected by valid channel state updates proving `A`'s debit authorization.

### 8.2 Direct Mode

In direct mode, `B` verifies `A`'s signed channel state directly. `B` has on-chain dispute rights against `A` via the shared channel contract.

### 8.3 Future: Conditional Mode

A future version may introduce lock-based conditional claims (e.g., HTLC) to reduce trust in `H`. Out of scope for v1.

---

## 9. Identifiers

| Identifier | Format | Scope |
|-----------|--------|-------|
| `channelId` | `bytes32` — `keccak256(chainId, contract, A, B, asset, salt)` | Unique per channel |
| `invoiceId` | String (6–128 chars), UUIDv7 recommended | Payee quote instance |
| `paymentId` | String (6–128 chars), UUIDv7 recommended | Idempotency key per payment attempt |
| `ticketId` | String (6–128 chars), UUIDv7 recommended | Hub-issued settlement promise ID |
| `stateNonce` | `uint64`, strictly monotonic | Channel sequence number |

All identifiers MUST be unique within their namespace.

---

## 10. Supported Networks and Assets

### 10.1 Networks

| Name | Chain ID | CAIP-2 |
|------|----------|--------|
| Ethereum Mainnet | 1 | `eip155:1` |
| Base | 8453 | `eip155:8453` |
| Sepolia (testnet) | 11155111 | `eip155:11155111` |
| Base Sepolia (testnet) | 84532 | `eip155:84532` |

### 10.2 Assets

| Chain | Symbol | Address | Decimals |
|-------|--------|---------|----------|
| Ethereum (1) | USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6 |
| Ethereum (1) | USDT | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | 6 |
| Ethereum (1) | ETH | `0x0000...0000` (native) | 18 |
| Base (8453) | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 |
| Base (8453) | USDT | `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` | 6 |
| Base (8453) | ETH | `0x0000...0000` (native) | 18 |
| Sepolia (11155111) | USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | 6 |
| Base Sepolia (84532) | USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | 6 |

`address(0)` (`0x0000000000000000000000000000000000000000`) denotes native ETH.

### 10.3 Contract Deployment

The canonical contract is deployed via deterministic CREATE2 at:

```
0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b
```

This address is identical on Base (8453) and Sepolia (11155111).

---

## 11. x402 Scheme Registration

Payees MUST advertise one or more SCP schemes in their `402` response body:

| Scheme | Route | Description |
|--------|-------|-------------|
| `statechannel-hub-v1` | Hub-routed | Payment goes `A → H → B` |
| `statechannel-direct-v1` | Direct | Payment goes `A → B` directly |

### 11.1 Example 402 Response Body

```json
{
  "accepts": [
    {
      "scheme": "statechannel-hub-v1",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "maxAmountRequired": "1000000",
      "payTo": "pay.eth",
      "resource": "https://payee.example/v1/data",
      "extensions": {
        "statechannel-hub-v1": {
          "hubName": "pay.eth",
          "hubEndpoint": "https://pay.eth/.well-known/x402",
          "mode": "proxy_hold",
          "feeModel": { "base": "10", "bps": 30 },
          "quoteExpiry": 1770000000
        }
      }
    },
    {
      "scheme": "statechannel-direct-v1",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
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

---

## 12. Core Data Structures

### 12.1 Channel State (Off-chain)

The fundamental signed object in SCP. Both parties sign this to authorize balance updates.

```json
{
  "channelId": "0x7a0de7b4...",
  "stateNonce": 42,
  "balA": "998996990",
  "balB": "1003010",
  "locksRoot": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "stateExpiry": 1770000320,
  "contextHash": "0x5f4cf45e..."
}
```

**Invariants:**

1. `stateNonce` MUST strictly increase by 1 per accepted update.
2. `balA + balB` MUST equal the channel's `totalBalance` on-chain.
3. `contextHash` SHOULD commit to `{payee, resource, method, invoiceId, paymentId}` for audit binding.
4. A state with expired `stateExpiry` MUST be rejected.
5. `locksRoot` is reserved for future conditional claim support (`0x00...00` in v1).

**Field types:**

| Field | Type | Description |
|-------|------|-------------|
| `channelId` | `bytes32` (hex string, `^0x[a-fA-F0-9]{64}$`) | Unique channel identifier |
| `stateNonce` | `uint64` (integer, 0–2^64-1) | Monotonic sequence number |
| `balA` | `uint256` (decimal string, `^[0-9]+$`) | Participant A balance in base units |
| `balB` | `uint256` (decimal string, `^[0-9]+$`) | Participant B balance in base units |
| `locksRoot` | `bytes32` (hex string) | Merkle root of active locks (reserved) |
| `stateExpiry` | `uint64` (unix timestamp) | State validity deadline |
| `contextHash` | `bytes32` (hex string) | Commitment to payment context |

### 12.2 Hub Ticket (Payee Settlement Promise)

Issued by the hub after the agent submits a signed state update. The payee uses this as proof of payment.

```json
{
  "ticketId": "tkt_01JXYZPB3X...",
  "hub": "0xHubAddress...",
  "payee": "0xPayeeAddress...",
  "invoiceId": "inv_01JXYZP2F8...",
  "paymentId": "pay_01JXYZP5A3...",
  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "amount": "1000000",
  "feeCharged": "3010",
  "totalDebit": "1003010",
  "expiry": 1770000300,
  "policyHash": "0x7f2c4ac6...",
  "sig": "0xabcdef..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ticketId` | string (6–128 chars) | Unique ticket identifier |
| `hub` | EVM address | Hub signer address |
| `payee` | EVM address | Intended recipient |
| `invoiceId` | string | Payee quote binding |
| `paymentId` | string | Idempotency key |
| `asset` | EVM address | Payment asset contract |
| `amount` | uint string | Payment amount to payee (base units) |
| `feeCharged` | uint string | Fee retained by hub |
| `totalDebit` | uint string | Total deducted from agent channel (`amount + feeCharged`) |
| `expiry` | unix timestamp | Ticket validity deadline |
| `policyHash` | bytes32 hex | Hash of the fee policy applied |
| `sig` | hex bytes (`^0x[a-fA-F0-9]{2,4096}$`) | Hub signature over the canonical ticket draft |

The hub MUST sign this ticket with its advertised key.

### 12.3 Channel Proof

Included in the payment header to provide cryptographic linkage between the ticket and the agent's channel state.

```json
{
  "channelId": "0x7a0de7b4...",
  "stateNonce": 42,
  "stateHash": "0x7607fdbf...",
  "sigA": "0xabcd...",
  "channelState": { ... }
}
```

The `channelState` field is OPTIONAL but RECOMMENDED for verifiers that want to independently validate the state hash and signer.

---

## 13. Cryptography

### 13.1 Channel State Signatures (EIP-712)

Channel state signatures use EIP-712 typed data signing.

**EIP-712 Domain:**

```
EIP712Domain(
  string name = "X402StateChannel",
  string version = "1",
  uint256 chainId,
  address verifyingContract
)
```

**Domain separator:**

```
DOMAIN_SEPARATOR = keccak256(abi.encode(
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    keccak256("X402StateChannel"),
    keccak256("1"),
    chainId,
    verifyingContract
))
```

**State type hash:**

```
STATE_TYPEHASH = keccak256(
    "ChannelState(bytes32 channelId,uint64 stateNonce,uint256 balA,uint256 balB,bytes32 locksRoot,uint64 stateExpiry,bytes32 contextHash)"
)
```

**Digest computation:**

```
structHash = keccak256(abi.encode(
    STATE_TYPEHASH,
    channelId,
    stateNonce,
    balA,
    balB,
    locksRoot,
    stateExpiry,
    contextHash
))

digest = keccak256("\x19\x01" || DOMAIN_SEPARATOR || structHash)
```

The signer signs this digest directly (raw `signDigest`, not `eth_sign` — the `\x19\x01` prefix is already in the digest).

### 13.2 Ticket Signatures

Ticket signatures use `eth_sign` over the keccak256 of the canonicalized JSON:

1. Remove the `sig` field from the ticket object.
2. Recursively sort all object keys alphabetically.
3. `JSON.stringify` the sorted object.
4. `digest = keccak256(utf8Bytes(jsonString))`
5. Sign with `eth_sign` (prepends `"\x19Ethereum Signed Message:\n32"` + digest).

Verification recovers the signer via `ecrecover` on the `eth_sign`-prefixed digest.

### 13.3 Signature Format

All signatures MUST be 65 bytes: `r (32) || s (32) || v (1)`. The `s` value MUST be in the lower half of the secp256k1 curve order per EIP-2 to prevent malleability. `v` MUST be 27 or 28.

### 13.4 Replay Protection

Replay safety MUST include all of:

1. `channelId` — scopes to a specific channel
2. `stateNonce` — prevents reuse of prior states
3. `chainId` — scopes to a specific chain (via EIP-712 domain)
4. `contextHash` — binds to the specific payment context

---

## 14. Smart Contract Interface

The on-chain adjudicator contract (`X402StateChannel.sol`, Solidity 0.8.28) provides the following interface:

### 14.1 Core Functions

```solidity
function openChannel(
    address participantB,
    address asset,
    uint256 amount,
    uint64 challengePeriodSec,
    uint64 channelExpiry,
    bytes32 salt,
    uint8 hubFlags          // 0=none, 1=A is hub, 2=B is hub, 3=both
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

function rebalance(
    ChannelState calldata state,
    bytes32 toChannelId,
    uint256 amount,
    bytes calldata sigCounterparty
) external;
```

**`hubFlags`** marks which participant(s) act as a hub in the channel. This controls who may call `rebalance()` to move earned funds out without closing. Typical values:

| Value | Meaning | Rebalance permitted by |
|-------|---------|------------------------|
| `0` | No hub | Nobody (rebalance blocked) |
| `1` | A is hub | A only |
| `2` | B is hub | B only |
| `3` | Both | Either |

**`rebalance()`** allows a hub participant to move earned funds from one channel to another in a single transaction, without closing the source channel.

The hub submits:
- The latest off-chain state (signed by the counterparty), proving the current balance split.
- The destination channel ID (must share the same asset and include the hub as a participant).
- The amount to move (must not exceed the hub's balance in the signed state).

The contract verifies the counterparty signature, deducts `amount` from the hub's side of the source channel, and credits it to the destination channel's `totalBalance`. The source channel remains open with a reduced `totalBalance`.

### 14.2 View Functions

```solidity
function getChannel(bytes32 channelId) external view returns (ChannelParams memory);
function balance(bytes32 channelId) external view returns (ChannelBalance memory);
function getChannelCount() external view returns (uint256);
function getChannelIds(uint256 offset, uint256 limit) external view returns (bytes32[] memory);
function getChannelsByParticipant(address participant) external view returns (bytes32[] memory);
function hashState(ChannelState calldata st) external view returns (bytes32);
function pendingPayout(address asset, address account) external view returns (uint256);
function withdrawPayout(address asset) external;
```

**`balance()`** returns the current on-chain balance view of a channel:

```solidity
struct ChannelBalance {
    uint256 totalBalance;
    uint256 balA;
    uint256 balB;
    uint64  latestNonce;
    bool    isClosing;
}
```

If the channel is closing or has had on-chain state updates (via `rebalance` or dispute), `balA`/`balB` reflect the last submitted state. Otherwise, `balA = totalBalance` and `balB = 0` (initial funding assumption).

### 14.3 Channel ID Derivation

```
channelId = keccak256(abi.encode(
    block.chainid,
    address(this),
    msg.sender,      // participantA
    participantB,
    asset,
    salt
))
```

Channel IDs are marked as used permanently — reuse of the same parameters with the same salt is rejected even after channel closure.

### 14.4 On-chain Channel Struct

```solidity
struct Channel {
    address participantA;
    address participantB;
    address asset;
    uint64  challengePeriodSec;
    uint64  channelExpiry;
    uint256 totalBalance;
    bool    isClosing;
    uint64  closeDeadline;
    uint64  latestNonce;
    uint256 closeBalA;
    uint256 closeBalB;
    uint8   hubFlags;       // 0=none, 1=A is hub, 2=B is hub, 3=both
}
```

The `ChannelParams` struct returned by `getChannel()` includes `hubFlags`:

```solidity
struct ChannelParams {
    address participantA;
    address participantB;
    address asset;
    uint64  challengePeriodSec;
    uint64  channelExpiry;
    uint256 totalBalance;
    bool    isClosing;
    uint64  closeDeadline;
    uint64  latestNonce;
    uint8   hubFlags;
}
```

### 14.5 Events

| Event | Parameters |
|-------|-----------|
| `ChannelOpened` | `channelId`, `participantA`, `participantB`, `asset`, `challengePeriodSec`, `channelExpiry` |
| `Deposited` | `channelId`, `sender`, `amount`, `newTotalBalance` |
| `CloseStarted` | `channelId`, `stateNonce`, `closeDeadline`, `stateHash` |
| `Challenged` | `channelId`, `stateNonce`, `stateHash` |
| `ChannelClosed` | `channelId`, `finalNonce`, `payoutA`, `payoutB` |
| `Rebalanced` | `fromChannelId`, `toChannelId`, `amount`, `fromNewTotal`, `toNewTotal` |
| `PayoutDeferred` | `asset`, `to`, `amount` |
| `PayoutWithdrawn` | `asset`, `to`, `amount` |

### 14.6 Contract Validation Rules

1. `balA + balB` MUST equal `totalBalance`.
2. `stateNonce` MUST be strictly greater than `latestNonce` for cooperative close, challenge, and rebalance. `startClose` allows equal nonce.
3. States with `stateExpiry > 0 && block.timestamp > stateExpiry` are rejected.
4. `challenge()` is only callable during the challenge window (`block.timestamp <= closeDeadline`).
5. `finalizeClose()` is only callable after the challenge window (`block.timestamp > closeDeadline`).
6. `cooperativeClose()` is blocked if the channel is already closing.
7. Failed ETH/ERC-20 transfers during payout are deferred to a pull-based `withdrawPayout()` pattern rather than reverting.
8. `openChannel` requires: `participantB != address(0)`, `challengePeriodSec > 0`, `channelExpiry > block.timestamp`, `amount > 0`, `hubFlags <= 3`.
9. Only channel participants may call `deposit`, `startClose`, and `challenge`.
10. `rebalance()` requires: caller is a hub participant in the source channel (`_isHub()` check against `hubFlags`), caller is a participant in the destination channel, same asset on both channels, destination channel not closing or expired, and `amount <= hub's balance` in the signed state.

---

## 15. Protocol Flows

### 15.1 Channel Open

1. Agent calls `openChannel()` on the contract with deposit, counterparty (hub or payee), asset, challenge period, expiry, a random salt, and `hubFlags`.
2. For hub-routed channels, use `hubFlags=2` (B is hub). For direct channels, use `hubFlags=0`.
3. Contract emits `ChannelOpened`.
4. Agent can begin sending off-chain signed state updates.

### 15.2 Channel Deposit (Top-up)

1. Either participant calls `deposit(channelId, amount)`.
2. Contract increments `totalBalance`.
3. Off-chain state MUST be re-synchronized to reflect the new total.

### 15.3 Rebalance (Hub Fund Transfer)

Allows a hub to move earned funds from one channel to another without closing:

1. Hub has earned funds through off-chain state updates (e.g., channel 1: `A=4 B=1`, hub is B, earned 1).
2. Hub holds the counterparty's signature on the latest state (obtained during normal payment flow).
3. Hub calls `rebalance(state, toChannelId, amount, sigCounterparty)` where:
   - `state` is the latest signed channel state proving the balance split.
   - `toChannelId` is the destination channel (same asset, hub is a participant).
   - `amount` is how much to pull from the hub's side (must be ≤ hub's balance in the state).
   - `sigCounterparty` is the counterparty's signature on the state.
4. Contract verifies the counterparty signature, deducts `amount` from source `totalBalance`, credits destination `totalBalance`.
5. Source channel remains open with reduced total. Off-chain state continues from the new total.
6. Contract emits `Rebalanced` and `Deposited` (on destination channel).

Example:
```
Channel 1 (agent↔hub): total=5, state{A=4, B=1}
Channel 2 (hub↔payee): total=0

Hub calls rebalance(state, ch2, 1, agentSig)
→ Channel 1: total=4, closeBalA=4, closeBalB=0
→ Channel 2: total=1
```

### 15.4 Hub-Routed Payment (Discovery → Quote → Issue → Pay)

**Step 1 — Discovery:**
1. `A → B`: GET request for a protected resource.
2. `B → A`: HTTP `402` with `accepts[]` containing one or more SCP offers.
3. `A` selects an offer based on network, asset, route preference, and channel readiness.

**Step 2 — Quote:**
1. `A → H`: `POST /v1/tickets/quote` with `{invoiceId, paymentId, channelId, payee, asset, amount, maxFee, quoteExpiry}`.
2. `H → A`: Quote response with `{fee, feeBreakdown, totalDebit, ticketDraft, expiry}`.
3. `A` verifies `fee <= maxFee`.

**Step 3 — Issue:**
1. `A` creates next channel state: `stateNonce += 1`, `balA -= totalDebit`, `balB += totalDebit`.
2. `A` computes `contextHash` binding the payment to `{payee, resource, invoiceId, paymentId, amount, asset}`.
3. `A` signs the state and submits to `H`: `POST /v1/tickets/issue` with `{quote, channelState, sigA}`.
4. `H` validates: signature recovery → nonce monotonicity → balance invariant → fee bounds.
5. `H → A`: Signed ticket + channel acknowledgment.

**Step 4 — Pay:**
1. `A → B`: Retry the original request with `PAYMENT-SIGNATURE` header containing `{scheme, paymentId, invoiceId, ticket, channelProof}`.
2. `B` verifies: ticket signature → ticket expiry → payee match → amount match → invoice binding → idempotency.
3. `B → A`: HTTP `200` with the resource and a payment receipt.

### 15.5 Direct Payment Flow

1. `A → B`: GET resource, receives `402` with `statechannel-direct-v1` offer.
2. `A` constructs a direct channel state update debiting the payment amount.
3. `A → B`: Retry with `PAYMENT-SIGNATURE` containing the direct payload.
4. `B` verifies: signature recovery matches `payer`, nonce strictly greater than previous, `balB` delta ≥ payment amount, state not expired.
5. `B → A`: HTTP `200` with resource and receipt.

### 15.6 Refund / Reverse Transfer

1. `B → H`: `POST /v1/refunds` with `{ticketId, refundAmount, reason}`.
2. `H` issues a reverse channel update crediting `A`.
3. `H → A`: Signed refund receipt with new `stateNonce`.

### 15.7 Channel Closure

**Cooperative Close (fast path):**
1. Either party proposes the latest state.
2. Both sign the same state.
3. Submit `cooperativeClose(state, sigA, sigB)` — settles immediately.

**Unilateral Close + Challenge (dispute path):**
1. Closer calls `startClose(state, sigFromCounterparty)`.
2. Contract sets `closeDeadline = now + challengePeriodSec`.
3. During challenge window, counterparty calls `challenge(newerState, sig)` with a higher nonce.
4. After deadline, anyone calls `finalizeClose(channelId)`.

**Settlement:**
- Participant A receives `closeBalA`.
- Participant B receives `closeBalB`.
- Failed transfers are deferred to `withdrawPayout()`.

---

## 16. Hub HTTP API

### 16.1 Metadata Endpoint

**`GET /.well-known/x402`**

```json
{
  "hubName": "pay.eth",
  "address": "0xHubAddress...",
  "schemes": ["statechannel-hub-v1"],
  "supportedAssets": ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
  "signature": {
    "format": "eip712",
    "keyId": "hub-main-v1",
    "publicKey": "0x04..."
  }
}
```

### 16.2 Ticket Endpoints

| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| `/v1/tickets/quote` | POST | QuoteRequest | QuoteResponse |
| `/v1/tickets/issue` | POST | `{quote, channelState, sigA}` | Ticket |

### 16.3 Payment & Channel Endpoints

| Endpoint | Method | Response |
|----------|--------|----------|
| `/v1/payments/{paymentId}` | GET | `{paymentId, status, ticketId?, stateNonce?}` |
| `/v1/channels/{channelId}` | GET | `{channelId, latestNonce, status}` |
| `/v1/refunds` | POST | `{ticketId, stateNonce, receiptId}` |

### 16.4 Payee Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/payee/inbox?payee=&since=&limit=` | GET | Paginated payment inbox |
| `/v1/payee/balance?payee=` | GET | Payee balance at hub |
| `/v1/payee/channel-state?payee=` | GET | Latest channel state |
| `/v1/payee/settle` | POST | Request settlement |

### 16.5 Agent & Admin Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/agent/summary?channelId=` | GET | Agent channel summary |
| `/v1/hub/open-payee-channel` | POST | Hub opens downstream channel |
| `/v1/hub/register-payee-channel` | POST | Register payee channel |

### 16.6 Payment Status Values

`quoted` → `issued` → `settled` | `refunded` | `expired`

### 16.7 Error Response Format

```json
{
  "errorCode": "SCP_003_FEE_EXCEEDS_MAX",
  "message": "Requested fee 5000 exceeds agent maxFee 3000",
  "retryable": false
}
```

Full OpenAPI 3.1 spec: `docs/openapi/pay-eth-scp-v1.yaml`

---

## 17. Payment Header Format

### 17.1 Hub-Routed (`PAYMENT-SIGNATURE` header, JSON string)

```json
{
  "scheme": "statechannel-hub-v1",
  "paymentId": "pay_01JXYZP5A3...",
  "invoiceId": "inv_01JXYZP2F8...",
  "ticket": {
    "ticketId": "tkt_...",
    "hub": "0xHub...",
    "payee": "0xPayee...",
    "invoiceId": "inv_...",
    "paymentId": "pay_...",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "amount": "1000000",
    "feeCharged": "3010",
    "totalDebit": "1003010",
    "expiry": 1770000300,
    "policyHash": "0x7f2c4ac6...",
    "sig": "0xabcdef..."
  },
  "channelProof": {
    "channelId": "0x7a0de7b4...",
    "stateNonce": 42,
    "stateHash": "0x7607fdbf...",
    "sigA": "0xabcd...",
    "channelState": { "..." }
  }
}
```

### 17.2 Direct (`PAYMENT-SIGNATURE` header, JSON string)

```json
{
  "scheme": "statechannel-direct-v1",
  "paymentId": "pay_...",
  "invoiceId": "inv_...",
  "direct": {
    "channelState": { "..." },
    "sigA": "0x...",
    "payer": "0xAgent...",
    "payee": "0xPayee...",
    "amount": "1000000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "invoiceId": "inv_...",
    "paymentId": "pay_...",
    "expiry": 1770000300
  }
}
```

### 17.3 Payee Verification Order

1. Parse `PAYMENT-SIGNATURE` header as JSON.
2. Validate `scheme` field.
3. **Hub route:** Verify ticket signature → verify ticket expiry → verify `ticket.payee` matches self → verify `ticket.amount` matches invoice → verify `paymentId` not already consumed → (optional) confirm with hub via `GET /v1/payments/{paymentId}`.
4. **Direct route:** Recover signer from `sigA` over `channelState` → verify signer matches `payer` → verify nonce > previous → verify `balB` delta ≥ amount → verify state not expired.

---

## 18. Fee Model

### 18.1 Fee Formula

```
fee = base + floor(amount × bps / 10000) + gasSurcharge
```

### 18.2 Fee Breakdown

```json
{
  "base": "10",
  "bps": 30,
  "variable": "3000",
  "gasSurcharge": "0"
}
```

### 18.3 Agent Fee Protection

- Agent MUST set `maxFee` in the quote request.
- Hub MUST reject if `fee > maxFee`.
- Agent MUST verify before signing.

---

## 19. Offer Configuration

Payees configure via `OFFERS_FILE` (JSON):

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

---

## 20. Agent Offer Selection

1. **Filter** by `--network` / `--asset` when provided.
2. **Split** into hub and direct offers.
3. **Score** readiness: `2` (funded channel), `1` (underfunded channel), `0` (no channel).
4. **Tie-break** by smaller `maxAmountRequired`, then original order.
5. **Route behavior:** `--route hub` → best hub; `--route direct` → best direct; `--route auto` → direct if score ≥ 2, otherwise hub.
6. **Hub affordability guard:** If no hub channel exists, check wallet can afford top-up.

---

## 21. Async Notifications (Webhooks)

### 21.1 Event Types

| Event | Description |
|-------|-------------|
| `channel.close_started` | `startClose` on-chain |
| `channel.challenged` | Higher nonce submitted |
| `channel.closed` | Channel finalized |
| `payment.refunded` | Reverse transfer issued |
| `payment.received` | Ticket credited to payee |
| `balance.low` | Channel balance below threshold |

### 21.2 Registration

```json
POST /v1/webhooks
{
  "url": "https://agent.example/hooks/scp",
  "events": ["channel.close_started", "payment.refunded"],
  "channelId": "0x...",
  "secret": "shared-hmac-secret"
}
```

### 21.3 Payload

```json
{
  "event": "channel.close_started",
  "timestamp": 1770000200,
  "webhookId": "wh_abc123",
  "data": {
    "channelId": "0x...",
    "submittedBy": "0xCounterparty...",
    "stateNonce": 42,
    "deadline": 1770086600,
    "txHash": "0x...",
    "blockNumber": 12345678
  }
}
```

Delivery via `X-SCP-Signature` HMAC header. Retry up to 5 times with exponential backoff.

---

## 22. Challenge Watcher

| Variable | Description |
|----------|-------------|
| `ROLE` | `agent` or `hub` |
| `RPC_URL` | Chain RPC endpoint |
| `CONTRACT_ADDRESS` | Channel contract |
| `CHANNEL_ID` | Channel to monitor |
| `WATCHER_PRIVATE_KEY` | Key for challenge txs |
| `POLL_MS` | Polling interval |
| `SAFETY_BUFFER_SEC` | Buffer before deadline |

Behavior: Poll for `CloseStarted` → if stale nonce, submit `challenge()` with highest known state → monitor until finalized.

---

## 23. Peer-to-Peer Payment Profile

### Profile `peer_simple`

- Receiver MAY be a wallet endpoint or static identity.
- HTTP 402 challenge is OPTIONAL.
- `paymentMemo` (max 280 chars) MAY replace `resource` binding.
- Hub ticket and signed state remain REQUIRED.
- `contextHash` MUST include recipient and `paymentMemo`.

---

## 24. Error Codes

| Code | Meaning |
|------|---------|
| `SCP_001_UNSUPPORTED_ASSET` | Asset not supported |
| `SCP_002_QUOTE_EXPIRED` | Quote TTL passed |
| `SCP_003_FEE_EXCEEDS_MAX` | Fee exceeds agent maxFee |
| `SCP_004_INVALID_TICKET_SIG` | Ticket signature failed |
| `SCP_005_NONCE_CONFLICT` | Stale or conflicting nonce |
| `SCP_006_STATE_EXPIRED` | Channel state expired |
| `SCP_007_CHANNEL_NOT_FOUND` | Channel does not exist |
| `SCP_008_CHALLENGE_WINDOW_OPEN` | Blocked during challenge |
| `SCP_009_POLICY_VIOLATION` | Policy violation |

---

## 25. Security Considerations

1. All signed objects MUST include an expiry.
2. Agent MUST bind debit authorization to payee and resource context via `contextHash`.
3. Payee MUST verify ticket not expired and `paymentId` not already consumed.
4. Hub SHOULD publish key rotation metadata and overlap windows.
5. Implementations MUST handle chain reorg safety for on-chain closure events.
6. Watchers SHOULD auto-challenge stale close attempts.
7. For direct route, payee MUST verify: signer recovery, nonce monotonicity, balance delta sufficiency.
8. Both payer and hub SHOULD persist latest state and counterparty signature.
9. EIP-2 `s` value constraint MUST be enforced.
10. Solidity 0.8.x overflow protection covers all arithmetic.
11. Failed transfers are deferred (not reverted) to prevent griefing attacks.

---

## 26. Privacy Considerations

1. Hub observes payer–payee graph in proxy mode.
2. Payers SHOULD use scoped channel identities to reduce linkability.
3. Payees SHOULD avoid sensitive plaintext in signed contexts.

---

## 27. Conformance Profiles

| Profile | Scope |
|---------|-------|
| **P0 (MVP)** | `proxy_hold` only, one asset/channel, basic fees, coop + unilateral close |
| **P1** | Multi-asset lanes, refund standardization, payee revocation checks |
| **P2** | Multi-hub discovery, conditional claim mode (deferred) |
| **P3 (Direct)** | `statechannel-direct-v1`, direct state verification, route selection |

---

## 28. JSON Schemas

All schemas use JSON Schema 2020-12. Hosted at `https://x402.org/schemas/`.

| Schema | Description |
|--------|-------------|
| `scp.channel-state.v1` | Channel state fields and types |
| `scp.quote-request.v1` | Quote request from agent to hub |
| `scp.quote-response.v1` | Quote response with ticket draft and fee breakdown |
| `scp.ticket.v1` | Hub-signed ticket (includes `sig`) |
| `scp.payment-payload.v1` | Full payment retry header payload |

### Common Types

| Type | Pattern |
|------|---------|
| `hex32` | `^0x[a-fA-F0-9]{64}$` |
| `evmAddress` | `^0x[a-fA-F0-9]{40}$` |
| `uintString` | `^[0-9]+$` |
| `hexBytes` | `^0x[a-fA-F0-9]{2,4096}$` |

---

## 29. Deterministic Contract Deployment

| Parameter | Value |
|-----------|-------|
| CREATE2 Factory | `0x4e59b44847b379578588920ca78fbf26c0b4956c` |
| CREATE2 Salt | `x402s:X402StateChannel:v1` |
| Canonical Address | `0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b` |

Same factory + bytecode + salt = same address on any EVM chain.

---

## 30. Example End-to-End Flow

### Hub-Routed

1. Agent opens channel with `pay.eth` on Base with 20 USDC.
2. Agent hits `B1`'s `/weather`, gets `402`, selects hub offer.
3. Agent quotes from hub — fee = 3010 on 1,000,000 amount.
4. Agent signs state nonce 101 debiting 1,003,010 from `balA`.
5. Hub issues signed ticket for `B1`.
6. Agent retries with ticket; `B1` verifies and serves data.
7. Agent pays `B2` (nonce 102), `B3` (nonce 103) through same channel.
8. `B2` refunds; hub reverses at nonce 104.
9. Cooperative close settles net result on-chain.

### Direct

1. Agent hits `B`, gets `402` with direct offer.
2. Agent signs direct state update.
3. Agent retries with direct payload.
4. Payee verifies signer, nonce, delta; serves response.

---

## 31. Backward Compatibility

SCP schemes are additive to x402 and do not alter baseline `402` semantics. Payees MAY offer multiple schemes in `accepts[]`, allowing clients to choose SCP or other x402 schemes (e.g., Coinbase `exact`).

---

## 32. Open Questions

1. Canonical header field naming (`PAYMENT-SIGNATURE` vs. alternatives).
2. Single-use vs. multi-use ticket policy defaults.
3. Standard revocation endpoint semantics.
4. Cross-chain channel portability model.
5. Multi-hub routing and discovery standardization.

---

## 33. Appendices

### A. `contextHash` Recommendation

```
contextHash = keccak256(abi.encode(
    payee, resourceUriHash, httpMethod,
    invoiceId, paymentId, amount, asset, quoteExpiry
))
```

### B. Hub Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `4021` | Hub port |
| `HUB_NAME` | `pay.eth` | Display identity |
| `HUB_PRIVATE_KEY` | required | Signing key |
| `NETWORK` | `sepolia` | Chain selector |
| `FEE_BASE` | `10` | Flat fee |
| `FEE_BPS` | `30` | Variable fee (bps) |
| `GAS_SURCHARGE` | `0` | Gas pass-through |
| `RPC_URL` | unset | On-chain operations |
| `CONTRACT_ADDRESS` | unset | Channel contract |
| `STORE_PATH` | `./data/store.json` | File store |
| `REDIS_URL` | unset | Shared backend |
| `HUB_WORKERS` | `0` | Cluster workers |
| `HUB_ADMIN_TOKEN` | unset | Admin auth |
| `PAYEE_AUTH_MAX_SKEW_SEC` | unset | Clock skew tolerance |

### C. Agent Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_PRIVATE_KEY` | required | Payer wallet |
| `NETWORK` / `NETWORKS` | required | Target chain(s) |
| `RPC_URL` | required | Chain RPC |
| `CONTRACT_ADDRESS` | auto | Contract address |
| `MAX_AMOUNT` | required | Payment cap |
| `MAX_FEE` | required | Fee cap |
| `MAX_AMOUNT_{ASSET}` | unset | Per-asset cap |
| `MAX_FEE_{ASSET}` | unset | Per-asset fee cap |
| `AGENT_APPROVAL_MODE` | `auto` | `auto` / `per_payment` / `per_api` |
| `AGENT_DEFAULT_ROUTE` | `hub` | `hub` / `direct` / `auto` |
| `HUB_URL` | unset | Hub endpoint |
| `AGENT_START_PAYEE` | `0` | Local `/pay` helper |

### D. Default Ports

| Role | Port |
|------|------|
| Hub | 4021 |
| Payee API | 4042 |
| Agent HTTP Server | 4060 |

### E. Project Structure

```
x402s/
├── contracts/                  # Solidity contracts
│   ├── X402StateChannel.sol    # Main adjudicator
│   ├── interfaces/             # IX402StateChannel.sol, IERC20.sol
│   └── mocks/                  # Test mocks
├── node/
│   ├── scp-agent/              # Agent SDK, CLI, HTTP server
│   ├── scp-common/             # Shared: networks, HTTP client, auth
│   ├── scp-demo/               # Demo scripts
│   ├── scp-hub/                # Hub server
│   ├── scp-sim/                # Simulations
│   ├── scp-watch/              # Challenge watcher
│   ├── meow-api/               # Example paid API
│   └── weather-api/            # Example weather API
├── docs/
│   ├── X402_STATE_CHANNEL_V1.md
│   ├── X402_STATE_CHANNEL_PROTOCOL.md
│   ├── IMPLEMENTATION_X402_SCP_V1.md
│   ├── openapi/                # OpenAPI 3.1 spec
│   ├── schemas/                # JSON Schemas
│   └── examples/               # Wire format examples
├── scripts/                    # Deploy, wizard, benchmarks
├── skill/                      # Claude skill integration
└── test/                       # Contract + integration tests
```

### F. Payee Verification Helper (Node.js)

```javascript
const { createVerifier } = require("x402s/node/scp-hub/ticket");

const verify = createVerifier({
  payee: "0xMyPayeeAddress",
  hubUrl: "http://159.223.150.70/hub/sepolia"
});

// In request handler:
const result = await verify(req.headers["payment-signature"], invoiceStore);
if (result.replayed) return res.json(result.response);
if (!result.ok) return res.status(402).json({ error: result.error });

const response = { ok: true, receipt: { paymentId: result.paymentId } };
verify.seenPayments.set(result.paymentId, response);
return res.json(response);
```
