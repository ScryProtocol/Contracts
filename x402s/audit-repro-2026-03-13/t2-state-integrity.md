## T2 -- State Integrity Findings

Audit date: 2026-03-13
Scope: `x402s/node/scp-hub/server.js`, `storage.js`, `state-signing.js`, `ticket.js`, and related tests.
Auditor: Claude Opus 4.6

---

### Critical: MemoryBackend.tx() does not await or return mutator result

- **Location:** `x402s/node/scp-hub/storage.js:51-53`
- **Root cause:** `MemoryBackend.tx()` calls `mutator(this.state)` but does not `await` the result (async mutators silently fire-and-forget) and does not `return` the mutator's return value. Compare:
  - `JsonFileBackend.tx()` (line 195-197): `return this._withWrite((state) => mutator(state))` -- correctly awaits and returns.
  - `RedisBackend.tx()` (line 244-265): `await mutator(state)` -- correctly awaits (but also does not return the mutator's return value, see High finding below).
  - `MemoryBackend.tx()` (line 51-53): `mutator(this.state)` -- neither `await` nor `return`.
- **Impact:** Two distinct consequences:
  1. **Silent data loss with async mutators:** If any `store.tx()` mutator is `async` or returns a Promise, the mutation may not complete before subsequent reads, causing corrupted state. In the current server.js, all tx mutators are synchronous closures, so this is latent -- but any future async mutator will silently break.
  2. **Return value discarded:** Multiple call sites read the return value of `store.tx()` to extract data from inside the atomic section. For example:
     - `server.js:552-554`: `const credits = await store.tx((s) => { return s.payerCredits?.[payerKey] || "0"; });` -- This returns `undefined` with MemoryBackend, causing `BigInt(undefined)` to throw or `payerCredit` to be wrong.
     - `server.js:1256`: `const credits = await store.tx((s) => s.payerCredits?.[...] || "0");` -- Same issue.
     - `server.js:1934`: `await store.tx((s) => BigInt(s.payerCredits?.[payerKey] || "0"))` -- Used in close-channel credit calculation.
     - `server.js:2100-2102`: Credit balance endpoint reads via `store.tx()` return value.
     - `server.js:2141`: Replay check `await store.tx((s) => !!(s.spentWithdrawNonces?.[nonce]))`.
  With MemoryBackend (used in all tests and `:memory:` mode), these return `undefined` instead of the intended value, causing credit balance lookups to fail and potentially allowing payments without proper credit checks.
- **Reproduction:**
  1. Start hub with `:memory:` storage (default for tests).
  2. Issue tickets to accumulate payer credits.
  3. Call `GET /v1/credit/balance?address=0x...` -- returns `undefined` instead of the credit amount.
  4. Call `GET /v1/channels/<id>` -- `payerCredit` field is `undefined`.
- **Recommendation:** Fix `MemoryBackend.tx()` to:
  ```js
  async tx(mutator) {
    return await mutator(this.state);
  }
  ```

---

### High: RedisBackend.tx() does not return the mutator's result

- **Location:** `x402s/node/scp-hub/storage.js:244-265`
- **Root cause:** `RedisBackend.tx()` calls `await mutator(state)` but discards the return value. On line 255 it returns `undefined` on success (`if (result !== null) return;`). The `result` variable here is the Redis MULTI/EXEC result, not the mutator's return value.
- **Impact:** Same as MemoryBackend -- all `store.tx()` call sites that read the return value get `undefined` when using Redis. This affects credit balance lookups, channel info endpoints, and the withdrawal replay check in production (Redis) deployments.
- **Recommendation:** Capture and return the mutator result:
  ```js
  const mutatorResult = await mutator(state);
  const multi = this.r.multi();
  multi.set(this.stateKey, JSON.stringify(state));
  const result = await multi.exec();
  if (result !== null) return mutatorResult;
  ```

---

### High: Credit nonce replay map is globally keyed, not per-signer

- **Location:** `x402s/node/scp-hub/server.js:2058-2064` (credit/pay) and `x402s/node/scp-hub/server.js:2129-2136` (credit/withdraw)
- **Root cause:** The credit payment replay map `s.spentCreditNonces` is keyed by `cpNonce` alone (line 2059: `s.spentCreditNonces[cpNonce]`). The withdrawal replay map `s.spentWithdrawNonces` is keyed by `nonce` alone (line 2130: `s.spentWithdrawNonces[nonce]`). Neither is scoped to the signer's address.
- **Impact:** An attacker (user A) who observes or guesses the nonce string used by user B can preemptively "burn" that nonce by submitting a valid credit-pay or withdrawal with the same nonce string from their own address. This is a denial-of-service vector: user B's legitimate transaction will be rejected as "nonce already used" even though they never submitted it. In practice, if nonces are random UUIDs the collision probability is low, but the protocol design is unsound -- nonces should be scoped per signer.
- **Reproduction:**
  1. User A submits `POST /v1/credit/pay` with `nonce: "abc123"` and their own valid signature.
  2. User B (different address) later submits `POST /v1/credit/pay` with `nonce: "abc123"` and their own valid signature.
  3. User B's request is rejected as replay even though user B never used this nonce.
- **Recommendation:** Key replay maps by `(address, nonce)`:
  ```js
  const replayKey = `${payerKey}:${cpNonce}`;
  if (s.spentCreditNonces[replayKey]) { txResult = "replay"; return; }
  ```
  Same for `spentWithdrawNonces`.

---

### Medium: Quote existence is re-verified inside store.tx(), but ticket is signed BEFORE the atomic section

- **Location:** `x402s/node/scp-hub/server.js:783-793` (ticket signing) and `x402s/node/scp-hub/server.js:834-956` (atomic tx)
- **Root cause:** The issue handler signs the ticket (line 783) and the channel state (line 792) **before** entering the atomic `store.tx()` that deletes the quote and checks for concurrent issues (line 834). The atomic section correctly rechecks quote existence (line 837: `if (!s.quotes[key])`) and nonce CAS (line 843-844), using the `_txReject` pattern to signal failure after the tx completes (line 957-959). If a concurrent request races, one will get `_txReject` set and the signed ticket/state will be discarded (never returned to the client).

  **This is architecturally sound** -- the signed artifacts are ephemeral until returned to the client, and the `_txReject` gate prevents them from being returned. However, there is a **side-channel concern**: the hub performs expensive signing operations (two EIP-712 signatures + one ticket signature) and hub-payee channel capacity pre-validation (lines 806-828) for requests that will ultimately be rejected. Under load, an attacker could submit many parallel issue requests for the same quote, forcing the hub to perform O(N) signing operations even though only one succeeds.

- **Impact:** CPU-based denial of service. Each rejected-but-signed request wastes ~3 cryptographic signing operations. An attacker with a valid quote can amplify hub CPU usage by submitting parallel issue requests.
- **Reproduction:**
  1. Obtain a valid quote.
  2. Submit 100 parallel `POST /v1/tickets/issue` requests with the same quote.
  3. Only 1 succeeds (correct); the other 99 force 99 * 3 = 297 wasted signature computations.
- **Recommendation:** Move the atomic CAS check (quote existence + nonce check) **before** signing. Acquire a short-lived lock or use a "claimed" flag in the quote to prevent parallel signing. Alternatively, accept this as a rate-limit concern and ensure `RATE_LIMIT_ISSUE` is set low enough.

---

### Medium: Withdrawal failure keeps nonce spent but re-credits balance, enabling griefing

- **Location:** `x402s/node/scp-hub/server.js:2146-2161`
- **Root cause:** When a withdrawal transaction fails on-chain (line 2152 catch block), the hub re-credits the balance (line 2154-2158) but the nonce remains spent (line 2136). The comment on line 2153 says "nonce stays spent to prevent retry of same sig." This means the user's signed withdrawal authorization is permanently burned even though no funds were transferred.
- **Impact:** If the hub's on-chain transaction fails (e.g., insufficient gas, network congestion, node outage), the user loses their withdrawal nonce and must generate a new signature. While this prevents replay attacks, it creates a griefing vector: if the hub operator intentionally runs with insufficient ETH to cover withdrawals, user withdrawal nonces are consumed without delivering funds. The user's credit balance is restored, but they must sign a new message with a new nonce each time.
- **Recommendation:** Consider adding a `failed` status to the nonce map that allows the same nonce to be retried once, or allow nonce reuse when the recorded status is `failed`.

---

### Medium: No cross-network validation -- quote chainId not compared to channel's on-chain chainId

- **Location:** `x402s/node/scp-hub/server.js:500-577` (quote handler) and `x402s/node/scp-hub/server.js:580-1001` (issue handler)
- **Root cause:** The hub is configured with a single `CHAIN_ID` (line 28-37). The quote stores `chainId` inside `policyHash` (line 525) but the issue handler never verifies that the submitted channel lives on the same chain. The on-chain `getChannel()` call (line 727) goes to the hub's configured `CONTRACT_ADDRESS` on the hub's `RPC_URL`, so a channel on a different chain would simply not be found. However, the EIP-712 domain separator used for state signing embeds `CHAIN_ID` and `CONTRACT_ADDRESS` (line 101), so signatures are chain-bound.

  **No cross-network issue found for a single-hub deployment.** The hub is single-chain by design. A channel on Base cannot produce a valid EIP-712 signature that the hub configured for Sepolia would accept, because the domain separator includes the chain ID. The `policyHash` in the quote additionally binds the chain ID.

- **Impact:** None for single-chain hubs. If multi-chain support is added without per-chain domain separation, this would become critical.
- **Recommendation:** No action required for current architecture. If multi-chain support is added, ensure channel chain ID is explicitly validated in the issue handler.

---

### Low: store.tx() return value used for read-only queries creates backend parity gap

- **Location:** `x402s/node/scp-hub/server.js:552`, `1256`, `1934`, `2100`, `2141`
- **Root cause:** The code uses `store.tx((s) => s.payerCredits?.[key] || "0")` as a read-only query pattern, relying on the return value of `tx()`. This works on `JsonFileBackend` (which properly returns via `_withWrite`) but fails on `MemoryBackend` and `RedisBackend` (see Critical and High findings above). This is a parity gap between storage backends.
- **Impact:** Tests using `:memory:` backend will not catch credit-related bugs because the return value is always `undefined`. Production using Redis will also get `undefined`. Only the JSON file backend returns correct values.
- **Recommendation:** Either fix all backends to return the mutator result (preferred), or add a dedicated `readTx()` method, or use `store.get()` for read-only access instead of `tx()`.

---

### Low: Payer credit accumulation has no cap -- credits can exceed total payments received

- **Location:** `x402s/node/scp-hub/server.js:949-955`
- **Root cause:** Every issued ticket credits the payee address: `s.payerCredits[creditKey] = (prev + BigInt(ticket.amount)).toString()` (line 954). Credits accumulate without a maximum cap. While credits are debited on settlement (line 1750-1754) and on refund (line 1138), there is no invariant check that `payerCredits[addr] <= total payments received by addr`. If there is a bug in debit logic (e.g., the MemoryBackend `tx()` return-value bug above causes a debit to be skipped), credits could grow unboundedly.
- **Impact:** If any credit debit operation silently fails (which it does on MemoryBackend due to the Critical finding), the credit balance can exceed the total payments received, allowing over-withdrawal.
- **Recommendation:** Add a periodic reconciliation check that `payerCredits[addr] <= sum(issued payments to addr) - sum(settled + credit_consumed for addr)`. Log warnings when invariant is violated.

---

### Low: Ticket signed before quote consumed -- signed artifacts exist in memory during TOCTOU window

- **Location:** `x402s/node/scp-hub/server.js:783-834`
- **Root cause:** The signed ticket and signed channel state exist in local variables between lines 783-834 before the atomic tx deletes the quote. While the `_txReject` pattern prevents them from being returned to the client on conflict, they exist in the Node.js heap during this window. If the process crashes between signing and the tx commit, no state corruption occurs (the quote is still present, the ticket was never returned). This is a defense-in-depth observation, not a practical exploit.
- **Impact:** Negligible. The signed artifacts are never persisted or returned unless the atomic tx succeeds.
- **Recommendation:** No action required. The current design is acceptable.

---

### Info: Continuation nonce is strictly sequential (correctly enforced)

- **Location:** `x402s/node/scp-hub/server.js:638`
- **Root cause:** Line 638 checks `Number(body.channelState.stateNonce) !== Number(existingChannel.latestNonce) + 1`, which enforces strict +1 sequentiality for continuation issues. This is correct.
- **Impact:** None -- this is a positive finding.

---

### Info: On-chain liveness check fails closed for continuation issues (correctly enforced)

- **Location:** `x402s/node/scp-hub/server.js:658-663`
- **Root cause:** When the RPC call to verify on-chain liveness fails, the hub returns 503 (line 661-662) and refuses to issue the ticket. The comment on line 659 explicitly notes "fail-closed." This is the correct security posture.
- **Impact:** None -- this is a positive finding.

---

### Info: Quote-to-issue atomicity uses correct two-phase CAS pattern

- **Location:** `x402s/node/scp-hub/server.js:834-956`
- **Root cause:** The atomic `store.tx()` section performs all CAS checks (quote existence at line 837, nonce CAS at line 843-844, credit check at line 849-856, hub-payee nonce CAS at line 860-861) in Phase 1 before any mutations in Phase 2. The `_txReject` flag is checked after tx completes (line 957). Two parallel issue requests for the same quote cannot both succeed because the first to enter the tx will delete the quote (line 872), and the second will find it missing (line 837-839).
- **Impact:** None -- this is a positive finding. The double-issue race is correctly prevented.

---

### Info: JsonFileBackend provides proper snapshot isolation via file locking

- **Location:** `x402s/node/scp-hub/storage.js:145-158`
- **Root cause:** `_withWrite()` acquires a file lock, reloads from disk (line 149), runs the mutator (line 150), flushes (line 151), then releases the lock. The `_saveChain` serializes concurrent writes within the same process. This provides correct isolation for single-instance deployments.
- **Impact:** None -- this is a positive finding.

---

### Info: RedisBackend uses WATCH/MULTI for optimistic concurrency (correct pattern)

- **Location:** `x402s/node/scp-hub/storage.js:244-265`
- **Root cause:** Redis WATCH + MULTI/EXEC provides optimistic locking. If another client modifies the watched key between WATCH and EXEC, EXEC returns null and the operation retries (up to 25 times). This is the standard Redis pattern for CAS operations.
- **Impact:** None -- this is a positive finding (aside from the return-value issue noted in the High finding).

---

## Summary

| Severity | Count | Key Findings |
|----------|-------|--------------|
| Critical | 1     | MemoryBackend.tx() silently drops return value and does not await async mutators |
| High     | 2     | RedisBackend.tx() drops return value; credit nonce replay maps not scoped per signer |
| Medium   | 3     | Ticket signed before atomic CAS (CPU DoS); withdrawal nonce burned on tx failure; no cross-network gap (confirmed safe) |
| Low      | 3     | Backend parity gap on tx() return; no credit cap; signed artifacts in memory during TOCTOU window |
| Info     | 4     | Continuation nonce sequential (correct); fail-closed liveness (correct); quote-issue CAS (correct); storage isolation (correct) |
