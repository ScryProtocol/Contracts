/* eslint-disable no-console */
/**
 * Generic SCP stream client.
 *
 * Keeps a live paid connection to any payee URL by repeating paid calls on
 * cadence.  For hub offers the cadence is read from:
 *
 *   accepts[].extensions["statechannel-hub-v1"].stream.t   (fallback 5s)
 *
 * Usage:
 *   npm run scp:agent:stream -- <url> [options]
 *
 * The URL can be any x402-protected endpoint.  If the payee returns
 * `stream.nextCursor` and `stream.hasMore` in its 200 response, the client
 * will advance the cursor automatically by appending `?cursor=<n>` (or
 * updating an existing cursor param).
 */

const { URL } = require("url");
const { ScpAgentClient } = require("./agent-client");
const { resolveNetwork } = require("../scp-common/networks");

const USAGE = `Usage:
  npm run scp:agent:stream -- <url> [options]

Examples:
  npm run scp:agent:stream -- http://127.0.0.1:4042/v1/data
  npm run scp:agent:stream -- https://api.example/meow --route hub --ticks 20

Options:
  --route <hub|direct|auto>     Route preference (default: hub)
  --network <network>           Offer network filter (base|sepolia|eip155:*)
  --asset <0xAssetAddress>      Offer asset filter
  --ticks <n>                   Number of paid ticks then stop (0 = infinite, default)
  --interval-sec <n>            Override sleep seconds between ticks (default: from offer)
  --continue-on-error           Keep streaming after tick errors
  --cursor <value>              Initial cursor value (appended as ?cursor=<value>)
  --cursor-param <name>         Query param name for cursor (default: cursor)
`;

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--continue-on-error") {
      flags.continueOnError = true;
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    flags[key] = next;
    i += 1;
  }

  return { flags, positional };
}

function parseNonNegativeInt(value, label, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === "") return defaultValue;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return n;
}

function normalizeRoute(value) {
  const route = String(value || "hub").trim().toLowerCase();
  if (route === "hub" || route === "direct" || route === "auto") return route;
  throw new Error("--route must be hub, direct, or auto");
}

function toCaip2(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (raw.startsWith("eip155:")) return raw.toLowerCase();
  try {
    return `eip155:${resolveNetwork(raw).chainId}`;
  } catch (_e) {
    return raw.toLowerCase();
  }
}

function resolveNetworks(overrideNetwork) {
  const raw = overrideNetwork || process.env.NETWORK || process.env.NETWORKS;
  if (!raw) return ["eip155:11155111"];
  return String(raw)
    .split(",")
    .map((x) => toCaip2(x))
    .filter(Boolean);
}

/**
 * Build the URL for the next tick, updating the cursor param if a new cursor
 * value is provided.
 */
function buildTickUrl(baseUrl, cursorValue, cursorParam) {
  const u = new URL(baseUrl);
  if (cursorValue !== null && cursorValue !== undefined) {
    u.searchParams.set(cursorParam, String(cursorValue));
  }
  return u.toString();
}

function summarizePaidAmount(result) {
  const candidate =
    result?.quote?.totalDebit ||
    result?.ticket?.totalDebit ||
    result?.quote?.amount ||
    result?.ticket?.amount ||
    "0";
  const text = String(candidate || "0").trim();
  return /^[0-9]+$/.test(text) ? text : "0";
}

/**
 * Try to extract stream metadata from the payee response.
 *
 * Payees that support streaming return a `stream` object in their 200
 * response:
 *   { amount, t, nextCursor, hasMore }
 *
 * Some payees put stream info at the top level, others nest it under
 * `connection` or `stream`.  We check all of these.
 */
