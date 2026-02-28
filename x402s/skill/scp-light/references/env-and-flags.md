# Env And Flags

## Required Env

- `AGENT_PRIVATE_KEY`: EOA private key used by `ScpAgentClient` for on-chain and off-chain signing.
  - If unset and running in an interactive TTY, the script prompts for this value.
  - In non-interactive mode, it must be set in env.

## Optional Env

- `NETWORK` / `NETWORKS`: Network allowlist for offer filtering. Friendly aliases like `base` and `sepolia` are accepted.
- `RPC_URL`: RPC endpoint for auto open/fund operations.
- `RPC_URLS`: Comma-separated RPC candidates for fallback selection.
- `CONTRACT_ADDRESS`: x402 state-channel contract address. Defaults to canonical resolver.
- `MAX_AMOUNT`, `MAX_FEE`: Agent payment caps (raw units).
- `AGENT_STATE_DIR`: Agent state directory (where channels/payments are persisted).
- `AUTO_402_TOPUP_PAYMENTS`: Default for `--topup-payments`.
- `AUTO_402_RPC_TIMEOUT_MS`: Default RPC probe/read timeout.
- `AUTO_402_CHALLENGE_PERIOD_SEC`: Default for `--challenge-period-sec`.
- `AUTO_402_CHANNEL_EXPIRY_SEC`: Default for `--channel-expiry-sec`.
- `X402S_ROOT`: Explicit x402s project root if not running from `x402s/`.
- `PAYMENT_MODE`, `PAY_ONCE_TTL_SEC`: payee-side mode controls for protected resources. These are not consumed by `auto_402_hub_pay.js` directly, but affect whether follow-up calls need fresh `PAYMENT-SIGNATURE` or can reuse an access grant.

## CLI Flags

- `--route <hub|direct|auto>`: Route preference for offer selection.
- `--network <network>`: Offer network filter. Supports alias (`base`, `sepolia`) and CAIP (`eip155:*`).
- `--rpc-url <url>`: Preferred RPC URL (first candidate).
- `--rpc-urls <u1,u2,...>`: Comma-separated RPC candidates.
- `--rpc-timeout-ms <n>`: RPC probe/read timeout.
- `--asset <0xAssetAddress>`: Offer asset filter.
- `--method <verb>`: HTTP method for paid request.
- `--json '<json>'`: JSON request body.
- `--topup-payments <n>`: Buffered payment count used for target channel balance.
  - If omitted in interactive TTY mode, the script prompts for this at startup.
- `--target-balance <raw>`: Explicit target channel balance override.
- `--challenge-period-sec <n>`: Challenge period for new channels.
- `--channel-expiry-sec <n>`: New channel expiry horizon from now.
- `--max-fee <raw>`: Payment max fee override.
- `--max-amount <raw>`: Payment max amount override.
- `--x402s-root <path>`: Explicit x402s root.
- `--dry-run`: Print plan only; no approve/open/fund/pay transaction.
- `--help`: Show usage.

## Behavior Notes

- Hub flow automatically:
  1. Discovers 402 offers.
  2. If there are multiple hub offers and no existing hub channel, evaluates wallet-balance affordability per offer.
  3. Picks a compatible offer by route/network/asset.
  4. Checks agent state for `hub:<hubEndpoint>` channel.
  5. Computes top-up target using offer amount + hub fee policy.
  6. Checks wallet balance and ERC20 allowance.
  7. Opens or funds channel when needed.
  8. Submits paid request using existing SCP signing flow.

- If ERC20 allowance is insufficient, the script sends an `approve(MaxUint256)` tx before open/fund.
- In `--dry-run`, allowance/open/fund/pay actions are planned but not executed.
- RPC selection order: `--rpc-url`, `--rpc-urls`, `RPC_URL`, `RPC_URLS`, built-in network presets (`base`, `sepolia`, `base-sepolia`, `mainnet`), then network default.
