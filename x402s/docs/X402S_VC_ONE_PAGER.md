# x402s SCP

## TLDR

x402s is a state channel payments stack for agent-native payments. It lets AI agents, apps, and users pay APIs and digital services over HTTP `402 Payment Required` with x402, using signed offchain balance updates instead of an onchain transaction for every request. 0 fee, instant transactions to anyone, anywhere.

## What Problem It Solves

AI agents are becoming autonomous API consumers, but the payment stack is still built for humans. Card billing, subscriptions, and prepaid SaaS credits are awkward for software-to-software purchases, while per-call onchain payments are too slow and expensive for high-frequency micropayments and nanopayments.

That leaves paid APIs stuck between two bad options: centralized billing accounts or unusable onchain UX.

## What x402s Does

x402s adds a state-channel rail to the x402 payment flow:

1. A payee returns `HTTP 402` with payment offers.
2. The agent gets a quote from a hub or uses a direct channel.
3. The agent signs an EIP-712 channel state update offchain.
4. The hub issues a ticket, or the payee verifies the direct proof.
5. The request is retried with a payment header and the resource is served.

Onchain activity is reserved for opening, funding, challenging, and closing channels, not for every API call.

## Why It Matters

- Zero gas per request after a channel is funded.
- Low-latency paid retries instead of block-by-block waiting.
- One funded hub channel can unlock many payees.
- Compatible with the broader x402 payment model for HTTP-native monetization.
- Works for one-shot API calls, direct payments, and streaming-style paid access.

## What Exists Today

The current `x402s` repo includes:

- `X402StateChannel.sol` for channel open, deposit, challenge, cooperative close, and rebalance.
- A Node hub with quote, issue, refund, webhook, and payee settlement routes.
- Agent tooling for paid URL calls, channel management, receipts, and summaries.
- Payee demos for standard paid APIs plus music and other streaming-style flows.
- A browser wallet (`scp-pay`) with handle resolution, iframe embedding, and postMessage payment events.
- Challenge watcher support for stale-close protection.

## Commercial Wedge

x402s has a developer wedge on both sides of the marketplace:

- Agent builders need a payment client that can unlock paid tools and APIs without human checkout.
- API developers need a monetization layer that can turn HTTP endpoints into machine-payable resources.

Natural monetization paths include hub fees, hosted hub infrastructure, staking and higher-trust settlement products layered on top of the open-source stack.

## Why Now

Three shifts make this timely:

- Agent traffic is becoming real economic traffic.
- HTTP `402 Payment Required` is being revived as a practical interface for paid requests.
- Stablecoin and EVM rails make prefunded machine payments workable, but still need an offchain execution layer for true micropayments.

## Notes

x402s' a working open-source payments stack for machine-native commerce.
- working hub-routed and direct flows
- open-source developer stack
- browser wallet and CLI entry points
- low-latency offchain payment authorization
- onchain dispute protection at the channel layer