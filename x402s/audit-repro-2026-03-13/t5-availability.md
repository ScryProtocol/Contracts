# T5 -- Availability & DoS Findings

**Auditor:** Claude Opus 4.6
**Date:** 2026-03-13
**Scope:** x402s SCP hub availability, DoS resistance, fail-open/fail-closed behavior
**Files reviewed:**
- `x402s/node/scp-hub/server.js` (2336 lines)
- `x402s/node/scp-hub/storage.js` (447 lines)
- `x402s/node/scp-hub/webhooks.js` (303 lines)
- `x402s/node/scp-common/networks.js` (119 lines)
- `x402s/contracts/X402StateChannel.sol` (613 lines)

---

## 1. Nonce Collision Scope

### High -- Global nonce maps allow cross-user nonce collision DoS

- **Location:** `server.js:2058-2064` (`spentCreditNonces`), `server.js:2129-2136` (`spentWithdrawNonces`)
- **Root cause:** Both `spentCreditNonces` and `spentWithdrawNonces` are keyed by the nonce string alone, not by `(signerAddress, nonce)`. The maps are structured as `s.spentCreditNonces[cpNonce]` and `s.spentWithdrawNonces[nonce]`, where the key is the raw nonce value without any signer prefix.
- **Impact:** An attacker who observes (or guesses) a nonce that another user intends to use can race to submit a credit-pay or withdraw request with that same nonce value first, causing the legitimate user's request to be rejected as "nonce already used." Because nonces are typically sequential or predictable (e.g., timestamps, counters), this is practical. The attacker only needs a valid signature from *their own* key -- the nonce collision check happens before the signature-mismatch check would matter, since both entries land in the same global map.
- **Reproduction:**
  1. User A prepares a credit-pay with `nonce: "abc123"` signed by their key.
  2. Attacker B submits a credit-pay with `nonce: "abc123"` signed by their own key, for a valid (possibly self-to-self) transfer.
  3. Attacker B's request succeeds and marks `spentCreditNonces["abc123"] = timestamp`.
  4. User A's request is rejected at line 2059: `s.spentCreditNonces[cpNonce]` is truthy.
  5. Same attack works for `spentWithdrawNonces` at line 2130.
- **Recommendation:** Key nonce maps by `(signerAddress, nonce)`. Replace:
  ```js
  s.spentCreditNonces[cpNonce]
  ```
  with:
  ```js
  s.spentCreditNonces[`${payerKey}:${cpNonce}`]
  ```
  And similarly for `spentWithdrawNonces`:
  ```js
  s.spentWithdrawNonces[`${addr}:${nonce}`]
  ```
- **Prior finding status:** NOT FIXED. The nonces remain globally scoped.

---

## 2. Contract Gas Consumption

### Info -- No unbounded gas loops in core contract operations

- **Location:** `X402StateChannel.sol`
- **Analysis:** All core operations (`cooperativeClose`, `startClose`, `challenge`, `finalizeClose`, `rebalance`, `deposit`) operate on a single channel with O(1) gas. There are no loops over dynamic arrays in any of these functions.
- **Details:**
  - `cooperativeClose` (line 141-158): two signature recoveries, one `_finalizeWithState` call, constant gas.
  - `startClose` (line 160-194): one signature recovery, constant storage writes.
  - `challenge` (line 196-230): one signature recovery, constant storage writes.
  - `finalizeClose` (line 316-337): reads stored values, calls `_removeActiveChannel`, two `_payoutAsset` calls.
  - `_removeActiveChannel` (lines 573-612): uses swap-and-pop pattern with O(1) index lookups via `_channelIndexPlusOne` and `_channelsByParticipantIndexPlusOne`. No iteration.
  - `_payoutAsset` (lines 519-540): single transfer, with deferred payout fallback. No loop.
- **View functions with potential gas concerns:**
  - `getChannelIds(offset, limit)` (line 366-380): bounded by caller-supplied `limit`. The loop iterates exactly `min(limit, _channelIds.length - offset)` times. A malicious caller could request a large `limit`, but this is a `view` function and does not affect on-chain state or other users' transactions.
  - `getChannelsByParticipant(participant)` (line 382-389): returns the full `_channelsByParticipant[participant]` array. If a participant has a very large number of channels, this could hit gas limits in an on-chain call context. However, this is a `view` function and is not called by any state-changing function.

**No issues found in this category for state-changing functions.**

---

## 3. Fail-Open / Fail-Closed Analysis

### Systematic catch/error handler audit

