# T1 -- Fund Safety Audit

**Auditor:** Claude Opus 4.6 (automated)
**Date:** 2026-03-13
**Scope:** `X402StateChannel.sol`, `IX402StateChannel.sol`, `scp-hub/server.js`, `scp-hub/state-signing.js`, `scp-hub/ticket.js`, `scp-hub/storage.js`, `test/test_x402_state_channel.js`

---

## Contract Function-by-Function Review

### openChannel (line 56-116)
- **Access control:** Any address can call (msg.sender becomes participantA).
- **State mutations:** Creates channel struct, sets totalBalance, fundedBalA.
- **Value transfer:** `_collectAsset` enforces msg.value == amount (ETH) or transferFrom (ERC20).
- **Reentrancy:** No external calls before state writes (collectAsset called after struct creation but before balance write -- however the channel is already registered with `_usedChannelIds` preventing re-entry exploits).
- **Checks:** participantB != 0, challengePeriodSec > 0, channelExpiry > block.timestamp, amount > 0, hubFlags <= 3, no duplicate channelId.

### deposit (line 118-139)
- **Access control:** Only participantA or participantB.
- **State mutations:** Increases totalBalance, fundedBalA or fundedBalB.
- **Value transfer:** `_collectAsset` enforces exact amount.
- **Reentrancy:** Safe -- state updates after collectAsset, but no reentry vector since the channel already exists.

### cooperativeClose (line 141-158)
- **Access control:** Anyone can call (permissionless) but requires valid sigA and sigB from both participants.
- **State mutations:** Deletes channel, pays out.
- **Value transfer:** `_finalizeWithState` -> `_payoutAsset` for both participants.
- **Reentrancy:** Channel is deleted before payouts. Payout failure is deferred to pending mapping. Safe pattern.
- **Signature validation:** Both EIP-712 signatures checked. Nonce must be > latestNonce. balA + balB == totalBalance enforced.

### startClose (line 160-194)
- **Access control:** Only participantA or participantB. Requires counterparty signature.
- **State mutations:** Sets isClosing, closeDeadline, latestNonce, closeBalA, closeBalB.
- **Reentrancy:** No external calls.

### challenge (line 196-230)
- **Access control:** Only participantA or participantB. Requires counterparty signature.
- **Checks:** Must be closing, within deadline, newer.stateNonce > latestNonce, balA+balB == totalBalance.
- **State mutations:** Updates latestNonce, closeBalA, closeBalB. Does NOT extend deadline.
- **Reentrancy:** No external calls.

### finalizeClose (line 316-337)
- **Access control:** Anyone can call.
- **Checks:** Channel must exist, must be closing, deadline must have passed.
- **State mutations:** Deletes channel, pays out closeBalA and closeBalB.
- **Reentrancy:** Channel deleted before payouts. Same safe pattern as cooperativeClose.

### rebalance (line 232-314)
- **Access control:** Caller must be hub in source channel and participant in destination.
- **Signature validation:** Counterparty must sign the state.
- **Checks:** Both channels must exist and not be closing. Same asset. stateNonce > from.latestNonce. Amount <= hub's balance in signed state.
- **State mutations:** Shrinks from.totalBalance, grows to.totalBalance. Updates funded balances.
- **Reentrancy:** No external calls.

### withdrawPayout (line 419-434)
- **Access control:** msg.sender only.
- **State mutations:** Zeroes pending balance before external call (CEI pattern for ETH). For ERC20, zeroes before transfer. Safe.
- **Reentrancy:** Pending payout set to 0 before `.call{value}` -- correct CEI pattern.

---

## Findings

### [Medium] M-01: Hub register-payee-channel accepts arbitrary balances without on-chain verification

