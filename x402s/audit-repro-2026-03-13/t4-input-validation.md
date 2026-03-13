## T4 — Input Validation & Injection Findings

Auditor: Claude Opus 4.6 (automated security audit)
Date: 2026-03-13
Scope: scp-pay frontend, scp-hub server, CLI tools, ABI encoding, webhooks

---

### High — Stored XSS via innerHTML with Hub-Sourced Data in Channel/Payment Views

- **Location:** `x402s/scp-pay/index.html:636-638` (credit balance), `:652-666` (channel list), `:696-712` (payment history)
- **Root cause:** The `goChannels()` and `goPayments()` functions build HTML strings from hub API responses and inject them via `innerHTML`. Values like `fT(bA,...)`, `gS({asset:...})`, `sA(v.id)`, `sA(v.pB)`, `sA(p.payee)`, `p.paymentId`, and network labels are interpolated directly into HTML without escaping. A malicious or compromised hub returning crafted strings in `latestState.balA`, `asset`, `participantB`, `payee`, `paymentId`, or `credit` fields can inject arbitrary HTML/JS.
- **Impact:** An attacker who controls a hub (or performs a MITM on the hub connection) can execute arbitrary JavaScript in the user's browser, stealing the private key from localStorage (`x402s.wallet`), initiating payments, or exfiltrating session data.
- **Reproduction:**
  1. Run a rogue hub that returns `paymentId: "<img src=x onerror=alert(document.cookie)>"` in the receipts API.
  2. Open scp-pay, connect to the rogue hub, click "Payments".
  3. The XSS payload executes.
- **Recommendation:** Create an `esc()` function (e.g., `function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}`) and wrap every dynamic value interpolated into HTML strings. Better: use `textContent` assignments or DOM APIs instead of string concatenation with `innerHTML`.

---

### High — Stored XSS via innerHTML in Credit Balance Display

- **Location:** `x402s/scp-pay/index.html:636`
- **Root cause:** The credit balance display at line 636 builds HTML from hub responses:
  ```js
  crParts.push(fT(c,"eth")+" ETH <span ...>"+nn+"</span>");
  ```
  While `nn` is derived from the endpoint URL (controlled string), the value `c` comes from `b.credit` (hub API response) which is passed through `fT()`. If `fT()` returns an unescaped string (its fallback at line 376 returns `r` — the raw input), a malicious hub could return a `credit` value like `"<img src=x onerror=...>"` that passes through `fT` and into `innerHTML`.
- **Impact:** Same as above — private key theft via XSS.
- **Recommendation:** Escape all hub-sourced values before inserting into HTML.

---

### Medium — postMessage to Wildcard Origin Leaks Payment Data

- **Location:** `x402s/scp-pay/index.html:1044,1100`
- **Root cause:** After successful payments, the frontend sends `window.parent.postMessage({...}, "*")` with payment details (paymentId, ticketId, amount). The `"*"` target origin means any parent page embedding scp-pay in an iframe receives this data.
- **Impact:** A malicious site embedding scp-pay in an iframe can silently capture payment IDs and amounts, enabling correlation attacks or receipt replay probing against the hub.
- **Recommendation:** Replace `"*"` with a configurable allowed origin, or let the embedding parent declare its origin via the `x402:config` message and validate it.

---

### Medium — postMessage Listener Lacks Origin Validation

- **Location:** `x402s/scp-pay/index.html:1118`
- **Root cause:** The `message` event listener accepts `x402:config` messages from any origin:
  ```js
  window.addEventListener('message',e=>{if(e.data?.type==='x402:config'){if(e.data.url)document.getElementById('iUrl').value=e.data.url;}});
  ```
  There is no `e.origin` check. Any page that opens scp-pay in an iframe (or window) can inject an arbitrary URL into the payment input field.
- **Impact:** An attacker embeds scp-pay in an iframe, sends a `x402:config` message with a malicious URL pointing to their own 402 endpoint. If the user clicks "Pay", they send funds to the attacker's payee address. This is a social engineering vector amplified by the lack of origin checks.
- **Recommendation:** Validate `e.origin` against an allowlist before processing the message. At minimum, require the origin to match `location.origin` or a configured parent domain.

---

### Medium — URL Parameter Injection into Payment Input

