## T3 — Auth & Access Control Findings

Audited: 2026-03-13
Scope: x402s SCP hub admin auth, payment verification on handle routes, webhook SSRF protections, payee-auth middleware, demo API auth delegation.

---

### [Medium] Webhook SSRF: No DNS rebinding or IPv6 private-address protection
- **Location:** `x402s/node/scp-hub/webhooks.js:25-41` (`isPrivateHost`)
- **Root cause:** `isPrivateHost()` only checks literal IPv4 patterns and two exact strings (`localhost`, `[::1]`). It does not:
  1. Block IPv4-mapped IPv6 addresses (e.g., `::ffff:127.0.0.1`, `::ffff:10.0.0.1`)
  2. Block IPv6 ULA addresses (`fd00::`, `fc00::`)
  3. Block IPv6 link-local addresses (`fe80::`)
  4. Perform DNS resolution to detect hostnames that resolve to private IPs (DNS rebinding)
  5. Block URL-encoded or alternate representations of private IPs (e.g., `0x7f000001`, `2130706433`, `017700000001`)
- **Impact:** An attacker with admin access can register a webhook URL like `http://[::ffff:127.0.0.1]:8080/internal` or register a hostname they control that resolves to `127.0.0.1` after the URL check passes. This enables SSRF to internal services.
- **Reproduction:**
  1. Set `HUB_ADMIN_TOKEN=secret` and start hub.
  2. `curl -X POST http://hub:4021/v1/webhooks -H 'X-SCP-Admin-Token: secret' -H 'Content-Type: application/json' -d '{"url":"http://[::ffff:127.0.0.1]:4021/.well-known/x402","events":["payment.received"]}'`
  3. Webhook is registered successfully; delivery hits loopback.
- **Recommendation:** Resolve the hostname to IP using `dns.lookup()` before the private-IP check. Add IPv6 ULA (`fc00::/7`), link-local (`fe80::/10`), and IPv4-mapped IPv6 (`::ffff:0:0/96`) to the blocklist. Consider also blocking decimal/hex/octal IPv4 representations.

---