- **Location:** `x402s/node/scp-hub/server.js:1457-1482`
- **Root cause:** The `/v1/hub/register-payee-channel` endpoint accepts `body.totalDeposit` from the caller and stores it directly as `balA` without verifying the actual on-chain channel state. The payee authenticates via `requirePayeeAuth`, but the hub trusts the claimed `totalDeposit` value.
- **Impact:** A payee could register a hub-payee channel with an inflated `totalDeposit`/`balA`, causing the hub's internal accounting to believe more funds are available than actually deposited on-chain. When tickets are routed through this channel, the hub would sign states for balances exceeding the actual on-chain funds. During cooperative close settlement, the on-chain contract would reject if `balA + balB != totalBalance`, but the hub's internal ledger would be corrupted, potentially allowing the payee to claim more via the credit system than they earned.
- **Reproduction:**
  1. Payee opens a real channel on-chain with 100 USDC deposit.
  2. Payee calls `/v1/hub/register-payee-channel` with `totalDeposit: "1000000000"` (inflated).
  3. Hub stores `balA: "1000000000"` internally, believing hub has 1B USDC available in the channel.
  4. Hub routes payments through this channel, signing states against the inflated balance.
- **Recommendation:** When registering an external payee channel, fetch on-chain `getChannel(channelId)` to verify `totalBalance` matches the claimed `totalDeposit`, and verify the hub is actually a participant.

### [Medium] M-02: Refund issues signed state before atomic tx confirmation

- **Location:** `x402s/node/scp-hub/server.js:1078,1086-1142`
- **Root cause:** At line 1078, `signChannelState(refundState, wallet)` is called and `sigB` is computed BEFORE the atomic store transaction at line 1087. If the store tx rejects (e.g., due to TOCTOU conflict at lines 1090-1098), the signed refund state has already been generated. While the code correctly does NOT return the signed state to the caller when `_refundReject` is set (line 1141-1142), the signing key operation has already occurred. This is a defense-in-depth concern: a more subtle race or future code change could leak the pre-signed state.
- **Impact:** Low in current code (the signed state is not returned on rejection), but the pattern is fragile. If the refundState nonce matches a legitimately signed state in the future, it could create signature confusion.
- **Recommendation:** Move `signChannelState` inside the store tx (after all checks pass) or sign only after the tx succeeds.

### [Medium] M-03: Credit withdrawal sends only ETH regardless of channel asset

- **Location:** `x402s/node/scp-hub/server.js:2106-2162`
- **Root cause:** The `/v1/credit/withdraw` endpoint always sends ETH via `signer.sendTransaction` with `value` (line 2148), regardless of what asset the credits were accumulated from. Credits are accumulated from ticket amounts (line 954), which could be USDC or any ERC20 token. The withdrawal always sends native ETH.
- **Impact:** If credits were accumulated from ERC20 payments (e.g., USDC), the hub would send ETH of equivalent raw value, which would be a massive value mismatch (1 USDC unit = 1 wei of ETH). The user receives virtually nothing, or the hub overpays if the credit was from a low-decimal token. This is a fund-safety issue: either the hub loses ETH or the user cannot withdraw ERC20 credits.
- **Reproduction:**
  1. User accumulates 1000000 USDC credits (6 decimals = $1 USDC).
  2. User calls `/v1/credit/withdraw` with `amount: "1000000"`.
  3. Hub sends 1000000 wei of ETH (approximately $0.000000000000001) instead of 1 USDC.
- **Recommendation:** Track credit asset type alongside credit amount. When withdrawing, transfer the correct asset. Alternatively, restrict credit withdrawal to channels where the asset is native ETH, or add an `asset` parameter to the withdraw endpoint and perform the correct transfer type.

### [Medium] M-04: Close endpoint does not verify on-chain nonce before signing

