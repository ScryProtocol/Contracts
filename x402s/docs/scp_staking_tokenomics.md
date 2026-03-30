# SCP Bonded Hub Staking and Tokenomics

Status: Draft  
Version: `0.1.0`  
Applies to: `A -> H -> B` routed SCP payments on top of the existing `X402StateChannel` model

## 1. Summary

This document specifies an optional bonded-hub layer for SCP:

- `A` opens a state channel with hub `H`.
- `H` routes payment to payee `B` and charges a fee.
- `H` must stake an SCP network token to operate in bonded mode.
- If `H` produces objectively provable malicious behavior, part or all of its stake is slashed.
- A fixed-price seed sale distributes the token initially so early hubs and ecosystem participants can acquire stake.

This design does **not** replace the current channel contract. It adds economic security around routed hub behavior.

## 2. Motivation

Current routed SCP is economically simple but trust-heavy for payees:

- `A` is protected by its signed channel states and fee caps.
- `B` trusts that `H` will honor the hub receipt it signs.
- `H` can already charge a fee, but there is no protocol-native bond that can be forfeited on misbehavior.

The bonded-hub model adds:

1. A required hub bond.
2. Objective slashing for signed misconduct.
3. A reason for operators to acquire and lock the network token.

## 3. Design Principles

1. Keep the base channel adjudicator generic. `X402StateChannel` should remain usable without the token.
2. Slash only on objective evidence. "Bad service" or "I do not like this hub" is not slashable.
3. Preserve off-chain speed. Regular payments should remain quote -> sign -> ticket -> serve.
4. Avoid forcing end users or payees to hold the staking token.
5. Separate economic security from payment settlement. The payment asset can remain ETH or ERC-20 while stake is held in SCP token.

## 4. Scope

### In Scope

- Hub registration and staking.
- Slashable receipt and close-related offenses.
- Fixed-price seed sale for initial token distribution.
- Discovery metadata for bonded hubs.
- Contract/module split for an EVM implementation.

### Out of Scope

- Full trustless multi-hop routing.
- Subjective arbitration over off-chain service quality.
- Exact treasury/governance allocation decisions.
- Perfect payee reimbursement in the payment asset without oracle or reserve design.

## 5. Relationship to Existing SCP

This proposal sits above the current SCP implementation:

- Upstream settlement stays `A <-> H` in [`X402StateChannel.sol`](../contracts/X402StateChannel.sol).
- Existing hub quote and receipt flow stays compatible with the routed mode described in [`X402_STATE_CHANNEL_PROTOCOL.md`](./X402_STATE_CHANNEL_PROTOCOL.md).
- The new bonded mode adds hub registry, stake, claim, and slashing contracts.

Recommended scheme naming:

- Existing mode: `statechannel-hub-v1`
- Bonded mode: `statechannel-hub-bonded-v1`

Payees that want slash-backed hub assurances SHOULD advertise the bonded mode only.

## 6. Roles

- `A`: payer/agent.
- `H`: hub operator and bonded router.
- `B`: payee/beneficiary.
- `C`: existing SCP channel contract.
- `R`: hub registry and stake vault.
- `S`: slash manager / settlement claim contract.
- `T`: SCP staking token.

## 7. Token Model

### 7.1 Token Purpose

The SCP token exists to secure hub behavior, not to replace the payment asset.

Primary utility:

1. Hubs MUST stake it to advertise bonded routing.
2. Slash penalties are paid in it.
3. Governance MAY later use it for parameter voting, but governance is not required for v1.

### 7.2 Token Requirements

Recommended token properties:

- ERC-20.
- Fixed cap or immutable max supply.
- `permit` support is useful but optional.
- No transfer restrictions after distribution.

### 7.3 Economic Role

The token functions as a bond:

- Honest hubs lock capital and earn routing fees.
- Malicious hubs lose part of that locked capital.
- Agents and payees can prefer hubs with larger active stake.

## 8. Bonded Hub Registration

To operate in bonded mode, a hub MUST:

1. Register an operator address.
2. Register one or more receipt-signing keys.
3. Stake at least `MIN_ACTIVE_STAKE`.
4. Accept an unstake cooldown long enough to cover receipt expiry plus dispute time.

