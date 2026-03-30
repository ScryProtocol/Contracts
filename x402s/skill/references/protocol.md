# SCP Protocol Reference

## Payment Flow (Hub Route)

```
Agent                    Payee                    Hub
  |--- GET <url> -------->|                         |
  |<-- 402 {accepts} -----|                         |
  |                                                  |
  |--- POST /v1/tickets/quote ------------------>   |
  |    {channelId, payee, amount, asset, maxFee}     |
  |<-- {fee, totalDebit, quoteExpiry} -----------   |
  |                                                  |
  |--- sign EIP-712 state (balA -= totalDebit)       |
  |--- POST /v1/tickets/issue ------------------->  |
  |    {quote, channelState, sigA}                   |
  |<-- {ticket, channelAck} ---------------------   |
  |                                                  |
  |--- <method> <url> -->|                          |
  |    PAYMENT-SIGNATURE  |--- verify ticket ------->|
  |                       |<-- {ok, paymentId} ------|
  |<-- 200 {data} -------|                          |
```

## 402 Response Format

```json
{
  "accepts": [
    {
      "scheme": "statechannel-hub-v1",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "maxAmountRequired": "10000",
      "resource": "https://api.example.com/v1/data",
      "extensions": {
        "statechannel-hub-v1": {
          "hubName": "pay.eth",
          "hubEndpoint": "https://pogchamp.tv/hub/base",
          "payeeAddress": "0x...",
          "invoiceId": "inv_...",
          "feeModel": { "base": "0", "bps": 0 },
          "stream": { "t": 1, "amount": "10000" }
        }
      }
    }
  ]
}
```

## Offer Selection Algorithm

1. Filter by `--network` / `--asset` if provided
2. Split into hub offers and direct offers
3. Score each by channel readiness:
   - 2 = channel exists, balance >= amount
   - 1 = channel exists, underfunded
   - 0 = no channel
4. Tie-break: smaller `maxAmountRequired`, then array order
5. Route logic:
   - `hub` → best hub offer
   - `direct` → best direct offer
   - `auto` → direct if score >= 2, else hub, else direct fallback

### Cross-Asset Comparison

Raw amounts are NOT comparable across assets. Use USD equivalents:

| Asset | Decimals | Example Raw | Human | ~USD |
|-------|----------|-------------|-------|------|
| USDC | 6 | 10000 | 0.01 | $0.01 |
| ETH | 18 | 10000000000000 | 0.00001 | $0.025 |
| USDT | 6 | 500000 | 0.50 | $0.50 |

Formula: `usd = raw / 10^decimals * price`

## EIP-712 Domain

```
name: "X402StateChannel"
version: "1"
chainId: <network chain id>
verifyingContract: 0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b
```

The contract address is canonical CREATE2 across all chains.

## Channel State Type

```
ChannelState(
  bytes32 channelId,
  uint64 stateNonce,
  uint256 balA,
  uint256 balB,
  bytes32 locksRoot,
  uint64 stateExpiry,
  bytes32 contextHash
)
```

## Context Hash

Used to bind a payment to a specific request:

```js
contextHash = keccak256(abi.encode(
  ["address", "string", "string", "string"],
  [payeeAddress, method, paymentId, invoiceId]
))
```

## Networks

| Name | Chain ID | CAIP-2 | Hub |
|------|----------|--------|-----|
| Base | 8453 | eip155:8453 | https://pogchamp.tv/hub/base |
| Sepolia | 11155111 | eip155:11155111 | https://pogchamp.tv/hub/sepolia |
| Ethereum | 1 | eip155:1 | — |
| Base Sepolia | 84532 | eip155:84532 | — |

## Assets

| Symbol | Decimals | Base (8453) | Sepolia (11155111) |
|--------|----------|-------------|-------------------|
| ETH | 18 | native (0x0...0) | native |
| USDC | 6 | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 | 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 |

## Fee Calculation

```
fee = base + floor(amount × bps / 10000) + gasSurcharge
totalDebit = amount + fee
```

For zero-fee hubs (pay.eth): `base=0, bps=0, gasSurcharge=0` → fee=0, totalDebit=amount.
