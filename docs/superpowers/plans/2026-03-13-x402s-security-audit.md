# x402s Full-Scope Security Audit — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a comprehensive security audit of the entire x402s SCP stack (~16,340 lines, 50 files), with severity-ranked findings and reproduction scripts for Medium+ issues.

**Architecture:** Five parallel subagents, each in an isolated worktree, auditing one threat category (T1–T5). A sixth aggregation task merges all findings into a unified report. Each agent reads code, identifies vulnerabilities, writes PoC scripts for Medium+ findings, and outputs a structured findings report.

**Tech Stack:** Node.js, Solidity, Hardhat, ethers.js, Express, HTML/JS frontend

**Spec:** `docs/superpowers/specs/2026-03-13-x402s-security-audit-design.md`

---

## Chunk 1: Parallel Audit Tasks (T1–T5)

All five tasks are independent and MUST run in parallel via subagent dispatch. Each task produces a markdown findings file in `x402s/audit-repro-2026-03-13/`.

### Task 1: T1 — Fund Safety Audit

**Files to read:**
- `x402s/contracts/X402StateChannel.sol` (613 lines) — full contract
- `x402s/contracts/interfaces/IX402StateChannel.sol` (140 lines) — interface
- `x402s/node/scp-hub/server.js` — close paths, refund paths, pay-to-address
- `x402s/node/scp-hub/state-signing.js` (145 lines) — full file
- `x402s/node/scp-hub/ticket.js` (500 lines) — full file
- `x402s/node/scp-hub/storage.js` (447 lines) — tx atomicity
- `x402s/test/test_x402_state_channel.js` (547 lines) — existing contract tests

**Output:** `x402s/audit-repro-2026-03-13/t1-fund-safety.md`

- [ ] **Step 1: Read the Solidity contract end-to-end**

Read `x402s/contracts/X402StateChannel.sol` and `x402s/contracts/interfaces/IX402StateChannel.sol`. For each external/public function, document:
- Access control (who can call it)
- State mutations (what storage changes)
- Value transfers (ETH or ERC20 movements)
- Reentrancy exposure (external calls before state updates)

- [ ] **Step 2: Audit closeChannel / challengeClose / withdraw**

Focus on:
- Can `closeChannel` be called with a stale or forged signature? Check signature recovery and nonce validation.
- Can `challengeClose` be used to grief — e.g., challenge with a lower nonce to reset the timeout?
- Does `withdraw` check that the channel is fully closed before releasing funds?
- Balance underflow: can `balA + balB > totalDeposited`? Check for overflow/underflow in balance arithmetic.
- Timeout manipulation: can `challengePeriod` be set to 0 or near-0 to bypass dispute window?

- [ ] **Step 3: Audit hub cooperative close path**

Read the hub's close endpoints in `server.js`. Search for `close` in route handlers. Check:
- Does the hub verify both signatures before submitting on-chain?
- Can a payer trick the hub into signing a close state that gives the payer more than their balance?
- Is the close state's nonce validated against the latest known state?

- [ ] **Step 4: Audit refund flow**

Search `server.js` for `refund`. Check:
- Can a refund be issued after the channel is closed?
- Can the same payment be refunded twice (double-refund)?
- Does a refund correctly reverse the credit/debit entries?
- Can a refund exceed the original payment amount (over-refund)?

- [ ] **Step 5: Audit channel funding and deposit accounting**

Check:
- When the hub sees a new channel or deposit, does it verify on-chain before crediting?
- Can a deposit be credited without the ETH/ERC20 actually arriving in the contract?
- Is there a race between deposit confirmation and balance availability?

- [ ] **Step 6: Audit pay-to-address**

Search for `pay-to-address` or `payToAddress` or `directPay` patterns. Check:
- Does value actually transfer on-chain, or is it just an off-chain ledger entry?
- Can the recipient address be spoofed?

- [ ] **Step 7: Write reproduction scripts for Medium+ findings**

For each finding rated Medium or above, write a standalone Node.js script in `x402s/audit-repro-2026-03-13/` that demonstrates the issue. Scripts should:
- Be runnable with `node <script>.js`
- Include clear comments explaining what they demonstrate
- Print PASS/FAIL output

- [ ] **Step 8: Write T1 findings report**

Write `x402s/audit-repro-2026-03-13/t1-fund-safety.md` with the format:
```
## T1 — Fund Safety Findings
### [Severity] Title
- **Location:** file:line
- **Root cause:** ...
- **Impact:** ...
- **Reproduction:** script reference or steps
- **Recommendation:** ...
```

---

### Task 2: T2 — State Integrity Audit