| Location | Error Type | Behavior | Notes |
|---|---|---|---|
| `server.js:658-663` | RPC liveness check failure on continuation issue | **CLOSED** | Returns 503 with comment "H2: fail-closed" |
| `server.js:677-682` | RPC reconciliation failure | **OPEN** | `console.warn` only; continues to balance check which will reject if mismatch. Effectively closed due to subsequent check at line 693. |
| `server.js:728-731` | RPC lookup failure on first-seen channel | **CLOSED** | Returns 409 |
| `server.js:1191-1196` | Chunk scan failure in channel lookup | **OPEN** (info-only) | `console.warn`, skips chunk, continues scan. Acceptable: lookup is informational. |
| `server.js:1200-1205` | getChannel failure in lookup enrichment | **OPEN** (info-only) | Pushes partial data without balance. Acceptable: lookup is informational. |
| `server.js:1207-1209` | Full on-chain scan error in lookup | **OPEN** (info-only) | `console.log`, continues to store lookup. Acceptable: lookup is read-only. |
| `server.js:1220` | RPC failure in store lookup enrichment | **OPEN** (info-only) | Empty catch, uses default `tb = "0"`. Acceptable: read-only. |
| `server.js:1251` | RPC failure in channel detail view | **OPEN** (info-only) | Empty catch, `onChainTotal` stays null. Acceptable: read-only. |
| `server.js:1452-1454` | openChannel tx failure | **CLOSED** | Returns 500 |
| `server.js:1706-1733` | Settlement tx failure | **CLOSED** | Rolls back ledger entries to "issued" status, records settlement as "failed" |
| `server.js:1887-1889` | RPC failure in close flow | **CLOSED** | Returns 404 |
| `server.js:1914-1916` | RPC failure in close on-chain lookup | **CLOSED** | Returns 503 |
| `server.js:1993-1995` | RPC failure in confirm-close | **CLOSED** | Returns 503 |
| `server.js:2268-2276` | Top-level catch | **CLOSED** | 413/400/500 returned to client |

### Medium -- Webhook delivery errors silently retry without backpressure

- **Location:** `webhooks.js:277-293`
- **Root cause:** Each failed webhook delivery schedules exponential backoff retries via `setTimeout` (up to 5 retries per event). The `_timers` set tracks active timers but there is no upper bound on total pending retries. If a webhook endpoint is consistently down and events are emitted rapidly, retry timers accumulate in memory.
- **Impact:** With rapid event emission (e.g., many payments per second) and a failing webhook endpoint, the timer count grows as `O(events * MAX_RETRIES)`. Each timer holds a closure over the payload. With 1000 events/sec and 5 retries with exponential delays up to 64s, hundreds of thousands of pending timers could accumulate, consuming memory and scheduling overhead.
- **Reproduction:**
  1. Register a webhook pointing to an unreachable endpoint.
  2. Emit events at high rate (e.g., via rapid payments).
  3. Observe memory growth from accumulated retry timers.
- **Recommendation:** Add a cap on total pending retries per hook (e.g., `MAX_PENDING_PER_HOOK = 100`). Drop new deliveries when the cap is reached.

### Info -- All security-critical paths fail closed

The `/v1/tickets/issue` endpoint consistently fails closed on RPC errors (lines 658-663, 728-731). The top-level handler (line 2268-2276) catches all unhandled errors and returns error responses. No security-critical path continues processing after an error.

---

## 4. RPC Failure Handling

### Medium -- Synchronous RPC calls block the event loop with no timeout

- **Location:** `server.js:649-650`, `server.js:726-727`, `server.js:1181-1202`, `server.js:1247-1250`, `server.js:1672-1674`, `server.js:1908-1910`, `server.js:1988-1990`
- **Root cause:** Every RPC call uses `ethers.providers.JsonRpcProvider` with default configuration. The ethers.js v5 `JsonRpcProvider` does not have a built-in request timeout. If the RPC endpoint hangs (accepts TCP connection but never responds), the `await` will block the request handler indefinitely. Since Node.js is single-threaded, this does not block the event loop for *other* requests (the await yields), but it does hold the HTTP connection open indefinitely.
- **Impact:** If the configured RPC provider (`RPC_URL`) becomes unresponsive:
  1. Every `/v1/tickets/issue` request hangs indefinitely (on-chain liveness check at line 649-650).
  2. Every `/v1/channels/lookup` request hangs (line 1183).
  3. Every `/v1/payee/settle` with cooperative_close hangs (line 1672-1674).
  4. Every `/v1/channels/.../close` request hangs (line 1908-1910).
  5. HTTP connections accumulate until the OS connection limit is reached, causing a full hub outage.