### [Medium] Unauthenticated information disclosure on multiple hub endpoints
- **Location:** `x402s/node/scp-hub/server.js:1164-1168` (`/v1/payments/:id`), `server.js:1268-1291` (`/v1/payee/inbox`), `server.js:1484-1505` (`/v1/payee/channel-state`), `server.js:2096-2103` (`/v1/credit/balance`), `server.js:2260-2264` (`/v1/handles/:id`)
- **Root cause:** These endpoints return sensitive financial data (payment details including amounts, payee addresses, ticket IDs, channel balances, signed state including `sigA`) without any authentication. Anyone who can guess or enumerate a `paymentId`, `payee` address, or `channelId` can read the data.
- **Impact:**
  - `/v1/payments/:id` leaks payment status, amounts, payee, ticketId, channelId for any payment.
  - `/v1/payee/inbox` leaks the full payment ledger for any payee address.
  - `/v1/payee/channel-state` returns `sigA` (the hub's signed channel state), which is a close-authorization credential.
  - `/v1/credit/balance` leaks credit balances for any address.
  - An attacker can enumerate payment IDs (they are prefixed `pay_` + 20 hex chars) to map financial activity.
- **Reproduction:**
  1. `curl http://hub:4021/v1/payee/inbox?payee=0xKNOWN_PAYEE_ADDRESS`
  2. Response contains full payment history without auth.
- **Recommendation:** Add payee-auth (signature verification) to `/v1/payee/inbox` and `/v1/payee/channel-state`. Consider rate-limiting or auth on `/v1/payments/:id`. The `sigA` field on `/v1/payee/channel-state` should especially be guarded since it is a settlement credential.

---

### [Medium] Handle route payment verification is weak — only checks paymentId existence, not ticket signature
- **Location:** `x402s/node/scp-hub/server.js:2174-2188`
- **Root cause:** The handle route (`/handle/:name`) verifies the `Payment-Signature` header by extracting `paymentId` from the JSON and checking `store.getPayment(paymentId)`. It does NOT verify the ticket cryptographic signature (the `sig` field on the ticket is never checked). This means any client who knows a valid `paymentId` (e.g., from a leaked log, or by observing the payment of another user) can replay it on a handle route.
- **Impact:** An attacker who obtains any valid `paymentId` with status "issued" can use it to access handle data without paying. The prior audit noted that the header was accepted without any verification at all — the fix added paymentId lookup, but did not add cryptographic verification.
- **Reproduction:**
  1. Observe a valid `paymentId` (e.g., from `/v1/payments/:id` which is unauthenticated).
  2. Send `GET /handle/alice` with header `Payment-Signature: {"paymentId":"pay_KNOWN_ID"}`.
  3. The hub looks up the payment, finds status "issued", and returns handle data.
- **Recommendation:** Use `verifyPayment()` or `verifyTicket()` from `ticket.js` to cryptographically verify the ticket signature in the `Payment-Signature` header on handle routes. Check that the ticket's payee matches the expected payee and that the invoiceId matches the handle registration invoice.

---

### [Medium] No replay protection on handle route payment verification
- **Location:** `x402s/node/scp-hub/server.js:2174-2188`
- **Root cause:** The handle route checks `verifiedPayment.status === "issued"` but never marks the payment as consumed or tracks it in a replay cache. The same `paymentId` can be used unlimited times on different handle lookups or repeated requests.
- **Impact:** A single payment can be used to access the handle endpoint unlimited times. While the payment was legitimately made once, the payee receives no additional revenue for subsequent accesses.
- **Reproduction:**
  1. Make one legitimate paid request to `/handle/alice`.
  2. Reuse the same `Payment-Signature` header indefinitely.
- **Recommendation:** Track consumed payment IDs in a set/map with TTL, or transition payment status to "consumed" after first use on a handle route.

---

### [Low] Admin token brute-force has no dedicated rate limit
- **Location:** `x402s/node/scp-hub/server.js:311-333` (`requireAdminAuth`), `server.js:386-417` (`enforceRateLimit`)
- **Root cause:** Admin endpoints are protected by the generic per-IP rate limiter (`RATE_LIMIT_DEFAULT`, default 600 req/min). There is no escalating lockout or lower limit specifically for authentication failures. An attacker can make 600 attempts per minute from a single IP, or bypass the rate limit entirely if `TRUST_PROXY=1` by spoofing `X-Forwarded-For`.
- **Impact:** At 600 attempts/minute, a short admin token can be brute-forced. With proxy spoofing, the rate limit is effectively unlimited.
- **Recommendation:** Add a separate, lower rate limit for admin auth failures (e.g., 10/minute per IP). Consider account lockout after N failures. Do not trust `X-Forwarded-For` unless behind a verified proxy that strips client-supplied values.

---

### [Low] Event polling endpoint requires admin auth but webhook secret is returned in registration response
- **Location:** `x402s/node/scp-hub/webhooks.js:129` (returns `secret`), `server.js:1796-1806`
- **Root cause:** When a webhook is registered, the response includes the HMAC `secret` in plaintext (`{ webhookId, status, secret }`). Additionally, `GET /v1/webhooks/:id` (line 1812-1815) returns the full hook object including the `secret`. If the admin token is compromised, all webhook secrets are exposed.
- **Impact:** An attacker with admin access can read all webhook secrets and forge `X-SCP-Signature` headers on webhook deliveries to downstream services.
- **Recommendation:** Only return the secret once at registration time (current behavior is acceptable for registration). However, the `GET /v1/webhooks/:id` endpoint should redact the secret field. Consider hashing the stored secret and only comparing HMACs.

---

### [Low] Webhook URL validation does not re-check at delivery time against DNS changes
- **Location:** `x402s/node/scp-hub/webhooks.js:239-243` (`_deliver` calls `parseWebhookUrl`)
- **Root cause:** While `_deliver` does re-validate the URL via `parseWebhookUrl` before each delivery, this only checks the hostname string against `isPrivateHost()`. If a hostname initially resolved to a public IP at registration time, then later the DNS record is changed to point to `127.0.0.1`, the delivery will reach the internal host because `isPrivateHost` only checks string patterns, not resolved IPs. This is a DNS rebinding attack variant.
- **Impact:** Combined with the IPv6 bypass above, this allows SSRF to internal services via DNS rebinding.
- **Recommendation:** Resolve the hostname to an IP address at delivery time and check the resolved IP against the private-IP blocklist.

---

### [Info] Admin token comparison is timing-safe — no issue found
- **Location:** `x402s/node/scp-hub/server.js:325-328`
- **Root cause:** N/A. The implementation correctly uses `crypto.timingSafeEqual` with equal-length buffer comparison. The token is not logged or leaked in error responses. When no `HUB_ADMIN_TOKEN` is set, admin endpoints return 403 (correctly blocking access rather than falling back to allow-all).
- **Impact:** None. This was a prior vulnerability that has been correctly fixed.
- **Recommendation:** None needed.

---

### [Info] Admin token is not leaked in error messages or responses
- **Location:** `x402s/node/scp-hub/server.js:316,329`
- **Root cause:** N/A. Error responses for failed admin auth use generic messages ("admin endpoints disabled", "admin auth required") without including the token or any hint about it.
- **Impact:** None.
- **Recommendation:** None needed.

---

### [Info] payee-auth middleware (payee-auth.js) is cryptographically sound
- **Location:** `x402s/node/scp-common/payee-auth.js:1-44`
- **Root cause:** N/A. The module builds a canonical message including method, path, payee address, timestamp, and a keccak256 hash of the canonicalized body. It uses `ethers.utils.verifyMessage` for signature recovery. The hub's `requirePayeeAuth` (server.js:335-372) enforces timestamp skew (default 300s) and checks that the recovered signer matches the expected payee address.
- **Impact:** None. This is well-implemented. One note: there is no replay protection on the payee-auth signatures themselves — the same signature is valid within the 300s window. However, the endpoints using it (refunds, settlements) have their own idempotency/replay guards.
- **Recommendation:** None critical. Consider adding a nonce to the payee-auth message for defense-in-depth against replay within the time window.

---

### [Info] Chat API (chat-server.js) correctly delegates auth to ticket verification
- **Location:** `x402s/node/scp-demo/chat-server.js:157-165,194-208`
- **Root cause:** N/A. The chat API uses `createVerifier()` from `ticket.js` with `confirmHub: true`, meaning it verifies the ticket cryptographic signature AND confirms with the hub that the payment is in "issued" status. It also uses a `consumed` Map for replay protection.
- **Impact:** None. Auth is properly implemented.
- **Recommendation:** None needed.

---

### [Info] Music API (music-api/server.js) correctly delegates auth to ticket verification
- **Location:** `x402s/node/music-api/server.js:8,853`
- **Root cause:** N/A. The music API uses `createVerifier()` from `ticket.js`, the same robust verification path as the chat API.
- **Impact:** None.
- **Recommendation:** None needed.

---

### [Info] Weather API (weather-api/server.js) implements its own payment verification — mostly correct
- **Location:** `x402s/node/weather-api/server.js:449-529`
- **Root cause:** N/A. The weather API does NOT use `createVerifier()` but implements its own `validatePayment()` function. For hub-routed payments, it verifies the ticket signature, checks the signer matches the hub address (fetched from `/.well-known/x402`), checks payee, expiry, amount, asset, and confirms with the hub via `/v1/payments/:id`. For direct payments, it verifies the payer signature, contextHash binding, and nonce progression.
- **Impact:** The implementation is functionally correct but introduces risk of divergence from the canonical `ticket.js` verification. One notable difference: the weather API does not check `payload.paymentId !== payload.ticket.paymentId` (the wrapper/ticket paymentId mismatch that `ticket.js:109-112` catches).
- **Recommendation:** Migrate to `createVerifier()` from `ticket.js` to avoid verification logic drift. The missing wrapper-paymentId check means a client could confuse replay caches by submitting a valid ticket with a tampered wrapper paymentId.

---

### [Info] contextHash is optional in direct payment verification
- **Location:** `x402s/node/scp-hub/ticket.js:173` (`if (dp.channelState.contextHash)`), `x402s/node/weather-api/server.js:504`
- **Root cause:** Both `ticket.js:verifyDirectPayment` and the weather API's `validatePayment` only verify contextHash if it is present in the channel state. If a payer omits contextHash from the signed state, the binding between the signed state and the payment fields (payee, invoiceId, amount, asset) is not enforced.
- **Impact:** A valid signed channel state without contextHash could potentially be repurposed across different invoices/payees, though the nonce progression and amount checks provide some mitigation. This is a defense-in-depth gap rather than an exploitable vulnerability in isolation.
- **Recommendation:** Consider requiring contextHash for all direct payments (reject if missing). Document this as a security invariant.

---

### Summary

| Severity | Count | Key Issues |
|----------|-------|------------|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 4 | Webhook SSRF via IPv6/DNS rebinding; unauthenticated info disclosure on hub endpoints; handle route weak payment verification; handle route replay |
| Low | 3 | Admin brute-force rate limit; webhook secret exposure on GET; DNS rebinding at delivery time |
| Info | 7 | Admin token handling correct; payee-auth sound; chat/music APIs correct; weather API minor drift; contextHash optional |

Prior finding status: **Handle route Payment-Signature bypass (M3) — partially fixed.** The header is no longer accepted blindly, but the fix only checks `paymentId` existence without cryptographic verification or replay protection.