**Files to read:**
- `x402s/node/scp-hub/server.js` — issue path (search for `/v1/tickets/issue`), continuation logic, credit/withdraw endpoints
- `x402s/node/scp-hub/storage.js` (447 lines) — full file, all backends
- `x402s/node/scp-hub/state-signing.js` (145 lines) — full file
- `x402s/node/scp-hub/ticket.js` (500 lines) — full file
- `x402s/test/test_scp_stack_deep.js` (1,148 lines) — existing integration tests
- `x402s/test/test_scp_unit_issue_delta.js` (259 lines)
- `x402s/test/test_scp_unit_storage.js` (144 lines)

**Output:** `x402s/audit-repro-2026-03-13/t2-state-integrity.md`

- [ ] **Step 1: Audit quote→issue atomicity**

Read the `/v1/tickets/issue` handler in `server.js`. Trace the flow:
1. Quote lookup
2. Channel state validation
3. `store.tx(...)` atomic section
4. Ticket signing

Check: Is the quote existence re-verified inside `store.tx()`? Is the channel nonce CAS-checked inside the atomic section? Can two parallel issue requests for the same quote both succeed?

- [ ] **Step 2: Audit continuation issue path**

Search for continuation logic in the issue handler. Check:
- Does it fail closed when RPC/on-chain liveness check fails?
- What happens if the channel was closed on-chain between the first and second issue?
- Is the continuation nonce strictly sequential?

- [ ] **Step 3: Audit credit/withdraw accounting**

Search for `credit` and `withdraw` endpoints. Check:
- Can a user's credit balance exceed total payments received?
- Can a withdrawal exceed the credit balance?
- Are credit nonces properly scoped per signer (not global)?
- Is the withdrawal replay map keyed by `(address, nonce)` not just `nonce`?

- [ ] **Step 4: Audit cross-network channel lookups**

Search for network/chain ID handling in the issue path. Check:
- Can a channel opened on Base be used to pay for a quote on Sepolia?
- Is the CAIP-2 network identifier validated consistently?

- [ ] **Step 5: Audit storage backend parity**

Read `storage.js` fully. For each backend (Memory, JSON, Redis):
- Does `tx()` return the mutator's result?
- Does `tx()` await async mutators?
- Are reads inside `tx()` consistent (snapshot isolation)?
- Known lead: `MemoryBackend.tx()` may not return or await.

- [ ] **Step 6: Write reproduction scripts for Medium+ findings**

Same approach as Task 1 Step 7.

- [ ] **Step 7: Write T2 findings report**

Write `x402s/audit-repro-2026-03-13/t2-state-integrity.md`.

---

### Task 3: T3 — Auth & Access Control Audit

**Files to read:**
- `x402s/node/scp-hub/server.js` — admin routes, handle routes, inline auth
- `x402s/node/scp-hub/webhooks.js` (303 lines) — full file
- `x402s/node/scp-common/payee-auth.js` (44 lines) — full file
- `x402s/node/scp-demo/chat-server.js` (255 lines) — full file
- `x402s/node/music-api/server.js` (986 lines) — auth-related sections
- `x402s/node/weather-api/server.js` (741 lines) — auth-related sections
- `x402s/test/test_scp_unit_webhooks.js` (149 lines)
- `x402s/test/test_scp_unit_auth_signing_validator.js` (140 lines)

**Output:** `x402s/audit-repro-2026-03-13/t3-auth-access.md`

- [ ] **Step 1: Audit admin token handling**

Search `server.js` for admin token checks. Check:
- Is comparison timing-safe (`crypto.timingSafeEqual` or equivalent)?
- Is the token ever logged, included in error messages, or leaked in responses?
- Can the token be brute-forced (rate limiting)?
- Is there a default/fallback token?

- [ ] **Step 2: Audit payment verification on handle routes**

Search for `handle` routes in `server.js`. Check:
- Is the `Payment-Signature` header actually verified against a real issued payment?
- Can a forged or empty header bypass the 402 challenge?
- Prior finding: the header was accepted without verification — confirm fix.

- [ ] **Step 3: Audit webhook SSRF protections**

Read `webhooks.js` fully. Check `isPrivateHost()` or equivalent:
- Does it block: `127.0.0.1`, `localhost`, `[::1]`, `10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`?
- Does it block IPv4-mapped IPv6: `::ffff:127.0.0.1`, `[::ffff:10.0.0.1]`?
- Does it block IPv6 ULA/link-local: `fd00::`, `fe80::`?
- Does it resolve hostnames before checking? (DNS rebinding: `evil.com` → `127.0.0.1`)
- Can URL encoding or redirects bypass the filter?

- [ ] **Step 4: Audit payee-auth middleware**