- **Location:** `x402s/scp-pay/index.html:1114-1115`
- **Root cause:** The `url` query parameter is read directly into the payment input:
  ```js
  const pp=new URLSearchParams(location.search);
  if(pp.get('url'))document.getElementById('iUrl').value=pp.get('url');
  ```
  While this populates an `<input>` (not innerHTML, so no direct XSS), it allows an attacker to craft a link like `scp-pay/index.html?url=https://evil.com/pay` that pre-populates the payment target. Combined with auto-pay or social engineering ("click Pay to claim your reward"), this directs payments to attacker-controlled endpoints.
- **Impact:** Phishing vector — user opens a crafted link and sees a pre-filled payment URL they may not scrutinize.
- **Recommendation:** Display a clear warning when the URL was pre-filled from query parameters, or require the user to manually confirm/re-enter the URL.

---

### Medium — Hub ABI Mismatch: openChannel Missing hubFlags Parameter

- **Location:** `x402s/node/scp-hub/server.js:81` (CHANNEL_ABI) vs `x402s/contracts/interfaces/IX402StateChannel.sol:64-72`
- **Root cause:** The hub's `CHANNEL_ABI` defines `openChannel` with 6 parameters:
  ```
  openChannel(address hub, address asset, uint256 amount, uint64 challengePeriodSec, uint64 channelExpiry, bytes32 salt)
  ```
  But the Solidity interface defines 7 parameters:
  ```solidity
  openChannel(address participantB, address asset, uint256 amount, uint64 challengePeriodSec, uint64 channelExpiry, bytes32 salt, uint8 hubFlags)
  ```
  The `hubFlags` parameter is missing from the hub ABI. Additionally, the first parameter is named `hub` in the hub ABI vs `participantB` in Solidity (cosmetic but confusing).

  **Prior finding confirmation:** The commit message `7fb8355` says "remove hubFlags from openChannel ABI" — this was an intentional change. However, the Solidity interface still declares `hubFlags`. If the deployed contract's `openChannel` expects 7 parameters, the hub's 6-parameter call would revert or ABI-encode incorrectly.

- **Impact:** If the contract was compiled with 7 parameters, the hub's `openChannel` call at line 1430-1432 would fail at the ABI encoding level (wrong number of arguments). The hub's call at line 1432 passes 6 positional args plus txOpts. This mismatch would cause the transaction to revert. However, since the hub only calls `openChannel` in the payee channel flow (not for payer channels), the blast radius is limited.
- **Recommendation:** Align the hub ABI with the deployed contract. If the contract was redeployed without `hubFlags`, update the Solidity interface. If the contract still has `hubFlags`, add it back to the hub ABI and pass a default value (e.g., `0`).

---

### Medium — Hub ABI Mismatch: rebalance ChannelState Tuple Uses Wrong Types

- **Location:** `x402s/node/scp-hub/server.js:84` vs `x402s/contracts/interfaces/IX402StateChannel.sol:102-107`
- **Root cause:** The hub's `rebalance` ABI defines the `state` tuple with `uint256 stateNonce` and `uint256 stateExpiry`:
  ```
  tuple(bytes32 channelId, uint256 stateNonce, uint256 balA, uint256 balB, bytes32 locksRoot, uint256 stateExpiry, bytes32 contextHash)
  ```
  But the Solidity `ChannelState` struct (used by `rebalance`) defines `uint64 stateNonce` and `uint64 stateExpiry`. The ABI encoding differs between `uint64` and `uint256` when packed into a struct tuple — ethers.js will generate a different function selector, causing the call to target a non-existent function.
- **Impact:** Any hub-initiated `rebalance` call would revert with "no matching function" or produce incorrect calldata. This blocks the hub's ability to rebalance channels.
- **Recommendation:** Change the tuple types to match the Solidity struct: use `uint64 stateNonce` and `uint64 stateExpiry`.

---

### Medium — Hub ABI getChannel Missing hubFlags Field

- **Location:** `x402s/node/scp-hub/server.js:86` vs `x402s/contracts/interfaces/IX402StateChannel.sol:109-112`
- **Root cause:** The hub's `getChannel` return tuple omits the `hubFlags` field present in the Solidity `ChannelParams` struct:
  ```
  // Hub ABI (9 fields):
  tuple(address participantA, address participantB, address asset, uint64 challengePeriodSec, uint64 channelExpiry, uint256 totalBalance, bool isClosing, uint64 closeDeadline, uint64 latestNonce)

  // Solidity (10 fields):
  ChannelParams { ..., uint8 hubFlags }
  ```
  This causes ethers.js to decode the returned bytes incorrectly — the `latestNonce` would be read from the wrong offset. However, the frontend `channel-cli.js:370` includes `hubFlags` in its local ABI, so this inconsistency only affects the hub server.