- **Location:** `x402s/node/scp-hub/server.js:1852-1977`
- **Root cause:** The `/v1/channels/{id}/close` endpoint fetches on-chain data to verify `totalBalance` but does NOT compare the on-chain `latestNonce` with the hub's stored `latestNonce`. If a `startClose` was initiated on-chain (advancing the on-chain nonce), the hub might sign a close state with a nonce that is stale relative to the on-chain dispute state. The hub does check `onChainData.isClosing` at line 1879 for nonce-0 channels but NOT for channels with existing state.
- **Impact:** If a payer initiates a unilateral `startClose` on-chain and then requests a cooperative close from the hub, the hub could sign a cooperative close state that is valid on-chain but based on stale hub-side balances, potentially allowing the payer to close with a more favorable balance split than the latest disputed state.
- **Reproduction:**
  1. Payer and hub have a channel with nonce 5 (latest state: balA=30, balB=70).
  2. Payer calls `startClose` on-chain with nonce 5.
  3. Before challenge period expires, payer calls hub `/v1/channels/{id}/close`.
  4. Hub signs a cooperative close at nonce 6 using its stored state (which may not reflect the on-chain dispute).
  5. Payer submits `cooperativeClose` on-chain (which bypasses the dispute since `!ch.isClosing` is checked -- this actually blocks it).
- **Note:** The contract's `cooperativeClose` checks `!ch.isClosing`, so this attack vector is partially mitigated at the contract level. Reclassified as **Low** given the on-chain guard.
- **Recommendation:** Still advisable for the hub to check `isClosing` on-chain before signing close states, to avoid generating useless signatures and potential confusion.

### [Low] L-01: Challenge does not extend close deadline

- **Location:** `x402s/contracts/X402StateChannel.sol:196-230`
- **Root cause:** When `challenge()` is called with a newer state, it updates `latestNonce`, `closeBalA`, and `closeBalB` but does NOT extend `closeDeadline`. In some state channel designs, successful challenges reset the timer to allow further challenges.
- **Impact:** If the challenge period is short and there are multiple state updates, the window for submitting the latest state may be too narrow. An attacker could `startClose` with a stale state near the end of the challenge period, leaving insufficient time for the honest party to challenge. However, this is a design choice rather than a bug -- many state channel implementations do not extend the deadline.
- **Recommendation:** Consider extending the deadline by `challengePeriodSec` on each successful challenge, or document this as a known design tradeoff. Users should choose a sufficiently long `challengePeriodSec`.

### [Low] L-02: startClose allows same nonce (allowSameNonce=true)

- **Location:** `x402s/contracts/X402StateChannel.sol:172` (calls `_validateState(ch, st, true)`)
- **Root cause:** `startClose` uses `allowSameNonce=true` at line 172, meaning a participant can start a close with the same nonce as the currently stored `latestNonce`. Since `latestNonce` starts at 0 for a new channel, a participant could start a close at nonce 0 with `balA=totalBalance, balB=0` (the "default" state before any payments).
- **Impact:** A payer could attempt to close the channel at nonce 0 before any payments are processed, effectively reverting all off-chain payments. However, the counterparty (hub) can always challenge with the latest signed state at a higher nonce, so this is only exploitable if the hub is offline during the entire challenge period.
- **Recommendation:** This is by design (allows closing a channel that had no state updates). Ensure the hub monitors for `CloseStarted` events and challenges promptly.

### [Low] L-03: Pending payout accumulation without cap

- **Location:** `x402s/contracts/X402StateChannel.sol:529-539`
- **Root cause:** When `_payoutAsset` fails (e.g., a contract that rejects ETH), the amount is added to `_pendingEthPayout` or `_pendingErc20Payout`. There is no cap on how much can accumulate. If a participant is a contract that always rejects transfers, funds accumulate indefinitely.
- **Impact:** No direct loss -- funds can still be claimed via `withdrawPayout`. But if the recipient address is permanently unable to receive (e.g., a self-destructed contract), the funds are locked forever in the contract.
- **Recommendation:** This is standard behavior for pull-payment patterns. Consider adding a time-limited recovery mechanism or documenting the risk.

### [Low] L-04: Cooperative close on settle path does not verify on-chain isClosing

- **Location:** `x402s/node/scp-hub/server.js:1638-1679`
- **Root cause:** The payee settle endpoint (`/v1/payee/settle`) with `cooperative_close` mode calls `contract.cooperativeClose()` at line 1673 without first checking if the channel is in a closing/dispute state on-chain. If the channel is already in a `startClose` dispute, `cooperativeClose` will revert, and the error handling at line 1706-1733 will correctly revert the settling entries. But this wastes gas.
- **Impact:** Gas waste only. The on-chain contract correctly rejects cooperativeClose during disputes.
- **Recommendation:** Fetch `getChannel` on-chain and check `isClosing` before attempting the cooperative close transaction.

