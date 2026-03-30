# Nitro Application Draft for x402s

This file is a working draft for `https://nitroacc.xyz/apply` as inspected on 2026-03-12.

Rule used here:
- `README-backed`: directly supported by `/workspaces/Contracts/x402s/README.md`
- `Inference`: reasonable product framing derived from the README, but not stated verbatim
- `TODO`: needs founder, company, traction, or fundraising input that is not in the repo

Primary source:
- `/workspaces/Contracts/x402s/README.md`

Useful public links mentioned or implied by the README:
- Repo: `https://github.com/Keychain-Inc/x402s`
- Live pay UI: `https://pogchamp.tv/pay/`

Important constraint:
- Based on the README alone, the only product-progress checkbox that is clearly safe is `MVP / demo exists`.
- Do not claim user traction, revenue, retention, fundraising status, or founder specifics without adding real data.

## High-Level Fit

What the README supports well:
- Product description
- Problem and solution framing
- Technical differentiation
- Product maturity as a working MVP/demo
- Target users at a high level
- Chain support and developer-infrastructure positioning

What the README does not support:
- Founder identities and bios
- Founder-market fit story
- How the founders met
- Full-time commitment status
- Founder location
- Budget use for the $500k
- Traction metrics, analytics dashboards, or revenue
- Fundraising history, current raise, or runway
- Nitro-specific motivation
- Mentor selection and question
- Weekly execution update

## Recommended Draft Answers

## Company Information

### Company / Project name *

Status: `README-backed`

`x402s`

### Email *

Status: `TODO`

Use a founder or company email that you actively monitor.

### One-line description *

Status: `README-backed`

`x402s is a state-channel payments stack that lets agents and APIs pay per request or per stream over HTTP 402 without an on-chain transaction for every call.`

### What are you building? *

Status: `README-backed`

`We are building the payment rail for agentic internet traffic: agent clients, payee middleware, hub infrastructure, direct state-channel payments, stream payments, monitoring, and a browser wallet for machine-native API commerce.`

### Website

Status: `Inference`

Recommended order:
1. `https://github.com/Keychain-Inc/x402s`
2. `https://pogchamp.tv/pay/`

Note:
- The README explicitly lists `https://pogchamp.tv/pay/` as the live browser wallet.
- The route is reachable, but the public branding is still `PogChamp`, so the GitHub repo may be the cleaner primary link unless you have a better x402s-specific landing page.

## Founders

### Full Name *

Status: `TODO`

### Role in the company *

Status: `TODO`

### X Handle *

Status: `TODO`

### LinkedIn username *

Status: `TODO`

### Telegram *

Status: `TODO`

### GitHub username

Status: `TODO`

### Why are you the right founder to build this? *

Status: `TODO`

This cannot be answered honestly from the README. It needs:
- your prior work in crypto/payments/infra/AI
- why you have unique distribution or insight
- proof that you have been shipping in this domain already

### If you did any video content or long form writing recently, paste the links so we can check them out.

Status: `TODO`

## Team Details

### How did the founders meet and how long have you worked together full-time? *

Status: `TODO`

### Are all founders committed full-time to the startup? *

Status: `TODO`

### Current location of founders *

Status: `TODO`

### If you get selected to the program, how do you plan to spend $500k?

Status: `TODO`

Suggested structure once you have real numbers:
- Engineering hires
- Security review / audits
- RPC, infra, and indexer costs
- Design and developer-relations
- Go-to-market and design partners

## Problem

### What problem are you solving, and why does it matter? *

Status: `README-backed`

`Agents need cheap, fast, programmable micropayments for API calls and streaming access. Card billing, subscriptions, and per-call on-chain settlement are too slow, too expensive, and not machine-native. x402s lets APIs charge and lets agents pay in milliseconds using funded state channels rather than a blockchain transaction for every request.`

### Who are your closest comparables and what do you understand that they don't?

Status: `Inference`

Draft:

`Closest comparables are API billing systems, x402-style paid HTTP tooling, and Lightning-style micropayment rails. Our view is that agent payments need to be embedded directly into request/response flows, not bolted onto SaaS billing or delayed settlement. One funded channel to a hub should unlock many APIs, and the same payment rail should support one-shot calls, subscriptions, and streaming access.`

Note:
- This answer is directionally strong, but it is still an inference from the product design in the README, not an explicit statement from the repo.

## Solution

### How far along is your product? *

Status: `README-backed`

Recommended selection:
- `MVP / demo exists`

Only select the following if you have external evidence:
- `Some traction (signups, low retention)`
- `Good traction (repeat users)`
- `Revenue-generating`

