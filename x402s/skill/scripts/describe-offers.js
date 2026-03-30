#!/usr/bin/env node
/* Discover 402 offers from a URL and describe them for AI selection.
   Usage: node skill/scripts/describe-offers.js <url> [--network <net>] */

const path = require("path");
const dotenv = require("dotenv");

// Load .env from x402s root
const x402sRoot = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(x402sRoot, ".env") });

const { ScpAgentClient } = require(path.join(x402sRoot, "node/scp-agent/agent-client"));
const { resolveNetwork, toCaip2 } = require(path.join(x402sRoot, "node/scp-common/networks"));

const DECIMALS = { eth: 18, usdc: 6, usdt: 6 };
const USD_PRICES = { eth: 2500, usdc: 1, usdt: 1 }; // rough estimates for comparison

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[++i];
    } else {
      positional.push(args[i]);
    }
  }
  return { url: positional[0], flags };
}

function assetSymbol(addr) {
  const a = (addr || "").toLowerCase();
  if (a === "0x0000000000000000000000000000000000000000" || a === "eth") return "ETH";
  if (a.includes("833589") || a.includes("a0b869") || a.includes("1c7d4b") || a.includes("036cbd")) return "USDC";
  if (a.includes("dac17f") || a.includes("fde4c9")) return "USDT";
  return addr ? addr.slice(0, 10) + "..." : "?";
}

function formatAmount(raw, sym) {
  const dec = DECIMALS[sym.toLowerCase()] || 18;
  const n = BigInt(raw || "0");
  const p = 10n ** BigInt(dec);
  const whole = n / p;
  const frac = (n % p).toString().padStart(dec, "0").replace(/0+$/, "");
  if (whole === 0n) {
    const i = frac.search(/[1-9]/);
    return i < 0 ? "0" : "0." + frac.slice(0, Math.min(dec, i + 6));
  }
  return frac ? `${whole}.${frac.slice(0, 6)}` : `${whole}`;
}

function estimateUsd(raw, sym) {
  const dec = DECIMALS[sym.toLowerCase()] || 18;
  const n = Number(raw) / Math.pow(10, dec);
  const price = USD_PRICES[sym.toLowerCase()] || 0;
  return (n * price).toFixed(6);
}

function networkName(caip) {
  const map = { "eip155:1": "Ethereum", "eip155:8453": "Base", "eip155:11155111": "Sepolia", "eip155:84532": "Base Sepolia" };
  return map[caip] || caip;
}

async function main() {
  const { url, flags } = parseArgs();
  if (!url) {
    console.error("Usage: node skill/scripts/describe-offers.js <url> [--network <net>]");
    process.exit(1);
  }

  const agent = new ScpAgentClient({
    privateKey: process.env.AGENT_PRIVATE_KEY || "0x" + "1".repeat(64), // dummy key for discovery
    maxFeeDefault: process.env.MAX_FEE || "5000000",
    maxAmountDefault: process.env.MAX_AMOUNT || "50000000000000"
  });

  try {
    console.log(`Discovering offers from: ${url}\n`);
    const offers = await agent.discoverOffers(url);

    if (!offers.length) {
      console.log("No 402 offers found (endpoint may not require payment).");
      return;
    }

    console.log(`Found ${offers.length} offer(s):\n`);
    console.log("| # | Network | Asset | Amount | ~USD | Scheme | Hub Fee | Hub | Channel |");
    console.log("|---|---------|-------|--------|------|--------|---------|-----|---------|");

    for (let i = 0; i < offers.length; i++) {
      const o = offers[i];
      const sym = assetSymbol(o.asset);
      const raw = o.maxAmountRequired || "0";
      const human = formatAmount(raw, sym);
      const usd = estimateUsd(raw, sym);
      const net = networkName(o.network);
      const ext = (o.extensions || {})["statechannel-hub-v1"] || (o.extensions || {})["statechannel-direct-v1"] || {};
      const fee = ext.feeModel ? `${ext.feeModel.base || 0} + ${ext.feeModel.bps || 0}bps` : "unknown";
      const hubEp = ext.hubEndpoint || "-";
      const hubShort = hubEp.replace(/https?:\/\//, "").replace(/\/.*/, "");
      const scheme = o.scheme === "statechannel-hub-v1" ? "hub" : o.scheme === "statechannel-direct-v1" ? "direct" : o.scheme;

      // Check channel readiness
      const ck = o.scheme === "statechannel-hub-v1" ? `hub:${(ext.hubEndpoint || "").replace(/\/+$/, "")}` : `direct:${(ext.payeeAddress || "").toLowerCase()}`;
      const ch = agent.state?.channels?.[ck];
      let chStatus = "none";
      if (ch) {
        try {
          chStatus = BigInt(ch.balA || "0") >= BigInt(raw) ? "funded" : "low";
        } catch { chStatus = "exists"; }
      }

      console.log(`| ${i + 1} | ${net} | ${sym} | ${human} | $${usd} | ${scheme} | ${fee} | ${hubShort} | ${chStatus} |`);
    }

    // Recommendation
    console.log("\n**Recommendation:**");
    const funded = offers.filter((o, i) => {
      const ext = (o.extensions || {})["statechannel-hub-v1"] || {};
      const ck = `hub:${(ext.hubEndpoint || "").replace(/\/+$/, "")}`;
      const ch = agent.state?.channels?.[ck];
      return ch && BigInt(ch.balA || "0") >= BigInt(o.maxAmountRequired || "0");
    });

    if (funded.length) {
      const best = funded.sort((a, b) => {
        const ua = parseFloat(estimateUsd(a.maxAmountRequired, assetSymbol(a.asset)));
        const ub = parseFloat(estimateUsd(b.maxAmountRequired, assetSymbol(b.asset)));
        return ua - ub;
      })[0];
      const sym = assetSymbol(best.asset);
      console.log(`Use offer #${offers.indexOf(best) + 1} (${sym} on ${networkName(best.network)}) — funded channel, cheapest at ~$${estimateUsd(best.maxAmountRequired, sym)}`);
    } else {
      const cheapest = [...offers].sort((a, b) => {
        const ua = parseFloat(estimateUsd(a.maxAmountRequired, assetSymbol(a.asset)));
        const ub = parseFloat(estimateUsd(b.maxAmountRequired, assetSymbol(b.asset)));
        return ua - ub;
      })[0];
      const sym = assetSymbol(cheapest.asset);
      console.log(`No funded channel. Cheapest: offer #${offers.indexOf(cheapest) + 1} (${sym} on ${networkName(cheapest.network)}) at ~$${estimateUsd(cheapest.maxAmountRequired, sym)}`);
    }

    if (ext => offers.some(o => (o.extensions?.["statechannel-hub-v1"]?.stream?.t || 0) > 1)) {
      const streamOffer = offers.find(o => (o.extensions?.["statechannel-hub-v1"]?.stream?.t || 0) > 1);
      if (streamOffer) {
        const t = streamOffer.extensions["statechannel-hub-v1"].stream.t;
        console.log(`Note: streaming endpoint (t=${t}s cadence) — use scp:agent:stream for continuous access.`);
      }
    }
  } finally {
    agent.close();
  }
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