- **Impact:** `getChannel` calls from the hub may return garbled data (e.g., wrong `latestNonce`, wrong `isClosing`). This could cause the hub to issue tickets against stale nonces or miss that a channel is closing — both are exploitable.
- **Recommendation:** Add `uint8 hubFlags` to the hub's `getChannel` return tuple.

---

### Low — Private Key Stored in localStorage Without Encryption

- **Location:** `x402s/scp-pay/index.html:553-555`
- **Root cause:** `saveWallet(pk)` stores the raw private key in localStorage:
  ```js
  localStorage.setItem(WK,JSON.stringify({pk,t:Date.now()}));
  ```
  Any XSS vulnerability (including those found above) immediately compromises the private key. Additionally, browser extensions with `storage` permissions and same-origin scripts can read it.
- **Impact:** Combined with any XSS finding, an attacker obtains the wallet private key and can drain all funds across all channels and on-chain balances.
- **Recommendation:** At minimum, encrypt the key with a user-provided password before storing. Consider using the Web Crypto API with a non-exportable key derived from a password via PBKDF2.

---

### Low — localStorage Channel State Trusted Without Validation

- **Location:** `x402s/scp-pay/index.html:384` (Agent._ld method)
- **Root cause:** The Agent constructor loads channel state from localStorage and trusts it without validation:
  ```js
  const r=localStorage.getItem(this._k());
  if(r){const p=JSON.parse(r); ...}
  ```
  Channel IDs, balances, nonces, and hub endpoints are loaded and used directly. A browser extension or XSS on a same-origin page could poison localStorage to set `bA` to an arbitrarily high value or change `hEp` to a malicious hub endpoint.
- **Impact:** An attacker who can write to localStorage (via same-origin XSS on any page hosted at the same origin) can redirect payments to their hub, or cause the agent to believe it has funds it doesn't, leading to failed payments or unexpected behavior.
- **Recommendation:** Validate loaded state against hub/on-chain data before trusting it. The code already does some reconciliation in `hyd()` and `ensure()`, which mitigates the balance manipulation scenario. However, the `hEp` (hub endpoint) poisoning is not validated.

---

### Low — External CDN Script (ethers.js) Without Subresource Integrity

- **Location:** `x402s/scp-pay/index.html:348`
- **Root cause:** The ethers.js library is loaded from cdnjs.cloudflare.com without an `integrity` attribute:
  ```html
  <script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js"></script>
  ```
  If the CDN is compromised or serves a tampered file (supply chain attack, cache poisoning), arbitrary JS runs with full access to the page and the private key in localStorage.
- **Impact:** CDN compromise leads to full wallet theft for all users.
- **Recommendation:** Add `integrity="sha384-..."` and `crossorigin="anonymous"` attributes with the correct hash. Alternatively, self-host ethers.js.

---

### Low — Hub Body Size Limit is 1MB (Adequate but Worth Noting)

- **Location:** `x402s/node/scp-hub/server.js:181`
- **Root cause:** The `parseBody` function enforces a 1MB limit:
  ```js
  if (data.length > 1024 * 1024) { ... }
  ```
  This is a reasonable limit for API payloads but is accumulated as a string (`data += chunk.toString("utf8")`), meaning the 1MB is measured in UTF-8 characters. For normal API usage this is fine.
- **Impact:** No immediate vulnerability. The limit prevents basic memory exhaustion attacks.
- **Recommendation:** No action needed. The current limit is appropriate.

---

### Low — No Prototype Pollution Protection on JSON.parse