Read `payee-auth.js` fully. Check:
- How does it verify the payment proof? Does it call back to the hub?
- Can the proof be replayed (same proof used for multiple requests)?
- Can the proof be forged (signed by a non-hub key)?
- What happens if the hub is unreachable during verification?

- [ ] **Step 5: Audit chat/music/weather API auth delegation**

For each API (`chat-server.js`, `music-api/server.js`, `weather-api/server.js`):
- Does it use `payee-auth.js` or roll its own verification?
- Are there any endpoints that bypass the 402 flow?
- Can the 402 challenge be satisfied without actual payment?

- [ ] **Step 6: Write reproduction scripts for Medium+ findings**

Same approach as Task 1 Step 7.

- [ ] **Step 7: Write T3 findings report**

Write `x402s/audit-repro-2026-03-13/t3-auth-access.md`.

---

### Task 4: T4 — Input Validation & Injection Audit

**Files to read:**
- `x402s/scp-pay/index.html` (1,125 lines) — full file
- `x402s/node/scp-hub/server.js` — all route handlers, request body parsing
- `x402s/node/scp-hub/validator.js` (83 lines) — full file
- `x402s/node/scp-hub/webhooks.js` (303 lines) — URL parsing
- `x402s/node/scp-agent/channel-cli.js` (637 lines) — CLI argument handling
- `x402s/node/scp-agent/pay-url.js` (183 lines) — URL handling
- `x402s/contracts/interfaces/IX402StateChannel.sol` (140 lines) — ABI reference

**Output:** `x402s/audit-repro-2026-03-13/t4-input-validation.md`

- [ ] **Step 1: Audit scp-pay frontend for XSS**

Read `scp-pay/index.html` fully. Check:
- Is offer data rendered using `innerHTML` or `document.write`? Any unsanitized template injection?
- Are URL parameters (query string, hash) used to populate DOM without escaping?
- Is localStorage data trusted without validation? Can a malicious site poison localStorage?
- Are external resources loaded (CDN scripts, iframes) that could be compromised?

- [ ] **Step 2: Audit hub HTTP endpoints for injection**

For each route handler in `server.js`:
- Is `req.body` validated before use? Are types checked (string vs number vs object)?
- Can oversized payloads cause memory exhaustion? Is there a body size limit?
- Are user-supplied values used in database keys without sanitization?
- Can JSON with `__proto__` or `constructor` keys cause prototype pollution?

- [ ] **Step 3: Audit ABI encoding correctness**

Compare the hub's ABI definitions (search for `ethers.Contract` or ABI arrays in `server.js`) against the actual contract interface in `IX402StateChannel.sol`. Check:
- Do function signatures match (name, parameter types, parameter count)?
- Are there functions the hub calls that don't exist on the contract?
- Prior finding: `openChannel` ABI had wrong parameter count — confirm fix.

- [ ] **Step 4: Audit CLI tools for command injection**

Read `channel-cli.js` and `pay-url.js`. Check:
- Are user-supplied arguments passed to `child_process.exec` or shell commands?
- Are file paths constructed from user input without sanitization?
- Can a malicious URL or address cause unexpected behavior?

- [ ] **Step 5: Write reproduction scripts for Medium+ findings**

Same approach as Task 1 Step 7.

- [ ] **Step 6: Write T4 findings report**

Write `x402s/audit-repro-2026-03-13/t4-input-validation.md`.

---

### Task 5: T5 — Availability & DoS Audit

**Files to read:**
- `x402s/contracts/X402StateChannel.sol` (613 lines) — gas consumption
- `x402s/node/scp-hub/server.js` — error handling, cluster mode
- `x402s/node/scp-hub/storage.js` (447 lines) — concurrency, locking
- `x402s/node/scp-hub/webhooks.js` (303 lines) — outbound request handling
- `x402s/node/scp-common/networks.js` (118 lines) — RPC configuration

**Output:** `x402s/audit-repro-2026-03-13/t5-availability.md`

- [ ] **Step 1: Audit nonce collision scope**

Search `server.js` for nonce/replay maps (`spentCreditNonces`, `spentWithdrawNonces`, etc.). Check:
- Are replay maps keyed by `(signerAddress, nonce)` or just `nonce`?
- Can one user burn a nonce and cause another user's valid request to fail?
- Prior finding: nonces were global, not signer-scoped — confirm fix.

- [ ] **Step 2: Audit contract gas consumption**

In `X402StateChannel.sol`, check:
- Can `closeChannel` or `challengeClose` consume unbounded gas (e.g., loops over arrays)?
- Can an attacker construct inputs that cause out-of-gas on close?
- Are there any storage writes in loops?

- [ ] **Step 3: Systematic fail-open / fail-closed check**