README evidence for MVP/demo:
- agent, payee, and hub flows
- direct payments
- stream payments
- browser wallet
- tests, simulation, and benchmarks
- live browser pay UI link

### Product Link

Status: `README-backed`

Recommended:
- `https://github.com/Keychain-Inc/x402s`

Optional secondary link:
- `https://pogchamp.tv/pay/`

### What changed in the tech or market that makes this a good idea right now?

Status: `Inference`

Draft:

`Three things changed at once: agents are now making real API calls autonomously, stablecoin and EVM rails are cheap enough to support prefunded machine payments, and HTTP 402-style payment flows are becoming practical again for software-to-software commerce. That makes it possible to turn APIs and streams into machine-native paid resources instead of forcing human billing flows onto agent traffic.`

### Paste your Dune Dashboard link

Status: `TODO`

### Link to your Google Analytics / Mixpanel / Posthog

Status: `TODO`

Only include this if you have a real public dashboard.

## Market

### Tell us about the target segment you are tapping in the next 3-6 months.

Status: `Inference`

Draft:

`The near-term target segment is agent developers and API developers who already need paid request flows. On the demand side, that means teams building agents that call third-party APIs frequently and need a machine-native payment rail. On the supply side, that means crypto-native API builders who want to charge per request, per session, or per stream without forcing wallet popups or subscription billing on every interaction.`

### What is your wedge into the market?

Status: `Inference`

Draft:

`The wedge is simple: one funded channel to a hub can unlock many paid APIs, and the same stack can also be used by API builders to charge for endpoints immediately. That gives us a developer wedge on both sides of the marketplace: agents need a payment client, and payees need a monetization layer. Streaming support and a browser wallet expand that from paid API calls into real-time paid experiences.`

### What traction have you achieved so far?

Status: `TODO`

Conservative repo-backed fallback if you have no user metrics yet:

`We have built a working end-to-end stack with an agent, payee, hub, direct-payment flow, stream-payment flow, browser wallet, tests, simulation, and benchmark tooling.`

Do not present that as customer traction. It is product maturity, not market traction.

### Select chain(s) you are building on *

Status: `README-backed`

Safe answer:
- Base
- Ethereum

Supporting note:
- The README also shows Sepolia and Base Sepolia support for testing and deployment.

### Which category best applies to your company?

Status: `Inference`

Best-fit category if available in Nitro's list:
- Developer Infrastructure
- Payments
- Agent Tooling

Choose the closest option Nitro actually offers.

## Fundraising

### Have you raised funding before? *

Status: `TODO`

### Are you currently fundraising? *

Status: `TODO`

### Runway at current burn (months) *

Status: `TODO`

## Application Motivation

### What attracts you the most about Nitro? *

Status: `TODO`

Suggested angle if true:
- concentrated crypto-founder peer group
- fast feedback from operators who understand distribution and go-to-market
- access to design partners and early customers
- pressure-tested founder environment instead of a passive accelerator

### Pick one of the mentors from our list. If you could ask them one question, who would you pick and what would you ask them?

Status: `TODO`

This requires the current mentor list and your actual preference.

## Program Commitment

### Do all founders commit to participating exclusively in Nitro during the program, without joining other accelerators? *

Status: `TODO`

### Will all founders attend the full 1-month NYC residency if accepted? *

Status: `TODO`

### What did you get done last week?

Status: `TODO`

Best answer format:
- shipped feature or fix
- user or partner conversations
- traction or product metric moved
- what unblocked the next milestone

## Founder Agreement

### All founders must agree to Nitro's Terms of Use and Privacy Policy *

Status: `TODO`

## Short Product-Only Version

If you need a compact product summary for reuse:

`x402s is a state-channel payments stack for machine-native commerce. It lets agents pay APIs and streams over HTTP 402 with off-chain balance updates instead of an on-chain transaction for every call. The product includes agent tooling, payee middleware, hub infrastructure, direct payments, streaming payments, monitoring, a browser wallet, and test/benchmark tooling across Base and Ethereum-compatible networks.`

## Honesty Check Before Submission

Safe to claim from the repo:
- working MVP/demo
- agent/payee/hub stack
- direct payment support
- streaming support
- browser wallet
- tests, simulation, and benchmarks
- EVM/Base support

Not safe to claim from the repo alone:
- active users
- retention
- revenue
- public traction
- founder credentials
- fundraising status
- runway

## Next Inputs Needed From Founders

To finish the form cleanly, add:
- founder names and bios
- founder handles and profiles
- founder location
- how the team formed
- full-time status
- current fundraising status
- runway
- product traction metrics
- analytics links
- how you would use the $500k
- why Nitro specifically
- last-week execution summary