- **Location:** `x402s/node/scp-hub/server.js:192` (parseBody), and throughout body handling
- **Root cause:** `JSON.parse(data)` in `parseBody` does not strip `__proto__` or `constructor` keys. If an attacker sends `{"__proto__": {"admin": true}}`, it could pollute `Object.prototype` depending on how the parsed object is used downstream.
- **Impact:** In practice, the risk is low because:
  1. The hub uses AJV schema validation with `additionalProperties: false` on quote/issue/refund requests, rejecting unexpected keys.
  2. Other endpoints validate specific fields and don't spread the body onto shared objects.
  3. Node.js v20+ mitigates `__proto__` in `JSON.parse` by default.
  However, endpoints like `/v1/webhooks` PATCH, `/v1/credit/pay`, and `/v1/credit/withdraw` pass `body` fields without strict schema validation. A carefully crafted payload could pollute prototypes if the body object is spread or Object.assign'd.
- **Recommendation:** Add a `JSON.parse` reviver that strips `__proto__` and `constructor` keys, or use a safe JSON parser. Example:
  ```js
  JSON.parse(data, (key, value) => key === '__proto__' ? undefined : value);
  ```

---

### Info — Hub Rate Limit Map Lacks Bounded Size

- **Location:** `x402s/node/scp-hub/server.js:127,393-417`
- **Root cause:** The `rateWindow` Map grows unbounded except for a 2% probabilistic cleanup (`Math.random() < 0.02`). An attacker rotating source IPs could add ~50 entries/sec * 60s window = 3000 entries per minute, potentially reaching millions over hours.
- **Impact:** Slow memory leak under sustained attack from diverse IPs. Not critical for short-running processes but could affect long-lived hub instances.
- **Recommendation:** Add a hard cap (e.g., `if (rateWindow.size > 100000) { /* force full sweep */ }`).

---

### Info — CLI Tools: No Command Injection Risk Found

- **Location:** `x402s/node/scp-agent/channel-cli.js`, `x402s/node/scp-agent/pay-url.js`
- **Root cause:** N/A — both CLI tools use `process.argv` for input and pass values through ethers.js SDK calls. No `child_process`, `exec`, `spawn`, or shell invocations were found. User inputs (addresses, amounts, URLs) are validated via regex patterns (e.g., `/^0x[a-fA-F0-9]{40}$/`) before use. URLs are passed to `fetch()` or `ethers.providers.JsonRpcProvider`, not to shells.
- **Impact:** No injection risk identified.
- **Recommendation:** None needed.

---

### Info — Webhook URL SSRF Protection Implemented

- **Location:** `x402s/node/scp-hub/webhooks.js:25-51`
- **Root cause:** The `isPrivateHost()` and `parseWebhookUrl()` functions properly block RFC-1918, loopback, link-local, and cloud metadata IPs. Admin auth is required for webhook registration. The `isPrivateHost` function checks IPv4 private ranges correctly.
- **Impact:** SSRF via webhook registration is mitigated. Note: IPv6 private addresses (beyond `[::1]`) are not explicitly blocked (e.g., `fc00::/7`, `fe80::/10`), but the DNS resolution happens at delivery time through Node.js http/https modules, which is a minor gap.
- **Recommendation:** Consider adding IPv6 ULA (`fc00::/7`) and link-local (`fe80::/10`) checks. Also consider DNS rebinding protection (resolve hostname before connecting, then verify the resolved IP is not private).

---

### Info — Hub Input Validation via AJV Schemas is Comprehensive

- **Location:** `x402s/node/scp-hub/validator.js:1-83`
- **Root cause:** The hub uses AJV with `additionalProperties: false` for quote, issue, and refund requests. Schema-validated endpoints reject extra fields and enforce types/patterns.
- **Impact:** Schema validation significantly reduces injection surface on the core payment endpoints.
- **Recommendation:** Extend schema validation to other POST endpoints (`/v1/credit/pay`, `/v1/credit/withdraw`, `/v1/hub/open-payee-channel`, etc.) that currently do ad-hoc field checks.

---

## Summary

| Severity | Count | Categories |
|----------|-------|------------|
| Critical | 0 | - |
| High | 2 | XSS via innerHTML with hub data |
| Medium | 5 | postMessage origin issues (2), URL param injection, ABI mismatches (3) |
| Low | 4 | Private key storage, localStorage trust, CDN SRI, prototype pollution |
| Info | 4 | Rate limit map, CLI clean, webhook SSRF mitigated, AJV validation |

The most urgent findings are the **innerHTML XSS vulnerabilities** (High) which can steal private keys when combined with a malicious/compromised hub. The ABI mismatches (Medium) could cause silent failures in on-chain operations. The postMessage issues create phishing amplification vectors.