- **Reproduction:**
  1. Set `RPC_URL` to a server that accepts connections but drops all data (e.g., `socat TCP-LISTEN:8545,fork /dev/null`).
  2. Send a `/v1/tickets/issue` request.
  3. Observe the request never completes.
  4. Repeat to accumulate hanging connections.
- **Recommendation:** Create the provider with a timeout:
  ```js
  const provider = new ethers.providers.JsonRpcProvider({
    url: RPC_URL,
    timeout: 10000  // 10 seconds
  });
  ```
  Or wrap each RPC call in `Promise.race` with a timeout. Also consider HTTP server-level request timeouts via `server.setTimeout(30000)`.

### Medium -- New provider instance created per-request on several endpoints

- **Location:** `server.js:1181`, `server.js:1219-1220`, `server.js:1247`
- **Root cause:** The `/v1/channels/lookup` and `/v1/channels/:id` endpoints create a new `ethers.providers.JsonRpcProvider(RPC_URL)` on every request rather than reusing the cached provider from `getHubSigner()`. Each new provider creates a new HTTP connection and may trigger rate limits on the RPC endpoint.
- **Impact:** Under load, the hub generates excessive RPC connections. Free-tier RPC providers (as configured in `networks.js`: `llamarpc.com`, `publicnode.com`, `base.org`) typically have connection rate limits. Exceeding these limits causes RPC failures, which cascades to ticket issuance failures (fail-closed on liveness check).
- **Recommendation:** Reuse the provider from `getHubSigner()` or maintain a single cached provider instance.

### Low -- Provider cache has 5-minute TTL with no connection pooling

- **Location:** `server.js:115-122`
- **Root cause:** `getHubSigner()` caches the provider/signer for 5 minutes (`300000ms`). After expiry, a new provider is created, which drops any persistent HTTP keep-alive connection. During the recreation window, concurrent requests may create multiple providers.
- **Impact:** Minor. Brief connection storms every 5 minutes.
- **Recommendation:** Use a longer TTL or only recreate on connection error.

---

## 5. Storage Concurrency

### High -- MemoryBackend tx() is not atomic under concurrent async operations

- **Location:** `storage.js:51-53`
- **Root cause:** `MemoryBackend.tx()` calls `mutator(this.state)` synchronously, but the mutator function in `server.js` is often *synchronous* (no awaits inside). However, the critical issue is that `tx()` does not implement any locking. If two async request handlers call `store.tx()` concurrently, and the mutators contain any `await` (or even just interleave due to microtask scheduling with synchronous mutators that read-then-write), state can be corrupted.

  Examining the mutators in `server.js`:
  - The issue tx at line 834 is synchronous (no awaits inside the mutator) -- safe for MemoryBackend since JS is single-threaded and synchronous code won't yield.
  - The refund tx at line 1087 is synchronous -- safe.
  - The credit-pay tx at line 2057 is synchronous -- safe.
  - The withdraw tx at line 2128 is synchronous -- safe.

  **Revised assessment:** Because all `tx()` mutators in `server.js` are synchronous (no `await` inside the function passed to `tx()`), and JavaScript's event loop guarantees a synchronous function runs to completion without yielding, MemoryBackend's `tx()` is effectively atomic for the current codebase. However, this is a fragile invariant: adding a single `await` inside any mutator breaks atomicity silently.

- **Impact:** Currently safe but brittle. Any future change adding an async operation inside a `tx()` mutator will silently break atomicity without any runtime error or warning.
- **Recommendation:** Add a warning comment and/or assertion in `MemoryBackend.tx()`:
  ```js
  async tx(mutator) {
    const result = mutator(this.state);
    // If mutator returns a Promise, atomicity is broken
    if (result && typeof result.then === 'function') {
      throw new Error('MemoryBackend.tx() mutator must be synchronous');
    }
  }
  ```

### Medium -- JsonFileBackend concurrent reads bypass the lock

- **Location:** `storage.js:160-163`, `storage.js:177-179`, `storage.js:181-183`, `storage.js:198-200`
- **Root cause:** `get()`, `getSeq()`, `getLedger()`, and `listPayments()` call `this._reloadFromDisk()` without acquiring the file lock. Meanwhile, `_withWrite()` (used by `set()`, `tx()`, etc.) acquires the lock, reloads, mutates, and flushes. If a read occurs during the flush window (between the mutator completing and `_flushUnlocked()` finishing the rename), the read gets stale data.
- **Impact:** Stale reads during concurrent write operations. For the hub, this could cause a quote lookup to return stale data or a nonce check to miss a recently committed nonce. The window is small (milliseconds) but exists.
- **Recommendation:** Either acquire a read lock or read from the in-memory state (which is updated before flush).