Read every `catch` block and error handler in `server.js`. For each:
- Does it return an error to the client (fail-closed), or continue processing (fail-open)?
- Document each as: `file:line | error type | behavior (open/closed)`
- Flag any that fail open on security-relevant paths.

- [ ] **Step 4: Audit RPC failure handling**

Search for RPC calls (`provider.getBlock`, `contract.getChannel`, etc.) in `server.js`. Check:
- Does a single RPC timeout block the entire server (event loop)?
- Is there a timeout on RPC calls?
- What happens when the RPC provider is completely unreachable?

- [ ] **Step 5: Audit storage concurrency**

Read `storage.js`. For each backend:
- MemoryBackend: is `tx()` actually atomic? Can concurrent `tx()` calls interleave?
- JsonFileBackend: does file I/O have a lock? Can concurrent writes corrupt the file?
- RedisBackend: are transactions using `MULTI`/`EXEC`?

- [ ] **Step 6: Audit cluster mode safety**

Search `server.js` for `cluster`. Check:
- Does the hub actually use cluster mode, or is it just imported?
- If used: MemoryBackend state is per-worker (not shared) — is this documented/handled?
- If used: JsonFileBackend concurrent writes from multiple workers — corruption risk?

- [ ] **Step 7: Write reproduction scripts for Medium+ findings**

Same approach as Task 1 Step 7.

- [ ] **Step 8: Write T5 findings report**

Write `x402s/audit-repro-2026-03-13/t5-availability.md`.

---

## Chunk 2: Aggregation & Final Report

This task runs AFTER all T1–T5 tasks complete. It is NOT parallel with Chunk 1.

### Task 6: Aggregate Findings & Produce Final Report

**Files to read:**
- `x402s/audit-repro-2026-03-13/t1-fund-safety.md`
- `x402s/audit-repro-2026-03-13/t2-state-integrity.md`
- `x402s/audit-repro-2026-03-13/t3-auth-access.md`
- `x402s/audit-repro-2026-03-13/t4-input-validation.md`
- `x402s/audit-repro-2026-03-13/t5-availability.md`
- Prior audit reports for comparison (these three contain actual findings; other audit files in the repo — `scp_audit_2026-03-07.md`, `scp_audit_2026-03-07_codex.md`, `scp_audit_worktree_2026-03-07.md`, `x402s/scp_audit_codex_2026-03-07.md` — are empty placeholders):
  - `audit_report.md` (root) — 2 Medium, 2 Low findings
  - `x402s/scp_audit_gpt5_2026-03-07.md` — 1 Critical, 1 High, 1 Medium findings
  - `x402s/scp_audit_multiagent_2026-03-07.md` — 1 Medium, 1 Low findings

**Output:** `x402s/scp_audit_2026-03-13.md`

- [ ] **Step 1: Read all five category reports**

Read each T1–T5 report. Collect all findings into a single list.

- [ ] **Step 2: Deduplicate cross-category findings**

Some issues may appear in multiple categories (e.g., a storage bug found by both T1 and T2). Merge duplicates, keeping the most complete description and highest severity.

- [ ] **Step 3: Compare against prior March 7 findings**

For each finding from the three prior audits, determine:
- **Fixed** — the issue is no longer reproducible
- **Regressed** — the fix was incomplete or reverted
- **Partial** — partially addressed but still exploitable
- **New** — not in any prior audit

Build a comparison table.

- [ ] **Step 4: Run the existing test suite**

```bash
cd /workspaces/Contracts/x402s && npm run scp:test:all
```

Record the output (passing/failing count, specific failures).

- [ ] **Step 5: Write the unified audit report**

Write `x402s/scp_audit_2026-03-13.md` following the report template from the spec:

```markdown
# SCP Security Audit — 2026-03-13

## Executive Summary
- Scope: full x402s stack (~16,340 lines, 50 files)
- Method: attack-surface-driven, 5 parallel threat categories
- [Overall risk assessment]
- [Finding count by severity]

## Prior Audit Status
| Prior Finding | Severity | Status | Notes |
|...|...|...|...|

## Findings (sorted by severity)
### [Critical|High|Medium|Low|Info] Title
- **Location:** file:line
- **Root cause:** ...
- **Impact:** ...
- **Reproduction:** ...
- **Recommendation:** ...

## Appendix
- Reproduction scripts: `x402s/audit-repro-2026-03-13/`
- Test suite status: [output from Step 4]
```

- [ ] **Step 6: Final review**

Re-read the complete report. Verify:
- Every finding has a concrete recommendation
- Every Medium+ finding has a reproduction reference
- The prior audit comparison table is complete
- The executive summary accurately reflects the findings