### [Info] I-01: Contract balance invariant is sound

- **Location:** `x402s/contracts/X402StateChannel.sol:471`
- **Root cause:** N/A -- this is a positive finding.
- The `_validateState` function enforces `balA + balB == ch.totalBalance` for ALL state transitions (cooperativeClose, startClose, challenge). This invariant ensures no funds can be created or destroyed during close. Solidity 0.8.28 overflow protection prevents `balA + balB` from wrapping.
- Since `_collectAsset` enforces exact deposits and `_payoutAsset` pays out at most the sum of close balances, **funds cannot be inflated via the contract**.

### [Info] I-02: challengePeriodSec > 0 is enforced

- **Location:** `x402s/contracts/X402StateChannel.sol:66`
- A zero challenge period (which would allow instant finalization after startClose) is explicitly rejected. No issue found.

### [Info] I-03: Channel ID reuse is prevented

- **Location:** `x402s/contracts/X402StateChannel.sol:74-75`
- The `_usedChannelIds` mapping persists even after channel deletion. A closed channel's ID cannot be reused, preventing replay of old close signatures against a new channel.

### [Info] I-04: Signature malleability protection is present

- **Location:** `x402s/contracts/X402StateChannel.sol:498`
- The `_recover` function enforces `s <= secp256k1n/2` per EIP-2, preventing signature malleability.

### [Info] I-05: Hub verifies on-chain state for first-seen channels

- **Location:** `x402s/node/scp-hub/server.js:713-781`
- For first ticket issuance on a new channel, the hub performs comprehensive on-chain verification: channel existence, hub participation, asset match, liveness, balance invariant. This prevents fabricated channel attacks.

### [Info] I-06: Hub close path uses stored creditApplied (not caller input)

- **Location:** `x402s/node/scp-hub/server.js:1996-2021`
- The `confirm-close` endpoint uses `ch.pendingCloseCredit` from the hub's own store, NOT from the caller's request body. This prevents a caller from inflating the credit consumed on close.

### [Info] I-07: Refund double-spend protection is sound

- **Location:** `x402s/node/scp-hub/server.js:1087-1140`
- Refund atomicity: The store transaction re-checks payment status (TOCTOU guard at line 1089-1092), re-checks cumulative refund amount (line 1094-1098), and verifies payee has sufficient credits to reverse (line 1100-1108, V5 guard prevents withdraw-then-refund drain). This is a well-designed defense against double-refund attacks.

### [Info] I-08: Reentrancy in contract payouts is safe

- **Location:** `x402s/contracts/X402StateChannel.sol:542-552`
- In `_finalizeWithState`, the channel is deleted (`delete _channels[st.channelId]`) BEFORE any external calls in `_payoutAsset`. This follows the checks-effects-interactions pattern. Even if a recipient contract re-enters, the channel no longer exists.
- In `withdrawPayout`, pending balance is zeroed before the `.call{value}`. Safe CEI pattern.

---

## Summary

| Severity | Count | Description |
|----------|-------|-------------|
| Critical | 0     | No critical fund-safety issues found |
| High     | 0     | No high-severity issues found |
| Medium   | 3     | M-01: Unverified payee channel registration; M-02: Pre-signed refund state; M-03: Credit withdrawal asset mismatch |
| Low      | 4     | L-01: No deadline extension on challenge; L-02: startClose allows nonce 0; L-03: Uncapped pending payouts; L-04: No isClosing pre-check on settle |
| Info     | 8     | Positive findings and design confirmations |

The on-chain contract (`X402StateChannel.sol`) is well-designed with proper balance invariants, signature verification, reentrancy protection, and replay prevention. The primary fund-safety risks are in the hub's off-chain accounting layer, particularly around the credit system (M-03) and the trust placed in payee-supplied data during channel registration (M-01).