### Info -- RedisBackend uses WATCH/MULTI/EXEC correctly

- **Location:** `storage.js:244-265`
- **Root cause:** N/A -- this is correct.
- **Details:** `RedisBackend.tx()` uses Redis optimistic locking: `WATCH` the key, load state, apply mutator, `MULTI`/`SET`/`EXEC`. If another client modified the key between WATCH and EXEC, `exec()` returns `null` and the operation retries (up to 25 times). This is correct optimistic concurrency control.

### Low -- RedisBackend stores entire state as single JSON blob

- **Location:** `storage.js:252-254`
- **Root cause:** All hub state (channels, payments, quotes, ledgers, nonces, credits) is serialized as a single JSON string under key `scp:state`. Every `tx()` call reads and writes the entire blob.
- **Impact:** As state grows (thousands of payments, ledger entries), JSON serialization/deserialization becomes a bottleneck. At ~10,000 payments with associated indexes, the JSON blob could be several MB, and every `tx()` call involves parsing and re-serializing it. This creates increasing latency under load and increases the probability of WATCH conflicts (since any write to any part of state conflicts with all other writes).
- **Recommendation:** For production, split state into separate Redis keys (e.g., `scp:payments:{id}`, `scp:channels:{id}`, `scp:nonces:{signer}:{nonce}`). This reduces contention and serialization overhead.

---

## 6. Cluster Mode Safety

### Info -- Cluster mode is gated with safety checks

- **Location:** `server.js:7` (import), `server.js:2287-2304` (startCluster), `server.js:2306-2328` (main)
- **Details:** `cluster` is imported and used. Cluster mode activates when `WORKERS > 1` or `HUB_CLUSTER=1`. The code has two safety gates:
  1. **Line 2308-2314:** Blocks cluster mode with `:memory:` storage (MemoryBackend is per-worker, not shared). Requires `STORE_PATH` or `REDIS_URL`.
  2. **Line 2315-2322:** Blocks cluster mode by default with `ALLOW_UNSAFE_CLUSTER=1` override, with an explicit warning that "some in-memory subsystems are worker-local."

### Medium -- Cluster mode with JsonFileBackend has race conditions