function extractStreamMeta(responseBody) {
  if (!responseBody || typeof responseBody !== "object") {
    return { t: null, nextCursor: null, hasMore: true };
  }

  const stream =
    responseBody.stream ||
    responseBody.connection?.stream ||
    {};

  const tRaw = Number(stream.t ?? responseBody.cadenceSec ?? responseBody.t);
  const t = Number.isInteger(tRaw) && tRaw > 0 ? tRaw : null;

  const ncRaw = stream.nextCursor ?? responseBody.nextCursor;
  const nextCursor =
    ncRaw !== undefined && ncRaw !== null ? ncRaw : null;

  const hasMore =
    stream.hasMore !== undefined ? stream.hasMore !== false :
    responseBody.hasMore !== undefined ? responseBody.hasMore !== false :
    true;

  return { t, nextCursor, hasMore };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.log(USAGE);
    process.exit(1);
  }
  const { flags, positional } = parsed;
  if (flags.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const baseUrl = positional[0];
  if (!baseUrl) {
    console.error("Error: URL argument is required.");
    console.log(USAGE);
    process.exit(1);
  }

  // Validate URL
  try {
    new URL(baseUrl);
  } catch (_e) {
    console.error(`Error: "${baseUrl}" is not a valid URL.`);
    process.exit(1);
  }

  const route = normalizeRoute(flags.route || process.env.AGENT_DEFAULT_ROUTE || "hub");
  const maxTicks = parseNonNegativeInt(flags.ticks, "--ticks", 0);
  const intervalOverride = parseNonNegativeInt(flags["interval-sec"], "--interval-sec", 0);
  const cursorParam = flags["cursor-param"] || "cursor";
  let cursorValue = flags.cursor !== undefined ? flags.cursor : null;

  const agentOpts = {
    networkAllowlist: resolveNetworks(flags.network),
    maxFeeDefault: process.env.MAX_FEE || "5000",
    maxAmountDefault: process.env.MAX_AMOUNT || "5000000"
  };
  if (process.env.AGENT_PRIVATE_KEY) agentOpts.privateKey = process.env.AGENT_PRIVATE_KEY;
  if (process.env.ASSET_ALLOWLIST) {
    agentOpts.assetAllowlist = process.env.ASSET_ALLOWLIST
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  if (process.env.AGENT_STATE_DIR) agentOpts.stateDir = process.env.AGENT_STATE_DIR;

  const agent = new ScpAgentClient(agentOpts);
  const payOptions = {
    route,
    network: flags.network,
    asset: flags.asset,
    method: "GET"
  };

  let stopRequested = false;
  let paidCount = 0;
  let failedCount = 0;
  let totalPaid = 0n;
  let intervalSec = intervalOverride > 0 ? intervalOverride : 5;

  const stopHandler = () => {
    if (stopRequested) {
      console.log("Force stop requested. Exiting.");
      process.exit(130);
    }
    stopRequested = true;
    console.log("Stopping after current tick...");
  };
  process.on("SIGINT", stopHandler);
  process.on("SIGTERM", stopHandler);

  console.log(`[stream] started ${nowIso()}`);
  console.log(`[stream] url=${baseUrl} route=${route}`);
  console.log(`[stream] maxTicks=${maxTicks || "infinite"} intervalOverride=${intervalOverride || "auto"}`);

  try {
    let tick = 0;
    while (!stopRequested && (maxTicks === 0 || tick < maxTicks)) {
      tick += 1;
      const tickStart = Date.now();
      const tickUrl = buildTickUrl(baseUrl, cursorValue, cursorParam);

      try {
        const result = await agent.payResource(tickUrl, payOptions);
        const charged = summarizePaidAmount(result);
        const body = result?.response || {};
        const meta = extractStreamMeta(body);

        totalPaid += BigInt(charged);
        paidCount += 1;

        // Update cadence from payee if no override
        if (intervalOverride === 0 && meta.t !== null) {
          intervalSec = meta.t;
        }

        // Advance cursor if payee provides one
        if (meta.nextCursor !== null) {
          cursorValue = meta.nextCursor;
        }

        console.log(
          `[tick ${tick}] ok charged=${charged} cursor=${cursorValue ?? "-"} hasMore=${meta.hasMore} t=${intervalSec}s`
        );

        if (!meta.hasMore) {
          console.log("[stream] payee signaled end of stream");
          break;
        }
      } catch (err) {
        failedCount += 1;
        console.error(`[tick ${tick}] error: ${err.message || err}`);
        if (!flags.continueOnError) break;
      }

      if (stopRequested || (maxTicks > 0 && tick >= maxTicks)) break;
      const elapsed = Date.now() - tickStart;
      const waitMs = Math.max(0, intervalSec * 1000 - elapsed);
      if (waitMs > 0) await sleep(waitMs);
    }
  } finally {
    process.off("SIGINT", stopHandler);
    process.off("SIGTERM", stopHandler);
    agent.close();
    console.log(`[stream] summary paid=${paidCount} failed=${failedCount} totalCharged=${totalPaid.toString()}`);
  }
}

main().catch((err) => {
  console.error(`Stream client failed: ${err.message}`);
  process.exit(1);
});
