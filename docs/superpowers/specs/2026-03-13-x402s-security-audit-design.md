# x402s Full-Scope Security Audit — Design Spec

**Date:** 2026-03-13
**Scope:** Everything under `x402s/` — Solidity contract, hub server, payee server, agent client, storage backends, auth/webhook helpers, CLI tools, chat/music/weather APIs, scp-pay frontend, and all tests.
**Method:** Attack-surface-driven, organized by threat category across the full stack.
**Prior work:** Three audits from 2026-03-07, followed by 7 rounds of fixes (~2000 lines changed). This audit treats the codebase fresh — no assumptions carried from prior reviews.

## Approach

Organize by threat category rather than architectural layer. Five categories run as parallel subagents, each in an isolated worktree. Each category examines all layers relevant to its threat class. After completion, a review agent merges findings into a unified report.

## Threat Categories

### T1 — Fund Safety

Anything that could lead to loss of deposited funds or creation of uncollectible hub liability.

**Targets:**
- `closeChannel` / `challengeClose` / `withdraw` in `X402StateChannel.sol` — reentrancy, balance underflow, timeout manipulation
- Hub cooperative close path — can hub be tricked into signing a close favoring one party?
- Refund flow — double-refund, over-refund, refund-after-close
- Channel funding — deposit accounting, can deposits be credited without arriving on-chain?
- Pay-to-address — does value actually transfer, or can it be spoofed?

**Key files:** `x402s/contracts/X402StateChannel.sol`, hub close/refund paths in `node/scp-hub/server.js`, `node/scp-hub/storage.js`, `node/scp-hub/state-signing.js`, `node/scp-hub/ticket.js`

### T2 — State Integrity

Correctness of the off-chain state machine: quote consumption, nonce ordering, replay protection, accounting.

**Targets:**
- Quote consumption atomicity inside `store.tx()`
- Nonce CAS guards — verify completeness
- Continuation issue — does fail-closed liveness reject when RPC is down?
- Credit/withdraw accounting — can credits exceed payments? Can withdrawals exceed credits?
- Cross-network channel lookups — can a channel on network A pay on network B?
- Memory/JSON/Redis backend parity — do all three return values from `tx()`? Known lead: `MemoryBackend.tx()` does not return or await the mutator result.

**Key files:** `node/scp-hub/server.js` (issue path, continuation logic, credit/withdraw), `node/scp-hub/storage.js`, `node/scp-hub/state-signing.js`, `node/scp-hub/ticket.js`

### T3 — Auth & Access Control

Authentication bypasses, authorization gaps, SSRF, and credential handling.

**Targets:**
- Admin token — timing-safe comparison, rotation, exposure in logs
- Payment verification on handle routes — is the forged-header bypass fixed?
- Webhook SSRF — IPv6/mapped-loopback coverage, DNS rebinding (hostname resolving to private IP), `::ffff:127.0.0.1` and `[::ffff:10.0.0.1]` mapped addresses
- Payee `payee-auth.js` middleware — can payment proof be forged or replayed?
- Chat/music/weather API auth — do all payee demo APIs properly delegate to the 402 flow?

**Key files:** `node/scp-hub/server.js` (admin routes, inline auth logic), `node/scp-hub/webhooks.js`, `node/scp-common/payee-auth.js`, `node/scp-demo/chat-server.js`, `node/music-api/server.js`, `node/weather-api/`

### T4 — Input Validation & Injection

XSS, parameter injection, ABI encoding correctness, malformed input handling.

**Targets:**
- scp-pay frontend — XSS via offer data, URL parameters, localStorage poisoning
- Hub HTTP endpoints — malformed JSON, oversized payloads, unexpected types
- ABI encoding — does the hub's ABI match the deployed contract on all networks?
- CLI tools — command injection via user-supplied arguments

**Key files:** `scp-pay/index.html`, all hub HTTP route handlers, hub ABI definitions, `node/scp-hub/validator.js`, CLI entry points

### T5 — Availability & DoS

Denial of service, resource exhaustion, and error handling posture.

**Targets:**
- Global nonce collision (signer-scoped nonce finding from prior audit)
- Gas limit on close/challenge — can an attacker force out-of-gas?
- Hub error paths — systematic check of fail-open vs fail-closed
- RPC failure cascading — does one bad RPC call block the whole hub?
- Storage locking under concurrent load
- Cluster mode safety — if hub runs with `cluster` module, do MemoryBackend and JsonFileBackend remain safe?

**Key files:** `x402s/contracts/X402StateChannel.sol` (gas), `node/scp-hub/server.js` (error paths, cluster import), `node/scp-hub/storage.js` (concurrency)

## Execution Model

### Parallel Subagent Dispatch

Each threat category (T1–T5) runs as an independent agent in an isolated git worktree. Per-agent workflow:

1. Read all files relevant to the category
2. Identify potential issues — document each with: location, root cause, impact, severity
3. For Medium+ findings, write a standalone reproduction script
4. Produce a structured findings report in markdown

### Aggregation

After all 5 agents complete, a review agent:
- Merges findings and deduplicates cross-category overlaps
- Produces a single unified audit report
- Compares against prior March 7 findings (fixed/regressed/new)

### Outputs

- **Audit report:** `x402s/scp_audit_2026-03-13.md`
- **Reproduction scripts:** `x402s/audit-repro-2026-03-13/` (not committed to test suite)

## Severity Classification

| Severity | Definition | Reproduction required? |
|----------|-----------|----------------------|
| **Critical** | Direct loss of deposited funds, or ability to drain channels | Yes — PoC script |
| **High** | Indirect fund risk (fail-open → uncollectible liability), auth bypass on money-bearing endpoints | Yes — PoC script |
| **Medium** | Monetization bypass, state corruption without direct fund loss, incomplete security controls | Yes — PoC script |
| **Low** | Defense-in-depth gaps, stale tests, info leakage, DoS under unlikely conditions | No — code reference only |
| **Info** | Code quality, missing validation on non-security paths, suggestions | No — code reference only |

## Report Structure

```
# SCP Security Audit — 2026-03-13

## Executive Summary
- Scope, method, overall risk assessment
- Count of findings by severity

## Prior Audit Status
- Table: each March 7 finding → fixed/regressed/partial

## Findings (sorted by severity)
### [Critical|High|Medium|Low|Info] Title
- **Location:** file:line
- **Root cause:** what's wrong
- **Impact:** what an attacker gains
- **Reproduction:** steps or script reference
- **Recommendation:** specific fix

## Appendix
- Reproduction scripts index
- Test suite status (npm run scp:test:all output)
```

## Constraints

- All reproduction scripts are standalone — they do not modify the committed test suite
- Findings must include specific file:line references
- Each finding must have a concrete recommendation, not just a description
- Prior audit findings are re-evaluated independently, not assumed fixed