- **Location:** `server.js:2308-2314`, `storage.js:122-157`
- **Root cause:** The cluster mode safety check at line 2308 only blocks `:memory:` storage. It permits `JsonFileBackend` (any STORE_PATH that isn't `:memory:`). The `JsonFileBackend` uses a file lock (`_acquireLock`) which creates a `.lock` file with `O_WRONLY | O_CREAT | O_EXCL` semantics. This is adequate for inter-process locking on the same host. However:
  1. The `_saveChain` promise chain (line 66/146) is per-process. Workers serialize their own writes but can interleave with other workers at the file level.
  2. Read operations (`get()`, `getSeq()`, etc.) do NOT acquire the lock (as noted in finding 5 above). With multiple workers, stale reads become much more likely.
- **Impact:** With `ALLOW_UNSAFE_CLUSTER=1` and JsonFileBackend, concurrent workers could issue duplicate tickets for the same quote (race between lock-acquire and stale read of quote existence).
- **Recommendation:** The existing safety gate is appropriate. Consider also blocking JsonFileBackend in cluster mode, or adding a warning in the error message.

### Medium -- Worker-local state not shared in cluster mode

- **Location:** `server.js:127-128` (`rateWindow`, `lastQuoteSweepAt`), `webhooks.js:70-76` (`hooks`, `eventLog`)
- **Root cause:** Even with `REDIS_URL` (shared storage), several state objects are held in process memory:
  - `rateWindow` (Map) -- rate limit counters are per-worker. With N workers, effective rate limits are multiplied by N.
  - `lastQuoteSweepAt` -- each worker sweeps independently, causing redundant work.
  - `webhooks.hooks` and `webhooks.eventLog` -- in-memory. Events emitted in one worker are invisible to webhook registrations in another worker.
- **Impact:** In cluster mode, rate limiting is ineffective (N workers = Nx the intended limit). Webhook delivery is inconsistent (events may not trigger hooks registered via a different worker).
- **Recommendation:** This is already documented in the `ALLOW_UNSAFE_CLUSTER` warning. For production cluster mode, rate limiting should use Redis (e.g., sliding window with `INCR`/`EXPIRE`), and webhook state should be persisted.

---

## 7. Additional Availability Findings

### Medium -- Rate limit map grows without bound under diverse IPs

- **Location:** `server.js:411-415`
- **Root cause:** The rate limit cleanup runs probabilistically (`Math.random() < 0.02`, i.e., 2% of requests). The cleanup iterates all entries and removes expired ones. However, if an attacker sends requests from many distinct IPs (e.g., via a botnet), the `rateWindow` Map accumulates entries faster than cleanup runs. Each unique `(method, path, IP)` triple creates a new entry.
- **Impact:** Memory exhaustion. With 100k unique IPs making one request each per window, the map holds 100k entries. The 2% cleanup probability means ~2000 requests before a cleanup runs, by which point the map may have grown significantly. Over time this can cause OOM.
- **Reproduction:**
  1. Send requests from distinct source IPs (or with distinct spoofed `X-Forwarded-For` if `TRUST_PROXY=1`).
  2. Each request creates a new `rateWindow` entry.
  3. Observe memory growth.
- **Recommendation:** Add a hard cap on `rateWindow.size`. When the cap is reached, either reject new IPs (conservative) or evict oldest entries. Also consider deterministic cleanup (e.g., every 1000 requests rather than probabilistic).

### Medium -- Channel lookup endpoint is an amplification vector

- **Location:** `server.js:1171-1228`
- **Root cause:** A single GET `/v1/channels/lookup?payer=0x...` request triggers:
  1. `prov.getBlockNumber()` -- 1 RPC call
  2. Up to `50000/5000 = 10` chunked `queryFilter` calls
  3. One `ct.getChannel()` per discovered log event
  4. `store.listPayments()` -- full scan of all payments
  5. One `store.getChannel()` per unique payment channelId
  6. Possibly additional `ct.getChannel()` per store-found channel

  A single API request can generate 10+ RPC calls plus a full payment scan. This endpoint is rate-limited at `RATE_LIMIT_DEFAULT` (600/min), but each request is expensive.
- **Impact:** An attacker can generate significant RPC load with relatively few requests. If the RPC provider has per-second rate limits, this can exhaust the hub's RPC quota, causing liveness check failures on `/v1/tickets/issue` (which fail-closed, blocking all payments).
- **Recommendation:** Apply a stricter rate limit to the lookup endpoint (e.g., 10/min). Cache lookup results. Limit the block scan range.

### Low -- No HTTP server request timeout

- **Location:** `server.js:2280-2283`
- **Root cause:** `http.createServer()` is called without setting `server.setTimeout()` or `server.requestTimeout`. The default Node.js HTTP server has no request timeout (or a very long one depending on version). Combined with the RPC timeout issue (finding 4), hung requests accumulate without cleanup.
- **Impact:** Slow resource exhaustion from accumulated hanging connections.
- **Recommendation:** Set `server.setTimeout(30000)` and `server.requestTimeout = 30000`.

### Low -- Unbounded quote sweep scans all quotes

- **Location:** `server.js:419-438`
- **Root cause:** `sweepExpiredQuotes()` iterates all entries in `s.quotes` inside a `tx()`. As the number of quotes grows (even with regular expiry), the scan touches every entry. This runs on every `/v1/tickets/quote` request (throttled by `QUOTE_SWEEP_INTERVAL_SEC`, default 30s).
- **Impact:** With thousands of active quotes, the sweep adds latency to quote requests. Minimal impact in practice since quotes have short TTLs.
- **Recommendation:** Use a sorted structure or expiry index for O(1) amortized cleanup.

### Low -- spentCreditNonces and spentWithdrawNonces grow without bound

- **Location:** `server.js:2058-2064`, `server.js:2129-2136`
- **Root cause:** Nonces are added to `spentCreditNonces` and `spentWithdrawNonces` maps but never removed. Over time these maps grow unboundedly.
- **Impact:** Memory consumption grows linearly with the number of credit-pay and withdrawal operations. At 1 million operations, assuming ~80 bytes per nonce entry, this is ~80MB. Not critical but unnecessary.
- **Recommendation:** Add periodic cleanup of old nonce entries (they store timestamps, so entries older than a reasonable window can be pruned). Alternatively, use a time-bucketed approach.

---

## Summary

| Severity | Count | Key Findings |
|---|---|---|
| Critical | 0 | -- |
| High | 2 | Global nonce maps (cross-user DoS), MemoryBackend tx atomicity fragility |
| Medium | 6 | RPC timeouts, webhook retry accumulation, rate limit map growth, JsonFile cluster races, worker-local state, channel lookup amplification |
| Low | 4 | Provider cache TTL, HTTP server timeout, quote sweep scan, nonce map growth |
| Info | 3 | Contract gas OK, fail-closed on security paths, Redis tx correct |
