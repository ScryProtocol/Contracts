#!/usr/bin/env node
/* eslint-disable no-console */
const { resolveHubEndpointForNetwork } = require("../node/scp-common/networks");

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function resolveHubCandidates(input) {
  const raw = String(input || "").trim();
  if (looksLikeUrl(raw)) {
    return [raw.replace(/\/+$/, "")];
  }
  const network = raw || process.env.NETWORK || "sepolia";
  const candidates = [
    resolveHubEndpointForNetwork(network, {
      baseUrl: process.env.HUB_BASE_URL || process.env.PUBLIC_HUB_BASE_URL
    }),
    resolveHubEndpointForNetwork(network, { baseUrl: "https://pogchamp.tv" }),
    resolveHubEndpointForNetwork(network, { baseUrl: "http://159.223.150.70" }),
    resolveHubEndpointForNetwork(network, { baseUrl: "https://159.223.150.70" })
  ];
  return [...new Set(candidates.map((value) => String(value || "").replace(/\/+$/, "")))];
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8000)
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_err) {
    body = text;
  }
  return { status: response.status, body };
}

async function main() {
  const arg = process.argv[2] || "";
  console.log("Hub Check");
  const candidates = resolveHubCandidates(arg);
  console.log(`  candidates: ${candidates.join(", ")}`);
  console.log();

  let result = null;
  let endpoint = "";
  let url = "";
  let lastError = "no candidate endpoints";
  for (const candidate of candidates) {
    endpoint = candidate;
    url = `${endpoint}/.well-known/x402`;
    try {
      const response = await fetchJson(url);
      if (response.status === 200 && response.body && typeof response.body === "object") {
        result = response;
        break;
      }
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err.message;
    }
  }

  if (!result) {
    console.error(`Hub check failed: ${lastError}`);
    process.exit(1);
  }

  const hub = result.body;
  console.log(`  endpoint: ${endpoint}`);
  console.log(`  url:      ${url}`);
  console.log(`  hubName:  ${hub.hubName || "n/a"}`);
  console.log(`  address:  ${hub.address || hub.hubAddress || "n/a"}`);
  console.log(`  chainId:  ${hub.chainId || "n/a"}`);
  console.log(`  schemes:  ${Array.isArray(hub.schemes) ? hub.schemes.join(", ") : "n/a"}`);
  console.log(`  assets:   ${Array.isArray(hub.supportedAssets) ? hub.supportedAssets.join(", ") : "n/a"}`);
  console.log(`  modes:    ${Array.isArray(hub.modes) ? hub.modes.join(", ") : "n/a"}`);

  if (hub.feePolicy) {
    console.log(
      `  fee:      base=${hub.feePolicy.base || "0"} bps=${hub.feePolicy.bps || 0} gas=${hub.feePolicy.gasSurcharge || "0"}`
    );
  }

  if (hub.signature && hub.signature.publicKey) {
    console.log(`  signer:   ${hub.signature.publicKey}`);
  }
}

main().catch((err) => {
  console.error(`Hub check failed: ${err.message}`);
  process.exit(1);
});