Suggested registration record:

```solidity
struct HubRecord {
  uint256 hubId;
  address operator;
  address treasury;
  address activeSigner;
  uint256 activeStake;
  uint256 pendingUnstake;
  uint64 unstakeReadyAt;
  uint64 stakeEpoch;
  bool active;
  string metadataURI;
}
```

Notes:

- `stakeEpoch` is included in bonded receipts so a hub cannot issue receipts and immediately rotate out of slashable stake.
- `activeSigner` is the key used for `HubReceipt` signatures.

## 9. Bonded Receipt Format

The current hub receipt should be extended for bonded mode.

Suggested typed data:

```solidity
BondedHubReceipt(
  uint256 hubId,
  uint64 stakeEpoch,
  bytes32 channelId,
  uint64 stateNonce,
  address payee,
  address asset,
  uint256 amount,
  uint256 feeCharged,
  uint256 totalDebit,
  bytes32 quoteId,
  bytes32 paymentId,
  bytes32 requestHash,
  uint64 issuedAt,
  uint64 settlementDeadline
)
```

Properties:

- `hubId` binds the receipt to the registry entry.
- `stakeEpoch` binds the receipt to a slashable stake period.
- `stateNonce` binds the receipt to an upstream payer state.
- `settlementDeadline` defines when `B` can escalate if unpaid.

`receiptId` SHOULD be:

```text
keccak256(hubId, stakeEpoch, channelId, stateNonce, paymentId)
```

## 10. What Counts as Slashable Misbehavior

Only objective, signature-backed offenses SHOULD be slashable in v1.

### 10.1 Offense A: Conflicting Receipts

The hub signs two incompatible receipts for the same upstream payment identity.

Examples:

- Same `paymentId`, different `payee`.
- Same `paymentId`, different `amount`.
- Same `(channelId, stateNonce, requestHash)`, multiple incompatible obligations.

Evidence:

- `receipt1 + hubSig1`
- `receipt2 + hubSig2`

Result:

- Immediate slash.
- Claimant receives a reward.
- Hub may be deactivated if remaining stake falls below minimum.

### 10.2 Offense B: Receipt Default

The hub signs a bonded receipt promising payment to `B`, but the receipt reaches `settlementDeadline` without any valid settlement proof.

Evidence:

- `BondedHubReceipt + hub signature`
- No recorded settlement for `receiptId`
- Deadline elapsed

Hub defense:

- A payee-signed settlement acknowledgement, or
- An on-chain downstream settlement proof, or
- A proof that the receipt was already slashed/settled/cancelled under the same `receiptId`

Result:

- Slash after dispute window.
- Claimant reward goes to `B` or whoever submitted the valid claim.

### 10.3 Offense C: Attempted Stale Close

The hub starts a channel close using a stale state even though a newer hub-signed state exists.

Evidence:

- Proof that the hub initiated close on nonce `n`
- A newer valid hub-signed state with nonce `n + k`

This offense is valuable, but it requires either:

1. A thin hook from the state channel contract into the slashing layer, or
2. Event-proof verification for `CloseStarted`

For that reason, stale-close slashing is RECOMMENDED as a phase-2 feature.

### 10.4 Not Slashable in v1

These should not trigger automatic slashing:

- Slow responses
- High fees, if quoted transparently
- Refusal to serve new traffic
- API quality disputes
- Payee claims without a valid hub-signed receipt

## 11. Settlement Proof Model

To make receipt-default slashing objective, the protocol needs a settlement acknowledgement format.

Suggested typed data:

```solidity
SettlementAck(
  bytes32 receiptId,
  address payee,
  address asset,
  uint256 amount,
  bytes32 settlementRef,
  uint64 settledAt
)
```

Who signs it:

- `B` signs if settlement happened off-chain.
- If settlement happened on-chain, the slash contract can instead accept transaction-level proof or a direct call from a protocol-controlled settlement adapter.

This keeps the default claim objective:

- If `H` paid, it can prove payment.
- If `H` cannot prove payment, it gets slashed.

## 12. Slash Amount Policy

Slash size should be parameterized, not hardcoded in the receipt.

Recommended policy:

```text
slashAmount = max(
  MIN_SLASH_TOKENS,
  oracleConvert(claimNotional * DEFAULT_SLASH_MULTIPLIER_BPS / 10000)
)
```

Suggested defaults:

- `DEFAULT_SLASH_MULTIPLIER_BPS = 15000` (150% of claim value)
- `MIN_SLASH_TOKENS` set high enough to deter griefing-sized receipts

If no reliable oracle exists, governance can instead use:

- fixed token penalties by receipt size tier, or
- a conservative flat slash schedule

Slash distribution can be:

- `claimantRewardBps`
- `treasuryBps`
- `burnBps`

Illustrative split:

- 70% to claimant
- 20% to protocol reserve
- 10% burned

## 13. Unstake Rules

Unstaking must not let hubs escape liability for recently issued receipts.

Recommended rules:

1. `requestUnstake(amount)` starts a cooldown.
2. Cooldown MUST be longer than `MAX_RECEIPT_TTL + DEFAULT_CLAIM_WINDOW`.
3. During cooldown, stake remains slashable.
4. If a slash claim is opened, unstake finalization is blocked until the claim is resolved.
5. If remaining stake after slash is below `MIN_ACTIVE_STAKE`, bonded routing is suspended.

Example:

- `MAX_RECEIPT_TTL = 1 day`
- `DEFAULT_CLAIM_WINDOW = 3 days`
- `UNSTAKE_DELAY = 7 days`

## 14. Discovery and Wire Metadata

Bonded hubs SHOULD publish the following in `/.well-known/x402` or the SCP offer extension:

```json
{
  "scheme": "statechannel-hub-bonded-v1",
  "hubId": 12,
  "registry": "0xRegistry",
  "stakeToken": "0xToken",
  "activeStake": "5000000000000000000000",
  "stakeEpoch": 7,
  "receiptSigner": "0xSigner",
  "settlementMode": "receipt_ack"
}
```

Agents and payees MAY reject hubs that:

- are inactive,
- have stake below policy,
- use unsupported settlement proof modes.

## 15. Seed Sale

### 15.1 Goal

Seed the token so early hub operators, integrators, and ecosystem participants can acquire stake.

### 15.2 Sale Mechanics

Recommended v1 sale:

- Fixed price.
- Accept ETH.
- Treasury receives ETH proceeds.
- Sale contract escrows a fixed token allocation.
- Unsold tokens return to treasury after the sale ends.

### 15.3 Example Price

Illustrative example from the proposal:

- `100 SCP` sold for `10 ETH`
- Equivalent price: `10 SCP / ETH`
- Equivalent price: `0.1 ETH / SCP`

In contract terms:

```text
tokensOut = (msg.value * TOKENS_PER_ETH) / 1 ether
TOKENS_PER_ETH = 10e18
```

This number is only an example. Production pricing should be chosen deliberately.

### 15.4 Recommended Sale Guards

- `startTime`
- `endTime`
- `hardCapEth`
- `perWalletCapEth`
- `treasury`
- `saleAllocation`

Optional:

- whitelist
- vesting for team/treasury allocations
- refund path if minimum raise is not met

## 16. Smart Contract Architecture

The cleanest architecture is a set of focused contracts around the existing state channel.

### 16.1 `SCPToken`

Responsibilities:

- ERC-20 token.
- Mint fixed supply at deployment.
- Transfer sale allocation to seed sale.
- Transfer treasury/ecosystem allocations to designated wallets or vesting contracts.

### 16.2 `SCPSeedSale`

Responsibilities:

- Hold the seed-sale allocation.
- Accept ETH and dispense SCP at a fixed rate.
- Enforce sale window and caps.
- Forward ETH to treasury.
- Return unsold tokens after the sale.

Minimal interface:

```solidity
function buy(address recipient) external payable;
function quote(uint256 ethIn) external view returns (uint256 tokenOut);
function sweepUnsold() external;
```

### 16.3 `SCPHubRegistry`

Responsibilities:

- Create hub ids.
- Track operator, treasury, active signer, metadata URI.
- Track active/inactive status.
- Expose read APIs for agents and payees.

Minimal interface:

```solidity
function registerHub(address signer, address treasury, string calldata metadataURI) external returns (uint256 hubId);
function updateSigner(uint256 hubId, address newSigner) external;
function setMetadataURI(uint256 hubId, string calldata metadataURI) external;
function hubInfo(uint256 hubId) external view returns (HubRecord memory);
```

### 16.4 `SCPStakeVault`

Responsibilities:

- Hold staked SCP.
- Accept stake increases.
- Track unstake requests and cooldowns.
- Execute slashes when called by the slash manager.
- Freeze or deactivate a hub if stake is too low.

Minimal interface:

```solidity
function stake(uint256 hubId, uint256 amount) external;
function requestUnstake(uint256 hubId, uint256 amount) external;
function finalizeUnstake(uint256 hubId) external;
function slash(uint256 hubId, uint256 amount, address recipient, bytes32 reasonHash) external;
```

### 16.5 `SCPSlashManager`

Responsibilities:

- Verify slash evidence.
- Open and resolve receipt-default claims.
- Slash for conflicting receipts.
- Optionally slash stale closes if integrated with channel hooks or event proofs.

Minimal interface:

```solidity
function openReceiptDefaultClaim(BondedHubReceipt calldata receipt, bytes calldata hubSig) external returns (bytes32 claimId);
function contestReceiptDefault(bytes32 claimId, SettlementAck calldata ack, bytes calldata payeeSig) external;
function finalizeReceiptDefault(bytes32 claimId) external;
function slashForConflictingReceipts(
  BondedHubReceipt calldata r1,
  bytes calldata sig1,
  BondedHubReceipt calldata r2,
  bytes calldata sig2
) external;
```

### 16.6 `SCPSettlementRegistry` (Optional but Clean)

Responsibilities:

- Record `receiptId -> settled` status.
- Store payee-signed settlement acknowledgements.
- Let slash manager query whether a receipt was already settled.

This can be folded into `SCPSlashManager`, but keeping it separate makes the accounting cleaner.

### 16.7 `X402StateChannel`

Responsibilities:

- Remains the on-chain adjudicator for `A <-> H` and optionally `H <-> B`.
- Does not need to know about the staking token for the basic bonded-receipt design.

Optional extension:

- A `BondedX402StateChannel` wrapper or hook for stale-close slashing.

## 17. Recommended Implementation Sequence

### Phase 1

- `SCPToken`
- `SCPSeedSale`
- `SCPHubRegistry`
- `SCPStakeVault`
- `SCPSlashManager` with:
  - conflicting receipt slashing
  - receipt default slashing

### Phase 2

- add settlement adapters for on-chain downstream settlement proofs
- add stale-close slashing via channel hook or event-proof logic

### Phase 3

- optional stake-based routing tiers
- optional governance over slash parameters
- optional reserve/oracle model for tighter payment-asset coverage

## 18. Example Lifecycle

1. Hub buys SCP in the seed sale.
2. Hub stakes SCP and registers its signer.
3. Agent `A` opens a normal SCP channel with hub `H`.
4. Payee `B` advertises `statechannel-hub-bonded-v1`.
5. `A` requests a quote from `H`.
6. `H` returns `amount`, `fee`, and bonded receipt terms.
7. `A` signs upstream state.
8. `H` signs `BondedHubReceipt`.
9. `B` serves the request.
10. If `H` settles, `B` signs `SettlementAck` or on-chain proof is recorded.
11. If `H` does not settle by deadline, `B` opens a default claim.
12. If `H` cannot prove settlement during the dispute window, stake is slashed.

## 19. Security Notes

1. Slashing only works if receipt signing keys are tightly controlled.
2. Receipt ids and payment ids must be globally unique in the hub namespace.
3. Unstake delay is not optional; otherwise hubs can escape liability.
4. If slash penalties are token-denominated, token price volatility affects how much real coverage payees get.
5. For large-value payment guarantees, a pure token bond may be insufficient without an oracle-based policy or additional reserve layer.

## 20. Main Tradeoff

This design gives SCP a useful hub bond with real consequences, but it does **not** make hub routing fully trustless. It makes hub promises:

- economically bonded,
- objectively challengeable,
- and costly to violate.

That is a practical middle ground between today's trust-heavy receipt model and a much heavier fully on-chain settlement design.
