/* eslint-disable no-console */
const { URL } = require("url");
const { ScpAgentClient } = require("../scp-agent/agent-client");
const { resolveNetwork } = require("../scp-common/networks");

const DEFAULT_BASE_URL = process.env.MUSIC_API_URL || "http://127.0.0.1:4095";

const USAGE = `Usage:
  npm run scp:music:stream -- [baseUrl] [options]

Examples:
  npm run scp:music:stream
  npm run scp:music:stream -- http://127.0.0.1:4095 --track neon-sky --ticks 8

Options:
  --track <id>                  Track id from /v1/music/catalog (default: first track)
  --cursor <sec>                Start cursor in seconds (default: 0)
  --route <hub|direct|auto>     Route preference (default: hub)
  --network <network>           Offer network filter (base|sepolia|eip155:*)
  --asset <0xAssetAddress>      Offer asset filter
  --ticks <n>                   Number of paid ticks then stop (0 = infinite, default)
  --interval-sec <n>            Override sleep seconds between ticks
  --continue-on-error           Keep streaming after tick errors
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

function normalizeBaseUrl(input) {
  const raw = String(input || DEFAULT_BASE_URL).trim();
  const u = new URL(raw);
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

function buildChunkUrl(baseUrl, trackId, cursorSec) {
  return `${baseUrl}/v1/music/chunk?track=${encodeURIComponent(trackId)}&cursor=${cursorSec}`;
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

async function fetchCatalog(baseUrl) {
  const res = await fetch(`${baseUrl}/v1/music/catalog`, { method: "GET" });
  if (!res.ok) {
    throw new Error(`catalog request failed (${res.status})`);
  }
  const body = await res.json();
  const tracks = Array.isArray(body?.tracks) ? body.tracks : [];
  if (!tracks.length) throw new Error("catalog is empty");
  return tracks;
}

function chooseTrack(catalog, requestedId) {
  if (!requestedId) return catalog[0];
  return catalog.find((t) => t.id === requestedId) || null;
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

  const baseUrl = normalizeBaseUrl(positional[0] || DEFAULT_BASE_URL);
  const route = normalizeRoute(flags.route || process.env.AGENT_DEFAULT_ROUTE || "hub");
  const maxTicks = parseNonNegativeInt(flags.ticks, "--ticks", 0);
  const intervalOverride = parseNonNegativeInt(flags["interval-sec"], "--interval-sec", 0);
  let cursorSec = parseNonNegativeInt(flags.cursor, "--cursor", 0);

  const catalog = await fetchCatalog(baseUrl);
  const trackId = flags.track || process.env.MUSIC_TRACK_ID || "";
  const track = chooseTrack(catalog, trackId);
  if (!track) {
    throw new Error(`Unknown --track "${trackId}". Available: ${catalog.map((t) => t.id).join(", ")}`);
  }

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
    console.log("Stopping after current payment tick...");
  };
  process.on("SIGINT", stopHandler);
  process.on("SIGTERM", stopHandler);

  console.log(`[music-stream] connected ${nowIso()}`);
  console.log(`[music-stream] baseUrl=${baseUrl} route=${route}`);
  console.log(`[music-stream] track=${track.id} (${track.title})`);
  console.log(`[music-stream] start cursor=${cursorSec}s maxTicks=${maxTicks || "infinite"}`);

  try {
    let tick = 0;
    while (!stopRequested && (maxTicks === 0 || tick < maxTicks)) {
      tick += 1;
      const tickStart = Date.now();
      const chunkUrl = buildChunkUrl(baseUrl, track.id, cursorSec);

      try {
        const result = await agent.payResource(chunkUrl, payOptions);
        const charged = summarizePaidAmount(result);
        const stream = result?.response?.stream || {};
        const hasMore = stream.hasMore !== false;

        totalPaid += BigInt(charged);
        paidCount += 1;

        const nextCursorRaw = Number(stream.nextCursor);
        const nextCursor = Number.isInteger(nextCursorRaw) && nextCursorRaw >= 0
          ? nextCursorRaw
          : cursorSec + intervalSec;

        const cadenceRaw = Number(stream.t);
        if (intervalOverride === 0 && Number.isInteger(cadenceRaw) && cadenceRaw > 0) {
          intervalSec = cadenceRaw;
        }

        console.log(
          `[tick ${tick}] ok charged=${charged} cursor=${cursorSec}s next=${nextCursor}s hasMore=${hasMore} t=${intervalSec}s`
        );

        cursorSec = nextCursor;
        if (!hasMore || (Number(track.durationSec) > 0 && cursorSec >= Number(track.durationSec))) {
          console.log("[music-stream] track complete");
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
    console.log(`[music-stream] summary paid=${paidCount} failed=${failedCount} totalCharged=${totalPaid.toString()}`);
  }
}

main().catch((err) => {
  console.error(`Music stream client failed: ${err.message}`);
  process.exit(1);
});
